/**
 * Operator navigation, injected into every console page.
 *
 * The consoles used to be reachable only from the index page, so getting from
 * the replay desk to the trivia host meant going back to `/` and picking
 * again. At an event nobody does that: they leave six tabs open and lose track
 * of which is which. One strip across the top of every console fixes both.
 *
 * The strip carries the program screen picker too, because "put the arcade
 * bumper up" is the single most time-critical thing an operator does between
 * matches, and it should not depend on which page they happen to be looking
 * at. It writes the same `screen.change` event the desk console does.
 */

import { SCREENS } from '/shared/desk-client.js';

const CONSOLES = [
  { id: 'desk', label: 'Desk' },
  { id: 'replay', label: 'Replay' },
  { id: 'draw', label: 'Telestrator' },
  { id: 'talent', label: 'Talent' },
  { id: 'arcadedesk', label: 'Arcade' },
  { id: 'triviadesk', label: 'Trivia' },
  { id: 'var', label: 'Ref review' },
  { id: 'media', label: 'Media' },
  { id: 'cards', label: 'Cards' },
];

// Program screens come from desk-client's shared SCREENS list: the strip,
// the desk's own row, and the phone remote must all teach the same words.

const CSS = `
.opnav { position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap;
  padding: 8px 14px; margin-bottom: 14px;
  background: var(--surface-raised); border-bottom: 2px solid var(--surface-sunken); }
/* The strip wraps in GROUPS, never item by item: the console links are one
   unit and the screen takes are another, so a width that cannot hold both
   drops the whole take row to its own line instead of orphaning one button
   ("Auto", alone on row two, was how this was found). Each group still
   wraps internally once it has a row to itself, so tablets get tidy rows
   rather than a horizontal scrollbar. */
.opnav .grp { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  min-width: 0; }
.opnav a, .opnav button {
  font-family: var(--font-cond); font-weight: 600;
  /* Metrics breathe with the viewport, so the single-row layout survives on
     monitors the fixed sizes overflowed by a button or two. */
  font-size: clamp(12px, 0.75vw, 14px);
  letter-spacing: .05em; text-transform: uppercase; text-decoration: none;
  padding: 8px clamp(7px, 0.65vw, 12px); cursor: pointer; border: 0;
  clip-path: var(--chamfer); --ch: 6px;
  background: var(--surface-sunken); color: var(--text); white-space: nowrap; }
.opnav a:hover, .opnav button:hover { background: var(--btn-hover); }
/* Inset, and :root-prefixed to match the weight of tokens.css's own
   :root[data-surface="console"] :focus-visible rule. Without the prefix that
   rule won on specificity and forced outline-offset back to +2px, which on
   these chamfer-clipped links paints NOTHING: the operator strip is the
   first thing a keyboard user tabs into on all nine consoles, and it had no
   visible focus anywhere. */
:root .opnav a:focus-visible, :root .opnav button:focus-visible {
  outline: 3px solid var(--focus-ring); outline-offset: -5px; }
/* Where you are, said twice: color and a filled background, so it is not
   color alone doing the work. */
.opnav a[aria-current="page"] { background: var(--accent); color: var(--text-on-accent); }
.opnav .sep { width: 1px; height: 22px; background: var(--surface-sunken); margin: 0 6px; }
.opnav .lbl { font-family: var(--font-cond); font-size: 13px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--text-dim); }
/* The spoken-refusal line gets its OWN class rather than borrowing .lbl.
   Sharing .lbl meant the narrow-window rule below hid it outright, and an
   author display:none cannot be undone by clearing the hidden attribute,
   so below 900px a refused take said nothing at all: not on screen, and not
   to a screen reader either, since a display:none role="status" is not
   announced. That silenced the one message that matters most, "The desk
   restarted. Reload this page to sign back in.", on exactly the tablets and
   half-screen laptop windows the consoles are used on. It wraps onto its own
   row instead of being squeezed out of the strip. */
.opnav .note { flex-basis: 100%; font-family: var(--font-cond); font-size: 13px;
  letter-spacing: .12em; text-transform: uppercase; color: var(--text); }
.opnav .take { background: var(--accent); color: var(--text-on-accent); }
.opnav .live { background: var(--st-ok); color: var(--cg-black); }
@media (max-width: 900px) { .opnav .lbl, .opnav .sep { display: none; } }
`;

/**
 * @param {string} current  surface id of the page mounting this
 * @param {object} opts     { screens: boolean } screens default on
 */
export function mountNav(current, opts = {}) {
  const withScreens = opts.screens !== false;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // The skip link: ~19 tab stops of nav strip sit before every console's
  // content, and a keyboard operator should not have to walk them all to
  // reach the first control. One link, visually hidden until focused.
  const skip = document.createElement('a');
  skip.href = '#main';
  skip.textContent = 'Skip to the console';
  skip.style.cssText = 'position:absolute;left:-9999px;top:8px;z-index:100;'
    + 'padding:8px 14px;background:var(--cg-gold);color:#101014;'
    + 'font-family:var(--font-cond);font-weight:700;text-transform:uppercase;'
    + 'letter-spacing:.1em;font-size:13px;';
  skip.addEventListener('focus', () => { skip.style.left = '8px'; });
  skip.addEventListener('blur', () => { skip.style.left = '-9999px'; });
  // The landmark the link needs: the page's own wrapper, promoted.
  // The telestrator pad has neither, so the drawing surface is the fallback:
  // a skip link that lands nowhere is worse than none.
  //
  // The fragment is read back OFF the element instead of being assumed. The
  // link hard-coded '#main' while the id was only assigned when the element
  // had none, and the one page that reaches the #pad fallback,
  // surfaces/draw, ships `<div id="pad">`: it kept its own id, #main was
  // never created, and the analyst's skip link navigated nowhere. Where
  // there is no landmark at all the link is left out entirely, for the same
  // reason the fallback exists.
  const wrap = document.querySelector('.wrap, main') ?? document.querySelector('#pad');
  if (wrap && !wrap.id) wrap.id = 'main';
  if (wrap && wrap.tagName !== 'MAIN') wrap.setAttribute('role', 'main');
  if (wrap) skip.href = `#${wrap.id}`;

  const nav = document.createElement('nav');
  nav.className = 'opnav';
  nav.setAttribute('aria-label', 'Operator consoles');

  nav.innerHTML =
    '<span class="grp" role="presentation">'
    + CONSOLES.map(c =>
      `<a href="/s/${c.id}"${c.id === current ? ' aria-current="page"' : ''}>${c.label}</a>`).join('')
    + '</span>'
    + (withScreens
      ? '<span class="grp" role="presentation">'
        + '<span class="sep" aria-hidden="true"></span><span class="lbl">On air</span>'
        + SCREENS.map(s =>
          `<button type="button" data-screen="${s.id}" title="Take the ${s.label} screen">${s.label}</button>`).join('')
        + '</span>'
      : '');

  document.body.prepend(nav);
  // The skip link goes in AFTER the strip, so that it ends up BEFORE it.
  // prepend() puts each node at the front of <body>, so prepending the link
  // first and the strip second left the DOM (and therefore the tab order)
  // reading nav, skip, page: a keyboard operator had to walk all nine console
  // links and eleven take buttons to reach the link whose only job is to let
  // them skip those. Because the link is off-screen until focused, nothing
  // ever revealed that it was doing nothing on every console.
  if (wrap) document.body.prepend(skip);

  // The strip wraps to two rows on narrow windows, so its height is a fact
  // only the browser knows. Published as a root variable for any page-level
  // sticky bar (the desk's jump strip) that has to stack under it.
  const setNavHeight = () =>
    document.documentElement.style.setProperty('--opnav-h', `${nav.offsetHeight}px`);
  setNavHeight();
  window.addEventListener('resize', setNavHeight);

  if (!withScreens) return nav;

  // The take buttons drive the bus directly rather than going through a page's
  // own desk client, so this works identically on a console that has no other
  // reason to hold a socket open.
  //
  // This socket reconnects on its own, the same way the console's own
  // connection does. Without that, a single network blip (or a desk restart
  // mid-show) would leave the take buttons dead silently: `ready` would never
  // go back to true, and nothing on the strip says so.
  let ws = null;
  let ready = false;
  let backoff = 250;
  let lastSeen = 0;

  // The same half-open watchdog the shared client runs: the strip's socket
  // hears the 10s server beat, so 25s of silence means the pipe is dead and
  // the take buttons are lying. drop() is shared by the close event and the
  // watchdog, because a half-open socket may never deliver a close.
  let dropped = false;
  function drop(sock) {
    if (sock !== ws || dropped) return;
    dropped = true;
    ready = false;
    setTimeout(connectNav, backoff);
    backoff = Math.min(backoff * 2, 5000);
  }
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastSeen > 25_000) {
      const sock = ws;
      try { sock.close(); } catch { /* already dying */ }
      drop(sock);
    }
  }, 5_000);

  function connectNav() {
    dropped = false;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?surface=nav`);

    ws.addEventListener('open', () => { ready = true; backoff = 250; lastSeen = Date.now(); });

    ws.addEventListener('message', ev => {
      lastSeen = Date.now();
      try {
        const msg = JSON.parse(ev.data);
        // A refused take used to vanish: the server answers {t:'denied'} (a
        // desk restart invalidates this page's session; award events are
        // JA-only) and this handler only looked for state frames, so the
        // operator pressed, nothing happened, and nothing said why.
        if (msg?.t === 'denied') {
          sayNote(msg.reason === 'PIN required'
            ? 'The desk restarted. Reload this page to sign back in.'
            : (msg.reason || 'The desk refused that.'));
          return;
        }
        const state = msg?.state;
        const screen = state?.screen ?? msg?.payload?.screen;
        if (!screen) return;
        for (const b of nav.querySelectorAll('button[data-screen]')) {
          // 'Auto' lights when nothing is being held, so the strip always says
          // whether the screen is following the match or an operator.
          const on = b.dataset.screen === 'auto'
            ? state?.screenHold === false
            : b.dataset.screen === screen;
          b.classList.toggle('live', !!on);
          // The class is the paint; this is the same fact for a screen reader.
          b.setAttribute('aria-pressed', String(!!on));
        }
      } catch { /* not a state frame */ }
    });

    const sock = ws;
    ws.addEventListener('close', () => drop(sock));
    ws.addEventListener('error', () => ws.close());
  }
  const note = document.createElement('span');
  note.className = 'note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  nav.append(note);

  /**
   * The one place the strip speaks. Every path that has something to tell the
   * operator goes through here, so none of them can quietly pick a channel
   * that nobody reads.
   */
  let noteTimer = null;
  function sayNote(text) {
    note.textContent = text;
    note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note.hidden = true; }, 6000);
  }

  connectNav();

  for (const b of nav.querySelectorAll('button[data-screen]')) {
    b.onclick = () => {
      // Say so instead of doing nothing: a take pressed during a desk restart
      // used to no-op with no clue anywhere on the strip.
      //
      // Said through the role="status" note, the same channel the `denied`
      // branch uses, because the two things this once relied on are not
      // channels at all: a `title` needs a sustained mouse hover, is never
      // surfaced on a press, and is not announced on activation, and a 300ms
      // opacity blink carries no words. Writing b.title also permanently
      // replaced that button's real tooltip ("Take the Blank screen") for the
      // rest of the session, so the one durable effect was making the strip
      // slightly worse.
      if (!ready) {
        b.animate?.([{ opacity: 1 }, { opacity: .3 }, { opacity: 1 }], { duration: 300 });
        sayNote('Reconnecting to the desk. Try again in a second.');
        return;
      }
      ws.send(JSON.stringify({
        t: 'emit',
        init: { type: 'screen.change', payload: { screen: b.dataset.screen } },
      }));
    };
  }

  return nav;
}
