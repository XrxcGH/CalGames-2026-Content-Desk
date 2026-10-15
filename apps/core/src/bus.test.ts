import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, localDay } from './bus.ts';
import { EVENT_SCHEMA_VERSION, type DeskEvent } from './types.ts';

/** A moment in October 2026, in LOCAL time: the clock the log is named and rotated on. */
const local = (day: number, hour: number, minute = 0, second = 0): Date =>
  new Date(2026, 9, day, hour, minute, second);

/** The event types in a log file, in order. */
const typesIn = async (path: string): Promise<string[]> =>
  (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    .map(l => (JSON.parse(l) as DeskEvent).type);

test('every event carries the envelope version and a monotonic seq', () => {
  const bus = new EventBus();
  const a = bus.emit({ type: 'graphic.show', payload: { graphic: 'x' } });
  const b = bus.emit({ type: 'graphic.hide' });

  assert.equal(a.schemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(a.seq, 1, 'seq starts at 1, so 0 reads as "not from a bus"');
  assert.equal(b.seq, 2);
  assert.ok(b.seq > a.seq, 'seq is what answers "did I miss anything"');
});

test('seq counts clock-driven events too, or a gap check would lie', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));

  bus.emit({ type: 'match.loaded', payload: { id: 'q1', displayName: 'Q1', red: [], blue: [] } });
  bus.emit({ type: 'match.start' });
  // Drive the ticker past the auto boundary: those events come from advance(),
  // not from a caller, and a client counting seq must see them numbered too.
  bus.advance(Date.now() + 25_000);

  const seqs = seen.map(e => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1),
    'no gaps and no repeats across caller-emitted and clock-emitted events');
});

test('the ring can answer "what happened after seq N"', () => {
  const bus = new EventBus();
  for (let i = 0; i < 5; i++) bus.emit({ type: 'graphic.show', payload: { i } });
  const after = bus.recent.filter(e => e.seq > 3);
  assert.deepEqual(after.map(e => e.seq), [4, 5]);
});

test('a clock that jumps fires every boundary it crossed', () => {
  // advance() fired only the phase it landed in, which is right at 10Hz and
  // wrong whenever the clock jumps. And it does jump: replay caps long gaps
  // deliberately, and a stalled event loop does the same live. Skipping
  // match.auto_end means the reducer's auto-winner heuristic never runs, so a
  // replay reconstructs different state than the run it is replaying.
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => { if (ev.source === 'clock') seen.push(ev.type); });

  const t0 = 1_000_000;
  bus.emit({ type: 'match.loaded', source: 'manual', payload: { displayName: 'Q1' }, ts: t0 });
  bus.emit({ type: 'match.start', source: 'manual', payload: {}, ts: t0 });

  // Straight from pre-match to the endgame in one tick: 130 seconds of match
  // clock in a single call, which is what a five-second cap on a long gap
  // produces at any replay speed.
  bus.advance(t0 + 130_000);

  assert.ok(seen.includes('match.auto_end'), 'auto ended somewhere in there');
  assert.equal(seen.filter(t => t === 'match.shift_change').length, 4,
    'all four shifts, not just the last one');
  assert.ok(seen.includes('match.endgame'));
});

test('a replayed log is renumbered on this process rather than keeping old seqs', async () => {
  // This test used to emit two fresh events on a new bus and assert seq 1 and
  // 2, which passes whether or not replay() renumbers anything, because it
  // never called replay(). The claim in the title was entirely unexercised.
  const dir = await mkdtemp(join(tmpdir(), 'cg-bus-'));
  try {
    const file = join(dir, 'log.ndjson');
    // A log whose seqs are from some other process, deliberately far away.
    await writeFile(file, [
      JSON.stringify({ type: 'match.loaded', source: 'manual', payload: { displayName: 'Q1' },
        ts: 1000, seq: 900, confidence: 'authoritative' }),
      JSON.stringify({ type: 'match.start', source: 'manual', payload: {},
        ts: 2000, seq: 901, confidence: 'authoritative' }),
    ].join('\n'));

    const bus = new EventBus();
    const seqs: number[] = [];
    bus.subscribe(ev => seqs.push(ev.seq));
    await bus.replay(file, 0);

    assert.deepEqual(seqs, [1, 2], 'renumbered on this process, not carried over');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the log rotates at local midnight, so Saturday is never filed under Friday', async () => {
  // The log was opened once and named for the day the PROCESS started, and the
  // desk runs Friday to Sunday without restarting, so all of Saturday went into
  // a Friday-named file. rebuildFromLog chooses files by the day in their name:
  // a Saturday restart rebuilt nothing while the file sat right there.
  const dir = await mkdtemp(join(tmpdir(), 'cg-bus-rotate-'));
  try {
    const bus = new EventBus();
    const friday = local(16, 23, 59);
    await bus.openLog(dir, { now: friday });
    bus.emit({ type: 'match.loaded', payload: { displayName: 'Practice 12' }, ts: friday.getTime() });
    bus.emit({ type: 'match.end', ts: local(16, 23, 59, 40).getTime() });
    // The first event of Saturday is what opens Saturday's file.
    bus.emit({ type: 'match.loaded', payload: { displayName: 'Qualification 1' }, ts: local(17, 0, 0, 10).getTime() });
    assert.ok(bus.logPath?.startsWith(join(dir, localDay(local(17, 0)))),
      'the open file is now named for Saturday');
    bus.emit({ type: 'match.start', ts: local(17, 0, 1).getTime() });
    await bus.closeLog();

    const files = (await readdir(dir)).sort();
    assert.equal(files.length, 2, 'one file per local day');
    assert.ok(files[0]!.startsWith(localDay(friday)), `${files[0]} is Friday's`);
    assert.ok(files[1]!.startsWith(localDay(local(17, 0))), `${files[1]} is Saturday's`);
    assert.deepEqual(await typesIn(join(dir, files[0]!)), ['match.loaded', 'match.end'],
      "Friday's file holds Friday, flushed to the last line");
    assert.deepEqual(await typesIn(join(dir, files[1]!)), ['match.loaded', 'match.start'],
      "Saturday's file holds Saturday");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rehearsal tag follows the log across midnight', async () => {
  // A --demo tech check that runs past midnight has to stay out of the next
  // day's rebuild exactly as it stayed out of this one's. Rotated into an
  // untagged file, its fabricated matches would be Saturday's history.
  const dir = await mkdtemp(join(tmpdir(), 'cg-bus-rotate-'));
  try {
    const bus = new EventBus();
    await bus.openLog(dir, { tag: 'rehearsal', now: local(16, 23, 50) });
    bus.emit({ type: 'match.loaded', payload: { displayName: 'Test' }, ts: local(16, 23, 50).getTime() });
    bus.emit({ type: 'match.loaded', payload: { displayName: 'Test' }, ts: local(17, 0, 5).getTime() });
    await bus.closeLog();

    const files = (await readdir(dir)).sort();
    assert.equal(files.length, 2);
    for (const f of files) assert.ok(f.endsWith('.rehearsal.ndjson'), `${f} is tagged`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an event stamped behind the open file stays in it', async () => {
  // Forward only. A replay restamps its events near the wall clock, and a few
  // seconds behind midnight they must not flip the log back onto a file named
  // for yesterday; rebuildFromLog places every event by its own stamp anyway.
  const dir = await mkdtemp(join(tmpdir(), 'cg-bus-rotate-'));
  try {
    const bus = new EventBus();
    await bus.openLog(dir, { now: local(17, 10) });
    bus.emit({ type: 'match.loaded', payload: { displayName: 'Late' }, ts: local(16, 23, 59).getTime() });
    bus.emit({ type: 'match.start', ts: local(17, 10, 1).getTime() });
    await bus.closeLog();

    const files = await readdir(dir);
    assert.equal(files.length, 1, 'no yesterday-named file was opened');
    assert.deepEqual(await typesIn(join(dir, files[0]!)), ['match.loaded', 'match.start']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
