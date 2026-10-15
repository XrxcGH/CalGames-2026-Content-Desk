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
import type { DeskEvent } from './types.ts';
import { projectDeck, scheduledAt } from './deck.ts';

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

// The queue rules live with the deck, which is what they serve. Re-exported
// here because pace's tests and older callers import them from pace.
export { headIsPlaying, scheduledAt, startedRows } from './deck.ts';

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
/** Stops the pace model; `observe` feeds it the day's logged starts after a restart. */
export type PaceHandle = (() => void) & { observe(ev: DeskEvent): void };

export function attachPace(bus: EventBus): PaceHandle {
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
  // A real start with nothing after it yet (no end, no score, no new load).
  // The one way the field takes such a start back is the adapter's unload:
  // a desk restarted during the FTA's test match hears the test's clock
  // before it hears that a test match is what is loaded.
  let openStart = false;
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
    // The first upcoming row with a published time, at its own projected
    // start, by the same projection every screen prints (deck.ts): the next
    // to start when it has a published time, the first after it that does
    // when it does not (a replay, a practice match, a row the deck made up for
    // the loaded match). Across a break the projection already waits for the
    // published restart, so lunch reads as lunch and not as running early.
    const behind = (): number | null => {
      const deck = s.deck;
      if (!deck || nextStartAt === null) return null;
      const etas = projectDeck(deck, {
        nextStartAt, cycleSec: cycleMs === null ? null : cycleMs / 1000, lastStartAt,
      }, s.queueFrom);
      for (let i = 0; i < deck.rows.length; i++) {
        if (deck.offs[i] === null) continue;
        const at = scheduledAt(deck.rows[i], s.queueFrom);
        if (at !== null) return behindMinutes(etas[i] ?? null, at);
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
      if (!sample) { dropSample(); openStart = true; }
      starts.push({ ts: ev.ts, sample });
      while (starts.length > KEEP + 1) starts.shift();
      emit();
    } else if (ev.type === 'match.unloaded') {
      // The sample data's clear, or the field taking back a start that was a
      // test match's (see openStart). Those starts go, and the figure is
      // published again even if it has not changed, because the clear has
      // just wiped what the sample put in state.pace.
      dropSample();
      if (ev.source !== 'demo' && openStart) {
        for (let i = starts.length - 1; i >= 0; i--) {
          if (!starts[i]!.sample) { starts.splice(i, 1); break; }
        }
      }
      openStart = false;
      held = null;
      lastEmit = '';
      emit();
    } else if (ev.type === 'queue.updated' || ev.type === 'match.loaded'
      || ev.type === 'match.score_posted' || ev.type === 'match.ended_before_join'
      || ev.type === 'schedule.played' || ev.type === 'match.end' || ev.type === 'match.aborted') {
      // Any of these can move which row is next, or end the latch.
      if (ev.type !== 'queue.updated' && ev.type !== 'schedule.played') openStart = false;
      emit();
    }
  });

  const timer = setInterval(emit, 30_000);

  /*
   * After a restart, today's starts come back from the event log.
   *
   * The starts lived only in memory, so a desk restarted at 2pm had no cycle
   * time and printed no estimates anywhere until two more matches had
   * started: a quarter of an hour of blank "when do we play" rows, right
   * after whatever went wrong enough to need a restart. Fed by rebuildFromLog
   * (only today's events, sample events never), and published once at the
   * end of the burst rather than per event.
   */
  let refresh: NodeJS.Timeout | null = null;
  const observe = (ev: DeskEvent): void => {
    if (ev.type !== 'match.start' || ev.source === 'demo' || !Number.isFinite(ev.ts)) return;
    starts.push({ ts: ev.ts, sample: false });
    starts.sort((a, b) => a.ts - b.ts);
    while (starts.length > KEEP + 1) starts.shift();
    if (!refresh) {
      refresh = setTimeout(() => { refresh = null; lastEmit = ''; emit(); }, 0);
      refresh.unref?.();
    }
  };

  const stop = (): void => {
    unsubscribe();
    clearInterval(timer);
    if (refresh) clearTimeout(refresh);
  };
  return Object.assign(stop, { observe });
}
