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
  #watchdog = null;
  #ws = null;
  #backoff = 250;
  #name;

  constructor(name) {
    super();
    this.#name = name;
    this.#connect();
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
      this.dispatchEvent(new CustomEvent('link', { detail: true }));
    };

    ws.onmessage = e => {
      this.#lastSeen = Date.now();
      const msg = JSON.parse(e.data);
      if (msg.t === 'snapshot') {
        this.media = msg.media ?? {};
        this.needsPin = !!msg.needsPin;
        // Re-authenticate automatically after a reconnect. A remote that
        // silently stops working mid-show because the socket blipped is worse
        // than one that never worked.
        if (this.needsPin && this.#pin) this.authenticate(this.#pin);
        this.#apply(msg.state);
        this.dispatchEvent(new CustomEvent('ready'));
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

/**
 * Reads ?key= onto <html>, so one URL configures a surface for OBS alpha vs.
 * a Blackmagic luma key. A surface's own markup default (e.g. the side screen
 * shipping luma) holds unless the URL says otherwise.
 */
export function applyDisplayMode() {
  const p = new URLSearchParams(location.search);
  const root = document.documentElement;
  root.dataset.key = p.get('key') || root.dataset.key || 'alpha';
  if (p.get('surface')) root.dataset.surface = p.get('surface');
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
