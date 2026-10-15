/**
 * The latched on-air states come back after a restart, and only those that
 * were still up. Driven through a real log file and the real rebuild, because
 * the rebuild's own rules (today only, sample never) are half of the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { LatchedRestore } from './latched.ts';
import { rebuildFromLog } from './rebuild.ts';
import { initialState, type DeskEvent } from './types.ts';

type Init = { type: DeskEvent['type']; source?: DeskEvent['source']; payload?: unknown; ts: number };

/** Write a day's log the way a running desk does, then close it. */
async function logOf(events: Init[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-latched-'));
  const before = new EventBus();
  await before.openLog(dir);
  for (const e of events) {
    before.emit({ type: e.type, source: e.source ?? 'manual', payload: e.payload ?? {}, ts: e.ts } as never);
  }
  await before.closeLog();
  return dir;
}

/** Boot a fresh desk on that log, the way index.ts does. */
async function restart(dir: string, now = Date.now(), live?: (bus: EventBus) => void) {
  const bus = new EventBus();
  live?.(bus);
  const heard: string[] = [];
  bus.subscribe(ev => heard.push(ev.type));
  const latched = new LatchedRestore(bus.recent[0]?.ts ?? Number.POSITIVE_INFINITY);
  await rebuildFromLog(dir, [latched]);
  const restored = latched.apply(bus, now);
  return { bus, heard, restored };
}

test('a restart puts the safety message, delay card, countdown and announcement back', async () => {
  // Each of these is set once and left up on purpose. The bus opened a
  // restart with an empty state, so all four vanished from every screen and
  // nothing said they had been lost.
  const now = Date.now();
  const dir = await logOf([
    { type: 'emergency.raise', ts: now - 50_000,
      payload: { kind: 'evacuate', message: 'Leave the gym by the north doors', detail: 'Now' } },
    { type: 'status.show', ts: now - 40_000,
      payload: { kind: 'delay', message: 'Field repair, back at 2:15', backAt: now + 600_000 } },
    { type: 'timer.started', ts: now - 30_000,
      payload: { label: 'Doors open', endsAt: now + 1_800_000 } },
    { type: 'announcement.posted', ts: now - 20_000,
      payload: { text: 'Lunch is served in the cafeteria', postedAt: now - 20_000, from: 'Event' } },
    // The sample's own card, pressed after: sample data is never history.
    { type: 'status.show', source: 'demo', ts: now - 10_000,
      payload: { kind: 'custom', message: 'Sample card' } },
  ]);
  try {
    const { bus, heard, restored } = await restart(dir, now);
    const s = bus.state;
    assert.equal(s.emergency?.message, 'Leave the gym by the north doors');
    assert.equal(s.emergency?.raisedAt, now - 50_000, 'raised when it really was');
    assert.equal(s.status?.message, 'Field repair, back at 2:15', 'the real card, not the sample');
    assert.equal(s.timer?.label, 'Doors open');
    assert.equal(s.announcement?.text, 'Lunch is served in the cafeteria');
    assert.deepEqual(restored.sort(), ['announcement', 'emergency', 'status', 'timer']);

    // Restored, not replayed: no subscriber (so no cue), nothing logged, and
    // the program screen is exactly where a fresh desk puts it.
    assert.deepEqual(heard, []);
    assert.equal(bus.recent.length, 0);
    assert.equal(s.screen, initialState().screen);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('what was already taken down stays down', async () => {
  const now = Date.now();
  const dir = await logOf([
    { type: 'emergency.raise', ts: now - 60_000, payload: { kind: 'hold', message: 'Hold all robots' } },
    { type: 'emergency.clear', ts: now - 55_000 },
    // The field's automatic timeout card retires itself at the next prestart.
    { type: 'break.started', ts: now - 50_000, source: 'cheesy' },
    { type: 'match.prestart', ts: now - 45_000, source: 'cheesy' },
    // A field-setup countdown ends when the match it counted down to starts.
    { type: 'timer.started', ts: now - 40_000, payload: { label: 'Field reset', endsAt: now + 600_000 } },
    { type: 'match.start', ts: now - 35_000, source: 'cheesy' },
  ]);
  try {
    const { bus, restored } = await restart(dir, now);
    assert.equal(bus.state.emergency, null);
    assert.equal(bus.state.status, null);
    assert.equal(bus.state.timer, null);
    assert.deepEqual(restored, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a countdown that ran out while the desk was down does not come back', async () => {
  // The reducer judges endsAt against the event's own stamp, which was in
  // the future when it was logged. It has to be judged against now.
  const now = Date.now();
  const dir = await logOf([
    { type: 'timer.started', ts: now - 50_000, payload: { label: 'Doors open', endsAt: now - 5_000 } },
  ]);
  try {
    const { bus, restored } = await restart(dir, now);
    assert.equal(bus.state.timer, null);
    assert.deepEqual(restored, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('this run\'s own events win over the log', async () => {
  // Events this process already emitted are live, and may have retired a
  // state the log still shows (its tail may not have reached the disk yet).
  const now = Date.now();
  const dir = await logOf([
    { type: 'break.started', ts: now - 50_000, source: 'cheesy' },
  ]);
  try {
    const { bus, restored } = await restart(dir, now, live => {
      live.emit({ type: 'match.prestart', source: 'cheesy', payload: {} });
    });
    assert.equal(bus.state.status, null, 'the field moved on during boot');
    assert.deepEqual(restored, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
