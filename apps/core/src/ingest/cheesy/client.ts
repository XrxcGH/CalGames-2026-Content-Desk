/**
 * Hardened Cheesy Arena client. See docs/10-field-bridge.md.
 *
 * The FTA's condition is that nothing we do can interfere with Cheesy Arena
 * controlling the field. That resolves to a hard endpoint allowlist, and the
 * guarantee behind it is structural rather than procedural:
 *
 *   Cheesy Arena's `websocket.HandleNotifiers` never calls Read(). Endpoints
 *   whose handler is HandleNotifiers-only CANNOT process anything we send.
 *
 * The endpoints that DO have a read loop are exactly the dangerous ones:
 *   /match_play/websocket                startMatch, abortMatch, discardResults
 *   /panels/scoring/{position}/websocket  autoTower, endgame, addFoul
 *   /panels/referee/websocket            fouls and cards
 *   POST /setup/db/clear/{type}          wipes the event database
 *
 * None of those are reachable from here, by construction.
 */

import { WebSocket } from 'ws';

/** WebSocket endpoints. Every one is HandleNotifiers-only (verified in source). */
export const ALLOWED_SOCKETS = [
  '/api/arena/websocket',
  '/displays/audience/websocket',
  '/displays/field_monitor/websocket',
  '/displays/queueing/websocket',
  '/displays/rankings/websocket',
  '/displays/bracket/websocket',
] as const;

/** GET-only REST endpoints. Note that get() parses every response as JSON, so
 *  the binary entries (/api/bracket/svg, and /api/teams/{id}/avatar under the
 *  /api/teams/ prefix) are allowlisted for the future but need a raw-bytes
 *  variant of get() before anything can actually fetch them. */
export const ALLOWED_PATHS = [
  '/api/matches/',
  '/api/rankings',
  '/api/alliances',
  '/api/teams/',
  '/api/bracket/svg',
  '/api/sponsor_slides',
] as const;

export type AllowedSocket = typeof ALLOWED_SOCKETS[number];

export function assertSocketAllowed(path: string): asserts path is AllowedSocket {
  if (!(ALLOWED_SOCKETS as readonly string[]).includes(path)) {
    throw new Error(`Refusing to open "${path}". Only HandleNotifiers-only display sockets ` +
      `are permitted: /match_play and /panels/* accept commands that can abort a match or ` +
      `corrupt scoring.`);
  }
}

/** Throws unless the path is on the read allowlist. Returns the normalized
 *  path, which is what MUST be requested: checking one string and fetching
 *  another is how the allowlist gets bypassed. */
export function assertPathAllowed(path: string): string {
  // Parse the way fetch() will before matching anything. A raw-string check
  // missed percent-encoded dot segments: "/api/matches/%2e%2e/%2e%2e/setup/
  // settings" contains no literal ".." and starts with an allowed prefix, but
  // fetch normalizes it onto /setup/settings. Checking the parsed pathname
  // closes that gap, and the same parsed value is what gets requested.
  const parsed = new URL(path, 'http://placeholder');
  const bare = parsed.pathname;
  // Parsing resolves ordinary dot segments, so any ".." still present here
  // (e.g. a half-encoded "..%2f" segment) is hostile enough to reject outright.
  if (bare.includes('..')) {
    throw new Error(`Refusing to request "${bare}": a path segment is not allowed.`);
  }
  // Entries ending in "/" are deliberate prefixes (one Cheesy path per match
  // type or team id); everything else must match exactly, or a path like
  // "/api/rankingsAndAlsoSomethingElse" would slip through on a substring hit.
  const allowed = ALLOWED_PATHS.some(p => p.endsWith('/') ? bare.startsWith(p) : bare === p);
  if (!allowed) {
    throw new Error(`Refusing to request "${bare}". Not on the read allowlist.`);
  }
  return bare + parsed.search;
}

export interface AuditEntry { ts: number; method: string; url: string; status: number | string }

export interface CheesyClientOpts {
  /** e.g. "10.0.100.5:8080" */
  host: string;
  /**
   * Registered with Cheesy so we appear as a normal auxiliary display rather
   * than being assigned an id and redirected. Agree this with the scorekeeper
   * so it cannot collide with a real audience screen.
   */
  displayId: string;
  onEvent: (notifier: string, data: unknown) => void;
  onStatus?: (connected: boolean, detail: string) => void;
}

export class CheesyClient {
  #opts: CheesyClientOpts;
  #sockets = new Map<string, WebSocket>();
  #backoff = new Map<string, number>();
  #timers = new Set<NodeJS.Timeout>();
  #audit: AuditEntry[] = [];
  #stopping = false;
  #connected = new Set<string>();

  constructor(opts: CheesyClientOpts) { this.#opts = opts; }

  get connected(): boolean { return this.#connected.size > 0; }
  /** Printable for the FTA: every request we have made, in order. */
  get audit(): readonly AuditEntry[] { return this.#audit; }

  #record(method: string, url: string, status: number | string): void {
    this.#audit.push({ ts: Date.now(), method, url, status });
    if (this.#audit.length > 5000) this.#audit.shift();
  }

  connect(paths: readonly string[] = ALLOWED_SOCKETS): void {
    for (const path of paths) {
      assertSocketAllowed(path);
      this.#open(path);
    }
  }

  #open(path: string): void {
    if (this.#stopping) return;

    // Display sockets want an explicit id; without one Cheesy allocates one and
    // issues a redirect, which is state we did not ask it to create.
    const needsId = path.startsWith('/displays/');
    const url = `ws://${this.#opts.host}${path}` +
      (needsId ? `?displayId=${encodeURIComponent(this.#opts.displayId)}` : '');

    const ws = new WebSocket(url);
    this.#sockets.set(path, ws);
    this.#record('WS', url, 'open');

    ws.on('open', () => {
      this.#connected.add(path);
      this.#opts.onStatus?.(true, path);
      // The backoff resets only after the socket has stayed up a while. An
      // arena that accepts and immediately closes (mid-restart, a proxy
      // hiccup) used to reset on the accept, turning the 60s cap into a ~1s
      // reconnect loop per socket forever: the exact storm the backoff
      // promises the FTA cannot happen. 30s of health is proof of life; the
      // recorder's supervisor uses the same settle pattern.
      const settle = setTimeout(() => {
        this.#timers.delete(settle);
        if (this.#sockets.get(path) === ws) this.#backoff.set(path, 500);
      }, 30_000);
      this.#timers.add(settle);
    });

    ws.on('message', raw => {
      // Cheesy frames are {type, data}.
      let msg: { type?: string; data?: unknown };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      if (msg.type) this.#opts.onEvent(msg.type, msg.data);
    });

    // We never send an application frame. The endpoints cannot read one, but
    // belt and suspenders: there is no code path here that writes.
    ws.on('close', () => this.#reopen(path, 'closed'));
    ws.on('error', err => this.#reopen(path, err.message));
  }

  #reopen(path: string, why: string): void {
    if (this.#stopping) return;
    if (!this.#sockets.has(path)) return;
    this.#sockets.delete(path);
    this.#connected.delete(path);
    this.#opts.onStatus?.(false, `${path}: ${why}`);

    // Backoff caps at 60s. A reconnect storm during a field reset is the most
    // plausible way this project causes a problem, so this is the important
    // part of the whole client. Jitter matters as much as the cap: six sockets
    // that all drop together (the arena restarting) must not also retry
    // together, or backoff just delays the storm instead of preventing it.
    const base = Math.min(60_000, (this.#backoff.get(path) ?? 500) * 2);
    this.#backoff.set(path, base);
    const wait = base * (0.75 + Math.random() * 0.5);
    const t = setTimeout(() => { this.#timers.delete(t); this.#open(path); }, wait);
    this.#timers.add(t);
  }

  /**
   * GET, and only GET. The method is not a parameter, so a typo cannot become a
   * POST to /setup/db/clear.
   */
  async get<T>(path: string, timeoutMs = 8000): Promise<T> {
    // The URL is built from what the allowlist actually checked, so the
    // checked string and the requested string cannot diverge.
    const safePath = assertPathAllowed(path);
    const url = `http://${this.#opts.host}${safePath}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // The audit log promises one entry per request. A non-ok response used to
    // land twice: once with its status, again from the catch with the thrown
    // error's name, overstating the request count shown to the FTA.
    let recorded = false;
    try {
      const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      this.#record('GET', url, res.status);
      recorded = true;
      if (!res.ok) throw new Error(`Cheesy GET ${path} -> ${res.status}`);
      return await res.json() as T;
    } catch (err) {
      if (!recorded) this.#record('GET', url, (err as Error).name);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Kill switch. Everything downstream degrades to manual and keeps running. */
  close(): void {
    this.#stopping = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    for (const [, ws] of this.#sockets) ws.close();
    this.#sockets.clear();
    this.#connected.clear();
  }
}
