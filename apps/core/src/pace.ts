/**
 * Schedule pace: how fast matches are actually cycling, and how far behind
 * the published schedule the event is running.
 *
 * TBA built "predicted match times" because published FRC schedules are
 * fiction. Events run up to hours behind and almost never ahead. The room
 * deserves the same honesty: "Q45 · est 2:40 PM" beats a printed time that
 * passed forty minutes ago. Method borrowed from TBA's: the median of recent
 * ACTUAL cycle times, with outliers (lunch, field faults) excluded, projected
 * forward from the last real match start.
 */

import type { EventBus } from './bus.ts';
import type { DeskState, UpcomingMatch } from './types.ts';

/** Cycles longer than this are breaks, not pace, so exclude from the median. */
const MAX_CYCLE_MS = 20 * 60_000;
/** Shorter than this is a replay/glitch double-fire, not a real cycle. */
const MIN_CYCLE_MS = 90_000;
const KEEP = 8;

export interface Pace {
  /** Median of recent real cycle times, seconds. Null until two starts. */
  cycleSec: number | null;
  /**
   * Wall-clock estimate for the start of the first match that has NOT started
   * yet: one median cycle after the last start. While a match is on the field
   * that is the match after it, so it belongs to on-deck row 1 when the queue
   * still lists the playing match as row 0 (see startedRows). Null until two
   * starts, because the projection needs a measured cycle.
   */
  nextStartAt: number | null;
  /**
   * Minutes behind the published schedule (negative = ahead). Null when the
   * schedule carries no times (desk-only demo, or Cheesy without a schedule).
   */
  behindMin: number | null;
  /** Wall clock of the last match start (what the projection anchors to). */
  lastStartAt: number | null;
}

/** Median of recent cycles after outlier exclusion. Pure, for tests. */
export function medianCycleMs(startTimes: number[]): number | null {
  const cycles: number[] = [];
  for (let i = 1; i < startTimes.length; i++) {
    const d = startTimes[i]! - startTimes[i - 1]!;
    if (d >= MIN_CYCLE_MS && d <= MAX_CYCLE_MS) cycles.push(d);
  }
  if (!cycles.length) return null;
  const sorted = [...cycles].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Project the next start: one median cycle after the last start, but never in
 * the past: if the field is stalled, the estimate walks forward with `now`,
 * which is exactly what a spectator wants the sign to do.
 */
export function projectNextStart(
  lastStartAt: number | null, cycleMs: number | null, now: number,
): number | null {
  if (lastStartAt === null || cycleMs === null) return null;
  return Math.max(now, lastStartAt + cycleMs);
}

/**
 * Beyond this, the "schedule" and the clock are not describing the same day,
 * and the honest answer is no figure at all. Real FRC events run at most a few
 * hours behind; the two ways to exceed twelve hours are a replayed log and a
 * schedule import with the wrong date. In a replay the events are restamped to
 * now while the schedule strings still come from the recording day, so
 * behindMin would read the replay offset: months of minutes. Both must blank
 * the sign, not put nonsense on it.
 */
const MAX_CREDIBLE_BEHIND_MIN = 12 * 60;

export function behindMinutes(
  nextStartAt: number | null, nextScheduledAt: number | null,
): number | null {
  if (nextStartAt === null || nextScheduledAt === null) return null;
  const min = Math.round((nextStartAt - nextScheduledAt) / 60_000);
  return Math.abs(min) > MAX_CREDIBLE_BEHIND_MIN ? null : min;
}

const norm = (x: string | null | undefined): string => (x ?? '').trim().toLowerCase();

/**
 * Is on-deck row 0 the match that is on the field right now?
 *
 * The two queue sources disagree about this, and a figure built on the wrong
 * answer is a whole cycle out. The field's queue (Cheesy, and the sample loop)
 * keeps a match listed until its score commits, so while it plays it IS row 0.
 * Nexus drops a match from its list the moment it is "On field" (see
 * pendingMatches), so there row 0 is already the next match to play. Asking
 * the queue's source is not enough, because Nexus can lag the field and a test
 * match was never in any queue; the one witness that is right every time is
 * the loaded match's own name.
 *
 * With no loaded match to compare against, fall back to the source's
 * convention: believe the field's queue, not Nexus's.
 */
export function headIsPlaying(
  head: Pick<UpcomingMatch, 'name' | 'shortName'> | undefined,
  match: { displayName: string } | null | undefined,
  queueFrom: DeskState['queueFrom'],
): boolean {
  if (!head) return false;
  const playing = norm(match?.displayName);
  if (!playing) return queueFrom !== 'nexus';
  return norm(head.name) === playing || (norm(head.shortName) !== '' && norm(head.shortName) === playing);
}

/**
 * How many rows at the head of the on-deck queue have already started: 1 from
 * match.start until that match's score commits (it is still listed, as row 0),
 * otherwise 0.
 *
 * `nextStartAt` projects the first match that has not started, so every
 * per-row estimate has to skip this many rows first. Counting from row 0
 * regardless put the next match's start time on the match already playing and
 * every later row one full cycle late, from match start until the score
 * committed, then snapped back. The surfaces carry a copy of this rule inline
 * (they are plain browser JS); this is the one that is tested.
 */
export function startedRows(
  s: Pick<DeskState, 'lastMatchStartedAt' | 'scorePostedAt' | 'match' | 'upcoming' | 'queueFrom'>,
): 0 | 1 {
  if (s.lastMatchStartedAt === null || s.scorePostedAt !== null) return 0;
  return headIsPlaying(s.upcoming[0], s.match, s.queueFrom) ? 1 : 0;
}

/**
 * Projected start for on-deck row `row`, or null when there is none to give:
 * the row is a match that already started, or the pace model has no signal.
 */
export function etaForRow(
  pace: Pick<Pace, 'nextStartAt' | 'cycleSec'>, started: number, row: number,
): number | null {
  if (row < started) return null;
  if (!pace.nextStartAt || !pace.cycleSec) return null;
  return pace.nextStartAt + (row - started) * pace.cycleSec * 1000;
}

/**
 * Watch match starts and the schedule; publish `pace.updated` whenever the
 * picture changes. Re-emits on a slow tick too. "est. start" keeps walking
 * forward while the field is stalled, without any new events.
 */
export function attachPace(bus: EventBus): () => void {
  const starts: number[] = [];
  let lastEmit = '';
  // From match.start until its score commits, upcoming[0] is still the match
  // on the field, and comparing the NEXT match's projection against it read
  // a full cycle behind on a field running exactly on time, snapping back at
  // every commit. So the figure is latched at each start (this match against
  // its own scheduled time) and held until the queue head moves on.
  let held: { behindMin: number; head: string } | null = null;

  const compute = (now = Date.now()): Pace => {
    const lastStartAt = starts.at(-1) ?? null;
    const cycleMs = medianCycleMs(starts);
    const nextStartAt = projectNextStart(lastStartAt, cycleMs, now);
    const sched = bus.state.upcoming[0]?.time;
    const nextScheduledAt = sched ? Date.parse(sched) : null;
    return {
      cycleSec: cycleMs === null ? null : Math.round(cycleMs / 1000),
      nextStartAt,
      behindMin: held !== null
        ? held.behindMin
        : behindMinutes(nextStartAt, Number.isFinite(nextScheduledAt) ? nextScheduledAt : null),
      lastStartAt,
    };
  };

  const emit = (): void => {
    const pace = compute();
    // Don't spam the log with identical minute-granularity updates.
    const key = `${pace.cycleSec}|${pace.behindMin}|${Math.round((pace.nextStartAt ?? 0) / 30_000)}`;
    if (key === lastEmit) return;
    lastEmit = key;
    bus.emit({ type: 'pace.updated', source: 'cue', payload: pace });
  };

  const unsubscribe = bus.subscribe(ev => {
    if (ev.type === 'match.start') {
      // Captured before the queue advances: the head IS the match starting.
      // Same credibility bound as behindMinutes: a latched figure computed
      // against a schedule from another day (replay, bad import) is nonsense.
      const head = bus.state.upcoming[0];
      const schedAt = head?.time ? Date.parse(head.time) : NaN;
      const latched = Number.isFinite(schedAt)
        ? Math.round((ev.ts - schedAt) / 60_000)
        : null;
      // Only when the head really is the match starting. A Nexus queue has
      // already dropped it (and a test match was never in any queue), so there
      // the head is the NEXT match and latching this start against its time
      // read a full cycle AHEAD for the whole match. Unlatched, compute()
      // compares the next match's projection against the next match's time,
      // which is the right pair.
      held = head && latched !== null && Math.abs(latched) <= MAX_CREDIBLE_BEHIND_MIN
        && headIsPlaying(head, bus.state.match, bus.state.queueFrom)
        ? { behindMin: latched, head: head.shortName }
        : null;
      starts.push(ev.ts);
      while (starts.length > KEEP + 1) starts.shift();
      emit();
    } else if (ev.type === 'queue.updated') {
      // The committed match has left the queue: back to projecting the next.
      if (held && bus.state.upcoming[0]?.shortName !== held.head) held = null;
      emit();
    }
  });

  const timer = setInterval(emit, 30_000);
  return () => { unsubscribe(); clearInterval(timer); };
}
