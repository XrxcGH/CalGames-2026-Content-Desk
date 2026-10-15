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
   * yet: one median cycle after the last start. Which on-deck row that is, is
   * the deck's business (deck.ts: the row whose offset is 0). Null until two
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
 * The PUBLISHED start of a deck row, epoch ms, or null when nobody published
 * one.
 *
 * A Nexus row's `time` is the queuers' estimate, recomputed on every poll, so
 * "behind schedule" measured against it was the desk's projection minus
 * Nexus's projection: about zero, all day, however late the event ran. Only
 * the row's `scheduled` counts there. A field row's `time` is the arena's
 * published schedule. A row the deck made up for the loaded match has none.
 */
export function scheduledAt(
  row: Pick<UpcomingMatch, 'time' | 'scheduled'> | undefined, queueFrom: DeskState['queueFrom'],
): number | null {
  if (!row) return null;
  const raw = row.scheduled ?? (queueFrom === 'nexus' ? null : row.time);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

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
  // Each start with whether it was the sample's. A sample start and the first
  // real one an hour later are not a cycle, and one minutes apart is a wrong
  // one, so the sample's are dropped the moment the field starts a real match.
  // The demo loop's are all sample and stay: they are its whole pace.
  const starts: { ts: number; sample: boolean }[] = [];
  const times = (): number[] => starts.map(x => x.ts);
  const dropSample = (): void => {
    for (let i = starts.length - 1; i >= 0; i--) if (starts[i]!.sample) starts.splice(i, 1);
  };
  let lastEmit = '';
  // While a match plays, the figure is latched at its start (this match
  // against its own published time) and held until its score commits or
  // another match loads. Comparing the NEXT match's projection mid-match is
  // right in principle but jumps around with every stall; the start is the
  // one moment the field said exactly how late it was.
  let held: { behindMin: number; match: string | null } | null = null;

  const compute = (now = Date.now()): Pace => {
    const s = bus.state;
    const lastStartAt = starts.at(-1)?.ts ?? null;
    const cycleMs = medianCycleMs(times());
    const nextStartAt = projectNextStart(lastStartAt, cycleMs, now);
    const holding = held !== null && s.lastMatchStartedAt !== null && s.scorePostedAt === null
      && (s.match?.id ?? null) === held.match;
    // The row nextStartAt belongs to, by the deck's reckoning, is offset 0.
    // When it has no published time (a replay, a practice match, a row the
    // deck made up for the loaded match), the first row after it that has one
    // stands in, at its own projected start. Never across a break: past lunch
    // the projection stops meaning anything.
    const behind = (): number | null => {
      const deck = s.deck;
      if (!deck || nextStartAt === null) return null;
      for (let i = 0; i < deck.rows.length; i++) {
        const off = deck.offs[i];
        if (off === null || off === undefined) continue;
        const at = scheduledAt(deck.rows[i], s.queueFrom);
        if (at !== null) {
          if (off > 0 && cycleMs === null) return null;
          return behindMinutes(nextStartAt + off * (cycleMs ?? 0), at);
        }
        if (deck.rows[i]!.breakAfter) return null;
      }
      return null;
    };
    return {
      cycleSec: cycleMs === null ? null : Math.round(cycleMs / 1000),
      nextStartAt,
      behindMin: holding ? held!.behindMin : behind(),
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
      // The bus reduces before subscribers run, so the deck already shows the
      // starting match as the one on the field (offset null), found by
      // identity rather than by assuming it is row 0: a Nexus queue has
      // dropped it, and latching this start against the NEXT match's time
      // read a full cycle ahead for the whole match. No row, or no published
      // time for it (a Nexus estimate is not one), and nothing is latched.
      // Same credibility bound as behindMinutes: a figure against a schedule
      // from another day (replay, bad import) is nonsense.
      const s = bus.state;
      const onField = s.deck?.rows[s.deck.offs.indexOf(null)];
      const schedAt = scheduledAt(onField, s.queueFrom);
      const latched = schedAt === null ? null : Math.round((ev.ts - schedAt) / 60_000);
      held = latched !== null && Math.abs(latched) <= MAX_CREDIBLE_BEHIND_MIN
        ? { behindMin: latched, match: s.match?.id ?? null }
        : null;
      const sample = ev.source === 'demo';
      if (!sample) dropSample();
      starts.push({ ts: ev.ts, sample });
      while (starts.length > KEEP + 1) starts.shift();
      emit();
    } else if (ev.type === 'match.unloaded') {
      // The sample data's clear. Its starts go, and the figure is published
      // again even if it has not changed, because the clear has just wiped
      // what the sample put in state.pace.
      dropSample();
      held = null;
      lastEmit = '';
      emit();
    } else if (ev.type === 'queue.updated' || ev.type === 'match.loaded'
      || ev.type === 'match.score_posted' || ev.type === 'match.ended_before_join') {
      // Any of these can move which row is next, or end the latch.
      emit();
    }
  });

  const timer = setInterval(emit, 30_000);
  return () => { unsubscribe(); clearInterval(timer); };
}
