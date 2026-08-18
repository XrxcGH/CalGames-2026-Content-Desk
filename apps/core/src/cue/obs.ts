/**
 * Minimal obs-websocket v5 client.
 *
 * Hand-rolled rather than pulling in obs-websocket-js: the whole protocol we
 * need is a SHA256 handshake and one request opcode, and this project's only
 * runtime dependency is `ws`. Fewer moving parts to debug at 11pm on a
 * Saturday.
 *
 * Protocol: Hello(0) -> Identify(1) -> Identified(2), then Request(6) /
 * RequestResponse(7). Events arrive as op 5 and we ignore them: the cue
 * engine drives OBS, not the other way round.
 */

import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;

interface Pending { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

export interface ObsOpts {
  /** e.g. "127.0.0.1:4455" */
  host: string;
  /** Read from the environment, never a CLI arg (argv is visible in `ps`). */
  password?: string;
  onStatus?: (connected: boolean, detail: string) => void;
}

/** GetStreamStatus response, the fields the desk actually reads. */
export interface StreamStatus {
  outputActive: boolean;
  outputReconnecting: boolean;
  /** "00:14:03.222", straight from OBS. */
  outputTimecode: string;
  outputDuration: number;
  outputCongestion: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
}

export class ObsClient {
  #opts: ObsOpts;
  #ws: WebSocket | null = null;
  #ready = false;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #backoff = 500;
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(opts: ObsOpts) { this.#opts = opts; }

  get connected(): boolean { return this.#ready; }

  connect(): void {
    if (this.#stopping) return;
    const ws = new WebSocket(`ws://${this.#opts.host}`);
    this.#ws = ws;

    ws.on('message', raw => {
      let msg: { op?: number; d?: Record<string, unknown> };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

      if (msg.op === OP.Hello) {
        const auth = msg.d?.['authentication'] as { challenge: string; salt: string } | undefined;
        const identify: Record<string, unknown> = {
          rpcVersion: (msg.d?.['rpcVersion'] as number) ?? 1,
          eventSubscriptions: 0,          // we only send; subscribing is wasted traffic
        };
        if (auth) {
          if (!this.#opts.password) {
            this.#opts.onStatus?.(false, 'OBS requires a password, set OBS_PASSWORD');
            ws.close();
            return;
          }
          identify['authentication'] = sign(this.#opts.password, auth.salt, auth.challenge);
        }
        ws.send(JSON.stringify({ op: OP.Identify, d: identify }));
        return;
      }

      if (msg.op === OP.Identified) {
        this.#ready = true;
        this.#backoff = 500;
        this.#opts.onStatus?.(true, 'identified');
        return;
      }

      if (msg.op === OP.RequestResponse) {
        const d = msg.d as {
          requestId?: string;
          requestStatus?: { result?: boolean; comment?: string };
          responseData?: unknown;
        };
        const pending = d.requestId ? this.#pending.get(d.requestId) : undefined;
        if (!pending || !d.requestId) return;
        this.#pending.delete(d.requestId);
        clearTimeout(pending.timer);
        d.requestStatus?.result
          ? pending.resolve(d.responseData)
          : pending.reject(new Error(d.requestStatus?.comment ?? 'OBS request failed'));
      }
    });

    ws.on('close', () => this.#reconnect('closed'));
    ws.on('error', err => this.#reconnect(err.message));
  }

  #reconnect(why: string): void {
    this.#ready = false;
    this.#ws = null;
    // Fail every in-flight request rather than leaving a cue hanging forever.
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(new Error(`OBS ${why}`)); }
    this.#pending.clear();
    this.#opts.onStatus?.(false, why);

    if (this.#stopping || this.#timer) return;
    const wait = Math.min(15_000, this.#backoff * 2);
    this.#backoff = wait;
    this.#timer = setTimeout(() => { this.#timer = null; this.connect(); }, wait);
  }

  request<T = unknown>(requestType: string, requestData: unknown = {}, timeoutMs = 4000): Promise<T> {
    if (!this.#ready || !this.#ws) return Promise.reject(new Error('OBS is not connected'));
    const requestId = `r${this.#seq++}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`OBS ${requestType} timed out`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.#ws!.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, requestData } }));
    });
  }

  setScene(sceneName: string): Promise<unknown> {
    return this.request('SetCurrentProgramScene', { sceneName });
  }

  /** Start the configured stream output (OBS holds the RTMP URL and key). */
  startStream(): Promise<unknown> {
    return this.request('StartStream');
  }

  stopStream(): Promise<unknown> {
    return this.request('StopStream');
  }

  streamStatus(): Promise<StreamStatus> {
    return this.request<StreamStatus>('GetStreamStatus');
  }

  /**
   * ONE overlay system on air. Sweep every OBS scene and switch off any
   * source whose name says it renders Cheesy Arena's own overlay pages,
   * otherwise both scorebugs composite and clip whenever someone drags the
   * field's audience display into a scene "just to check something".
   *
   * The contract is the NAME, because a source name is all OBS exposes:
   * anything showing a Cheesy page must carry "cheesy" (or "audience
   * display") in its source name, and the desk keeps it off the program.
   * Runs at connect and on a slow patrol (see index.ts).
   */
  async suppressCheesySources(pattern = /cheesy|audience[ _-]?display/i): Promise<string[]> {
    const { scenes } = await this.request<{ scenes?: { sceneName?: string }[] }>('GetSceneList');
    const disabled: string[] = [];

    type Item = {
      sceneItemId?: number; sourceName?: string;
      sceneItemEnabled?: boolean; isGroup?: boolean | null;
    };

    const sweep = async (containerName: string, isGroup: boolean): Promise<void> => {
      // In obs-websocket v5, GetSceneItemList returns a group as a SINGLE item
      // and never its children: those need GetGroupSceneItemList, addressed
      // by the group's name. Without the recursion, a Cheesy source dragged
      // into a group (a common way volunteers organize scenes) survived every
      // sweep, and both scorebugs composited: the exact failure this exists
      // to prevent.
      const { sceneItems } = await this.request<{ sceneItems?: Item[] }>(
        isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList',
        { sceneName: containerName });
      for (const item of sceneItems ?? []) {
        if (item?.sceneItemId === undefined || !item.sourceName) continue;
        if (item.isGroup) await sweep(item.sourceName, true);
        if (!pattern.test(item.sourceName) || item.sceneItemEnabled === false) continue;
        // SetSceneItemEnabled addresses group children by the GROUP's name.
        await this.request('SetSceneItemEnabled', {
          sceneName: containerName, sceneItemId: item.sceneItemId, sceneItemEnabled: false,
        });
        disabled.push(`${containerName} / ${item.sourceName}`);
      }
    };

    for (const scene of scenes ?? []) {
      if (!scene?.sceneName) continue;
      await sweep(scene.sceneName, false);
    }
    return disabled;
  }

  close(): void {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#ws?.close();
    this.#ready = false;
  }
}

/** base64(sha256(base64(sha256(password + salt)) + challenge)) */
export function sign(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}
