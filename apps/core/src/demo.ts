/**
 * Simulated match driver. Development only: it exists so graphics can be
 * built in July without a field, and so a new volunteer can see the whole
 * show loop within ten seconds of `npm start -- --demo`.
 *
 * Real CalGames 2025 teams, because placeholder names hide layout problems:
 * "Team A" fits anywhere, "Homestead Robotics" does not.
 */

import type { EventBus } from './bus.ts';
import type { ArcadeStore } from './arcade/store.ts';
import type { TriviaStore } from './trivia/store.ts';
import type { Slides, Slide } from './slides.ts';
import type { ProfileBook, Profile } from './profiles.ts';
import type { MediaLibrary } from './media.ts';
import type { CardLedger } from './cards.ts';
import { teamName } from './teams.ts';
import { REBUILT, type Alliance, type RankingRow, type UpcomingMatch } from './types.ts';

// Every demo emission carries this one tag, so a simulated match can never
// pass for field data in a log, a publish decision, or a confidence check.
// index.ts additionally refuses --demo alongside --cheesy and keeps demo
// matches out of the publish auto-queue.
const DEMO_SOURCE = 'demo';

/*
 * Everything below says SAMPLE on its face.
 *
 * Not decoration. Sample data exists to be put on screens, and a screen is
 * the one place where the difference between a test and the event stops being
 * recoverable. If any of this ever reaches a projector by accident, the room
 * should be able to tell at a glance, without knowing anything about how the
 * desk works.
 */

const SAMPLE_SLIDES: Slide[] = [
  {
    id: 'sample-shoutout', kind: 'shoutout',
    title: 'Sample shout-out',
    lines: [
      'This is sample data, not a real submission',
      'Approved shout-outs from the stands look like this',
    ],
  },
  {
    id: 'sample-recognition', kind: 'recognition',
    title: 'Sample recognition',
    lines: ['This is sample data', 'Thanking the setup crew looks like this'],
  },
  {
    id: 'sample-info', kind: 'info',
    title: 'Sample notice',
    lines: ['This is sample data', 'Lunch, a schedule change, a lost phone'],
  },
];

const SAMPLE_PROFILES: Profile[] = [
  {
    id: 'sample-analyst', name: 'Sample Analyst', role: 'Analyst',
    team: null, student: false, display: 'Sample Analyst',
    lastUsedAt: 0, uses: 0,
  },
  {
    id: 'sample-host', name: 'Sample Host', role: 'Host',
    team: null, student: false, display: 'Sample Host',
    lastUsedAt: 0, uses: 0,
  },
  {
    id: 'sample-student', name: 'Sample Student', role: 'Team captain',
    team: 846, student: true, display: 'Sample S.',
    lastUsedAt: 0, uses: 0,
  },
];

/*
 * Every team in the sample is a real CalGames 2026 team, from teams.ts, which
 * is The Blue Alliance's list for 2026cacg plus the event's own pit map.
 *
 * It used to be a made-up regional field (254, 1678, 1868, a five-digit
 * "Rookie Rhinos"), which meant a beta test showed graphics for teams that
 * are not coming, and the long-name and five-digit layouts were exercised by
 * names nobody would ever see. The real field has its own stress cases and
 * they are better ones: 10252 is five digits, "Deep Space
 * Robotics" and "Highlander Robotics" are long, and 9999 is The Wildhats'
 * SECOND robot, which must print as 100B. It is on the sample match on
 * purpose, so a beta test proves the label works on every screen.
 */
const team = (n: number): { number: number; name: string } =>
  ({ number: n, name: teamName(n) });

const RED = [team(846), team(9999), team(253)];
const BLUE = [team(100), team(115), team(670)];

/**
 * Dummy standings, so every surface that renders event data can be judged
 * without a field. The order is invented and deterministic; the teams, names
 * and field size (38, so the rankings rotation pages exactly as it will) are
 * the event's.
 */
const RANK_ORDER = [
  846, 5940, 1700, 2473, 115, 4159, 8033, 840, 100,
  6884, 4904, 670, 253, 1351, 841, 9999, 766, 852, 751,
  6036, 3045, 1854, 1967, 2643, 4765, 4990, 5430, 5499, 6418,
  6619, 6962, 7419, 8404, 9038, 10252, 9998, 9997, 8,
];

const DEMO_RANKINGS: RankingRow[] = RANK_ORDER.map((n, i) => {
  const rp = Math.max(4, 40 - i);
  const wins = Math.max(1, 10 - Math.floor(i / 4));
  return {
    rank: i + 1,
    // A little movement, so the up/down arrows have something to show.
    previousRank: i % 5 === 1 ? i + 2 : i % 5 === 2 ? i : i + 1,
    team: n,
    name: teamName(n),
    rankingPoints: rp,
    avgRp: Math.round((rp / 11) * 10) / 10,
    record: `${wins}-${11 - wins}-0`,
    played: 11,
  };
});

// The published schedule is FIXED at boot (real schedules don't reflow), and
// its 170s pitch is slightly faster than the demo's real ~190s cycle, so the
// behind-schedule readout drifts a few honest minutes over a session, exactly
// like a real event afternoon.
const scheduleAnchor = Date.now();
const scheduledAt = (matchNumber: number): string =>
  new Date(scheduleAnchor + (matchNumber - 42) * 170_000).toISOString();

const upcomingFrom = (n: number): UpcomingMatch[] => {
  // Every roster team must exist in DEMO_RANKINGS: surfaces join rosters
  // against the standings, and an unknown number renders nameless.
  const rosters: [number[], number[]][] = [
    // 10252 is the event's one five-digit team, and the B robots print as
    // five characters too ("6036B"), so this row is the on-deck fit's worst
    // case at this event.
    [[10252, 1700, 6036], [9997, 5940, 9998]],
    [[846, 100, 6884], [253, 115, 4159]],
    [[2473, 8033, 6962], [670, 840, 4904]],
    [[115, 253, 846], [9999, 670, 1351]],
    // Beyond the side screens' four: the phone schedule view sees these.
    [[751, 766, 841], [852, 1854, 1967]],
    [[2643, 3045, 4765], [4990, 5430, 5499]],
    [[6418, 6619, 6962], [7419, 8404, 9038]],
    [[8, 100, 846], [5940, 1700, 2473]],
  ];
  return rosters.map(([red, blue], i) => ({
    name: `Qualification ${n + i}`,
    shortName: `Q${n + i}`,
    time: scheduledAt(n + i),
    red, blue,
  }));
};

/** Seed the arcade so its overlay and console open onto something real-looking. */
function seedArcade(arcade: ArcadeStore): void {
  arcade.startSet({
    game: 'pacman', round: 'Party Round 2',
    players: [
      { id: 'p1', name: 'Ana', team: 846 },
      { id: 'p2', name: 'Ben', team: 1700 },
      { id: 'p3', name: 'Cy', team: 5940 },
      { id: 'p4', name: 'Dee' },
    ],
  });
  arcade.score(0, 3); arcade.score(2, 2); arcade.score(1, 1);
  arcade.startGrandPrix('Pit Crew Cup', [
    { id: 'r1', name: 'Ana', team: 846 },
    { id: 'r2', name: 'Ben', team: 1700 },
    { id: 'r3', name: 'Cy', team: 5940 },
    { id: 'r4', name: 'Dee' },
  ], 4);
  arcade.recordRace(['r2', 'r1', 'r4', 'r3']);
  arcade.recordRace(['r1', 'r4', 'r2', 'r3']);
  arcade.setUpNext('Winners Final · 846 Ana vs 5940 Cy');
}

/** Two instant trivia rounds so the leaderboard and host console render lived-in. */
function seedTrivia(trivia: TriviaStore): void {
  const roster: [string, number?][] = [
    ['Ana', 846], ['Ben', 1700], ['Cy', 5940], ['Dee'],
    ['Evan', 100], ['Fay', 670], ['Gus', 115], ['Hana', 4159],
  ];
  const ids = roster.map(([name, team]) => trivia.join(name, team).playerId);
  for (let round = 0; round < 2; round++) {
    trivia.open(20);
    ids.forEach((id, i) => {
      // A believable spread: most answer B-ish, some miss.
      trivia.answer(id, [1, 1, 0, 3, 1, 2, 1, 1][i]! % 4);
    });
    trivia.reveal();
    trivia.next();
  }
}

/**
 * A selection part-way through, so the board can be looked at without waiting
 * for a Sunday. Four alliances are complete, the fifth captain is on the clock,
 * and the pool still has takeable teams near the top.
 */
function seedSelection(bus: EventBus): void {
  // Captains are the top of the sample standings, picks come from the next
  // ones down, so the board and the pool agree with each other.
  const order = DEMO_RANKINGS.map(r => r.team);
  const alliances = [
    { id: 1, teams: [order[0]!, order[9]!, order[17]!, order[25]!] },
    { id: 2, teams: [order[1]!, order[10]!, order[18]!, order[26]!] },
    { id: 3, teams: [order[2]!, order[11]!, order[19]!, order[27]!] },
    { id: 4, teams: [order[3]!, order[12]!, order[20]!, order[28]!] },
    { id: 5, teams: [order[4]!, order[13]!] },
    { id: 6, teams: [order[5]!] },
    { id: 7, teams: [] as number[] },
    { id: 8, teams: [] as number[] },
  ];
  const picked = new Set(alliances.flatMap(a => a.teams));
  bus.emit({
    type: 'alliance_selection.update',
    source: DEMO_SOURCE,
    payload: {
      // Four per alliance, captain first: CalGames picks a fourth rather than
      // calling a backup later, the way Championship divisions do.
      alliances,
      ranked: DEMO_RANKINGS.slice(0, 24).map(r => ({
        rank: r.rank,
        team: r.team,
        picked: picked.has(r.team),
      })),
      showTimer: true,
      timeRemainingSec: 45,
      updatedAt: Date.now(),
    },
  });
}

export interface DemoExtras {
  arcade?: ArcadeStore;
  trivia?: TriviaStore;
  /**
   * The file-backed stores.
   *
   * Each one gets its sample content through a seedSample() method that
   * writes ONLY to memory. None of them touch data/slides.json,
   * data/profiles.json or media/teams, and that is the whole point: this
   * project has already shipped test residue into the live slides and profile
   * files, where it sat afterwards looking like real shout-outs somebody had
   * approved and real people somebody had put on camera.
   */
  slides?: Slides;
  profiles?: ProfileBook;
  media?: MediaLibrary;
  cards?: CardLedger;
}

/**
 * Fill every surface with believable sample data, once, and stop.
 *
 * The same seed `startDemo` lays down before its match loop, plus a loaded and
 * running match with a score on it, so that a person opening /s/program or a
 * pit monitor during a beta has something to look at. A desk with no field
 * attached and no match loaded draws exactly nothing, which reads as broken
 * rather than as idle, and "does the overlay work" is the first question
 * anybody testing this asks.
 *
 * Deliberately NOT the match loop. A loop is the right thing when you are
 * building graphics and want to watch the whole cycle; it is the wrong thing
 * when you are showing somebody the overlay and want it to hold still.
 *
 * Every event carries DEMO_SOURCE, so nothing here can pass for field data in
 * the event log, in a publish decision, or in a confidence check: the score
 * arrives estimated and the graphics draw it outlined, which is the overlay's
 * existing way of saying "this is a guess".
 */
/**
 * Fill the CONTENT stores with sample material, in memory only.
 *
 * Separate from the bus events below because these are catalogues rather than
 * moments: the slide deck the side screens rotate, the people the lower third
 * can name, the robot photos the overview looks up. A screen that switches to
 * them needs them to already exist.
 *
 * Every one of these goes through a seedSample() that writes only to memory.
 * Nothing here reaches data/slides.json, data/profiles.json or media/teams.
 */
function seedContent(extras: DemoExtras): void {
  extras.slides?.seedSample(SAMPLE_SLIDES);
  extras.profiles?.seedSample(SAMPLE_PROFILES);
  // Two of the six, deliberately. Most teams at an offseason have no photo
  // and get the tier-3 plinth, so an overview where every robot has a picture
  // would be a prettier lie than the one the event will actually show.
  extras.media?.seedSample([846, 971]);
}

/**
 * Everything a screen needs in order not to be blank.
 *
 * The complaint this answers: after running the exe there is no field, no
 * arena and no event, so most surfaces render an empty state and nobody can
 * confirm the desk works. seedStatic covered rankings, the queue, the arcade,
 * trivia and alliance selection, which is about a third of DeskState.
 *
 * TWO THINGS ARE DELIBERATELY NOT SEEDED.
 *
 * The status card, the emergency message and the countdown timer are all
 * TAKEOVERS: the first two paint over whatever screen is up, and the timer
 * replaces the side screen's whole rotation ("A TAKEOVER, not a pane", says
 * the surface itself). Seeding any of them would hide the very content a
 * beta test is trying to look at, for as long as it ran. All three are one
 * button away on the desk console, so they are already testable, and unlike
 * a slide or a sponsor they need no catalogue to exist first.
 *
 * And no award winner, ever. The winner is the one secret the whole
 * architecture exists to keep, and it does not enter the bus before the
 * reveal even in a sample.
 */
function seedScreens(bus: EventBus, matchNumber: number): void {
  const emit = (type: string, payload: unknown): void => {
    bus.emit({ type: type as never, source: DEMO_SOURCE, payload: payload as never });
  };

  // Who is on camera, and the name under them.
  emit('lower_third.show', {
    name: 'Sample Analyst', role: 'Analyst', kind: 'person',
  });
  emit('panel.show', {
    title: 'Sample analysis desk',
    people: [
      { name: 'Sample Analyst', role: 'Analyst', team: null },
      { name: 'Sample S.', role: 'Team captain', team: 846 },
    ],
  });

  // The sponsor plate. Named as a sample, because the whole purpose of this
  // screen is to show somebody's name and getting that wrong on air is the
  // one mistake a sponsor actually notices.
  emit('sponsor.show', {
    id: 'sample-sponsor', name: 'Sample Sponsor',
    line: 'This is sample data, not a real sponsor', logo: null,
  });

  // A slide, so the deck and the slide screen both have something.
  emit('slide.show', SAMPLE_SLIDES[0]);

  // The card-call screen, and only that. NOT card.issued: a card folds into
  // the per-team discipline ledger, which carries across matches for the rest
  // of the phase, and every team number in this sample is a real team. A
  // sample yellow on 253 would have marked Boba Bots as carrying a card on the
  // real event's graphics. card.call is per match and the next load clears it.
  emit('card.call', {
    team: 253, alliance: 'red', color: 'yellow',
    reason: 'Sample card call, not a real penalty',
  });

  // The queuers, the room, and the clock.
  emit('queue.updated', { nowQueuing: `Qualification ${matchNumber + 1}` });
  emit('announcement.posted', {
    text: 'This is sample data. Announcements from the event appear here.',
    from: 'Sample',
  });

  /*
   * An award ON THE PLATE, with no winner.
   *
   * award.show carries the title, the description and the on-air blurb and
   * NOTHING ELSE: the winner appears for the first time at award.presented,
   * at the moment it stops being a secret. That split is the single most
   * load-bearing thing in this codebase, so the sample exercises the safe
   * half of it and leaves the other half alone.
   */
  emit('award.show', {
    id: 'sample-award',
    title: 'Sample Award',
    description: 'This is sample data. A real award description appears here.',
    blurb: 'Presented to nobody, because this is a test.',
  });

  // How late the day is running, so the side screens and the pit monitor have
  // a pace line rather than an empty one.
  emit('pace.updated', {
    cycleSec: 7 * 60,
    nextStartAt: Date.now() + 6 * 60_000,
    behindMin: 6,
    lastStartAt: Date.now() - 60_000,
  });
}

/** True from a sample seed until the sample is cleared. */
let sampleActive = false;
export const sampleIsActive = (): boolean => sampleActive;

/**
 * Take every trace of the sample back off the desk, without a restart.
 *
 * Runs on the button, and AUTOMATICALLY the first time a real match loads,
 * because "restart before the first practice match" is an instruction, and
 * an instruction is the thing a first-time crew forgets. Left in place, the
 * sample is not harmless: its rankings and its alliance board stay on the
 * venue screens for as long as no field is connected, its slides rotate all
 * weekend, two of its trivia rounds count as already asked, and its full
 * alliance board makes the bridge treat the arena's real, still-empty board
 * as "the arena forgot" and refuse it.
 *
 * Only ever removes what the sample put there: sample-prefixed slides,
 * people and drawn photos, and on-air items carrying the sample's own ids or
 * names. Anything real that has replaced them is left alone.
 */
export function clearSampleState(bus: EventBus, extras: DemoExtras = {}): boolean {
  if (!sampleActive) return false;
  sampleActive = false;

  extras.slides?.clearSample();
  extras.profiles?.clearSample();
  extras.media?.clearSample();
  try { extras.trivia?.clearSample(); } catch { /* best effort */ }
  try { extras.arcade?.clearSample(); } catch { /* best effort */ }

  const s = bus.state;
  const emit = (type: string, payload: unknown = {}): void => {
    bus.emit({ type: type as never, source: DEMO_SOURCE, payload: payload as never });
  };
  if (s.slide?.id?.startsWith('sample-')) emit('slide.hide');
  if (s.sponsor?.id === 'sample-sponsor') emit('sponsor.hide');
  if (s.lowerThird && (s.lowerThird as { name?: string }).name === 'Sample Analyst') {
    emit('lower_third.hide');
  }
  if (s.panel?.title === 'Sample analysis desk') emit('panel.hide');
  if (s.award?.id === 'sample-award') emit('award.clear');
  if (s.cardCall?.reason?.startsWith('Sample')) emit('card.call_clear');
  // The sample's pace figures, which it wrote straight into state: "running
  // 6 min behind" stayed on the talent tablet with nothing loaded. Before the
  // unload below, so the pace model can publish its own figure over this.
  emit('pace.updated', { cycleSec: null, nextStartAt: null, behindMin: null, lastStartAt: null });
  // The sample's own match, if nothing real has loaded over it. Left loaded,
  // every screen went on saying "Now playing: Qualification 42" with the
  // sample's teams on the deck.
  const red = (s.match?.red ?? []).map(t => t.number).join(',');
  if (s.match?.id === `q${SAMPLE_MATCH}` && red === RED.map(t => t.number).join(',')) {
    emit('match.unloaded');
  }
  // Lists the sample filled wholesale. A live field or Nexus re-asserts its
  // own within a minute; with nothing connected, empty is the honest answer.
  emit('rankings.updated', { rankings: [], highestPlayedMatch: '' });
  emit('queue.updated', { upcoming: [], nowQueuing: null });
  emit('alliance_selection.update', {
    alliances: [], ranked: [], showTimer: false, timeRemainingSec: 0,
  });
  console.log('[sample] sample data cleared');
  return true;
}

/** The match the sample puts on the field. */
const SAMPLE_MATCH = 42;

export function seedSampleState(bus: EventBus, extras: DemoExtras = {}): void {
  sampleActive = true;
  const matchNumber = SAMPLE_MATCH;
  seedStatic(bus, extras, matchNumber);
  seedContent(extras);

  bus.emit({
    type: 'match.loaded', source: DEMO_SOURCE,
    payload: {
      id: `q${matchNumber}`,
      displayName: `Qualification ${matchNumber}`,
      red: RED, blue: BLUE,
      // A surrogate, because the mark that says "this one does not count for
      // their record" is otherwise impossible to see without a real schedule.
      surrogates: [253],
    },
  });
  bus.emit({ type: 'match.start', source: DEMO_SOURCE });
  bus.emit({
    type: 'score.realtime', source: DEMO_SOURCE, confidence: 'estimated',
    payload: {
      red: { autoFuel: 42, teleopFuel: 66, autoTower: 0, teleopTower: 30, fouls: 0 },
      blue: { autoFuel: 36, teleopFuel: 58, autoTower: 15, teleopTower: 20, fouls: 5 },
    },
  });

  // AFTER the match loads, not before. match.loaded deliberately clears
  // per-match state (the card call among it), so anything seeded ahead of it
  // was wiped by the very next event and the screens stayed empty.
  seedScreens(bus, matchNumber);

  /*
   * Land the program on the match, with no hold.
   *
   * Several of the events above take the screen on purpose: slide.show pins
   * it and sets screenHold, sponsor.show and card.call move it too. Left
   * there, the sample would open on whichever of them happened to be last,
   * held, with the match hidden behind it.
   *
   * Two events: the first puts the screen on the match, the second releases
   * the hold so the desk's own automation can take it from there.
   */
  bus.emit({ type: 'screen.change', source: DEMO_SOURCE, payload: { screen: 'match' } });
  bus.emit({ type: 'screen.change', source: DEMO_SOURCE, payload: { screen: 'auto' } });

  console.log('[sample] sample data seeded on every surface, tagged '
    + `"${DEMO_SOURCE}" so it cannot pass for the field. The log keeps it marked `
    + 'as sample and never replays it, so a restart clears it too.');
}

/** The parts that are the same whether this is a one-shot seed or the loop. */
function seedStatic(bus: EventBus, extras: DemoExtras, matchNumber: number): void {
  bus.emit({
    type: 'rankings.updated', source: DEMO_SOURCE,
    payload: { rankings: DEMO_RANKINGS, highestPlayedMatch: `Q${matchNumber}` },
  });
  // +1: nothing is playing yet at boot, so the queue head is the match the
  // loop is about to load and start, the same convention every post-commit
  // update below follows. Starting the head one further along (+2) made pace
  // latch the first match's behind-schedule figure against the SECOND match's
  // scheduled time, reading ~3 minutes ahead on a demo running dead on time.
  bus.emit({
    type: 'queue.updated', source: DEMO_SOURCE,
    payload: { upcoming: upcomingFrom(matchNumber + 1) },
  });
  try { if (extras.arcade) extras.arcade.asSample(() => seedArcade(extras.arcade!)); } catch (err) {
    console.warn('[demo] arcade seed failed:', (err as Error).message);
  }
  try { if (extras.trivia) extras.trivia.asSample(() => seedTrivia(extras.trivia!)); } catch (err) {
    console.warn('[demo] trivia seed failed:', (err as Error).message);
  }
  seedSelection(bus);
}

export function startDemo(bus: EventBus, extras: DemoExtras = {}): void {
  console.log('[demo] simulated match loop running');
  let matchNumber = 41;
  seedStatic(bus, extras, matchNumber);
  // The catalogues, so START-PRACTICE.cmd does not leave the slide deck, the
  // profile book and the robot photos empty while a match plays. NOT
  // seedScreens: those are momentary overlays, and a lower third pinned over
  // every match of a running demo is not what anybody wants to watch.
  seedContent(extras);

  const loop = async (): Promise<void> => {
    for (;;) {
      matchNumber++;
      bus.emit({
        type: 'match.loaded',
        source: DEMO_SOURCE,
        payload: {
          id: `q${matchNumber}`,
          displayName: `Qualification ${matchNumber}`,
          red: RED, blue: BLUE,
        },
      });

      await sleep(6000);
      // Field ready: program flips to the score bar here, ahead of the
      // announcer's countdown, exactly like the real arming signal.
      bus.emit({ type: 'match.armed', source: DEMO_SOURCE });
      await sleep(2500);
      bus.emit({ type: 'match.start', source: DEMO_SOURCE });

      const score = { red: { fuel: 0, tower: 0 }, blue: { fuel: 0, tower: 0 } };

      // Drive scoring off the real clock so hub state and endgame land right.
      const scoring = setInterval(() => {
        const c = bus.state.matchClock;
        if (c === null || c < REBUILT.AUTO_START || c > REBUILT.MATCH_END) return;
        const hub = bus.state.hubActive;

        for (const side of ['red', 'blue'] as Alliance[]) {
          if (hub !== 'both' && hub !== side) continue;
          if (Math.random() > 0.55) continue;
          const amount = 1 + Math.floor(Math.random() * 4);
          score[side].fuel += amount;
          bus.emit({
            type: 'score.delta', source: DEMO_SOURCE,
            payload: { alliance: side, field: 'fuel', amount },
          });
        }

        if (c > REBUILT.ENDGAME_START + 8 && Math.random() < 0.05) {
          const side: Alliance = Math.random() < 0.5 ? 'red' : 'blue';
          if (score[side].tower >= 90) return;
          const level = (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3;
          score[side].tower += REBUILT.TOWER_TELEOP[level];
          bus.emit({
            type: 'score.delta', source: DEMO_SOURCE,
            payload: { alliance: side, field: 'tower', amount: REBUILT.TOWER_TELEOP[level] },
          });
        }
      }, 400);

      await sleep((REBUILT.MATCH_END - REBUILT.AUTO_START) * 1000 + 1500);
      clearInterval(scoring);

      await sleep(2500);
      bus.emit({ type: 'match.score_posted', source: DEMO_SOURCE });

      // The event moves on: the played match leaves the queue and the
      // standings tick over, so the side screens stay believable.
      bus.emit({
        type: 'rankings.updated', source: DEMO_SOURCE,
        payload: { highestPlayedMatch: `Q${matchNumber}` },
      });
      bus.emit({
        type: 'queue.updated', source: DEMO_SOURCE,
        payload: { upcoming: upcomingFrom(matchNumber + 1) },
      });
      await sleep(9000);
    }
  };

  // The process-level rejection hook would catch this too, but with a message
  // nobody would connect to the demo going quiet.
  void loop().catch(err => console.warn('[demo] loop stopped:', (err as Error).message));
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
