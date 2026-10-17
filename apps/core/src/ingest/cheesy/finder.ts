/**
 * FieldFinder: the desk looks for Cheesy Arena by itself, and keeps looking.
 *
 * The launcher has always scanned for the field once, at startup, and that is
 * still the fast path: when it finds the field the desk starts with the bridge
 * attached. But one look at startup assumed the field network is up before
 * the desk is, and at a venue it often is not. The AV table gets cabled in
 * whatever order the crew reaches it, the switch on the field cart is the last
 * thing powered, and a laptop moved from venue wifi to the field network after
 * the desk started was never looked at again. Each of those left the desk in
 * manual mode for the day, and the only cure was a restart with a flag a
 * first-time volunteer has never heard of.
 *
 * So the desk keeps looking, every 30 seconds, until it finds the field, and
 * then stops for good. What it does on the network is the launcher's check,
 * exactly (LooksLikeCheesy in tools/launcher/Launcher.cs), because that check
 * is the one the FTA signed off on:
 *
 *   a TCP knock on port 8080 (connect, then close, nothing sent), and for the
 *   few addresses that answer, one GET of /api/rankings, which is on the
 *   bridge's own read allowlist and is polled by the bridge anyway. 200 with a
 *   JSON body is Cheesy Arena; anything else is somebody's dev server.
 *
 * Nothing here can steer the field. The method is not a parameter, the path
 * is checked against the bridge's allowlist before it is ever requested, and
 * redirects are not followed.
 *
 * And it is polite, because the network it sweeps may have a match running on
 * it. The likely addresses (the one the settings page names, then the FRC
 * default 10.0.100.5) are tried ALONE first, so in the case that matters the
 * whole search is one connect and one GET. Only then does it fan out, at no
 * more than about 50 knocks a second and 16 in flight, one sweep at a time.
 *
 * Fail safe: every callback is guarded, every timer is unref'd, and a sweep
 * that throws is logged and retried on the next round. It never touches show
 * logic; when it finds the field it calls onFound and stops.
 */

import { connect } from 'node:net';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { assertPathAllowed } from './client.ts';

/** Cheesy Arena's own default address, and the FRC field network's convention. */
export const FIELD_DEFAULT_HOST = '10.0.100.5';
export const FIELD_PORT = 8080;
/**
 * The launcher's probe path. Checked against the bridge's allowlist at load,
 * so this file cannot request anything the bridge itself may not.
 */
export const FIELD_PROBE_PATH = assertPathAllowed('/api/rankings');

export const FINDER_TIMING = {
  /** A new sweep starts this long after the last one finished, while nothing is found. */
  sweepEveryMs: 30_000,
  /** "No more than about 50 probes a second." */
  probesPerSecond: 50,
  /** The launcher's SemaphoreSlim(16). */
  maxInFlight: 16,
  /** The launcher's TcpOpen(ip, 8080, 600). */
  knockTimeoutMs: 600,
  /** The launcher's req.Timeout = 2500. */
  checkTimeoutMs: 2_500,
  /** The likely addresses tried one at a time before the fan-out. */
  leadCount: 2,
} as const;

/**
 * "10.0.100.5" -> "10.0.100.5:8080", "cheesy:9000" kept, anything else null.
 *
 * Host names are allowed (a venue may give the field a DNS name), IPv6 is not:
 * the field network is IPv4 by convention and the bridge builds its URLs as
 * host:port, which an IPv6 literal would break.
 */
export function withFieldPort(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 255) return null;
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const port = m[2] === undefined ? FIELD_PORT : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${m[1]!.toLowerCase()}:${port}`;
}

/** The subset of os.networkInterfaces() this reads, so a test can pass its own. */
export type InterfaceMap = Record<string, ReadonlyArray<{
  family: string | number; address: string; internal: boolean;
}> | undefined>;

/**
 * Where to look, in the order to look.
 *
 *   1. the field address from the settings page, when there is one
 *   2. 10.0.100.5, Cheesy Arena's default
 *   3. the rest of 10.0.100.0/24, the FRC field network, whether or not this
 *      machine is on it right now
 *   4. every other /24 this machine has an IPv4 address on, skipping loopback
 *      and 169.254 (DHCP never answered, so nothing else is there)
 *
 * A /24 and never wider, as in the launcher: a /16 is 65 thousand knocks and
 * looks like a port scan to whoever runs the venue network.
 */
export function fieldCandidates(
  preferred: string | null | undefined,
  interfaces: InterfaceMap = networkInterfaces(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (hostPort: string | null): void => {
    if (hostPort && !seen.has(hostPort)) { seen.add(hostPort); out.push(hostPort); }
  };

  add(withFieldPort(preferred));
  add(`${FIELD_DEFAULT_HOST}:${FIELD_PORT}`);
  for (let i = 1; i < 255; i++) add(`10.0.100.${i}:${FIELD_PORT}`);

  for (const list of Object.values(interfaces)) {
    for (const net of list ?? []) {
      // Node 18.0-18.3 reported family as a number; harmless to accept both.
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      const parts = net.address.split('.').map(Number);
      if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) continue;
      if (parts[0] === 127) continue;
      if (parts[0] === 169 && parts[1] === 254) continue;
      const base = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      for (let i = 1; i < 255; i++) add(`${base}${i}:${FIELD_PORT}`);
    }
  }
  return out;
}

function split(hostPort: string): { host: string; port: number } {
  const i = hostPort.lastIndexOf(':');
  return { host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) };
}

/**
 * Is anything listening on host:port? Connect and close, nothing sent.
 * The launcher's TcpOpen, and the cheap half of a sweep.
 */
export function knock(hostPort: string, timeoutMs: number = FINDER_TIMING.knockTimeoutMs): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const { host, port } = split(hostPort);
    let socket: ReturnType<typeof connect> | null = null;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    try {
      socket = connect({ host, port });
      socket.unref();
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * The launcher's LooksLikeCheesy: one GET of /api/rankings, 200 with a body
 * that starts like JSON. Only the first few bytes are read; a server that
 * streams forever is cut off by the timeout, and a redirect is a no.
 */
export function looksLikeCheesy(
  hostPort: string, timeoutMs: number = FINDER_TIMING.checkTimeoutMs,
): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const { host, port } = split(hostPort);
    let req: ReturnType<typeof request> | null = null;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    try {
      req = request({
        host, port, path: FIELD_PROBE_PATH,
        // Fixed, not a parameter: a typo here cannot become a POST.
        method: 'GET',
        // A fresh connection, closed after: no keep-alive socket left open
        // to a machine that may not be the field at all.
        agent: false,
        headers: { 'User-Agent': 'CalGames-ContentDesk', Connection: 'close' },
      }, res => {
        if (res.statusCode !== 200) { finish(false); return; }
        let head = '';
        res.setEncoding('utf8');
        const judge = (): boolean => {
          const t = head.trimStart();
          return t.startsWith('[') || t.startsWith('{');
        };
        res.on('data', (chunk: string) => {
          head += chunk;
          if (head.trimStart().length > 0 || head.length > 64) finish(judge());
        });
        res.on('end', () => finish(judge()));
        res.on('error', () => finish(false));
      });
      req.on('error', () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

export interface FieldFinderOpts {
  /** host:port strings in the order to try them; see fieldCandidates. Read at each sweep. */
  candidates: () => string[];
  /** Called once, with the host:port that answered as Cheesy Arena. */
  onFound: (hostPort: string) => void;
  /** Defaults to knock(); a test passes its own. */
  knock?: (hostPort: string) => Promise<boolean>;
  /** Defaults to looksLikeCheesy(); a test passes its own. */
  check?: (hostPort: string) => Promise<boolean>;
  log?: (line: string) => void;
  sweepEveryMs?: number;
  probesPerSecond?: number;
  maxInFlight?: number;
  leadCount?: number;
}

const sleep = (ms: number): Promise<void> => new Promise(r => {
  const t = setTimeout(r, ms);
  t.unref();
});

export class FieldFinder {
  #opts: FieldFinderOpts;
  #knock: (hostPort: string) => Promise<boolean>;
  #check: (hostPort: string) => Promise<boolean>;
  #running = false;
  #found: string | null = null;
  #sweeping = false;
  /** Set by retarget(): the sweep in progress winds down and the next one starts at once. */
  #again = false;
  #timer: NodeJS.Timeout | null = null;
  #sweeps = 0;
  #lastCount = -1;

  constructor(opts: FieldFinderOpts) {
    this.#opts = opts;
    this.#knock = opts.knock ?? (h => knock(h));
    this.#check = opts.check ?? (h => looksLikeCheesy(h));
  }

  get running(): boolean { return this.#running; }
  get sweeping(): boolean { return this.#sweeping; }
  /** Sweeps begun, for the tests and the log. */
  get sweeps(): number { return this.#sweeps; }
  get found(): string | null { return this.#found; }

  start(): void {
    if (this.#running || this.#found) return;
    this.#running = true;
    this.#schedule(0);
  }

  /** Stops looking. In-flight probes finish on their own timeouts and are ignored. */
  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * The settings page named a different field address. The sweep in progress
   * stops launching probes, and the next one, with the new address first,
   * starts as soon as it has wound down rather than half a minute later.
   * Still one sweep at a time.
   */
  retarget(): void {
    if (!this.#running || this.#found) return;
    if (this.#sweeping) { this.#again = true; return; }
    this.#schedule(0);
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#sweep();
    }, ms);
    this.#timer.unref();
  }

  #log(line: string): void {
    try { this.#opts.log?.(line); } catch { /* a broken logger must not stop the search */ }
  }

  /** True once the field is found or the finder was stopped: stop launching probes. */
  #over(): boolean { return !this.#running || this.#found !== null || this.#again; }

  async #sweep(): Promise<void> {
    if (!this.#running || this.#found || this.#sweeping) return;
    this.#sweeping = true;
    this.#again = false;
    this.#sweeps++;
    try {
      let list: string[];
      try { list = this.#opts.candidates(); } catch (err) {
        this.#log(`could not list this computer's networks (${(err as Error).message}); `
          + 'trying the field network only');
        list = fieldCandidates(null, {});
      }
      if (list.length !== this.#lastCount) {
        // Said once, and again only when the list changes (a network came or
        // went): every 30 seconds would bury desk-log.txt.
        this.#lastCount = list.length;
        this.#log(`looking for the field by itself: ${list.length} address(es), `
          + `read-only (GET ${FIELD_PROBE_PATH}), then again every `
          + `${Math.round((this.#opts.sweepEveryMs ?? FINDER_TIMING.sweepEveryMs) / 1000)} s until it answers`);
      }
      await this.#run(list);
    } catch (err) {
      this.#log(`a search for the field failed (${(err as Error).message}); trying again shortly`);
    } finally {
      this.#sweeping = false;
    }
    if (!this.#running || this.#found) return;
    this.#schedule(this.#again ? 0 : (this.#opts.sweepEveryMs ?? FINDER_TIMING.sweepEveryMs));
  }

  async #probe(hostPort: string): Promise<void> {
    let open = false;
    try { open = await this.#knock(hostPort); } catch { open = false; }
    if (!open || this.#found || !this.#running) return;
    let yes = false;
    try { yes = await this.#check(hostPort); } catch { yes = false; }
    if (!yes || this.#found || !this.#running) return;
    this.#found = hostPort;
    this.stop();
    this.#log(`found Cheesy Arena at ${hostPort}`);
    try { this.#opts.onFound(hostPort); } catch (err) {
      this.#log(`the field was found but could not be attached (${(err as Error).message})`);
    }
  }

  async #run(list: string[]): Promise<void> {
    const lead = Math.max(0, this.#opts.leadCount ?? FINDER_TIMING.leadCount);
    // The likely addresses alone, one after the other: at an FRC event the
    // first of them nearly always answers, and then nothing else is touched.
    for (const hostPort of list.slice(0, lead)) {
      if (this.#over()) return;
      await this.#probe(hostPort);
    }

    const rest = list.slice(lead);
    const gapMs = 1000 / Math.max(1, this.#opts.probesPerSecond ?? FINDER_TIMING.probesPerSecond);
    const cap = Math.max(1, this.#opts.maxInFlight ?? FINDER_TIMING.maxInFlight);
    const inFlight = new Set<Promise<void>>();
    let nextAt = Date.now();
    for (const hostPort of rest) {
      if (this.#over()) break;
      while (inFlight.size >= cap) await Promise.race(inFlight);
      if (this.#over()) break;
      const wait = nextAt - Date.now();
      // Under a millisecond is not worth a timer: Windows rounds it up to
      // its 15 ms tick, which would pace far slower than asked.
      if (wait >= 1) await sleep(wait);
      if (this.#over()) break;
      // From the moment this one goes out, never from when it was due: after
      // a wait on the in-flight cap a due-time schedule would fire a burst.
      nextAt = Date.now() + gapMs;
      const p: Promise<void> = this.#probe(hostPort).finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    }
    // One sweep at a time means its stragglers too: the next sweep starts
    // only once every probe of this one has finished or timed out.
    await Promise.allSettled([...inFlight]);
  }
}
