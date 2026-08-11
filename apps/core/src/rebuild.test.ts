import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFromDay, rebuildFromLog, type Observer } from './rebuild.ts';
import { CardLedger } from './cards.ts';
import type { DeskEvent } from './types.ts';

const line = (type: string, payload: Record<string, unknown>, ts: number): string =>
  JSON.stringify({ type, payload, ts, seq: ts, source: 'cheesy', confidence: 'authoritative' });

/** A log directory with the given files in it. */
async function logs(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-rebuild-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

/** Records what it was fed, in order. */
const spy = (): Observer & { seen: DeskEvent[] } => {
  const seen: DeskEvent[] = [];
  return { seen, observe: ev => { seen.push(ev); } };
};

test('a restart carries the morning back into the card ledger', async () => {
  // The failure this exists for: the desk restarts after lunch, the ledger
  // opens empty, and the announcer is told a team carrying a yellow from
  // Q12 has a clean slate.
  const dir = await logs({
    '2026-10-17-09-02-11.ndjson': [
      line('match.loaded', { displayName: 'Qualification 12' }, 1000),
      line('card.issued', { team: 254, card: 'yellow', alliance: 'red' }, 2000),
    ].join('\n'),
  });
  try {
    const ledger = new CardLedger();
    const out = await rebuildFromLog(dir, [ledger], new Date('2026-10-17T14:00:00Z'));
    assert.equal(out.events, 2);
    assert.equal(ledger.forTeam(254)?.carrying, true, 'the yellow survived the restart');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yesterday stays yesterday', async () => {
  // A three-day event is three separate tournament phases and three separate
  // rundowns. Dragging Friday's practice cards into Sunday is exactly what
  // the phase rule in cards.ts exists to prevent.
  const dir = await logs({
    '2026-10-16-09-00-00.ndjson': line('match.loaded', { displayName: 'Practice 1' }, 1000),
    '2026-10-17-09-00-00.ndjson': line('match.loaded', { displayName: 'Qualification 1' }, 2000),
  });
  try {
    const s = spy();
    await rebuildFromLog(dir, [s], new Date('2026-10-17T14:00:00Z'));
    assert.equal(s.seen.length, 1);
    assert.equal((s.seen[0]!.payload as { displayName: string }).displayName, 'Qualification 1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn last line is expected, not fatal', async () => {
  // What a power cut leaves behind. Refusing to start a desk somebody is
  // standing in front of would be a much worse answer than skipping a line.
  const dir = await logs({
    '2026-10-17-09-00-00.ndjson':
      line('match.loaded', { displayName: 'Qualification 1' }, 1000) + '\n{"type":"match.st',
  });
  try {
    const s = spy();
    const out = await rebuildFromLog(dir, [s], new Date('2026-10-17T14:00:00Z'));
    assert.equal(out.events, 1);
    assert.equal(out.skipped, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no log directory is a fresh desk, not an error', async () => {
  const out = await rebuildFromLog(join(tmpdir(), 'cg-rebuild-nope'), [spy()]);
  assert.deepEqual(out, { files: 0, events: 0, skipped: 0 });
});

test('one observer throwing does not cost the others their history', async () => {
  const dir = await logs({
    '2026-10-17-09-00-00.ndjson': line('match.loaded', { displayName: 'Q1' }, 1000),
  });
  try {
    const bad: Observer = { observe: () => { throw new Error('boom'); } };
    const good = spy();
    await rebuildFromLog(dir, [bad, good], new Date('2026-10-17T14:00:00Z'));
    assert.equal(good.seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('files are read oldest first, because order is the whole point', async () => {
  const dir = await logs({
    '2026-10-17-13-00-00.ndjson': line('match.loaded', { displayName: 'Q9' }, 3000),
    '2026-10-17-09-00-00.ndjson': line('match.loaded', { displayName: 'Q1' }, 1000),
  });
  try {
    const s = spy();
    await rebuildFromLog(dir, [s], new Date('2026-10-17T14:00:00Z'));
    assert.deepEqual(s.seen.map(e => (e.payload as { displayName: string }).displayName),
      ['Q1', 'Q9']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only .ndjson from the right day counts', () => {
  assert.equal(isFromDay('2026-10-17-09-14-02.ndjson', '2026-10-17'), true);
  assert.equal(isFromDay('2026-10-16-09-14-02.ndjson', '2026-10-17'), false);
  assert.equal(isFromDay('2026-10-17-notes.txt', '2026-10-17'), false);
  assert.equal(isFromDay('sample.ndjson', '2026-10-17'), false);
});
