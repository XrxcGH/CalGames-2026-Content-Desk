import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { clearSampleState, seedSampleState } from './demo.ts';
import { rebuildFromLog } from './rebuild.ts';
import { rosterList, teamName } from './teams.ts';
import { Slides } from './slides.ts';
import { ProfileBook } from './profiles.ts';
import { MediaLibrary } from './media.ts';
import { TriviaStore } from './trivia/store.ts';
import { ArcadeStore } from './arcade/store.ts';

/**
 * The sample-data seed exists because a volunteer who double-clicks the
 * shipped exe has no field, no arena and no event, and most surfaces render
 * an empty state. Without this they cannot confirm the desk works at all.
 */

const stores = (root: string, bus: EventBus) => ({
  slides: new Slides(root, bus, []),
  profiles: new ProfileBook(root),
  media: new MediaLibrary(join(root, 'media')),
});

test('the sample seed fills the screens that are otherwise blank', () => {
  const bus = new EventBus();
  const before = bus.state;
  // The state a volunteer actually meets after starting the exe.
  for (const k of ['match', 'rankings', 'slide', 'sponsor', 'panel'] as const) {
    assert.ok(
      before[k] === null || (Array.isArray(before[k]) && !(before[k] as unknown[]).length),
      `${k} starts empty, which is the complaint`,
    );
  }

  seedSampleState(bus);
  const s = bus.state;

  // Everything a screen needs in order to show something.
  assert.equal(s.match?.displayName, 'Qualification 42');
  assert.ok(s.rankings.length > 0, 'rankings');
  assert.ok(s.upcoming.length > 0, 'the on-deck queue');
  assert.ok(s.slide, 'the slide screen');
  assert.ok(s.sponsor, 'the sponsor plate');
  assert.ok(s.panel, 'the analysis panel');
  assert.ok(s.lowerThird, 'the lower third');
  assert.ok(s.cardCall, 'the card call screen');
  assert.ok(s.award, 'an award on the plate');
  assert.ok(s.announcement, 'the announcement rail');
  assert.ok(s.nowQueuing, 'the queueing banner');
  assert.ok(s.selection, 'the alliance selection board');
  assert.ok(s.match?.surrogates?.length, 'the surrogate mark');

  // The three takeovers are deliberately NOT seeded: the status card and the
  // emergency plate paint over whatever screen is up, and the timer replaces
  // the side screen's entire rotation. Seeding any of them would hide the
  // content a beta test is trying to look at. All three are one console
  // button away.
  assert.equal(s.status, null, 'no status card over the sample match');
  assert.equal(s.emergency, null, 'and certainly no emergency');
  assert.equal(s.timer, null, 'and no countdown hiding the side screen');
  assert.ok(s.score.red.total > 0 && s.score.blue.total > 0, 'a live score');
});

test('the seed lands on the match, with no hold left behind', () => {
  // slide.show pins the screen and sets screenHold; sponsor.show and card.call
  // move it too. Left alone, the sample opened on whichever of them happened
  // to be last, held, with the match hidden behind it.
  const bus = new EventBus();
  seedSampleState(bus);
  assert.equal(bus.state.screen, 'match');
  assert.equal(bus.state.screenHold, false,
    'a hold would stop the desk\'s own automation dead');
});

test('every sample event is tagged demo, so none of it can pass for the field', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.source));
  seedSampleState(bus);

  assert.ok(seen.length > 10, 'it emitted something');
  const foreign = [...new Set(seen)].filter(src => src !== 'demo' && src !== 'clock');
  assert.deepEqual(foreign, [],
    `every event must be demo-sourced, got: ${foreign.join(', ')}`);
  assert.equal(bus.state.totalConfidence, 'estimated',
    'and the score draws outlined, never solid');
});

test('no award winner reaches the bus, even in a sample', () => {
  /*
   * award.show carries the title, the description and the on-air blurb and
   * nothing else. The winner appears for the first time at award.presented,
   * at the moment it stops being a secret. That split is the single most
   * load-bearing thing in this codebase, and a sample that shortcut it would
   * be teaching the wrong lesson in the one place it cannot be unlearned.
   */
  const bus = new EventBus();
  const frames: string[] = [];
  bus.subscribe(ev => frames.push(JSON.stringify(ev)));
  seedSampleState(bus);

  assert.equal(frames.some(f => f.includes('award.presented')), false,
    'nothing presents an award');
  const award = bus.state.award;
  assert.ok(award, 'an award is on the plate');
  // The reducer hard-nulls these on award.show whatever the payload said, so
  // the guarantee holds even against a caller that tried to smuggle one in.
  assert.equal(award?.winner, null, 'and it carries no winner');
  assert.equal(award?.team, null);
  assert.equal(award?.revealed, false);
});

test('seeding sample data writes nothing to disk', async () => {
  /*
   * The whole reason the content stores get a seedSample() rather than a
   * normal add() or upsert(). This project has already shipped test residue
   * into data/slides.json and data/profiles.json, where it sat afterwards
   * looking like real shout-outs somebody had approved and real people
   * somebody had put on camera. A sample that persists is not a sample.
   */
  const root = await mkdtemp(join(tmpdir(), 'cg-sample-'));
  try {
    const bus = new EventBus();
    const st = stores(root, bus);
    seedSampleState(bus, st);

    // The stores are populated in memory.
    assert.ok(st.slides.deck.some(s => s.id.startsWith('sample-')), 'slides in memory');
    assert.ok(st.profiles.list.some(p => p.id.startsWith('sample-')), 'profiles in memory');
    assert.ok(Object.keys(st.media.airable).length > 0, 'robot photos in memory');

    // And nothing reached the disk.
    let left: string[] = [];
    try { left = await readdir(root); } catch { left = []; }
    assert.deepEqual(left, [],
      `sample data wrote to disk: ${left.join(', ')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the sample robot photos point at the drawn placeholder, not a file', () => {
  // There is no invented photograph of a real team's robot anywhere on disk.
  // The src is a route that draws an obvious placeholder from a team number.
  const bus = new EventBus();
  const media = new MediaLibrary(join(tmpdir(), 'cg-sample-media-none'));
  seedSampleState(bus, { media });

  const entries = Object.values(media.airable);
  assert.ok(entries.length > 0);
  for (const m of entries) {
    assert.match(m.src, /^\/sample\/robot\/\d+\.svg$/, m.src);
    assert.ok(m.warnings.some(w => /sample/i.test(w)), 'it says what it is');
  }
});

test('re-seeding does not stack a second copy of the sample', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cg-sample-'));
  try {
    const bus = new EventBus();
    const st = stores(root, bus);
    seedSampleState(bus, st);
    const onceSlides = st.slides.deck.length;
    const onceProfiles = st.profiles.list.length;

    seedSampleState(bus, st);
    assert.equal(st.slides.deck.length, onceSlides, 'slides');
    assert.equal(st.profiles.list.length, onceProfiles, 'profiles');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clearing the sample takes every trace of it back off the desk', async () => {
  /*
   * The handbook used to say "restart before the first practice match", which
   * is an instruction, and an instruction is the thing a first-time crew
   * forgets. Left in place the sample is not harmless: its rankings and its
   * alliance board stay on the venue screens whenever no field is connected,
   * its slides rotate all weekend, and its full alliance board makes the
   * bridge refuse the arena's real, still-empty one as "the arena forgot".
   */
  const root = await mkdtemp(join(tmpdir(), 'cg-sample-'));
  try {
    const bus = new EventBus();
    const st = stores(root, bus);
    seedSampleState(bus, st);
    assert.ok(bus.state.rankings.length && bus.state.selection?.alliances.length);

    assert.equal(clearSampleState(bus, st), true);
    const s = bus.state;
    assert.equal(st.slides.deck.some(x => x.id.startsWith('sample-')), false, 'slides');
    assert.equal(st.profiles.list.some(p => p.id.startsWith('sample-')), false, 'people');
    assert.deepEqual(Object.keys(st.media.airable), [], 'drawn photos');
    assert.equal(s.slide, null, 'the slide on air');
    assert.equal(s.sponsor, null, 'the sample sponsor');
    assert.equal(s.panel, null);
    assert.equal(s.lowerThird, null);
    assert.equal(s.award, null);
    assert.equal(s.cardCall, null);
    assert.deepEqual(s.rankings, [], 'sample standings');
    assert.deepEqual(s.upcoming, [], 'sample schedule');
    assert.equal(s.nowQueuing, null);
    assert.deepEqual(s.selection?.alliances, [], 'and the sample alliance board');
    assert.equal(s.match, null, 'and the sample match, so no screen says it is playing');
    assert.equal(s.pace.behindMin, null, 'and its "running 6 min behind"');
    assert.equal(s.pace.nextStartAt, null);
    assert.deepEqual(s.deck.rows, [], 'and nothing of it on the on-deck list');

    assert.equal(clearSampleState(bus, st), false, 'twice is a no-op');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sample is never folded back in by the restart rebuild', async () => {
  // The Sample data button logs into the real day's log. The rebuild used to
  // replay it on every restart, so a sample on event morning came back as a
  // real team's yellow card, a sponsor-report airing and a coverage row.
  const dir = await mkdtemp(join(tmpdir(), 'cg-rebuild-'));
  try {
    const { localStamp } = await import('./bus.ts');
    const name = `${localStamp(new Date())}.ndjson`;
    const line = (source: string, team: number) => JSON.stringify({
      id: 'x', ts: Date.now(), matchClock: null, source, confidence: 'estimated',
      type: 'card.issued', payload: { team, color: 'yellow', match: 'Qualification 42' },
    });
    await writeFile(join(dir, name), `${line('demo', 253)}\n${line('cheesy', 846)}\n`);
    const seen: number[] = [];
    await rebuildFromLog(dir, [{ observe: ev => seen.push((ev.payload as { team: number }).team) }]);
    assert.deepEqual(seen, [846], 'the field\'s card survives, the sample\'s does not');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the sample quiz and arcade never survive a restart, and a clear keeps the real room', async () => {
  // Trivia and the arcade publish through their own stores, which stamped the
  // sample 'manual'. The restart restore then brought back eight sample
  // players, two rounds marked asked and the Pit Crew Cup, with nothing left
  // that knew they were sample. And the clear used to wipe the whole quiz,
  // real players included.
  const dir = await mkdtemp(join(tmpdir(), 'cg-sample-quiz-'));
  try {
    const bus = new EventBus();
    await bus.openLog(dir);
    const trivia = new TriviaStore(bus);
    const arcade = new ArcadeStore(bus);
    trivia.join('Rosa', 846);
    seedSampleState(bus, { trivia, arcade });
    assert.ok(trivia.snapshot().standings.some(r => r.name === 'Ana'), 'the sample is up');
    assert.ok(arcade.snapshot.gp && arcade.snapshot.set);
    // A real player joins while the sample is still up: this publish is real
    // and its snapshot still lists the sample's players.
    trivia.join('Theo', 1700);
    await bus.closeLog();

    const trivia2 = new TriviaStore(new EventBus());
    const arcade2 = new ArcadeStore(new EventBus());
    await rebuildFromLog(dir, [trivia2, arcade2]);
    assert.deepEqual(trivia2.snapshot().standings.map(r => r.name).sort(), ['Rosa', 'Theo']);
    assert.equal(trivia2.snapshot().asked, 0, 'the sample rounds do not count');
    assert.equal(arcade2.snapshot.gp, null);
    assert.equal(arcade2.snapshot.set, null);
    assert.equal(arcade2.snapshot.upNext, '');

    assert.equal(clearSampleState(bus, { trivia, arcade }), true);
    assert.deepEqual(trivia.snapshot().standings.map(r => r.name).sort(), ['Rosa', 'Theo'], 'the clear keeps real players');
    assert.equal(trivia.snapshot().asked, 0, 'joining is not playing: the sample rounds come off');
    assert.equal(arcade.snapshot.gp, null);
    assert.equal(arcade.snapshot.set, null);
    assert.equal(arcade.snapshot.upNext, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a clear with no real play since the seed puts the quiz back exactly as it was', () => {
  const bus = new EventBus();
  const trivia = new TriviaStore(bus);
  trivia.join('Rosa', 846);
  seedSampleState(bus, { trivia });
  assert.equal(trivia.snapshot().asked, 2);
  clearSampleState(bus, { trivia });
  assert.equal(trivia.snapshot().asked, 0, 'the two sample rounds are unasked again');
  assert.deepEqual(trivia.snapshot().standings.map(r => r.name), ['Rosa']);

  // But once a real question has been played, the progress is real.
  seedSampleState(bus, { trivia });
  trivia.open(20); trivia.reveal(); trivia.next();
  clearSampleState(bus, { trivia });
  assert.equal(trivia.snapshot().asked, 3);
  assert.deepEqual(trivia.snapshot().standings.map(r => r.name), ['Rosa']);
});

test('a second robot prints as its label and keeps its team\'s name', () => {
  /*
   * CalGames registers The Wildhats' second robot as 9999. TBA names every
   * such number "Off-Season Demo Team 9999, Manchester NH", and Cheesy Arena
   * takes its nicknames from TBA, so without an override that is what the
   * field would hand the desk to put on air.
   */
  assert.equal(teamName(9999, 'Off-Season Demo Team 9999'), 'The Wildhats');
  assert.equal(teamName(9998, 'Off-Season Demo Team 9998'), 'Peninsula Robotics');
  assert.equal(teamName(9997, 'Off-Season Demo Team 9997'), 'CardinalBotics');
  // Everyone else keeps what the field says: that is what the scorekeeper
  // corrects on the day. The table is only the fallback.
  assert.equal(teamName(846, 'Funky Monkeys (fixed)'), 'Funky Monkeys (fixed)');
  assert.equal(teamName(846, ''), 'The Funky Monkeys');

  const bus = new EventBus();
  bus.emit({ type: 'event.teams', source: 'manual', payload: { list: rosterList() } });
  assert.equal(bus.state.teams['9999']?.label, '100B');
  assert.equal(bus.state.teams['10252']?.name, 'Mecha Lions');
  assert.equal(bus.state.teams['10615'], undefined, '10615 withdrew');
  assert.equal(Object.keys(bus.state.teams).length, 38, 'every CalGames 2026 team');

  // And the sample puts 100B on the field, so a beta test shows the label.
  seedSampleState(bus);
  assert.ok(bus.state.match?.red.some(t => t.number === 9999 && t.name === 'The Wildhats'));
});
