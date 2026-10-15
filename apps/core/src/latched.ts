/**
 * The operator's latched on-air states, brought back after a restart.
 *
 * A safety message stays up until somebody clears it; that is the whole
 * difference between it and a status card. A "back at 2:15" delay card, a
 * field-setup or doors countdown and the event's live announcement are the
 * same kind of thing: set once, then left up on purpose. They live only in the
 * state snapshot, and the bus opens a restart with an empty one, so a desk
 * that restarted while the building was being told to stay clear of the north
 * doors came back with every screen saying nothing, and nothing anywhere said
 * the message had been lost.
 *
 * So the last word on each of them is read back out of today's log and folded
 * into the snapshot with bus.restore(), which writes nothing to the log, tells
 * no subscriber and fires no cue. Re-emitting would re-run every automation
 * hanging off these events; restore only puts back what the screens show.
 *
 * Deciding what is still live is the reducer's job, not this file's. Every
 * event that can set or retire one of these four fields is fed, in order, to
 * a private scratch state, so the rules that already exist apply exactly as
 * they did live: a field timeout's automatic card retires at the next
 * prestart, a match start ends a countdown, an operator's card is never
 * overwritten by the automatic one. Whatever the scratch state still holds at
 * the end is what was on the screens when the desk went down.
 */

import type { EventBus } from './bus.ts';
import { reduce } from './state.ts';
import { initialState, type DeskEvent, type DeskEventType, type DeskState } from './types.ts';

/**
 * Every event type the reducer uses to set or retire one of the four fields.
 * Kept as a list rather than "everything" because a day's log is mostly score
 * traffic, and replaying all of it through the whole reducer would slow the
 * one boot that has somebody standing in front of it waiting.
 */
const LATCH_EVENTS: ReadonlySet<DeskEventType> = new Set<DeskEventType>([
  'emergency.raise', 'emergency.clear',
  'status.show', 'status.hide', 'break.started', 'match.prestart',
  'timer.started', 'timer.cleared', 'match.start',
  'announcement.posted',
]);

const FIELDS = ['emergency', 'status', 'timer', 'announcement'] as const;
export type LatchedField = typeof FIELDS[number];

export class LatchedRestore {
  #scratch: DeskState = initialState();
  /** The logged event that put each still-live field where it is. */
  #producer = new Map<LatchedField, DeskEvent>();
  #thisRun: number;

  /**
   * @param thisRunStartedAt  the stamp of this process's first event. Logged
   *   events at or after it are this run's own, which are already live and
   *   are fed from bus.recent in apply() instead, so they are not read twice.
   */
  constructor(thisRunStartedAt = Number.POSITIVE_INFINITY) {
    this.#thisRun = thisRunStartedAt;
  }

  /** For rebuildFromLog. Sample (demo) events never arrive: it drops them. */
  observe(ev: DeskEvent): void {
    if (typeof ev.ts === 'number' && ev.ts >= this.#thisRun) return;
    this.#feed(ev, true);
  }

  #feed(ev: DeskEvent, fromLog: boolean): void {
    if (!LATCH_EVENTS.has(ev.type) || ev.source === 'demo') return;
    const before = this.#scratch;
    this.#scratch = reduce(before, ev);
    for (const f of FIELDS) {
      if (this.#scratch[f] === before[f]) continue;
      // Only a LOGGED event is restored. One from this run already landed
      // live; it is fed so that it can retire what the log still shows.
      if (this.#scratch[f] && fromLog) this.#producer.set(f, ev);
      else this.#producer.delete(f);
    }
  }

  /**
   * Fold the last word on each field into the live snapshot. Returns what was
   * put back, for the boot log line.
   */
  apply(bus: EventBus, now = Date.now()): LatchedField[] {
    // This run's own events last: they are newer than anything in the log,
    // and a live one (a field timeout ending in a prestart during boot, say)
    // may already have retired a state the log still holds.
    for (const ev of bus.recent) this.#feed(ev, false);

    const restored: LatchedField[] = [];
    const due = [...this.#producer.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [field, ev] of due) {
      // The reducer judges a countdown against the event's own stamp, so a
      // timer that ran out while the desk was down would come back. Not here.
      if (field === 'timer' && !((this.#scratch.timer?.endsAt ?? 0) > now)) continue;
      bus.restore(ev);
      restored.push(field);
    }
    return restored;
  }
}
