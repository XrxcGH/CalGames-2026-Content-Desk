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

/**
 * The standby card's line, or null for no card.
 *
 * The card is for a program screen standing on its own (a projector, a TV,
 * a switcher input) that has nothing to show, and says why in words a
 * volunteer can act on. Without it that screen was an empty page until a
 * real match loaded, and a field parked on its Test Match (which the desk
 * skips) never loads one: the AV coordinator saw nothing, for good, and
 * reasonably decided the desk was broken.
 *
 * "Nothing to show" is narrow on purpose: no state yet, or the automatic
 * blank with no match loaded. A Blank an operator TOOK (screenHold) is a
 * choice, and it stays a plain backdrop with no words on it; once any match
 * has loaded, the screens have something to say and the card never returns.
 *
 *   state    the desk state, or null before the first frame
 *   screen   the screen the overlay is on (see wantedScreen in program.js)
 *   link     'connecting' before the socket first opens, then 'up' or 'down'
 *   address  where this page is reaching the desk, as a person would type it
 *
 * Returns { text, warn } so the one line that asks somebody to act can look
 * like it.
 */
export function standbyLine({ state, screen, link, address }) {
  const empty = !state || (screen === 'blank' && !state.screenHold && !state.match);
  if (!empty) return null;
  if (link === 'down') {
    return {
      text: `Cannot reach the desk at ${address}. Check that the desk computer `
        + 'is on and the Content Desk is running.',
      warn: true,
    };
  }
  if (!state) return { text: `Connecting to the desk at ${address}.`, warn: false };
  if (state.connected?.cheesy) {
    return {
      text: 'Connected to the field. Waiting for it to load a match '
        + '(its Test Match does not count).',
      warn: false,
    };
  }
  return {
    text: 'No field connection. Matches can be run from the desk console.',
    warn: false,
  };
}

/**
 * The standby card's second line in a /s/watch kiosk whose field feed has
 * shown no picture, or '' for none.
 *
 * The kiosk frames this page over the field feed. A camera that was off, on
 * another network, or typed wrong used to leave that display solid black,
 * with nothing to read, until the first real match. Now the kiosk frames
 * this page on its own backdrop instead and passes the feed's host
 * (?feeddown=), and the card says which box to go and look at.
 *
 * Only something shaped like a host and port is printed. The kiosk sends
 * nothing else (a camera's address can carry its password), and an address
 * somebody typed by hand must not put any words they like on a projector.
 */
const HOST_PORT = /^([a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(:[0-9]{1,5})?$/i;

export function feedNote(host) {
  const h = typeof host === 'string' ? host.trim() : '';
  if (!HOST_PORT.test(h)) return '';
  return `No picture from the field feed at ${h}: check that the camera is on `
    + 'and its address is right. Until then the graphics show on this backdrop.';
}

/**
 * Cheesy Arena's own audience display at the field's address, as the
 * program's stand-in (see "the field's own score" in program.js), or null
 * for anything that is not a host and port.
 *
 * Its own display id, so the field's display list shows it by name rather
 * than as a stranger, and a black background, which the luma key cuts out
 * exactly as it cut out the field's own keyed display. Only a host and port
 * is ever put in the address: the host comes from the desk, but a page must
 * not be talked into framing some other site by a malformed answer.
 */
export const FIELD_DISPLAY_ID = 'contentdesk-backup';

export function fieldDisplayUrl(host) {
  const h = typeof host === 'string' ? host.trim() : '';
  if (!HOST_PORT.test(h)) return null;
  return `http://${h}/displays/audience?displayId=${FIELD_DISPLAY_ID}&background=%23000000`;
}

/**
 * When the program stands aside for the field's display, and when it comes
 * back. In milliseconds:
 *
 *   silent  no frame at all for this long is a dead socket, though it looks
 *           open. The desk beats every 10 s, so two missed beats and margin,
 *           the same line the shared client's watchdog draws.
 *   desk    the desk unreachable (closed, or silent) for longer than this
 *           hands off. Short, because the score on the stream is frozen
 *           meanwhile, but long enough that a reconnect blip does not cut
 *           the stream twice.
 *   field   the desk reachable but its link to the field down for longer
 *           than this hands off: Cheesy has the real numbers then. Longer,
 *           because the bridge reconnects by itself and a desk that has
 *           just started takes a few seconds to reach the field.
 *   back    the desk answering, caught up, and on the field (or with no
 *           field to be on) for this long hands back. A desk that is
 *           restarting can answer once and drop again; the stream should
 *           not cut back and forth with it.
 */
export const HANDOFF_MS = Object.freeze({ silent: 25_000, desk: 3000, field: 10_000, back: 5000 });

export const HANDOFF_START = Object.freeze({
  showing: 'desk', deskBadSince: null, fieldBadSince: null, goodSince: null,
});

/**
 * One step of the handoff: given what was decided last time and what is
 * true now, what the program shows. Pure, and fed the time, so a test can
 * walk it through a whole outage in a few lines.
 *
 *   now              a monotonic clock, in ms
 *   open             the socket is open
 *   heardAt          when the desk last sent anything (same clock), or null
 *   synced           a snapshot has arrived since the socket opened
 *   fieldConfigured  the desk is on a field (it named one at /api/info)
 *   fieldUp          the desk's last state says its field link is up
 *   backupReady      the field's display is loaded and known good
 *
 * 'cheesy' only ever with backupReady: a frame that is not known good may
 * be the browser's error page, which is light, and on a luma key a white
 * box over the stream. Losing it mid-outage goes back to the desk's last
 * picture at once, for the same reason.
 */
export function handoffStep(was, { now, open, heardAt, synced, fieldConfigured, fieldUp, backupReady }) {
  const silent = !open || !Number.isFinite(heardAt) || now - heardAt > HANDOFF_MS.silent;
  const fieldDown = !silent && !!synced && !!fieldConfigured && !fieldUp;
  const healthy = !silent && !!synced && (!!fieldUp || !fieldConfigured);
  const since = (on, at) => (on ? (at ?? now) : null);
  const deskBadSince = since(silent, was?.deskBadSince ?? null);
  const fieldBadSince = since(fieldDown, was?.fieldBadSince ?? null);
  const goodSince = since(healthy, was?.goodSince ?? null);
  const wanted = (deskBadSince !== null && now - deskBadSince > HANDOFF_MS.desk)
    || (fieldBadSince !== null && now - fieldBadSince > HANDOFF_MS.field);
  let showing = was?.showing === 'cheesy' ? 'cheesy' : 'desk';
  if (!backupReady) showing = 'desk';
  else if (showing === 'desk' && wanted) showing = 'cheesy';
  else if (showing === 'cheesy' && goodSince !== null && now - goodSince >= HANDOFF_MS.back) showing = 'desk';
  return { showing, deskBadSince, fieldBadSince, goodSince };
}
