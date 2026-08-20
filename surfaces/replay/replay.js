/**
 * Replay console.
 *
 * The timeline is the MATCH CLOCK, phase-segmented, not a raw video scrubber.
 * The operator thinks in "endgame", not "18:42:07", and every marker is already
 * placed, so the job is choosing rather than hunting.
 */

import { connect, startTicker, clockDisplay, REBUILT } from '/shared/desk-client.js';

const $ = id => document.getElementById(id);
const desk = connect('replay');

const T0 = REBUILT.AUTO_START;          // -20
const T1 = REBUILT.MATCH_END;           // 140
const SPAN = T1 - T0;                   // 160s of match clock

const PHASES = [
  ['auto', 'Auto', T0, 0],
  ['transition', 'Trans', 0, REBUILT.TRANSITION_END],
  ['shift1', 'Shift 1', 10, 35], ['shift2', 'Shift 2', 35, 60],
  ['shift3', 'Shift 3', 60, 85], ['shift4', 'Shift 4', 85, 110],
  // 'End game', two words, to match PHASE_LABEL: the desk console sits next
  // to this one and the two must not spell the same phase differently.
  ['endgame', 'End game', REBUILT.ENDGAME_START, T1],
];

$('phases').innerHTML = PHASES.map(([id, label, a, b]) =>
  `<div data-p="${id}" style="flex:${b - a}">${label}</div>`).join('');

const TICK_CLOCKS = [-20, 0, 30, 60, 90, 120, 140];
// The first and last labels are anchored to the track's own edges (see CSS):
// centering them, like the ones in between, would hang half the label past
// the end of the timeline.
$('ticks').innerHTML = TICK_CLOCKS.map((c, i) => {
  const edge = i === 0 ? ' data-align="start"' : i === TICK_CLOCKS.length - 1 ? ' data-align="end"' : '';
  return `<span style="left:${pct(c)}%"${edge}>${clockDisplay(c)}</span>`;
}).join('');

function pct(clock) { return ((clock - T0) / SPAN) * 100; }

// Marker and clip labels derive from operator-typed text (match display
// names); a stray < must not eat the row. Same helper as the var console.
function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- state ----------------------------------------------------------------
let markers = [];
let inClock = null;
let outClock = null;
let lastClip = null;

/** Match clock -> wall ms. Exact, because match start is a logged timestamp. */
function wallAt(clock) {
  const started = desk.state?.matchStartedAt ?? desk.state?.lastMatchStartedAt;
  return started ? started + (clock - T0) * 1000 : null;
}

function setBounds(a, b) {
  inClock = Math.max(T0, Math.min(T1, a));
  outClock = Math.max(inClock + 1, Math.min(T1 + 20, b));
  paintSelection();
}

function paintSelection() {
  const sel = $('sel');
  if (inClock === null) { sel.style.display = 'none'; $('bounds').textContent = 'in - · out - · -'; return; }
  sel.style.display = 'block';
  sel.style.left = `${pct(inClock)}%`;
  // outClock may run past the buzzer on purpose (T1 + 20, for the celebration),
  // but nothing clips #sel, so the painted bar must stop at the track edge.
  sel.style.width = `${Math.max(0.4, Math.min(100, pct(outClock)) - pct(inClock))}%`;
  $('bounds').textContent =
    `in ${clockDisplay(inClock)} · out ${clockDisplay(outClock)} · ${(outClock - inClock).toFixed(1)}s`;
}

// ---- timeline interaction --------------------------------------------------
$('track').addEventListener('pointerdown', e => {
  const r = $('track').getBoundingClientRect();
  const clock = T0 + ((e.clientX - r.left) / r.width) * SPAN;
  setBounds(clock, clock + 10);
});

function paintMarkers() {
  const track = $('track');
  for (const el of document.querySelectorAll('.mk')) el.remove();
  for (const m of markers) {
    if (m.matchClock === null || m.matchClock === undefined) continue;
    // Manual markers can arrive label-less; "undefined" on a tooltip is worse
    // than a plain name.
    const label = m.label ?? 'Manual mark';
    const el = document.createElement('div');
    el.className = 'mk';
    el.dataset.pri = String(m.priority ?? 2);
    if (m.alliance) el.dataset.a = m.alliance;
    el.dataset.label = label;
    el.style.left = `${pct(m.matchClock)}%`;
    // Past 60% of the track a left-anchored tooltip runs into the section's
    // chamfer clip-path and gets cut; those anchor right instead (see CSS).
    if (pct(m.matchClock) > 60) el.dataset.edge = '';
    // Keyboard-reachable: an operator tabbing through the page (or a screen
    // reader) can jump to a marker the same way a mouse click does.
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Frame ${label} at ${clockDisplay(m.matchClock)}`);
    // Frame the marker: enough lead-in to see the build-up, enough tail to see
    // the result. A human hits the button late, so the marker itself already
    // sits 2s back (see the desk console).
    const frameMarker = () => setBounds(m.matchClock - 6, m.matchClock + 4);
    el.onclick = ev => { ev.stopPropagation(); frameMarker(); };
    el.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      // Stop this Enter from also reaching the page-level shortcut (Enter = Cut
      // clip): the marker's own Enter means "frame this marker", not "cut now".
      ev.stopPropagation();
      frameMarker();
    });
    track.parentElement.appendChild(el);
  }

  // The LIST seeks. It used to be inert text while the only clickable
  // targets were the 3-to-5-pixel slivers on the track: the operator read
  // "red 8 fuel burst 1:36" in comfortable type, clicked it, and nothing
  // happened; the real target needed aiming under a 20-second replay window.
  // Each row frames the same window the track sliver does.
  $('markers').replaceChildren(...(markers.length
    ? [...markers].reverse().map(m => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'btn';
      row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;'
        + 'width:100%;text-align:left;margin-bottom:4px;text-transform:none;'
        + 'letter-spacing:0;font-family:var(--font-display);font-weight:600;';
      const label = document.createElement('span');
      label.textContent = m.label ?? 'Manual mark';
      const clock = document.createElement('span');
      clock.className = 'mono';
      clock.textContent = m.matchClock === null ? '-' : clockDisplay(m.matchClock);
      row.append(label, clock);
      if (m.matchClock === null || m.matchClock === undefined) {
        row.disabled = true;
      } else {
        row.onclick = () => setBounds(m.matchClock - 6, m.matchClock + 4);
      }
      return row;
    })
    : [(() => {
      const i = document.createElement('i');
      i.textContent = 'None yet. They appear as the match runs.';
      return i;
    })()]));
}

async function loadMarkers() {
  try {
    const res = await fetch('/api/markers');
    if (!res.ok) return say('Signed out. Reload this page and sign in again.', true);
    markers = await res.json();
    paintMarkers();
  } catch { /* transient */ }
}

// ---- sources ---------------------------------------------------------------
async function loadSources() {
  try {
    const res = await fetch('/api/recorder');
    if (!res.ok) {
      $('src').innerHTML = '<option value="program">program</option>';
      return say('Signed out. Reload this page and sign in again.', true);
    }
    const rec = await res.json();
    $('encoder').textContent = rec.available ? `encoder: ${rec.encoder}` : 'recording unavailable';
    $('src').innerHTML = rec.sources.length
      ? rec.sources.map(s => `<option value="${s.id}">${s.label}${s.running ? '' : ' (down)'}</option>`).join('')
      : '<option value="program">program</option>';
  } catch {
    $('src').innerHTML = '<option value="program">program</option>';
  }
}

// ---- actions ---------------------------------------------------------------
const say = (msg, isErr = false) => {
  const el = $('status');
  el.textContent = msg;
  el.toggleAttribute('data-err', isErr);
};

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json;
}

async function cut() {
  if (inClock === null) return say('Pick an in-point on the timeline first.', true);
  const fromMs = wallAt(inClock), toMs = wallAt(outClock);
  if (!fromMs) return say('No match start recorded yet: nothing to map the clock onto.', true);

  say('Cutting...');
  try {
    const clip = await post('/api/clips', {
      sourceId: $('src').value,
      ranges: [{ fromMs, toMs }],
      speed: Number($('speed').value),
      label: `${desk.state?.match?.displayName ?? 'clip'}-${clockDisplay(inClock).replace(':', '')}`,
    });
    showClip(clip);
    say(`Ready · ${clip.seconds.toFixed(1)}s`);
  } catch (err) { say(err.message, true); }
}

async function cutMatch() {
  say('Cutting full match video...');
  try {
    const clip = await post('/api/clips/match', { sourceId: $('src').value });
    showClip(clip);
    say(`Match video ready · ${clip.seconds.toFixed(1)}s · ${clip.parts} part(s)` +
      (clip.parts > 1 ? ' (referee delay cut out)' : ''));
  } catch (err) { say(err.message, true); }
}

function showClip(clip) {
  lastClip = clip;
  $('preview').src = clip.url;
  $('clipsEmpty')?.remove();
  const row = document.createElement('div');
  row.innerHTML = `<a href="${clip.url}" target="_blank">${esc(clip.label)}</a>` +
    `<span class="mono">${clip.seconds.toFixed(1)}s${clip.speed !== 1 ? ` ${clip.speed}×` : ''}</span>`;
  $('clips').prepend(row);
  while ($('clips').children.length > 12) $('clips').lastChild.remove();
}

async function sendFrame() {
  if (!lastClip) return say('Cut a clip first, then pause on the frame you want.', true);
  // The frame the operator is actually looking at, mapped back to wall clock.
  // A multi-part match video plays its ranges back to back with the referee
  // delay removed, so the pause position is walked range by range: mapping it
  // all onto ranges[0] used to point part-2 frames into the removed gap.
  const speed = lastClip.speed ?? 1;
  let t = $('preview').currentTime;
  // The last range absorbs any float overshoot at the very end of playback,
  // and the clamp keeps the result inside it.
  let range = lastClip.ranges[lastClip.ranges.length - 1];
  for (const r of lastClip.ranges.slice(0, -1)) {
    const dur = (r.toMs - r.fromMs) / 1000 / speed;
    if (t <= dur) { range = r; break; }
    t -= dur;
  }
  const atMs = Math.min(range.toMs, range.fromMs + t * 1000 * speed);
  say('Sending frame...');
  try {
    await post('/api/frame', { sourceId: lastClip.sourceId, atMs: Math.round(atMs) });
    say('Frame sent to the analyst.');
  } catch (err) { say(err.message, true); }
}

function take() {
  if (!lastClip) return say('Nothing cut yet.', true);
  // emit() drops silently on a closed socket, so "Sent" would be a lie there.
  // A server-side rejection comes back as 'denied' and overwrites this line.
  if (!desk.connected) return say('Link is down. Wait for the dot, then try again.', true);
  desk.emit({ type: 'replay.play', payload: lastClip });
  say('Sent to program.');
}

$('cut').onclick = cut;
$('cutMatch').onclick = cutMatch;
$('send').onclick = sendFrame;
$('take').onclick = take;

for (const b of document.querySelectorAll('[data-nudge]')) {
  b.onclick = () => {
    const [edge, delta] = b.dataset.nudge.split(':');
    if (inClock === null) return;
    if (edge === 'in') setBounds(inClock + Number(delta), outClock);
    else setBounds(inClock, outClock + Number(delta));
  };
}

addEventListener('keydown', e => {
  // Bare keys only: Ctrl+F must stay find-in-page, not become send-frame.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Buttons and links included: Enter on a focused button must activate that
  // button, not fire cut() over it (preventDefault cancels the activation).
  if (e.target.closest('button, a, input, select, textarea, video')) return;
  if (e.key === 'Enter') { e.preventDefault(); cut(); }
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); sendFrame(); }
  if (e.key.toLowerCase() === 't') { e.preventDefault(); take(); }
});

// ---- live wiring -----------------------------------------------------------
// A core restart regenerates the session, so the cookie can die while the
// socket reconnects and reports healthy: every take is then rejected behind a
// green dot. Latch the failure; the only way back is a reload through /signin.
let signedOut = false;
desk.on('denied', () => {
  signedOut = true;
  $('dot').dataset.up = 'false';
  $('linkText').textContent = 'signed out: reload this page to sign in again';
  say('Signed out. Reload this page and sign in again.', true);
});
desk.on('link', up => {
  if (signedOut) return;
  $('dot').dataset.up = String(up);
  $('linkText').textContent = up ? 'linked' : 'reconnecting...';
  if (up) { loadSources(); loadMarkers(); }
});

desk.on('state', s => {
  $('matchName').textContent = s.match?.displayName ?? 'No match loaded';
});

desk.on('replay.marker', () => loadMarkers());
desk.on('match.loaded', () => { markers = []; paintMarkers(); setBounds(T0, T0 + 10); });

// Playhead follows the live match.
startTicker(() => {
  const c = desk.matchClock;
  const head = $('playhead');
  if (c === null || c < T0 || c > T1) { head.style.display = 'none'; return; }
  head.style.display = 'block';
  head.style.left = `${pct(c)}%`;
});

loadSources();
loadMarkers();
paintSelection();
