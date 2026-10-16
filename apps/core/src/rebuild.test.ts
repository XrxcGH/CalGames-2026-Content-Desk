import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFromDay, rebuildFromLog, type Observer } from './rebuild.ts';
import { localStamp } from './bus.ts';
import { CardLedger } from './cards.ts';
import type { DeskEvent } from './types.ts';

/**
 * A moment in 2026, in LOCAL time, which is the clock the log names and the
 * day filter both run on. Built with the local-time constructor rather than
 * an ISO string so every test here means the same thing on a machine in any
 * time zone. CalGames 2026 is Friday 16 to Sunday 18 October.
 */
const local = (month: number, day: number, hour: number, minute = 0): Date =>
  new Date(2026, month - 1, day, hour, minute, 0);

const line = (type: string, payload: Record<string, unknown>, at: Date): string =>
  JSON.stringify({
    type, payload, ts: at.getTime(), seq: 1, source: 'cheesy', confidence: 'authoritative',
  });

/** The file name bus.openLog gives a log opened at `opened`. */
const named = (opened: Date, tag?: string): string =>
  `${localStamp(opened)}${tag ? `.${tag}` : ''}.ndjson`;

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

const names = (s: { seen: DeskEvent[] }): string[] =>
  s.seen.map(e => (e.payload as { displayName?: string }).displayName ?? e.type);

test('a restart carries the morning back into the card ledger', async () => {
  // The failure this exists for: the desk restarts after lunch, the ledger
  // opens empty, and the announcer is told a team carrying a yellow from
  // Q12 has a clean slate.
  const dir = await logs({
    [named(local(10, 17, 9, 2))]: [
      line('match.loaded', { displayName: 'Qualification 12' }, local(10, 17, 9, 5)),
      line('card.issued', { team: 254, card: 'yellow', alliance: 'red' }, local(10, 17, 9, 6)),
    ].join('\n'),
  });
  try {
    const ledger = new CardLedger();
    const out = await rebuildFromLog(dir, [ledger], local(10, 17, 14));
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
    [named(local(10, 16, 9))]: line('match.loaded', { displayName: 'Practice 1' }, local(10, 16, 9, 5)),
    [named(local(10, 17, 9))]: line('match.loaded', { displayName: 'Qualification 1' }, local(10, 17, 9, 5)),
  });
  try {
    const s = spy();
    const out = await rebuildFromLog(dir, [s], local(10, 17, 14));
    assert.deepEqual(names(s), ['Qualification 1']);
    // Yesterday's file IS opened (a Saturday event can be in it, see below),
    // and what it holds of yesterday is counted as left alone, not as today.
    assert.equal(out.files, 2);
    assert.equal(out.otherDay, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Sunday desk still knows Saturday\'s qual yellows, and nothing else of Saturday', async () => {
  /*
   * Qualifications run Saturday into Sunday morning. A desk switched on for
   * Sunday (or restarted then) rebuilt from Sunday alone, so a team carded
   * in Saturday's Q30 played Sunday's Q41 as clean, and a second yellow
   * showed as a first. The cards take yesterday too; everything else is a
   * day's own record and stays today's.
   */
  const dir = await logs({
    [named(local(10, 17, 8))]: [
      // A hand-merged line from two days back counts for nothing, whatever
      // file it sits in.
      line('card.issued', { team: 1678, card: 'yellow', alliance: 'blue', match: 'Practice 2' },
        local(10, 16, 16)),
      line('match.loaded', { displayName: 'Qualification 30' }, local(10, 17, 15)),
      line('card.issued', { team: 253, card: 'yellow', alliance: 'red', match: 'Qualification 30' },
        local(10, 17, 15, 2)),
    ].join('\n'),
    // Two days back is not opened at all.
    [named(local(10, 16, 9))]: line('card.issued', { team: 1678, card: 'yellow', alliance: 'blue' },
      local(10, 16, 9, 5)),
  });
  try {
    const ledger = new CardLedger();
    const cards = Object.assign(spy(), { alsoYesterday: true });
    const day = spy();
    const out = await rebuildFromLog(dir, [
      { observe: ev => ledger.observe(ev), alsoYesterday: true }, cards, day,
    ], local(10, 18, 8, 40));
    assert.equal(ledger.forTeam(253)?.carrying, true, "Saturday's yellow is live on Sunday morning");
    assert.equal(ledger.forTeam(1678), null, 'and Friday is not part of it');
    assert.deepEqual(names(cards), ['Qualification 30', 'card.issued']);
    assert.deepEqual(day.seen, [], 'the coverage, rundown and the rest stay Sunday only');
    assert.equal(out.events, 0);
    assert.equal(out.carried, 2);
    assert.equal(out.files, 1, 'only yesterday and today are opened');

    // Sunday's playoffs retire it by the phase rule, not by the calendar.
    await writeFile(join(dir, named(local(10, 18, 13))),
      line('match.loaded', { displayName: 'Match 1' }, local(10, 18, 13, 5)));
    const later = new CardLedger();
    await rebuildFromLog(dir, [{ observe: ev => later.observe(ev), alsoYesterday: true }],
      local(10, 18, 14));
    assert.equal(later.forTeam(253)?.carrying, false, 'a qual yellow is spent in the playoffs');
    assert.equal(later.forTeam(253)?.yellows, 1, 'though the weekend total still has it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Saturday in a Friday-named file is still Saturday', async () => {
  // The desk ran from Friday morning straight through, the log was opened
  // once and named for the moment it opened, so all of Saturday morning sat
  // in a Friday-named file. Choosing files by name, a Saturday restart found
  // nothing to rebuild from: cards, coverage, run of show, sponsor counts and
  // awards-presented all gone, with the file holding them right there. The
  // bus rotates at midnight now, but a file can still straddle it (killed at
  // 23:59, restarted at 00:10; a log copied in from another machine), so the
  // event's own stamp decides, never the name on the file.
  const dir = await logs({
    [named(local(10, 16, 8))]: [
      line('match.loaded', { displayName: 'Practice 3' }, local(10, 16, 15)),
      line('card.issued', { team: 1678, card: 'yellow', alliance: 'blue' }, local(10, 16, 15, 2)),
      line('match.loaded', { displayName: 'Qualification 1' }, local(10, 17, 9)),
      line('card.issued', { team: 254, card: 'yellow', alliance: 'red' }, local(10, 17, 9, 4)),
    ].join('\n'),
    [named(local(10, 17, 11))]:
      line('match.loaded', { displayName: 'Qualification 9' }, local(10, 17, 11, 1)),
  });
  try {
    const saturday = spy();
    const ledger = new CardLedger();
    const out = await rebuildFromLog(dir, [saturday, ledger], local(10, 17, 14));
    assert.deepEqual(names(saturday), ['Qualification 1', 'card.issued', 'Qualification 9'],
      'Saturday morning out of the Friday file, then the Saturday file, in order');
    assert.equal(out.files, 2);
    assert.equal(out.otherDay, 2, "Friday's two events were read and left alone");
    assert.equal(ledger.forTeam(254)?.carrying, true, "Saturday's yellow is back");
    assert.ok(!ledger.forTeam(1678)?.carrying, "Friday's yellow is not dragged into Saturday");

    // And the same file read on Friday evening gives Friday's events only.
    const friday = spy();
    await rebuildFromLog(dir, [friday], local(10, 16, 20));
    assert.deepEqual(names(friday), ['Practice 3', 'card.issued']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an event with no usable stamp belongs to the file it is in', async () => {
  // A hand-edited or hand-merged line without a ts cannot be placed on a day
  // by itself. Dropping it silently would lose a real event; the file's day is
  // the best available answer, which is also what the rule was before.
  const bare = (displayName: string): string =>
    JSON.stringify({ type: 'match.loaded', payload: { displayName }, source: 'cheesy' });
  const dir = await logs({
    [named(local(10, 16, 9))]: bare('FRI'),
    [named(local(10, 17, 9))]: bare('Q1'),
  });
  try {
    const s = spy();
    const out = await rebuildFromLog(dir, [s], local(10, 17, 14));
    assert.deepEqual(names(s), ['Q1']);
    assert.equal(out.otherDay, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('yesterday is the calendar day before, even on the 25-hour day', async () => {
  // 1 November 2026 is the autumn clock change at a US venue, and 23:30 that
  // day minus 24 hours is 00:30 the SAME day: computed that way, "yesterday"
  // was today and the straddling file was never opened. In a zone without a
  // clock change this passes trivially, which is fine; it pins the venue's.
  const dir = await logs({
    [named(local(10, 31, 20))]: line('match.loaded', { displayName: 'Late' }, local(11, 1, 0, 20)),
  });
  try {
    const s = spy();
    await rebuildFromLog(dir, [s], local(11, 1, 23, 30));
    assert.deepEqual(names(s), ['Late']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sample data is never history', async () => {
  // The Sample data button logs into the real day's log like anything else on
  // the bus. Folded back in on a restart, a real team carried the sample's
  // yellow for the rest of qualifications.
  const demo = JSON.stringify({
    type: 'card.issued', payload: { team: 9999, card: 'yellow', alliance: 'red' },
    ts: local(10, 17, 9, 1).getTime(), seq: 1, source: 'demo', confidence: 'authoritative',
  });
  const dir = await logs({
    [named(local(10, 17, 9))]: [demo, line('match.loaded', { displayName: 'Q1' }, local(10, 17, 9, 2))].join('\n'),
  });
  try {
    const s = spy();
    const out = await rebuildFromLog(dir, [s], local(10, 17, 14));
    assert.deepEqual(names(s), ['Q1']);
    assert.equal(out.skipped, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a torn last line is expected, not fatal', async () => {
  // What a power cut leaves behind. Refusing to start a desk somebody is
  // standing in front of would be a much worse answer than skipping a line.
  const dir = await logs({
    [named(local(10, 17, 9))]:
      line('match.loaded', { displayName: 'Qualification 1' }, local(10, 17, 9, 5)) + '\n{"type":"match.st',
  });
  try {
    const s = spy();
    const out = await rebuildFromLog(dir, [s], local(10, 17, 14));
    assert.equal(out.events, 1);
    assert.equal(out.skipped, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no log directory is a fresh desk, not an error', async () => {
  const out = await rebuildFromLog(join(tmpdir(), 'cg-rebuild-nope'), [spy()]);
  assert.deepEqual(out, { files: 0, events: 0, skipped: 0, otherDay: 0, carried: 0 });
});

test('one observer throwing does not cost the others their history', async () => {
  const dir = await logs({
    [named(local(10, 17, 9))]: line('match.loaded', { displayName: 'Q1' }, local(10, 17, 9, 5)),
  });
  try {
    const bad: Observer = { observe: () => { throw new Error('boom'); } };
    const good = spy();
    await rebuildFromLog(dir, [bad, good], local(10, 17, 14));
    assert.equal(good.seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('files are read oldest first, because order is the whole point', async () => {
  const dir = await logs({
    [named(local(10, 17, 13))]: line('match.loaded', { displayName: 'Q9' }, local(10, 17, 13, 1)),
    [named(local(10, 17, 9))]: line('match.loaded', { displayName: 'Q1' }, local(10, 17, 9, 1)),
  });
  try {
    const s = spy();
    await rebuildFromLog(dir, [s], local(10, 17, 14));
    assert.deepEqual(names(s), ['Q1', 'Q9']);
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

test('an evening restart still finds the morning, and does not eat yesterday', async () => {
  // The day used to be computed in UTC while the event ran in Pacific, so the
  // calendar flipped at 5pm local, mid-show: a 5:30pm restart matched no files
  // at all and every ledger reopened blank, while the next morning matched the
  // previous evening's log and replayed it into a fresh day. Both directions
  // are pinned here because one fix has to hold both.
  const fridayEvening = new Date('2026-10-16T18:00:00-07:00');
  const morning = new Date('2026-10-17T09:00:00-07:00');
  const evening = new Date('2026-10-17T17:30:00-07:00');
  const nextDay = new Date('2026-10-18T09:00:00-07:00');

  const dir = await logs({
    [named(morning)]: line('match.loaded', { displayName: 'Q1' }, morning),
    [named(fridayEvening)]: line('match.loaded', { displayName: 'FRI' }, fridayEvening),
  });
  try {
    const evenings = spy();
    await rebuildFromLog(dir, [evenings], evening);
    assert.deepEqual(names(evenings), ['Q1'],
      'the 5:30pm restart restores the morning and only the morning');

    const sunday = spy();
    await rebuildFromLog(dir, [sunday], nextDay);
    assert.deepEqual(sunday.seen, [], 'the next day starts clean');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('log names sort chronologically as strings, which is how they are replayed', () => {
  const stamps = [
    new Date('2026-10-17T09:00:00-07:00'),
    new Date('2026-10-17T14:00:00-07:00'),
    new Date('2026-10-17T17:30:00-07:00'),
    new Date('2026-10-17T23:45:00-07:00'),
  ].map(localStamp);
  assert.deepEqual([...stamps].sort(), stamps);
});

test('a rehearsal log is not part of the day', () => {
  // --demo and --replay sessions log under a tagged name so the events they
  // fabricate never feed the next boot's ledgers.
  assert.equal(isFromDay('2026-10-17-09-14-02.ndjson', '2026-10-17'), true);
  assert.equal(isFromDay('2026-10-17-09-14-02.rehearsal.ndjson', '2026-10-17'), false);
  assert.equal(isFromDay('2026-10-17-09-14-02.REHEARSAL.ndjson', '2026-10-17'), false);
});
