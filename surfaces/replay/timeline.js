/**
 * Match clock and wall time, for the replay console.
 *
 * Plain functions of the desk state, kept out of replay.js so the server's
 * test suite can drive them: replay.js is DOM code and cannot be imported
 * there, and this mapping is exactly where a replay gets cut in the wrong
 * place without anybody noticing until it is on air.
 *
 * Two axes, because the field pauses between auto and teleop for as long as
 * it likes (three seconds by default, more when the scorekeeper is slow). The
 * desk re-anchors its clock at teleop so the teleop clock reads the field's
 * own numbers, which makes every teleop clock a different distance from the
 * true start than every auto clock. Auto clocks (below zero) count from the
 * true start; teleop clocks from the re-anchored one. Mapping a teleop clock
 * from the true start, which is all the console had once the buzzer cleared
 * matchStartedAt, put every teleop moment early by the length of the pause:
 * a climb framed six seconds before and four after came out nine before and
 * one after, with the result of the climb cut off.
 */

/** The wall time of clock T0 on each axis, or null with no match to map. */
function axes(state) {
  const auto = state?.lastMatchStartedAt ?? state?.matchStartedAt ?? null;
  const teleop = state?.teleopAnchorAt ?? state?.matchStartedAt ?? auto;
  return auto === null || teleop === null ? null : { auto, teleop };
}

/**
 * Wall ms for a match clock, or null when nothing has started.
 * @param {object} state  the desk state
 * @param {number} clock  signed match clock seconds
 * @param {number} t0     the clock at match start (REBUILT.AUTO_START, -20)
 */
export function wallAt(state, clock, t0) {
  const a = axes(state);
  if (!a) return null;
  return (clock < 0 ? a.auto : a.teleop) + (clock - t0) * 1000;
}

/**
 * The match clock for a wall time: the inverse of wallAt. A moment inside
 * the auto-to-teleop pause has no clock of its own and reads as 0, the
 * boundary both sides of the pause share.
 */
export function clockAt(state, wallMs, t0) {
  const a = axes(state);
  if (!a || !Number.isFinite(wallMs)) return null;
  const onAuto = (wallMs - a.auto) / 1000 + t0;
  if (onAuto < 0) return onAuto;
  const onTeleop = (wallMs - a.teleop) / 1000 + t0;
  return onTeleop >= 0 ? onTeleop : 0;
}

/**
 * The in and out clocks that frame a marker: enough lead-in to see the
 * build-up, enough tail to see the result.
 *
 * Framed from the marker's own wall time, which the desk stamps exactly, and
 * not from its match clock. The clock is only right on the axis it was
 * stamped on, and a marker stamped in the pause (End of auto) has no clock
 * that names its moment at all. A window that straddles the pause runs a
 * little longer; it never loses the moment.
 */
export function markerWindow(state, marker, t0, lead = 6, tail = 4) {
  const fromTs = typeof marker?.ts === 'number' ? clockAt(state, marker.ts, t0) : null;
  const c = fromTs ?? marker?.matchClock;
  if (c === null || c === undefined || !Number.isFinite(c)) return null;
  return [c - lead, c + tail];
}
