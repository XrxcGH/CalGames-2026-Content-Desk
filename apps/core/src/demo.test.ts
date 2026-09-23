import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { seedSampleState } from './demo.ts';
import { Slides } from './slides.ts';
import { ProfileBook } from './profiles.ts';
import { MediaLibrary } from './media.ts';

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
