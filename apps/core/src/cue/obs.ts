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
import { networkInterfaces } from 'node:os';
import { WebSocket } from 'ws';

const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;

interface Pending { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

export interface ObsOpts {
  /** e.g. "127.0.0.1:4455" */
  host: string;
  /**
   * From OBS_PASSWORD or config.json's obs.password, never a CLI arg (argv is
   * visible in `ps`, Task Manager and shell history).
   */
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

  /**
   * Whether OBS runs on this machine, so a path on the desk's disk is a path
   * OBS can open too. The replay take hands OBS the clip as a local file:
   * pointed at another machine, the same path names nothing there, and OBS
   * plays an empty source over a scene the desk has just cut the stream to.
   * Better to refuse the take and say so than to air black.
   */
  get local(): boolean { return isLocalHost(this.#opts.host); }

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
            this.#opts.onStatus?.(false, 'OBS asks for a password: put it in "obs": { "password": ... } in config.json (or set OBS_PASSWORD)');
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
    // Re-entry guard: the timeout path tears a wedged socket down with
    // terminate(), whose own close event lands right back here. One
    // teardown, one status flip, one re-dial.
    if (!this.#ws && this.#timer) return;
    this.#ready = false;
    // terminate, not close: a half-open socket's close handshake never
    // completes, and this path exists precisely for sockets that stopped
    // answering. On an already-dead socket this is a no-op.
    this.#ws?.terminate();
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

  /** Consecutive request timeouts. Two in a row means the socket is lying. */
  #timeouts = 0;

  request<T = unknown>(requestType: string, requestData: unknown = {}, timeoutMs = 4000): Promise<T> {
    if (!this.#ready || !this.#ws) return Promise.reject(new Error('OBS is not connected'));
    const requestId = `r${this.#seq++}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`OBS ${requestType} timed out`));
        // A timeout is evidence, and two in a row is a verdict: a half-open
        // socket (OBS machine's network path gone without a FIN) or a hung
        // OBS keeps readyState OPEN while answering nothing, so waiting for
        // a close event meant every cue burned its 4s and scene automation
        // was dead with the status still green. Tear it down and re-dial;
        // a healthy OBS is back in under a second.
        if (++this.#timeouts >= 2) {
          this.#timeouts = 0;
          this.#reconnect('answered nothing twice running');
        }
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve: d => { this.#timeouts = 0; (resolve as (v: unknown) => void)(d); },
        reject, timer,
      });
      this.#ws!.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, requestData } }));
    });
  }

  setScene(sceneName: string): Promise<unknown> {
    return this.request('SetCurrentProgramScene', { sceneName });
  }

  /**
   * The scene OBS has on program right now. Asked rather than remembered:
   * the handbook has the switcher operator cut in OBS by hand, so the last
   * scene the desk itself cut to is often not what is on the stream.
   */
  async programScene(): Promise<string | null> {
    const r = await this.request<{ currentProgramSceneName?: unknown; sceneName?: unknown } | undefined>(
      'GetCurrentProgramScene');
    const name = r?.currentProgramSceneName ?? r?.sceneName;
    return typeof name === 'string' && name ? name : null;
  }

  /**
   * Load a file into an existing Media Source and play it from the top.
   *
   * The source has to exist already (the handbook has the operator make it):
   * creating inputs remotely would mean guessing at a scene layout nobody
   * here can see. `overlay: true` merges, so the operator's own settings on
   * the source survive. close_when_inactive lets go of the file as soon as
   * the scene is cut away from, so a later cut is never blocked by OBS still
   * holding the previous clip open; restart_on_activate plays it from the
   * start when the replay scene comes up. The explicit restart covers the
   * second take of the day, when the scene is already live and activation
   * never happens.
   */
  async playMedia(inputName: string, file: string): Promise<void> {
    await this.request('SetInputSettings', {
      inputName,
      inputSettings: {
        is_local_file: true, local_file: file,
        restart_on_activate: true, close_when_inactive: true,
      },
      overlay: true,
    });
    await this.request('TriggerMediaInputAction', {
      inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    });
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

/**
 * "127.0.0.1:4455", "localhost:4455", "[::1]:4455", or this machine's own
 * LAN address: anything that reaches OBS without leaving the box. The last
 * case matters because a volunteer copying the address off the desk's own
 * front page types the LAN IP, not the loopback one.
 */
export function isLocalHost(hostPort: string): boolean {
  const raw = hostPort.trim().toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']'))   // [::1]:4455
    : (raw.match(/:/g) ?? []).length > 1 ? raw                         // bare IPv6
      : raw.replace(/:\d*$/, '');                                      // name or v4, :port
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.address.toLowerCase() === host) return true;
    }
  }
  return false;
}

/** base64(sha256(base64(sha256(password + salt)) + challenge)) */
export function sign(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}
