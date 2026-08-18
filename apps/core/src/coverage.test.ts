import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { CoverageLedger } from './coverage.ts';
import type { PublishQueue } from './publish/queue.ts';

/** Just the slice of the queue the ledger joins against. */
const fakeQueue = (items: unknown[]): PublishQueue =>
  ({ items } as unknown as PublishQueue);

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'i1', kind: 'match', label: 'Qualification 12', state: 'done',
  videoId: 'abc123', error: null, ...over,
});

function playMatch(bus: EventBus, name: string, opts: {
  red?: number[]; blue?: number[]; score?: [number, number]; post?: boolean;
} = {}): void {
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: {
      id: name.toLowerCase().replace(/\s+/g, ''),
      displayName: name,
      red: (opts.red ?? [254, 846, 1678]).map(number => ({ number, name: '' })),
      blue: (opts.blue ?? [971, 1868, 100]).map(number => ({ number, name: '' })),
    },
  });
  bus.emit({ type: 'match.start', source: 'cheesy' });
  bus.emit({ type: 'match.end', source: 'cheesy' });
  if (opts.post !== false) {
    const [r, b] = opts.score ?? [88, 74];
    bus.emit({
      type: 'match.score_posted', source: 'cheesy',
      payload: { red: { total: r }, blue: { total: b } },
    });
  }
}

test('a played match with a finished upload is not a gap', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([item()]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');

  const report = ledger.report();
  assert.equal(report.played, 1);
  assert.equal(report.scored, 1);
  assert.equal(report.uploaded, 1);
  assert.deepEqual(report.gaps, []);
});

test('the gap that matters: played, and nothing was ever queued', () => {
  // This is the failure the whole module exists for. Every component reports
  // success; the video simply does not exist, and nobody finds out for weeks.
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');

  const report = ledger.report();
  assert.equal(report.played, 1);
  assert.equal(report.queued, 0);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0]!.problem, 'never-queued');
});

test('queued but still sitting in the queue is reported with its state', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([item({ state: 'pending', videoId: null })]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');

  const gaps = ledger.report().gaps;
  assert.equal(gaps[0]!.problem, 'not-uploaded');
  assert.match(gaps[0]!.detail, /pending/);
});

test('a failed item carries its reason, so the fix is one retry away', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([
    item({ state: 'failed', videoId: null, error: 'quota exceeded' }),
  ]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');

  const gaps = ledger.report().gaps;
  assert.equal(gaps[0]!.problem, 'failed');
  assert.match(gaps[0]!.detail, /quota exceeded/);
});

test('a match that never got a score is flagged separately', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([item()]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12', { post: false });

  const problems = ledger.report().gaps.map(g => g.problem);
  assert.ok(problems.includes('no-score'));
});

test('a loaded-but-never-played match is not counted as missing video', () => {
  // An aborted or re-loaded match must not raise a false alarm, or the report
  // becomes something people ignore.
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([]));
  ledger.attach(bus);
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q99', displayName: 'Qualification 99', red: [], blue: [] },
  });

  const report = ledger.report();
  assert.equal(report.played, 0);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.rows.length, 1, 'it is still on the ledger, just not played');
});

test('a re-load with an empty roster does not erase who played', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([item()]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q12', displayName: 'Qualification 12', red: [], blue: [] },
  });

  assert.deepEqual(ledger.report().rows[0]!.red, [254, 846, 1678]);
});

test('a team can be handed everything they played, with the links', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([
    item({ id: 'i1', label: 'Qualification 12', videoId: 'vid12' }),
    item({ id: 'i2', label: 'Qualification 13', videoId: 'vid13' }),
  ]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12', { red: [254, 846, 1678] });
  playMatch(bus, 'Qualification 13', { red: [8, 604, 199], blue: [1, 2, 3] });

  const theirs = ledger.forTeam(846);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0]!.name, 'Qualification 12');
  assert.equal(theirs[0]!.publish?.videoId, 'vid12');

  assert.equal(ledger.forTeam(3).length, 1, 'blue counts too');
  assert.equal(ledger.forTeam(9999).length, 0);
});

test('rows come back in the order the matches were played', () => {
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([]));
  ledger.attach(bus);
  playMatch(bus, 'Qualification 12');
  playMatch(bus, 'Qualification 13');
  assert.deepEqual(ledger.report().rows.map(r => r.name),
    ['Qualification 12', 'Qualification 13']);
});

test('the ledger rebuilds itself from a replayed log', () => {
  // It is derived entirely from bus events, which is what makes the day's
  // archive re-checkable afterwards rather than only live.
  const live = new EventBus();
  const first = new CoverageLedger(fakeQueue([]));
  first.attach(live);
  playMatch(live, 'Qualification 12');

  const rebuilt = new CoverageLedger(fakeQueue([]));
  for (const ev of live.recent) rebuilt.observe(ev);
  assert.deepEqual(
    rebuilt.report().rows.map(r => [r.name, r.playedAt !== null]),
    first.report().rows.map(r => [r.name, r.playedAt !== null]),
  );
});

test('a stale loaded match does not swallow the next match\'s result', () => {
  // The bug this pins: taking "the first row with no playedAt" instead of the
  // match that was actually loaded last. A match loaded and then abandoned
  // (schedule change, abort, a demo left running) sits unplayed at the front
  // of the map forever and collects every later match's buzzer and score, so
  // the ledger reports the wrong match played and the right one missing.
  const bus = new EventBus();
  const ledger = new CoverageLedger(fakeQueue([]));
  ledger.attach(bus);

  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q41', displayName: 'Qualification 41', red: [], blue: [] },
  });
  playMatch(bus, 'Qualification 42', { red: [254, 846, 1678], score: [91, 84] });

  const rows = ledger.report().rows;
  const stale = rows.find(r => r.name === 'Qualification 41')!;
  const real = rows.find(r => r.name === 'Qualification 42')!;
  assert.equal(stale.playedAt, null, 'the abandoned match was never played');
  assert.ok(real.playedAt, 'the match that actually ran is the one marked played');
  assert.deepEqual(real.score, { red: 91, blue: 84 });
  assert.equal(ledger.report().played, 1);
});

test('a playoff match joins its upload, and the score column fills', async () => {
  // Two bugs that only showed up on Sunday afternoon. The rows are keyed on
  // the raw name the field sends, and Cheesy's playoff LongName is a bare
  // "Match 7". The publish queue labels its items identify()'d to
  // "Match 7 (R2)", so the join missed and every playoff match reported
  // never-queued while its upload was succeeding. And the score was read from
  // payload.red.total, which no live emitter produces; the field sends
  // `score`, so the column was permanently null.
  const bus = new EventBus();
  const fake = {
    items: [{ id: 'i1', kind: 'match', label: 'Match 7 (R2)', state: 'done',
      videoId: 'abc123', error: null }],
  } as unknown as PublishQueue;
  const ledger = new CoverageLedger(fake);
  ledger.attach(bus);

  bus.emit({ type: 'match.loaded', source: 'cheesy',
    payload: { displayName: 'Match 7', red: [{ number: 254 }], blue: [{ number: 846 }] } });
  bus.emit({ type: 'match.start', source: 'cheesy', payload: {} });
  bus.emit({ type: 'match.end', source: 'cheesy', payload: {} });
  bus.emit({ type: 'match.score_posted', source: 'cheesy',
    payload: { red: { score: 96, rp: 3 }, blue: { score: 88, rp: 1 } } });

  const report = ledger.report();
  const row = report.rows.find(r => r.name === 'Match 7')!;
  assert.deepEqual(row.score, { red: 96, blue: 88 }, 'the field sends `score`');
  assert.equal(row.publish?.videoId, 'abc123', 'and the upload is found despite the rename');
  assert.equal(report.gaps.some(g => g.problem === 'never-queued'), false,
    'so it does not warn about a video that exists');
});
