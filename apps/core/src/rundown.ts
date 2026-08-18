/**
 * The run of show: the day as a list, and an honest clock on the next thing.
 *
 * A three-person crew has no producer holding the rundown in their head, and
 * the desk manager is also cutting cameras. What actually happens without this
 * is that the day is a printed sheet on the table, it goes wrong by 10:30, and
 * from then on nobody can answer the two questions everybody asks all day:
 * what happens next, and when.
 *
 * So the day is a list, and the clock on it is DERIVED rather than printed.
 * That distinction is the whole point:
 *
 *   - A printed schedule says lunch is at 12:00. By 11am the event is
 *     seventeen minutes behind, everyone can see the printed time is a lie,
 *     and they stop believing every other time on the sheet too.
 *   - This projects each segment off the pace model's measured cycle time and
 *     the matches actually remaining, so "lunch at 12:17" is a number the room
 *     can act on. It is allowed to be wrong; it is not allowed to be a fiction
 *     nobody has updated.
 *
 * Nothing here drives the field or the graphics on its own. It is the desk
 * manager's list and the audience's countdown, and every segment is advanced
 * by a human, because a rundown that advances itself will advance during the
 * one delay nobody predicted.
 */

import type { EventBus } from './bus.ts';
import type { DeskEvent, PaceInfo } from './types.ts';

export type SegmentKind =
  /** Matches. Its length comes from the cycle time, not from a guess. */
  | 'matches'
  /** Ceremonies, lunch, alliance selection: a fixed-length block. */
  | 'break'
  | 'ceremony'
  | 'selection'
  | 'awards'
  /** Anything the desk fills: arcade, trivia, interviews. */
  | 'gap';

export interface SegmentPlan {
  id: string;
  label: string;
  kind: SegmentKind;
  /** Planned minutes. For a `matches` segment this is ignored when a match
   *  count is given, since measured cycle time beats a plan. */
  minutes?: number;
  /** For `matches`: how many are in this block. */
  matches?: number;
  /** Shown on the audience-facing countdown, e.g. "Doors reopen". */
  audience?: string;
}

export type SegmentState = 'pending' | 'live' | 'done';

export interface SegmentRow extends SegmentPlan {
  state: SegmentState;
  startedAt: number | null;
  endedAt: number | null;
  /** Projected start, from measured pace. Null when it cannot be projected. */
  projectedAt: number | null;
  /** Minutes this is expected to take, after measurement. */
  projectedMinutes: number;
}

export interface RundownSnapshot {
  segments: SegmentRow[];
  live: SegmentRow | null;
  next: SegmentRow | null;
  /**
   * Audience countdown: when the next thing starts, and what to call it.
   * Null unless a break-ish segment is live, because a countdown during
   * matches is just a distraction.
   */
  countdown: { label: string; at: number } | null;
  updatedAt: number;
}

/** Fallback cycle when nothing has been measured yet. */
const ASSUMED_CYCLE_SEC = 7 * 60;

const MIN = 60_000;

export class Rundown {
  #bus: EventBus;
  #plan: SegmentPlan[];
  #state = new Map<string, { state: SegmentState; startedAt: number | null; endedAt: number | null }>();

  constructor(bus: EventBus, plan: SegmentPlan[] = []) {
    this.#bus = bus;
    this.#plan = plan.filter(s => s?.id && s?.label);
    for (const s of this.#plan) {
      this.#state.set(s.id, { state: 'pending', startedAt: null, endedAt: null });
    }
  }

  attach(): () => void {
    return this.#bus.subscribe(ev => this.observe(ev));
  }

  observe(ev: DeskEvent): void {
    // Counting real matches is what lets a matches block shrink as it is
    // played, rather than projecting the same finish time all morning.
    // Recorded WITH ITS TIME, not as a running total: a block that starts at
    // noon must not inherit the morning's count, and a bare counter cannot
    // tell the difference.
    if (ev.type === 'match.score_posted') {
      this.#playedAt.push(ev.ts);
      this.#publish();
      return;
    }

    // Which segment is live, and which are done, is the day's actual
    // progress. It lived only in memory, so a restart put every segment back
    // to pending: the audience countdown pointed at the wrong thing and the
    // desk manager had to walk the whole morning forward by hand to get the
    // projections honest again. Restoring it from the published snapshot is
    // idempotent, so the copy that comes back around on the live desk
    // changes nothing.
    if (ev.type === 'rundown.updated') {
      const rows = (ev.payload as { segments?: unknown }).segments;
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const r = row as { id?: unknown; state?: unknown; startedAt?: unknown; endedAt?: unknown };
        const st = this.#state.get(String(r.id));
        if (!st) continue;                       // a plan that changed since
        if (r.state !== 'pending' && r.state !== 'live' && r.state !== 'done') continue;
        st.state = r.state;
        st.startedAt = typeof r.startedAt === 'number' ? r.startedAt : null;
        st.endedAt = typeof r.endedAt === 'number' ? r.endedAt : null;
      }
    }
  }

  #publish(): void {
    this.#bus.emit({ type: 'rundown.updated', source: 'manual', payload: this.snapshot });
  }

  /**
   * How long a segment should be expected to take, in minutes.
   *
   * A matches block is measured, not planned: the pace model knows the real
   * cycle time, and the difference between a printed 7 minutes and a measured
   * 9 is an hour by the end of the day.
   */
  #minutesFor(s: SegmentPlan, pace: PaceInfo): number {
    if (s.kind === 'matches' && s.matches) {
      const cycle = pace.cycleSec && pace.cycleSec > 0 ? pace.cycleSec : ASSUMED_CYCLE_SEC;
      return Math.round((s.matches * cycle) / 60);
    }
    return Math.max(0, Math.round(s.minutes ?? 0));
  }

  /** Matches still to play inside a live matches block. */
  #remaining(s: SegmentPlan, row: { startedAt: number | null }): number {
    if (s.kind !== 'matches' || !s.matches) return 0;
    // Counted from when the block started, so a block that begins mid-day
    // does not inherit the morning's total.
    const playedInBlock = row.startedAt === null ? 0 : this.#matchesPlayedSince(row.startedAt);
    return Math.max(0, s.matches - playedInBlock);
  }

  /**
   * When each match finished. An ARRAY, not a map keyed by the timestamp:
   * two matches posted in the same millisecond are two matches, and a map
   * silently collapsed them into one, so a block stopped shrinking as it was
   * played. Found by a test that posted five in a tight loop.
   */
  #playedAt: number[] = [];
  #matchesPlayedSince(since: number): number {
    // Strictly after. A match posted at the same instant the block was started
    // belongs to the block that just ended, not the one beginning: the desk
    // manager taps "next block" right after a score lands, and counting that
    // match twice made the new block think it was already 20 matches down.
    return this.#playedAt.filter(at => at > since).length;
  }

  get snapshot(): RundownSnapshot {
    const pace = this.#bus.state.pace;
    const now = Date.now();

    // Projection walks forward from the live segment (or from now), so every
    // later segment inherits the delay rather than each one being optimistic
    // on its own.
    let cursor = now;
    const segments: SegmentRow[] = this.#plan.map(plan => {
      const st = this.#state.get(plan.id)!;
      const projectedMinutes = this.#minutesFor(plan, pace);

      let projectedAt: number | null = null;
      if (st.state === 'done') {
        projectedAt = st.startedAt;
      } else if (st.state === 'live') {
        projectedAt = st.startedAt;
        const remaining = plan.kind === 'matches' && plan.matches
          ? this.#remaining(plan, st)
          : null;
        const leftMin = remaining !== null
          ? Math.round((remaining * (pace.cycleSec && pace.cycleSec > 0 ? pace.cycleSec : ASSUMED_CYCLE_SEC)) / 60)
          // A fixed block that is already running: whatever is left of it.
          : Math.max(0, projectedMinutes - Math.round(((now - (st.startedAt ?? now)) / MIN)));
        cursor = now + leftMin * MIN;
      } else {
        projectedAt = cursor;
        cursor += projectedMinutes * MIN;
      }

      return {
        ...plan,
        state: st.state,
        startedAt: st.startedAt,
        endedAt: st.endedAt,
        projectedAt,
        projectedMinutes,
      };
    });

    const live = segments.find(s => s.state === 'live') ?? null;
    // The next thing is what comes AFTER the live segment, not the first
    // pending row in the plan. Those differ constantly in practice: a desk
    // manager jumps straight to lunch when the field falls behind, leaving
    // earlier rows pending forever, and scanning from the top would point the
    // audience countdown at a segment that already happened or never will.
    const liveIndex = live ? segments.findIndex(s => s.id === live.id) : -1;
    const next = segments.slice(liveIndex + 1).find(s => s.state === 'pending') ?? null;

    // A countdown belongs to anything that is not a match. During matches the
    // room already has a clock and a second one competing with it is noise;
    // everywhere else the audience is waiting and wants to know for how long.
    //
    // 'selection' and 'awards' were missing, which meant no countdown during
    // alliance selection and the awards ceremony — the two longest
    // audience-facing waits of the weekend, and the two people ask about.
    const countdownKinds: SegmentKind[] = ['break', 'ceremony', 'gap', 'selection', 'awards'];
    const countdown = live && countdownKinds.includes(live.kind) && next?.projectedAt
      ? { label: live.audience ?? `${next.label} at`, at: next.projectedAt }
      : null;

    return { segments, live, next, countdown, updatedAt: Date.now() };
  }

  /**
   * Start a segment. Ends whatever was live, because two live segments is a
   * state the day cannot actually be in and pretending otherwise makes every
   * projection after it wrong.
   */
  start(id: string): RundownSnapshot {
    const st = this.#state.get(id);
    if (!st) throw new Error(`There is no segment "${id}" in the rundown.`);
    const now = Date.now();
    for (const [otherId, other] of this.#state) {
      if (otherId !== id && other.state === 'live') {
        other.state = 'done';
        other.endedAt = now;
      }
    }
    st.state = 'live';
    st.startedAt = now;
    st.endedAt = null;
    this.#publish();
    return this.snapshot;
  }

  /** Finish the live segment and start the next pending one. */
  advance(): RundownSnapshot {
    const order = this.#plan.map(s => s.id);
    const liveIndex = order.findIndex(id => this.#state.get(id)?.state === 'live');
    if (liveIndex >= 0) {
      const st = this.#state.get(order[liveIndex]!)!;
      st.state = 'done';
      st.endedAt = Date.now();
    }
    const nextId = order.slice(liveIndex + 1).find(id => this.#state.get(id)?.state === 'pending');
    if (!nextId) { this.#publish(); return this.snapshot; }
    return this.start(nextId);
  }

  /** Put a segment back to pending, for the inevitable mis-tap. */
  reset(id: string): RundownSnapshot {
    const st = this.#state.get(id);
    if (!st) throw new Error(`There is no segment "${id}" in the rundown.`);
    st.state = 'pending';
    st.startedAt = null;
    st.endedAt = null;
    this.#publish();
    return this.snapshot;
  }

}
