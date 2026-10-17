/**
 * ScreenRegistry: where every open page says it is showing.
 *
 * The desk used to know only how many sockets were open. Whether the program
 * graphics were up on the computer that feeds the video switcher, whether that
 * browser was full screen, whether its screen ran at the switcher's resolution
 * and frame rate, whether it had handed over to Cheesy Arena's own overlay:
 * none of that reached the desk, so the only way to find out was to walk to
 * the AV table and look. Each page now says so itself, in a hello frame over
 * the socket it already holds (desk-client.js), and this keeps the latest one
 * per socket for the doors check, the front page and GET /api/screens.
 *
 * A hello is a page describing itself, never a command, so it needs no PIN
 * (an overlay cannot type one) and changes nothing: it is never put on the
 * bus, never echoed to another socket, and never read by show logic. Anything
 * on the venue Wi-Fi can send one, so every field is checked for type, range
 * and length, a frame that fails any check is dropped whole, and the number of
 * sockets tracked is capped. Old clients send no hello and simply stay as
 * "nothing said yet" (nulls).
 *
 * Nothing here may throw into the socket handler that calls it: a 'change'
 * listener that throws is caught and logged by name only.
 */

import { EventEmitter } from 'node:events';

export type ScreenKey = 'alpha' | 'luma' | 'fill';
export type ScreenShowing = 'desk' | 'cheesy';
/**
 * Whether a program page that can hand over to the field's own display (C7)
 * has it loaded and checked: 'ready'; has been unable to show it for a while,
 * so a desk outage would leave the switcher on a frozen picture: 'bad'; or was
 * given no field to stand in with: 'none'.
 */
export type ScreenBackup = 'none' | 'ready' | 'bad';

/** One open page, as it last described itself. Nulls until its first hello. */
export interface ScreenInfo {
  /** This socket's id, the server's own: never anything the page chose. */
  id: string;
  /** Which page: "program", "watch", "desk". From the hello once there is one. */
  surface: string;
  /** The computer it is open on, as the network sees it ("127.0.0.1" is the desk laptop). */
  addr: string;
  /** When the socket opened (ms since the epoch). */
  since: number;
  /** How it paints: see-through (alpha), on black for a keyer (luma), or on the backdrop (fill). */
  key: ScreenKey | null;
  /** True when framed inside another page (/s/watch), false when it is the whole tab. */
  embedded: boolean | null;
  /** True when full screen, F11 included. */
  full: boolean | null;
  /** The page's own size in CSS pixels. */
  w: number | null;
  h: number | null;
  /** The screen's size in CSS pixels; times dpr is the signal the computer sends. */
  sw: number | null;
  sh: number | null;
  dpr: number | null;
  /** Measured refresh rate, or null when the page was hidden. */
  hz: number | null;
  /** Whose graphics a program page is showing right now (C7). */
  showing: ScreenShowing | null;
  /**
   * On a program page that can hand over (C7), whether the field's own display
   * is ready to stand in. Null on every other page, and from a client older
   * than this field: an addition to C1, so its absence is never an error.
   */
  backup: ScreenBackup | null;
}

/** The checked fields of one hello frame. */
export type Hello = Omit<ScreenInfo, 'id' | 'addr' | 'since'> & {
  key: ScreenKey | null; embedded: boolean; full: boolean;
  w: number; h: number; sw: number; sh: number; dpr: number;
};

/**
 * How many sockets are tracked at once. Phones on the trivia page open one
 * each; a venue has a few hundred. Past this, a new socket is simply not
 * tracked, which costs the doors check nothing it needs (it reads program
 * pages, and there are a handful).
 */
export const MAX_SCREENS = 2000;

/** The largest pixel size accepted: past 16K is not a screen. */
const MAX_PX = 32_768;

const KEYS: readonly ScreenKey[] = ['alpha', 'luma', 'fill'];
const SHOWING: readonly ScreenShowing[] = ['desk', 'cheesy'];
const BACKUP: readonly ScreenBackup[] = ['none', 'ready', 'bad'];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A whole number of pixels in range, or undefined when it is not one. */
const px = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PX ? Math.round(v) : undefined;

/**
 * The fields of a hello frame, checked, or null when any one is wrong.
 *
 * Dropped whole rather than kept in part: a frame with one impossible value
 * came from something that is not the desk's own client, and half of it is
 * not worth believing. `surface` is held to id characters because it reaches
 * the doors check and the desk log; nothing here is ever printed raw.
 */
export function validateHello(frame: unknown): Hello | null {
  if (!isObj(frame) || frame['t'] !== 'hello') return null;
  const surface = frame['surface'];
  if (typeof surface !== 'string' || !/^[\w-]{1,32}$/.test(surface)) return null;
  const key = frame['key'];
  if (key !== null && !(KEYS as readonly unknown[]).includes(key)) return null;
  const embedded = frame['embedded'];
  const full = frame['full'];
  if (typeof embedded !== 'boolean' || typeof full !== 'boolean') return null;
  const w = px(frame['w']);
  const h = px(frame['h']);
  const sw = px(frame['sw']);
  const sh = px(frame['sh']);
  if (w === undefined || h === undefined || sw === undefined || sh === undefined) return null;
  const dprRaw = frame['dpr'];
  if (typeof dprRaw !== 'number' || !Number.isFinite(dprRaw) || dprRaw < 0.1 || dprRaw > 16) return null;
  const hzRaw = frame['hz'];
  let hz: number | null = null;
  if (hzRaw !== null) {
    if (typeof hzRaw !== 'number' || !Number.isFinite(hzRaw) || hzRaw < 1 || hzRaw > 1000) return null;
    hz = Math.round(hzRaw);
  }
  const showing = frame['showing'];
  if (showing !== null && !(SHOWING as readonly unknown[]).includes(showing)) return null;
  // Optional, unlike the rest: a page from before it sends none, and that
  // is "not said", never a reason to drop the frame.
  const backup = frame['backup'] ?? null;
  if (backup !== null && !(BACKUP as readonly unknown[]).includes(backup)) return null;
  return {
    surface, key: key as ScreenKey | null, embedded, full, w, h, sw, sh,
    dpr: Math.round(dprRaw * 1000) / 1000, hz, showing: showing as ScreenShowing | null,
    backup: backup as ScreenBackup | null,
  };
}

/**
 * Is this a program page, the one the switcher, projector and stream carry?
 *
 * Its variants count too: the clean second-stream feed connects as
 * "program-clean" (program.js, ?mode=clean), and a crew that puts that one on
 * the switcher has the graphics on air. Counting only "program" read "no
 * program page is open anywhere" all day while the overlay was keyed on.
 */
export const isProgramPage = (s: { surface: string }): boolean =>
  s.surface === 'program' || s.surface.startsWith('program-');

/** The address as a person reads it: IPv4 in IPv6 clothing loses the clothing. */
export const plainAddr = (addr: string): string =>
  String(addr ?? '').replace(/^::ffff:/i, '').slice(0, 64) || 'unknown';

export class ScreenRegistry extends EventEmitter<{ change: [] }> {
  #screens = new Map<string, ScreenInfo>();
  #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    super();
    this.#now = opts.now ?? Date.now;
  }

  /** A socket opened. Its surface is the handshake's tag until a hello says otherwise. */
  add(id: string, info: { surface: string; addr: string }): void {
    if (this.#screens.has(id) || this.#screens.size >= MAX_SCREENS) return;
    const surface = String(info.surface ?? '').replace(/[^\w-]/g, '').slice(0, 32) || 'anon';
    this.#screens.set(id, {
      id, surface, addr: plainAddr(info.addr), since: this.#now(),
      key: null, embedded: null, full: null, w: null, h: null, sw: null, sh: null,
      dpr: null, hz: null, showing: null, backup: null,
    });
    this.#changed();
  }

  /**
   * A hello arrived on that socket. Returns whether it was taken: false for
   * a socket that is not tracked or a frame that did not pass validateHello.
   */
  hello(id: string, frame: unknown): boolean {
    const known = this.#screens.get(id);
    if (!known) return false;
    const h = validateHello(frame);
    if (!h) return false;
    this.#screens.set(id, { ...known, ...h });
    this.#changed();
    return true;
  }

  remove(id: string): void {
    if (this.#screens.delete(id)) this.#changed();
  }

  /** Every tracked page, oldest first. Copies: a caller cannot edit the registry. */
  list(): ScreenInfo[] {
    return [...this.#screens.values()].map(s => ({ ...s }));
  }

  #changed(): void {
    try { this.emit('change'); } catch (err) {
      // The listener's own failure, by name only: a message could carry
      // anything, and this runs inside the socket handler during a show.
      console.warn(`[screens] a listener for screen changes failed (${(err as Error)?.name ?? 'error'})`);
    }
  }
}
