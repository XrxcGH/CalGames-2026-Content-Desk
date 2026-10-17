/**
 * Shared surface client. Every browser surface imports this and nothing else.
 *
 * Two ideas worth knowing:
 *
 * 1. The clock is derived LOCALLY every frame from `state.matchStartedAt`,
 *    not pushed. The countdown stays smooth through a network hiccup and we
 *    don't spend bandwidth on a number the client can compute.
 *
 * 2. Reconnect is aggressive and silent. A surface is a Browser Source in OBS
 *    that nobody is looking at until it is on air, so it must heal itself
 *    without anyone noticing, and never show an error state on the broadcast.
 */

/*
 * Every face and weight fonts.css declares, asked for as the page loads.
 * The faces are font-display: block (a fallback face would overflow the
 * condensed layouts), so text stays INVISIBLE until its file arrives, and a
 * browser only fetches a weight the first time something uses it. The
 * explainer's bold word appeared after the page had settled and showed as a
 * blank gap in the middle of its sentence until Saira Condensed 700 loaded.
 * Asking for all of them up front means a weight is already there when a
 * screen first needs it.
 */
if (typeof document !== 'undefined' && document.fonts?.load) {
  for (const face of ['600 1em "Saira Condensed"', '700 1em "Saira Condensed"',
    '700 1em Chivo', '900 1em Chivo', '800 1em Archivo', '400 1em "JetBrains Mono"',
    '600 1em "JetBrains Mono"']) {
    document.fonts.load(face).catch(() => { /* the face stays blocked, as before */ });
  }
}

export const REBUILT = {
  AUTO_START: -20, TELEOP_START: 0, TRANSITION_END: 10,
  SHIFT_SECONDS: 25, SHIFT_COUNT: 4, ENDGAME_START: 110, MATCH_END: 140,
  RP_ENERGIZED_FUEL: 100, RP_SUPERCHARGED_FUEL: 360, RP_TRAVERSAL_TOWER: 50,
};

export const PHASE_LABEL = {
  pre: 'Pre-match', auto: 'Auto', transition: 'Transition',
  shift1: 'Shift 1', shift2: 'Shift 2', shift3: 'Shift 3', shift4: 'Shift 4',
  // 'End game', two words. The one spelling, everywhere. Core clock.ts and
  // the replay console's timeline both use it, and the desk, remote, and
  // talent consoles render THIS map, so a drift here shows two spellings of
  // the same phase on adjacent screens at the desk.
  endgame: 'End game', post: 'Final',
};

export function phaseAt(c) {
  if (c === null || c < REBUILT.AUTO_START) return 'pre';
  if (c < REBUILT.TELEOP_START) return 'auto';
  if (c < REBUILT.TRANSITION_END) return 'transition';
  if (c < REBUILT.ENDGAME_START) {
    const n = Math.floor((c - REBUILT.TRANSITION_END) / REBUILT.SHIFT_SECONDS) + 1;
    return `shift${Math.min(n, REBUILT.SHIFT_COUNT)}`;
  }
  if (c < REBUILT.MATCH_END) return 'endgame';
  return 'post';
}

/**
 * Odd shifts belong to the AUTO LOSER, even shifts to the winner (verified
 * against Cheesy Arena's Hub.isShiftActive). Winning auto buys the LATER
 * shifts. Mirrors apps/core/src/clock.ts; keep the two in step.
 */
export function hubActiveAt(c, autoWinner, authoritative) {
  // The field knows. Prefer it over anything we can infer.
  if (authoritative) return authoritative;
  const phase = phaseAt(c);
  if (phase === 'pre' || phase === 'post') return 'none';
  if (phase === 'auto' || phase === 'transition' || phase === 'endgame') return 'both';
  if (!autoWinner) return 'both';
  const shift = Number(phase.slice(-1));
  const loser = autoWinner === 'red' ? 'blue' : 'red';
  return shift % 2 === 1 ? loser : autoWinner;
}

export function clockDisplay(c) {
  if (c === null) return '0:20';
  const remaining = c < REBUILT.TELEOP_START ? -c : REBUILT.MATCH_END - c;
  const s = Math.max(0, Math.ceil(remaining));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A null clock is ambiguous: pre-match before the first start, but OVER after
 * the buzzer (match.end stops the clock by clearing matchStartedAt). These
 * disambiguate with state.matchEndedAt so a finished match reads "Final 0:00",
 * never "Pre-match 0:20". match.loaded clears matchEndedAt for the next one.
 */
export function phaseFor(state, c) {
  if (c !== null) return phaseAt(c);
  return state?.matchEndedAt ? 'post' : 'pre';
}
export function clockDisplayFor(state, c) {
  if (c !== null) return clockDisplay(c);
  return state?.matchEndedAt ? '0:00' : '0:20';
}

/**
 * A clock for durations: performance.now() where there is one. Date.now()
 * jumps when a venue laptop's clock is corrected, and the program's handoff
 * (see program.js) times a silence in seconds, which a jump would fake.
 */
export function monotonic() {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** How long the screen's own report (helloFrame) waits for things to settle. */
const HELLO_DEBOUNCE_MS = 1000;
/** How long the refresh rate is watched for: about two seconds of frames. */
const HZ_SAMPLE_MS = 2000;
const SHOWING = ['desk', 'cheesy'];
const BACKUP = ['none', 'ready', 'bad'];
const MAX_PX = 32_768;

/**
 * Frames counted over a span, as a refresh rate, or null when there is not
 * enough to say. Rounded: a 59.94 Hz video output reads 60, which is what
 * a volunteer would call it.
 */
export function hzOf(frames, spanMs) {
  if (!(frames >= 1) || !(spanMs > 0)) return null;
  const hz = Math.round((frames * 1000) / spanMs);
  return hz >= 1 && hz <= 500 ? hz : null;
}

/**
 * The hello frame: what this screen tells the desk about itself, so the desk
 * can say what each display is doing without anybody walking over to it
 * (a projector at 30 Hz, a switcher input that is not full screen, the
 * program showing the field's own score). The desk keeps it against this
 * one socket and nowhere else; it is never on the bus.
 *
 *   key       what the page paints behind itself (see KEY_MODES), or null
 *             for a page that does not use one (a console)
 *   embedded  framed inside another page (/s/watch)
 *   full      the page fills the screen: the Fullscreen API, or a window
 *             the size of the screen, which is what F11 leaves (it sets no
 *             fullscreenElement)
 *   w, h      the window, in CSS pixels; sw, sh the screen; dpr the ratio
 *   hz        the refresh rate measured from animation frames, or null
 *             while the page is hidden or not yet measured
 *   showing   'desk' or 'cheesy' on a program that can hand off to the
 *             field's own display (see program.js), null everywhere else
 *   backup    on that same program, whether the field's display is ready
 *             to stand in: 'ready', 'bad' (the desk named a field and this
 *             computer cannot show its display) or 'none' (no field named);
 *             null everywhere else. An addition to the agreed fields: a
 *             desk that does not know it drops it and keeps the rest
 *
 * Pure, so a test can ask it about any window. Nothing here can carry a
 * code: it reads the window and nothing else.
 */
export function helloFrame(win = globalThis, { surface = '', showing = null, hz = null, backup = null } = {}) {
  const doc = win.document;
  const int = (v, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
  };
  // The same ceilings the desk checks a frame against (screens.ts), which
  // drops a frame whole if any one value is out of range.
  const w = int(win.innerWidth, MAX_PX);
  const h = int(win.innerHeight, MAX_PX);
  const sw = int(win.screen?.width, MAX_PX);
  const sh = int(win.screen?.height, MAX_PX);
  const ratio = Number(win.devicePixelRatio);
  const dpr = Number.isFinite(ratio) && ratio > 0 ? Math.round(Math.min(ratio, 16) * 100) / 100 : 1;
  let full = false;
  try {
    full = !!doc?.fullscreenElement
      || !!win.matchMedia?.('(display-mode: fullscreen)')?.matches
      || (sw > 0 && sh > 0 && Math.abs(w - sw) <= 2 && Math.abs(h - sh) <= 2);
  } catch { /* a browser that will not say is reported as not full screen */ }
  const key = doc?.documentElement?.dataset?.key;
  return {
    t: 'hello',
    surface: String(surface ?? '').slice(0, 32),
    key: KEY_MODES.includes(key) ? key : null,
    embedded: framedPage(win),
    full, w, h, sw, sh, dpr,
    hz: Number.isInteger(hz) && hz > 0 ? hz : null,
    showing: SHOWING.includes(showing) ? showing : null,
    backup: BACKUP.includes(backup) ? backup : null,
  };
}

class DeskClient extends EventTarget {
  state = null;
  media = {};
  connected = false;
  /** Set from the server snapshot; surfaces only prompt when it's true. */
  needsPin = false;
  authed = false;
  #pin = null;
  /** Server clock minus ours. Small, but it makes the countdown honest. */
  #skew = 0;
  /** True once a heartbeat has given the real server clock. See #apply. */
  #skewFromBeat = false;
  /** Last frame time, for the half-open watchdog. */
  #lastSeen = 0;
  /** The same, on the monotonic clock, for the program's handoff. */
  #heardAt = null;
  /** A snapshot has arrived over the socket that is open now. */
  #synced = false;
  #watchdog = null;
  #ws = null;
  #backoff = 250;
  #name;
  /** What the hello frame reports; see helloFrame. */
  #showing = null;
  #backup = null;
  #hz = null;
  #hzFrame = 0;
  #helloTimer = null;

  constructor(name) {
    super();
    this.#name = name;
    this.#connect();
    this.#watchScreen();
    // One REST read for the first frame. The websocket snapshot is the source
    // of truth, but it loses a race the venue actually runs: a headless
    // capture screenshots, and a cold pit monitor paints, before the socket
    // finishes its handshake. The guard keeps the order honest: if the
    // socket won, the fetch result is stale and goes nowhere.
    fetch('/api/state').then(r => (r.ok ? r.json() : null))
      .then(state => { if (state && !this.state) this.#apply(state); })
      .catch(() => { /* the socket is the real path; this was a head start */ });
  }

  #connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?surface=${this.#name}`);
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.#backoff = 250;
      // Counted from the open, not from the last socket's last frame: a
      // fresh socket is not a silent one. The snapshot is still owed.
      this.#heardAt = monotonic();
      this.#synced = false;
      // First, before anybody reacts to the link: the desk learns what this
      // screen is the moment it can. Nothing waits for an answer, because an
      // older desk ignores a frame type it does not know.
      this.#sendHello();
      this.dispatchEvent(new CustomEvent('link', { detail: true }));
    };

    ws.onmessage = e => {
      this.#lastSeen = Date.now();
      this.#heardAt = monotonic();
      const msg = JSON.parse(e.data);
      if (msg.t === 'snapshot') {
        this.media = msg.media ?? {};
        this.needsPin = !!msg.needsPin;
        // Re-authenticate automatically after a reconnect. A remote that
        // silently stops working mid-show because the socket blipped is worse
        // than one that never worked.
        if (this.needsPin && this.#pin) this.authenticate(this.#pin);
        this.#synced = true;
        this.#apply(msg.state);
        this.dispatchEvent(new CustomEvent('ready'));
        // A snapshot follows every reconnect, which is how a desk restart
        // (a new session) reaches this page. See signInIfSignedOut.
        void this.checkSignIn();
      } else if (msg.t === 'auth') {
        this.authed = !!msg.ok;
        if (!msg.ok) this.#pin = null;
        this.dispatchEvent(new CustomEvent('auth', { detail: !!msg.ok }));
      } else if (msg.t === 'denied') {
        this.authed = false;
        this.dispatchEvent(new CustomEvent('denied', { detail: msg.reason }));
      } else if (msg.t === 'event') {
        this.#apply(msg.state);
        this.dispatchEvent(new CustomEvent('desk', { detail: msg.ev }));
        this.dispatchEvent(new CustomEvent(msg.ev.type, { detail: msg.ev }));
      } else if (msg.t === 'relay') {
        this.dispatchEvent(new CustomEvent(`relay:${msg.channel}`, { detail: msg.data }));
      } else if (msg.t === 'hb' && typeof msg.now === 'number') {
        // The heartbeat carries the server's clock, so the skew stays fresh
        // between events. See #apply: the only other source is the last
        // EVENT's timestamp, which on a quiet desk is minutes old. A socket
        // that reconnected mid-match then computed a match clock that
        // was wrong by exactly that age, showed it on air, and snapped
        // forward at the next phase boundary.
        this.#skew = msg.now - Date.now();
        this.#skewFromBeat = true;
      }
    };

    ws.onclose = () => this.#dropped(ws);
    ws.onerror = () => ws.close();

    /*
     * The liveness watchdog. Reconnection used to hang entirely on onclose,
     * and a half-open path fires no close: the AP roam or unplugged switch
     * port the server's heartbeat comment names kills the TCP path without a
     * FIN ever reaching this browser, the socket stays OPEN, and because
     * surfaces never send anything, nothing ever surfaces the death. The
     * surface then renders a frozen score forever while `connected` stays
     * true and every console's write guard happily "sends" into the void.
     *
     * The server beats every 10 seconds, so silence past 25 (two missed
     * beats and margin) means the pipe is gone. #dropped() is called
     * directly rather than waiting for close(), because a browser can take
     * a very long time to abort an unanswered closing handshake.
     */
    this.#lastSeen = Date.now();
    if (!this.#watchdog) {
      this.#watchdog = setInterval(() => {
        const sock = this.#ws;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.#lastSeen > 25_000) {
          sock.onclose = null;
          try { sock.close(); } catch { /* already dying */ }
          this.#dropped(sock);
        }
      }, 5_000);
    }
  }

  /** One path for a dead socket, whether the browser noticed or we did. */
  #dropped(ws) {
    if (this.#ws !== ws) return;         // an old socket's late close event
    this.#ws = null;
    this.connected = false;
    this.#synced = false;
    // The skew is NOT reset here. The last beat-derived answer, even a
    // reconnect-old one, beats re-deriving from `updatedAt`, which on a
    // quiet desk is minutes stale and put a visibly wrong countdown on the
    // venue screens for the 10 seconds until the next heartbeat. A genuinely
    // different desk process corrects at its first beat.
    this.dispatchEvent(new CustomEvent('link', { detail: false }));
    setTimeout(() => this.#connect(), this.#backoff);
    this.#backoff = Math.min(this.#backoff * 2, 5000);
  }

  #apply(state) {
    // A floor, not a correction, and only for a surface that has NEVER heard
    // a heartbeat. `updatedAt` is the last EVENT's timestamp: fine at the
    // instant an event lands, minutes stale on a quiet desk. Re-deriving
    // from it after every reconnect overwrote a beat-correct skew with a
    // stale one and put a wrong countdown on the venue screens until the
    // next beat; a kept skew is at worst seconds old.
    if (state.updatedAt && !this.#skewFromBeat) this.#skew = state.updatedAt - Date.now();
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }

  /**
   * The server's clock, as near as this surface can know it. For anything
   * that counts down to a server-stamped instant (the event timer): venue
   * machines are not NTP-disciplined, and a countdown that is four seconds
   * out against the desk teaches the room not to trust the screen.
   */
  get serverNow() { return Date.now() + this.#skew; }

  /** Live match clock, computed here rather than pushed. */
  get matchClock() {
    const started = this.state?.matchStartedAt;
    if (!started) return this.state?.matchClock ?? null;
    return (Date.now() + this.#skew - started) / 1000 + REBUILT.AUTO_START;
  }

  /**
   * When the desk last said anything on this socket (any frame, the 10 s
   * heartbeat included), on the monotonic clock, or null before the first
   * socket opens. The program's handoff reads a silence from it directly
   * rather than waiting on the watchdog, which only acts every 5 s.
   */
  get heardAt() { return this.#heardAt; }

  /** A snapshot has arrived since the socket now open opened. */
  get synced() { return this.#synced; }

  /**
   * What a program that can hand off to the field's own display is showing
   * ('desk' or 'cheesy'), for the hello frame. Null on every other page.
   */
  setShowing(showing) {
    const next = SHOWING.includes(showing) ? showing : null;
    if (next === this.#showing) return;
    this.#showing = next;
    // With no socket open the next open reports it, at once.
    if (this.#ws?.readyState === WebSocket.OPEN) this.#helloSoon();
  }

  /**
   * On that same program, whether the field's display is ready to stand in
   * ('ready', 'bad', 'none'), for the hello frame. Null on every other page.
   */
  setBackup(backup) {
    const next = BACKUP.includes(backup) ? backup : null;
    if (next === this.#backup) return;
    this.#backup = next;
    if (this.#ws?.readyState === WebSocket.OPEN) this.#helloSoon();
  }

  /**
   * Tell the desk what this screen is (see helloFrame). Best effort, and
   * never allowed to break the page: a report that fails to go is simply
   * not there, and the show carries on.
   */
  #sendHello() {
    try {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(helloFrame(globalThis, {
        surface: this.#name, showing: this.#showing, hz: this.#hz, backup: this.#backup,
      })));
    } catch { /* see above */ }
  }

  /** Again, once things have stopped changing for a second. */
  #helloSoon() {
    try {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = setTimeout(() => { this.#helloTimer = null; this.#sendHello(); }, HELLO_DEBOUNCE_MS);
    } catch { /* no timers: the next open still reports */ }
  }

  /**
   * Re-report whenever what the hello frame says can have changed: the
   * window resized (or moved to another display, which can change the
   * refresh rate too), went full screen or back, or was hidden or shown.
   */
  #watchScreen() {
    try {
      globalThis.addEventListener?.('resize', () => { this.#measureHz(); this.#helloSoon(); });
      const doc = globalThis.document;
      doc?.addEventListener?.('fullscreenchange', () => this.#helloSoon());
      doc?.addEventListener?.('visibilitychange', () => { this.#measureHz(); this.#helloSoon(); });
      this.#measureHz();
    } catch { /* a browser without these reports less; nothing else changes */ }
  }

  /**
   * The refresh rate, from about two seconds of animation frames. Only while
   * the page is visible: a hidden page gets no frames, so it reports null
   * rather than a number from some other moment. Once, not continuously, so
   * a screen that is only standing by is not kept busy measuring itself.
   */
  #measureHz() {
    try { if (this.#hzFrame) cancelAnimationFrame(this.#hzFrame); } catch { /* none to cancel */ }
    this.#hzFrame = 0;
    if (globalThis.document?.hidden || typeof requestAnimationFrame !== 'function') {
      this.#hz = null;
      return;
    }
    const stamps = [];
    const step = t => {
      this.#hzFrame = 0;
      if (globalThis.document?.hidden) { this.#hz = null; return; }
      stamps.push(t);
      const span = t - stamps[0];
      if (span < HZ_SAMPLE_MS) { this.#hzFrame = requestAnimationFrame(step); return; }
      this.#hz = hzOf(stamps.length - 1, span);
      this.#helloSoon();
    };
    this.#hzFrame = requestAnimationFrame(step);
  }

  /**
   * Send this console to sign in if its session is gone. See signInIfSignedOut
   * below; a page holding a typed PIN (the phone remote) re-authenticates its
   * socket by itself instead.
   */
  async checkSignIn() {
    if (!this.needsPin || this.#pin) return;
    if (!(await signInIfSignedOut())) return;
    // The navigation is under way; pages that latch a "signed out" state
    // (the desk) paint it in the moment before the sign-in page arrives.
    this.authed = false;
    this.dispatchEvent(new CustomEvent('denied', { detail: 'PIN required' }));
  }

  /** Send the shared PIN. Kept in memory only, never written to storage. */
  authenticate(pin) {
    this.#pin = pin;
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: 'auth', pin }));
    }
  }

  emit(init) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: 'emit', init }));
    }
  }

  /**
   * Ephemeral broadcast that bypasses the event bus and the log. For data
   * that arrives at pointer rate and is worthless a second later, like
   * telestrator strokes or scrub positions. Never use it for anything the archive needs.
   */
  relay(channel, data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: 'relay', channel, data }));
    }
  }

  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); return this; }

  /** Robot cutout for a team, or null so callers hit the fallback plinth. */
  mediaFor(team) { return this.media[team] ?? null; }
}

/** Latched once a sign-in redirect is under way, so it happens once per page. */
let signingOut = false;

/**
 * Send a signed-out console to sign in, instead of leaving it green.
 *
 * A desk restart rotates the session, and the socket's read path is open by
 * design, so a console reconnected, showed "linked", and then failed every
 * gated read in silence: the announcer's card flags froze on the ledger from
 * before, and the desk's panels went stale behind a green dot. Pages that
 * signed in with the cookie hold no PIN to re-send.
 *
 * The server is asked about THIS page rather than told which pages are gated,
 * so the answer cannot drift from access.ts: it redirects a signed-out request
 * for a gated page to /signin and never redirects an open one. An overlay, a
 * venue TV or a phone page can never be sent to a sign-in form by this, which
 * on air would be the worst possible outcome.
 *
 * Called on every snapshot (one follows each reconnect, which is how a desk
 * restart reaches a page) and by pages whose gated read answered 401, which is
 * how a console notices without waiting for a reconnect.
 */
export async function signInIfSignedOut() {
  if (signingOut || !location.pathname.startsWith('/s/')) return false;
  const here = location.pathname + location.search;
  let landed;
  try {
    // Followed, so the answer is WHERE the server sent us, not merely that it
    // sent us somewhere: only a redirect to the sign-in page counts.
    const res = await fetch(here, { method: 'HEAD', cache: 'no-store' });
    landed = res.redirected ? new URL(res.url).pathname : null;
  } catch { return false; /* the desk is unreachable: the link dot already says so */ }
  if (landed !== '/signin' || signingOut) return false;
  signingOut = true;
  location.replace(`/signin?next=${encodeURIComponent(here)}`);
  return true;
}

/**
 * What a screen paints behind itself, set on <html data-key>:
 *
 *   alpha  nothing. For a layer something else puts a picture under: an OBS
 *          Browser Source over a camera, or /s/watch over its field feed.
 *   luma   black, for a hardware keyer that cuts the black out (a luma key
 *          on a Blackmagic or Roland switcher).
 *   fill   the CalGames backdrop, for a screen that IS the picture: a
 *          browser full screen on a projector or a TV, or an HDMI input on a
 *          video switcher that is cut to rather than keyed.
 *
 * Fill exists because the venues stopped using OBS. A transparent page in a
 * plain browser is a WHITE page (the browser paints its own default behind
 * it), and the program overlay sits on its empty screen until a real match
 * loads, so an AV coordinator testing the desk against a field parked on its
 * Test Match saw pure white, for good, and the volunteers gave up.
 *
 * No chroma (green) mode, on purpose. The brand palette carries WRRF green
 * (#006549) and FIRST blue, so a green or a blue key eats pieces of the
 * graphic, and every switcher that can chroma key can also luma key, which
 * the graphics are already built and tested for.
 */
export const KEY_MODES = ['alpha', 'luma', 'fill'];

/**
 * Which of those a screen uses, decided in this order:
 *
 *   1. ?key= in the address, whenever it names a mode. An address somebody
 *      typed on purpose beats any guess.
 *   2. A screen that has no "alone" look (the side screen, trivia, the
 *      telestrator pad) keeps its markup default, exactly as before.
 *   3. Inside OBS, the markup default: alpha for the program overlay, so a
 *      Browser Source pointed at /s/program keeps working as it always has.
 *   4. Framed inside another page (/s/watch frames the program over its
 *      field feed), the markup default too, so the feed still shows through.
 *   5. Otherwise this is a browser on its own, on a projector, a TV or an
 *      HDMI input, and the screen gets its alone look.
 *
 * An unknown ?key= is ignored rather than written through: it used to land
 * on <html> as is, match no style, and leave the page transparent, which in
 * a plain browser is the white page again.
 *
 * Pure, so the tests can ask it every case without a browser.
 */
export function displayModeFor({ asked = null, markup = null, alone = null, inObs = false, embedded = false } = {}) {
  const named = String(asked ?? '').trim().toLowerCase();
  if (KEY_MODES.includes(named)) return named;
  const fallback = markup || 'alpha';
  if (!alone || inObs || embedded) return fallback;
  return alone;
}

/**
 * Running inside OBS. The same two tells the house audio player uses
 * (surfaces/house/index.html, which explains them): the injected `obsstudio`
 * object, which only reaches the top frame of a Browser Source, and
 * `OBS/<version>` in the user agent, which reaches every frame.
 */
export function insideObs(win = globalThis) {
  const hasObsObject = typeof win.obsstudio === 'object' && win.obsstudio !== null;
  return hasObsObject || /\bOBS\/[\d.]+/.test(win.navigator?.userAgent ?? '');
}

/**
 * Framed inside another page. Comparing `top` with `self` is allowed even
 * across origins; if a browser ever refuses, the answer is "framed", which
 * keeps the old transparent behaviour. Outside a browser there is no `top`
 * at all, and nothing frames a page that is not in one.
 */
export function framedPage(win = globalThis) {
  try {
    return win.top != null && win.top !== win.self;
  } catch {
    return true;
  }
}

/**
 * Sets <html data-key> (see displayModeFor) and returns the address's
 * query, so one URL configures a screen for OBS, a hardware keyer or a
 * projector. `alone` is the mode a screen wants when it is the whole
 * picture; a screen that passes nothing keeps its markup default (the side
 * screen ships luma) unless the URL says otherwise.
 */
export function applyDisplayMode({ alone = null } = {}) {
  const p = new URLSearchParams(location.search);
  const root = document.documentElement;
  root.dataset.key = displayModeFor({
    asked: p.get('key'), markup: root.dataset.key, alone,
    inObs: insideObs(globalThis), embedded: framedPage(globalThis),
  });
  if (p.get('surface')) root.dataset.surface = p.get('surface');
  // ?safe=1: a TV that overscans (crops the picture's edges). The score bar
  // then keeps its text above the 3.5% action-safe line instead of centering
  // it; the stream and an LED wall show the whole frame and need nothing.
  if (p.get('safe') === '1') root.dataset.safe = 'action';
  return p;
}

/**
 * Number Roll. Counts to the new value with tabular figures so nothing
 * reflows: at 140px the changing digit shapes are visible across a gym even
 * when the exact value isn't.
 *
 * Jumps straight to the value while hidden: requestAnimationFrame does not
 * fire in a backgrounded page, so an animated roll started while hidden would
 * strand the element on a stale number. Nobody is watching a hidden source, so
 * the animation is worthless there, but the correct value is not.
 */
/**
 * Camera-scene display names, shared by every console that shows a cut
 * button. This lived as two hand-kept copies (desk and remote) and they had
 * already drifted ("Field wide" vs "Field"). One table, one vocabulary.
 */
/**
 * Program screens: canonical order and display names, shared by the nav
 * strip, the desk's screen row, and the phone remote. Three surfaces used to
 * keep three hand-typed sets ("Overview" / "Pre-match", "Match" / "Score
 * bar", "Score" / "Final"), which taught three names for one screen. The
 * names follow what the audience sees, not the internal id.
 */
export const SCREENS = [
  { id: 'overview', label: 'Pre-match' },
  { id: 'match', label: 'Match' },
  { id: 'score', label: 'Final' },
  { id: 'selection', label: 'Selection' },
  { id: 'explain', label: 'Explainer' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'cardcall', label: 'Card call' },
  { id: 'arcade', label: 'Arcade' },
  { id: 'sponsor', label: 'Sponsor' },
  { id: 'blank', label: 'Blank' },
  { id: 'auto', label: 'Auto' },
];
export const SCREEN_LABEL = Object.fromEntries(SCREENS.map(s => [s.id, s.label]));

/**
 * What to PRINT for a team number. Almost always the number itself; for a
 * second robot, its label: CalGames registers The Wildhats' B robot as 9999,
 * and nobody in the stands knows 9999, they know 100B. The number stays the
 * identity for every lookup; this is for display only.
 */
export function teamLabel(state, n) {
  return state?.teams?.[n]?.label ?? String(n);
}

/** A team's pit code, if the event published one. */
export function teamPit(state, n) {
  return state?.teams?.[n]?.pit ?? null;
}

/**
 * Turn what somebody typed into a team number: "100B" or "100b" finds 9999.
 * A plain number comes straight back. Null when it matches nothing usable.
 */
export function teamFromInput(state, text) {
  const t = String(text ?? '').trim().toUpperCase();
  if (!t) return null;
  for (const [n, e] of Object.entries(state?.teams ?? {})) {
    if (e?.label && e.label.toUpperCase() === t) return Number(n);
  }
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// Screens that exist at runtime but earn no button (a slide or an award is
// taken from its own panel, never cold from a screen row).
SCREEN_LABEL['slide'] = 'Slide';
SCREEN_LABEL['award'] = 'Award';

export const SCENE_LABEL = {
  intro: 'Intro', match: 'Field wide', score: 'Score',
  replay: 'Replay', desk: 'Desk', arcade: 'Arcade',
};

export function roll(el, to, ms = 600) {
  const from = Number(el.dataset.v ?? 0);
  if (from === to) return;
  el.dataset.v = String(to);

  // Reduced motion gets the final value instantly too. The roll is JS-driven,
  // so the reduced-motion CSS block in tokens.css cannot reach it, and docs/08
  // promises every transition collapses to a state change.
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = String(to);
    return;
  }

  const t0 = performance.now();
  const step = now => {
    // Clamped at BOTH ends. The top clamp is obvious; the bottom one is not,
    // and its absence put wrong numbers on the score bar. `t0` comes from
    // performance.now() but `now` is the rAF frame timestamp, and the first
    // frame can be stamped fractionally EARLIER than the call that scheduled
    // it. That makes p negative, and the ease `1 - (1 - p) ** 3` explodes
    // downward for negative p: at p = -1 it is -7, so the element renders
    // seven times the distance below the value in the wrong direction. Caught
    // as a "-18 FUEL" on a screen bar whose state was +119 the whole time.
    const p = Math.max(0, Math.min(1, (now - t0) / ms));
    el.textContent = String(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Per-frame paint loop with a backstop.
 *
 * OBS throttles (and with "shutdown source when not visible" effectively
 * pauses) Browser Sources that aren't on a live scene, and rAF stops firing
 * entirely in a hidden page. A clock driven by rAF alone freezes at whatever
 * it read when the source went off-scene, then snaps forward when it returns.
 * On a scoreboard that is very visible.
 *
 * So: rAF while visible, a 250ms interval as the backstop (browsers clamp
 * background timers to ~1s, which is fine because nobody can see it), and an
 * immediate repaint the moment the page becomes visible again.
 */
export function startTicker(fn) {
  let raf = 0;
  const paint = () => { try { fn(); } catch (err) { console.error('[ticker]', err); } };

  const frame = () => { paint(); raf = requestAnimationFrame(frame); };
  const backstop = setInterval(() => { if (document.hidden) paint(); }, 250);

  const onVis = () => {
    cancelAnimationFrame(raf);
    paint();
    if (!document.hidden) raf = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', onVis);

  paint();
  if (!document.hidden) raf = requestAnimationFrame(frame);

  // The listener must be removed too: while it lived on, one visibility flip
  // restarted a disposed ticker permanently.
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    cancelAnimationFrame(raf);
    clearInterval(backstop);
  };
}

/**
 * Fit a 1920x1080 stage into the window. The scale rounds UP a hair (0.05% at most,
 * cropped by the wrap's overflow) so fractional scaling can never leave a
 * sub-pixel seam of page background at the stage edges. On a broadcast
 * overlay that seam reads as a white line around the score bar.
 */
export function fitStage(stage) {
  const fit = () => {
    const s = Math.ceil(Math.min(innerWidth / 1920, innerHeight / 1080) * 2000) / 2000;
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  addEventListener('resize', fit);
  fit();
}

/** Re-trigger a CSS animation that may already have run. */
export function restart(el, attr = 'data-run') {
  el.removeAttribute(attr);
  void el.offsetWidth;
  el.setAttribute(attr, '');
}

export const connect = name => new DeskClient(name);
