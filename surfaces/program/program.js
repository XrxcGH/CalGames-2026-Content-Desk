/**
 * Program overlay: the whole broadcast graphic in one Browser Source.
 *
 * Screens switch on `state.screen`, so the switcher operator never has to
 * change sources mid-show. One URL in OBS, all weekend.
 */

import {
  connect, applyDisplayMode, fitStage, roll, restart, startTicker,
  clockDisplayFor, hubActiveAt, phaseFor, PHASE_LABEL, REBUILT, teamLabel,
} from '/shared/desk-client.js';
import { rpStrip } from '/shared/rp.js';
import { allianceRoster, lineupKey, availablePool, finalVerdict } from '/shared/alliance.js';
import { overviewKeys, overviewChange, backLine } from '/s/program/decide.js';

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
  'cardcall', 'sponsor', 'award', 'slide', 'replay', 'blank',
];
let currentScreen = null;

/**
 * A replay is playing on program: OBS has the clip in a Media Source under
 * this overlay, and the replay cue said so (state.replayOnAir). The overlay
 * stands aside for the clip's length, because the screen it would otherwise
 * show after a match is the full-frame Final, which hid the clip completely.
 * Judged on the desk's clock, and re-judged every frame (see the ticker),
 * because nothing arrives on the bus at the moment a clip ends.
 */
function replayUp(state) {
  const r = state?.replayOnAir;
  return !!r && desk.serverNow < r.at + r.seconds * 1000;
}

/*
 * The pit monitors' copy of this overlay (/s/watch frames it with kiosk=1)
 * never stands aside. Its picture underneath is the live field feed, not
 * OBS, so the clip is not there: standing aside would put a "Replay" chip
 * over the live field and hide the Final score from the pits.
 */
const KIOSK = params.get('kiosk') === '1';

/** The screen this overlay should be on right now. */
const wantedScreen = state =>
  (CLEAN ? 'match' : !KIOSK && replayUp(state) ? 'replay' : state.screen);

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
function paintSelection(sel, state) {
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
        ${picks.map((t, i) => (t
          // A zero is a slot the scorekeeper CLEARED, not a team. Drawing it
          // as an empty slot keeps every later pick in its own column: this
          // used to compact, so blanking a mis-entered first-round pick slid
          // the second-round pick left, on the projector, mid-selection.
          // Printed through teamLabel: a second robot is registered under a
          // placeholder number (9999) that nobody in the hall recognizes.
          ? `<span class="sel-al-team num"${i === 0 ? ' data-captain' : ''}>${escapeHtml(teamLabel(state, t))}</span>`
          : '<span class="sel-al-slot"></span>')).join('')}
        ${'<span class="sel-al-slot"></span>'.repeat(slots)}
      </div>
    </div>`;
  }).join('');

  // Room-scale legibility beats completeness: the teams near the top of the
  // pool are the ones about to be called, and the rest are a scroll nobody
  // can read from the back of the gym anyway. The cut is taken from the teams
  // still AVAILABLE (see availablePool): taken teams are on the board.
  const pool = availablePool(sel, 24);
  $('selPool').innerHTML = pool.map(r =>
    `<div class="sel-pool-team"${r.picked ? ' data-picked' : ''}>
      <span class="sel-pool-rank">${r.rank}</span>
      <span class="sel-pool-num num">${escapeHtml(teamLabel(state, r.team))}</span>
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
function robotCard(team, i, state) {
  // The photo lookup stays on the number (that is the identity); only what is
  // PRINTED follows the label, so a second robot reads 100B, not 9999. The
  // plate is sized off the printed length, since "6036B" is as wide as a
  // five-digit number.
  const media = desk.mediaFor(team.number);
  const text = teamLabel(state, team.number);
  const label = escapeHtml(text);
  const len = text.length;
  // data-team and data-src let a photo that lands later be swapped into this
  // card without rebuilding it (see swapPhotos).
  return `<div class="robot reveal reveal--up" data-photo="${!!media}" data-team="${team.number}"
      data-src="${escapeHtml(media?.src ?? '')}" style="--i:${i}">
    <div class="robot-art">${robotArt(media, text)}</div>
    <div class="robot-id">
      <div class="robot-num num" data-len="${len}">${label}</div>
      <div class="robot-name">${escapeHtml(team.name ?? '')}</div>
    </div>
  </div>`;
}

/** What goes inside a card's plate: the photo, or the team's printed label. */
function robotArt(media, text) {
  return media
    ? `<img src="${media.src}" alt="">`
    // Fallback must look deliberate, since most teams won't have a photo.
    : `<div class="robot-art--fallback"><span class="num" data-len="${text.length}">${escapeHtml(text)}</span></div>`;
}

/**
 * Bring the overview up to date with the match and the photos, rebuilding
 * the cards only when what they say has changed. See overviewKeys: a
 * rebuild replays the robots' entrance, and the desk pushes a whole
 * snapshot for every photo uploaded, so rebuilding on each one made the
 * overview blink on air once per photo.
 */
let ovKeys = null;
function syncOverview(state) {
  const match = state?.match;
  const keys = overviewKeys(match, n => teamLabel(state, n), n => desk.mediaFor(n)?.src ?? null);
  const change = overviewChange(ovKeys, keys);
  ovKeys = keys;
  if (change === 'build') buildOverview(match, state);
  else if (change === 'photos') swapPhotos(state);
  // The heading is text, not a card: kept current without a rebuild.
  if (match) $('ovLabel').textContent = match.displayName ?? '';
}

/**
 * A photo that changed for a team already on the overview goes into its card
 * in place: the card, and the entrance it has already played, stay put.
 * Only cards whose photo actually changed are touched, so the other robots'
 * images are never reloaded.
 */
function swapPhotos(state) {
  for (const id of ['redRobots', 'blueRobots']) {
    for (const card of $(id).children) {
      const team = Number(card.dataset.team);
      const media = desk.mediaFor(team);
      const src = media?.src ?? '';
      if ((card.dataset.src ?? '') === src) continue;
      card.dataset.src = src;
      card.dataset.photo = String(!!media);
      card.querySelector('.robot-art').innerHTML = robotArt(media, teamLabel(state, team));
    }
  }
}

function buildOverview(match, state) {
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
  $('redRobots').innerHTML = (match.red ?? []).map((t, i) => robotCard(t, i, state)).join('');
  $('blueRobots').innerHTML = (match.blue ?? []).map((t, i) => robotCard(t, i, state)).join('');
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

/**
 * The ranking-point badges, and whether the desk is guessing at them.
 *
 * `estimated` is not decoration here. When the bridge is down the operator
 * shadow-scores by hand, and every number on the bar is drawn as an outline to
 * say so. The badges were the one thing that ignored it: a guessed fuel total
 * crossing the Energized threshold lit a badge in exactly the same solid green
 * a field-confirmed one uses, so the overlay asserted a ranking point it had
 * worked out from a desk-typed figure, beside totals it had just admitted were
 * guesses.
 */
function paintRp(container, rp, estimated = false) {
  container.dataset.est = String(!!estimated);
  for (const badge of container.children) {
    badge.dataset.earned = String(!!rp[badge.dataset.rp]);
    badge.dataset.est = String(!!estimated);
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
    paintRp($(`${side}Pips`), s.rp, state.confidence === 'estimated');
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
  // Marks and card lookups stay keyed on the number; only the print is the label.
  const line = t => `<span class="bar-team">${escapeHtml(teamLabel(state, t.number))}${teamMark(t.number, state)}</span>`;
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
  // an outlined breakdown, which is exactly the state a desk that
  // shadow-scored a match is in when the field finally posts the result.
  const estParts = String(state.confidence === 'estimated');
  $('finalRedBreak').dataset.est = estParts;
  $('finalBlueBreak').dataset.est = estParts;
  // The whole alliance, not just the three on the field: in a playoff the
  // fourth pick won this match too, and the social card already names them.
  // The on-air final screen and the card must agree.
  $('finalRedTeams').textContent = allianceRoster(state, 'red').map(t => teamLabel(state, t.number)).join(' · ');
  $('finalBlueTeams').textContent = allianceRoster(state, 'blue').map(t => teamLabel(state, t.number)).join(' · ');
  const estimated = state.totalConfidence === 'estimated';
  paintRp($('finalRedRp'), state.score.red.rp, estimated);
  paintRp($('finalBlueRp'), state.score.blue.rp, estimated);
  paintFinalCards(state);

  /*
   * The verdict is a claim about the result, so it answers to the same flag
   * the totals do.
   *
   * These four lines ran with no confidence check at all. With the bridge down
   * and the desk shadow-scoring, paintFinal correctly drew both totals as
   * white outlines, the overlay's whole convention for "this is a guess", and
   * then printed WINNER in solid white under a solid gold cap between them. If
   * the typed fuel was a few points out, that word named the wrong alliance,
   * in the typography the graphic reserves for the field's own answer.
   *
   * Unofficial gets its own words and no gold cap: the cap is the thing people
   * photograph.
   */
  /*
   * The FIELD's answer when it has given one, and only then our arithmetic.
   *
   * Comparing the two totals is wrong twice over in a playoff. Every double
   * elimination match applies tiebreak criteria, so a level score is resolved
   * on major fouls, then auto fuel, then tower points, and the bracket
   * advances that alliance. And a disqualification is recorded without
   * touching the score, so a DQ'd alliance can hold the higher number. Either
   * way this printed "Tie" in front of the hall, or "Winner" under the
   * alliance that had just been disqualified, while the announcer and the
   * bracket said the opposite.
   *
   * The fallback stays for a desk with no field attached, where it is already
   * labelled unofficial and nobody is being told it is official.
   */
  /*
   * Who is ahead and whether that is a RESULT are two questions, answered in
   * finalVerdict (alliance.js, where it is tested). The gold cap is the claim
   * that it is a result, so it needs the field's total behind it; the words
   * say which kind of claim it is. A shadow-scored match that is clearly
   * decided now reads "Leading, unofficial" instead of showing two outlined
   * totals and no words, as it did while this was one '!estimated && r > b'
   * flag that made the unofficial branch unreachable.
   */
  const result = finalVerdict(state);
  $('finalRedSide').toggleAttribute('data-won', result.won.red);
  $('finalBlueSide').toggleAttribute('data-won', result.won.blue);
  $('finalRedVerdict').textContent = result.verdict.red;
  $('finalBlueVerdict').textContent = result.verdict.blue;

  // Why a level score still has a winner. Only ever the field's wording, and
  // only when the field gave one: inventing a reason would be worse than the
  // silence it replaces.
  const tb = !estimated ? state.tiebreakReason : null;
  $('finalTiebreak').textContent = tb ?? '';
  $('finalTiebreak').hidden = !tb;
  $('finalRedVerdict').dataset.est = String(estimated);
  $('finalBlueVerdict').dataset.est = String(estimated);
}

// ---- status card ----------------------------------------------------------
const STATUS_KIND = {
  delay: 'Field delay', review: 'Under review', fault: 'Arena fault',
  replay: 'Match replay', custom: 'Announcement',
};

let statusLeaveTimer = null;
/** The card being painted, so the ticker can retire its time (see paintBack). */
let statusShown = null;
function paintStatus(status) {
  const card = $('statusCard');
  statusShown = status;
  if (!status) {
    // Fades out rather than disappearing between two frames, which on a
    // broadcast reads as a glitch rather than as the card retiring.
    if (!card.hidden && card.dataset.leaving !== 'true') {
      card.dataset.leaving = 'true';
      // done() re-checks the flag: a status re-shown inside the 500ms fade
      // deletes it, and the stale callback (this timer, or a transitionend
      // from the ENTRANCE transition) must then do nothing. Without the
      // check, clear-then-repost hid the fresh card, and because a status
      // is up precisely when the bus is quiet, "Under review" stayed
      // silently missing until the next event. Same class as hideThird.
      const done = () => {
        if (card.dataset.leaving !== 'true') return;
        card.hidden = true;
        delete card.dataset.leaving;
      };
      card.addEventListener('transitionend', done, { once: true });
      statusLeaveTimer = setTimeout(done, 500);
    }
    return;
  }
  clearTimeout(statusLeaveTimer);
  delete card.dataset.leaving;
  $('statusKind').textContent = STATUS_KIND[status.kind] ?? 'Update';
  $('statusMsg').textContent = status.message;
  paintBack();
  card.hidden = false;
}

/**
 * The card's "Back ~" line, re-judged on every frame as well as every state
 * frame: the moment the time passes is a clock, not a bus event, and a break
 * is exactly when the bus goes quiet. See backLine for why it changes.
 * Its own element, not a suffix on the clamped message. See .sc-back.
 */
const CLOCK = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
function paintBack() {
  // A card on its way out keeps the line it had while it fades.
  if (!statusShown) return;
  const backEl = $('statusBack');
  const text = backLine(statusShown.backAt, desk.serverNow, t => CLOCK.format(t));
  if (text === backEl.textContent && backEl.hidden === !text) return;
  backEl.hidden = !text;
  backEl.textContent = text;
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

const thirdDwell = () => parseFloat(getComputedStyle(document.documentElement)
  .getPropertyValue('--dwell')) || 8000;

/** On air now, for `dwell` ms when unpinned (a whole dwell unless told). */
function showThird(lt, dwell = thirdDwell()) {
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
  // Unseen with no show event: the snapshot after a (re)connect, or this
  // page loading at all. The reducer keeps an unpinned third until somebody
  // hides it, so it can have gone up hours ago, and this used to air it
  // again for a full dwell: the morning's name strip over the afternoon,
  // whenever OBS or a pit kiosk reloaded. It gets what is left of its dwell
  // on the desk's clock, and one whose dwell has run stays retired, as it
  // would had this page been up to watch it go.
  if (!lt.pinned && Number.isFinite(lt.at)) {
    const left = thirdDwell() - (desk.serverNow - lt.at);
    if (left <= 0) {
      hideThird();
      thirdKey = JSON.stringify(lt);
      thirdExpired = true;
      return;
    }
    showThird(lt, left);
    return;
  }
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
  paintBack();

  // The end of a replay is a moment on the clock, not an event: hand the
  // screen back when the clip has run, and only then. Limited to the replay
  // edge so every other switch stays with the state frame below.
  const want = wantedScreen(st);
  if (want !== currentScreen && (want === 'replay' || currentScreen === 'replay')) showScreen(want);
});

// ---- wiring ---------------------------------------------------------------
let lastMatchId = null;

desk.on('state', state => {
  // Cards land mid-match and change what the team lines say, so the key is
  // the lineup AND what everyone on it is carrying. The lineup is the match id
  // PLUS the teams: a playoff substitution re-sends matchLoad with the same id
  // and different teams, and keyed on the id the overview and the scorebug
  // went on naming the swapped-out team for the whole match.
  const teamKey = lineupKey(state) + JSON.stringify(state.cards?.byTeam ?? {})
    + JSON.stringify(state.surrogates ?? []);
  if (teamKey !== lastMatchId) {
    lastMatchId = teamKey;
    paintTeams(state.match, state);
  }
  // Keyed on its own inputs (the lineup and its photos), never on this
  // frame having arrived: the overview animates in, so it must not rebuild
  // for a card, a score, or a snapshot that changed nothing it shows.
  syncOverview(state);
  paintRpStrips(state.thresholds);
  paintScore(state);
  if (state.screen === 'score') paintFinal(state);
  if (state.selection && state.selection.updatedAt !== selStamp) {
    selStamp = state.selection.updatedAt;
    selSeenAt = Date.now();
  }
  if (state.selection) paintSelection(state.selection, state);
  paintThird(CLEAN ? null : state.lowerThird);
  paintPanel(CLEAN ? null : state.panel);
  // The field's own break card yields to an award or a slide on this
  // overlay: the scheduled Awards Break is exactly when the award plate is
  // up, and the plate already says what is happening. The side screens still
  // carry it. An operator's card is never hidden: it is a deliberate take.
  const plateUp = state.screen === 'award' || state.screen === 'slide';
  paintStatus(CLEAN || (state.status?.auto && plateUp) ? null : state.status);
  paintEmergency(state.emergency);
  paintCardCall(state.cardCall);
  paintSponsor(state.sponsor);
  paintAward(state.award);
  paintSlide(state.slide);
  showScreen(wantedScreen(state));
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
let panelLeaveTimer = null;
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
  // The printed team label is part of the key: a label that lands after the
  // first panel paint would otherwise leave a placeholder number up all show.
  const key = JSON.stringify(people)
    + people.map(p => (p.team ? teamLabel(desk.state, p.team) : '')).join('|');
  if (key === panelKey) return;
  panelKey = key;
  strap.hidden = people.length > 0;
  el.dataset.n = String(people.length);

  // Leaving is animated as well as arriving. Up to six name cards vanishing in
  // a single frame reads as a fault; the band drops away the way it came in.
  if (people.length === 0) {
    if (!el.hidden) {
      el.dataset.leaving = 'true';
      // done() re-checks the flag, because the re-show path clears it: a
      // panel hidden and re-shown inside the 500ms leave (a mis-tap fixed,
      // or remove-last then add) used to be blanked by the stale callback,
      // and the keyed early-return above then never touched `hidden` again,
      // so the analysis screen stayed EMPTY while state said three guests
      // were on air. hideThird fixed this class; this one had missed it.
      const done = () => {
        if (el.dataset.leaving !== 'true') return;
        el.hidden = true;
        delete el.dataset.leaving;
      };
      // The timeout is the belt: transitionend does not fire if the element is
      // display:none'd by something else mid-flight, and a panel stuck
      // half-off the bottom of the frame is worse than one that cuts.
      el.addEventListener('transitionend', done, { once: true });
      panelLeaveTimer = setTimeout(done, 500);
    }
    return;
  }
  clearTimeout(panelLeaveTimer);
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
        team.textContent = teamLabel(desk.state, p.team);
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
  //
  // Measured against the PLATE, not the message's own box: .emerg-msg is an
  // auto-height flex item, so its scrollHeight always equals its clientHeight
  // and the old guard could never fire; the fit steps were unreachable and a
  // 200-character message pushed the EVACUATE chip half off the top of frame.
  // The centered flex column overflows in BOTH directions, which scrollHeight
  // cannot see either, so this checks the first and last children against the
  // plate's edges directly.
  const msg = $('emergMsg');
  msg.removeAttribute('data-fit');
  const fits = () => {
    const box = el.getBoundingClientRect();
    const first = el.firstElementChild.getBoundingClientRect();
    const last = el.lastElementChild.getBoundingClientRect();
    return first.top >= box.top - 1 && last.bottom <= box.bottom + 1
      && msg.scrollWidth <= msg.clientWidth;
  };
  for (const step of ['1', '2']) {
    if (fits()) break;
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
    chip.textContent = `${c.color === 'red' ? 'Red card' : 'Yellow card'} · ${teamLabel(state, c.team)}`;
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

/**
 * The awards plate.
 *
 * Keyed on winner + title so the reveal block's entrance animation runs
 * exactly once, at the moment `award.presented` lands, rather than restarting
 * on every state frame while the applause is still going.
 */
let awardKey = '';
function paintAward(award) {
  if (!award) { awardKey = ''; return; }
  const key = `${award.id}|${award.winner ?? ''}`;
  if (key === awardKey) return;
  awardKey = key;

  $('awTitle').textContent = award.title;

  /*
   * The BLURB, not the definition.
   *
   * The committee's real definitions run to six hundred characters. At the
   * plate's 32px over 1180px that is ten lines, and with the reveal card in
   * frame it overflowed 1080 outright. It also duplicated the GA, who is
   * reading that exact paragraph aloud while it sits there. The screen's job
   * is to name the award and orient the hall in one line; the core supplies
   * that line (falling back to the definition's first sentence when nobody
   * wrote one).
   */
  const desc = $('awDesc');
  desc.textContent = award.blurb || award.description || '';

  const reveal = $('awReveal');
  reveal.hidden = !award.revealed;
  /*
   * At the reveal the line goes away. The winner is the whole story from
   * that moment, the hall is applauding rather than reading, and dropping it
   * buys the reveal card its room on the frame instead of competing for it.
   */
  desc.hidden = !!award.revealed;
  if (award.revealed) {
    $('awWinner').textContent = award.winner ?? '';
    const team = $('awTeam');
    team.hidden = !award.team;
    if (award.team) team.textContent = `Team ${teamLabel(desk.state, award.team)}`;
  }
}

const SLIDE_KICKER = {
  recognition: 'Thank you', info: 'Event info', shoutout: 'Shout-out',
};

function paintSlide(slide) {
  if (!slide) return;
  $('slKicker').textContent = SLIDE_KICKER[slide.kind] ?? 'Event info';
  $('slTitle').textContent = slide.title;
  const lines = $('slLines');
  // The kind has to reach the stylesheet, not just the kicker. Only a
  // shout-out ends on an attribution that should read quieter; a recognition
  // or info slide's last line is the substance, and with nothing on the plate
  // carrying the kind the quiet-last-line rule could not be scoped and
  // demoted it on every slide. See .sl-lines in broadcast.css.
  lines.dataset.kind = slide.kind ?? '';
  lines.replaceChildren(...(slide.lines ?? []).map(line => {
    const div = document.createElement('div');
    div.textContent = line;
    return div;
  }));
}

function paintCardCall(call) {
  /*
   * Clear the plate rather than leaving the markup's defaults on it.
   *
   * This used to return early, and the markup shipped with a chip reading
   * "Yellow card" over a team number of "0". So taking the card call screen
   * with no card active put "YELLOW CARD / 0" on the program feed: a penalty
   * against a team that does not exist, in the graphic whose entire job is to
   * name who was penalised and why. The markup carries no numbers now either,
   * so a first paint before any state arrives shows nothing rather than
   * something wrong.
   */
  if (!call) {
    const blank = $('ccPlate');
    delete blank.dataset.color;
    $('ccChip').textContent = '';
    $('ccTeam').textContent = '';
    $('ccName').textContent = '';
    $('ccReason').textContent = '';
    return;
  }
  const plate = $('ccPlate');
  plate.dataset.color = call.color;
  $('ccChip').textContent = call.color === 'red' ? 'Red card' : 'Yellow card';
  // Printed as the label (100B, not 9999); the name lookup below stays on the number.
  $('ccTeam').textContent = teamLabel(desk.state, call.team);
  // The team NAME comes off the loaded match rather than a lookup: the card is
  // always for somebody on the field right now, and a second source of team
  // names is a second thing that can disagree with the score bar.
  const roster = [...(desk.state?.match?.red ?? []), ...(desk.state?.match?.blue ?? [])];
  $('ccName').textContent = roster.find(t => t.number === call.team)?.name ?? '';
  $('ccReason').textContent = call.reason ?? '';

  /*
   * Whoever typed the reason was typing during a match, so the type fits
   * itself rather than trusting them to be brief.
   *
   * Measured against the PLATE, not against the reason's own box. .cc-reason
   * is an auto-height item in a centred flex column, so its scrollHeight can
   * never exceed its clientHeight and the old guard broke on its first pass:
   * the 42px and 34px steps below were unreachable, and a long reason simply
   * grew the column until it ran off the frame. Same dead guard, same fix, as
   * the emergency plate.
   */
  const r = $('ccReason');
  r.removeAttribute('data-fit');
  const fits = () => {
    const box = plate.getBoundingClientRect();
    const first = plate.firstElementChild.getBoundingClientRect();
    const last = plate.lastElementChild.getBoundingClientRect();
    return first.top >= box.top - 1 && last.bottom <= box.bottom + 1;
  };
  for (const step of ['1', '2']) {
    if (fits()) break;
    r.dataset.fit = step;
  }
}

// Media can land after the overview was built, so a photo uploaded on Sunday
// morning appears without anyone reloading the Browser Source. Today it rides
// a snapshot, whose state frame (just before 'ready') has already synced it;
// 'media' is for a client that one day sends the photo list on its own.
// Either way only a photo that changed is swapped, and nothing replays.
desk.on('ready', () => { syncOverview(desk.state); });
desk.on('media', () => { syncOverview(desk.state); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
