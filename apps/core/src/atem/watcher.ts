/**
 * AtemWatcher: what the vision switcher has on air, read without touching it.
 *
 * The venue kit's switcher (an ATEM Constellation on the field network) is
 * driven by the AV crew from the panel and from ATEM Software Control on the
 * AV table. The desk only needs to KNOW: which input is on program, which
 * keyers are up (Cheesy Arena's score overlay is a luma key on DSK1), what
 * video mode the switcher runs, and what the inputs are called. So this is
 * a watcher, read-only by construction, in the same spirit as the Cheesy
 * Arena bridge being receive-only by construction:
 *
 *   The only bytes it can put on the wire come from buildClientDatagram()
 *   in protocol.ts, which builds a hello or an acknowledgement and nothing
 *   else. #send() below is the single place this file writes to a socket,
 *   and it takes a ClientDatagram, not bytes. There is no command encoder
 *   on this side at all, so "cut to camera 2" cannot be expressed, let
 *   alone sent.
 *
 * The switcher's client slots are shared with every copy of ATEM Software
 * Control on the AV table, so the second rule is politeness:
 *
 *   One session at a time. The probe that finds the switcher runs on this
 *   watcher's own socket, and the hello answer that ends the search is the
 *   handshake the session continues on, so finding it never costs a second
 *   slot. Retries back off from 5 s to 60 s, a sweep of the network runs at
 *   most once a minute, and after a session ends the same switcher gets no
 *   new hello for at least 5 s, so its old slot has time to lapse first.
 *
 * And the third, because this runs inside the desk's process during a live
 * show: nothing here may throw out of a socket or timer callback. Every
 * callback goes through #guard(), every read in protocol.ts is
 * bounds-checked, every timer is unref'd, and stop() closes the socket and
 * clears every timer.
 *
 * Long waits (silence, backoff, the once-a-minute sweep) are measured with
 * the injected now(), on a 250 ms tick, so a test can move time without
 * waiting for it. Short ones (the 5 ms ack batch, the 20 ms probe pacing)
 * are real timers, because they pace real packets.
 */

import { EventEmitter } from 'node:events';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  ATEM_PORT,
  HelloAnswerCode,
  MAX_PACKET_ID,
  PacketFlag,
  buildClientDatagram,
  helloAnswerCode,
  parseCommand,
  parsePacket,
  protocolLabel,
  splitCommands,
  videoModeInfo,
  type AtemCommand,
  type AtemPacket,
  type ClientDatagram,
  type KeyType,
} from './protocol.ts';
import { DEFAULT_CANDIDATE_CAP, HelloProbe, describeSubnets, discoveryCandidates } from './discover.ts';

export interface AtemInput { id: number; longName: string; shortName: string }

export interface AtemKeyer {
  kind: 'upstream' | 'downstream';
  /** The M/E, counted from 1 as on the panel; null for a downstream keyer. */
  me: number | null;
  /** Counted from 1 as on the panel: DSK1 is index 1, upstream key 1 is index 1. */
  index: number;
  /** True when the key is visible, including part way through an auto transition. */
  onAir: boolean;
  type: 'luma' | 'chroma' | 'pattern' | 'dve' | null;
  fillSource: number | null;
  keySource: number | null;
}

export interface AtemStatus {
  state: 'off' | 'searching' | 'connecting' | 'connected' | 'lost';
  host: string | null;
  model: string | null;
  protocol: string | null;
  videoMode: { id: number; label: string; width: number; height: number; fps: number } | null;
  /** M/E 1's program input id. */
  program: number | null;
  /** M/E 1's preview input id. */
  preview: number | null;
  inputs: AtemInput[];
  keyers: AtemKeyer[];
  /** When the current state began (now() clock). */
  since: number | null;
  /** When the switcher was last heard from. Does not, on its own, cause a 'change'. */
  lastHeard: number | null;
  /** Plain words a volunteer can act on, or null. */
  error: string | null;
}

export interface AtemWatcherOptions {
  /** The switcher's address from the settings page, e.g. "10.0.100.40". */
  host?: string | null;
  /** Sweep the local networks when no host is set or it does not answer. Default true. */
  discover?: boolean;
  /** Where to sweep. Default: discoveryCandidates() over os.networkInterfaces(). */
  candidates?: () => string[];
  log?: (line: string) => void;
  /** Default 9910. Tests point it at the fake switcher's free port. */
  port?: number;
  /** Default Date.now. */
  now?: () => number;
}

/**
 * Every interval the watcher keeps. Exported read-only so the wiring owner
 * and the tests can quote them rather than hard-code copies.
 */
export const ATEM_TIMING = {
  /** atemSocketChild.js `CONNECTION_TIMEOUT = 5000`: this long without a packet is a lost switcher. */
  silenceMs: 5_000,
  /** How long after the last hello of a run we wait for an answer. A switcher on the LAN answers in under a millisecond. */
  helloWaitMs: 2_000,
  /** The floor and the cap of the retry backoff. */
  backoffMinMs: 5_000,
  backoffMaxMs: 60_000,
  /** A full sweep of the networks never starts sooner than this after the last. */
  sweepEveryMs: 60_000,
  /** A session that stayed connected this long resets the backoff when it ends (the Cheesy client's settle rule). */
  settleMs: 30_000,
  /** A switcher that answered but has not finished its state dump by now gets a message. */
  slowSetupMs: 10_000,
  tickMs: 250,
  /** atemSocketChild.js `_sendOrQueueAck`: ack after 5 ms, or at once after `MAX_PACKET_PER_ACK = 16`. */
  ackDelayMs: 5,
  acksPerBatch: 16,
  /** atemSocketChild.js `MAX_OUT_OF_ORDER_PACKETS = 256`. */
  maxOutOfOrder: 256,
  /** Bursts of changes inside this window become one 'change'. */
  emitDebounceMs: 10,
} as const;

/*
 * Caps on what a switcher can make us remember. A Constellation 8K has a
 * few hundred sources in all; these only stop a garbage stream from growing
 * the status without bound.
 */
const MAX_INPUTS = 1024;
const MAX_MES = 8;
const MAX_UPSTREAM_PER_ME = 16;
const MAX_DOWNSTREAM = 8;

type Phase = 'idle' | 'waiting' | 'probing' | 'session';

interface Session {
  host: string;
  sessionId: number;
  /** The switcher's last packet id we have, in sequence. */
  lastRemoteId: number;
  startedAt: number;
  connectedAt: number | null;
  /** Packets that arrived ahead of a gap, by id, until the gap fills. */
  pending: Map<number, Buffer>;
  stalledSince: number | null;
  unacked: number;
  complete: boolean;
  toldRetransmit: boolean;
  toldSendError: boolean;
}

interface ProbeRun {
  hosts: string[];
  full: boolean;
  /** now() when the last hello of the run went out, or null while still sending. */
  doneAt: number | null;
  /** The first send error toward the target host, which explains a silence better than "no answer". */
  targetError: string | null;
}

interface Upstream { me: number; index: number; onAir: boolean; type: KeyType | null; fill: number | null; key: number | null }
interface Downstream { index: number; onAir: boolean; inTransition: boolean; fill: number | null; key: number | null }

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function secs(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s === 60) return '1 minute';
  return `${s} s`;
}

/** What to tell a volunteer when a send fails, by the code the OS gave. */
function sendErrorHint(code: string, host: string): string {
  switch (code) {
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return `This computer has no network route to ${host}. Check its network cable and that it has an address on the same network.`;
    case 'EACCES':
    case 'EPERM':
      return `Windows or a firewall stopped the desk sending to ${host}. Allow Node.js on private networks in Windows Defender Firewall.`;
    case 'EADDRNOTAVAIL':
      return "This computer's network address changed. Check its network cable.";
    default:
      return `Sending to ${host} failed (${code}).`;
  }
}

/**
 * The settings page hands us whatever was typed. Only an IPv4 address is a
 * switcher address: ATEMs are set up by number in ATEM Setup, and a name
 * would need a DNS lookup whose answer could not be matched against the
 * address the replies come from.
 */
function normalizeHost(host: string | null | undefined, port: number): { value: string | null; error: string | null } {
  if (host === null || host === undefined) return { value: null, error: null };
  let h = String(host).trim();
  if (h === '') return { value: null, error: null };
  const shown = h.length > 40 ? `${h.slice(0, 40)}...` : h;
  const withPort = /^(.+):(\d{1,5})$/.exec(h);
  if (withPort && isIPv4(withPort[1] ?? '')) {
    if (Number(withPort[2]) !== port) {
      return { value: null, error: `"${shown}" names port ${withPort[2]}, but the switcher listens on ${port}. Type just the address, like 10.0.100.40.` };
    }
    h = withPort[1] ?? '';
  }
  if (!isIPv4(h)) {
    return { value: null, error: `"${shown}" is not a switcher address. Type four numbers with dots, like 10.0.100.40 (ATEM Setup shows it under Network).` };
  }
  return { value: h, error: null };
}

export class AtemWatcher extends EventEmitter<{ change: [AtemStatus] }> {
  #opts: AtemWatcherOptions;
  #port: number;
  #now: () => number;
  #discover: boolean;

  #configured: string | null;
  #hostError: string | null;
  /** The last switcher discovery found: retried, when discovery is on. */
  #found: string | null = null;
  /** The switcher of the last session, which is the first one worth asking again. */
  #lastHost: string | null = null;

  #running = false;
  #phase: Phase = 'idle';
  #socket: Socket | null = null;
  #tick: NodeJS.Timeout | null = null;
  #ackTimer: NodeJS.Timeout | null = null;
  #emitTimer: NodeJS.Timeout | null = null;
  #lastTickAt = 0;

  #probe: HelloProbe;
  #run: ProbeRun | null = null;
  #nextAttemptAt = 0;
  #backoffMs: number = ATEM_TIMING.backoffMinMs;
  #lastSweepAt = Number.NEGATIVE_INFINITY;
  /** host -> now() before which it gets no hello (its previous session's slot is still lapsing). */
  #quiet = new Map<string, number>();

  #session: Session | null = null;
  /** Set when a session is lost, and the state stays 'lost' until a new one starts. */
  #lostHost: string | null = null;

  #state: AtemStatus['state'] = 'off';
  #since: number | null = null;
  #lastHeard: number | null = null;
  #error: string | null = null;
  #lastKey: string | null = null;

  #model: string | null = null;
  #protocol: string | null = null;
  #topology: { mixEffects: number; sources: number; downstreamKeyers: number } | null = null;
  #videoMode: AtemStatus['videoMode'] = null;
  #program: number | null = null;
  #preview: number | null = null;
  #inputs = new Map<number, AtemInput>();
  #upstream = new Map<string, Upstream>();
  #downstream = new Map<number, Downstream>();

  constructor(opts: AtemWatcherOptions = {}) {
    super();
    this.#opts = opts;
    this.#port = opts.port ?? ATEM_PORT;
    this.#now = opts.now ?? Date.now;
    this.#discover = opts.discover ?? true;
    const h = normalizeHost(opts.host, this.#port);
    this.#configured = h.value;
    this.#hostError = h.error;
    this.#probe = new HelloProbe({
      // The probe can do exactly one thing to the network: ask for a hello.
      send: host => this.#send({ kind: 'hello' }, host),
      onSent: () => { if (this.#run) this.#run.doneAt = this.#now(); },
    });
  }

  /**
   * A fresh copy every time: callers may keep or mutate it freely.
   *
   * While connecting, the switcher's half is held back even though the dump
   * is arriving: a status read half way through it would show some inputs
   * and not others, or a program input without the keys over it. It all
   * appears at once when InCm says the dump is complete.
   */
  get status(): AtemStatus {
    const host = this.#session ? this.#session.host : this.#state === 'lost' ? this.#lostHost : this.#configured;
    if (this.#state === 'connecting') {
      return {
        state: 'connecting', host, model: null, protocol: null, videoMode: null,
        program: null, preview: null, inputs: [], keyers: [],
        since: this.#since, lastHeard: this.#lastHeard, error: this.#error,
      };
    }
    const upstream = [...this.#upstream.values()]
      .sort((a, b) => a.me - b.me || a.index - b.index)
      .map((k): AtemKeyer => ({
        kind: 'upstream', me: k.me + 1, index: k.index + 1, onAir: k.onAir,
        type: k.type, fillSource: k.fill, keySource: k.key,
      }));
    const downstream = [...this.#downstream.values()]
      .sort((a, b) => a.index - b.index)
      .map((k): AtemKeyer => ({
        kind: 'downstream', me: null, index: k.index + 1,
        // A DSK part way through an auto transition is visible on program,
        // whichever way it is going, so it counts as on air.
        onAir: k.onAir || k.inTransition,
        // DskB and DskS carry no key type because a downstream keyer has
        // only one: a luma (linear) key of its fill by its key source.
        type: 'luma', fillSource: k.fill, keySource: k.key,
      }));
    return {
      state: this.#state,
      host,
      model: this.#model,
      protocol: this.#protocol,
      videoMode: this.#videoMode ? { ...this.#videoMode } : null,
      program: this.#program,
      preview: this.#preview,
      inputs: [...this.#inputs.values()].sort((a, b) => a.id - b.id).map(i => ({ ...i })),
      keyers: [...upstream, ...downstream],
      since: this.#since,
      lastHeard: this.#lastHeard,
      error: this.#error,
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const now = this.#now();
    this.#lastTickAt = now;
    this.#tick = setInterval(() => this.#guard(() => this.#onTick()), ATEM_TIMING.tickMs);
    this.#tick.unref();
    this.#backoffMs = ATEM_TIMING.backoffMinMs;
    this.#phase = 'waiting';
    this.#nextAttemptAt = now;
    this.#setError(this.#hostError);
    this.#setState(this.#idleState(), now);
    this.#guard(() => this.#attempt(now));
  }

  /**
   * Closes the socket and clears every timer, and resolves once the socket
   * is really closed, so a desk shutting down can await it and know the
   * process is free to exit. Safe to call twice, or before start().
   */
  async stop(): Promise<void> {
    const wasRunning = this.#running;
    this.#running = false;
    const now = this.#now();
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;
    this.#probe.stop();
    this.#run = null;
    // A session in progress ends the way any other does, which also keeps
    // its switcher on the quiet list: a stop() and start() in a row (the
    // wiring restarting the watcher) must not take a second slot while the
    // first is still lapsing on the switcher.
    const s = this.#session;
    const closing = s ? this.#endSession(s, now) : this.#closeSocket();
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    this.#lostHost = null;
    this.#phase = 'idle';
    this.#resetSwitcher();
    this.#lastHeard = null;
    this.#error = null;
    this.#setState('off', now);
    if (this.#emitTimer) clearTimeout(this.#emitTimer);
    this.#emitTimer = null;
    if (wasRunning) this.#flush();
    await closing;
  }

  /**
   * Live from the settings page. A new address is tried at once. null (or a
   * blank) means go back to searching when discovery is on, else off. The
   * same address again is a no-op, so calling this on every config save is
   * safe.
   */
  setHost(host: string | null): void {
    this.#guard(() => {
      const h = normalizeHost(host, this.#port);
      if (h.value === this.#configured && h.error === this.#hostError) return;
      this.#configured = h.value;
      this.#hostError = h.error;
      this.#backoffMs = ATEM_TIMING.backoffMinMs;
      if (!this.#running) {
        this.#setError(h.error);
        this.#scheduleEmit();
        return;
      }
      const now = this.#now();
      const s = this.#session;
      // Already talking to the switcher at that address (discovery found
      // it, and now someone typed it in): nothing to change.
      if (s && h.value !== null && s.host === h.value) {
        this.#scheduleEmit();
        return;
      }
      if (s) this.#abandon(s, now);
      // The settings now say where to look, so the switchers this watcher
      // found or last talked to stop being retried ahead of it.
      this.#lastHost = null;
      this.#found = null;
      if (this.#phase === 'probing') {
        this.#probe.stop();
        this.#run = null;
      }
      this.#lostHost = null;
      this.#setError(h.error);
      this.#phase = 'waiting';
      this.#nextAttemptAt = now;
      this.#setState(this.#idleState(), now);
      this.#attempt(now);
    });
  }

  // ---- the attempt cycle ------------------------------------------------------

  /**
   * Where a retry between sweeps goes: the switcher we last had a session
   * with, then the configured address, then the one discovery last found.
   * Without discovery only the configured address is ever asked. The
   * switcher we just lost comes first because it is the one that was
   * actually there: a configured address that never answered, while a
   * sweep found the switcher one number along, must not be all a retry
   * asks for the rest of the minute.
   */
  #retryHosts(): string[] {
    const list: string[] = [];
    if (this.#lastHost && (this.#discover || this.#lastHost === this.#configured)) list.push(this.#lastHost);
    if (this.#configured) list.push(this.#configured);
    if (this.#discover && this.#found) list.push(this.#found);
    return [...new Set(list)];
  }

  /** The state to show while there is no session. 'lost' sticks until a new session starts. */
  #idleState(): AtemStatus['state'] {
    if (!this.#running) return 'off';
    if (this.#lostHost !== null) return 'lost';
    if (this.#configured) return 'connecting';
    return this.#discover ? 'searching' : 'off';
  }

  #attempt(now: number): void {
    if (!this.#running || this.#session) return;
    const retry = this.#retryHosts();
    const sweepDue = this.#discover && now - this.#lastSweepAt >= ATEM_TIMING.sweepEveryMs;
    let hosts: string[];
    if (sweepDue) {
      hosts = this.#sweepList(retry);
    } else if (retry.length > 0) {
      hosts = retry;
    } else if (this.#discover) {
      this.#wait(this.#lastSweepAt + ATEM_TIMING.sweepEveryMs);
      return;
    } else {
      // No address and no discovery: nothing to do until setHost().
      this.#phase = 'idle';
      this.#setState(this.#idleState(), now);
      return;
    }
    // A switcher we just had a session with keeps that slot until it times
    // out on its side. A hello inside that window would be a second slot.
    let quietUntil = 0;
    for (const h of hosts) quietUntil = Math.max(quietUntil, this.#quiet.get(h) ?? 0);
    if (quietUntil > now) {
      this.#wait(quietUntil);
      return;
    }
    if (sweepDue) this.#lastSweepAt = now;
    this.#run = { hosts, full: sweepDue, doneAt: null, targetError: null };
    this.#phase = 'probing';
    this.#setState(this.#idleState(), now);
    this.#probe.start(hosts);
  }

  #sweepList(retry: string[]): string[] {
    let list: string[];
    try {
      list = this.#opts.candidates
        ? this.#opts.candidates()
        : discoveryCandidates(this.#configured, networkInterfaces());
    } catch (err) {
      // os.networkInterfaces() can throw on a locked-down machine. The field
      // network is still worth a look.
      this.#log(`ATEM: could not list this computer's networks (${errorText(err)}); searching the field network only`);
      list = discoveryCandidates(this.#configured, {});
    }
    const all = [...retry, ...list];
    return [...new Set(all.filter(h => typeof h === 'string' && isIPv4(h)))].slice(0, DEFAULT_CANDIDATE_CAP);
  }

  #wait(at: number): void {
    this.#phase = 'waiting';
    this.#nextAttemptAt = at;
  }

  #nextBackoff(): number {
    const wait = Math.max(ATEM_TIMING.backoffMinMs, this.#backoffMs);
    this.#backoffMs = Math.min(ATEM_TIMING.backoffMaxMs, wait * 2);
    return wait;
  }

  #probeFailed(now: number): void {
    const run = this.#run;
    this.#run = null;
    this.#probe.stop();
    const retry = this.#retryHosts();
    let next = now + this.#nextBackoff();
    // Without a host to retry, the only thing left to do is the next sweep.
    if (retry.length === 0) next = Math.max(next, this.#lastSweepAt + ATEM_TIMING.sweepEveryMs);
    this.#setError(this.#noAnswer(run, retry, next - now));
    this.#wait(next);
  }

  #noAnswer(run: ProbeRun | null, retry: string[], waitMs: number): string {
    const target = retry.length > 0 ? retry.join(' or ') : null;
    const hint = run?.targetError && target ? sendErrorHint(run.targetError, target) : null;
    if (run && run.full) {
      const others = run.hosts.filter(h => !retry.includes(h));
      const where = describeSubnets(others) || 'this computer\'s networks';
      if (target) {
        return [
          `No answer from the switcher at ${target}, and no other switcher answered (${others.length} addresses on ${where}).`,
          hint ?? 'Check that it is powered on and plugged into the field network.',
          `Trying again in ${secs(waitMs)}.`,
        ].join(' ');
      }
      return [
        `No ATEM switcher answered on ${where} (${others.length} addresses tried).`,
        'Check that it is powered on and plugged into the same network as this computer, or type its address on the settings page.',
        `Searching again in ${secs(waitMs)}.`,
      ].join(' ');
    }
    return [
      `No answer from the switcher at ${target ?? 'the configured address'}.`,
      hint ?? `Check that it is powered on and plugged into the field network, and that ${target ?? 'the address'} is what ATEM Setup shows under Network.`,
      `Trying again in ${secs(waitMs)}.`,
    ].join(' ');
  }

  #onHelloAnswer(pkt: AtemPacket, host: string, now: number): void {
    if (this.#phase !== 'probing' || !this.#run) return;
    const code = helloAnswerCode(pkt);
    if (code === null) return;
    if (!this.#probe.answer(host)) return;
    // The once-a-minute limit is for sweeps that find nothing. One that
    // found a switcher (often on its very first hello) does not count, so a
    // later "go back to searching" is not kept waiting for it.
    if (this.#run.full) this.#lastSweepAt = Number.NEGATIVE_INFINITY;
    this.#run = null;
    if (host !== this.#configured) this.#found = host;
    if (code === HelloAnswerCode.Restart) {
      // Turned down. No ack: there is no session to ack into, and the
      // switcher has not reserved anything for us.
      this.#quiet.set(host, now + ATEM_TIMING.backoffMinMs);
      const wait = this.#nextBackoff();
      this.#setError(`The switcher at ${host} turned the desk down. It may have no free connection slots: close any copy of ATEM Software Control nobody is using. Trying again in ${secs(wait)}.`);
      this.#wait(now + wait);
      return;
    }
    this.#startSession(host, pkt, now);
  }

  // ---- the session ------------------------------------------------------------

  #startSession(host: string, pkt: AtemPacket, now: number): void {
    this.#lostHost = null;
    this.#lastHost = host;
    this.#resetSwitcher();
    this.#session = {
      host,
      sessionId: pkt.sessionId,
      lastRemoteId: pkt.packetId % MAX_PACKET_ID,
      startedAt: now,
      connectedAt: null,
      pending: new Map(),
      stalledSince: null,
      unacked: 0,
      complete: false,
      toldRetransmit: false,
      toldSendError: false,
    };
    this.#lastHeard = now;
    this.#phase = 'session';
    this.#setError(null);
    // atemSocketChild.js `_receivePacket`: the hello answer is acked at once,
    // and its packet id becomes the base of the inbound sequence.
    this.#ackNow();
    this.#setState('connecting', now);
    this.#log(`ATEM: the switcher at ${host} answered; reading its setup`);
  }

  #onSessionPacket(s: Session, pkt: AtemPacket, now: number): void {
    // atemSocketChild.js takes the session id from every packet: the
    // switcher replaces our hello's id with its own once the session is up.
    s.sessionId = pkt.sessionId;
    this.#lastHeard = now;

    if (pkt.flags & PacketFlag.NewSessionId) {
      // A repeat of the hello answer: our first ack was lost and the
      // switcher is asking again. Same handling as the first one.
      s.lastRemoteId = pkt.packetId % MAX_PACKET_ID;
      s.pending.clear();
      s.stalledSince = null;
      this.#ackNow();
      return;
    }

    if ((pkt.flags & PacketFlag.RetransmitRequest) && !s.toldRetransmit) {
      // We never send anything with a packet id, so there is nothing to
      // resend. atem-connection restarts the session here; that would cost
      // a second slot while the first one lapses, so we let the switcher
      // decide, and silence detection takes it from there if it gives up.
      s.toldRetransmit = true;
      this.#log(`ATEM: the switcher at ${s.host} asked the desk to resend; the desk sends nothing that can be resent, so it is ignoring that`);
    }

    // Only AckRequest packets carry commands (atemSocketChild.js). Ids are
    // 15 bits, and anything larger is malformed and could never be drained.
    if ((pkt.flags & PacketFlag.AckRequest) === 0 || pkt.packetId >= MAX_PACKET_ID) return;

    const distance = (pkt.packetId - s.lastRemoteId + MAX_PACKET_ID) % MAX_PACKET_ID;
    if (distance === 1) {
      s.lastRemoteId = pkt.packetId;
      this.#apply(s, pkt.payload, now);
      let drained = 0;
      for (;;) {
        const nextId = (s.lastRemoteId + 1) % MAX_PACKET_ID;
        const buffered = s.pending.get(nextId);
        if (buffered === undefined) break;
        s.pending.delete(nextId);
        s.lastRemoteId = nextId;
        drained++;
        this.#apply(s, buffered, now);
      }
      s.stalledSince = s.pending.size > 0 ? now : null;
      // Drained a gap: ack now so the switcher stops resending what we have.
      if (drained > 0) this.#ackNow();
      else this.#queueAck();
    } else if (distance > 1 && distance <= ATEM_TIMING.maxOutOfOrder) {
      // Ahead of a lost packet. Keep it until the switcher resends the gap,
      // bounded so a garbage stream cannot grow this past 256 x 2 KB.
      if (!s.pending.has(pkt.packetId)) {
        if (s.pending.size === 0) s.stalledSince = now;
        s.pending.set(pkt.packetId, Buffer.from(pkt.payload));
      }
    } else if (distance === 0 || distance > MAX_PACKET_ID / 2) {
      // A resend of something we already have: our ack was lost. Re-ack.
      this.#queueAck();
    }
  }

  #apply(s: Session, payload: Buffer, now: number): void {
    for (const raw of splitCommands(payload)) {
      const cmd = parseCommand(raw);
      if (cmd) this.#applyCommand(s, cmd, now);
    }
    this.#scheduleEmit();
  }

  #upstreamAt(me: number, keyer: number): Upstream | null {
    if (me >= MAX_MES || keyer >= MAX_UPSTREAM_PER_ME) return null;
    const id = `${me}/${keyer}`;
    let k = this.#upstream.get(id);
    if (!k) {
      k = { me, index: keyer, onAir: false, type: null, fill: null, key: null };
      this.#upstream.set(id, k);
    }
    return k;
  }

  #downstreamAt(index: number): Downstream | null {
    if (index >= MAX_DOWNSTREAM) return null;
    let k = this.#downstream.get(index);
    if (!k) {
      k = { index, onAir: false, inTransition: false, fill: null, key: null };
      this.#downstream.set(index, k);
    }
    return k;
  }

  #applyCommand(s: Session, cmd: AtemCommand, now: number): void {
    switch (cmd.name) {
      case '_ver':
        this.#protocol = protocolLabel(cmd.version);
        break;
      case '_pin':
        this.#model = cmd.product || (cmd.model !== null ? `ATEM (model ${cmd.model})` : null);
        break;
      case '_top':
        this.#topology = { mixEffects: cmd.mixEffects, sources: cmd.sources, downstreamKeyers: cmd.downstreamKeyers };
        break;
      case 'VidM':
        this.#videoMode = videoModeInfo(cmd.mode);
        break;
      case 'InPr':
        if (this.#inputs.size < MAX_INPUTS || this.#inputs.has(cmd.id)) {
          this.#inputs.set(cmd.id, { id: cmd.id, longName: cmd.longName, shortName: cmd.shortName });
        }
        break;
      case 'PrgI':
        if (cmd.me === 0) this.#program = cmd.source;
        break;
      case 'PrvI':
        if (cmd.me === 0) this.#preview = cmd.source;
        break;
      case 'KeOn': {
        const k = this.#upstreamAt(cmd.me, cmd.keyer);
        if (k) k.onAir = cmd.onAir;
        break;
      }
      case 'KeBP': {
        const k = this.#upstreamAt(cmd.me, cmd.keyer);
        if (k) { k.type = cmd.type; k.fill = cmd.fillSource; k.key = cmd.keySource; }
        break;
      }
      case 'DskS': {
        const k = this.#downstreamAt(cmd.keyer);
        if (k) { k.onAir = cmd.onAir; k.inTransition = cmd.inTransition; }
        break;
      }
      case 'DskB': {
        const k = this.#downstreamAt(cmd.keyer);
        if (k) { k.fill = cmd.fillSource; k.key = cmd.keySource; }
        break;
      }
      case 'InCm':
        if (!s.complete) {
          s.complete = true;
          s.connectedAt = now;
          this.#setError(null);
          this.#setState('connected', now);
          const topo = this.#topology;
          const shape = topo ? `, ${topo.mixEffects} M/E, ${topo.downstreamKeyers} DSK` : '';
          this.#log(`ATEM: connected to ${this.#model ?? 'the switcher'} at ${s.host} (protocol ${this.#protocol ?? 'unknown'}, ${this.#videoMode?.label ?? 'unknown video mode'}${shape})`);
        }
        break;
    }
  }

  #queueAck(): void {
    const s = this.#session;
    if (!s) return;
    s.unacked++;
    if (s.unacked >= ATEM_TIMING.acksPerBatch) {
      this.#ackNow();
      return;
    }
    if (!this.#ackTimer) {
      this.#ackTimer = setTimeout(() => {
        this.#ackTimer = null;
        this.#guard(() => this.#ackNow());
      }, ATEM_TIMING.ackDelayMs);
      this.#ackTimer.unref();
    }
  }

  /** Acks everything up to the last in-sequence packet: acks are cumulative. */
  #ackNow(): void {
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    const s = this.#session;
    if (!s) return;
    s.unacked = 0;
    this.#send({ kind: 'ack', sessionId: s.sessionId, packetId: s.lastRemoteId }, s.host);
  }

  #checkSession(s: Session, now: number): void {
    const heard = this.#lastHeard ?? s.startedAt;
    if (now - heard >= ATEM_TIMING.silenceMs) {
      this.#lose(s, `nothing heard from it for ${secs(ATEM_TIMING.silenceMs)}`, now);
      return;
    }
    if (s.stalledSince !== null && now - s.stalledSince >= ATEM_TIMING.silenceMs) {
      this.#lose(s, 'part of what it sent never arrived', now);
      return;
    }
    if (!s.complete && now - s.startedAt >= ATEM_TIMING.slowSetupMs) {
      this.#setError(`The switcher at ${s.host} answered but has not finished sending its setup after ${secs(ATEM_TIMING.slowSetupMs)}. The desk is still listening.`);
    }
  }

  /**
   * Ends a session on our side. There is no goodbye in the protocol: we just
   * stop acking, and the switcher drops the slot when its retries run out.
   * The socket is replaced (atemSocketChild.js `restartConnection` recreates
   * it too), so the next session starts from a fresh port and nothing the
   * old one still has in flight can be mistaken for the new one.
   */
  #endSession(s: Session, now: number): Promise<void> {
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    this.#session = null;
    this.#quiet.set(s.host, now + ATEM_TIMING.backoffMinMs);
    return this.#closeSocket();
  }

  #lose(s: Session, reason: string, now: number): void {
    void this.#endSession(s, now);
    // A session that was healthy for a while earns a fast first retry. One
    // that dropped straight away does not, or a switcher that accepts and
    // then drops us would get a hello every 5 s forever.
    if (s.connectedAt !== null && now - s.connectedAt >= ATEM_TIMING.settleMs) {
      this.#backoffMs = ATEM_TIMING.backoffMinMs;
    }
    const wait = this.#nextBackoff();
    this.#lostHost = s.host;
    // What WAS on air is not what IS on air. Names and the video mode stay,
    // so the message can say which switcher went.
    this.#program = null;
    this.#preview = null;
    this.#upstream.clear();
    this.#downstream.clear();
    this.#setError(`Lost the ${this.#model ?? 'switcher'} at ${s.host}: ${reason}. Check its power and network cable. Trying again in ${secs(wait)}.`);
    this.#setState('lost', now);
    this.#wait(now + wait);
  }

  /** Walks away from a session because the settings now point elsewhere. */
  #abandon(s: Session, now: number): void {
    void this.#endSession(s, now);
    this.#resetSwitcher();
    this.#lastHeard = null;
    this.#log(`ATEM: leaving the switcher at ${s.host}, the settings point elsewhere now`);
  }

  #resetSwitcher(): void {
    this.#model = null;
    this.#protocol = null;
    this.#topology = null;
    this.#videoMode = null;
    this.#program = null;
    this.#preview = null;
    this.#inputs.clear();
    this.#upstream.clear();
    this.#downstream.clear();
  }

  // ---- the tick ---------------------------------------------------------------

  #onTick(): void {
    if (!this.#running) return;
    const now = this.#now();
    this.#followClock(now);
    for (const [h, until] of this.#quiet) if (until <= now) this.#quiet.delete(h);
    switch (this.#phase) {
      case 'session':
        if (this.#session) this.#checkSession(this.#session, now);
        break;
      case 'probing': {
        const run = this.#run;
        if (run && run.doneAt !== null && now - run.doneAt >= ATEM_TIMING.helloWaitMs) this.#probeFailed(now);
        break;
      }
      case 'waiting':
        if (now >= this.#nextAttemptAt) this.#attempt(now);
        break;
      case 'idle':
        break;
    }
  }

  /**
   * The wall clock can go BACKWARDS under us (an NTP correction once the
   * desk finds the internet, a volunteer fixing the time zone). Everything
   * scheduled against the old clock moves back with it, or a retry planned
   * for "in 5 s" would wait out the whole jump.
   */
  #followClock(now: number): void {
    const back = this.#lastTickAt - now;
    this.#lastTickAt = now;
    if (back <= 1000) return;
    this.#nextAttemptAt -= back;
    this.#lastSweepAt -= back;
    if (this.#run && this.#run.doneAt !== null) this.#run.doneAt -= back;
    if (this.#lastHeard !== null) this.#lastHeard -= back;
    if (this.#since !== null) this.#since -= back;
    const s = this.#session;
    if (s) {
      s.startedAt -= back;
      if (s.connectedAt !== null) s.connectedAt -= back;
      if (s.stalledSince !== null) s.stalledSince -= back;
    }
    for (const [h, until] of this.#quiet) this.#quiet.set(h, until - back);
  }

  // ---- the socket -------------------------------------------------------------

  #ensureSocket(): Socket | null {
    if (this.#socket) return this.#socket;
    try {
      const sock = createSocket({ type: 'udp4' });
      sock.on('message', (msg, rinfo) => this.#guard(() => this.#onDatagram(sock, msg, rinfo)));
      sock.on('error', err => this.#guard(() => this.#onSocketError(sock, err)));
      // An ephemeral port on every interface: replies come back to whichever
      // interface the hello left by.
      sock.bind();
      this.#socket = sock;
      return sock;
    } catch (err) {
      this.#setError(`The desk could not open a network socket to look for the switcher (${errorCode(err)}).`);
      return null;
    }
  }

  #closeSocket(): Promise<void> {
    const sock = this.#socket;
    this.#socket = null;
    if (!sock) return Promise.resolve();
    return new Promise(resolve => {
      try {
        sock.close(() => resolve());
      } catch {
        // Already closed (an 'error' can close it first). Nothing left to free.
        resolve();
      }
    });
  }

  /**
   * THE send path: the only socket send in this file. It takes a
   * ClientDatagram, never bytes, and the bytes come from
   * buildClientDatagram(), which can only build a hello or an ack.
   */
  #send(d: ClientDatagram, host: string): void {
    if (!this.#running) return;
    const sock = this.#ensureSocket();
    if (!sock) return;
    const bytes = buildClientDatagram(d);
    try {
      sock.send(bytes, this.#port, host, err => {
        if (err) this.#guard(() => this.#onSendError(err, host));
      });
    } catch (err) {
      this.#onSendError(err, host);
    }
  }

  #onSendError(err: unknown, host: string): void {
    const code = errorCode(err);
    const run = this.#run;
    if (run) {
      // A sweep sends to whole subnets this computer may have no route to,
      // and those fail by the hundred. Only the target's failure is news.
      if (this.#retryHosts().includes(host) && run.targetError === null) run.targetError = code;
      return;
    }
    const s = this.#session;
    if (s && host === s.host && !s.toldSendError) {
      // Logged, not shown: if the acks really are not getting out, the
      // switcher stops talking and silence turns this into 'lost' with a
      // message, within 5 s.
      s.toldSendError = true;
      this.#log(`ATEM: ${sendErrorHint(code, host)}`);
    }
  }

  #onSocketError(sock: Socket, err: Error): void {
    if (sock !== this.#socket) return;
    this.#log(`ATEM: the network socket failed (${errorCode(err)}); opening a new one`);
    void this.#closeSocket();
    const s = this.#session;
    if (s) this.#lose(s, 'the network connection on this computer failed', this.#now());
  }

  #onDatagram(sock: Socket, msg: Buffer, rinfo: RemoteInfo): void {
    if (sock !== this.#socket || !this.#running) return;
    if (rinfo.port !== this.#port) return;
    const pkt = parsePacket(msg);
    if (!pkt) return;
    const now = this.#now();
    const s = this.#session;
    if (s) {
      // During a session, every other sender is noise, including a second
      // switcher answering a sweep late.
      if (rinfo.address === s.host) this.#onSessionPacket(s, pkt, now);
      return;
    }
    if (this.#phase === 'probing') this.#onHelloAnswer(pkt, rinfo.address, now);
  }

  // ---- reporting --------------------------------------------------------------

  #setState(state: AtemStatus['state'], now: number): void {
    if (state === this.#state) return;
    const from = this.#state;
    this.#state = state;
    this.#since = now;
    if (state !== 'connected') this.#log(`ATEM: ${from} -> ${state}`);
    this.#scheduleEmit();
  }

  #setError(error: string | null): void {
    if (error === this.#error) return;
    this.#error = error;
    if (error) this.#log(`ATEM: ${error}`);
    this.#scheduleEmit();
  }

  #scheduleEmit(): void {
    if (this.#emitTimer) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      this.#guard(() => this.#flush());
    }, ATEM_TIMING.emitDebounceMs);
    this.#emitTimer.unref();
  }

  /**
   * What counts as a change. lastHeard is left out, or every keepalive would
   * be a 'change'. The initial dump is hundreds of commands, and because the
   * status holds the switcher's half back while connecting, it arrives as
   * one 'change' when InCm says it is complete.
   */
  #keyOf(st: AtemStatus): string {
    return JSON.stringify({ ...st, lastHeard: null });
  }

  #flush(): void {
    const st = this.status;
    const key = this.#keyOf(st);
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    try {
      this.emit('change', st);
    } catch (err) {
      this.#log(`ATEM: a listener for switcher changes failed (${errorText(err)})`);
    }
  }

  #log(line: string): void {
    try { this.#opts.log?.(line); } catch { /* a broken logger must not break the watcher */ }
  }

  /** Every callback from a socket or timer runs through here: nothing may escape into the desk. */
  #guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log(`ATEM: ignored an internal error (${errorText(err)})`);
    }
  }
}

/** The name the operator knows an input by. */
export function inputName(status: AtemStatus, id: number | null): string {
  if (id === null) return 'unknown';
  const input = status.inputs.find(i => i.id === id);
  return input?.longName || input?.shortName || `input ${id}`;
}

/**
 * What is on air, in one plain sentence for the desk console: the program
 * input and any keys over it. Pure, so the wiring owner and the doors check
 * can show the same words.
 */
export function onAirSummary(status: AtemStatus): string {
  switch (status.state) {
    case 'off':
      return 'Not watching a switcher.';
    case 'searching':
      return 'Looking for the switcher on the network.';
    case 'connecting':
      return `Connecting to the switcher${status.host ? ` at ${status.host}` : ''}.`;
    case 'lost':
      return `Lost the switcher${status.host ? ` at ${status.host}` : ''}. What is on air is unknown.`;
    case 'connected': {
      const parts = [`Program: ${inputName(status, status.program)}.`];
      if (status.preview !== null) parts.push(`Preview: ${inputName(status, status.preview)}.`);
      const keys = status.keyers.filter(k => k.onAir).map(k => {
        const label = k.kind === 'downstream' ? `DSK${k.index}` : `M/E ${k.me ?? 1} key ${k.index}`;
        const how = k.type ? `${k.type} key` : 'key';
        return `${label} (${how} of ${inputName(status, k.fillSource)})`;
      });
      parts.push(keys.length ? `On air over it: ${keys.join(', ')}.` : 'No keys on air.');
      return parts.join(' ');
    }
  }
}
