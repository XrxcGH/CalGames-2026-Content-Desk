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

/** Program screens, in the order the show actually uses them. */
const SCREENS = [
  { id: 'overview', label: 'Pre-match' },
  { id: 'match', label: 'Match' },
  { id: 'score', label: 'Final' },
  { id: 'selection', label: 'Selection' },
  { id: 'explain', label: 'Explainer' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'cardcall', label: 'Card call' },
  { id: 'arcade', label: 'Arcade' },
  { id: 'blank', label: 'Blank' },
  // Not a screen: hands control back to the match lifecycle.
  { id: 'auto', label: 'Auto' },
];

const CSS = `
.opnav { position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 14px; margin-bottom: 14px;
  background: var(--surface-raised); border-bottom: 2px solid var(--surface-sunken); }
.opnav a, .opnav button {
  font-family: var(--font-cond); font-weight: 600; font-size: 14px;
  letter-spacing: .06em; text-transform: uppercase; text-decoration: none;
  padding: 8px 12px; cursor: pointer; border: 0;
  clip-path: var(--chamfer); --ch: 6px;
  background: var(--surface-sunken); color: var(--text); }
.opnav a:hover, .opnav button:hover { background: var(--btn-hover); }
.opnav a:focus-visible, .opnav button:focus-visible {
  outline: 3px solid var(--focus-ring); outline-offset: -5px; }
/* Where you are, said twice: color and a filled background, so it is not
   color alone doing the work. */
.opnav a[aria-current="page"] { background: var(--accent); color: var(--text-on-accent); }
.opnav .sep { width: 1px; height: 22px; background: var(--surface-sunken); margin: 0 6px; }
.opnav .lbl { font-family: var(--font-cond); font-size: 13px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--text-dim); }
.opnav .take { background: var(--accent); color: var(--text-on-accent); }
.opnav .live { background: var(--st-ok); color: var(--cg-black); }
@media (max-width: 900px) { .opnav .lbl { display: none; } }
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
  document.body.prepend(skip);
  // The landmark the link needs: the page's own wrapper, promoted.
  const wrap = document.querySelector('.wrap, main');
  if (wrap && !wrap.id) wrap.id = 'main';
  if (wrap && wrap.tagName !== 'MAIN') wrap.setAttribute('role', 'main');

  const nav = document.createElement('nav');
  nav.className = 'opnav';
  nav.setAttribute('aria-label', 'Operator consoles');

  nav.innerHTML =
    CONSOLES.map(c =>
      `<a href="/s/${c.id}"${c.id === current ? ' aria-current="page"' : ''}>${c.label}</a>`).join('')
    + (withScreens
      ? '<span class="sep" aria-hidden="true"></span><span class="lbl">On air</span>'
        + SCREENS.map(s =>
          `<button type="button" data-screen="${s.id}" title="Take the ${s.label} screen">${s.label}</button>`).join('')
      : '');

  document.body.prepend(nav);

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

  function connectNav() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?surface=nav`);

    ws.addEventListener('open', () => { ready = true; backoff = 250; });

    ws.addEventListener('message', ev => {
      try {
        const msg = JSON.parse(ev.data);
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

    ws.addEventListener('close', () => {
      ready = false;
      setTimeout(connectNav, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
    ws.addEventListener('error', () => ws.close());
  }
  connectNav();

  for (const b of nav.querySelectorAll('button[data-screen]')) {
    b.onclick = () => {
      // Say so instead of doing nothing: a take pressed during a desk restart
      // used to no-op with no clue anywhere on the strip.
      if (!ready) {
        b.animate?.([{ opacity: 1 }, { opacity: .3 }, { opacity: 1 }], { duration: 300 });
        b.title = 'Reconnecting to the desk. Try again in a second.';
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
