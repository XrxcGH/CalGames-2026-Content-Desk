import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileBook, shortenForMinor } from './profiles.ts';
import { reduce } from './state.ts';
import { initialState, type DeskEvent, type DeskState, type PanelState } from './types.ts';

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), 'cg-profiles-'));

test('the book remembers anyone put on air, once', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.load();

    const first = await book.resolve([
      { name: 'Priya Raman', role: 'Analyst' },
      { name: 'Marcus Webb', role: 'Play-by-play' },
    ]);
    assert.equal(first.length, 2);
    assert.equal(book.list.length, 2);

    // The same two people again must not mint two more profiles: the whole
    // point is that the second segment is a checklist.
    await book.resolve([
      { name: 'Priya Raman', role: 'Analyst' },
      { name: 'Marcus Webb', role: 'Play-by-play' },
    ]);
    assert.equal(book.list.length, 2);
    assert.equal(book.list.find(p => p.name === 'Priya Raman')?.uses, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same name on a different team is a different person', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.resolve([{ name: 'Alex', role: 'Drive coach', team: 254 }]);
    await book.resolve([{ name: 'Alex', role: 'Drive coach', team: 1678 }]);
    assert.equal(book.list.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a role typed at the desk wins: the same person changes hats', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    const [made] = await book.resolve([{ name: 'Dana Okafor', role: 'Analyst' }]);
    await book.resolve([{ id: made!.id, name: 'Dana Okafor', role: 'Drive coach' }]);
    assert.equal(book.get(made!.id)?.role, 'Drive coach');
    assert.equal(book.list.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the book survives a restart, most-recently-used first', async () => {
  const dir = await scratch();
  try {
    const first = new ProfileBook(dir);
    await first.resolve([{ name: 'Older', role: 'Analyst' }]);
    await new Promise(r => setTimeout(r, 5));
    await first.resolve([{ name: 'Newer', role: 'Host' }]);

    const reopened = new ProfileBook(dir);
    await reopened.load();
    assert.deepEqual(reopened.list.map(p => p.name), ['Newer', 'Older']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The panel on the state snapshot
// ---------------------------------------------------------------------------

const ev = (type: string, payload: unknown): DeskEvent => ({
  id: 'x', seq: 0, ts: Date.now(), matchClock: null,
  source: 'manual', confidence: 'authoritative',
  type: type as DeskEvent['type'], payload,
});

const panelOf = (s: DeskState): PanelState | null => s.panel;

test('panel.show keeps the order it was given: seat one is screen left', () => {
  const after = reduce(initialState(), ev('panel.show', {
    title: 'Match preview',
    people: [
      { name: 'A', role: 'Analyst' },
      { name: 'B', role: 'Play-by-play' },
      { name: 'C', role: 'Drive coach', team: 254 },
    ],
  }));
  assert.deepEqual(panelOf(after)?.people.map(p => p.name), ['A', 'B', 'C']);
  assert.equal(panelOf(after)?.people[2]?.team, 254);
  assert.equal(panelOf(after)?.title, 'Match preview');
});

test('a nameless entry is dropped, and an empty panel is a hide', () => {
  const blank = reduce(initialState(), ev('panel.show', { people: [{ name: '  ' }] }));
  assert.equal(panelOf(blank), null, 'a panel of nobody must not leave a plate on air');

  const up = reduce(initialState(), ev('panel.show', { people: [{ name: 'A', role: 'Analyst' }] }));
  assert.equal(panelOf(up)?.people.length, 1);
  assert.equal(panelOf(reduce(up, ev('panel.hide', {}))), null);
});

test('a junk team number becomes null rather than reaching the graphic', () => {
  const after = reduce(initialState(), ev('panel.show', {
    people: [{ name: 'A', role: 'Analyst', team: 'not a number' }],
  }));
  assert.equal(panelOf(after)?.people[0]?.team, null);
});

test('the panel title falls back rather than rendering an empty band', () => {
  const after = reduce(initialState(), ev('panel.show', { people: [{ name: 'A' }] }));
  assert.equal(panelOf(after)?.title, 'Analysis desk');
});

test('a student airs as a given name and a family initial', () => {
  assert.equal(shortenForMinor('Alex Rivera'), 'Alex R.');
  assert.equal(shortenForMinor('Maria de la Cruz'), 'Maria de la C.');
  assert.equal(shortenForMinor('Nguyen Van Minh'), 'Nguyen Van M.');
  // Nothing to shorten, and "A." would be worse than the name.
  assert.equal(shortenForMinor('Bolt'), 'Bolt');
  // The first LETTER, not the first character: an initial of '"' is gibberish.
  assert.equal(shortenForMinor('Jordan (Jo) "Ace"'), 'Jordan (Jo) A.');
});

test('the flag changes what airs and nothing else', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.load();
    const [p] = await book.resolve([
      { name: 'Alex Rivera', role: 'Drive coach', team: 846, student: true },
    ]);
    assert.equal(p!.name, 'Alex Rivera', 'the book keeps the real name; the operator needs it');
    assert.equal(p!.display, 'Alex R.', 'the graphic gets the short one');
    assert.equal(p!.team, 846, 'nothing else is hidden');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an upgraded book does not lose every adult surname', async () => {
  // A book written before the flag existed has no `student` field, and
  // treating a missing field as anything but false would shorten the whole
  // commentary team on the first restart after the upgrade.
  const dir = await scratch();
  try {
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'profiles.json'), JSON.stringify([
      { id: 'p1', name: 'Sam Whitfield', role: 'Play-by-play', team: null, lastUsedAt: 1, uses: 3 },
    ]));
    const book = new ProfileBook(dir);
    await book.load();
    assert.equal(book.list[0]!.display, 'Sam Whitfield');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('omitting the flag is not the same as clearing it', async () => {
  // The desk sends {id, name, role, team} on every panel push. If a missing
  // field read as "adult", a student's surname would come back the second time
  // they were put on air.
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.load();
    const [p] = await book.resolve([{ name: 'Alex Rivera', team: 846, student: true }]);
    const [again] = await book.resolve([{ id: p!.id, name: 'Alex Rivera', team: 846 }]);
    assert.equal(again!.display, 'Alex R.');
    // Explicitly clearing it does work: somebody ticked the wrong row.
    const [cleared] = await book.resolve([
      { id: p!.id, name: 'Alex Rivera', team: 846, student: false },
    ]);
    assert.equal(cleared!.display, 'Alex Rivera');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the derived name is not written to disk', async () => {
  // A stale `display` in the file would outrank the name it came from after
  // somebody hand-edited the JSON.
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.load();
    await book.resolve([{ name: 'Alex Rivera', team: 846, student: true }]);
    const raw = JSON.parse(await readFile(join(dir, 'data', 'profiles.json'), 'utf8')) as
      Record<string, unknown>[];
    assert.equal('display' in raw[0]!, false);
    assert.equal(raw[0]!.student, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
