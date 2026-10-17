/**
 * The alliance as it was picked, not just the three robots on the field.
 *
 * CalGames runs Championship-division style selection: four teams are chosen
 * per alliance and no backup is called later. Only three ever play a given
 * match, so `match.red` is the three on the field and is the right answer for
 * anything about THIS match. The fourth team is still on the alliance, and
 * anything about the ALLIANCE (the selection board, the result card, the
 * awards) has to name all four or it is telling a team they were not there.
 *
 * FOUR IS NOT AUTOMATIC. Cheesy only creates a fourth slot when the event's
 * Selection Round 3 Order is set, and the shipped default is empty, in which
 * case alliances are three teams and selection will not finalize with a
 * fourth pick. The scorekeeper has to set it on /setup/settings BEFORE
 * alliance selection; it is on the pre-event checklist in docs/10 beside the
 * display id. If nobody does, everything here degrades quietly to the
 * on-field three, which is correct but is not what the event decided.
 *
 * Cheesy Arena's match record has only three team slots, so the rest of the
 * alliance comes from one of two places, best first:
 *
 *   1. `match.redOffField` / `blueOffField`, which the arena resolves itself
 *      and sends on every playoff matchLoad. This is the one that works from
 *      a cold start: a desk restarted through alliance selection has no
 *      selection data at all, and used to be unable to name the backup.
 *   2. The alliance list from selection, joined on the playoff seed.
 *
 * Names are filled from whoever we already know: the teams on the field carry
 * theirs, and the rankings poll covers the rest.
 */

import { teamLabel } from './desk-client.js';

/** @returns the full alliance in pick order, or the on-field three if unknown. */
export function allianceRoster(state, side) {
  const onField = state?.match?.[side] ?? [];
  const named = new Map((state?.rankings ?? []).map(r => [r.team, r.name]));

  // The arena's own answer, sent on every playoff matchLoad. Preferred over
  // the selection join because it needs nothing the desk has to have been
  // running to see.
  const offField = side === 'red' ? state?.match?.redOffField : state?.match?.blueOffField;
  if (offField?.length) {
    const seen = new Set(onField.map(t => t.number));
    return [
      ...onField,
      ...offField
        .filter(t => t?.number && !seen.has(t.number))
        .map(t => ({ number: t.number, name: t.name || named.get(t.number) || '' })),
    ];
  }

  const seed = side === 'red' ? state?.match?.redAlliance : state?.match?.blueAlliance;
  if (!seed) return onField;                       // qualification match

  // Zeros are cleared slots, kept positionally on the board so a correction
  // does not slide later picks left. A roster is a list of real teams.
  const picked = (state?.selection?.alliances ?? []).find(a => a.id === seed)
    ?.teams.filter(n => n > 0);
  // Selection has not run, or this alliance is still empty: the field wins.
  if (!picked?.length) return onField;

  const known = new Map(onField.map(t => [t.number, t]));
  return picked.map(number =>
    known.get(number) ?? { number, name: named.get(number) ?? '' });
}

/** True when this team is on the alliance but not on the field this match. */
export function isReserve(state, side, number) {
  return !(state?.match?.[side] ?? []).some(t => t.number === number);
}

/*
 * ---- helpers the program overlay and the talent view share ----------------
 * Pure functions of a state frame, kept here (not in the surfaces) so the
 * rules can be exercised from Node without a DOM.
 */

/**
 * Who is on the field, as one string that changes when any of them does.
 *
 * The match id alone is not an identity for the lineup. A playoff team
 * substitution re-sends matchLoad with the SAME id and different teams, and a
 * repaint keyed on the id left the overview, the scorebug and the talent cards
 * naming the swapped-out team for the whole match. The printed label rides
 * along so a label that lands after the first paint (a second robot's 100B)
 * repaints as well.
 */
export function lineupKey(state) {
  const side = list => (list ?? [])
    .map(t => `${t.number}/${teamLabel(state, t.number)}`).join(',');
  return `${state?.match?.id ?? ''}|${side(state?.match?.red)}|${side(state?.match?.blue)}`;
}

/**
 * The teams still to be called, in rank order, capped for room-scale reading.
 *
 * Taken from the UNPICKED teams, not from the top of the whole ranking. Slicing
 * the first 24 ranks and striking the taken ones is fine in round one and
 * wrong from round two, when the top 24 are all gone: every visible row was
 * struck through and the teams actually left to call (rank 25 and below) never
 * appeared under a plate headed "Still available".
 */
export function availablePool(selection, limit = 24) {
  return (selection?.ranked ?? []).filter(r => !r.picked).slice(0, limit);
}

/**
 * What the final screen says about the result.
 *
 * WHO IS AHEAD and WHETHER THAT IS A RESULT are two questions. They used to be
 * one flag ('!estimated && r > b'), so while the desk shadow-scored neither
 * alliance was ever ahead and the 'Leading' wording could never
 * appear: a clearly decided match showed two outlined totals and no words.
 *
 * The leader is worked out regardless. `won` (the gold cap) is the claim that
 * it is a RESULT, so it needs the field's total behind it; the words say which
 * kind of claim it is. The field's own verdict wins over our arithmetic when
 * the total is official, because a playoff tie is resolved on tiebreaks and a
 * disqualification never touches the score.
 *
 * @returns {{ estimated: boolean, leader: 'red'|'blue'|'tie',
 *   won: {red: boolean, blue: boolean}, verdict: {red: string, blue: string} }}
 */
export function finalVerdict(state) {
  const estimated = state?.totalConfidence === 'estimated';
  const r = state?.score?.red?.total ?? 0;
  const b = state?.score?.blue?.total ?? 0;
  const official = !estimated ? state?.officialWinner : null;
  const leader = official ?? (r > b ? 'red' : b > r ? 'blue' : 'tie');
  const words = side => {
    // No "unofficial" on air (the event asked for no such tag). What keeps a
    // guess from being called the result is that it never says Winner or Tie.
    if (leader === side) return estimated ? 'Leading' : 'Winner';
    if (leader === 'tie') return estimated ? 'Level' : 'Tie';
    return '';
  };
  return {
    estimated,
    leader,
    won: { red: !estimated && leader === 'red', blue: !estimated && leader === 'blue' },
    verdict: { red: words('red'), blue: words('blue') },
  };
}
