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
