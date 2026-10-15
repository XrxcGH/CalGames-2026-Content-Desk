import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import { ArcadeStore } from './store.ts';
import { MK_POINTS, setWinner, standings, type ArcadePlayer, type GrandPrix } from './model.ts';
import type { DeskEvent } from '../types.ts';

const racers = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
const gp = (races: string[][]): GrandPrix =>
  ({ game: 'mariokart', name: 'Pit Crew Cup', racers, races, raceCount: 4 });

test('grand prix points follow the MK8D table', () => {
  assert.deepEqual([...MK_POINTS].slice(0, 4), [15, 12, 10, 9]);

  const table = standings(gp([['a', 'b', 'c', 'd']]));
  assert.deepEqual(table.map(s => [s.player.id, s.points]), [
    ['a', 15], ['b', 12], ['c', 10], ['d', 9],
  ]);
});

test('points accumulate across races', () => {
  const table = standings(gp([
    ['a', 'b', 'c', 'd'],
    ['d', 'c', 'b', 'a'],
  ]));
  // a: 15 + 9 = 24, b: 12 + 10 = 22, c: 10 + 12 = 22, d: 9 + 15 = 24
  assert.deepEqual(
    table.map(s => [s.player.id, s.points]),
    [['a', 24], ['d', 24], ['b', 22], ['c', 22]],
  );
});

test('ties break on best single finish, as Mario Kart does', () => {
  // a: 1st then 4th  -> 15 + 9  = 24, best finish 1
  // b: 2nd then 2nd  -> 12 + 12 = 24, best finish 2
  // c: 3rd then 1st  -> 10 + 15 = 25
  // d: 4th then 3rd  ->  9 + 10 = 19
  const table = standings(gp([
    ['a', 'b', 'c', 'd'],
    ['c', 'b', 'd', 'a'],
  ]));

  assert.deepEqual(table.map(s => [s.player.id, s.points]), [
    ['c', 25], ['a', 24], ['b', 24], ['d', 19],
  ]);
  // a and b are level on 24; a placed 1st once and b never better than 2nd.
  assert.equal(table[1]?.player.id, 'a', 'best single finish wins the tie');
  assert.equal(table[2]?.player.id, 'b');
});

test('positions are recorded for the detail line', () => {
  const table = standings(gp([['c', 'a', 'b', 'd'], ['a', 'c', 'd', 'b']]));
  const a = table.find(s => s.player.id === 'a')!;
  assert.deepEqual(a.positions, [2, 1]);
});

test('an unknown racer id is ignored rather than crashing the overlay', () => {
  const table = standings(gp([['a', 'ghost', 'b']]));
  assert.equal(table.find(s => s.player.id === 'a')?.points, 15);
  assert.equal(table.length, 4, 'no phantom row is created');
});

test('a set is decided at best-of-three', () => {
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  const base = {
    id: 's1', game: 'smash' as const, round: 'Winners Semifinal',
    players, state: 'live' as const, scoreConfidence: 'estimated' as const,
  };

  assert.equal(setWinner({ ...base, scores: [1, 1] }), null);
  assert.equal(setWinner({ ...base, scores: [2, 0] })?.id, 'p1');
  assert.equal(setWinner({ ...base, scores: [1, 2] })?.id, 'p2');
  // Best of five needs three.
  assert.equal(setWinner({ ...base, scores: [2, 1] }, 5), null);
  assert.equal(setWinner({ ...base, scores: [3, 1] }, 5)?.id, 'p1');
});

test('a free-for-all never auto-completes; a versus set still does', () => {
  const ffa = {
    id: 's1', game: 'pacman' as const, round: 'Party 1',
    players: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id })),
    scores: [9, 2, 5, 2],
    state: 'live' as const, scoreConfidence: 'authoritative' as const,
  };
  // 9 is far past any best-of threshold, but with 4 players nobody "wins" a
  // set automatically: a Pac-Man party ends when the operator ends it.
  assert.equal(setWinner(ffa), null);

  const versus = { ...ffa, players: ffa.players.slice(0, 2), scores: [2, 0] };
  assert.equal(setWinner(versus)?.id, 'a');
});

test('a malformed race result is refused before it can poison the standings', () => {
  const store = new ArcadeStore(new EventBus());
  store.startGrandPrix('Pit Crew Cup', racers);
  // These once pushed first and threw later, which left every subsequent
  // snapshot throwing until the bad entry was popped by hand.
  assert.throws(() => store.recordRace('a' as unknown as string[]), /finishing order/);
  assert.throws(() => store.recordRace([1, 2] as unknown as string[]), /finishing order/);
  store.recordRace(['a', 'b', 'c', 'd']);
  assert.equal(store.snapshot.standings[0]?.points, 15, 'the store stays healthy');
  assert.throws(
    () => store.startGrandPrix('Bad', 'nope' as unknown as ArcadePlayer[]),
    /id and a name/);
});

test('a set carries its start time from start through score to end', () => {
  const store = new ArcadeStore(new EventBus());
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  const before = Date.now();
  const set = store.startSet({ game: 'smash', round: 'Winners Semifinal', players });

  // The publish auto-queue cuts the set's video from startedAt to set_end,
  // so a restamp anywhere along the way would cut the wrong footage.
  assert.ok(typeof set.startedAt === 'number' && set.startedAt >= before,
    'startSet stamps the wall clock');
  const startedAt = set.startedAt;
  store.score(0, 1);
  assert.equal(store.snapshot.set?.startedAt, startedAt, 'scoring must not restamp the set');
  store.endSet();
  assert.equal(store.snapshot.set?.startedAt, startedAt, 'the end still carries the start');
});

test('set_end announces once, even when the operator confirms an auto-complete', () => {
  const bus = new EventBus();
  let ends = 0;
  bus.subscribe(ev => { if (ev.type === 'arcade.set_end') ends++; });

  const store = new ArcadeStore(bus);
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  store.startSet({ game: 'smash', round: 'Grand Final', players });
  store.score(0, 1);
  store.score(0, 1);              // Bo3 decided: set_end fires here
  store.endSet();                 // the operator's confirming tap
  assert.equal(ends, 1, 'a doubled set_end would queue the same video twice');
});

test('a best-of-5 set completes at three wins, not two', () => {
  const store = new ArcadeStore(new EventBus());
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  store.startSet({ game: 'smash', round: 'Grand Final', players, bestOf: 5 });
  store.score(0, 1);
  store.score(0, 1);
  assert.equal(store.snapshot.set?.state, 'live', 'two wins do not end a Bo5');
  store.score(0, 1);
  assert.equal(store.snapshot.set?.state, 'complete');

  assert.throws(
    () => store.startSet({ game: 'smash', round: 'Bad', players, bestOf: 4 }),
    /best of 3 or best of 5/);
  store.startSet({ game: 'smash', round: 'Winners Final', players });
  store.score(1, 1);
  store.score(1, 1);
  assert.equal(store.snapshot.set?.state, 'complete', 'the default is still best of 3');
});

test('a NaN score delta is refused rather than poisoning the set', () => {
  const store = new ArcadeStore(new EventBus());
  store.startSet({ game: 'smash', round: 'Winners Final',
    players: [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Ben' }] });
  assert.throws(() => store.score(0, Number('one')), /must be a number/);
  // The set is untouched and still scorable.
  const set = store.score(0, 1);
  assert.deepEqual(set?.scores, [1, 0]);
});

test('starting a new set over a live one announces the old set_end first', () => {
  const bus = new EventBus();
  const ends: unknown[] = [];
  bus.subscribe(ev => { if (ev.type === 'arcade.set_end') ends.push(ev); });
  const store = new ArcadeStore(bus);

  store.startSet({ game: 'smash', round: 'Round 1',
    players: [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Ben' }] });
  // Operator abandons it and starts the next: subscribers (the publish
  // auto-queue cuts each set video off set_end) must hear the first one close.
  store.startSet({ game: 'smash', round: 'Round 2',
    players: [{ id: 'p3', name: 'Cy' }, { id: 'p4', name: 'Dee' }] });
  assert.equal(ends.length, 1, 'the interrupted set announced its end');

  // A completed set does NOT re-announce when the next one starts.
  store.score(0, 1); store.score(0, 1);            // auto-completes best-of-3
  assert.equal(ends.length, 2);
  store.startSet({ game: 'smash', round: 'Round 3',
    players: [{ id: 'p5', name: 'Eve' }, { id: 'p6', name: 'Fay' }] });
  assert.equal(ends.length, 2, 'no duplicate set_end for an already-complete set');
});

test('a duplicated racer id in a finishing order is refused', () => {
  const store = new ArcadeStore(new EventBus());
  store.startGrandPrix('Pit Crew Cup', racers as ArcadePlayer[], 4);
  assert.throws(() => store.recordRace(['a', 'a', 'c', 'd']), /appears twice/);
  // Nothing was recorded, and a clean order still lands.
  const after = store.recordRace(['a', 'b', 'c', 'd']);
  assert.equal(after?.races.length, 1);
});

test('boxes hide one at a time and come back together', () => {
  const store = new ArcadeStore(new EventBus());
  assert.deepEqual(store.snapshot.boxes, { card: true, ffa: true, gp: true, upNext: true });

  store.setBox('gp', false);
  assert.equal(store.snapshot.boxes.gp, false);
  assert.equal(store.snapshot.boxes.card, true, 'hiding one box must not touch the others');

  store.setBox('upNext', false);
  store.showAllBoxes();
  assert.deepEqual(store.snapshot.boxes, { card: true, ffa: true, gp: true, upNext: true });
});

test('clearing the segment puts every box back', () => {
  const store = new ArcadeStore(new EventBus());
  store.setBox('card', false);
  store.setBox('gp', false);
  // Otherwise the next segment's graphic is swallowed by a switch somebody
  // flicked twenty minutes earlier, with nothing on screen to explain it.
  store.clear();
  assert.deepEqual(store.snapshot.boxes, { card: true, ffa: true, gp: true, upNext: true });
});

test('an unknown box is refused rather than silently ignored', () => {
  const store = new ArcadeStore(new EventBus());
  assert.throws(() => store.setBox('scoreboard' as never, false), /no "scoreboard" box/);
});

// ---------------------------------------------------------------------------
// Restore: the boot-time rebuild feeds the day's arcade.* events back in
// ---------------------------------------------------------------------------

/** The day's arcade events, as the event log would hold them. */
const recording = (bus: EventBus): DeskEvent[] => {
  const log: DeskEvent[] = [];
  bus.subscribe(ev => { if (ev.type.startsWith('arcade.')) log.push(ev); });
  return log;
};

/** A fresh desk after a restart: a new bus, the log fed to observe(). */
const restart = (log: DeskEvent[]) => {
  const bus = new EventBus();
  const emitted: DeskEvent[] = [];
  bus.subscribe(ev => emitted.push(ev));
  const store = new ArcadeStore(bus);
  for (const ev of log) store.observe(ev);
  return { store, emitted };
};

const two = [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Ben' }];

test('a restart carries the grand prix standings back, and publishes nothing doing it', () => {
  // Three races into a four-race Pit Crew Cup, a restart put an empty
  // standings panel on the projector and the operator re-typing finishing
  // orders from memory.
  const bus = new EventBus();
  const log = recording(bus);
  const store = new ArcadeStore(bus);
  store.startGrandPrix('Pit Crew Cup', racers, 4);
  store.recordRace(['a', 'b', 'c', 'd']);
  store.recordRace(['d', 'c', 'b', 'a']);
  store.recordRace(['c', 'a', 'd', 'b']);
  store.setUpNext('Race 4 after Q31');
  store.setBox('card', false);
  const before = store.snapshot;

  const { store: after, emitted } = restart(log);
  assert.equal(emitted.length, 0, 'restoring reaches no surface and re-enters no log');
  const snap = after.snapshot;
  assert.deepEqual(snap.standings.map(s => [s.player.id, s.points]),
    before.standings.map(s => [s.player.id, s.points]));
  assert.equal(snap.gp?.races.length, 3);
  assert.equal(snap.upNext, 'Race 4 after Q31');
  assert.equal(snap.boxes.card, false, 'a box the operator hid stays hidden');
  // And the day goes on from where it was.
  after.recordRace(['b', 'a', 'd', 'c']);
  assert.equal(after.snapshot.gp?.races.length, 4);
});

test('a live set survives a restart with its start time, so its video is still cut right', () => {
  const bus = new EventBus();
  const log = recording(bus);
  const store = new ArcadeStore(bus);
  const set = store.startSet({ game: 'smash', round: 'Grand Final', players: two, bestOf: 5 });
  store.score(0, 1);
  store.score(1, 1);

  const { store: after, emitted } = restart(log);
  const restored = after.snapshot.set;
  assert.equal(restored?.state, 'live');
  assert.deepEqual(restored?.scores, [1, 1]);
  assert.equal(restored?.startedAt, set.startedAt, 'the publish auto-queue cuts from here');
  assert.equal(restored?.bestOf, 5);
  // It finishes under its own rules: three wins for a Bo5, one set_end.
  after.score(0, 1); after.score(0, 1);
  assert.equal(after.snapshot.set?.state, 'complete');
  assert.equal(emitted.filter(e => e.type === 'arcade.set_end').length, 1);
});

test('a start.gg poll landing mid-rebuild neither ends the restore nor is overwritten by it', () => {
  // The adapter's first poll goes out at boot and can land while the rebuild
  // is still feeding observe(). It says nothing about what the operator has
  // done, so it must not latch the store live; and its bracket is fresher than
  // anything in the log, so the log must not overwrite it.
  const bus = new EventBus();
  const log = recording(bus);
  const store = new ArcadeStore(bus);
  store.setBracket([{ id: 'set-1', round: 'Winners Semifinal', state: 'complete', players: two }]);
  store.startGrandPrix('Pit Crew Cup', racers, 4);
  store.recordRace(['a', 'b', 'c', 'd']);

  const after = new ArcadeStore(new EventBus());
  const fresh = [{ id: 'set-9', round: 'Winners Final', state: 'upcoming' as const, players: two }];
  after.setBracket(fresh);              // landed before the rebuild finished
  for (const ev of log) after.observe(ev);
  assert.equal(after.snapshot.gp?.races.length, 1, 'the grand prix still came back');
  assert.deepEqual(after.snapshot.bracket, fresh, 'the fresh bracket stayed');
});

test('a logged snapshot arriving once the operator is scoring is ignored', () => {
  // observe() is a boot-time path. Fed a file after the first operator action,
  // it would overwrite a set that is being scored in front of a crowd.
  const bus = new EventBus();
  const log = recording(bus);
  const store = new ArcadeStore(bus);
  store.startGrandPrix('Pit Crew Cup', racers, 4);
  store.recordRace(['a', 'b', 'c', 'd']);

  const live = new ArcadeStore(new EventBus());
  live.startSet({ game: 'smash', round: 'Round 1', players: two });
  live.score(0, 1);
  for (const ev of log) live.observe(ev);
  assert.equal(live.snapshot.gp, null, 'the morning did not come back over the live set');
  assert.deepEqual(live.snapshot.set?.scores, [1, 0]);
});

test('a malformed grand prix in the log is refused rather than poisoning every snapshot', () => {
  // standings() runs on every snapshot, so a bad grand prix accepted here
  // would take the whole /api/arcade surface down at boot.
  const store = new ArcadeStore(new EventBus());
  const envelope = {
    id: 'x', seq: 1, ts: 0, matchClock: null,
    source: 'manual' as const, confidence: 'authoritative' as const,
  };
  store.observe({ ...envelope, type: 'arcade.score', payload: {
    gp: { game: 'mariokart', name: 'Bad', racers: 'nope', races: [[1]] },
    set: { players: 'nope' }, upNext: 7, boxes: { card: true },
  } });
  assert.equal(store.snapshot.gp, null);
  assert.deepEqual(store.snapshot.standings, []);
  assert.equal(store.snapshot.set, null);
  assert.equal(store.snapshot.upNext, '');
  assert.deepEqual(store.snapshot.boxes, { card: true, ffa: true, gp: true, upNext: true },
    'half a boxes object is not trusted either');
  store.observe({ ...envelope, type: 'match.loaded', payload: { displayName: 'Q1' } });
  assert.equal(store.snapshot.gp, null, 'other events are not arcade snapshots');
});
