/**
 * Desk console. The P0 ship criterion: a producer, a switcher op and an
 * analyst can run a full match from here with every integration dead.
 *
 * Keyboard-first, because the producer is watching program, not their hands.
 */

import {
  connect, clockDisplay, clockDisplayFor, phaseFor, PHASE_LABEL, startTicker,
} from '/shared/desk-client.js';

const $ = id => document.getElementById(id);
const desk = connect('desk');

// ---- connection ------------------------------------------------------------
// A core restart regenerates the session token, so this page's cookie goes
// stale while the socket reconnects and reports healthy: every emit then
// fails behind a green dot. This page has no PIN UI, so the only way back in
// is a reload through /signin. Latch the message so a later reconnect cannot
// paint the dot green again over a session that is still dead.
let signedOut = false;
desk.on('denied', () => {
  signedOut = true;
  $('dot').dataset.up = 'false';
  $('linkText').textContent = 'signed out: reload this page to sign in again';
});
desk.on('link', up => {
  if (signedOut) return;
  $('dot').dataset.up = String(up);
  $('linkText').textContent = up ? 'linked' : 'reconnecting...';
});

// ---- live readout ----------------------------------------------------------
desk.on('state', s => {
  $('nRed').textContent = s.score.red.total;
  $('nBlue').textContent = s.score.blue.total;
  // Keep the manual-take dropdown honest about what program is showing, but
  // never yank it out from under an operator who is mid-choice.
  if (document.activeElement !== $('screenSel')
      && [...$('screenSel').options].some(o => o.value === s.screen)) {
    $('screenSel').value = s.screen;
  }
  $('nMatch').textContent = s.match
    // Both, and only both when they differ, which is the state worth
    // noticing: an official total sitting over a typed-in breakdown.
    ? `${s.match.displayName} · screen: ${s.screen} · ${s.totalConfidence}`
      + (s.confidence === s.totalConfidence ? '' : ` (breakdown ${s.confidence})`)
    : 'No match loaded';
  $('nRedTeams').textContent = (s.match?.red ?? []).map(t => t.number).join(' · ') || '-';
  $('nBlueTeams').textContent = (s.match?.blue ?? []).map(t => t.number).join(' · ') || '-';
});

startTicker(() => {
  const c = desk.matchClock;
  $('nClock').textContent = clockDisplayFor(desk.state, c);
  $('nPhase').textContent = PHASE_LABEL[phaseFor(desk.state, c)] ?? '';
});

// ---- event log -------------------------------------------------------------
// Built with textContent, never innerHTML: type and source arrive over the WS
// from any client on the production LAN and must render as text, not markup.
desk.on('desk', ev => {
  const row = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false });
  const what = document.createElement('span');
  const ty = document.createElement('span');
  ty.className = 'ty';
  ty.textContent = ev.type;
  const src = document.createElement('span');
  src.style.opacity = '.6';
  src.textContent = ` ${ev.source}`;
  what.append(ty, src);
  row.append(t, what);
  $('log').prepend(row);
  while ($('log').children.length > 120) $('log').lastChild.remove();
});

// ---- actions ---------------------------------------------------------------
const emit = (type, payload) => desk.emit({ type, payload });

for (const b of document.querySelectorAll('[data-emit]')) {
  b.onclick = () => emit(b.dataset.emit);
}
for (const b of document.querySelectorAll('[data-score]')) {
  b.onclick = () => score(b.dataset.score);
}

// Manual screen take. The lifecycle buttons drive screens on their own; this
// is the override for everything else: analysis segments, the arcade bumper,
// or recovering from a state the automation didn't expect.
$('screenTake').onclick = () => emit('screen.change', { screen: $('screenSel').value });

// ---- status card -----------------------------------------------------------
// One press puts the "why we're waiting" card up; minutes are optional.
function showStatus(kind, message) {
  const min = Number($('statusMin').value);
  emit('status.show', {
    kind, message,
    backAt: min > 0 ? Date.now() + min * 60_000 : null,
  });
}
for (const b of document.querySelectorAll('[data-status]')) {
  b.onclick = () => {
    const [kind, message] = b.dataset.status.split(/:(.+)/);
    showStatus(kind, message);
  };
}
$('statusShowCustom').onclick = () => {
  const message = $('statusCustom').value.trim();
  if (message) showStatus('custom', message);
};
$('statusClear').onclick = () => { emit('status.hide'); $('statusMin').value = ''; };

/** Shadow scoring publishes at `estimated`. The overlay renders it outlined. */
function score(spec) {
  const [alliance, field, amount] = spec.split(':');
  desk.emit({
    type: 'score.delta',
    confidence: 'estimated',
    payload: { alliance, field, amount: Number(amount) },
  });
}

function showThird(pinned) {
  // The placeholder is a sample, not a default. It used to be the fallback, so
  // pressing T before typing anything put a lower third naming a specific
  // (invented) person on the broadcast: a one-keystroke mistake with no undo
  // shorter than pressing T again.
  const line1 = $('t1').value.trim();
  if (!line1) {
    $('thirdHint').textContent = 'Type a name first. The grey text is an example.';
    return;
  }
  emit('lower_third.show', { line1, line2: $('t2').value.trim(), pinned });
}
$('thirdShow').onclick = () => showThird(false);
$('thirdPin').onclick = () => showThird(true);
$('thirdHide').onclick = () => emit('lower_third.hide');

const teamList = str => str.trim().split(/\s+/).filter(Boolean)
  .map(n => ({ number: Number(n), name: '' }));

$('loadMatch').onclick = () => {
  emit('match.loaded', {
    id: `m${Date.now()}`,
    displayName: $('mName').value || 'Match',
    red: teamList($('mRed').value),
    blue: teamList($('mBlue').value),
  });
};

// ---- telestrator -----------------------------------------------------------
const teleFrame = (frame) => emit('telestrator.frame', {
  analyst: $('analyst').value || $('analyst').placeholder,
  frame,
});
$('teleSend').onclick = () => teleFrame($('frame').value || null);
$('teleLive').onclick = () => teleFrame(desk.state?.telestrator?.frame ?? null);
$('teleClear').onclick = () => emit('telestrator.clear');
$('teleHide').onclick = () => emit('telestrator.hide');

// ---- replay markers --------------------------------------------------------
$('mark').onclick = () => mark();

function mark() {
  // Back-date by 2s: by the time a human presses the button, the moment has
  // already passed.
  const at = (desk.matchClock ?? 0) - 2;
  desk.emit({ type: 'replay.marker', payload: { kind: 'manual', matchClock: at } });
  const line = document.createElement('div');
  line.textContent = `▲ manual · ${clockDisplay(at)} (${at.toFixed(1)}s)`;
  $('markers').prepend(line);
  while ($('markers').children.length > 12) $('markers').lastChild.remove();
}

// ---- keyboard --------------------------------------------------------------
const KEYS = {
  '1': () => emit('match.preview'),
  '2': () => emit('match.armed'),
  '3': () => emit('match.start'),
  '4': () => emit('match.end'),
  '5': () => emit('match.score_posted'),
  '0': () => emit('match.aborted'),
  'b': () => emit('screen.change', { screen: 'blank' }),
  't': () => showThird(false),
  'y': () => emit('lower_third.hide'),
  'q': () => score('red:fuel:1'),
  'w': () => score('red:fuel:5'),
  'e': () => score('red:tower:10'),
  'a': () => score('blue:fuel:1'),
  's': () => score('blue:fuel:5'),
  'd': () => score('blue:tower:10'),
  ' ': () => mark(),
};

addEventListener('keydown', e => {
  // Browser chords stay with the browser. Without this, Ctrl+0 (reset zoom,
  // pressed constantly on laptops) aborted the live match, and Ctrl+A
  // published a phantom blue score.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Never steal keys from a field the operator is typing in.
  if (e.target.matches('input, select, textarea')) return;
  // Space on a focused button must press that button, not drop a marker:
  // preventDefault on keydown would swallow the activation entirely.
  if (e.key === ' ' && e.target.closest('button')) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  fn();
});

// ---- publish a segment -----------------------------------------------------
// Alliance selection and the ceremonies are the parts of the day teams ask for
// and nobody records. Nothing on the bus knows when a ceremony began, so the
// operator marks both ends by hand.
let segFrom = null;

// "Other..." reveals a title field: the API takes any unlisted string as a
// literal title, which is how a single award gets its own video.
$('segKind').onchange = () => {
  const other = $('segKind').value === 'other';
  $('segOtherRow').style.display = other ? 'flex' : 'none';
  if (other) $('segTitle').focus();
};

$('segStart').onclick = () => {
  segFrom = Date.now();
  $('segQueue').disabled = false;
  $('segState').textContent = `Marking since ${new Date(segFrom).toLocaleTimeString()}.`;
};

$('segQueue').onclick = async () => {
  if (segFrom === null) return;
  const kind = $('segKind').value;
  const segment = kind === 'other' ? $('segTitle').value.trim() : kind;
  if (!segment) {
    // Refuse rather than publish a video literally titled "other".
    $('segState').textContent = 'Type a title first: it becomes the video title.';
    $('segTitle').focus();
    return;
  }
  $('segQueue').disabled = true;
  try {
    const res = await fetch('/api/publish/segment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segment, fromMs: segFrom, toMs: Date.now() }),
    });
    const item = await res.json();
    if (!res.ok) throw new Error(item.error ?? `HTTP ${res.status}`);
    $('segState').textContent = item.state === 'held'
      ? `${item.label} queued and held: ${item.error}`
      : `${item.label} queued.`;
    segFrom = null;
  } catch (err) {
    $('segState').textContent = err.message;
    $('segQueue').disabled = false;
  }
};

// ---- stream ----------------------------------------------------------------
// OBS owns the RTMP URL and the key; these controls only ask it to go. OBS
// liveness is not on the event bus, so status comes from a modest poll: five
// seconds of staleness on a timecode readout costs nothing.

const streamSay = (msg, isErr = false) => {
  $('streamMsg').textContent = msg;
  $('streamMsg').toggleAttribute('data-err', isErr);
};

function paintStream(s) {
  // Dead integrations disable the buttons with the reason on the status
  // line, never silently: the operator must know WHY Start is grayed out.
  const usable = !!s?.connected;
  $('streamStart').disabled = !usable;
  $('streamStop').disabled = !usable;
  let line;
  // Not "check the link dot": the dot tracks the WebSocket, which reconnects
  // on its own schedule and is routinely green while this HTTP poll is the
  // thing failing (a desk restart mid-poll, a blocked fetch). Pointing at a
  // healthy indicator sent operators hunting in the wrong place.
  if (!s) line = 'Stream status did not answer. If the desk just restarted, the next poll picks it up on its own.';
  else if (!s.available) line = 'No OBS control: launch the desk with --obs to run the stream from here.';
  else if (!s.connected) line = 'OBS is not connected. Start OBS on this machine; the desk retries on its own.';
  else if (s.streaming === null) line = 'OBS is connected but did not answer the status probe.';
  else if (s.streaming) {
    // OBS timecodes carry milliseconds; nobody reads a stream uptime that closely.
    const tc = s.timecode ? ` · ${s.timecode.split('.')[0]}` : '';
    line = `Streaming${tc}${s.reconnecting ? ' · reconnecting to the ingest' : ''}`;
  } else line = 'OBS connected · not streaming.';
  $('streamState').textContent = line;
}

async function pollStream() {
  let s = null;
  try {
    const res = await fetch('/api/stream');
    if (res.ok) s = await res.json();
  } catch { /* transient; paintStream(null) reports the miss */ }
  paintStream(s);
}

async function streamPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    ...(body ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

// Ask first, the same idiom as the trivia console's delete: a fat-fingered
// Stop ends the broadcast for every viewer, and Start goes public just as
// abruptly. The server is idempotent, so a re-press after a confirm is safe.
$('streamStart').onclick = async () => {
  if (!confirm('Start the stream? OBS goes live to the public feed.')) return;
  try { await streamPost('/api/stream/start'); streamSay('Stream is up.'); }
  catch (err) { streamSay(err.message, true); }
  pollStream();
};
$('streamStop').onclick = async () => {
  if (!confirm('Stop the live stream? It ends for every viewer.')) return;
  try { await streamPost('/api/stream/stop'); streamSay('Stream stopped.'); }
  catch (err) { streamSay(err.message, true); }
  pollStream();
};

$('streamTitle').onclick = async () => {
  // A blank field means day 1; the server rejects anything not a positive
  // whole number with a sentence worth showing verbatim.
  const day = Number($('streamDay').value) || 1;
  try {
    const r = await streamPost('/api/stream/title', { day });
    streamSay(`YouTube broadcast is now "${r.title}".`);
  } catch (err) { streamSay(err.message, true); }
};

pollStream();
setInterval(() => { if (!document.hidden) pollStream(); }, 5000);
// Repaint the moment the page is visible again rather than up to 5s later.
addEventListener('visibilitychange', () => { if (!document.hidden) pollStream(); });

// ---- day VOD chapters ------------------------------------------------------
$('chapMake').onclick = async () => {
  const params = new URLSearchParams();
  // A bare time means today: the stream and the desk are always the same day.
  if ($('chapStart').value) {
    const [h, m, s] = $('chapStart').value.split(':').map(Number);
    const d = new Date();
    d.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
    params.set('startedAt', String(d.getTime()));
  }
  try {
    const res = await fetch(`/api/chapters?${params}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    $('chapText').style.display = body.usable ? 'block' : 'none';
    $('chapText').value = body.text;
    $('chapState').textContent = body.usable
      ? `${body.chapters.length} chapters from ${new Date(body.startedAt).toLocaleTimeString()}. Select all and copy.`
      : 'Not enough yet. YouTube ignores a list under three chapters, so this stays empty until there are.';
  } catch (err) {
    $('chapText').style.display = 'none';
    $('chapState').textContent = err.message;
  }
};

// ---- on camera: saved profiles, ordered left to right -----------------------
//
// Two lists rather than one. The BOOK is who exists and is ticked; the ON AIR
// list is who is up and, crucially, in what order. They are separate because
// the order is the part the graphic gets wrong: names have to sit under the
// right faces, and "who is on" and "where they sit" are different questions
// the desk manager answers at different moments.
//
// The book fills itself. Anyone put on air is remembered by the server, so
// after the first segment the common case is ticking two boxes.
const PANEL_MAX = 6;
/** Profile ids in screen order, left to right. The wire order IS the layout. */
let onAir = [];
let book = [];

async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles');
    if (!res.ok) return;
    book = await res.json();
    paintBook();
  } catch { /* the desk runs without the book; the panel just needs typing */ }
}

function paintBook() {
  const list = $('profileList');
  if (!book.length) {
    list.innerHTML = '<p class="hint" style="padding:8px">Nobody saved yet. Add someone below, ' +
      'or put a name on air and it is remembered.</p>';
    return;
  }
  list.replaceChildren(...book.map(p => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = onAir.includes(p.id);
    box.onchange = () => toggle(p.id, box.checked);

    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('b');
    // The book shows the REAL name: this is the operator's list, and finding
    // the right person in it is the whole job. Only the graphic shortens.
    name.textContent = p.name;
    who.append(name);
    if (p.role || p.team) {
      const sub = document.createElement('span');
      sub.textContent = ' · ' + [p.role, p.team].filter(Boolean).join(' ');
      who.append(sub);
    }
    if (p.display && p.display !== p.name) {
      const as = document.createElement('span');
      as.className = 'as';
      as.textContent = ` airs as ${p.display}`;
      who.append(as);
    }

    // Toggling this is not an edit anyone should have to go looking for: a
    // student walks up to the desk and the operator has one press to make.
    const stu = document.createElement('button');
    stu.className = 'btn stu';
    stu.textContent = 'Student';
    stu.setAttribute('aria-pressed', String(!!p.student));
    stu.onclick = async e => {
      e.preventDefault();
      await fetch('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, name: p.name, role: p.role, team: p.team,
          student: !p.student }),
      });
      await loadProfiles();
      // The graphic may already be on air with the old name on it. Re-push so
      // the correction lands immediately rather than at the next segment,
      // which is the one moment it actually matters.
      if (onAir.includes(p.id)) $('panelShow').click();
      paintOnAir();
    };

    const kill = document.createElement('button');
    kill.className = 'btn kill';
    kill.textContent = 'Forget';
    kill.onclick = async e => {
      e.preventDefault();
      await fetch('/api/profiles/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id }),
      });
      onAir = onAir.filter(id => id !== p.id);
      await loadProfiles();
      paintOnAir();
    };

    label.append(box, who, stu, kill);
    return label;
  }));
}

function toggle(id, on) {
  // Ticking appends to the RIGHT of the row, which matches how people arrive:
  // somebody sits down at the end of the desk, not in the middle of it.
  if (on && !onAir.includes(id)) {
    if (onAir.length >= PANEL_MAX) {
      $('panelHint').textContent = `Six is the most the graphic can show and stay readable. ` +
        `Take one off first.`;
      paintBook();
      return;
    }
    onAir.push(id);
  } else if (!on) {
    onAir = onAir.filter(x => x !== id);
  }
  paintOnAir();
  paintBook();
}

function move(id, delta) {
  const i = onAir.indexOf(id);
  const to = i + delta;
  if (i < 0 || to < 0 || to >= onAir.length) return;
  onAir.splice(to, 0, ...onAir.splice(i, 1));
  paintOnAir();
}

function paintOnAir() {
  const box = $('panelOnAir');
  if (!onAir.length) {
    box.innerHTML = '<div class="empty">Nobody on air. Tick a name.</div>';
    $('panelHint').textContent = 'Tick a name to put them on. Six maximum.';
    return;
  }
  box.replaceChildren(...onAir.map((id, i) => {
    const p = book.find(b => b.id === id);
    const row = document.createElement('div');
    row.className = 'seat';

    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1);

    const who = document.createElement('span');
    who.textContent = p ? (p.team ? `${p.name} · ${p.role || ''} ${p.team}`.trim() : `${p.name}${p.role ? ' · ' + p.role : ''}`) : id;

    const left = document.createElement('button');
    left.className = 'btn';
    left.textContent = '◀';
    left.title = 'Move one seat left';
    left.setAttribute('aria-label', `Move ${p ? p.name : 'this person'} one seat left`);
    left.disabled = i === 0;
    left.onclick = () => move(id, -1);

    const right = document.createElement('button');
    right.className = 'btn';
    right.textContent = '▶';
    right.title = 'Move one seat right';
    right.setAttribute('aria-label', `Move ${p ? p.name : 'this person'} one seat right`);
    right.disabled = i === onAir.length - 1;
    right.onclick = () => move(id, 1);

    const off = document.createElement('button');
    off.className = 'btn';
    off.textContent = '✕';
    off.title = 'Take off air';
    off.setAttribute('aria-label', `Take ${p ? p.name : 'this person'} off air`);
    off.onclick = () => toggle(id, false);

    row.append(n, who, left, right, off);
    return row;
  }));
  $('panelHint').textContent = `${onAir.length} on air, seat 1 on the audience's left. ` +
    `Press Put on air to update the graphic.`;
}

$('pAdd').onclick = async () => {
  const name = $('pName').value.trim();
  if (!name) return;
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role: $('pRole').value.trim(), team: $('pTeam').value,
        student: $('pStudent').checked }),
    });
    const p = await res.json();
    if (!res.ok) throw new Error(p.error ?? `HTTP ${res.status}`);
    $('pName').value = ''; $('pRole').value = ''; $('pTeam').value = '';
    // The checkbox is deliberately NOT cleared: guests arrive in runs. Three
    // students from the same team is the normal case, and re-ticking it for
    // each one is how the third one ends up on air under their full name.
    await loadProfiles();
    toggle(p.id, true);
  } catch (err) {
    $('panelHint').textContent = err.message;
  }
};

$('panelShow').onclick = async () => {
  const people = onAir.map(id => {
    const p = book.find(b => b.id === id);
    return p ? { id: p.id, name: p.name, role: p.role, team: p.team } : null;
  }).filter(Boolean);
  try {
    const res = await fetch('/api/panel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('panelTitle').value.trim(), people }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    $('panelHint').textContent = body.warning
      ?? (body.on ? `${body.on} on air, left to right.` : 'Panel cleared.');
    await loadProfiles();
  } catch (err) {
    $('panelHint').textContent = err.message;
  }
};

$('panelHide').onclick = async () => {
  // The server first, the local list after. Clearing optimistically and
  // swallowing the failure showed "Nobody on air" on a console whose graphic
  // still had five faces up, and threw away the ordering, so recovery meant
  // re-ticking five people from memory while they were still on camera.
  const had = [...onAir];
  try {
    const res = await fetch('/api/panel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ people: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onAir = [];
    paintOnAir();
    paintBook();
  } catch (err) {
    onAir = had;
    $('panelHint').textContent =
      `Still on air: ${err.message}. Press Clear again.`;
  }
};

void loadProfiles();
paintOnAir();

// ---- house audio ------------------------------------------------------------
//
// The room's PA, from the desk. Nothing here makes a sound: the house player
// page on the music machine does, and this sends it instructions. That split
// is what keeps the music on the house bus and only the house bus (docs/06).
//
// Every control is one press, because the moment this gets used is the moment
// an announcer has started talking over a song.
let audioSnap = null;

async function audio(action, body) {
  try {
    const res = await fetch(`/api/audio/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    paintAudio(json);
  } catch (err) {
    $('audioHint').textContent = err.message;
    $('audioHint').setAttribute('data-warn', '');
  }
}

$('audPlay').onclick = () => audio('play');
$('audPause').onclick = () => audio('pause');
$('audNext').onclick = () => audio('next');
$('audPrev').onclick = () => audio('previous');
$('audConsole').onclick = () => audio('source', { source: 'console', reason: 'Game audio, from the desk' });
// Proving the music machine answers, before doors rather than during a match.
$('audWake').onclick = () => audio('wake');
$('audDuck').onclick = () => audio('duck', { on: !(audioSnap?.music?.ducked) });
$('audVol').oninput = () => { $('audVolText').textContent = $('audVol').value; };
$('audVol').onchange = () => audio('volume', { percent: Number($('audVol').value) });
$('audPlaylist').onchange = () => {
  if ($('audPlaylist').value) audio('playlist', { uri: $('audPlaylist').value });
};

function paintAudio(s) {
  if (!s) return;
  audioSnap = s;

  const clip = s.clip;
  const now = s.music?.now;
  $('audioTitle').textContent = clip ? clip.label : (now?.title ?? 'Nothing playing');
  $('audioSub').textContent = clip
    ? (clip.team !== null ? `walk-up for ${clip.team}` : 'stinger')
    : (now?.artist || s.reason || 'house bus only, never the stream');

  const label = { playlist: 'Playlist', clip: 'Walk-up', console: 'Game audio', silent: 'Silent' };
  $('audioSrc').textContent = label[s.source] ?? s.source;
  const dev = s.music?.device;
  $('audioWho').textContent = dev ? `· ${dev}` : '·';
  $('audioSrc').dataset.s = s.source;
  $('audDuck').classList.toggle('btn--go', !!s.music?.ducked);

  // Do not fight the operator's thumb: a poll landing mid-drag would snap the
  // slider back to the value the server last heard about.
  if (document.activeElement !== $('audVol')) {
    $('audVol').value = String(s.music?.volume ?? 70);
    $('audVolText').textContent = String(s.music?.volume ?? 70);
  }

  const sel = $('audPlaylist');
  const lists = s.music?.playlists ?? [];
  if (sel.options.length - 1 !== lists.length) {
    sel.replaceChildren(new Option('Playlist...', ''),
      ...lists.map(p => new Option(p.name, p.uri)));
  }

  // One button per clip. Team walk-ups first, which is the order an alliance
  // introduction runs in.
  const clips = s.clips ?? [];
  const box = $('audClips');
  if (box.dataset.n !== String(clips.length)) {
    box.dataset.n = String(clips.length);
    box.replaceChildren(...clips.map(c => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      if (c.team !== null) {
        const b = document.createElement('b');
        b.textContent = String(c.team);
        btn.append(b);
      }
      btn.append(document.createTextNode(c.label || (c.team === null ? c.id : 'walk-up')));
      btn.onclick = () => audio('clip', { id: c.id });
      return btn;
    }));
    if (!clips.length) {
      box.textContent = '';
      const none = document.createElement('span');
      none.className = 'hint';
      none.textContent = 'No clips loaded yet.';
      box.append(none);
    }
  }

  // Two things worth interrupting the operator for, in priority order.
  const players = s.players ?? { alive: 0, armed: 0 };
  if (players.armed !== 1) $('audioWho').textContent = `· ${players.armed} players armed`;

  let warn = '';
  if (s.music?.needsRelink) {
    // Terminal: the saved credential was refused, and no amount of retrying
    // fixes it. Spotify's refresh tokens expire six months after they were
    // minted whether or not they get used.
    warn = `${s.music.service} needs re-linking: run "npm run auth:spotify" on the desk ` +
      'machine and paste the new token into config.json. Clips still play.';
  } else if (players.armed === 0) {
    warn = 'No house player is armed. Open /s/house on the music machine and press the ' +
      'button once, or nothing will make a sound.';
  } else if (players.armed > 1) {
    warn = `${players.armed} house players are armed. If one of them is the machine OBS ` +
      'captures, the music is going to the stream. Close the other one.';
  } else if (s.music?.configured && s.music.linked && !s.music.reachable) {
    warn = 'The music service is not answering, so the playlist cannot be changed. ' +
      'Clips still play. ' + (s.music.error ?? '');
  }
  if (warn) { $('audioHint').textContent = warn; $('audioHint').setAttribute('data-warn', ''); }
  else {
    $('audioHint').removeAttribute('data-warn');
    $('audioHint').innerHTML = 'The player runs on the music machine at <b>/s/house</b>. ' +
      'Walk-up files go in <b>media/audio/walkups</b>, named for the team.';
  }
}

desk.on('audio.updated', ev => paintAudio(ev.payload));
fetch('/api/audio').then(r => r.ok ? r.json() : null).then(s => s && paintAudio(s)).catch(() => {});

// ---- coverage ---------------------------------------------------------------
// The one question nothing else in the pipeline answers: is the set of matches
// that were PLAYED the same set as the videos that EXIST. Polled slowly, and
// on demand, because it is a reconciliation rather than a live reading.
async function loadCoverage() {
  try {
    const res = await fetch('/api/coverage');
    if (!res.ok) return;
    const r = await res.json();
    const sum = $('covSum');
    sum.textContent = `· ${r.uploaded}/${r.played} matches published`;
    sum.toggleAttribute('data-bad', r.gaps.length > 0);

    const box = $('covGaps');
    if (!r.gaps.length) {
      box.innerHTML = r.played
        ? '<div class="ok">Every match played has a video. Nothing missing.</div>'
        : '<div class="hint">No matches played yet.</div>';
      return;
    }
    box.replaceChildren(...r.gaps.map(g => {
      const row = document.createElement('div');
      row.className = 'gap';
      const name = document.createElement('b');
      name.textContent = g.name;
      const detail = document.createElement('span');
      detail.textContent = g.detail;
      row.append(name, detail);
      return row;
    }));
  } catch { /* transient */ }
}
$('covCheck').onclick = loadCoverage;
void loadCoverage();
// Slow poll: a reconciliation that changes only when a match ends or an upload
// finishes does not need to be live, and this walks the whole queue.
setInterval(() => { if (!document.hidden) void loadCoverage(); }, 60_000);

// ---- vitals -----------------------------------------------------------------
// One health report across every subsystem. Polled slowly on purpose: several
// checks talk to OBS, and a panel that hammers the switcher every second is
// itself a production risk.
async function loadVitals() {
  try {
    const res = await fetch('/api/vitals');
    if (!res.ok) return;
    const r = await res.json();
    $('vitalsDot').dataset.l = r.worst;

    $('vitals').replaceChildren(...r.checks.map(c => {
      const row = document.createElement('div');
      row.className = 'v';
      row.dataset.l = c.level;
      const dot = document.createElement('i');
      const label = document.createElement('b');
      label.textContent = c.label;
      const detail = document.createElement('span');
      detail.textContent = c.detail;
      row.append(dot, label, detail);
      if (c.fix) {
        const fix = document.createElement('span');
        fix.className = 'fix';
        fix.textContent = c.fix;
        row.append(fix);
      }
      return row;
    }));
  } catch { /* transient */ }
}

$('vitalsCheck').onclick = loadVitals;
$('vitalsPrint').onclick = () => window.print();
void loadVitals();
setInterval(() => { if (!document.hidden) void loadVitals(); }, 30_000);

// ---- cameras ----------------------------------------------------------------
// At the floor of the crew range the desk manager is also the switcher, so the
// camera cut lives here rather than in another application. The live scene is
// read off the desk state, which every console shares, so a dedicated switcher
// on their own screen and the desk manager see the same thing.
const SCENE_LABEL = {
  intro: 'Intro', match: 'Field wide', score: 'Score',
  replay: 'Replay', desk: 'Desk', arcade: 'Arcade',
};
let sceneMap = null;

async function loadScenes() {
  try {
    const res = await fetch('/api/scenes');
    if (!res.ok) return;
    const { scenes, obs } = await res.json();
    sceneMap = scenes;
    $('sceneNote').textContent = obs ? '· OBS connected' : '· OBS not connected';
    $('sceneNote').toggleAttribute('data-warn', !obs);
    if (!scenes) { $('sceneRow').textContent = 'Show automation is off.'; return; }

    $('sceneRow').replaceChildren(...Object.entries(scenes).map(([key, name]) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = SCENE_LABEL[key] ?? key;
      btn.dataset.scene = name;
      btn.onclick = async () => {
        try {
          const r = await fetch('/api/scene', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scene: name }),
          });
          const body = await r.json();
          if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
          // A 200 with obs:false means the desk recorded the cut and OBS
          // never saw it. The button would light up "live" off bus state
          // while the broadcast stayed on the field wide, with nothing on
          // this panel saying why. The note is also refreshed from the same
          // answer, because it was fetched once at page load and never again.
          $('sceneNote').textContent = body.obs
            ? '· OBS connected'
            : '· OBS is not connected, so nothing was cut';
          $('sceneNote').toggleAttribute('data-warn', !body.obs);
        } catch (err) {
          $('sceneNote').textContent = '· ' + err.message;
          $('sceneNote').setAttribute('data-warn', '');
        }
      };
      return btn;
    }));
    paintScene(desk.state);
  } catch { /* transient */ }
}

function paintScene(state) {
  const live = state?.scene ?? null;
  for (const btn of document.querySelectorAll('#sceneRow .btn')) {
    btn.dataset.live = String(btn.dataset.scene === live);
  }
}

desk.on('state', paintScene);
void loadScenes();

// ---- safety message ---------------------------------------------------------
// Every screen at once, latched until cleared. Deliberately separate from the
// status card: that explains a delay and retires itself, this does neither.
/**
 * A failure here is sticky, and that is the whole point.
 *
 * The state subscriber below repaints emergState on EVERY bus event, which
 * during a match is several a second. An error written straight into that
 * element survived about one frame: the operator pressed "Put on every
 * screen" during a desk restart, the POST failed, the message flashed, the
 * next score tick wiped it, and they walked away believing an evacuation
 * notice was on every screen when nothing was.
 *
 * So a failure latches here and the repaint leaves it alone until the next
 * attempt clears it.
 */
let emergError = '';

function emergPaint(state) {
  const e = state?.emergency ?? null;
  $('emergSection').toggleAttribute('data-live', !!e);
  $('emergState').toggleAttribute('data-live', !!e);
  $('emergState').toggleAttribute('data-failed', !!emergError);
  $('emergState').textContent = emergError || (e
    ? `LIVE on every screen since ${new Date(e.raisedAt).toLocaleTimeString()}. Clear it when the room is back to normal.`
    : '');
}

async function emergency(body) {
  emergError = '';
  // Which way this request was going, because the honest failure message is
  // the opposite in each direction. A failed RAISE means nothing reached the
  // screens. A failed CLEAR means the safety message is STILL UP, and telling
  // the operator "nothing is on the screens" there sends them away from a
  // live evacuation notice believing they had already taken it down.
  const clearing = body.clear === true;
  try {
    const res = await fetch('/api/emergency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  } catch (err) {
    emergError = clearing
      ? `NOT CLEARED: ${err.message}. The message is STILL ON every screen. Try again.`
      : `NOT SENT: ${err.message}. Nothing is on the screens. Try again.`;
  }
  emergPaint(desk.state);
}

$('emergRaise').onclick = () => {
  const message = $('emergMsgIn').value.trim();
  if (!message) {
    emergError = 'Type what the room needs to do.';
    emergPaint(desk.state);
    return;
  }
  void emergency({
    kind: $('emergKindSel').value,
    message,
    detail: $('emergDetailIn').value.trim(),
  });
};
$('emergClear').onclick = () => void emergency({ clear: true });

// The console itself changes appearance while one is live, because the person
// who raised it may have walked away and somebody else is now looking at this
// screen wondering why the overlay is covered.
desk.on('state', emergPaint);

// ---- the card call ----------------------------------------------------------
// The screen the announcer talks over between the buzzer and the score. The
// team list is the six on the field, because a card is always for somebody who
// just played, and typing a team number under time pressure is how the wrong
// number ends up 200px tall on a projector.
function paintCardTeams(state) {
  const sel = $('ccTeamSel');
  const roster = [
    ...(state?.match?.red ?? []).map(t => ({ ...t, alliance: 'red' })),
    ...(state?.match?.blue ?? []).map(t => ({ ...t, alliance: 'blue' })),
  ];
  const key = roster.map(t => t.number).join(',');
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.replaceChildren(...roster.map(t => {
    const o = new Option(`${t.number} ${t.name ?? ''}`.trim(), String(t.number));
    o.dataset.alliance = t.alliance;
    return o;
  }));
}

$('ccShow').onclick = async () => {
  const opt = $('ccTeamSel').selectedOptions[0];
  if (!opt) return;
  try {
    const res = await fetch('/api/cardcall', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: Number(opt.value),
        color: $('ccColor').value,
        alliance: opt.dataset.alliance,
        reason: $('ccReasonIn').value.trim(),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    $('ccReasonIn').value = '';
    $('ccHint').textContent = 'Card is up. Clear it before the score reveal.';
  } catch (err) {
    // The error goes in the HINT, not in the reason input. It used to
    // overwrite what the operator had typed, so the obvious response to a
    // transient failure (press the button again) put "HTTP 500" on the
    // program under a 200px team number as the reason for the card.
    $('ccHint').textContent = err.message;
  }
};

$('ccClear').onclick = async () => {
  // Not swallowed. A failed clear used to report nothing at all, which leaves
  // a red card latched over the score reveal while the operator, having
  // pressed Clear, has already moved on to the next match.
  try {
    const res = await fetch('/api/cardcall', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('ccHint').textContent = 'Cleared.';
  } catch (err) {
    $('ccHint').textContent = `The card is still up: ${err.message}. Press Clear again.`;
  }
};

desk.on('state', paintCardTeams);

// ---- awards -----------------------------------------------------------------
// The winner is typed HERE and held by the server until Reveal: it must never
// ride the open state feed while the GA is still building the moment.
let awardSnap = null;
let awardPicked = null;

async function loadAwards() {
  try {
    const res = await fetch('/api/awards');
    if (!res.ok) return;
    awardSnap = await res.json();
    paintAwards();
  } catch { /* transient */ }
}

function paintAwards() {
  const box = $('awList');
  const list = awardSnap?.list ?? [];
  if (!list.length) {
    box.innerHTML = '<p class="hint" style="padding:8px">No awards in config.json. ' +
      'Type a custom title below and it works the same.</p>';
    return;
  }
  box.replaceChildren(...list.map(a => {
    const label = document.createElement('label');
    const tick = document.createElement('input');
    tick.type = 'radio';
    tick.name = 'awardPick';
    tick.checked = awardPicked === a.id;
    tick.onchange = () => { awardPicked = a.id; };
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = a.title;
    who.append(name);
    const sub = document.createElement('span');
    sub.textContent = a.presented
      ? ` · presented: ${a.presented.winner}`
      : (awardSnap.live === a.id ? ' · ON SCREEN' : '');
    who.append(sub);
    label.append(tick, who);
    return label;
  }));
}

$('awShow').onclick = async () => {
  const custom = $('awCustomTitle').value.trim();
  const body = {
    action: 'show',
    ...(custom ? { title: custom, description: $('awCustomDesc').value.trim() }
      : { id: awardPicked }),
    winner: $('awWinnerIn').value.trim(),
    team: Number($('awTeamIn').value) || undefined,
  };
  if (!custom && !awardPicked) {
    $('awHint').textContent = 'Pick an award from the list, or type a custom title.';
    return;
  }
  try {
    const res = await fetch('/api/awards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    $('awHint').textContent = $('awWinnerIn').value.trim()
      ? 'On screen. The winner is loaded and hidden: press Reveal on the GA\'s cue.'
      : 'On screen. Type the winner, then press Reveal.';
    await loadAwards();
  } catch (err) {
    $('awHint').textContent = err.message;
  }
};

$('awReveal').onclick = async () => {
  try {
    const res = await fetch('/api/awards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reveal',
        winner: $('awWinnerIn').value.trim() || undefined,
        team: Number($('awTeamIn').value) || undefined,
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    $('awHint').textContent = 'Revealed.';
    $('awWinnerIn').value = ''; $('awTeamIn').value = '';
    await loadAwards();
  } catch (err) {
    $('awHint').textContent = err.message;
  }
};

$('awClear').onclick = async () => {
  try {
    const res = await fetch('/api/awards', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('awHint').textContent = 'Cleared.';
    await loadAwards();
  } catch (err) {
    $('awHint').textContent = `Still up: ${err.message}. Press Clear again.`;
  }
};

void loadAwards();

// ---- slides & shout-outs ----------------------------------------------------
async function slideAction(body, okText) {
  try {
    const res = await fetch('/api/slides', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    if (okText) $('slHint').textContent = okText;
    await loadSlideDeck();
    return out;
  } catch (err) {
    $('slHint').textContent = err.message;
    return null;
  }
}

async function loadSlideDeck() {
  try {
    const [deckRes, queueRes] = await Promise.all([
      fetch('/api/slides'), fetch('/api/slides/queue'),
    ]);
    if (deckRes.ok) paintSlideDeck(await deckRes.json());
    if (queueRes.ok) paintGpQueue((await queueRes.json()).queue ?? []);
  } catch { /* transient */ }
}

function paintSlideDeck({ deck = [], live = null }) {
  const box = $('slList');
  if (!deck.length) {
    box.innerHTML = '<p class="hint" style="padding:8px">No slides yet. Add one below, ' +
      'or put them in config.json before the event.</p>';
    return;
  }
  box.replaceChildren(...deck.map(sl => {
    const row = document.createElement('label');
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = sl.title;
    who.append(name);
    const sub = document.createElement('span');
    sub.textContent = ` · ${sl.kind}${sl.id === live ? ' · ON SCREEN' : ''}`;
    who.append(sub);
    const show = document.createElement('button');
    show.className = 'btn';
    show.textContent = 'Show';
    show.onclick = e => {
      e.preventDefault();
      void slideAction({ action: 'show', id: sl.id }, 'On program.');
    };
    const kill = document.createElement('button');
    kill.className = 'btn kill';
    kill.textContent = 'Remove';
    kill.onclick = e => {
      e.preventDefault();
      void slideAction({ action: 'remove', id: sl.id }, 'Removed.');
    };
    row.append(who, show, kill);
    return row;
  }));
}

function paintGpQueue(queue) {
  const box = $('gpQueue');
  if (!queue.length) {
    box.innerHTML = '<p class="hint" style="padding:8px">Nothing waiting.</p>';
    return;
  }
  box.replaceChildren(...queue.map(q => {
    const row = document.createElement('label');
    const who = document.createElement('span');
    who.className = 'who';
    const msg = document.createElement('span');
    msg.textContent = `"${q.message}" `;
    const from = document.createElement('b');
    from.textContent = `— ${q.name}${q.team ? `, ${q.team}` : ''}`;
    who.append(msg, from);
    const ok = document.createElement('button');
    ok.className = 'btn';
    ok.textContent = 'Approve';
    ok.onclick = e => {
      e.preventDefault();
      void slideAction({ action: 'approve', id: q.id }, 'Approved into the deck.');
    };
    const no = document.createElement('button');
    no.className = 'btn kill';
    no.textContent = 'Reject';
    no.onclick = e => {
      e.preventDefault();
      void slideAction({ action: 'reject', id: q.id }, 'Rejected.');
    };
    row.append(who, ok, no);
    return row;
  }));
}

$('slAdd').onclick = async () => {
  const title = $('slTitleIn').value.trim();
  if (!title) { $('slHint').textContent = 'A slide needs a title.'; return; }
  const out = await slideAction({
    action: 'add',
    kind: $('slKindSel').value,
    title,
    lines: $('slLinesIn').value.split('|').map(l => l.trim()).filter(Boolean),
  }, 'Added to the deck.');
  if (out) { $('slTitleIn').value = ''; $('slLinesIn').value = ''; }
};

$('slNext').onclick = () => void slideAction({ action: 'next' }, 'Next slide on program.');
$('slHide').onclick = () => void slideAction({ action: 'hide' }, 'Taken down.');

void loadSlideDeck();
// The queue fills from the stands all day; the console should not need a
// reload to notice. Slow poll: moderation is a between-matches job.
setInterval(loadSlideDeck, 30_000);

// ---- the event timer --------------------------------------------------------
async function startTimer(label, seconds) {
  try {
    const res = await fetch('/api/timer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, seconds }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    $('tmHint').textContent = `${label || 'Countdown'} running on the side screens.`;
  } catch (err) {
    $('tmHint').textContent = err.message;
  }
}

$('tmSetup').onclick = () => void startTimer('Field setup', 120);
$('tmFive').onclick = () => void startTimer($('tmLabelIn').value.trim() || 'Countdown', 300);
$('tmStart').onclick = () => {
  const min = Number($('tmMinIn').value);
  if (!min || min <= 0) { $('tmHint').textContent = 'How many minutes?'; return; }
  void startTimer($('tmLabelIn').value.trim() || 'Countdown', Math.round(min * 60));
};
$('tmClear').onclick = async () => {
  try {
    const res = await fetch('/api/timer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $('tmHint').textContent = 'Cleared.';
  } catch (err) {
    $('tmHint').textContent = `Still running: ${err.message}. Press Clear again.`;
  }
};
