import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachPace, behindMinutes, etaForRow, headIsPlaying, medianCycleMs, projectNextStart, startedRows,
} from './pace.ts';
import { EventBus } from './bus.ts';
import { initialState, type DeskState, type UpcomingMatch } from './types.ts';

const MIN = 60_000;

test('median cycle excludes breaks and glitches', () => {
  // 7, 7, 8 minute cycles with a lunch break (45m) and a double-fire (20s).
  const t0 = 1_000_000;
  const starts = [
    t0,
    t0 + 7 * MIN,
    t0 + 14 * MIN,
    t0 + 14 * MIN + 20_000,       // glitch: excluded (< 90s)
    t0 + 22 * MIN + 20_000,       // 8m cycle from the glitch entry
    t0 + 67 * MIN,                 // lunch: excluded (> 20m)
    t0 + 74 * MIN,                 // 7m
  ];
  const median = medianCycleMs(starts);
  assert.equal(median, 7 * MIN, 'median of [7, 7, 8, 7] minutes');
});

test('median is null until there are two starts worth of signal', () => {
  assert.equal(medianCycleMs([]), null);
  assert.equal(medianCycleMs([5_000_000]), null);
  assert.equal(medianCycleMs([0, 30 * MIN]), null, 'a single break is not a pace');
});

test('projection never points into the past (a stalled field walks forward)', () => {
  const last = 1_000_000;
  const cycle = 7 * MIN;
  assert.equal(projectNextStart(last, cycle, last + MIN), last + cycle, 'normal case');
  // Field stalled: 30 minutes since the last start; the estimate is "now".
  const now = last + 30 * MIN;
  assert.equal(projectNextStart(last, cycle, now), now);
  assert.equal(projectNextStart(null, cycle, now), null);
  assert.equal(projectNextStart(last, null, now), null);
});

test('behind-schedule math, both directions', () => {
  const sched = 2_000_000;
  assert.equal(behindMinutes(sched + 12 * MIN, sched), 12, 'running behind');
  assert.equal(behindMinutes(sched - 3 * MIN, sched), -3, 'ahead, which is rare but honest');
  assert.equal(behindMinutes(null, sched), null);
  assert.equal(behindMinutes(sched, null), null, 'no published times, no claim');
});

test('behindMin stays honest while the queue head is still the playing match', () => {
  const bus = new EventBus();
  const detach = attachPace(bus);
  try {
    const updates: { behindMin: number | null }[] = [];
    bus.subscribe(ev => {
      if (ev.type === 'pace.updated') updates.push(ev.payload as { behindMin: number | null });
    });

    // A 7-minute schedule running exactly on time. Cheesy keeps a match in
    // the upcoming queue until its score commits, so while a match plays the
    // head is that match, not the next one; comparing the NEXT start's
    // projection against it used to read a full cycle behind here.
    const t0 = Date.now() - 7 * MIN;
    const iso = (t: number) => new Date(t).toISOString();
    const queue = (head: number) => bus.emit({
      type: 'queue.updated', source: 'cheesy',
      payload: {
        upcoming: [{
          name: `Qualification ${head}`, shortName: `Q${head}`,
          time: iso(t0 + (head - 42) * 7 * MIN), red: [], blue: [],
        }],
      },
    });

    queue(42);
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 });
    queue(43);                                             // Q42 committed
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 + 7 * MIN });

    assert.equal(updates.at(-1)!.behindMin, 0,
      'a field running exactly on schedule must not read a cycle behind mid-match');
  } finally {
    detach();
  }
});

// ---- which on-deck row does nextStartAt belong to? -------------------------

const row = (n: number): UpcomingMatch => ({
  name: `Qualification ${n}`, shortName: `Q${n}`, time: null, red: [], blue: [],
});

/** A desk state with the given match on the field and the given queue. */
function deskWith(over: Partial<DeskState>): DeskState {
  return { ...initialState(), ...over };
}
const playing = (n: number) => ({
  id: `q${n}`, displayName: `Qualification ${n}`, red: [], blue: [],
});

test('a match on the field is row 0 of the field queue until its score commits', () => {
  const live = deskWith({
    match: playing(42), upcoming: [row(42), row(43), row(44)], queueFrom: 'field',
    lastMatchStartedAt: 1_000, scorePostedAt: null,
  });
  assert.equal(startedRows(live), 1, 'started and not committed: row 0 is already out');

  assert.equal(startedRows({ ...live, scorePostedAt: 2_000 }), 0,
    'committed: the queue has moved on, row 0 is the next match again');
  assert.equal(startedRows({ ...live, lastMatchStartedAt: null }), 0,
    'loaded but not started: row 0 is still ahead of the field');
  assert.equal(startedRows({ ...live, upcoming: [] }), 0, 'an empty queue has no started rows');
});

test('a Nexus queue has already dropped the playing match, so nothing is skipped', () => {
  // Nexus never lists a match once it is "On field": while Q42 plays, row 0 is
  // Q43 and nextStartAt is already Q43's start. Skipping a row here would put
  // every estimate a cycle EARLY.
  const live = deskWith({
    match: playing(42), upcoming: [row(43), row(44)], queueFrom: 'nexus',
    lastMatchStartedAt: 1_000, scorePostedAt: null,
  });
  assert.equal(startedRows(live), 0);

  // Unless Nexus is slow to flip it, and still lists the playing match first.
  assert.equal(startedRows({ ...live, upcoming: [row(42), row(43)] }), 1,
    'the loaded match is named in row 0, whoever the source is');
});

test('a test match is never in the queue, so it does not consume a row', () => {
  const live = deskWith({
    match: { ...playing(0), displayName: 'Test Match' }, upcoming: [row(42), row(43)],
    queueFrom: 'field', lastMatchStartedAt: 1_000, scorePostedAt: null,
  });
  assert.equal(startedRows(live), 0);
});

test('with no loaded match to compare, the queue source decides', () => {
  assert.equal(headIsPlaying(row(42), null, 'field'), true, 'the field keeps it listed');
  assert.equal(headIsPlaying(row(42), null, null), true, 'desk-only follows the field convention');
  assert.equal(headIsPlaying(row(42), null, 'nexus'), false, 'Nexus drops it');
  assert.equal(headIsPlaying(undefined, playing(42), 'field'), false, 'no row, nothing to be playing');
  assert.equal(headIsPlaying(row(42), { displayName: ' qualification 42 ' }, 'nexus'), true,
    'names compare without regard to case or padding');
  assert.equal(headIsPlaying({ name: '', shortName: 'Q42' }, { displayName: 'Q42' }, 'field'), true,
    'a field that sent only a ShortName names the loaded match by it too');
});

test('every ETA skips the playing match: the next match gets nextStartAt, not the one on the field', () => {
  const pace = { nextStartAt: 10_000_000, cycleSec: 420 };
  const cycle = 420_000;

  // Match on the field: row 0 has no estimate, row 1 is the NEXT start, row 2 one cycle later.
  assert.equal(etaForRow(pace, 1, 0), null);
  assert.equal(etaForRow(pace, 1, 1), 10_000_000);
  assert.equal(etaForRow(pace, 1, 2), 10_000_000 + cycle);

  // Nothing on the field: row 0 is the next start, as it always was.
  assert.equal(etaForRow(pace, 0, 0), 10_000_000);
  assert.equal(etaForRow(pace, 0, 3), 10_000_000 + 3 * cycle);

  // No pace signal: no figure rather than an invented one.
  assert.equal(etaForRow({ nextStartAt: null, cycleSec: 420 }, 0, 1), null);
  assert.equal(etaForRow({ nextStartAt: 10_000_000, cycleSec: null }, 0, 1), null);
});

test('the pace model and the row rule agree: Q43 is estimated from Q42 start plus one cycle', () => {
  // The end-to-end shape of the bug. Q41 started 7 minutes ago, Q42 just
  // started; the model projects Q43. While Q42 is on the field the queue
  // still reads [Q42, Q43, Q44], and the old surfaces counted from row 0.
  const bus = new EventBus();
  const detach = attachPace(bus);
  try {
    const t0 = Date.now() - 7 * MIN;
    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(41) });
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 });
    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(42) });
    bus.emit({
      type: 'queue.updated', source: 'cheesy',
      payload: { upcoming: [row(42), row(43), row(44)] },
    });
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 + 7 * MIN });

    const s = bus.state;
    const started = startedRows(s);
    assert.equal(started, 1);
    assert.equal(etaForRow(s.pace, started, 0), null, 'Q42 is playing, it has no start to estimate');
    assert.equal(etaForRow(s.pace, started, 1), s.pace.nextStartAt,
      'Q43 starts when the model says the next start is');
    assert.equal(etaForRow(s.pace, started, 2)! - etaForRow(s.pace, started, 1)!, 7 * MIN,
      'and Q44 one cycle after that');
  } finally {
    detach();
  }
});

test('behindMin is not latched against the NEXT match when the queue is Nexus\'s', () => {
  const bus = new EventBus();
  const detach = attachPace(bus);
  try {
    const updates: { behindMin: number | null }[] = [];
    bus.subscribe(ev => {
      if (ev.type === 'pace.updated') updates.push(ev.payload as { behindMin: number | null });
    });

    // On time, Nexus's queue. Nexus lists a match only until it is "On field",
    // so when Q43 starts the head is Q44. Latching Q43's start against Q44's
    // time read 7 minutes AHEAD on a field running exactly on schedule.
    const t0 = Date.now() - 14 * MIN;
    const iso = (t: number) => new Date(t).toISOString();
    const nexus = (head: number) => bus.emit({
      type: 'queue.updated', source: 'nexus',
      payload: {
        upcoming: [{ ...row(head), time: iso(t0 + (head - 42) * 7 * MIN) }],
      },
    });

    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(42) });
    nexus(43);
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 });
    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(43) });
    nexus(44);
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 + 7 * MIN });

    assert.equal(updates.at(-1)!.behindMin, 0,
      'the head is the next match, so compare the next match\'s projection with its own time');
  } finally {
    detach();
  }
});

test('a field queue with the loaded match named still latches against the playing match', () => {
  const bus = new EventBus();
  const detach = attachPace(bus);
  try {
    const updates: { behindMin: number | null }[] = [];
    bus.subscribe(ev => {
      if (ev.type === 'pace.updated') updates.push(ev.payload as { behindMin: number | null });
    });

    // The same on-time field as the first behindMin test, but with the match
    // loaded the way the real adapter does it. Naming the head must not lose
    // the latch: without it this reads a full cycle behind.
    const t0 = Date.now() - 7 * MIN;
    const iso = (t: number) => new Date(t).toISOString();
    const queue = (head: number) => bus.emit({
      type: 'queue.updated', source: 'cheesy',
      payload: { upcoming: [{ ...row(head), time: iso(t0 + (head - 42) * 7 * MIN) }] },
    });

    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(42) });
    queue(42);
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 });
    bus.emit({ type: 'match.loaded', source: 'cheesy', payload: playing(43) });
    queue(43);
    bus.emit({ type: 'match.start', source: 'cheesy', ts: t0 + 7 * MIN });

    assert.equal(updates.at(-1)!.behindMin, 0);
  } finally {
    detach();
  }
});
