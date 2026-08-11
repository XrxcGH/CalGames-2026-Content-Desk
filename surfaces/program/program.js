/**
 * Program overlay: the whole broadcast graphic in one Browser Source.
 *
 * Screens switch on `state.screen`, so the switcher operator never has to
 * change sources mid-show. One URL in OBS, all weekend.
 */

import {
  connect, applyDisplayMode, fitStage, roll, restart, startTicker,
  clockDisplayFor, hubActiveAt, phaseFor, PHASE_LABEL, REBUILT,
} from '/shared/desk-client.js';
import { rpStrip } from '/shared/rp.js';
import { allianceRoster } from '/shared/alliance.js';

const params = applyDisplayMode();
// ?mode=clean is the second-stream variant: minimal score bar and clock over a
// static full-field camera, locked to the match layout. No screen switching,
// no lower thirds, no status cards. See docs/11 "The second stream".
const CLEAN = params.get('mode') === 'clean';
const $ = id => document.getElementById(id);
const desk = connect(CLEAN ? 'program-clean' : 'program');

// ---- stage fitting --------------------------------------------------------
fitStage($('stage'));

// ---- screens --------------------------------------------------------------
const SCREENS = [
  'overview', 'match', 'score', 'analysis', 'arcade', 'selection', 'explain',
  'cardcall', 'sponsor', 'blank',
];
let currentScreen = null;

function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'blank';
  if (name === currentScreen) return;
  const first = currentScreen === null;
  currentScreen = name;

  const paint = () => {
    for (const s of SCREENS) $(`scr-${s}`).toggleAttribute('data-active', s === name);
  };

  // The explainer only advances while it is the live screen. Nothing is more
  // confusing than a loop that jumps mid-card because it kept counting.
  runExplainer(name === 'explain');

  if (first) { paint(); return; }
  // Gold Sweep: swap behind the bar at its midpoint.
  restart($('sweep'));
  const half = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dur-sweep')) / 2 || 240;
  setTimeout(paint, half);
}

// ---- explainer loop -------------------------------------------------------
/**
 * For the parent who arrived twenty minutes ago.
 *
 * The most repeated newcomer complaint is that nobody ever says what the
 * numbers mean: you can watch a full match without learning what fuel is, or
 * why the alliance that scored fewer points is celebrating. These run in the
 * gaps, one idea per card, in the same words the announcer uses.
 *
 * Deliberately not a glossary dump. Six cards, twelve seconds each, so a card
 * is readable from the back of the gym and the loop comes round often enough
 * that nobody has to catch it from the start.
 */
const EXPLAINERS = [
  {
    chip: 'How to watch',
    title: 'Two alliances, three teams each',
    // Red and blue stay unemphasized on purpose: the accent here is gold, and
    // gold on the words "red" and "blue" reads as a third alliance color.
    body: 'Six robots on the field, red against blue, three teams a side. '
      + 'The teams were paired at random for this match, so today\'s opponent is '
      + 'tomorrow\'s teammate.',
  },
  {
    chip: 'The clock',
    title: 'Twenty seconds on their own',
    body: 'Every match opens with <b>autonomous</b>: no drivers, just code the students '
      + 'wrote. Then the drivers pick up the controls for the rest of it.',
  },
  {
    chip: 'Scoring',
    title: 'Fuel and tower',
    body: '<b>Fuel</b> is the scoring game piece, and it only counts while your hub is '
      + 'live. <b>Tower</b> points come from climbing at the end. Both are on the bar '
      + 'at the bottom of the screen.',
  },
  {
    chip: 'Scoring',
    title: 'Only one hub is live at a time',
    body: 'The hubs alternate through the match. Scoring into a hub that is not lit '
      + 'earns <b>nothing</b>. Watch which alliance the field is favoring right now.',
  },
  {
    chip: 'Why they cheer',
    title: 'Winning is not the only prize',
    body: 'Alliances also chase <b>ranking points</b> for hitting targets. That is why '
      + 'a team that just lost might still be celebrating. The badges on the score bar '
      + 'show how close each one is.',
  },
  {
    chip: 'Come say hi',
    title: 'The pits are open',
    body: 'Every robot here was built by students in about six weeks. They are happy to '
      + 'show you how it works, and the pits are open all day.',
  },
];

const EXPLAINER_MS = 12_000;
let explainerAt = 0;
let explainerTimer = null;

function explainerCards() {
  const extra = accessCard(desk.state);
  return extra ? [...EXPLAINERS, extra] : EXPLAINERS;
}

function paintExplainer() {
  const cards = explainerCards();
  const card = cards[explainerAt % cards.length];
  $('expChip').textContent = card.chip;
  $('expTitle').textContent = card.title;
  $('expBody').innerHTML = card.body;
  $('expDots').innerHTML = cards
    .map((_, i) => `<span${i === explainerAt % cards.length ? ' data-on' : ''}></span>`).join('');
}

/**
 * The accessibility card, built from what the event actually listed.
 *
 * Appended to the loop rather than given its own screen, because a screen
 * somebody has to choose is a screen nobody chooses, and this needs to come
 * round on its own in front of people who did not know to look. Absent when
 * the event listed nothing: inventing a service is worse than silence.
 */
function accessCard(state) {
  const a = state?.accessibility;
  if (!a?.services?.length) return null;
  return {
    chip: 'Here to help',
    title: 'Around the building',
    body: a.services
      .slice(0, 4)
      .map(sv => '<b>' + escapeHtml(sv.label) + '</b>' + (sv.detail ? ' &middot; ' + escapeHtml(sv.detail) : ''))
      .join('<br>')
      + (a.ask ? '<br>' + escapeHtml(a.ask) : ''),
  };
}

function runExplainer(on) {
  clearInterval(explainerTimer);
  explainerTimer = null;
  if (!on) return;
  paintExplainer();
  explainerTimer = setInterval(() => { explainerAt++; paintExplainer(); }, EXPLAINER_MS);
}

// ---- alliance selection ---------------------------------------------------
/**
 * The board, straight from the field. Cheesy Arena republishes the whole thing
 * on every pick, so this redraws wholesale rather than trying to animate
 * individual slots: a pick that lands during a redraw would be lost.
 *
 * Empty slots stay visible as gold rules. Watching them fill is the segment.
 */
function paintSelection(sel) {
  if (!sel) return;

  // CalGames picks four per alliance and never calls a backup, so a complete
  // alliance is a captain plus three, and the board shows four slots from the
  // start. Sized off the longest alliance rather than a constant, so a
  // three-pick event still draws a full board instead of a trailing gap.
  const size = Math.max(4, ...sel.alliances.map(a => a.teams.length));

  $('selBoard').innerHTML = sel.alliances.map(a => {
    const picks = a.teams.slice(0, size);
    const slots = Math.max(0, size - picks.length);
    return `<div class="sel-al" style="--n:${size}">
      <div class="sel-al-seed num">${a.id}</div>
      <div class="sel-al-teams">
        ${picks.map((t, i) => `<span class="sel-al-team num"${i === 0 ? ' data-captain' : ''}>${t}</span>`).join('')}
        ${'<span class="sel-al-slot"></span>'.repeat(slots)}
      </div>
    </div>`;
  }).join('');

  // Room-scale legibility beats completeness: the teams near the top of the
  // pool are the ones about to be called, and the rest are a scroll nobody
  // can read from the back of the gym anyway.
  const pool = sel.ranked.slice(0, 24);
  $('selPool').innerHTML = pool.map(r =>
    `<div class="sel-pool-team"${r.picked ? ' data-picked' : ''}>
      <span class="sel-pool-rank">${r.rank}</span>
      <span class="sel-pool-num num">${r.team}</span>
    </div>`).join('');

  $('selClock').hidden = !sel.showTimer;
}

/**
 * Tick the pick clock between messages. The field sends a fresh value once a
 * second, so interpolating from the last one keeps the countdown smooth if a
 * message is late.
 *
 * Only for a couple of seconds, though. If updates stop, the timer was paused
 * or selection moved on, and running our own clock down to a triumphant 0:00
 * would be inventing a deadline the field never called. Past the grace window
 * it freezes exactly where the interpolation stood.
 */
const SELECTION_GRACE_MS = 2500;

// Frames are aged from LOCAL receipt time, never against sel.updatedAt: that
// stamp is the desk server's clock, and an OBS box or pit monitor a minute
// off shifts the on-air countdown by its full skew (behind, it also defeats
// the grace check, so the freeze never engages). Receipt time asks no two
// clocks to agree. The state handler below resets it per fresh frame.
let selSeenAt = 0;
let selStamp = null;

function paintSelectionClock(sel) {
  if (!sel?.showTimer) return;
  // Clamped, not switched: falling back to the raw field value after the
  // grace window visibly replayed the last two seconds on air.
  const age = Math.min(Date.now() - selSeenAt, SELECTION_GRACE_MS);
  const left = Math.max(0, Math.ceil(sel.timeRemainingSec - age / 1000));
  $('selClockNum').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('selClock').toggleAttribute('data-low', left <= 10);
}

// ---- alliance overview ----------------------------------------------------
/**
 * One team, laid out across rather than down.
 *
 * Stacking robots as columns gave each name about 186px and long ones had to
 * shrink to fit. As a row the name gets the whole width beside the plate,
 * roughly 500px, so "Homestead Robotics" sets at full size and a four-team
 * playoff alliance costs height (which there is) instead of width (which there
 * is not).
 *
 * Two shapes, because most teams at an off-season have no photo:
 *   with a photo    plate, then number over name
 *   without a photo the plate carries the number in gold, and the name gets
 *                   the text column to itself at a larger size
 * Either way the number appears exactly once and every name starts at the
 * same x, so a mixed alliance still reads as one list.
 */
function robotCard(team, i) {
  const media = desk.mediaFor(team.number);
  const len = String(team.number).length;
  const art = media
    ? `<div class="robot-art"><img src="${media.src}" alt=""></div>`
    // Fallback must look deliberate, since most teams won't have a photo.
    : `<div class="robot-art"><div class="robot-art--fallback"><span class="num" data-len="${len}">${team.number}</span></div></div>`;
  return `<div class="robot reveal reveal--up" data-photo="${!!media}" style="--i:${i}">
    ${art}
    <div class="robot-id">
      <div class="robot-num num" data-len="${len}">${team.number}</div>
      <div class="robot-name">${escapeHtml(team.name ?? '')}</div>
    </div>
  </div>`;
}

function buildOverview(match) {
  if (!match) return;
  $('ovLabel').textContent = match.displayName ?? '';
  // Row count follows the alliance. Rows share the side's height, so a fourth
  // team makes each row shorter rather than making every name narrower. Both
  // sides take the larger count, so the two halves stay level even when one
  // alliance is short a robot.
  const n = Math.max(1, (match.red ?? []).length, (match.blue ?? []).length);
  // Three-team qualification rows are taller, so the plate can afford to be
  // wider; a four-team playoff tightens it to keep the name column honest.
  // Type grows into the width the row layout freed up. Three-team rows are
  // taller and wider, so they carry the larger step; four still clears the
  // old column layout comfortably.
  const plate = n >= 4 ? '168px' : '200px';
  const nameSize = n >= 4 ? '44px' : '54px';
  const numSize = n >= 4 ? '76px' : '92px';
  for (const id of ['redRobots', 'blueRobots']) {
    $(id).style.setProperty('--n', n);
    $(id).style.setProperty('--plate', plate);
    $(id).style.setProperty('--name-size', nameSize);
    $(id).style.setProperty('--num-size', numSize);
  }
  $('redRobots').innerHTML = (match.red ?? []).map(robotCard).join('');
  $('blueRobots').innerHTML = (match.blue ?? []).map(robotCard).join('');
}

// ---- score bar ------------------------------------------------------------
// Badges, not bare pips: the icon says which bonus, the numeral says the
// threshold, so a viewer arriving mid-match can read the goal off the bar.
// Thresholds come from config and arrive with the first state frame, so the
// strips are rebuilt when they change rather than baked in at load. Rebuilding
// clears the earned flags, so this always runs before the score repaints.
let rpKey = null;

function paintRpStrips(thresholds) {
  const key = JSON.stringify(thresholds ?? null);
  if (key === rpKey) return;
  rpKey = key;
  for (const el of [$('redPips'), $('bluePips'), $('finalRedRp'), $('finalBlueRp')]) {
    el.innerHTML = rpStrip(thresholds);
  }
}

paintRpStrips();

function paintRp(container, rp) {
  for (const badge of container.children) {
    badge.dataset.earned = String(!!rp[badge.dataset.rp]);
  }
}

function paintScore(state) {
  // Two flags, because they are two different claims. When the field posts a
  // result the TOTAL is official while the fuel and tower under it may still
  // be what somebody typed at the desk with the bridge down. One flag for
  // both meant an official total silently promoted the guesses beside it.
  const estTotal = String(state.totalConfidence === 'estimated');
  const estParts = String(state.confidence === 'estimated');
  for (const side of ['red', 'blue']) {
    const s = state.score[side];
    roll($(`${side}Fuel`), s.fuel);
    roll($(`${side}Tower`), s.tower);
    roll($(`${side}Total`), s.total);
    $(`${side}Total`).dataset.est = estTotal;
    $(`${side}Fuel`).dataset.est = estParts;
    $(`${side}Tower`).dataset.est = estParts;
    paintRp($(`${side}Pips`), s.rp);
  }
}

/**
 * A team's number on the bar, with what it is carrying.
 *
 * The mark is a shape as well as a colour: a red card and a yellow card are
 * two states of the same thing, and on a stream that has been recompressed
 * twice, colour alone is not a reliable difference. Red gets a filled block,
 * yellow an outlined one, and both carry a title for anyone reading the DOM.
 *
 * A surrogate gets an "S", because the alternative is the audience watching a
 * team lose a match that was never theirs and then finding the ranking table
 * disagrees.
 */
function teamMark(team, state) {
  const c = state?.cards?.byTeam?.[team];
  const marks = [];
  if (c?.reds) marks.push('<i class="cmark cmark--red" title="Red card"></i>');
  else if (c?.yellows) marks.push('<i class="cmark cmark--yellow" title="Carrying a yellow card"></i>');
  if ((state?.surrogates ?? []).includes(team)) {
    marks.push('<i class="cmark cmark--sur" title="Surrogate: this match does not count for them">S</i>');
  }
  return marks.join('');
}

function paintTeams(match, state) {
  if (!match) return;
  // A fourth team adds a fourth line inside a fixed-height bar, so the stack
  // tightens rather than growing past it. Three lines keep the full size.
  const n = Math.max((match.red ?? []).length, (match.blue ?? []).length);
  for (const id of ['redTeams', 'blueTeams']) $(id).dataset.rows = String(n);
  const line = t => `<span class="bar-team">${t.number}${teamMark(t.number, state)}</span>`;
  $('redTeams').innerHTML = (match.red ?? []).map(line).join('<br>');
  $('blueTeams').innerHTML = (match.blue ?? []).map(line).join('<br>');
}

// Where the points came from: fuel and tower by period, plus the points the
// OPPONENT's fouls handed over (which is how fouls enter this side's total).
function paintBreak(el, s, opponentFouls) {
  el.innerHTML = `
    <span></span><span class="fb-h">Fuel</span><span class="fb-h">Tower</span>
    <span class="fb-l">Auto</span><span class="fb-n">${s.autoFuel ?? 0}</span><span class="fb-n">${s.autoTower ?? 0}</span>
    <span class="fb-l">Teleop</span><span class="fb-n">${s.teleopFuel ?? 0}</span><span class="fb-n">${s.teleopTower ?? 0}</span>
    <span class="fb-l">Opponent fouls</span><span class="fb-n fb-span">+${opponentFouls ?? 0}</span>`;
}

function paintFinal(state) {
  const r = state.score.red.total, b = state.score.blue.total;
  // score[side].fouls = points that side CONCEDED, so they land in the other total.
  paintBreak($('finalRedBreak'), state.score.red, state.score.blue.fouls);
  paintBreak($('finalBlueBreak'), state.score.blue, state.score.red.fouls);
  // The escaped nbsp holds the line box like the markup fallback &nbsp; does;
  // a plain space collapses and the final-score header jumps.
  $('finalMatchName').textContent = state.match?.displayName ?? '\u00a0';
  $('finalRed').textContent = r;
  $('finalBlue').textContent = b;
  // Shadow-scored totals render OUTLINED here too, same contract as the score
  // bar: the final screen is the one everyone screenshots, and it must never
  // dress a desk-typed guess up as an official result.
  const estTotal = String(state.totalConfidence === 'estimated');
  $('finalRed').dataset.est = estTotal;
  $('finalBlue').dataset.est = estTotal;
  // The itemization carries its own flag, so an official total can sit above
  // an outlined breakdown — which is exactly the state a desk that
  // shadow-scored a match is in when the field finally posts the result.
  const estParts = String(state.confidence === 'estimated');
  $('finalRedBreak').dataset.est = estParts;
  $('finalBlueBreak').dataset.est = estParts;
  // The whole alliance, not just the three on the field: in a playoff the
  // fourth pick won this match too, and the social card already names them.
  // The on-air final screen and the card must agree.
  $('finalRedTeams').textContent = allianceRoster(state, 'red').map(t => t.number).join(' · ');
  $('finalBlueTeams').textContent = allianceRoster(state, 'blue').map(t => t.number).join(' · ');
  paintRp($('finalRedRp'), state.score.red.rp);
  paintRp($('finalBlueRp'), state.score.blue.rp);
  paintFinalCards(state);

  $('finalRedSide').toggleAttribute('data-won', r > b);
  $('finalBlueSide').toggleAttribute('data-won', b > r);
  $('finalRedVerdict').textContent = r > b ? 'Winner' : r === b ? 'Tie' : '';
  $('finalBlueVerdict').textContent = b > r ? 'Winner' : r === b ? 'Tie' : '';
}

// ---- status card ----------------------------------------------------------
const STATUS_KIND = {
  delay: 'Field delay', review: 'Under review', fault: 'Arena fault',
  replay: 'Match replay', custom: 'Announcement',
};

function paintStatus(status) {
  const card = $('statusCard');
  if (!status) {
    // Fades out rather than disappearing between two frames, which on a
    // broadcast reads as a glitch rather than as the card retiring.
    if (!card.hidden && card.dataset.leaving !== 'true') {
      card.dataset.leaving = 'true';
      const done = () => { card.hidden = true; delete card.dataset.leaving; };
      card.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 500);
    }
    return;
  }
  delete card.dataset.leaving;
  const back = status.backAt
    ? ` (back ~${new Date(status.backAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`
    : '';
  $('statusKind').textContent = STATUS_KIND[status.kind] ?? 'Update';
  $('statusMsg').textContent = `${status.message}${back}`;
  card.hidden = false;
}

// ---- lower third ----------------------------------------------------------
/**
 * The show EVENT drives the entrance; state frames only reconcile.
 *
 * The reducer keeps lowerThird set until an explicit hide, and every bus
 * event fans out with full state, so painting the entrance from state frames
 * had two on-air failure modes: any event cadence under the dwell (realtime
 * scoring alone is ~1Hz) re-armed the timer forever, and once the dwell did
 * fire, the next state frame slid the retired third straight back in,
 * looping it on and off air until an operator hid it by hand.
 */
let thirdTimer = null;
let thirdKey = null;       // JSON of the third currently or last shown
let thirdExpired = false;  // dwell retired it; state frames must not resurrect it

function hideThird() {
  const el = $('third');
  clearTimeout(thirdTimer);
  if (!el.hasAttribute('data-show')) return;
  el.className = 'lower-third third--exit';
  const out = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dur-out')) || 260;
  // Tracked in thirdTimer so a show landing mid-exit cancels it: a stray
  // timeout here would strip data-show out from under the fresh entrance.
  thirdTimer = setTimeout(() => el.removeAttribute('data-show'), out);
}

function showThird(lt) {
  const el = $('third');
  clearTimeout(thirdTimer);
  thirdKey = JSON.stringify(lt);
  thirdExpired = false;

  $('thirdT1').textContent = lt.line1 ?? '';
  $('thirdT2').textContent = lt.line2 ?? '';
  el.setAttribute('data-show', '');
  el.className = 'lower-third third';

  // Nothing stays up forever waiting on an operator who is busy.
  if (!lt.pinned) {
    const dwell = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--dwell')) || 8000;
    thirdTimer = setTimeout(() => { thirdExpired = true; hideThird(); }, dwell);
  }
}

function paintThird(lt) {
  if (!lt) {
    thirdKey = null;
    thirdExpired = false;
    hideThird();
    return;
  }
  // Seen already: either on air (leave the dwell alone) or retired (stay
  // retired until a fresh show event or a different payload).
  if (JSON.stringify(lt) === thirdKey) return;
  // Unseen with no show event: the snapshot after a (re)connect.
  showThird(lt);
}

// ---- local clock, derived every frame -------------------------------------
startTicker(() => {
  const st = desk.state;
  if (!st) return;

  const c = desk.matchClock;
  $('clock').textContent = clockDisplayFor(st, c);
  const phase = phaseFor(st, c);
  $('phase').textContent = PHASE_LABEL[phase] ?? phase;

  const hub = phase === 'post' && !st.hubAuthoritative
    ? 'none'
    : hubActiveAt(c, st.autoWinner, st.hubAuthoritative);
  $('hub').dataset.on = hub;
  $('hubText').textContent = hub === 'both' ? 'Both hubs live'
    : hub === 'none' ? '' : `${hub} hub live`;

  // Endgame: suppress decorative motion, keep score and clock running.
  const endgame = c !== null && c >= REBUILT.ENDGAME_START && c < REBUILT.MATCH_END;
  document.documentElement.toggleAttribute('data-lockdown', endgame);

  // Alert Pulse: the gold band pulses three times as endgame opens, then
  // holds steady. The class is added once per entry (cg-pulse runs 3
  // iterations on its own); re-adding it every tick would restart the
  // animation at 10Hz and it would never visibly pulse.
  const bar = $('endgameBar');
  if (endgame && bar.hidden) {
    bar.hidden = false;
    bar.classList.add('pulse');
  } else if (!endgame && !bar.hidden) {
    bar.hidden = true;
    bar.classList.remove('pulse');
  }

  if (currentScreen === 'selection') paintSelectionClock(st.selection);
});

// ---- wiring ---------------------------------------------------------------
let lastMatchId = null;
let lastMatchLoaded = null;

desk.on('state', state => {
  // Cards land mid-match and change what the team lines say, so the key is
  // the match AND what everyone on it is carrying.
  const teamKey = (state.match?.id ?? null) + JSON.stringify(state.cards?.byTeam ?? {})
    + JSON.stringify(state.surrogates ?? []);
  if (teamKey !== lastMatchId) {
    const freshMatch = (state.match?.id ?? null) !== lastMatchLoaded;
    lastMatchId = teamKey;
    lastMatchLoaded = state.match?.id ?? null;
    if (freshMatch) buildOverview(state.match);
    paintTeams(state.match, state);
  }
  paintRpStrips(state.thresholds);
  paintScore(state);
  if (state.screen === 'score') paintFinal(state);
  if (state.selection && state.selection.updatedAt !== selStamp) {
    selStamp = state.selection.updatedAt;
    selSeenAt = Date.now();
  }
  if (state.selection) paintSelection(state.selection);
  paintThird(CLEAN ? null : state.lowerThird);
  paintPanel(CLEAN ? null : state.panel);
  paintStatus(CLEAN ? null : state.status);
  paintEmergency(state.emergency);
  paintCardCall(state.cardCall);
  paintSponsor(state.sponsor);
  showScreen(CLEAN ? 'match' : state.screen);
});

// The event, not the state frame, is the authority for a fresh entrance: an
// operator deliberately re-showing identical text emits an identical payload,
// which the keyed state path in paintThird correctly swallows. Read the
// payload back off state so the key always matches later state frames.
desk.on('lower_third.show', () => {
  if (!CLEAN && desk.state?.lowerThird) showThird(desk.state.lowerThird);
});

/**
 * Who is on camera, in screen order.
 *
 * Keyed like the lower third: rebuilding on every state frame would restart
 * the entrance animation ten times a second. Only a real change to the people
 * or their order redraws, so adding a fourth guest animates just that card in
 * and leaves the other three alone.
 */
let panelKey = '';
function paintPanel(panel) {
  const el = $('anPanel');
  const strap = $('anStrap');
  const people = panel?.people ?? [];

  // The title is painted BEFORE the early return, because it changes
  // independently of who is sitting there. Inside the keyed block it stuck:
  // the desk retitled a segment "Playoff preview" with the same three guests
  // up and the strap kept saying "Analysis desk" until somebody was added or
  // removed. It also never appeared at all for a strap with nobody on it,
  // which is the bumper case the strap exists for.
  $('anTitle').textContent = panel?.title || 'Analysis desk';

  // The CARDS are keyed, because rebuilding them on every state frame would
  // restart the entrance animation ten times a second.
  const key = JSON.stringify(people);
  if (key === panelKey) return;
  panelKey = key;
  strap.hidden = people.length > 0;
  el.dataset.n = String(people.length);

  // Leaving is animated as well as arriving. Up to six name cards vanishing in
  // a single frame reads as a fault; the band drops away the way it came in.
  if (people.length === 0) {
    if (!el.hidden) {
      el.dataset.leaving = 'true';
      const done = () => { el.hidden = true; delete el.dataset.leaving; };
      // The timeout is the belt: transitionend does not fire if the element is
      // display:none'd by something else mid-flight, and a panel stuck
      // half-off the bottom of the frame is worse than one that cuts.
      el.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 500);
    }
    return;
  }
  delete el.dataset.leaving;
  el.hidden = false;

  el.replaceChildren(...people.map(p => {
    const card = document.createElement('div');
    card.className = 'an-card';

    const name = document.createElement('div');
    name.className = 'an-name';
    // The core already shortened a student's name before this reached the
    // event payload, so this prints what it is given. `display` is checked
    // first only for a panel pushed straight through the API.
    name.textContent = p.display || p.name;
    card.append(name);

    // The role line is skipped entirely when there is nothing to say, rather
    // than reserving an empty row: a ragged band of different heights is worse
    // than a shorter one.
    if (p.role || p.team) {
      const role = document.createElement('div');
      role.className = 'an-role';
      role.textContent = p.role ?? '';
      if (p.team) {
        const team = document.createElement('b');
        team.textContent = String(p.team);
        role.append(team);
      }
      card.append(role);
    }
    return card;
  }));
}

/**
 * The safety plate.
 *
 * Shown even in clean mode. ?mode=clean exists to give a scouting or pit feed
 * a quieter picture by dropping lower thirds and status cards; a safety
 * message is the one thing those feeds must never be quieter about.
 */
const EMERG_KIND = {
  evacuate: 'Evacuate',
  shelter: 'Shelter in place',
  medical: 'Medical',
  hold: 'Hold',
  allclear: 'All clear',
  custom: 'Announcement',
};

function paintEmergency(e) {
  const el = $('emerg');
  el.hidden = !e;
  if (!e) return;
  $('emergKind').textContent = EMERG_KIND[e.kind] ?? EMERG_KIND.custom;
  $('emergMsg').textContent = e.message;
  $('emergDetail').textContent = e.detail ?? '';
  // Whoever raised this was typing in a hurry, so the type fits itself.
  const msg = $('emergMsg');
  msg.removeAttribute('data-fit');
  for (const step of ['1', '2']) {
    if (msg.scrollHeight <= msg.clientHeight && msg.scrollWidth <= msg.clientWidth) break;
    msg.dataset.fit = step;
  }
}
/**
 * The card call. Team, colour, and the reason the announcer is saying.
 *
 * The team NAME comes off the loaded match rather than a lookup: the card is
 * always for somebody who is on the field right now, and a second source of
 * team names is a second thing that can disagree with the bar.
 */
/**
 * Cards issued in the match just finished, on the final screen.
 *
 * The final screen is the one people photograph, and a red card is the reason
 * a number on it looks wrong. Saying so here means the picture explains itself
 * later, when nobody remembers what the announcer said.
 */
function paintFinalCards(state) {
  const el = $('finalCards');
  const list = state.cards?.thisMatch ?? [];
  el.hidden = list.length === 0;
  if (!list.length) return;
  el.replaceChildren(...list.map(c => {
    const chip = document.createElement('span');
    chip.className = `fc-chip fc-chip--${c.color}`;
    chip.textContent = `${c.color === 'red' ? 'Red card' : 'Yellow card'} · ${c.team}`;
    return chip;
  }));
}

/**
 * The sponsor card.
 *
 * The logo is optional and often missing at an offseason event, so the name is
 * always drawn: a card that renders as a broken image is worse for the sponsor
 * than one that just says who they are, in the same face everything else uses.
 */
function paintSponsor(sponsor) {
  if (!sponsor) return;
  $('spName').textContent = sponsor.name;
  $('spLine').textContent = sponsor.line ?? '';
  const logo = $('spLogo');
  logo.hidden = !sponsor.logo;
  if (sponsor.logo) logo.src = sponsor.logo;
  // A logo path that 404s would otherwise leave the browser's broken-image
  // glyph 340px tall on a projector.
  logo.onerror = () => { logo.hidden = true; };
}

function paintCardCall(call) {
  if (!call) return;
  const plate = $('ccPlate');
  plate.dataset.color = call.color;
  $('ccChip').textContent = call.color === 'red' ? 'Red card' : 'Yellow card';
  $('ccTeam').textContent = String(call.team);
  // The team NAME comes off the loaded match rather than a lookup: the card is
  // always for somebody on the field right now, and a second source of team
  // names is a second thing that can disagree with the score bar.
  const roster = [...(desk.state?.match?.red ?? []), ...(desk.state?.match?.blue ?? [])];
  $('ccName').textContent = roster.find(t => t.number === call.team)?.name ?? '';
  $('ccReason').textContent = call.reason ?? '';

  // Whoever typed the reason was typing during a match, so the type fits
  // itself rather than trusting them to be brief.
  const r = $('ccReason');
  r.removeAttribute('data-fit');
  for (const step of ['1', '2']) {
    if (r.scrollHeight <= r.clientHeight) break;
    r.dataset.fit = step;
  }
}

// Media can land after the overview was built. Rebuild so a photo uploaded
// on Sunday morning appears without anyone reloading the Browser Source.
desk.on('ready', () => { buildOverview(desk.state?.match); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
