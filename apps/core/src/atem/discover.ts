/**
 * Finding a switcher nobody told us the address of.
 *
 * The kit travels, and the volunteer setting up the desk at a new venue
 * cannot be expected to know the switcher's address, or that it changed
 * since last time. ATEM switchers do not answer a broadcast on 9910, so the
 * only reliable way to find one is to ask each plausible address in turn:
 * send the protocol's own hello, and the first switcher that answers wins.
 *
 * This file does two things and touches no socket itself:
 *
 *   discoveryCandidates() decides WHERE to ask. It is pure (interfaces come
 *   in as an argument) so the order is testable: the configured address
 *   first, then the FRC field network 10.0.100.0/24, then the /24 of every
 *   other local IPv4 address.
 *
 *   HelloProbe decides WHEN to ask: one hello every 20 ms at most (about 50
 *   per second), and it stops the moment someone answers. The watcher owns
 *   the socket and hands the probe a send callback that can only send the
 *   hello, so discovery cannot widen what the desk puts on the wire, and the
 *   answer that ends discovery is the same handshake the session continues
 *   on. That is the point of probing from the watcher's own socket: a
 *   separate probe socket would leave the switcher holding a half-open
 *   session for it, and the switcher's client slots are shared with ATEM
 *   Software Control on the AV table.
 *
 * How often a sweep may repeat (at most once a minute) is the watcher's
 * business, since only it knows whether anything was found.
 */

import { isIPv4 } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

/** The FRC field network. The kit's switcher lives at 10.0.100.40 on it. */
export const FIELD_PREFIX = '10.0.100';

/**
 * Four /24s' worth: the configured host, the field network and three more.
 * A Windows desk can carry Hyper-V, WSL and VPN adapters each with their
 * own subnet, and at 50 hellos a second the cap is what keeps one sweep
 * under about 20 seconds.
 */
export const DEFAULT_CANDIDATE_CAP = 1024;

/** 50 per second. The probe refuses to go faster whatever it is asked. */
export const PROBE_INTERVAL_MS = 20;

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** The a.b.c of an IPv4 address, or null for anything we would never sweep. */
function prefixOf(address: string): string | null {
  if (!isIPv4(address)) return null;
  const parts = address.split('.');
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  // Loopback and link-local are never where a switcher is: 169.254 is what
  // Windows hands itself when DHCP failed, and sweeping it would spend 5 s
  // asking nobody. 0.x and multicast and above are not unicast hosts at all.
  if (first === 127 || first === 0 || first >= 224) return null;
  if (first === 169 && second === 254) return null;
  return parts.slice(0, 3).join('.');
}

/**
 * Where to look, in order, de-duplicated and capped.
 *
 * The field network comes before the desk's own subnets even when the desk
 * has no address on it, because that is where this kit's switcher is
 * supposed to be; a hello to a network we have no route to just fails to
 * send, which the watcher counts quietly.
 */
export function discoveryCandidates(
  configured: string | null | undefined,
  interfaces: Interfaces,
  cap: number = DEFAULT_CANDIDATE_CAP,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (host: string): void => {
    if (out.length >= cap || seen.has(host)) return;
    seen.add(host);
    out.push(host);
  };
  // The configured host is taken as typed, loopback included: a rehearsal
  // runs the fake switcher on 127.0.0.1 and says so in the settings.
  if (configured && isIPv4(configured)) add(configured);

  const prefixes: string[] = [FIELD_PREFIX];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      // Older Node versions reported family as the number 4.
      const family = String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (info.internal) continue;
      const p = prefixOf(info.address);
      if (p && !prefixes.includes(p)) prefixes.push(p);
    }
  }
  // .0 and .255 are left out: on a /24 they are the network and broadcast
  // addresses, and Windows refuses a send to a broadcast address outright.
  for (const p of prefixes) {
    for (let i = 1; i <= 254 && out.length < cap; i++) add(`${p}.${i}`);
  }
  return out;
}

/** The distinct a.b.c.x subnets in a host list, for a message a volunteer can read. */
export function describeSubnets(hosts: readonly string[], max = 3): string {
  const nets: string[] = [];
  for (const h of hosts) {
    const p = isIPv4(h) ? h.split('.').slice(0, 3).join('.') + '.x' : null;
    if (p && !nets.includes(p)) nets.push(p);
  }
  if (nets.length <= max) return nets.join(', ');
  return `${nets.slice(0, max).join(', ')} and ${nets.length - max} more`;
}

export interface HelloProbeOptions {
  /** Sends one hello to this host. The watcher's, and the only thing a probe can do to the network. */
  send: (host: string) => void;
  /** Called once, right after the last hello of a run has gone out. */
  onSent?: () => void;
  /** Milliseconds between hellos. Floored at PROBE_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * One paced pass over a host list. "First valid answer wins": the watcher
 * validates the hello answer, then calls answer(host), which accepts it only
 * from a host this run actually asked, and stops the run.
 */
export class HelloProbe {
  #opts: HelloProbeOptions;
  #interval: number;
  #hosts: string[] = [];
  #next = 0;
  #asked = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #active = false;

  constructor(opts: HelloProbeOptions) {
    this.#opts = opts;
    this.#interval = Math.max(PROBE_INTERVAL_MS, opts.intervalMs ?? PROBE_INTERVAL_MS);
  }

  /** True from start() until an answer is accepted or stop() is called. */
  get active(): boolean { return this.#active; }
  /** How many hellos this run has sent so far. */
  get sent(): number { return this.#next; }
  /** How many hosts this run will ask in all. */
  get total(): number { return this.#hosts.length; }
  /** True once the last hello has gone out (the run then waits for answers). */
  get finishedSending(): boolean { return this.#active && this.#next >= this.#hosts.length; }

  start(hosts: readonly string[]): void {
    this.stop();
    this.#hosts = [...new Set(hosts)];
    this.#next = 0;
    this.#asked.clear();
    this.#active = true;
    this.#step();
  }

  /** Accepts an answer from a host this run asked, and ends the run. */
  answer(host: string): boolean {
    if (!this.#active || !this.#asked.has(host)) return false;
    this.stop();
    return true;
  }

  stop(): void {
    this.#active = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #step(): void {
    this.#timer = null;
    if (!this.#active) return;
    const host = this.#hosts[this.#next];
    if (host === undefined) return;
    this.#next++;
    this.#asked.add(host);
    // Neither callback may throw out of a timer: an exception there is an
    // uncaught exception in the desk's process.
    try { this.#opts.send(host); } catch { /* a failed send is a host that did not answer */ }
    // A caller may stop() the run from inside send(); honour that before
    // scheduling another hello.
    if (!this.#active) return;
    if (this.#next >= this.#hosts.length) {
      try { this.#opts.onSent?.(); } catch { /* reporting only */ }
      return;
    }
    this.#timer = setTimeout(() => this.#step(), this.#interval);
    this.#timer.unref();
  }
}
