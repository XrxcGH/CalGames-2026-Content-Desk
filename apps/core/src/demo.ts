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

const RED = [
  { number: 846, name: 'The Funky Monkeys' },
  { number: 1868, name: 'Space Cookies' },
  { number: 253, name: 'Boba Bots' },
];
const BLUE = [
  { number: 100, name: 'The Wildhats' },
  { number: 115, name: 'MVRT' },
  { number: 670, name: 'Homestead Robotics' },
];

/**
 * Dummy standings and schedule, so every surface that renders event data can
 * be judged aesthetically without a field, the side screens especially,
 * whose empty states ("schedule not published yet") hide the real layout.
 */
const DEMO_RANKINGS: RankingRow[] = [
  { rank: 1, previousRank: 1, team: 254, name: 'The Cheesy Poofs', rankingPoints: 38, avgRp: 3.5, record: '10-1-0', played: 11 },
  { rank: 2, previousRank: 3, team: 846, name: 'The Funky Monkeys', rankingPoints: 34, avgRp: 3.1, record: '8-2-1', played: 11 },
  { rank: 3, previousRank: 2, team: 1678, name: 'Citrus Circuits', rankingPoints: 33, avgRp: 3.0, record: '8-3-0', played: 11 },
  { rank: 4, previousRank: 5, team: 1868, name: 'Space Cookies', rankingPoints: 31, avgRp: 2.8, record: '7-3-1', played: 11 },
  { rank: 5, previousRank: 4, team: 100, name: 'The Wildhats', rankingPoints: 29, avgRp: 2.6, record: '7-4-0', played: 11 },
  { rank: 6, previousRank: 6, team: 115, name: 'MVRT', rankingPoints: 27, avgRp: 2.5, record: '6-5-0', played: 11 },
  { rank: 7, previousRank: 8, team: 670, name: 'Homestead Robotics', rankingPoints: 25, avgRp: 2.3, record: '6-5-0', played: 11 },
  { rank: 8, previousRank: 7, team: 253, name: 'Boba Bots', rankingPoints: 24, avgRp: 2.2, record: '5-6-0', played: 11 },
  { rank: 9, previousRank: 9, team: 5940, name: 'BREAD', rankingPoints: 22, avgRp: 2.0, record: '5-6-0', played: 11 },
  { rank: 10, previousRank: 11, team: 649, name: 'M-SET Fish', rankingPoints: 20, avgRp: 1.8, record: '4-7-0', played: 11 },
  { rank: 11, previousRank: 10, team: 8033, name: 'Highlander Robotics', rankingPoints: 19, avgRp: 1.7, record: '4-7-0', played: 11 },
  // A 5-digit rookie, on purpose: it exercises the widest-number layouts.
  { rank: 12, previousRank: 12, team: 25801, name: 'Rookie Rhinos', rankingPoints: 17, avgRp: 1.5, record: '3-8-0', played: 11 },
  // A realistically sized field (~36 teams), so the rankings rotation pages
  // through several screens exactly as it will at the event.
  ...([
    [192, 'Gunn Robotics'], [604, 'Quixilver'], [668, 'Apes of Wrath'],
    [751, 'Barn 2 Robotics'], [841, 'BERT'], [852, 'The Athenians'],
    [972, 'Iron Claw'], [1072, 'Harker Robotics'], [1280, 'Ragin\' C-Biscuits'],
    [1351, 'TKO'], [1458, 'Red Tie Robotics'], [1662, 'Raptor Force'],
    [2035, 'Rockin\' Bots'], [2135, 'Presentation Invasion'], [2367, 'Lancer Robotics'],
    [2473, 'Goldstrikers'], [2489, 'The Insomniacs'], [3045, 'Gear Gremlins'],
    [3256, 'WarriorBorgs'], [4990, 'Gryphon Robotics'], [5026, 'Iron Panthers'],
    [5924, 'Golden Gears'], [6418, 'The Missfits'], [7419, 'Tech Support'],
  ] as [number, string][]).map(([team, name], i) => ({
    rank: 13 + i,
    previousRank: 13 + i,
    team,
    name,
    rankingPoints: Math.max(0, 16 - i),
    avgRp: Math.round((Math.max(0, 16 - i) / 11) * 10) / 10,
    record: `${Math.max(0, 3 - (i >> 3))}-${8 + (i >> 3)}-0`,
    played: 11,
  })),
];

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
    // 25801 in the worst slot on purpose: the on-deck fit has to survive it.
    [[254, 25801, 1072], [1678, 649, 8033]],
    [[846, 100, 649], [253, 115, 5940]],
    [[1868, 8033, 254], [670, 1072, 1678]],
    [[115, 253, 846], [25801, 670, 1868]],
    // Beyond the side screens' four: the phone schedule view sees these.
    [[604, 668, 972], [841, 852, 192]],
    [[1072, 1280, 1351], [1458, 1662, 2035]],
    [[846, 254, 670], [1868, 100, 115]],
    [[2473, 2489, 3045], [5026, 5924, 6418]],
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
      { id: 'p2', name: 'Ben', team: 1868 },
      { id: 'p3', name: 'Cy', team: 254 },
      { id: 'p4', name: 'Dee' },
    ],
  });
  arcade.score(0, 3); arcade.score(2, 2); arcade.score(1, 1);
  arcade.startGrandPrix('Pit Crew Cup', [
    { id: 'r1', name: 'Ana', team: 846 },
    { id: 'r2', name: 'Ben', team: 1868 },
    { id: 'r3', name: 'Cy', team: 254 },
    { id: 'r4', name: 'Dee' },
  ], 4);
  arcade.recordRace(['r2', 'r1', 'r4', 'r3']);
  arcade.recordRace(['r1', 'r4', 'r2', 'r3']);
  arcade.setUpNext('Winners Final · 846 Ana vs 254 Cy');
}

/** Two instant trivia rounds so the leaderboard and host console render lived-in. */
function seedTrivia(trivia: TriviaStore): void {
  const roster: [string, number?][] = [
    ['Ana', 846], ['Ben', 1868], ['Cy', 254], ['Dee'],
    ['Evan', 100], ['Fay', 670], ['Gus', 115], ['Hana', 649],
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
  const picked = new Set([
    254, 846, 1678, 25801, 100, 1868, 649, 8033,
    115, 253, 1072, 5940, 670, 604, 668, 751, 841, 852, 972,
  ]);
  bus.emit({
    type: 'alliance_selection.update',
    source: DEMO_SOURCE,
    payload: {
      // Four per alliance, captain first: CalGames picks a fourth rather than
      // calling a backup later, the way Championship divisions do.
      alliances: [
        { id: 1, teams: [254, 846, 1678, 25801] },
        { id: 2, teams: [100, 1868, 649, 8033] },
        { id: 3, teams: [115, 253, 1072, 5940] },
        { id: 4, teams: [670, 604, 668, 751] },
        { id: 5, teams: [841, 852] },
        { id: 6, teams: [972] },
        { id: 7, teams: [] },
        { id: 8, teams: [] },
      ],
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

  // Discipline: a card on a team, and the card-call screen that explains it.
  emit('card.issued', {
    team: 253, alliance: 'red', color: 'yellow', match: `Qualification ${matchNumber}`,
  });
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

export function seedSampleState(bus: EventBus, extras: DemoExtras = {}): void {
  const matchNumber = 42;
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
    + `"${DEMO_SOURCE}" so it cannot pass for the field. Nothing was written `
    + 'to disk: a restart clears it.');
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
  try { if (extras.arcade) seedArcade(extras.arcade); } catch (err) {
    console.warn('[demo] arcade seed failed:', (err as Error).message);
  }
  try { if (extras.trivia) seedTrivia(extras.trivia); } catch (err) {
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
