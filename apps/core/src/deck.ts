/**
 * The on-deck list every screen shows, and where each row sits in time.
 *
 * Worked out once, here, from desk state, and published as `state.deck`. The
 * side screens, the When do we play page and the talent view used to each
 * carry their own copy of "which rows have already started", and the copies
 * were all wrong in the same place:
 *
 * The pace model's `nextStartAt` projects the first match that has NOT
 * started. Every row's estimate is that, plus one median cycle per row after
 * it, so everything hangs on WHICH row that first unstarted match is. With
 * the field's own queue it is easy: Cheesy keeps a match listed until its
 * score commits, so the loaded match is row 0. With a Nexus queue it is not:
 * Nexus drops a match from its pending list the moment a queuer marks it "On
 * field", which queuers do while it is being set up, or even while the match
 * before it is still playing. Row 0 was then the match AFTER the one about to
 * start, every estimate on every screen read a full cycle early, the gold
 * next-up cap sat on the wrong row, and the phone page told the teams walking
 * onto the field "You have time".
 *
 * The fix is to stop counting rows and find the loaded match itself. The
 * Nexus adapter now also sends the last few rows it dropped (`queueRecent`),
 * so the loaded match can be found whether the queuers are ahead of the
 * field, level with it, or behind it. From the loaded match on, in queue
 * order, the view is exact: it is on the field (started), or it is the first
 * match to start (not started), and every row after it is one cycle later.
 *
 * Nexus cannot say whether an "On field" row was PLAYED or is merely on the
 * field, so the field's own word is used for that: every match the arena has
 * a result for (`fieldPlayed`). Those never come back as upcoming, whatever
 * order the field played them in, and a loaded match the field has a result
 * for counts as done even when the desk missed its start (a restart).
 *
 * When the loaded match cannot be identified (no match, a name outside the
 * grammar in match-key.ts, two rows claiming it, teams that disagree), the
 * view falls back to the old row-counting rule. Never worse than before;
 * right wherever the identity is certain.
 */

import { fieldMatchKey, matchKey, sameMatch, shortFor, type MatchKey } from './match-key.ts';
import type { DeskState, UpcomingMatch } from './types.ts';

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


export interface Deck {
  rows: UpcomingMatch[];
  /**
   * Per row: whole cycles after pace.nextStartAt that it should start, or null
   * for the match on the field right now. The row with 0 is the next to start
   * (the gold cap); rows before the loaded match, already played, are gone.
   */
  offs: (number | null)[];
  /**
   * The match just before the first row ends in a break (Nexus's "break
   * after" on a row the deck has dropped), so the first row starts after it.
   */
  breakBefore?: boolean;
}

export type DeckInput = Pick<DeskState,
  'match' | 'matchRun' | 'lastMatchStartedAt' | 'matchEndedAt' | 'scorePostedAt'
  | 'upcoming' | 'queueFrom' | 'queueRecent' | 'fieldPlayed' | 'pace'>;

const rowKey = (m: UpcomingMatch): MatchKey | null => matchKey(m.name) ?? matchKey(m.shortName);

/**
 * A cheap second witness, for names that agree across two sources that could
 * in principle number differently (playoffs above all). Only when both sides
 * know at least three teams: early playoff rows often have none yet.
 */
function teamsAgree(row: UpcomingMatch, match: NonNullable<DeskState['match']>): boolean {
  const queued = [...(row.red ?? []), ...(row.blue ?? [])];
  const field = [...numbers(match.red), ...numbers(match.blue)];
  if (queued.length < 3 || field.length < 3) return true;
  return queued.filter(n => field.includes(n)).length >= 3;
}

/** Team numbers off a field alliance, tolerating a payload that has none. */
const numbers = (list: readonly { number: number }[] | undefined): number[] =>
  (Array.isArray(list) ? list : []).map(t => Number(t?.number)).filter(n => Number.isInteger(n) && n > 0);

/** The loaded match as a row, for when the queue does not list it. */
function loadedRow(match: NonNullable<DeskState['match']>, key: MatchKey): UpcomingMatch {
  return {
    name: match.displayName,
    shortName: shortFor(key),
    time: null,
    red: numbers(match.red),
    blue: numbers(match.blue),
    ...(match.redAlliance ? { redAlliance: match.redAlliance } : {}),
    ...(match.blueAlliance ? { blueAlliance: match.blueAlliance } : {}),
  };
}

/** From the loaded match's row: on the field, or the first to start. */
const from = (rows: UpcomingMatch[], playing: boolean, breakBefore = false): Deck => ({
  rows,
  offs: rows.map((_, i) => (playing ? (i === 0 ? null : i - 1) : i)),
  ...(breakBefore ? { breakBefore } : {}),
});

export function buildDeck(s: DeckInput): Deck {
  const nexus = s.queueFrom === 'nexus';
  // What the field has a result for. Replays are left out on both sides: the
  // arena keeps one record per match, so its result says nothing about
  // whether a replay of it has been run.
  const done = new Set((s.fieldPlayed ?? []).map(matchKey)
    .filter((k): k is MatchKey => !!k && !k.replay).map(k => `${k.kind}:${k.number}`));
  const played = (k: MatchKey | null): boolean => !!k && !k.replay && done.has(`${k.kind}:${k.number}`);
  const unplayed = (rows: UpcomingMatch[]): UpcomingMatch[] => rows.filter(r => !played(rowKey(r)));

  const upcoming = unplayed(s.upcoming ?? []);
  let loaded = s.match ? fieldMatchKey(s.match, s.matchRun ?? 1) : null;
  // Started, or over before the desk was listening (a restart after the
  // buzzer: the field said so, see the Cheesy adapter).
  const started = s.lastMatchStartedAt !== null || s.matchEndedAt !== null;
  const committed = s.scorePostedAt !== null || played(loaded);

  if (s.match && loaded) {
    // Nexus's dropped rows go in front, in Nexus's own order: the match on the
    // field, and one a queuer has marked On field before it started, are
    // among them. The field's queue has no such rows; it still lists both.
    const seq = nexus ? [...(s.queueRecent ?? []), ...(s.upcoming ?? [])] : upcoming;
    const keys = seq.map(rowKey);
    // The field re-running an ABORTED match: no result existed, so the arena
    // does not call it a replay and loads it as run 1, while the queuers list
    // a Replay row for it. That row is the run in progress.
    const l = loaded;
    if (!l.replay && keys.some(k => !!k && k.replay && k.kind === l.kind && k.number === l.number)) {
      loaded = { ...l, replay: true };
    }
    const at = keys.flatMap((k, i) => (sameMatch(k, loaded) ? [i] : []));

    if (at.length === 1 && teamsAgree(seq[at[0]!]!, s.match)) {
      const j = at[0]!;
      // Rows before it are played (or skipped), and so is any row after it
      // the field has a result for: a match skipped and run later leaves
      // the ones played in between behind it in Nexus's order.
      if (committed) return from(unplayed(seq.slice(j + 1)), false, !!seq[j]!.breakAfter);
      return from([seq[j]!, ...unplayed(seq.slice(j + 1))], started);
    }

    // The field's queue only lists Scheduled qualification and playoff
    // matches, so a replay in place (no longer Scheduled) and a practice match
    // are on the field without a row. They are still the match on the field,
    // or the next to start, so they get a row of their own at the top.
    // Not for Nexus: there an unlisted match is more likely a naming gap than
    // a missing row, and guessing would shift everything a cycle.
    if (at.length === 0 && !nexus && !committed) {
      return from([loadedRow(s.match, loaded), ...upcoming], started);
    }

    // A replay the field has loaded before the queuers have added its Replay
    // row to Nexus. It is still the next to start, or playing, and ahead of
    // everything Nexus has pending; a match Nexus has marked On field that the
    // field has no result for comes after it. Only with the field's word on
    // what is played, without which those marked rows cannot be sorted.
    if (at.length === 0 && nexus && loaded.replay && !committed && done.size > 0) {
      const marked = (s.queueRecent ?? []).filter(r => {
        const k = rowKey(r);
        return !!k && !k.replay && !played(k);
      });
      return from([loadedRow(s.match, loaded), ...marked, ...upcoming], started);
    }
  }

  // The old rule: count the rows already out, 0 or 1, by name. Over a list
  // with the field's played matches taken out, which can only help it.
  const out = startedRows({ ...s, upcoming });
  return {
    rows: upcoming,
    offs: upcoming.map((_, i) => (i < out ? null : i - out)),
    ...(nexus && out === 0 && s.queueRecent?.at(-1)?.breakAfter ? { breakBefore: true } : {}),
  };
}

/**
 * Longer than this between two published starts is a break (lunch, the night
 * between days), not a cycle. The field's own queue cuts its list at the same
 * gap.
 */
const BREAK_MS = 20 * 60_000;

/**
 * Each row's estimated start, or null for the match on the field and when the
 * pace model has no signal yet.
 *
 * The first row to start is at pace.nextStartAt and every row after it one
 * median cycle after the one before, EXCEPT that a match after a break never
 * starts before its published time. A field does not come back from lunch
 * early because the morning ran fast, and before this the estimate simply
 * walked forward with the clock all through the break: the first match after
 * lunch read "~12:10" at 12:10, "~12:20" at 12:20, while it was printed for
 * 12:45 and everyone was eating. The same held overnight for a desk left
 * running from Friday's practice.
 *
 * A break is seen three ways: a published gap longer than any cycle between
 * this row and the one before it; the queuers' "break after" on the row
 * before (Nexus); or, for the first row when nothing published comes before
 * it, a gap that long after the last actual start. With no published time,
 * Nexus's own estimate for the row is the floor: it is the one that knows
 * about the break.
 */
export function projectDeck(
  deck: Deck,
  pace: { nextStartAt: number | null; cycleSec: number | null; lastStartAt: number | null },
  queueFrom: DeskState['queueFrom'],
): (number | null)[] {
  const cycle = pace.cycleSec ? pace.cycleSec * 1000 : null;
  const next = pace.nextStartAt;
  if (next === null || cycle === null) return deck.rows.map(() => null);
  const out: (number | null)[] = [];
  let prevEta: number | null = null;
  let prevSched: number | null = null;
  let prevBreakAfter = !!deck.breakBefore;
  deck.rows.forEach((row, i) => {
    const sched = scheduledAt(row, queueFrom);
    if (deck.offs[i] === null) {
      out.push(null);
      prevSched = sched;
      prevBreakAfter = !!row.breakAfter;
      return;
    }
    let eta = prevEta === null ? next : prevEta + cycle;
    const gapFrom = prevSched ?? (prevEta === null ? pace.lastStartAt : null);
    const afterBreak = prevBreakAfter
      || (sched !== null && gapFrom !== null && sched - gapFrom > BREAK_MS);
    if (afterBreak) {
      const floor = sched ?? (queueFrom === 'nexus' && row.time ? Date.parse(row.time) : NaN);
      if (Number.isFinite(floor)) eta = Math.max(eta, floor);
    }
    out.push(eta);
    prevEta = eta;
    prevSched = sched;
    prevBreakAfter = !!row.breakAfter;
  });
  return out;
}

/** Same inputs, same deck: the reducer keeps the old object instead of rebuilding. */
export const sameDeckInputs = (a: DeckInput, b: DeckInput): boolean =>
  a.pace?.nextStartAt === b.pace?.nextStartAt && a.pace?.cycleSec === b.pace?.cycleSec
  && a.pace?.lastStartAt === b.pace?.lastStartAt
  && a.match === b.match && a.matchRun === b.matchRun
  && a.lastMatchStartedAt === b.lastMatchStartedAt && a.matchEndedAt === b.matchEndedAt
  && a.scorePostedAt === b.scorePostedAt && a.upcoming === b.upcoming
  && a.queueFrom === b.queueFrom && a.queueRecent === b.queueRecent
  && a.fieldPlayed === b.fieldPlayed;
