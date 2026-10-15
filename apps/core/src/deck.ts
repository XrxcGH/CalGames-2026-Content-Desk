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
import { startedRows } from './pace.ts';
import type { DeskState, UpcomingMatch } from './types.ts';

export interface Deck {
  rows: UpcomingMatch[];
  /**
   * Per row: whole cycles after pace.nextStartAt that it should start, or null
   * for the match on the field right now. The row with 0 is the next to start
   * (the gold cap); rows before the loaded match, already played, are gone.
   */
  offs: (number | null)[];
}

export type DeckInput = Pick<DeskState,
  'match' | 'matchRun' | 'lastMatchStartedAt' | 'matchEndedAt' | 'scorePostedAt'
  | 'upcoming' | 'queueFrom' | 'queueRecent' | 'fieldPlayed'>;

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
const from = (rows: UpcomingMatch[], playing: boolean): Deck => ({
  rows,
  offs: rows.map((_, i) => (playing ? (i === 0 ? null : i - 1) : i)),
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
      if (committed) return from(unplayed(seq.slice(j + 1)), false);
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
  }

  // The old rule: count the rows already out, 0 or 1, by name. Over a list
  // with the field's played matches taken out, which can only help it.
  const out = startedRows({ ...s, upcoming });
  return { rows: upcoming, offs: upcoming.map((_, i) => (i < out ? null : i - out)) };
}

/** Same inputs, same deck: the reducer keeps the old object instead of rebuilding. */
export const sameDeckInputs = (a: DeckInput, b: DeckInput): boolean =>
  a.match === b.match && a.matchRun === b.matchRun
  && a.lastMatchStartedAt === b.lastMatchStartedAt && a.matchEndedAt === b.matchEndedAt
  && a.scorePostedAt === b.scorePostedAt && a.upcoming === b.upcoming
  && a.queueFrom === b.queueFrom && a.queueRecent === b.queueRecent
  && a.fieldPlayed === b.fieldPlayed;
