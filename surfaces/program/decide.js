/**
 * What the program overlay decides, kept out of program.js (DOM code) so the
 * tests can run it, the same arrangement as surfaces/replay/timeline.js.
 *
 * No imports: what these need is passed in, so the file loads the same way
 * in the browser and under node --test.
 */

/**
 * The alliance overview's two inputs, as keys.
 *
 * `cards` is what the robot cards say: the match and, side by side, each
 * team's number, printed label and name. A change there rebuilds the cards,
 * and a rebuild replays their entrance (.reveal: every robot vanishes and
 * slides back in), which is right for a new match and wrong for anything
 * else. `photos` is the photo each of those teams has, and a change there
 * alone only swaps the pictures inside the cards.
 *
 * The desk pushes a whole snapshot after every photo upload, sample seed and
 * clear, and the overlay used to rebuild the overview on each one. The
 * overview is the program from a match's load until the field arms, so on
 * Saturday morning every pit photo uploaded made all six robots blink on air.
 *
 * `label(n)` is the printed team label (100B, not 9999), and `photoOf(n)` the
 * photo's URL or null. Null when there is no match to draw.
 */
export function overviewKeys(match, label, photoOf) {
  if (!match) return null;
  const side = list => (list ?? []).map(t => [t.number, label(t.number), t.name ?? '']);
  const teams = [...(match.red ?? []), ...(match.blue ?? [])];
  return {
    cards: JSON.stringify([match.id ?? null, side(match.red), side(match.blue)]),
    photos: JSON.stringify(teams.map(t => photoOf(t.number) ?? null)),
  };
}

/**
 * What the overview needs, going from keys `was` to keys `now`: 'build' the
 * cards afresh, swap only their 'photos', or nothing at all (null).
 */
export function overviewChange(was, now) {
  if (!now) return null;
  if (!was || was.cards !== now.cards) return 'build';
  return was.photos !== now.photos ? 'photos' : null;
}

/**
 * The line under a status card that says when the field is back, or '' for
 * none.
 *
 * A time only while it is still ahead. The field's own break card is stamped
 * with the arena's scheduled length (900 s for an Awards Break), ceremonies
 * overrun, and the card stays up until the field actually comes back, so the
 * stream read "Back ~2:37 PM" at ten to three. Past it, the card still says
 * the break is on; it just stops promising a time that has gone. `now` is the
 * desk's clock, not this machine's, and `clock(ms)` formats the time.
 */
export function backLine(backAt, now, clock) {
  if (!backAt) return '';
  return now < backAt ? `Back ~${clock(backAt)}` : 'Back soon';
}
