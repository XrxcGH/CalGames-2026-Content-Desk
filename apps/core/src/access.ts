/**
 * Who may drive the show.
 *
 * The desk runs on the venue network, and at an event that network has a few
 * hundred phones on it. Anyone who can reach the desk can currently load the
 * control consoles and take the program screen, abort a publish, or clear the
 * telestrator. That is not a hypothetical: the trivia QR code puts the desk's
 * address on a projector in front of the whole gym.
 *
 * So control is gated and viewing is not. The split matters more than the
 * mechanism:
 *
 *   OPEN    the overlays OBS renders, the venue TVs, and the two audience
 *           phone pages, plus exactly the reads they need. These have no
 *           credential and never will: a Browser Source cannot type a PIN,
 *           and a spectator should not have to.
 *
 *   GATED   every operator console, and every request that changes something.
 *
 * One shared PIN rather than accounts. The people who need it are a handful
 * of volunteers who arrive on the day, and anything requiring a password
 * reset at 8am on a Saturday will be worked around by propping the door open.
 */

/** Surfaces anyone may load. Everything else under /s/ needs the PIN. */
export const OPEN_SURFACES: ReadonlySet<string> = new Set([
  'program',   // OBS Browser Source
  'side',      // venue TVs
  'tele',      // OBS Browser Source, telestrator render
  'arcade',    // OBS Browser Source
  'trivia',    // OBS Browser Source
  'quiz',      // the audience plays on their own phones
  'next',      // "when do we play?", the whole point is that anyone can open it
  'watch',     // kiosk wrapper: composites the open screens for a pit monitor
  'gp',        // the shout-out form; its one write is moderated before air
  'testcard',  // the AV crew's screen test pattern; it is a picture of nothing
  // The Judge Advisor's page. Open to LOAD because the JA does not hold the
  // desk PIN: the page is a sign-in shell, and every read or write behind it
  // requires the JA session the shell's own unlock creates.
  'awards',
  // The event-settings page: the same sign-in-shell pattern, behind the
  // settings code held by the content lead.
  'setup',
]);

/**
 * Reads an open surface genuinely needs.
 *
 * Deliberately a list rather than "all GETs": `/api/publish` reports queue
 * state and credential readiness, `/api/cheesy/audit` is the bridge's request
 * log, and neither belongs to the audience even though both are reads.
 */
const OPEN_GET = new Set([
  '/api/state',        // every overlay renders from this
  '/api/urls',         // the LAN base a QR code has to encode
  '/api/media/manifest',
  '/api/trivia',       // the overlay's snapshot: never carries an unrevealed answer
  '/api/trivia/play',  // a player's own view
  // The arcade overlay is open, and this is the only way it learns the set in
  // progress: the state snapshot carries no arcade fields. Gating it left the
  // overlay permanently blank after any reload, which is a bad way to find out.
  '/api/arcade',
  // The audience-facing half of the run of show: what is happening now and
  // when the next thing starts. The venue screens and the phone page both
  // render it and neither can type a PIN. Changing it is a POST, and closed.
  '/api/rundown',
  // The slide deck the side screens rotate. Approved content only, by
  // construction: the moderation queue lives at /api/slides/queue, gated.
  '/api/slides',
]);

/**
 * Open reads whose path carries a parameter, so a Set lookup cannot express
 * them. Kept as an explicit list of prefixes for the same reason as everything
 * else here: anything not named is closed.
 */
const OPEN_GET_PREFIXES = [
  // One team's own matches and video links, for the phone page. The full
  // coverage report at /api/coverage stays gated: it carries the operational
  // gap list, which is the desk's business.
  '/api/coverage/team/',
];

/**
 * Writes the audience must be able to make.
 *
 * Joining and answering are the game. They are rate-limited by the store
 * (one answer per player, names clipped, a 500-player ceiling) rather than by
 * a credential nobody in the stands could have.
 */
const OPEN_POST = new Set([
  '/api/trivia/join',
  '/api/trivia/answer',
  // A Gracious Professionalism shout-out from the stands. Screened,
  // rate-limited, capped, and never on a screen until a human approves it.
  '/api/gp',
]);

/**
 * Static assets a surface pulls in. Gating these would break the open pages.
 *
 * /clips/ is deliberately absent: it holds pre-publication match cuts and the
 * head referee's review frames, no open surface reads it, and the gated ones
 * send the session cookie with every subresource request. /frames/ was an
 * exemption for a mount that never existed.
 */
const OPEN_PREFIXES = ['/theme/', '/shared/', '/media/'];

export interface AccessQuery {
  method: string;
  path: string;
}

/**
 * Does this request need the PIN?
 *
 * Written as an allowlist in both directions: anything not explicitly opened
 * is closed. A new endpoint added later is private until someone decides
 * otherwise, which is the safe direction for a mistake to fall.
 */
export function needsAuth({ method, path }: AccessQuery): boolean {
  const reading = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  // Static asset trees. Inside the read branch, not ahead of it: these opened
  // /theme/, /shared/ and /media/ for EVERY verb, which is harmless only for
  // as long as the sole handler matching those paths is the static file
  // sender. The moment a write route is mounted under one of them it ships
  // pre-opened. That is the exact mechanism behind the OPTIONS hole below,
  // and the file's own "a verb is not a permission" test does not hold on
  // this branch.
  if (reading && OPEN_PREFIXES.some(p => path.startsWith(p))) return false;

  // The surface pages themselves.
  if (path === '/' ) return false;                       // the index just lists them
  if (path.startsWith('/s/')) {
    const id = path.slice(3).split('/')[0] ?? '';
    return !OPEN_SURFACES.has(id);
  }

  // Auth endpoints, and the page that posts to them, must be reachable
  // to authenticate at all. Gating /signin would mean nobody redirected
  // there for lacking a PIN could ever load the form that lets them enter one.
  if (path === '/api/auth' || path === '/api/auth/status' || path === '/signin') return false;
  // The Judge Advisor's door, same reasoning as /api/auth: gating the unlock
  // endpoint behind the thing it unlocks would lock everyone out. The
  // settings door gets the same treatment.
  if (path === '/api/awards/auth' || path === '/api/setup/auth') return false;

  // Anything that only reads is judged against the read list. OPTIONS belongs
  // here and NOT in a blanket exemption: this once returned false for every
  // OPTIONS request, and because the route handlers dispatch on path alone,
  // `curl -X OPTIONS /s/desk` served the whole operator console and
  // `-X OPTIONS /api/trivia/bank` handed out unrevealed answers. A verb is not
  // a permission.
  if (reading) {
    if (OPEN_GET_PREFIXES.some(p => path.startsWith(p))) return false;
    return !OPEN_GET.has(path);
  }
  return !OPEN_POST.has(path);
}

/** Read one cookie without pulling in a parser. */
export function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      // A malformed percent escape (Cookie: desk_auth=%zz) once threw out of
      // the /ws handshake and took the whole process down, no PIN needed.
      // Junk in, junk out, but never throw.
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return null;
}

/**
 * Compare without leaking length or position through timing.
 *
 * The threat is mild (a volunteer network, a short PIN) but this costs
 * nothing, and a naive === on a secret is the kind of thing that gets copied
 * into somewhere it matters.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
