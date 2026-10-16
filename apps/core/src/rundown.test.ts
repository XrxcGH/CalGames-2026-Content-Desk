import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { Rundown, type SegmentPlan } from './rundown.ts';

const PLAN: SegmentPlan[] = [
  { id: 'open', label: 'Opening ceremony', kind: 'ceremony', minutes: 20, audience: 'Matches start' },
  { id: 'quals-am', label: 'Qualification matches', kind: 'matches', matches: 20 },
  { id: 'lunch', label: 'Lunch', kind: 'break', minutes: 45, audience: 'Matches resume' },
  { id: 'quals-pm', label: 'Qualification matches', kind: 'matches', matches: 20 },
  { id: 'awards', label: 'Awards', kind: 'awards', minutes: 30 },
];

const mins = (a: number, b: number): number => Math.round((a - b) / 60_000);

test('a matches block is measured, not planned', () => {
  // The difference between a printed seven minutes and a measured nine is an
  // hour by the end of the day, which is the entire reason this exists.
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);

  const assumed = r.snapshot.segments.find(s => s.id === 'quals-am')!;
  assert.equal(assumed.projectedMinutes, 140, '20 matches at the assumed 7 min');

  // Feed the pace model a real, slower cycle.
  bus.emit({ type: 'pace.updated', source: 'manual', payload: {
    cycleSec: 9 * 60, nextStartAt: null, behindMin: 20, lastStartAt: Date.now(),
  } });

  const measured = r.snapshot.segments.find(s => s.id === 'quals-am')!;
  assert.equal(measured.projectedMinutes, 180, '20 matches at the measured 9 min');
});

test('a delay pushes everything after it, not just the thing that is late', () => {
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  const before = r.snapshot.segments.find(s => s.id === 'awards')!.projectedAt!;

  bus.emit({ type: 'pace.updated', source: 'manual', payload: {
    cycleSec: 9 * 60, nextStartAt: null, behindMin: 20, lastStartAt: Date.now(),
  } });

  const after = r.snapshot.segments.find(s => s.id === 'awards')!.projectedAt!;
  // Two 20-match blocks, each 2 minutes per match slower: 80 minutes later.
  assert.equal(mins(after, before), 80, 'the whole afternoon moves, not one block');
});

test('starting a segment ends whatever was live', () => {
  // Two live segments is a state the day cannot be in, and pretending
  // otherwise makes every projection after it wrong.
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.start('open');
  const snap = r.start('quals-am');
  assert.equal(snap.segments.find(s => s.id === 'open')!.state, 'done');
  assert.equal(snap.live?.id, 'quals-am');
});

test('advance finishes the live one and starts the next pending one', () => {
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.start('open');
  const snap = r.advance();
  assert.equal(snap.live?.id, 'quals-am');
  assert.equal(snap.next?.id, 'lunch');
});

test('advancing past the end stops rather than throwing', () => {
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.start('awards');
  const snap = r.advance();
  assert.equal(snap.live, null, 'the day is over, not broken');
});

test('the countdown belongs to a break, never to matches', () => {
  // During matches the room already has a clock. A second one competing with
  // it is noise.
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);

  r.start('quals-am');
  assert.equal(r.snapshot.countdown, null, 'no countdown during matches');

  r.start('lunch');
  const c = r.snapshot.countdown!;
  assert.ok(c, 'a break gets one');
  assert.equal(c.label, 'Matches resume', 'in the audience-facing words');
  assert.ok(c.at > Date.now(), 'and it points forward');
});

test('a matches block shrinks as it is played', () => {
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.attach();
  bus.emit({ type: 'pace.updated', source: 'manual', payload: {
    cycleSec: 6 * 60, nextStartAt: null, behindMin: 0, lastStartAt: Date.now(),
  } });
  r.start('quals-am');
  const before = r.snapshot.segments.find(s => s.id === 'lunch')!.projectedAt!;

  // Explicit timestamps, spaced. A whole test running inside one millisecond
  // is not a thing that happens at an event, and leaving it implicit makes the
  // test depend on clock resolution rather than on the behaviour.
  const t = Date.now();
  for (let i = 0; i < 5; i++) {
    bus.emit({ type: 'match.score_posted', source: 'cheesy', payload: {}, ts: t + (i + 1) * 7 * 60_000 });
  }

  const after = r.snapshot.segments.find(s => s.id === 'lunch')!.projectedAt!;
  assert.ok(after < before, 'five matches played means lunch is closer, not the same');
  assert.equal(mins(before, after), 30, 'five matches at six minutes');
});

test('a block that starts later does not inherit the morning count', () => {
  // Counting per block rather than a running total is the reason the afternoon
  // block does not think it is already finished.
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.attach();
  r.start('quals-am');
  // The morning's matches happened BEFORE the afternoon block starts, which is
  // the whole thing being tested: they must not be counted against it.
  const t = Date.now();
  for (let i = 0; i < 20; i++) {
    bus.emit({ type: 'match.score_posted', source: 'cheesy', payload: {}, ts: t - (20 - i) * 7 * 60_000 });
  }

  r.start('quals-pm');
  const pm = r.snapshot.segments.find(s => s.id === 'quals-pm')!;
  // Live blocks project from now; the projection for what FOLLOWS is what
  // shows whether the block thinks it has 20 matches left or none.
  const awards = r.snapshot.segments.find(s => s.id === 'awards')!;
  assert.ok(mins(awards.projectedAt!, Date.now()) >= 120,
    'the afternoon block still has its full 20 matches to play');
  assert.equal(pm.state, 'live');
});

test("Post score held down counts one match, not thirty", () => {
  // The desk console's number keys auto-repeat about thirty times a second.
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.attach();
  bus.emit({ type: 'pace.updated', source: 'manual', payload: {
    cycleSec: 6 * 60, nextStartAt: null, behindMin: 0, lastStartAt: Date.now(),
  } });
  r.start('quals-am');
  const before = r.snapshot.segments.find(s => s.id === 'lunch')!.projectedAt!;
  const t = Date.now();
  for (let i = 0; i < 30; i++) {
    bus.emit({ type: 'match.score_posted', source: 'manual', payload: {}, ts: t + 1000 + i * 33 });
  }
  const after = r.snapshot.segments.find(s => s.id === 'lunch')!.projectedAt!;
  assert.equal(mins(before, after), 6, 'one match nearer, not thirty');
});

test('a mis-tap can be put back', () => {
  const bus = new EventBus();
  const r = new Rundown(bus, PLAN);
  r.start('lunch');
  const snap = r.reset('lunch');
  assert.equal(snap.segments.find(s => s.id === 'lunch')!.state, 'pending');
  assert.equal(snap.live, null);
});

test('an unknown segment is refused by name', () => {
  const r = new Rundown(new EventBus(), PLAN);
  assert.throws(() => r.start('nope'), /no segment "nope"/);
});

test('an empty plan is a supported way to run', () => {
  const r = new Rundown(new EventBus(), []);
  const snap = r.snapshot;
  assert.deepEqual(snap.segments, []);
  assert.equal(snap.live, null);
  assert.equal(snap.countdown, null);
});
