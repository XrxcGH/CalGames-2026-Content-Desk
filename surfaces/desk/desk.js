/**
 * Desk console. The P0 ship criterion: a producer, a switcher op and an
 * analyst can run a full match from here with every integration dead.
 *
 * Keyboard-first, because the producer is watching program, not their hands.
 */

import {
  connect, clockDisplay, clockDisplayFor, phaseFor, PHASE_LABEL, startTicker,
  SCENE_LABEL, SCREENS, SCREEN_LABEL,
} from '/shared/desk-client.js';
import { iconEl } from '/shared/icons.js';

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
  // Everything that rides the websocket goes DEAD while the link is down.
  // emit() silently drops on a closed socket, so an enabled button was a lie:
  // pressing End at the buzzer during a desk restart did nothing, and the
  // only clue was this dot. The stream section already models honest-disabled.
  for (const b of document.querySelectorAll(
    '[data-emit], [data-score], [data-screen-take], [data-status], .needs-link')) {
    b.disabled = !up;
  }
});

// ---- the sticky chrome -----------------------------------------------------
// Two strips stack above the page: the injected nav, which publishes its own
// measured height as --opnav-h, and this page's jump strip under it. A jump
// anchor has to clear BOTH. The stylesheet used to guess one flat number, so
// clicking Awards or Safety mid-show scrolled the section's heading in behind
// the strip the operator had just clicked: they arrive at a panel whose title
// they cannot see, at the one moment the strip exists for. Both strips wrap to
// a second row on a narrow window, so the height is a fact only the browser
// knows.
const jumpStrip = document.querySelector('.jump');
const setJumpHeight = () =>
  document.documentElement.style.setProperty('--jump-h', `${jumpStrip.offsetHeight}px`);
setJumpHeight();
addEventListener('resize', setJumpHeight);
// Webfonts land after the first paint and can rewrap the strip on their own,
// with no resize event to go with it.
if (typeof ResizeObserver === 'function') new ResizeObserver(setJumpHeight).observe(jumpStrip);

// ---- Simple and Everything -------------------------------------------------
// A first-time AV coordinator met twenty-five panels, could not find the few
// that put something on the projector, and gave up. Simple shows what a match
// day needs and Everything is the whole console, one click apart. The view
// lives on <html data-view>, set by the head script before the first paint,
// and the stylesheet does the hiding, so no panel flashes up and away on a
// reload. This block switches it, remembers the choice for this browser, and
// keeps the jump strip and the folds honest about what is on the page (those
// two catch up as this module loads). Nothing here stops a panel working: a
// hidden panel's key still fires and its polls keep running.
const page = document.documentElement;
const VIEW_KEY = 'desk.view';
const OBS_SHOWN_KEY = 'desk.obsShown';
/** Folds that Simple opened, so going back to Everything shuts them again. */
const simpleOpened = new Set();

/**
 * Open a fold for a reason of its own (the field dropped, a check failed, a
 * jump). It is then the operator's open fold, which leaving Simple must not
 * shut on them.
 */
function openFold(fold) {
  simpleOpened.delete(fold);
  fold.open = true;
}

/**
 * Left off the page by the view or the OBS fold, as opposed to tucked inside
 * a closed fold, which a jump opens on the way. Read back from the stylesheet
 * rather than worked out again here, so the jump strip cannot disagree with
 * what the page actually shows.
 */
function offPage(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (getComputedStyle(n).display === 'none') return true;
  }
  return false;
}

function paintView() {
  const simple = page.dataset.view !== 'everything';
  for (const b of document.querySelectorAll('[data-view-pick]')) {
    b.setAttribute('aria-pressed', String(b.dataset.viewPick === (simple ? 'simple' : 'everything')));
  }
  // Simple reads as plain cards: a fold holding one of its panels opens and
  // its summary steps aside or stays as a plain heading (the stylesheet
  // decides which), so the doors check, Load a match and the sample data are
  // on the page rather than one more click away.
  for (const fold of document.querySelectorAll('details.group')) {
    if (simple && fold.hasAttribute('data-simple')) {
      if (!fold.open) { fold.open = true; simpleOpened.add(fold); }
    } else if (simpleOpened.has(fold)) {
      fold.open = false;
      simpleOpened.delete(fold);
    }
  }
  // A jump to a panel that is not on the page scrolls to nothing, which reads
  // as a broken strip. Only the panels this view shows keep their link.
  for (const a of jumpStrip.querySelectorAll('a[href^="#"]')) {
    const target = document.getElementById(a.getAttribute('href').slice(1));
    a.hidden = !target || offPage(target);
  }
  const shown = page.hasAttribute('data-obs-shown');
  setText($('obsToggle'), shown ? 'Put the camera controls away' : 'Using OBS? Show the camera controls');
  $('obsToggle').setAttribute('aria-expanded', String(shown));
  setJumpHeight();
}

/**
 * Switch the view. `remember` is false for a switch the operator did not ask
 * for by name (a link to a panel Simple leaves out), so an old bookmark does
 * not quietly change what this browser opens to tomorrow.
 */
function pickView(view, remember = true) {
  page.dataset.view = view;
  if (remember) {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage blocked: this page only */ }
    // A ?view= in the address would win over the choice just made on the next
    // reload, so it goes once somebody has chosen.
    try {
      const url = new URL(location.href);
      if (url.searchParams.has('view')) {
        url.searchParams.delete('view');
        history.replaceState(history.state, '', url);
      }
    } catch { /* no history to tidy */ }
  }
  paintView();
}

for (const b of document.querySelectorAll('[data-view-pick]')) {
  b.onclick = () => pickView(b.dataset.viewPick);
}

// Simple holds its folds open, and the one heading it leaves showing, "Field
// down? Run matches by hand", is the words the front page's help tells a
// first-timer to look for. A click on it shut the fold like any other, and
// one press into that help took Load a match by hand and the sample data off
// the page, with nothing left to say how to get them back. In Everything the
// fold works as it always has.
for (const fold of document.querySelectorAll('details.group[data-simple]')) {
  const heading = [...fold.children].find(c => c.localName === 'summary');
  heading?.addEventListener('click', e => {
    if (page.dataset.view !== 'everything') e.preventDefault();
  });
}

/**
 * Whether this desk drives OBS at all, from the stream poll's `available`
 * (false only when OBS is not set up in config.json). Most venues no longer
 * run OBS: the picture is a browser full screen on a projector or a hardware
 * switcher, and a camera row that cuts nothing beside a stream panel that
 * cannot start only looks broken. With OBS set up, connected or not, nothing
 * changes: the panels stay where they were and say why they are dead.
 */
function paintObs(available) {
  const now = available ? 'on' : 'off';
  if (page.dataset.obs === now) return;
  page.dataset.obs = now;
  paintView();
  // The setup strip reads it too: a see-through page is OBS's only on a
  // desk with OBS. Later in the file, and only ever called from a poll.
  paintKit();
}

// "Using OBS?": for a desk whose OBS is about to be set up, or somebody who
// wants to see what the controls look like. Remembered like the view.
$('obsToggle').onclick = () => {
  const show = !page.hasAttribute('data-obs-shown');
  page.toggleAttribute('data-obs-shown', show);
  try {
    if (show) localStorage.setItem(OBS_SHOWN_KEY, '1');
    else localStorage.removeItem(OBS_SHOWN_KEY);
  } catch { /* storage blocked: this page only */ }
  paintView();
};

/*
 * The field-down kit follows the field, in Simple. data-field on <html> is
 * "down" while the field is not connected and "up" while it is, and the
 * stylesheet shows the kit's band in Simple only while it is down (Everything
 * always has it). Down is said at once: that is the moment somebody needs
 * Load a match by hand. Up waits until the field has stayed connected for
 * FIELD_SETTLE_MS and nobody is typing in the kit, because a field that
 * flaps would otherwise pull the band out from under a half-typed match, and
 * the operator may still be loading one in the seconds after it reconnects.
 * The first word after a reload needs no wait: nobody is typing yet.
 */
const FIELD_SETTLE_MS = 20_000;
let fieldUpSince = 0;
/** A link into the kit that arrived before the desk said where the field is. */
let arriveLater = null;

function setField(now) {
  if (page.dataset.field === now) return;
  page.dataset.field = now;
  paintView();
  const go = arriveLater;
  arriveLater = null;
  go?.();
}

function paintField(s) {
  if (!s) return;
  if (s.connected?.cheesy !== true) {
    fieldUpSince = 0;
    setField('down');
    return;
  }
  if (page.dataset.field !== 'down') {
    setField('up');
    return;
  }
  const t = Date.now();
  if (!fieldUpSince) fieldUpSince = t;
  if (t - fieldUpSince < FIELD_SETTLE_MS) return;
  if ($('fieldBand').contains(document.activeElement)) return;
  setField('up');
}

desk.on('state', paintField);

paintView();

// ---- live readout ----------------------------------------------------------
// Writes are guarded: setting textContent mutates the node even when the
// string is identical, and the Now readout's fields are aria-live, so
// unguarded writes made a screen reader re-announce the score several times a
// second all match. Same guard the audience pages already carry.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

desk.on('state', s => {
  setText($('nRed'), String(s.score.red.total));
  setText($('nBlue'), String(s.score.blue.total));
  paintScreenRow(s);
  setText($('nMatch'), s.match
    // Both, and only both when they differ, which is the state worth
    // noticing: an official total sitting over a typed-in breakdown.
    ? `${s.match.displayName} · screen: ${s.screen} · ${s.totalConfidence}`
      + (s.confidence === s.totalConfidence ? '' : ` (breakdown ${s.confidence})`)
    : 'No match loaded');
  setText($('nRedTeams'), (s.match?.red ?? []).map(t => t.number).join(' · ') || '-');
  setText($('nBlueTeams'), (s.match?.blue ?? []).map(t => t.number).join(' · ') || '-');
  paintLiveState(s);
});

/**
 * Re-sync the console to what is ALREADY live, so a reload tells the truth.
 *
 * The panel, the card call, the lower third, the status card and the timer
 * all live in server state, but the page used to render only what happened
 * while it was open: a console reloaded mid-show said "Nobody on air" under
 * four faces on the broadcast, and pressing Put on air then silently replaced
 * them with an empty panel. This paints the live facts into each section's
 * own hint line, where the operator is already looking.
 */
let fieldKitOpened = false;

function paintLiveState(s) {
  // The card call: emphasize Clear while one is latched, like Safety does.
  const cardUp = !!s.cardCall;
  $('ccClear').classList.toggle('btn--go', cardUp);
  if (cardUp && !$('ccHint').textContent) {
    setText($('ccHint'),
      `A ${s.cardCall.color} card for ${s.cardCall.team} is ON SCREEN. Clear it before the score.`);
  } else if (!cardUp && $('ccHint').textContent.includes('ON SCREEN')) {
    setText($('ccHint'), '');
  }

  // The delay card, which nothing else on this console reveals. status.show
  // does not move the program screen, so the Now readout still reads
  // "overview" while the card covers the feed, and a card the operator put up
  // waits for Hide card however long that takes: the field comes back, nobody
  // presses it, and "Field delay" sits over program and the venue TVs through
  // the next match. Clear gets the same emphasis the card call's does.
  const statusUp = !!s.status;
  $('statusClear').classList.toggle('btn--go', statusUp);
  setText($('statusHint'), statusUp
    ? `ON SCREEN over the main screen and the side screens: "${s.status.message}"`
      + (s.status.backAt
        ? `, back at about ${new Date(s.status.backAt).toLocaleTimeString()}` : '')
      + '. Press Hide card when the show starts again.'
    : '');

  // The telestrator. The section is four buttons and nothing that says
  // whether the analyst has a frame to draw on or whether the render is
  // hidden, which is the difference between "the ink is on air" and "the
  // analyst is drawing into a blank". Only these two lines get repainted, so
  // a refusal from Send this URL survives the next bus event the way
  // emergState's latched failure does.
  const tele = s.telestrator;
  const teleLine = $('teleHint').textContent;
  if (teleLine === '' || teleLine.startsWith('A frozen frame') || teleLine.startsWith('No frozen frame')) {
    setText($('teleHint'), (tele?.frame
      ? 'A frozen frame is loaded on the analyst\'s pad.'
      : 'No frozen frame yet: the pad stays blank until one is sent.')
      + (tele?.hidden
        ? ' The drawing is HIDDEN, so nothing the analyst draws is on air. Show again brings it back.'
        : ' The drawing is up on the broadcast.'));
  }

  /*
   * The panel: a reload, or a second console, must not claim an empty desk
   * under a full graphic.
   *
   * This wrote the truth into the hint and left the box above it still
   * reading "Nobody on air. Tick a name.", so the panel contradicted itself.
   * paintOnAir knows how to say it properly now; it just has to be told that
   * the state moved, because otherwise it only ever runs on a local action
   * and a second console never repaints at all.
   */
  const livePanel = (s.panel?.people ?? []).map(p => p.name).join(', ');
  if (!onAir.length && livePanel !== lastLivePanel) {
    lastLivePanel = livePanel;
    paintOnAir();
  }

  // The event timer's hint lives with the ticker below, not here: this
  // subscriber runs once per bus EVENT, and a countdown that only moves when
  // something else happens is frozen exactly when the timer is in use.

  // The lower third.
  if (s.lowerThird && !$('thirdHint').textContent) {
    setText($('thirdHint'), `On air: "${s.lowerThird.line1}". Y hides it.`);
  } else if (!s.lowerThird && $('thirdHint').textContent.startsWith('On air:')) {
    setText($('thirdHint'), '');
  }

  // The field-down kit surfaces exactly when it becomes relevant: the
  // moment the bridge drops, the hand-scoring tools unfold on their own.
  // It never closes itself: the operator may still be typing a score in
  // the seconds after a flapping bridge reconnects.
  if (s.connected && s.connected.cheesy === false && !fieldKitOpened) {
    fieldKitOpened = true;
    openFold($('fieldDownKit'));
  }
  // Simple follows the field in its own band above the cards (setField and
  // paintField, near the top), never inside the card flow: a card that came
  // and went with the field rebalanced every column under the operator the
  // moment it dropped.

  // The match beats: light the one the show is at, so the row teaches its own
  // order. Every button stays pressable: out-of-order is the recovery path.
  const beat = s.matchStartedAt ? 'match.start'
    : s.scorePostedAt ? 'match.score_posted'
      : s.matchEndedAt ? 'match.end'
        : s.screen === 'match' ? 'match.armed'
          : s.match ? 'match.preview' : null;
  for (const b of document.querySelectorAll('[data-emit]')) {
    b.classList.toggle('live-beat', b.dataset.emit === beat);
  }
}

/**
 * The event-timer hint counts down on the ticker, not on the state feed.
 *
 * It used to be computed in paintLiveState, which only runs per bus event,
 * and the timer's whole use case is a break, when the bus goes quiet for
 * minutes: the hint froze at the time left as of the last event ("4:37
 * left." for the entire break) while the side screens counted down
 * correctly. setText's diff keeps the aria-live announcement to the
 * once-a-second the string actually changes.
 *
 * It only ever repaints its own lines. A failure like "Still running: ..."
 * from a botched Clear survives a quiet bus today precisely because nothing
 * paints over it; a per-frame overwrite would erase it before the operator
 * ever saw it, which is the emergState bug all over again.
 */
function paintTimerHint() {
  const s = desk.state;
  if (!s) return;
  const showing = $('tmHint').textContent;
  const ours = showing === '' || showing === 'Cleared.'
    || showing.includes('RUNNING') || showing.includes('on the side screens');
  if (s.timer) {
    if (!ours) return;
    const left = Math.max(0, Math.ceil((s.timer.endsAt - desk.serverNow) / 1000));
    setText($('tmHint'),
      `${s.timer.label} is RUNNING on the side screens: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left.`);
  } else if (showing.includes('RUNNING')) {
    setText($('tmHint'), 'Cleared.');
  }
}

startTicker(() => {
  const c = desk.matchClock;
  setText($('nClock'), clockDisplayFor(desk.state, c));
  setText($('nPhase'), PHASE_LABEL[phaseFor(desk.state, c)] ?? '');
  paintTimerHint();
});

// ---- event log -------------------------------------------------------------
// Built with textContent, never innerHTML: type and source arrive over the WS
// from any client on the production LAN and must render as text, not markup.
function logLine(ev) {
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
}
// The live feed and the one-shot backfill race each other on a mid-show
// reload (the documented re-auth remedy, exactly when events fire several a
// second): a live event landing before /api/events/recent resolved got
// buried under 120 prepended history rows, and the events recorded between
// socket open and the response appeared twice. So live events are HELD until
// the backfill settles, then everything paints once, oldest first, deduped
// by the bus's own event id.
const logSeen = new Set();
let logHold = [];   // live events waiting on the backfill; null once merged

function logEvent(ev) {
  if (ev.id) {
    if (logSeen.has(ev.id)) return;
    logSeen.add(ev.id);
    // The dedupe only needs to cover deliveries still in flight around the
    // merge; an unbounded set on a console that runs all day is a slow leak.
    if (logSeen.size > 300) logSeen.delete(logSeen.values().next().value);
  }
  logLine(ev);
}

desk.on('desk', ev => { if (logHold) logHold.push(ev); else logEvent(ev); });

// Backfilled on load: the server keeps the last 200 events, and a console
// that reloads mid-show should still answer "what just happened", not open
// with an empty log.
fetch('/api/events/recent').then(r => (r.ok ? r.json() : []))
  .then(events => {
    // History first, then whatever arrived while the fetch was out. Held
    // events were all emitted at or after the response was built, so this
    // order is oldest to newest, the overlap collapses on id, and prepending
    // keeps the newest row on top where the operator reads it.
    for (const ev of [...(events ?? []), ...logHold].slice(-120)) logEvent(ev);
    logHold = null;
  })
  .catch(() => {
    // The live feed still fills the log; just stop holding it back.
    for (const ev of logHold ?? []) logEvent(ev);
    logHold = null;
  });

// ---- actions ---------------------------------------------------------------
const emit = (type, payload) => desk.emit({ type, payload });

for (const b of document.querySelectorAll('[data-emit]')) {
  b.onclick = () => emit(b.dataset.emit);
}
for (const b of document.querySelectorAll('[data-score]')) {
  b.onclick = () => score(b.dataset.score);
}

// Manual screen take: one button per screen, lit from live state.
//
// Built from the control map's Screen group rather than a hand-kept list, so
// this row, the Stream Deck, and the remote cannot drift apart: the old
// dropdown was missing `sponsor` entirely, and a hardware button could take a
// screen the main console could not. The fallback list only exists for the
// seconds before the map loads.
// Order and names shared with the nav strip and the remote: the strip above
// this row must never teach different words than the row itself.
const SCREEN_FALLBACK = SCREENS.filter(s => s.id !== 'cardcall').map(s => s.id);
const SCREEN_WORDS = SCREEN_LABEL;
let screenIds = SCREEN_FALLBACK;

function buildScreenRow() {
  const row = $('screenRow');
  row.replaceChildren(...screenIds.map(id => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.dataset.screenTake = id;
    b.textContent = SCREEN_WORDS[id] ?? id;
    if (id === 'auto') {
      b.title = 'Release the hold: the screen follows the match again.';
      b.style.marginLeft = 'auto';
    }
    b.onclick = () => emit('screen.change', { screen: id });
    return b;
  }));
}

function paintScreenRow(s) {
  let listed = false;
  for (const b of $('screenRow').querySelectorAll('[data-screen-take]')) {
    const id = b.dataset.screenTake;
    const on = id === 'auto' ? s.screenHold === false : id === s.screen;
    if (id === s.screen) listed = true;
    b.classList.toggle('live', on && id !== 'auto');
    b.classList.toggle('live-beat', on && id === 'auto');
    b.setAttribute('aria-pressed', String(on));
  }
  // A runtime screen the row has no button for (card call mid-reveal, a
  // slide) still gets NAMED, so the row never asserts the wrong thing the
  // way the dropdown did.
  let chip = $('screenRow').querySelector('.showing');
  if (!listed && s.screen) {
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'hint showing';
      chip.style.alignSelf = 'center';
      $('screenRow').append(chip);
    }
    setText(chip, `showing: ${SCREEN_WORDS[s.screen] ?? s.screen}`);
  } else if (chip) {
    chip.remove();
  }
}

buildScreenRow();
fetch('/api/control-map').then(r => (r.ok ? r.json() : null)).then(map => {
  const ids = (map?.actions ?? [])
    .filter(a => a.id.startsWith('screen.'))
    .map(a => a.id.slice('screen.'.length));
  if (ids.length) { screenIds = ids; buildScreenRow(); if (desk.state) paintScreenRow(desk.state); }
}).catch(() => { /* the fallback row stands */ });

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
/*
 * How much room is left, counted where the operator is typing rather than
 * discovered on the program feed. The plate holds three lines of display type,
 * which is 90 characters even in capitals, and the reducer keeps the same 90.
 * Quiet until the last stretch: a counter that shouts from character one is a
 * counter nobody reads.
 */
$('statusCustom').addEventListener('input', () => {
  const left = 90 - $('statusCustom').value.length;
  $('statusLeft').textContent = left <= 30 ? `${left} left` : '';
});
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
$('thirdShow').onclick = () => showThird($('thirdPinned').checked);
$('thirdHide').onclick = () => emit('lower_third.hide');

const teamList = str => str.trim().split(/\s+/).filter(Boolean)
  .map(n => ({ number: Number(n), name: '' }));

$('loadMatch').onclick = () => {
  // The boxes are examples, not defaults, for the reason the lower third
  // already refuses its own: loading a match takes the program screen, so a
  // press on an untouched form painted an invented alliance overview, made of
  // real team numbers, onto program and every TV in the venue. This kit
  // unfolds itself the moment the field bridge drops, which is exactly when
  // somebody presses the one button in front of them to see what it does.
  const displayName = $('mName').value.trim();
  const red = teamList($('mRed').value);
  const blue = teamList($('mBlue').value);
  if (!displayName || !red.length || !blue.length) {
    setText($('loadHint'), 'Type the match name and both alliances. The grey text is an '
      + 'example, not a match: loading it would put those teams on every screen.');
    // Register it, or the refusal inherits the countdown an earlier load
    // started and can be wiped seconds after it appears: the operator looks
    // back at a filled-in box and a blank hint and believes the match loaded.
    noteLoadHint();
    return;
  }
  emit('match.loaded', { id: `m${Date.now()}`, displayName, red, blue });
  /*
   * What went out, in the numbers now on the overview.
   *
   * "and on the program screen" was said unconditionally, and it is not
   * unconditionally true: a manual screen take engages a hold, and the
   * reducer lets a hold sit over an automatic screen change. So loading a
   * match while holding the arcade screen loaded the match and moved nothing,
   * while this line said it was on program. The operator then explains an
   * overview to a room that is looking at something else.
   */
  const held = !!desk.state?.screenHold && desk.state.screen !== 'overview';
  const teams = `red ${red.map(t => t.number).join(' ')} against blue `
    + `${blue.map(t => t.number).join(' ')}`;
  /*
   * "Press Auto to bring it up" was wrong, which is worse than saying nothing.
   * `screen.change` with `auto` only clears the hold; the reducer's own
   * comment says "'auto' is not a screen: it hands control back and leaves
   * whatever is on air alone until the next lifecycle event moves it". The
   * next lifecycle event was match.loaded, and it has already fired, so
   * pressing Auto releases the hold, lights the Auto chip, and leaves the
   * arcade bumper on every screen in the venue while the operator starts
   * talking over an overview nobody can see. Press Pre-match.
   */
  setText($('loadHint'), held
    ? `${displayName} is loaded, ${teams}. It is NOT on the main screen: you are `
      + `holding ${SCREEN_LABEL[desk.state.screen] ?? desk.state.screen}. `
      + 'Press Pre-match to put the overview up.'
    : `${displayName} is loaded and on the main screen: ${teams}.`);
  noteLoadHint();
};

/*
 * When the load hint was written, so it can retire.
 *
 * It named a specific match and stood there until something else happened to
 * write this element: two matches later the console was still reporting the
 * first one as "loaded and on the program screen", which by then was a
 * sentence about nothing. Every path that writes #loadHint must call
 * noteLoadHint(), including the refusal: a message that did not start the
 * clock gets retired on somebody else's.
 */
let loadHintAt = 0;
const LOAD_HINT_MS = 45_000;
const noteLoadHint = () => { loadHintAt = Date.now(); };
setInterval(() => {
  if (loadHintAt && Date.now() - loadHintAt > LOAD_HINT_MS) {
    loadHintAt = 0;
    setText($('loadHint'), '');
  }
}, 5000);

/*
 * Sample data, for somebody testing the desk rather than running a show.
 *
 * Confirmed before it fires: it puts invented team numbers on every screen in
 * the building, and the one place that must never happen is the place where
 * the screens are pointed at an audience. The server refuses outright while
 * the field bridge is up, which is the real guard; this is the one that stops
 * an idle click.
 */
$('sampleGo').onclick = async () => {
  if (!confirm('Fill every screen with invented teams and scores? '
    + 'This is for testing a monitor or showing somebody the graphics. '
    + 'Do not do it during the show.')) return;
  $('sampleGo').disabled = true;
  setText($('sampleNote'), 'Seeding...');
  try {
    const res = await fetch('/api/sample', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setText($('sampleNote'), body.note ?? 'Done.');
  } catch (err) {
    setText($('sampleNote'), err.message);
  } finally {
    $('sampleGo').disabled = false;
  }
};

// Takes the sample back off without a restart. The first real match does
// the same by itself.
$('sampleClear').onclick = async () => {
  try {
    const res = await fetch('/api/sample/clear', { method: 'POST' });
    const body = await res.json();
    setText($('sampleNote'), body.note ?? (res.ok ? 'Cleared.' : `HTTP ${res.status}`));
  } catch (err) {
    setText($('sampleNote'), err.message);
  }
};

// ---- telestrator -----------------------------------------------------------
// The placeholder is a sample, not a default. It used to be the fallback, so
// sending a frame before typing anything put "Analysis - Priya Raman" on
// the broadcast, naming a person who is not in the building. The lower third
// fixed this same class already; this kept the old pattern. Empty is fine:
// the renderer draws a bare "Analysis" chip when there is no name.
const teleFrame = (frame) => emit('telestrator.frame', {
  analyst: $('analyst').value.trim(),
  frame,
});
// Hands the hint back to paintLiveState: it only repaints its own lines, so a
// refusal left in place would hide what the telestrator is actually doing
// from the press after it.
const showTeleState = () => setText($('teleHint'), '');
$('teleSend').onclick = () => {
  // An empty box is not "send nothing", it is "wipe the frame the analyst is
  // drawing on". The normal path is the replay console pushing a frame, so
  // this box is empty almost always: pressing Send frame to see what it did
  // dropped the pad to "No frozen frame" mid-segment, and this console said
  // nothing about it.
  const frame = $('frame').value.trim();
  if (!frame) {
    setText($('teleHint'), 'Paste an image URL in the box above first. Sending an empty box '
      + 'takes away the frame the analyst is drawing on.');
    return;
  }
  showTeleState();
  teleFrame(frame);
};
/*
 * Show again puts the render back after Hide, which is what its tooltip says
 * and what it now does. It used to re-send the whole frame event with
 * `analyst` read from the box on THIS console, which is empty almost always:
 * the normal path is the replay console pushing a frame, and the analyst's
 * name rides along with it. So the button whose label is "Show again" and
 * whose tooltip promises the frame and the ink are left alone wiped the name
 * off the on-air ANALYSIS chip. A name typed here still wins; blank means
 * "leave what is up", not "clear it".
 */
$('teleLive').onclick = () => {
  showTeleState();
  emit('telestrator.frame', {
    analyst: $('analyst').value.trim() || desk.state?.telestrator?.analyst || '',
    frame: desk.state?.telestrator?.frame ?? null,
  });
};
$('teleClear').onclick = () => { showTeleState(); emit('telestrator.clear'); };
$('teleHide').onclick = () => { showTeleState(); emit('telestrator.hide'); };

// ---- replay markers --------------------------------------------------------
$('mark').onclick = () => mark();

function mark() {
  // No record for a drop: emit() on a closed socket goes nowhere, and a
  // marker line painted anyway would tell the replay op a moment was saved
  // when it was not.
  if (!desk.connected) {
    $('linkText').textContent = 'reconnecting: the marker was NOT saved';
    return;
  }
  // Back-date by 2s: by the time a human presses the button, the moment has
  // already passed.
  const at = (desk.matchClock ?? 0) - 2;
  desk.emit({ type: 'replay.marker', payload: { kind: 'manual', matchClock: at } });
  const line = document.createElement('div');
  line.append(iconEl('flag'), ` manual · ${clockDisplay(at)} (${at.toFixed(1)}s)`);
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
  // One press, one action. A key held a moment too long (or one that sticks)
  // auto-repeats at about thirty a second: 5 held for a second posted the
  // score thirty times, each one a played match in the run of show, and 0
  // aborted over and over. The repeats are still swallowed above, so a held
  // Space does not scroll the console away either.
  if (e.repeat) return;
  // The buttons go honest-disabled while the socket is down; the shortcuts
  // must not keep lying on their behalf. emit() silently drops on a closed
  // socket, and the number row is the PRIMARY interface during a match, so a
  // shortcut pressed mid-restart says so out loud instead of doing nothing.
  if (!desk.connected) {
    $('linkText').textContent = 'reconnecting: that key press was NOT sent';
    return;
  }
  fn();
});

// ---- publish a segment -----------------------------------------------------
// Alliance selection and the ceremonies are the parts of the day teams ask for
// and nobody records. Nothing on the bus knows when a ceremony began, so the
// operator marks both ends by hand.
let segFrom = null;

/*
 * The start mark is kept on this machine, not only in a page variable. A
 * ceremony runs 20 to 40 minutes, and a desk restart in the middle of one
 * signs this page out: the only way back is a reload through /signin, which
 * used to drop the start mark with no way to enter it again, so the ceremony
 * could not be queued with its real start. Storage can throw (a private
 * window, blocked site data), and then the mark simply lives in the page as
 * it always did.
 */
const SEG_KEY = 'desk.segmentMark';
/** No ceremony runs this long; an older mark is one somebody abandoned. */
const SEG_MAX_AGE_MS = 6 * 3600_000;
const saveSegMark = () => {
  try {
    if (segFrom === null) localStorage.removeItem(SEG_KEY);
    else {
      localStorage.setItem(SEG_KEY, JSON.stringify({
        from: segFrom, kind: $('segKind').value, title: $('segTitle').value,
      }));
    }
  } catch { /* storage unavailable: the page variable still holds it */ }
};

// "Other..." reveals a title field: the API takes any unlisted string as a
// literal title, which is how a single award gets its own video.
const showSegOther = () => {
  const other = $('segKind').value === 'other';
  $('segOtherRow').style.display = other ? 'flex' : 'none';
  return other;
};
$('segKind').onchange = () => {
  if (showSegOther()) $('segTitle').focus();
  if (segFrom !== null) saveSegMark();
};
$('segTitle').addEventListener('input', () => { if (segFrom !== null) saveSegMark(); });

$('segStart').onclick = () => {
  segFrom = Date.now();
  saveSegMark();
  $('segQueue').disabled = false;
  $('segState').textContent = `Marking since ${new Date(segFrom).toLocaleTimeString()}.`;
};

// Back from a reload with a mark still running: say so, and let it be queued.
try {
  const kept = JSON.parse(localStorage.getItem(SEG_KEY) ?? 'null');
  const from = Number(kept?.from);
  if (Number.isFinite(from) && from > 0 && Date.now() - from < SEG_MAX_AGE_MS) {
    segFrom = from;
    if ([...$('segKind').options].some(o => o.value === kept.kind)) $('segKind').value = kept.kind;
    if (typeof kept.title === 'string') $('segTitle').value = kept.title;
    showSegOther();
    $('segQueue').disabled = false;
    $('segState').textContent = `Marking since ${new Date(segFrom).toLocaleTimeString()} `
      + '(kept through a reload of this page).';
  } else if (kept) {
    localStorage.removeItem(SEG_KEY);
  }
} catch { /* nothing kept, or storage unavailable */ }

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
    saveSegMark();
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
  // The one poll that says whether OBS is set up at all, which is what folds
  // the camera and stream panels away. A poll that did not answer says
  // nothing about OBS, so the page stays as it was.
  if (s) paintObs(!!s.available);
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
  else if (!s.available) {
    line = 'OBS is not set up on this desk. To run the stream from here, set "obs": '
      + '{ "enabled": true } in config.json and restart the desk (the OBS steps in docs/handbook-reference.md).';
  }
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
  // Same reason as paintOnAir: ticking a name rebuilds this whole list, so a
  // keyboard operator ticking three people lost the list twice.
  keepingFocus(list, 'book', () => list.replaceChildren(...book.map(p => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = onAir.includes(p.id);
    box.dataset.book = p.id;
    box.dataset.act = 'tick';
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
    // Two presses, because this deletes a real person's saved profile and it
    // sits one button-width from the Student toggle. The arm decays on its
    // own so an abandoned first press cannot linger as a trap.
    kill.onclick = async e => {
      e.preventDefault();
      if (kill.dataset.armed !== 'true') {
        kill.dataset.armed = 'true';
        kill.textContent = 'Forget?';
        kill.classList.add('btn--go');
        setTimeout(() => {
          kill.dataset.armed = '';
          kill.textContent = 'Forget';
          kill.classList.remove('btn--go');
        }, 3000);
        return;
      }
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
  })));
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

/**
 * Rebuild a list without throwing the keyboard out.
 *
 * replaceChildren destroys the focused node, so focus falls to <body> and the
 * next Tab restarts at the top of a twenty-section console. On the On camera
 * panel that happened on EVERY press: the move-left and move-right buttons
 * repaint the list they live in, so an operator ordering five people by
 * keyboard lost their place five times, on a console whose first line of copy
 * is "Keyboard-first". The cue list already solved this; this is that solution
 * with the identifying attributes passed in.
 *
 * Falls through to the same row's other control, then to anything enabled in
 * the box, because landing somewhere always beats landing nowhere.
 */
function keepingFocus(box, keyAttr, rebuild) {
  const active = document.activeElement;
  const held = active && box.contains(active) && active.dataset[keyAttr]
    ? { key: active.dataset[keyAttr], act: active.dataset.act }
    : null;
  rebuild();
  if (!held) return;
  const attr = keyAttr.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
  const esc = v => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const target =
    box.querySelector(`[data-${attr}="${esc(held.key)}"][data-act="${held.act}"]:not([disabled])`)
    ?? box.querySelector(`[data-${attr}="${esc(held.key)}"]:not([disabled])`)
    ?? box.querySelector('button:not([disabled]), input:not([disabled])');
  if (target) target.focus();
}

/** What another console has on air, so the repaint only runs when it moves. */
let lastLivePanel = null;

function paintOnAir() {
  const box = $('panelOnAir');
  if (!onAir.length) {
    /*
     * "Nobody on air" is only true of THIS console.
     *
     * `onAir` is page-local and never seeded from the desk, so a second
     * console opened mid-show starts empty while four analysts are live. The
     * box said nobody was on while the hint under it correctly listed them,
     * so the panel contradicted itself, and the first Put on air from the new
     * console replaced everyone who was up with whatever that operator had
     * ticked. A third volunteer arriving during an analysis segment is the
     * normal way this happens, not an edge case.
     */
    const live = desk.state?.panel?.people ?? [];
    if (live.length) {
      const names = live.map(p => p.name).filter(Boolean).join(', ');
      box.innerHTML = '<div class="empty"></div>';
      box.firstChild.textContent = `On air now, put up from another console: ${names}. `
        + 'Ticking names here and pressing Put on air replaces all of them.';
      $('panelHint').textContent = 'This console has nobody ticked. What you tick here '
        + 'REPLACES what is on air, it does not add to it.';
      return;
    }
    box.innerHTML = '<div class="empty">Nobody on air. Tick a name.</div>';
    $('panelHint').textContent = 'Tick a name to put them on. Six maximum.';
    return;
  }
  keepingFocus(box, 'seat', () => box.replaceChildren(...onAir.map((id, i) => {
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
    left.append(iconEl('chevron-left'));
    left.title = 'Move one seat left';
    left.setAttribute('aria-label', `Move ${p ? p.name : 'this person'} one seat left`);
    left.disabled = i === 0;
    left.dataset.seat = id; left.dataset.act = 'left';
    left.onclick = () => move(id, -1);

    const right = document.createElement('button');
    right.className = 'btn';
    right.append(iconEl('chevron-right'));
    right.title = 'Move one seat right';
    right.setAttribute('aria-label', `Move ${p ? p.name : 'this person'} one seat right`);
    right.disabled = i === onAir.length - 1;
    right.dataset.seat = id; right.dataset.act = 'right';
    right.onclick = () => move(id, 1);

    const off = document.createElement('button');
    off.className = 'btn';
    off.append(iconEl('x'));
    off.title = 'Take off air';
    off.setAttribute('aria-label', `Take ${p ? p.name : 'this person'} off air`);
    off.dataset.seat = id; off.dataset.act = 'off';
    off.onclick = () => toggle(id, false);

    row.append(n, who, left, right, off);
    return row;
  })));
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
      `Still on air: ${err.message}. Press Hide again.`;
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
let lastClipSig = '';

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

// One toggle, because the console has live state and a big source label to
// anchor it. The REMOTE keeps separate Music on / Music off buttons on
// purpose: a phone waking from sleep can hold stale state for the seconds
// before the socket recovers, and a panic press must be idempotent.
$('audToggle').onclick = () =>
  audio(audioSnap?.source === 'playlist' ? 'pause' : 'play');
$('audNext').onclick = () => audio('next');
$('audPrev').onclick = () => audio('previous');
$('audConsole').onclick = () => audio('source', { source: 'console', reason: 'Game audio, from the desk' });
// Proving the music machine answers, before doors rather than during a match.
// It wakes the music service's playback device, NOT the /s/house player page
// the hint names: a volunteer chasing a silent room read the old "Wake
// player" label as the page and pressed it instead of arming a player.
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
  // Both words say what the press will do to the room. "Duck" and "Unduck"
  // are audio-desk words: a first-timer with an announcer talking over a song
  // has no reading of either.
  const ducked = !!s.music?.ducked;
  $('audDuck').classList.toggle('btn--go', ducked);
  $('audDuck').setAttribute('aria-pressed', String(ducked));
  setText($('audDuck'), ducked ? 'Music back up' : 'Duck music');
  $('audDuck').title = ducked
    ? 'Puts the music back to its full volume.'
    : 'Drops the music under the announcer so the room can hear them.';
  setText($('audToggle'), s.source === 'playlist' ? 'Pause music' : 'Play music');
  $('audToggle').setAttribute('aria-pressed', String(s.source === 'playlist'));
  $('audToggle').title = s.music && s.music.configured === false
    ? 'No music service is set up, so this plays nothing. Walk-ups and stingers still play.'
    : 'Starts and stops the playlist on the house speakers. The stream never hears it.';

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
  // Rebuilt on a signature of ids, labels and teams, not the count: the
  // library rescans on every upload and ids derive from filenames, so
  // swapping one walk-up for a corrected file under a new name changes the
  // set without changing its size. A count guard kept every button's old
  // closure alive, and the press that mattered posted a clip id the server
  // no longer had.
  const clips = s.clips ?? [];
  const box = $('audClips');
  const clipSig = JSON.stringify(clips.map(c => [c.id, c.label, c.team]));
  if (clipSig !== lastClipSig) {
    lastClipSig = clipSig;
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
  } else if (s.music && s.music.configured === false) {
    // The exe has no way to set up the playlist service (it needs a Premium
    // account and a sign-in done off-site), and Play music then "worked": the
    // source flipped to Playlist and the room stayed silent, with nothing on
    // this console saying why.
    warn = 'No music service is set up, so Play music does nothing: only walk-ups and ' +
      'stingers play. Load them with Add a clip on the house player page (/s/house).';
  } else if (s.music?.configured && s.music.linked && !s.music.reachable) {
    warn = 'The music service is not answering, so the playlist cannot be changed. ' +
      'Clips still play. ' + (s.music.error ?? '');
  }
  /*
   * Through setText, and without re-parsing HTML.
   *
   * #audioHint is aria-live, and this runs on every audio.updated frame, which
   * is roughly every five seconds all day. The innerHTML assignment replaced
   * the region's children even when the sentence was identical, and a replaced
   * aria-live region is a changed one, so a screen-reader operator heard the
   * same static sentence about where walk-up files go, every five seconds,
   * for the length of the event. The warning branch had the same problem, and
   * a standing warning is exactly the one that must not be re-read forever.
   */
  if (warn) { setText($('audioHint'), warn); $('audioHint').setAttribute('data-warn', ''); }
  else {
    $('audioHint').removeAttribute('data-warn');
    setText($('audioHint'), 'The player runs on the music machine at /s/house. '
      + 'Walk-up files go in media/audio/walkups, named for the team.');
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

// ---- videos -----------------------------------------------------------------
/*
 * The desk ships in deferred mode, so every cut video parks in `held` waiting
 * for a go-ahead, and until now nothing on any surface could give one. The
 * routes all existed and nobody called them: the only way to start the day's
 * uploads was a hand-built authenticated POST, and the only way to clear a
 * failure was one more of those per item, with the ids read out of a JSON
 * blob at eleven at night. Realistically the weekend's videos never went up.
 *
 * Read-and-press, deliberately: no per-item controls beyond a retry. The two
 * things an operator actually needs at the end of a day are "send them all"
 * and "send the ones that broke again".
 */
const PUB_WORDS = {
  held: 'waiting for you',
  pending: 'queued',
  cut: 'clip made',
  uploaded: 'uploaded, linking',
  done: 'done',
  failed: 'failed',
};

async function loadPublish() {
  try {
    const res = await fetch('/api/publish');
    if (!res.ok) return;
    const r = await res.json();
    const items = r.items ?? [];
    const by = (state) => items.filter(i => i.state === state).length;
    const sum = $('pubSum');
    if (!r.available) {
      sum.textContent = '· publishing is off';
    } else {
      const done = by('done');
      const failed = by('failed');
      const waiting = by('held');
      sum.textContent = `· ${done}/${items.length} published`
        + (waiting ? `, ${waiting} waiting` : '')
        + (failed ? `, ${failed} failed` : '');
      sum.toggleAttribute('data-bad', failed > 0);
    }

    const box = $('pubList');
    if (!items.length) {
      box.innerHTML = '<div class="hint">Nothing cut yet.</div>';
      return;
    }
    // Newest first: at the end of a day the thing you are looking for is the
    // thing that just happened.
    box.replaceChildren(...items.slice().reverse().map(i => {
      const row = document.createElement('div');
      row.className = 'gap';
      const name = document.createElement('b');
      name.textContent = i.label + (i.supersededBy ? ' (replaced by a replay)' : '');
      const detail = document.createElement('span');
      detail.textContent = i.error
        ? `${PUB_WORDS[i.state] ?? i.state}: ${i.error}`
        : (PUB_WORDS[i.state] ?? i.state);
      row.append(name, detail);
      if (i.state === 'failed' || i.state === 'held') {
        const go = document.createElement('button');
        go.className = 'btn';
        go.textContent = i.state === 'held' ? 'Publish' : 'Retry';
        go.onclick = async () => {
          go.disabled = true;
          await fetch(`/api/publish/retry/${encodeURIComponent(i.id)}`, { method: 'POST' })
            .catch(() => {});
          loadPublish();
        };
        row.append(go);
      }
      return row;
    }));
  } catch { /* transient */ }
}

const pubPost = async (action, note) => {
  setText($('pubNote'), 'Working...');
  try {
    const res = await fetch(`/api/publish/${action}`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setText($('pubNote'), note(body));
  } catch (err) {
    setText($('pubNote'), err.message);
  }
  loadPublish();
};

$('pubRefresh').onclick = loadPublish;
$('pubRelease').onclick = () => {
  // Worth a confirm: on a slow venue uplink this competes with the stream,
  // and the whole reason for deferred mode is not to do it mid-playoffs.
  if (!confirm('Start uploading everything that is waiting? On a slow uplink '
    + 'this competes with the stream. Normally done after the last award.')) return;
  pubPost('release', b => `${b.released} video(s) released.`);
};
$('pubRetry').onclick = () => pubPost('retry-failed',
  b => b.retried ? `${b.retried} failed video(s) queued again.` : 'Nothing was failed.');
void loadCoverage();
void loadPublish();
// Slow poll: a reconciliation that changes only when a match ends or an upload
// finishes does not need to be live, and this walks the whole queue.
setInterval(() => {
  if (document.hidden) return;
  void loadCoverage();
  void loadPublish();
}, 60_000);

// ---- the setup strip: what this desk found ----------------------------------
/*
 * The kits change. NorCal stopped using OBS and rebuilt its AV rack around an
 * ATEM switcher, and the first anyone heard of it was a coordinator testing
 * the exe on the field, stuck, with a 43-page handbook as the only way to
 * find out why. So the console says, at the top of both views, what it found
 * and what is on air: the field, the switcher, the graphics screens, and the
 * access codes while they still need changing. Every problem is one line
 * that names the computer and says what to do on it.
 *
 * It only reads. Every request here is a plain GET of something the desk
 * already knows (the switcher watcher is read-only by construction), so the
 * strip cannot change the show, and an answer it does not get leaves its row
 * off the page: an older desk has no /api/atem or /api/screens at all, and a
 * row that guessed would be the one people trust.
 */
const kit = {
  /** The switcher watcher's status, or null when this desk answers none. */
  atem: null,
  /** The switcher input the desk's graphics come in on, when the answer says. */
  graphicsInput: null,
  /** The graphics screens that have said hello, or null when the desk cannot say. */
  screens: null,
  /** Since when the screens have listed no main screen (this page's clock). */
  noScreensSince: Date.now(),
  /** The doors check's rows, from loadVitals. */
  vitals: null,
  /** Where the field is expected, from /api/info, so a warning can name it. */
  fieldHost: null,
  /** This desk's address on the network, for the "open this address" fix. */
  base: null,
};
let kitBusy = false;

/** A GET's JSON. Null when the desk does not answer it; undefined when the request itself failed. */
async function kitGet(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** The switcher status out of an answer, whether it comes bare or as { atem }. */
function atemFrom(body) {
  const a = body && typeof body === 'object' && body.atem && typeof body.atem === 'object' ? body.atem : body;
  return a && typeof a === 'object' && typeof a.state === 'string' ? a : null;
}

const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * The computer a screen runs on, in words. The browser cannot learn a
 * computer's name, so it is the address the desk saw it at, or the desk
 * laptop itself when it is this machine.
 */
function computerAt(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/i, '').trim();
  if (!a) return 'a computer the desk cannot name';
  if (a === '::1' || a === 'localhost' || /^127\./.test(a)) return 'the desk laptop';
  return `the computer at ${a}`;
}

/** A switcher input by the name the crew gave it. */
function inputName(a, id) {
  if (!isNum(id)) return 'an input the switcher did not name';
  const i = (Array.isArray(a.inputs) ? a.inputs : []).find(x => x && x.id === id);
  return i?.longName || i?.shortName || `input ${id}`;
}

const KEY_WORD = { luma: 'luma key', chroma: 'chroma key', pattern: 'pattern key', dve: 'DVE key' };

/** "DSK1" or "key 1 on M/E 1", as the panel says it. */
function keyerName(k) {
  return k.kind === 'downstream' ? `DSK${k.index}` : `key ${k.index} on M/E ${k.me ?? 1}`;
}

/**
 * The field row. Connected comes from the desk state, live. What "not
 * connected" means comes from the doors check's Field row: lost (the desk
 * has the field and it stopped answering), still looking (the desk searches
 * for it by itself), or not part of this setup. "Not looking" is read first:
 * it has the word "looking" in it too.
 */
function fieldRow() {
  const s = desk.state;
  const v = (kit.vitals ?? []).find(c => c?.id === 'field') ?? null;
  if (!s && !v) return null;
  const at = kit.fieldHost ? ` at ${kit.fieldHost}` : '';
  if (s?.connected?.cheesy === true) {
    return { l: 'ok', say: `connected to Cheesy Arena${at}. Matches load by themselves.` };
  }
  const byHand = 'Until then, run matches by hand below.';
  const said = String(v?.detail ?? '');
  if (v && v.level !== 'off' && v.level !== 'unknown') {
    return { l: 'warn', byHand: true,
      say: `not answering. The desk reconnects by itself. ${byHand}`,
      warn: `The desk laptop cannot reach the field${at}. Check the desk laptop's network cable `
        + 'to the field network, and ask the scorekeeper whether Cheesy Arena is running.' };
  }
  if (/not looking/i.test(said)) {
    return { l: 'off', byHand: true, say: 'not used on this setup: the desk was started without '
      + 'looking for it. Run matches by hand below.' };
  }
  if (/searching/i.test(said)) {
    return { l: 'wait', byHand: true,
      say: `not found yet. The desk keeps looking for it by itself. ${byHand}` };
  }
  if (/practice/i.test(said)) {
    return { l: 'off', byHand: true, say: 'not used in practice mode. Run matches by hand below.' };
  }
  if (/playing back/i.test(said)) {
    return { l: 'off', say: 'not used: this desk is playing back a saved day.' };
  }
  return { l: 'off', byHand: true, say: 'not connected. Run matches by hand below.' };
}

/**
 * The doors check's Switcher row, for a desk that answers no /api/atem: the
 * same facts in the doors check's words, every thirty seconds rather than
 * every five.
 */
function switcherFromCheck() {
  const v = (kit.vitals ?? []).find(c => c?.id === 'switcher');
  if (!v) return null;
  const l = ['ok', 'warn', 'fail', 'off'].includes(v.level) ? v.level : 'wait';
  return { l, say: String(v.detail ?? ''),
    warn: v.fix && (l === 'warn' || l === 'fail') ? `On the switcher: ${String(v.fix)}` : null };
}

/**
 * The switcher row, live. Its problems are the ones that spoil a stream
 * quietly, the same two the doors check names: two overlays keyed at once
 * (the desk's graphics and Cheesy Arena's come through the same input, so one
 * key is enough), and a match running with the graphics input keyed off. And
 * losing the switcher, which changes nothing on air: the desk only watches.
 */
function switcherRow() {
  const a = kit.atem;
  if (!a) return switcherFromCheck();
  const at = a.host ? ` at ${a.host}` : '';
  // The watcher's own words, when it has some, are the fix: it knows
  // whether nothing answered, the switcher turned the desk down (a copy of
  // ATEM Software Control holding the last slot), or it answered and is
  // slow, and each one sends somebody to a different place.
  const said = typeof a.error === 'string' && a.error.trim() ? a.error.trim() : null;
  // Its words name the switcher already, except an address typed wrong,
  // which needs saying where it was typed.
  const fix = said && /not a switcher address|names port/i.test(said)
    ? `The switcher address on the Event settings page: ${said}` : said;
  if (a.state === 'off' || a.state === 'searching') {
    // Searching with no answer is a kit with no switcher: gray. But a
    // switcher that turned the desk down, or an address typed wrong, is
    // somebody's to fix even while the desk searches. Named by what the
    // watcher says, so words it might say one day fall back to gray.
    if (said && /turned the desk down|not a switcher address|names port/i.test(said)) {
      // A typo leaves nothing to retry until somebody fixes it.
      return { l: 'warn', warn: fix, say: fix !== said
        ? 'not connected: the address typed for it is not a switcher address.'
        : 'not connected. The desk keeps trying by itself.' };
    }
    return a.state === 'off' ? { l: 'off', say: 'not used on this setup.' }
      : { l: 'off', say: 'none found: not used on this setup, or not on the network yet. '
        + 'The desk keeps looking by itself.' };
  }
  if (a.state === 'connecting') {
    // A typed address that does not answer is somebody's to fix; one the
    // desk found a moment ago is only a handshake under way.
    if (!said) return { l: 'wait', say: `found one${at}, connecting.` };
    return { l: 'warn',
      say: /^no answer/i.test(said) ? `not answering${at}. The desk keeps trying by itself.`
        : `not connected yet${at}. The desk keeps trying by itself.`,
      warn: fix };
  }
  if (a.state === 'lost') {
    return { l: 'warn',
      say: `lost${at}. The desk reconnects by itself, and the switcher keeps running without it.`,
      warn: `The desk laptop lost the switcher${at}. Check the switcher is on and the network cable `
        + 'between it and the desk laptop. Nothing on air changes: the desk only watches the switcher.' };
  }
  if (a.state !== 'connected') return null;
  const parts = [`${a.model || 'ATEM switcher'}${at}${a.videoMode?.label ? `, ${a.videoMode.label}` : ''}.`];
  if (isNum(a.program)) parts.push(`On air: ${inputName(a, a.program)}.`);
  const keyed = (Array.isArray(a.keyers) ? a.keyers : []).filter(k => k && k.onAir);
  parts.push(keyed.length
    ? `Overlay on air: ${keyed.map(k => `${keyerName(k)}, ${KEY_WORD[k.type] ?? 'key'} of `
      + `${inputName(a, k.fillSource)}`).join('; ')}.`
    : 'No overlay keyer is on air.');
  // A picture-in-picture box is an upstream DVE key, not an overlay.
  const overlays = keyed.filter(k => k.type !== 'dve');
  const gfx = isNum(kit.graphicsInput) ? kit.graphicsInput : null;
  let warn = null;
  if (overlays.length >= 2) {
    warn = `The switcher has ${overlays.length} overlays keyed on air at once, one over the other `
      + `(${overlays.map(keyerName).join(', ')}). On the switcher's panel, take all but one off air with `
      + "its ON AIR button: the desk's graphics and Cheesy Arena's overlay come through the same input, "
      + 'so one key is enough.';
  } else if (gfx !== null && desk.state?.matchStartedAt && !keyed.some(k => k.fillSource === gfx)) {
    warn = `A match is running and the graphics input (${inputName(a, gfx)}) is not keyed on air, so `
      + "the stream shows no score. On the switcher's panel, put the key that carries it on air (on "
      + 'this kit, DSK 1: press its ON AIR button).';
  }
  return { l: warn ? 'warn' : 'ok', say: parts.join(' '), warn };
}

/** How long a list with no main screen in it waits before it is a problem. */
const SCREENS_SETTLE_MS = 15_000;

/**
 * The graphics row: the main-screen pages that have said hello, how many are
 * full screen, and whose overlay they show (the desk's own, or Cheesy
 * Arena's when the desk has no field data). The checks are the doors check's
 * Screens row, said from the screens' own reports every few seconds: a page
 * in a window rather than full screen (the taskbar is keyed onto the
 * stream), the switcher's feed at another size or rate than the switcher
 * runs (the converter between them does not scale, so the input goes
 * blank), and the handoff to Cheesy Arena's overlay. A page framed by
 * /s/watch is a projector's and an OBS browser source lives in OBS: neither
 * is held to full screen or to the switcher's format.
 */
/**
 * A main-screen page, its variants included: the clean second-stream feed
 * connects as "program-clean" (?mode=clean), and a crew that keys that one
 * has the graphics on air. The server's isProgramPage (screens.ts) is the
 * same rule, so the strip and the doors check count the same pages.
 */
const isProgramPage = sc => !!sc && typeof sc.surface === 'string'
  && (sc.surface === 'program' || sc.surface.startsWith('program-'));

function graphicsRow() {
  if (!kit.screens) return null;
  const shows = kit.screens.filter(isProgramPage);
  if (!shows.length) {
    // Every page reconnects by itself after the desk restarts, a few
    // seconds apart, and "none open" in that window sends somebody to fix
    // nothing.
    if (Date.now() - kit.noScreensSince < SCREENS_SETTLE_MS) {
      return { l: 'wait', say: 'waiting for the screens to say where they are.' };
    }
    const where = kit.base ? `${kit.base}/s/program` : "this desk's address followed by /s/program";
    return { l: 'warn', say: 'not open on any screen yet.',
      warns: [`No computer has the graphics open. On the computer whose HDMI goes to the switcher, `
        + `open ${where} in Chrome or Edge, then press F11. For a projector or TV, open /s/watch on `
        + 'that computer instead.'] };
  }
  // A top-level page drawn see-through is an OBS browser source only on a
  // desk that has OBS. On a desk with none it is the page the AV table got
  // stuck on: a plain browser showing ?key=alpha, which it draws on white,
  // and the switcher keys that white over the whole stream. The page cannot
  // tell OBS from a plain browser by its hello alone, so the desk's own
  // word on OBS decides, and until the stream poll answers it stays "in OBS".
  const obsOff = page.dataset.obs === 'off';
  const seeThrough = sc => sc.key === 'alpha' && sc.embedded === false;
  const inObs = sc => seeThrough(sc) && !obsOff;
  const onWhite = sc => seeThrough(sc) && obsOff;
  const own = sc => sc.embedded === false && !inObs(sc);
  const shown = shows.filter(own);
  const full = shown.filter(sc => sc.full === true).length;
  const cheesy = shows.filter(sc => sc.showing === 'cheesy').length;
  const framed = shows.filter(sc => sc.embedded === true).length;
  const parts = [`on ${plural(shows.length, 'screen', 'screens')}`];
  if (shown.length) {
    parts.push(full === shown.length
      ? (shown.length === 1 && shows.length === 1 ? 'full screen' : `${full === 1 ? '1' : 'all'} full screen`)
      : `${full} of ${shown.length} full screen`);
  }
  if (framed) parts.push(`${framed} on a projector or TV`);
  if (shows.some(inObs)) parts.push(`${shows.filter(inObs).length} in OBS`);
  if (shows.some(onWhite)) parts.push(`${shows.filter(onWhite).length} on white`);
  parts.push(!cheesy ? "showing the desk's graphics"
    : cheesy === shows.length ? "showing Cheesy Arena's own overlay"
      : `${cheesy} showing Cheesy Arena's own overlay`);

  const warns = [];
  const mode = kit.atem?.state === 'connected' ? kit.atem.videoMode : null;
  const fmt = mode?.label || 'its own format';
  for (const sc of shows) {
    const who = computerAt(sc.addr);
    if (sc.showing === 'cheesy') {
      warns.push(`${capFirst(who)} is showing Cheesy Arena's own score overlay, because the desk has `
        + 'no field data right now. It switches back to the desk\'s graphics by itself a few seconds '
        + 'after the desk and the field are both answering.');
    }
    if (!own(sc)) continue;
    if (onWhite(sc)) {
      // One line, not this and "not full screen" too: its fix ends in F11.
      // "If it is not OBS": a desk can still have an OBS it does not drive.
      const there = kit.base ? `${kit.base}/s/program` : "this desk's address followed by /s/program";
      warns.push(`The graphics on ${who} are the see-through version made for OBS, so a plain browser `
        + 'shows them on white, and on the switcher that white covers the whole stream. If that '
        + `computer is not running OBS, open ${there} there instead, with nothing after it, then press F11.`);
      continue;
    }
    // The handoff to Cheesy Arena's own display is armed only when that
    // computer can reach it (program.js says 'bad' after 15 s of failing).
    // Nothing on the input shows it while the desk works, so it is said now,
    // not at the first desk hiccup. Only while the field is up: when it is
    // down, the Field row already says so.
    if (sc.key === 'luma' && sc.backup === 'bad' && desk.state?.connected?.cheesy === true) {
      warns.push(`${capFirst(who)} cannot reach Cheesy Arena's own score display, so if the desk stops, `
        + "that input keeps its last picture instead of showing the field's score. Plug that computer "
        + 'into the field network (the same switch as Cheesy Arena).');
    }
    if (sc.full === false) {
      warns.push(`The graphics on ${who} are not full screen. On that computer, click them and press F11.`);
    }
    if (!mode || sc.key !== 'luma') continue;
    const w = isNum(sc.sw) && isNum(sc.dpr) ? Math.round(sc.sw * sc.dpr) : null;
    const h = isNum(sc.sh) && isNum(sc.dpr) ? Math.round(sc.sh * sc.dpr) : null;
    if (w && h && isNum(mode.width) && isNum(mode.height) && mode.width > 0
      && (w !== mode.width || h !== mode.height)) {
      warns.push(`${capFirst(who)} sends ${w}x${h}, and the switcher runs ${fmt} `
        + `(${mode.width}x${mode.height}). If it feeds the switcher, set that display to `
        + `${mode.width}x${mode.height} in Windows: Settings, System, Display.`);
    }
    // An interlaced format's label is the field rate (1080i59.94 is 29.97
    // frames), and the computer feeding it runs at the field rate.
    const target = isNum(mode.fps) && mode.fps > 0
      ? (/\d+i/.test(String(mode.label ?? '')) ? mode.fps * 2 : mode.fps) : null;
    if (isNum(sc.hz) && target !== null && Math.abs(sc.hz - target) > 2) {
      warns.push(`${capFirst(who)} refreshes ${sc.hz} times a second, and the switcher runs `
        + `${fmt}. If it feeds the switcher, set that display to ${Math.round(target)} Hz `
        + 'in Windows: Settings, System, Display, Advanced display.');
    }
  }
  return { l: warns.length ? 'warn' : 'ok', say: `${parts.join(', ')}.`, warns };
}

/**
 * The access codes, only while the doors check's row is not green, with the
 * way to change them. Its words, not its fix: the fix is written for
 * somebody editing config.json, and Event settings now changes the codes.
 * No code is ever in the doors check's words, so none can reach this line.
 */
function codesRow() {
  // Only on the desk laptop, opened by a local name: which codes are still
  // the shipped ones is a hint to anybody reading over a shoulder at another
  // AV table computer (the shipped awards code opens the winners). The same
  // rule as the front page's Start here box, from this page's side: a page
  // at localhost is on the desk laptop. Keeping the row out of other
  // machines' doors check answers is the server's part; this keeps the strip
  // from headlining it there.
  const name = String(location.hostname ?? '').toLowerCase();
  if (name !== 'localhost' && name !== '127.0.0.1' && name !== '[::1]') return null;
  const v = (kit.vitals ?? []).find(c => c?.id === 'codes');
  if (!v || v.level === 'ok') return null;
  const detail = String(v.detail ?? '');
  const which = /default:\s*([^.]+)\./.exec(detail)?.[1];
  // Gray is the one empty PIN that is no open door (a desk answering only
  // on its own machine), and the row's own words say why.
  const say = v.level === 'off' ? detail
    : /PIN is empty/i.test(detail)
      ? 'the desk PIN is empty, so anyone who can reach this desk can run the show.'
      : which
        ? `still the shipped ${which}, which anyone with a copy of this software knows.`
        : detail;
  return { l: v.level === 'fail' ? 'fail' : v.level === 'off' ? 'off' : 'warn', say };
}

function paintKitRow(id, row) {
  const el = $(id);
  el.hidden = !row;
  if (!row) return;
  if (el.dataset.l !== row.l) el.dataset.l = row.l;
  setText($(`${id}Say`), row.say);
}

let kitWarnShown = '';
/**
 * Never throws: it runs on every desk event, beside the handlers that keep
 * the rest of the console true, and an answer shaped in a way nobody planned
 * for takes the strip off the page rather than anything else with it.
 */
function paintKit() {
  try {
    paintKitNow();
  } catch {
    $('kit').hidden = true;
  }
}

function paintKitNow() {
  const field = fieldRow();
  const switcher = switcherRow();
  const graphics = graphicsRow();
  const codes = codesRow();
  paintKitRow('kitField', field);
  $('kitFieldGo').hidden = !field?.byHand;
  paintKitRow('kitSwitcher', switcher);
  paintKitRow('kitGraphics', graphics);
  paintKitRow('kitCodes', codes);
  const warns = [
    ...(field?.warn ? [field.warn] : []),
    ...(switcher?.warn ? [switcher.warn] : []),
    ...(graphics?.warns ?? []),
  ];
  // Rebuilt only when the words change: the list is announced, and the strip
  // repaints every few seconds and on every desk event.
  const key = warns.join('\n');
  if (key !== kitWarnShown) {
    kitWarnShown = key;
    $('kitWarn').replaceChildren(...warns.map(w => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }));
  }
  $('kit').hidden = !field && !switcher && !graphics && !codes && !warns.length;
}

async function refreshKit() {
  if (kitBusy) return;
  kitBusy = true;
  try {
    const [atem, screens, info] = await Promise.all(
      [kitGet('/api/atem'), kitGet('/api/screens'), kitGet('/api/info')]);
    // A request that failed outright (the desk restarting) keeps the last
    // answer: the link indicator in the header already says the desk is
    // away, and a strip that blanked every row would read as a desk that
    // found nothing.
    if (atem !== undefined) {
      kit.atem = atemFrom(atem);
      const gfx = atem?.graphicsInput ?? kit.atem?.graphicsInput;
      kit.graphicsInput = isNum(gfx) ? gfx : null;
    }
    if (screens !== undefined) {
      kit.screens = Array.isArray(screens?.screens) ? screens.screens : null;
      const any = (kit.screens ?? []).some(isProgramPage);
      if (any) kit.noScreensSince = Infinity;
      else if (kit.noScreensSince === Infinity) kit.noScreensSince = Date.now();
    }
    if (info !== undefined) kit.fieldHost = typeof info?.field?.host === 'string' ? info.field.host : null;
  } finally {
    kitBusy = false;
  }
  paintKit();
  // The field-down kit's wait after a reconnect ends on this tick too, on a
  // desk whose state has gone quiet.
  paintField(desk.state);
}

desk.on('state', () => paintKit());
fetch('/api/urls').then(r => (r.ok ? r.json() : null)).then(u => {
  if (typeof u?.base === 'string') { kit.base = u.base; paintKit(); }
}).catch(() => { /* the fix then says it in words */ });
void refreshKit();
setInterval(() => { if (!document.hidden) void refreshKit(); }, 5000);
addEventListener('visibilitychange', () => { if (!document.hidden) void refreshKit(); });

// ---- vitals -----------------------------------------------------------------
// One health report across every subsystem. Polled slowly on purpose: several
// checks talk to OBS, and a panel that hammers the switcher every second is
// itself a production risk.
//
// Pass or fail as a WORD. A level only ever reached the page as the colour of
// a 10px dot, which is nothing at all to an operator who cannot tell the
// greens from the reds, and nothing at all on the printed sheet, whose whole
// job is to be carried around the venue before doors. vitals.ts never puts
// the level in the text either: "connected, not streaming" and "not
// answering" read the same in black ink.
const VITAL_WORD = { ok: 'OK', warn: 'WARNING', fail: 'FAILED', unknown: 'UNKNOWN', off: 'OFF' };
// The same verdict said in words, for the heading and the header mirror.
const VITAL_VERDICT = {
  ok: 'all good', warn: 'needs a look', fail: 'something is broken',
  unknown: 'cannot tell', off: 'nothing to check',
};
// The fold opens itself once, on the first failing check, the way the
// field-down kit does. It never closes itself: the operator may be reading a
// failure that has already cleared, and a panel that shuts while they read is
// worse than one they have to shut by hand.
let vitalsOpened = false;

/*
 * The check stopped answering, so say so where the verdict is.
 *
 * A failed fetch used to return quietly, which left the last verdict standing
 * in the page header, reading "doors check: all good" in green, for as long
 * as the desk stayed up. That readout exists precisely so nobody has to open
 * the fold to know the state of the building, and a stale green is worse than
 * no readout: it is the one that stops people looking.
 *
 * One missed poll is not news on a thirty-second timer, so the background
 * poll waits for a second consecutive failure. A press of Run the check is
 * somebody asking right now, and gets the answer right now.
 */
let vitalsMisses = 0;
let vitalsLastOk = 0;
function vitalsNotAnswering() {
  // Only once it is worth saying: "last answered 0 min ago" is noise, and on
  // a thirty-second poll it is what the first failure would always print.
  const mins = vitalsLastOk ? Math.floor((Date.now() - vitalsLastOk) / 60_000) : 0;
  const ago = mins >= 1 ? `, last answered ${mins} min ago` : '';
  $('vitalsDot').dataset.l = 'unknown';
  setText($('vitalsWord'), `not answering${ago}`);
  $('vitalsMirror').dataset.l = 'unknown';
  setText($('vitalsMirrorText'), 'doors check: not answering');
  /*
   * The rows below are the last thing it said, not the current state. Dimming
   * them is not enough on its own: a 50% opacity says nothing to a screen
   * reader and nothing on the printed sheet, and this panel's own rule is that
   * a level is never carried by colour alone. An operator arrowing through the
   * rows would hear "Announcer mic, OK" and report the building healthy while
   * the check had been dead for ten minutes. The banner is a role="status", so
   * the death of the check is announced once, in words.
   */
  $('vitals').dataset.stale = 'true';
  $('vitalsStale').hidden = false;
  $('vitalsStale').textContent = 'These rows are the last answer the check gave'
    + `${ago ? ago.replace(', last answered', ', from') : ''}, not the state of the `
    + 'building now. Press Run the check.';
}

async function loadVitals(manual = false) {
  try {
    const res = await fetch('/api/vitals');
    // A 401 here is not "the doors check is not answering": this console is
    // signed out, and every other panel is failing the same way in silence.
    // The 30-second poll makes this the console's sign-in watchdog.
    if (res.status === 401) void desk.checkSignIn();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    vitalsMisses = 0;
    vitalsLastOk = Date.now();
    delete $('vitals').dataset.stale;
    $('vitalsStale').hidden = true;
    const verdict = VITAL_VERDICT[r.worst] ?? r.worst;
    $('vitalsDot').dataset.l = r.worst;
    setText($('vitalsWord'), verdict);
    // Mirrored into the page header, because this is the one readout that
    // rolls up every subsystem and it lives inside a fold that can stay shut
    // all day: the console knew the announcer mic was muted and said so
    // nowhere anybody was looking.
    $('vitalsMirror').dataset.l = r.worst;
    setText($('vitalsMirrorText'), `doors check: ${verdict}`);
    if (r.worst === 'fail' && !vitalsOpened) {
      vitalsOpened = true;
      openFold($('setupGroup'));
    }

    $('vitals').replaceChildren(...r.checks.map(c => {
      const row = document.createElement('div');
      row.className = 'v';
      row.dataset.l = c.level;
      const dot = document.createElement('i');
      const label = document.createElement('b');
      label.textContent = c.label;
      const detail = document.createElement('span');
      detail.textContent = c.detail;
      const lvl = document.createElement('span');
      lvl.className = 'lvl';
      lvl.textContent = VITAL_WORD[c.level] ?? c.level;
      row.append(dot, label, detail, lvl);
      if (c.fix) {
        const fix = document.createElement('span');
        fix.className = 'fix';
        fix.textContent = c.fix;
        row.append(fix);
      }
      return row;
    }));
    paintRecording(r.checks.find(c => c.id === 'recorder'));
    kit.vitals = r.checks;
    paintKit();
  } catch {
    vitalsMisses++;
    if (manual || vitalsMisses >= 2) vitalsNotAnswering();
  }
}

/**
 * Whether this desk records at all, from the doors check's Recording row:
 * "off" only when neither half is set up (no ffmpeg AND no cameras listed),
 * the one gray row whose words start "not used on this setup". That folds
 * away the controls that only work on a recording. Any other gray row is a
 * setup half done or a recorder that failed to start, and a failing one is
 * red: their controls stay, because clips cut before a restart still wait
 * in the upload queue, and the row says what broke.
 */
function paintRecording(row) {
  const now = !row ? null
    : row.level === 'off' && /^not used on this setup/i.test(String(row.detail ?? '')) ? 'off' : 'on';
  if ((page.dataset.recording ?? null) === now) return;
  if (now) page.dataset.recording = now;
  else delete page.dataset.recording;
  paintView();
}

$('vitalsCheck').onclick = () => void loadVitals(true);
// Every way in opens the folds on the way past. An anchor pointing inside a
// closed <details> scrolls to a section the browser is not showing, so the
// jump strip and the header mirror would both look broken. Any fold, not just
// the doors check's: Sample data sits inside the field-down kit.
function openFoldsAround(id) {
  const el = id ? document.getElementById(id) : null;
  // A link to a panel Simple leaves out (an old bookmark, a page elsewhere
  // that points at one) shows Everything for this visit rather than landing
  // on nothing. The jump strip never offers one, so this is only arrivals.
  if (el && page.dataset.view !== 'everything' && offPage(el)) pickView('everything', false);
  for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) openFold(d);
  return el;
}
for (const a of document.querySelectorAll('a[href^="#"]')) {
  a.addEventListener('click', () => { openFoldsAround(a.getAttribute('href').slice(1)); });
}
// The same on arrival. The Start here box links to #sec-sample, the sign-in
// page now carries the fragment through, and the target is in a fold that
// starts shut: a first-timer used to land at the top of a very long page with
// the one button they came for nowhere in sight.
{
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { /* a malformed fragment */ }
  const arrive = () => {
    const target = openFoldsAround(id);
    if (target) requestAnimationFrame(() => target.scrollIntoView());
  };
  // A link into the field-down kit (the Start here box's sample data) waits
  // for the desk to say where the field is. Simple shows the kit only while
  // the field is down, so deciding before the first state would read the
  // kit as left out and switch a first-timer to Everything for nothing.
  const into = id ? document.getElementById(id) : null;
  if (into && $('fieldBand').contains(into) && page.dataset.field === undefined) arriveLater = arrive;
  else arrive();
}
$('vitalsPrint').onclick = () => {
  // A closed <details> is display:none inside, and display:none beats the
  // print stylesheet's visibility trick; open it or the sheet comes out blank.
  openFold($('setupGroup'));
  window.print();
};
void loadVitals();
setInterval(() => { if (!document.hidden) void loadVitals(); }, 30_000);

// ---- cameras ----------------------------------------------------------------
// At the floor of the crew range the desk manager is also the switcher, so the
// camera cut lives here rather than in another application. The live scene is
// read off the desk state, which every console shares, so a dedicated switcher
// on their own screen and the desk manager see the same thing.
// SCENE_LABEL is shared from desk-client.js: two hand-kept copies drifted.
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
    const on = btn.dataset.scene === live;
    btn.dataset.live = String(on);
    // Said as a state, not only as a gold fill. This row is the one control
    // that answers "what is the audience actually seeing", and it was the
    // only toggle group on the console a screen reader could not read the
    // state of: every other row on this page sets aria-pressed the same way.
    btn.setAttribute('aria-pressed', String(on));
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
  // role="alert" aria-live="assertive", rewritten unguarded on EVERY bus
  // event. A live safety message therefore interrupted the screen reader
  // continuously, cutting off whatever the operator was trying to read,
  // during the one situation where they most need to hear something else.
  // The raise and the clear still change the string, so the alert still
  // fires once when it means something.
  setText($('emergState'), emergError || (e
    ? `LIVE on every screen since ${new Date(e.raisedAt).toLocaleTimeString()}. Clear it when the room is back to normal.`
    : ''));
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

// ---- sponsors ---------------------------------------------------------------
// The rotation was reachable only from a Stream Deck before: the operator doc
// lists "Sponsor" as a between-matches action, and no console had the button.
async function sponsorAction(action) {
  try {
    const res = await fetch('/api/sponsors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    setText($('spHint'), action === 'hide'
      ? 'Hidden.'
      : `On the main screen: ${out.live?.name ?? out.card?.name ?? 'next sponsor'}.`);
  } catch (err) {
    setText($('spHint'), err.message);
  }
}
$('spNext').onclick = () => void sponsorAction('next');
$('spHide').onclick = () => void sponsorAction('hide');

/**
 * Honestly dead until a sponsor list exists.
 *
 * A shipped config has none, and the section still rendered two live-looking
 * buttons under copy about what the broadcast owes the people who paid. The
 * first press answered "No sponsors are configured." and stopped there,
 * naming no page and no person. Everything else on this console gets this
 * right: the award list says the Judge Advisor builds it at /s/awards, the
 * deck says "Add one below", the profile book says "Nobody saved yet."
 */
async function loadSponsors() {
  try {
    const res = await fetch('/api/sponsors');
    if (!res.ok) return;
    const rows = (await res.json())?.rows ?? [];
    $('spNext').disabled = !rows.length;
    $('spHide').disabled = !rows.length;
    // The page ships with the empty-state sentence already in it, so it is
    // honest before this first answer lands. Left alone when it is already
    // right, because spHint is aria-live and rewriting it re-announces it.
    if (!rows.length) {
      if (!$('spHint').textContent.startsWith('No sponsors')) {
        setText($('spHint'), 'No sponsors on the list yet. The content lead adds them '
          + 'at /s/setup, behind the settings code.');
      }
    } else if ($('spHint').textContent.startsWith('No sponsors')) {
      setText($('spHint'), '');
    }
  } catch { /* transient */ }
}
void loadSponsors();
// Slow poll, because the content lead edits the plan at /s/setup during the
// day and a console that needs a reload to notice stays dead until someone
// thinks to reload it.
setInterval(() => { if (!document.hidden) void loadSponsors(); }, 60_000);

// ---- run of show ------------------------------------------------------------
async function loadRundown() {
  try {
    const res = await fetch('/api/rundown');
    if (!res.ok) return;
    const rd = await res.json();
    // Same treatment as the sponsor rotation: no plan means Advance is dead
    // and says where a plan comes from, instead of staying pressable over an
    // empty day and answering "No run of show is configured."
    const segments = rd?.segments ?? [];
    $('rdAdvance').disabled = !segments.length;
    if (!segments.length) {
      if (!$('rdNow').textContent.startsWith('No run of show')) {
        setText($('rdNow'), 'No run of show yet. The content lead builds the day at '
          + '/s/setup, behind the settings code.');
      }
      return;
    }
    const now = rd.live ? `Live: ${rd.live.label}` : 'Nothing live';
    const next = rd.next ? ` · next: ${rd.next.label}` : '';
    setText($('rdNow'), now + next);
  } catch { /* transient */ }
}
$('rdAdvance').onclick = async () => {
  try {
    const res = await fetch('/api/rundown', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'advance' }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    setText($('rdHint'), 'Advanced.');
    await loadRundown();
  } catch (err) {
    setText($('rdHint'), err.message);
  }
};
void loadRundown();
setInterval(loadRundown, 30_000);

// ---- awards -----------------------------------------------------------------
// The winner is typed HERE and held by the server until Reveal: it must never
// ride the open state feed while the GA is still building the moment.
let awardSnap = null;
let awardPicked = null;
let lastAwardsSig = '';

async function loadAwards() {
  try {
    const res = await fetch('/api/awards');
    if (!res.ok) return;
    awardSnap = await res.json();
    // Diff-guarded, because this now polls: the JA adds and edits awards from
    // their own page all day, and the ceremony list here should follow
    // without a reload. Repainting only on a real change keeps the radio the
    // operator has picked from being wiped mid-ceremony by an idle poll.
    const sig = JSON.stringify(awardSnap);
    if (sig === lastAwardsSig) return;
    lastAwardsSig = sig;
    // The lock only exists when a separate Judge Advisor code is configured;
    // a small event with one code never sees a door it cannot open.
    const locked = !!(awardSnap?.locked && awardSnap?.separate);
    $('awLock').hidden = !locked;
    $('awPanel').hidden = locked;
    if (!locked) paintAwards();
  } catch { /* transient */ }
}

$('awUnlock').onclick = async () => {
  try {
    const res = await fetch('/api/awards/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('awCode').value.trim() }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    $('awCode').value = '';
    $('awLockHint').textContent = 'Unlocked. Run the ceremony from the list below.';
    await loadAwards();
  } catch (err) {
    $('awLockHint').textContent = err.message;
  }
};

function paintAwards() {
  // Reveal is only a real button while an award is on screen: the server
  // refuses it otherwise, and a disabled button explains that before the
  // press instead of after.
  $('awReveal').disabled = !awardSnap?.live;
  const box = $('awList');
  const list = awardSnap?.list ?? [];
  if (!list.length) {
    box.innerHTML = '<p class="hint" style="padding:8px">No awards on the list yet: ' +
      'the Judge Advisor builds it at /s/awards. Typing a custom title below works the same.</p>';
    return;
  }
  /*
   * Grouped by ceremony, numbered in running order.
   *
   * CalGames runs two ceremonies and the desk works one at a time. Flat, the
   * operator hunts for tonight's three awards among Sunday's nine, mid-show,
   * with the hall waiting. The heading also gives them the position in the
   * running order, which is the thing they are actually tracking: "we are on
   * four of nine".
   */
  const groups = [];
  for (const a of list) {
    const label = (a.day || '').trim();
    const key = label.toLowerCase();
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, label, items: [] }; groups.push(g); }
    g.items.push(a);
  }

  const rows = [];
  for (const g of groups) {
    if (groups.length > 1 || g.label) {
      const done = g.items.filter(a => a.presented).length;
      const head = document.createElement('div');
      head.className = 'aw-day';
      head.textContent = (g.label ? `${g.label} ceremony` : 'Not scheduled')
        + ` · ${done} of ${g.items.length} presented`;
      rows.push(head);
    }
    g.items.forEach((a, i) => {
      const label = document.createElement('label');
      const tick = document.createElement('input');
      tick.type = 'radio';
      tick.name = 'awardPick';
      tick.checked = awardPicked === a.id;
      tick.onchange = () => {
        awardPicked = a.id;
        /*
         * The list and the custom box are two ways to say the same thing, so
         * choosing one clears the other. They used to be able to hold
         * conflicting answers at once, which Show could only refuse.
         *
         * Say so when it costs the operator something. The other direction
         * (typing in the box, which drops the list pick) has always written
         * #awHint; this one silently binned a title and a definition somebody
         * had just typed for an off-book award, with the hall waiting, and
         * with no way to get the wording back. Clicking a radio to check the
         * running order is a reasonable thing to do mid-ceremony.
         */
        const typed = $('awCustomTitle').value || $('awCustomDesc').value;
        if (typed) {
          $('awCustomTitle').value = '';
          $('awCustomDesc').value = '';
          $('awHint').textContent = `Using "${a.title}" from the list. The custom `
            + 'award you had typed has been cleared.';
        }
      };
      const who = document.createElement('span');
      who.className = 'who';
      const num = document.createElement('i');
      num.className = 'aw-n';
      num.textContent = `${i + 1}.`;
      const name = document.createElement('b');
      name.textContent = a.title;
      who.append(num, name);
      const sub = document.createElement('span');
      // Priority: what is on screen beats everything; presented is history;
      // "winner loaded" is the JA's staging, shown only once this session
      // holds the JA code (the locked view never carries the flag at all).
      sub.textContent = awardSnap.live === a.id
        ? ' · ON SCREEN'
        : a.presented
          ? ` · presented: ${a.presented.winner}`
          : (a.staged ? ' · winner loaded ' : '');
      who.append(sub);
      if (!a.presented && a.staged && awardSnap.live !== a.id) sub.append(iconEl('check'));
      label.append(tick, who);
      rows.push(label);
    });
  }
  box.replaceChildren(...rows);
}

/*
 * Typing a custom title releases the list selection.
 *
 * A radio group cannot be deselected by clicking, and nothing else ever set
 * awardPicked back to null, so once any listed award had been picked, the
 * Show handler's both-are-set refusal was inescapable: it told the operator
 * to "clear the selection" using a control that does not exist on this page.
 * Mid ceremony, with the hall waiting, the only way out was reloading the
 * console. Clearing it here means the two inputs can never disagree, so the
 * refusal is gone rather than merely escapable.
 */
for (const el of [$('awCustomTitle'), $('awCustomDesc')]) {
  el.addEventListener('input', () => {
    if (!awardPicked) return;
    awardPicked = null;
    if (awardSnap) paintAwards();
    $('awHint').textContent = 'Using the custom award below. '
      + 'Pick from the list again to go back to it.';
  });
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
    if (custom) {
      // Otherwise the title sits in the box and silently becomes the next
      // award too, which is the same collision in reverse.
      $('awCustomTitle').value = '';
      $('awCustomDesc').value = '';
    }
    $('awHint').textContent = $('awWinnerIn').value.trim()
      ? 'On screen. The winner is loaded and hidden: press Reveal on the announcer\'s cue.'
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
// Slow poll, same rhythm as the slide deck: award edits are a between-matches
// event, and 30s is faster than anyone walks from judging to the desk.
setInterval(loadAwards, 30_000);

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
    box.innerHTML = '<p class="hint" style="padding:8px">No slides yet. Add one below: ' +
      'it saves immediately and survives a restart.</p>';
    return;
  }
  box.replaceChildren(...deck.map(sl => {
    const row = document.createElement('div');
    row.className = 'pline';
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
      void slideAction({ action: 'show', id: sl.id }, 'On the main screen.');
    };
    const kill = document.createElement('button');
    kill.className = 'btn kill';
    kill.textContent = 'Remove';
    kill.onclick = e => {
      e.preventDefault();
      // One slot from Show, and there is no undo: deleting a slide typed at
      // the event deletes the typing too.
      if (!confirm(`Remove the slide "${sl.title}" from the deck?`)) return;
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
    const row = document.createElement('div');
    row.className = 'pline';
    const who = document.createElement('span');
    who.className = 'who';
    // The recipient leads, because it becomes the slide's headline: the
    // moderator is approving "Shout-out to X" as much as the message.
    const to = document.createElement('b');
    to.textContent = q.to ? `To ${q.to}: ` : '';
    const msg = document.createElement('span');
    msg.textContent = `"${q.message}" `;
    const from = document.createElement('b');
    from.textContent = `from ${q.name}${q.team ? `, ${q.team}` : ''}`;
    who.append(to, msg, from);
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

$('slNext').onclick = () => void slideAction({ action: 'next' }, 'Next slide on the main screen.');
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
// A preset ignores the label box, both of them, consistently: "5:00" used to
// silently read it while "Field setup 2:00" did not, so one preset was
// secretly a form. The custom row below is the labeled path.
$('tmFive').onclick = () => void startTimer('Break', 300);
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


// ---- show automation: the cues, armed from the desk -------------------------
// They ship disarmed, and until now the phone remote was the ONLY place to
// arm one: a producer with no phone could not turn show automation on at all,
// and nothing on this console said cues existed. The desk has to be able to
// run the whole show by itself.
let cueSig = '';
/*
 * Until when the note belongs to something the operator just did.
 *
 * "Run now" set the note to "ran it" and then, two lines later in the same
 * function, forced a repaint that overwrote it with the standing armed count.
 * The confirmation existed for about as long as a network round trip, so the
 * one button on this panel that does something irreversible looked like it
 * had done nothing, and the honest response to that is to press it again.
 */
let cueNoteHeldUntil = 0;

/**
 * Say something back, and keep it on screen long enough to be read.
 *
 * Writes directly rather than through setText. #cueNote is aria-live, and
 * setText skips an identical string, so pressing Run now twice in a row put
 * "ran it" up once and said nothing the second time: no flicker for a sighted
 * operator, no announcement for a screen reader, and the standing count is
 * suppressed for four seconds so nothing breaks the tie either. The honest
 * reading of a silent console is that the press missed, so it gets pressed
 * again, and the sting plays twice over the announcer. Re-assigning the same
 * string is the point: it is what makes it be said again.
 */
function cueSay(msg) {
  $('cueNote').textContent = `· ${msg}`;
  cueNoteHeldUntil = Date.now() + 4000;
  setTimeout(() => { cueSig = ''; void loadCues(); }, 4100);
}

/** The standing note: suppressed while a reply to the operator is up. */
function cueStandingNote(text) {
  if (Date.now() < cueNoteHeldUntil) return;
  setText($('cueNote'), text);
}

async function loadCues() {
  try {
    const res = await fetch('/api/cues');
    if (!res.ok) return;
    const snap = await res.json();
    // Diff-guarded: this polls, and repainting an unchanged list would move
    // the buttons under the operator's cursor and re-announce the note.
    const sig = JSON.stringify(snap);
    if (sig === cueSig) return;
    cueSig = sig;
    paintCues(snap);
  } catch { /* transient */ }
}

function paintCues({ available, obs, cues = [] }) {
  const box = $('cueList');
  const armAll = $('cueArmAll');
  const disarmAll = $('cueDisarmAll');

  if (!available) {
    cueStandingNote('· off');
    box.innerHTML = '<p class="hint" style="padding:8px">Show automation is not running '
      + 'on this desk. Everything still works by hand; nothing is missing from the show.</p>';
    armAll.disabled = true;
    disarmAll.disabled = true;
    return;
  }
  if (!cues.length) {
    cueStandingNote('· none configured');
    box.innerHTML = '<p class="hint" style="padding:8px">No cues are configured on this '
      + 'desk. They are set up before the event, in config.json on this machine.</p>';
    armAll.disabled = true;
    disarmAll.disabled = true;
    return;
  }

  const armed = cues.filter(c => c.autopilot).length;
  cueStandingNote(`· ${armed} of ${cues.length} armed`);
  armAll.disabled = armed === cues.length;
  disarmAll.disabled = armed === 0;

  /*
   * A cue that drives OBS cannot do anything while OBS is away. It used to
   * disable Run now on EVERY cue, under a notice explaining why: but the
   * three music cues and the end game chip never touch OBS, so a desk running
   * the show on the venue projectors with no stream had four working cues it
   * could not fire by hand, and a reason printed underneath that was false of
   * all four. The engine now says which cues need it (see Cue.needsObs).
   */
  /*
   * With OBS away, every cue still runs. `ctx.scene` emits the scene change on
   * the bus whatever happens and only reaches the switcher when OBS is
   * connected, so the graphics still switch and only the camera cut is lost.
   * This panel disabled all eleven Run now buttons, then briefly the seven
   * that cut a scene; both were the same mistake, reading "talks to OBS" as
   * "needs OBS". Nothing is disabled now. The count is still worth saying,
   * because somebody has to cover those cuts by hand.
   */
  const obsDown = !!(obs && obs.attached && !obs.connected);
  const cutting = obsDown ? cues.filter(c => c.needsObs).length : 0;

  /*
   * Where the keyboard was, so it can be put back.
   *
   * This list repaints on a poll, and the signature it diffs against includes
   * counters that move as the show runs: "would have run 3x" becomes 4x and
   * the whole list is rebuilt under the operator. replaceChildren destroys
   * the focused button, so focus falls to <body> and the next Tab starts from
   * the top of a twenty-section console. On a console whose first line of
   * documentation is "keyboard-first", a panel that throws the keyboard out
   * every fifteen seconds is not usable by the people it was built for.
   */
  const wasFocused = document.activeElement;
  const restore = wasFocused && box.contains(wasFocused) && wasFocused.dataset.cue
    ? { cue: wasFocused.dataset.cue, act: wasFocused.dataset.act }
    : null;

  box.replaceChildren(...cues.map(c => {
    const row = document.createElement('div');
    row.className = 'cue';

    const who = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = c.name;
    who.append(name);
    if (c.does) {
      const does = document.createElement('span');
      does.className = 'does';
      does.textContent = c.does;
      who.append(does);
    }
    const st = document.createElement('span');
    st.className = 'st';
    if (c.lastError) {
      st.dataset.err = 'true';
      st.textContent = `failed last time: ${c.lastError}`;
    } else if (c.autopilot) {
      st.dataset.on = 'true';
      st.textContent = 'armed, runs by itself';
    } else {
      st.textContent = c.wouldHaveFired
        ? `off, would have run ${c.wouldHaveFired}x`
        : 'off';
    }
    who.append(st);

    const toggle = document.createElement('button');
    toggle.className = c.autopilot ? 'btn' : 'btn btn--go';
    toggle.textContent = c.autopilot ? 'Turn off' : 'Arm';
    toggle.title = c.autopilot
      ? `Stop ${c.name} running by itself. It still counts what it would have done.`
      : `Let ${c.name} run by itself from now on.`;
    toggle.dataset.cue = c.id;
    toggle.dataset.act = 'toggle';
    toggle.onclick = () => void cueAction(c.id, c.autopilot ? 'disarm' : 'arm');

    const fire = document.createElement('button');
    fire.className = 'btn';
    fire.textContent = 'Run now';
    fire.title = obsDown && c.needsObs
      ? `Run ${c.name} once, right now. OBS is not connected, so the graphics `
        + 'switch and the camera cut does not: take that cut by hand.'
      : `Run ${c.name} once, right now, whatever it is set to.`;
    fire.dataset.cue = c.id;
    fire.dataset.act = 'fire';
    fire.onclick = () => void cueAction(c.id, 'fire');

    row.append(who, toggle, fire);
    return row;
  }));

  if (restore) {
    const esc = window.CSS && CSS.escape ? CSS.escape(restore.cue) : restore.cue;
    const row = box.querySelector(`[data-cue="${esc}"]`)?.closest('.cue');
    /*
     * Land somewhere, always. An earlier version skipped the focus when the
     * asked-for button came back disabled, which produced exactly the dead
     * keyboard this block exists to prevent: replaceChildren has already
     * destroyed the focused node, so activeElement is <body> and the next Tab
     * restarts twenty sections above the panel. Fall through to the other
     * control on the same row, then to the row itself.
     */
    const target = box.querySelector(`[data-cue="${esc}"][data-act="${restore.act}"]:not([disabled])`)
      ?? row?.querySelector('button:not([disabled])')
      ?? box.querySelector('button:not([disabled])');
    if (target) target.focus();
  }

  if (cutting) {
    const warn = document.createElement('p');
    warn.className = 'hint';
    warn.style.padding = '8px';
    warn.textContent = 'OBS is not connected. Every cue still runs and the graphics '
      + `still switch; the ${cutting} cue${cutting === 1 ? '' : 's'} that also cut a `
      + 'camera will not move it, so take those cuts in the switcher by hand until '
      + 'OBS is back.';
    box.append(warn);
  }
}

async function cueAction(id, action) {
  try {
    const res = await fetch(`/api/cues/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
    cueSig = '';            // force the next paint
    await loadCues();
    // After the repaint, not before it: the repaint writes this same element.
    if (action === 'fire') cueSay('ran it');
  } catch (err) {
    cueSay(err.message);
  }
}

$('cueArmAll').onclick = async () => {
  // No cameras to cut on a desk without OBS, so the question does not offer any.
  const doing = page.dataset.obs === 'off' ? 'switching the screens' : 'cutting cameras';
  if (!confirm(`Arm every cue? The desk starts ${doing} and driving audio `
    + 'by itself from now on. You can still take anything by hand.')) return;
  await cueAction('all', 'arm');
};
$('cueDisarmAll').onclick = () => void cueAction('all', 'disarm');

void loadCues();
// Slow poll: arming is a between-matches decision, and the counts of what a
// cue would have fired move as the show runs.
setInterval(() => { if (!document.hidden) void loadCues(); }, 15_000);
