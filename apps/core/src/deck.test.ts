import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { attachPace } from './pace.ts';
import { projectDeck } from './deck.ts';
import { fieldMatchKey, matchKey, sameMatch } from './match-key.ts';
import { rebuildFromLog } from './rebuild.ts';
import { localStamp } from './bus.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NexusAdapter } from './ingest/nexus/adapter.ts';
import { NexusClient, type NexusEventStatus, type NexusMatch } from './ingest/nexus/client.ts';
import type { UpcomingMatch } from './types.ts';

/**
 * The on-deck view (deck.ts) against every way queuers drive Nexus by hand,
 * through the REAL reducer and the REAL Nexus adapter. The bug these pin:
 * Nexus drops a match from its pending list the moment it is marked "On
 * field", so the deck's row 0 was the match AFTER the one about to start, and
 * every estimate on every screen read a full cycle early.
 */

const MIN = 60_000;

// ---- match identity -----------------------------------------------------------

test('the field and the queue name the same match differently, and the key folds them', () => {
  const same = (a: string, b: string) => sameMatch(matchKey(a), matchKey(b));
  assert.ok(same('Qualification 12', 'Q12'));
  assert.ok(same('Practice 3', 'P3'));
  // Cheesy calls a double elimination match "Match 7"; Nexus calls it "Playoff 7".
  assert.ok(same('Match 7', 'Playoff 7'));
  assert.ok(same('M7', 'Playoff 7'));
  assert.ok(same('Match 7 (R2)', 'Playoff 7'), 'the FIRST title form');
  assert.ok(same('Final 1', 'F1'));
  assert.ok(same('Qualification 24 Replay', 'Q24R'), 'Nexus label and its own short form');
  assert.ok(!same('Qualification 24', 'Qualification 24 Replay'));
  assert.ok(!same('Final 1', 'Playoff 1'));
});

test('a name outside the grammar has no key, so callers fall back instead of guessing', () => {
  for (const name of ['', 'Test Match', 'Overtime 1', 'SF2-3', 'Qualification 24R', 'Qualification 0',
    'Lunch', 'Qualification 24 Replay 2']) {
    assert.equal(matchKey(name), null, name);
  }
});

test('the loaded match: a replay is run 2 under the original name, and the field kind vetoes', () => {
  const m = (displayName: string, kind?: 'test' | 'practice' | 'qualification' | 'playoff') =>
    ({ displayName, ...(kind ? { kind } : {}) });
  assert.deepEqual(fieldMatchKey(m('Qualification 24'), 2),
    { kind: 'qualification', number: 24, replay: true });
  assert.deepEqual(fieldMatchKey(m('Qualification 24'), 3),
    { kind: 'qualification', number: 24, replay: true },
    'run 3 is not a trustworthy COUNT, but it is certainly a replay');
  assert.equal(fieldMatchKey(m('Match 7', 'qualification'), 1), null, 'a qual is not Match 7');
  assert.ok(fieldMatchKey(m('Final 2', 'playoff'), 1), 'Cheesy finals are type Playoff');
  assert.equal(fieldMatchKey(m('Test Match', 'test'), 1), null);
  assert.equal(fieldMatchKey(null, 1), null);
});

// ---- a desk with a field and a Nexus queue -----------------------------------

const row = (label: string, status: string, extra: Partial<NexusMatch> = {}): NexusMatch => ({
  label, status, redTeams: [], blueTeams: [], ...extra,
});

/**
 * Qualifications 38 to 50. Everything up to and including `through` is "On
 * field" (played, or on the field now), plus any listed in `alsoOnField`.
 */
const quals = (through: number, alsoOnField: number[] = []): NexusMatch[] => {
  const out: NexusMatch[] = [];
  for (let n = 38; n <= 50; n++) {
    out.push(row(`Qualification ${n}`, n <= through || alsoOnField.includes(n) ? 'On field' : 'Queuing soon'));
  }
  return out;
};

function desk() {
  const bus = new EventBus();
  const nexus = new NexusAdapter({
    bus, apiKey: 'k', eventKey: '2026cacg',
    client: new NexusClient({ apiKey: 'k', eventKey: '2026cacg' }),
  });
  let asOf = 1;
  const d = {
    bus,
    nexus(matches: NexusMatch[]) {
      nexus.apply({
        eventKey: '2026cacg', dataAsOfTime: asOf++, nowQueuing: null, matches, announcements: [],
      } as NexusEventStatus);
    },
    field(upcoming: UpcomingMatch[]) {
      bus.emit({ type: 'queue.updated', source: 'cheesy', payload: { upcoming } });
    },
    load(displayName: string, run = 1, extra: Record<string, unknown> = {}) {
      bus.emit({
        type: 'match.loaded', source: 'cheesy',
        payload: { id: displayName, displayName, red: [], blue: [], run, ...extra },
      });
    },
    start(ts?: number) { bus.emit({ type: 'match.start', source: 'cheesy', ...(ts ? { ts } : {}) }); },
    commit() { bus.emit({ type: 'match.score_posted', source: 'cheesy', payload: {} }); },
    /** The deck as the screens read it: "Q43:0", "Q42:field". */
    view(): string[] {
      const { rows, offs } = bus.state.deck;
      return rows.map((r, i) => `${r.shortName}:${offs[i] === null ? 'field' : offs[i]}`);
    },
  };
  return d;
}

test('THE BUG: a queuer marks the next match On field before it starts', () => {
  const d = desk();
  d.load('Qualification 42'); d.start();
  d.nexus(quals(42));
  assert.deepEqual(d.view().slice(0, 3), ['Q42:field', 'Q43:0', 'Q44:1'],
    'the match on the field is shown as on the field, the next as next');

  d.commit();
  assert.deepEqual(d.view().slice(0, 2), ['Q43:0', 'Q44:1']);

  d.load('Qualification 43');
  assert.deepEqual(d.view().slice(0, 2), ['Q43:0', 'Q44:1'], 'loaded, not yet marked');

  // The window the bug lived in: Nexus has dropped Q43, the field has not
  // started it. The old rule made Q44 row 0 with Q43's start time.
  d.nexus(quals(43));
  assert.deepEqual(d.bus.state.upcoming[0]?.name, 'Qualification 44', 'Nexus really did drop it');
  assert.deepEqual(d.view().slice(0, 3), ['Q43:0', 'Q44:1', 'Q45:2']);

  d.start();
  assert.deepEqual(d.view().slice(0, 2), ['Q43:field', 'Q44:0']);
});

test('a queuer marks the next match On field while the previous one is still playing', () => {
  const d = desk();
  d.load('Qualification 42'); d.start();
  d.nexus(quals(43));
  assert.deepEqual(d.view().slice(0, 3), ['Q42:field', 'Q43:0', 'Q44:1']);
  d.commit();
  assert.deepEqual(d.view().slice(0, 2), ['Q43:0', 'Q44:1'],
    'after the commit the marked-but-unplayed match is still the next to start');
});

test('a queuer skips a match and marks the one after it', () => {
  const d = desk();
  d.load('Qualification 43');
  d.nexus(quals(42, [44]));
  assert.deepEqual(d.view().slice(0, 3), ['Q43:0', 'Q44:1', 'Q45:2']);
});

test('queuers who lag the field: played rows leave the deck instead of being "up next"', () => {
  const d = desk();
  d.load('Qualification 44'); d.start();
  d.nexus(quals(42));
  assert.deepEqual(d.view().slice(0, 2), ['Q44:field', 'Q45:0'], 'Q43 was played; it is not next');

  const e = desk();
  e.load('Qualification 43'); e.start(); e.commit();
  e.nexus(quals(42));
  assert.deepEqual(e.view()[0], 'Q44:0', 'committed and still listed is still played');
});

test('playoffs: the field\'s "Match 7" is Nexus\'s "Playoff 7"', () => {
  const d = desk();
  d.load('Match 7', 1, { kind: 'playoff' });
  d.nexus([
    row('Playoff 6', 'On field'), row('Playoff 7', 'On field'),
    row('Playoff 8', 'On deck'), row('Playoff 9', 'Queuing soon'),
  ]);
  assert.deepEqual(d.view(), ['M7:0', 'M8:1', 'M9:2']);
  d.start();
  assert.deepEqual(d.view(), ['M7:field', 'M8:0', 'M9:1']);
});

test('a replay: the field reloads the original name, the queuers list a Replay row', () => {
  const d = desk();
  d.load('Qualification 24', 2);
  d.nexus([
    row('Qualification 30', 'On field'),
    row('Qualification 24 Replay', 'On field', { replayOf: 'Qualification 24' }),
    row('Qualification 31', 'On deck'),
  ]);
  assert.deepEqual(d.view(), ['Q24R:0', 'Q31:1']);
});

test('an ABORTED match re-run is the Replay row the queuers added for it', () => {
  // The arena says run 1 (no result existed, so it is not a "replay" to the
  // arena), while the queuers list a Replay row. That row is the run.
  const a = desk();
  a.load('Qualification 30'); a.start();
  a.bus.emit({ type: 'match.aborted', source: 'cheesy' });
  a.load('Qualification 30');
  a.nexus([
    row('Qualification 30', 'On field'),
    row('Qualification 30 Replay', 'On field', { replayOf: 'Qualification 30' }),
    row('Qualification 31', 'Queuing soon'),
  ]);
  assert.deepEqual(a.view(), ['Q30R:0', 'Q31:1']);
  a.start();
  assert.deepEqual(a.view(), ['Q30R:field', 'Q31:0']);
});

test('anything ambiguous falls back to the old rule', () => {

  // A name outside the grammar.
  const b = desk();
  b.load('Overtime 1'); b.start();
  b.nexus([row('Final 3', 'On field'), row('Final 4', 'On deck')]);
  assert.deepEqual(b.view(), ['F4:0']);

  // Same number, different teams: not the same match, whatever the names say.
  const c = desk();
  c.bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: {
      id: 'm7', displayName: 'Match 7', kind: 'playoff', run: 1,
      red: [254, 846, 1678].map(number => ({ number, name: '' })),
      blue: [971, 1868, 100].map(number => ({ number, name: '' })),
    },
  });
  c.nexus([
    row('Playoff 7', 'On field', { redTeams: ['8', '604', '199'], blueTeams: ['1', '2', '3'] }),
    row('Playoff 8', 'On deck'),
  ]);
  assert.deepEqual(c.view(), ['M8:0']);
});

// ---- the field's word on what has been played ---------------------------------

const played = (d: ReturnType<typeof desk>, names: string[]) =>
  d.bus.emit({ type: 'schedule.played', source: 'cheesy', payload: { names } });

test('a match skipped and run later does not bring the ones played in between back', () => {
  // A no-show: the field skips Q43, plays Q44 to Q46, then runs Q43. The
  // queuers cannot reorder Nexus, so Q43 still sits before Q44 there.
  const d = desk();
  played(d, ['Qualification 42', 'Qualification 44', 'Qualification 45', 'Qualification 46']);
  d.load('Qualification 43');
  d.nexus(quals(42, [44, 45, 46]));
  assert.deepEqual(d.view().slice(0, 3), ['Q43:0', 'Q47:1', 'Q48:2']);
  d.start();
  assert.deepEqual(d.view().slice(0, 2), ['Q43:field', 'Q47:0']);
});

test('a desk restarted after a match was scored does not list it as next', () => {
  // The field still has Q43 loaded with its result up. The restarted desk saw
  // no start and, depending on socket order, no score either.
  const d = desk();
  d.load('Qualification 43');
  d.nexus(quals(43));
  played(d, ['Qualification 42', 'Qualification 43']);
  assert.deepEqual(d.view()[0], 'Q44:0');

  // The same with the field's own queue, which no longer lists Q43.
  const e = desk();
  e.load('Qualification 43');
  played(e, ['Qualification 43']);
  e.field([{ name: 'Qualification 44', shortName: 'Q44', time: null, red: [], blue: [] }]);
  assert.deepEqual(e.view(), ['Q44:0']);
});

test('a desk restarted after the buzzer, before the score, shows the match as on the field', () => {
  const d = desk();
  d.load('Qualification 43');
  d.bus.emit({ type: 'match.ended_before_join', source: 'cheesy' });
  d.nexus(quals(43));
  assert.deepEqual(d.view().slice(0, 2), ['Q43:field', 'Q44:0']);
  d.commit();
  assert.deepEqual(d.view()[0], 'Q44:0');
});

test('the field\'s own queue: unchanged where it was right, fixed where it was not', () => {
  const d = desk();
  const r = (n: number): UpcomingMatch => ({
    name: `Qualification ${n}`, shortName: `Q${n}`, time: null, red: [], blue: [],
  });
  d.load('Qualification 42');
  d.field([r(42), r(43), r(44)]);
  assert.deepEqual(d.view(), ['Q42:0', 'Q43:1', 'Q44:2']);
  d.start();
  assert.deepEqual(d.view(), ['Q42:field', 'Q43:0', 'Q44:1']);
  // The score posts; the arena's list is refreshed 1.5 s later. In between
  // the old rule put Q43's start time on Q42, which had just been played.
  d.commit();
  assert.deepEqual(d.view(), ['Q43:0', 'Q44:1']);

  // A replay in place: no longer Scheduled, so the arena's list leaves it
  // out. It still gets a row, at the top, as the next to start.
  const e = desk();
  e.load('Qualification 24', 2);
  e.field([r(31), r(32)]);
  assert.deepEqual(e.view(), ['Q24R:0', 'Q31:1', 'Q32:2']);
  e.start();
  assert.deepEqual(e.view(), ['Q24R:field', 'Q31:0', 'Q32:1']);

  // No match on the field at all: the queue as it comes.
  const f = desk();
  f.field([r(1), r(2)]);
  assert.deepEqual(f.view(), ['Q1:0', 'Q2:1']);
});

test('the field\'s queue taking over drops Nexus\'s rows with it', () => {
  const d = desk();
  d.load('Qualification 43');
  d.nexus(quals(43));
  assert.ok(d.bus.state.queueRecent.length > 0);
  d.field([{ name: 'Qualification 43', shortName: 'Q43', time: null, red: [], blue: [] }]);
  assert.deepEqual(d.bus.state.queueRecent, []);
  assert.deepEqual(d.view(), ['Q43:0']);
  // The banner clear after failed polls carries no list, and changes nothing.
  d.nexus(quals(43));
  const before = d.bus.state.queueRecent;
  d.bus.emit({ type: 'queue.updated', source: 'nexus', payload: { nowQueuing: null } });
  assert.equal(d.bus.state.queueRecent, before);
});

test('the deck is not rebuilt on events that cannot change it', () => {
  const d = desk();
  d.load('Qualification 42'); d.nexus(quals(42));
  const deck = d.bus.state.deck;
  d.bus.emit({ type: 'screen.change', source: 'manual', payload: { screen: 'match' } });
  assert.equal(d.bus.state.deck, deck);
});

test('the Nexus adapter sends the rows it dropped, and the published time apart from the estimate', () => {
  const d = desk();
  const seen: unknown[] = [];
  d.bus.subscribe(ev => { if (ev.type === 'queue.updated') seen.push(ev.payload); });
  d.nexus([
    ...quals(46).map(m => m.label === 'Qualification 47'
      ? { ...m, times: { scheduledStartTime: 1_700_000_000_000, estimatedStartTime: 1_700_000_900_000 } }
      : m),
  ]);
  const p = seen[0] as { recent: UpcomingMatch[]; upcoming: UpcomingMatch[] };
  assert.deepEqual(p.recent.map(m => m.shortName),
    ['Q38', 'Q39', 'Q40', 'Q41', 'Q42', 'Q43', 'Q44', 'Q45', 'Q46'],
    'the rows before the cut (up to sixteen), in Nexus order');
  assert.equal(p.upcoming[0]?.scheduled, new Date(1_700_000_000_000).toISOString());
  assert.equal(p.upcoming[0]?.time, new Date(1_700_000_900_000).toISOString(), 'time stays the estimate');
});

// ---- the estimates themselves, end to end ------------------------------------

test('in the bug window every printed estimate is right, and behind schedule reads zero on time', () => {
  const d = desk();
  const updates: { behindMin: number | null }[] = [];
  const detach = attachPace(d.bus);
  d.bus.subscribe(ev => {
    if (ev.type === 'pace.updated') updates.push(ev.payload as { behindMin: number | null });
  });
  try {
    // An event running exactly on a 7 minute schedule: Q41 at t0, Q42 at t0+7.
    const t0 = Date.now() - 8 * MIN;
    const at = (n: number) => t0 + (n - 41) * 7 * MIN;
    const sched = (through: number) => quals(through).map(m => ({
      ...m, times: { scheduledStartTime: at(Number(m.label!.split(' ')[1])) },
    }));
    d.load('Qualification 41'); d.nexus(sched(41)); d.start(at(41)); d.commit();
    d.load('Qualification 42'); d.nexus(sched(42)); d.start(at(42)); d.commit();
    d.load('Qualification 43');
    d.nexus(sched(43));                          // marked On field, not started

    const { rows, etas } = d.bus.state.deck;
    assert.equal(rows[0]?.shortName, 'Q43');
    assert.equal(etas[0], at(43), 'Q43 is estimated at its own slot');
    assert.equal(etas[1], at(44), 'and Q44 one cycle after, not at Q43\'s');
    assert.equal(updates.at(-1)!.behindMin, 0, 'the old pairing read 7 minutes AHEAD here');
  } finally {
    detach();
  }
});

test('a Nexus estimate is never taken for the published schedule', () => {
  const d = desk();
  const detach = attachPace(d.bus);
  try {
    const t0 = Date.now() - 8 * MIN;
    // Estimates only, an hour after the starts: the event is an hour late by
    // nobody's schedule, so there is no figure to give.
    const est = quals(42).map(m => ({ ...m, times: { estimatedStartTime: t0 + 60 * MIN } }));
    d.load('Qualification 41'); d.nexus(est); d.start(t0); d.commit();
    d.load('Qualification 42'); d.start(t0 + 7 * MIN);
    assert.equal(d.bus.state.pace.behindMin, null);
  } finally {
    detach();
  }
});

test('behind schedule with a replay first in line is measured from the first published time', () => {
  // A row the deck made up for a replay has no published time. Blank was
  // wrong, and so was HEAD's figure: Q43 now starts a full cycle after its
  // slot, because the replay goes first.
  const d = desk();
  const detach = attachPace(d.bus);
  try {
    const t0 = Date.now() - 15 * MIN;
    const at = (n: number) => t0 + (n - 40) * 7 * MIN;
    const r = (n: number): UpcomingMatch => ({
      name: `Qualification ${n}`, shortName: `Q${n}`, time: new Date(at(n)).toISOString(), red: [], blue: [],
    });
    for (const n of [40, 41, 42]) { d.load(`Qualification ${n}`); d.start(at(n)); d.commit(); }
    d.load('Qualification 41', 2);
    d.field([r(43), r(44), r(45)]);
    assert.deepEqual(d.view().slice(0, 2), ['Q41R:0', 'Q43:1']);
    assert.equal(d.bus.state.pace.behindMin, 7);
  } finally {
    detach();
  }
});

test('the sample\'s match start never makes a cycle with the field\'s first real one', () => {
  const d = desk();
  const detach = attachPace(d.bus);
  try {
    const t = Date.now() - 20 * MIN;
    d.bus.emit({ type: 'match.start', source: 'demo', ts: t });
    d.load('Qualification 1'); d.start(t + 5 * MIN); d.commit();
    d.load('Qualification 2'); d.start(t + 12 * MIN);
    assert.equal(d.bus.state.pace.cycleSec, 7 * 60, 'the real cycle, not the median of 5 and 7');
  } finally {
    detach();
  }
});

// ---- breaks, restarts, bursts ---------------------------------------------------

const qrow = (n: number, at: number | null, extra: Partial<UpcomingMatch> = {}): UpcomingMatch => ({
  name: `Qualification ${n}`, shortName: `Q${n}`, time: at === null ? null : new Date(at).toISOString(),
  red: [], blue: [], ...extra,
});

test('lunch: the first match after it is estimated at its published time, not at the clock', () => {
  // Q50 went at 11:55 on a 7 minute cycle; lunch; Q51 is printed for 12:45.
  // It is 12:10. The estimate used to walk with the clock: "~12:10".
  const t1155 = Date.parse('2026-10-17T11:55:00');
  const now = t1155 + 15 * MIN;
  const deck = { rows: [qrow(51, t1155 + 50 * MIN), qrow(52, t1155 + 57 * MIN)], offs: [0, 1] };
  const etas = projectDeck(deck, { nextStartAt: now, cycleSec: 420, lastStartAt: t1155 }, 'field');
  assert.deepEqual(etas, [t1155 + 50 * MIN, t1155 + 57 * MIN]);

  // A field running late into lunch comes back no earlier than printed, and
  // later if the morning ran over it.
  const late = projectDeck(deck, {
    nextStartAt: t1155 + 60 * MIN, cycleSec: 420, lastStartAt: t1155 + 53 * MIN,
  }, 'field');
  assert.deepEqual(late, [t1155 + 60 * MIN, t1155 + 67 * MIN]);
});

test('a break in the middle of the list is waited out there, and only there', () => {
  const t0 = Date.parse('2026-10-17T11:41:00');
  const deck = {
    rows: [qrow(48, t0), qrow(49, t0 + 7 * MIN), qrow(50, t0 + 14 * MIN), qrow(51, t0 + 64 * MIN)],
    offs: [0, 1, 2, 3],
  };
  const etas = projectDeck(deck, {
    nextStartAt: t0 + 5 * MIN, cycleSec: 420, lastStartAt: t0 - 2 * MIN,
  }, 'field');
  assert.deepEqual(etas, [t0 + 5 * MIN, t0 + 12 * MIN, t0 + 19 * MIN, t0 + 64 * MIN],
    'five behind through the morning, back on the printed time after lunch');
});

test('the queuers\' "break after" is a break, with Nexus\'s own estimate as the floor', () => {
  const t0 = Date.parse('2026-10-17T11:55:00');
  const deck = {
    rows: [qrow(51, t0 + 50 * MIN), qrow(52, t0 + 57 * MIN)], offs: [0, 1], breakBefore: true,
  };
  const etas = projectDeck(deck, { nextStartAt: t0 + 15 * MIN, cycleSec: 420, lastStartAt: t0 }, 'nexus');
  assert.equal(etas[0], t0 + 50 * MIN, 'no published time under Nexus: its estimate is the floor');

  // Through the real adapter: the row before the cut carries the break.
  const d = desk();
  const ms = quals(50).map(m => (m.label === 'Qualification 50' ? { ...m, breakAfter: 'Lunch' } : m));
  d.load('Qualification 50'); d.start(); d.commit();
  d.nexus(ms);
  assert.equal(d.bus.state.deck.breakBefore, true);
});

test('overnight: a desk left running from Friday practice waits for Saturday\'s first match', () => {
  const fri = Date.parse('2026-10-16T19:40:00');
  const sat9 = Date.parse('2026-10-17T09:00:00');
  const deck = { rows: [qrow(1, sat9), qrow(2, sat9 + 7 * MIN)], offs: [0, 1] };
  const etas = projectDeck(deck, {
    nextStartAt: sat9 - 60 * MIN, cycleSec: 420, lastStartAt: fri,
  }, 'field');
  assert.deepEqual(etas, [sat9, sat9 + 7 * MIN]);
});

test('after a restart the pace comes back from the day\'s log, not two matches later', async ctx => {
  // The clock is pinned to midday. The fixture's starts run from 30 minutes
  // ago, and in the half hour after midnight that is yesterday, which the
  // rebuild rightly leaves out: the test failed every night from 00:00 to
  // 00:30 while the desk was doing exactly what it should.
  ctx.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 17, 12, 0, 0).getTime() });
  const dir = await mkdtemp(join(tmpdir(), 'cg-pace-'));
  try {
    const t = Date.now() - 30 * MIN;
    const line = (ts: number, source = 'cheesy') => JSON.stringify({
      id: String(ts), ts, matchClock: null, source, confidence: 'authoritative',
      type: 'match.start', payload: {},
    });
    await writeFile(join(dir, `${localStamp(new Date())}.ndjson`),
      [line(t), line(t + 7 * MIN), line(t + 14 * MIN, 'demo'), line(t + 21 * MIN)].join('\n') + '\n');
    const bus = new EventBus();
    const pace = attachPace(bus);
    try {
      await rebuildFromLog(dir, [pace]);
      await new Promise(r => setTimeout(r, 5));
      assert.equal(bus.state.pace.lastStartAt, t + 21 * MIN, 'the last real start; the sample one skipped');
      assert.equal(bus.state.pace.cycleSec, 7 * 60 * 1.5,
        'median of the real cycles, 7 and 14 minutes: the sample start never joined them');
    } finally {
      pace();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a queuer catching up a dozen matches in one go still leaves the field\'s match findable', () => {
  const d = desk();
  const many: NexusMatch[] = [];
  for (let n = 30; n <= 60; n++) many.push(row(`Qualification ${n}`, n <= 54 ? 'On field' : 'Queuing soon'));
  d.load('Qualification 43'); d.start();
  d.nexus(many);
  assert.deepEqual(d.view().slice(0, 2), ['Q43:field', 'Q44:0']);
});

test('a replay loaded before the queuers have added its Replay row', () => {
  const d = desk();
  played(d, ['Qualification 24', 'Qualification 30']);
  d.load('Qualification 24', 2);
  d.nexus([
    row('Qualification 24', 'On field'), row('Qualification 30', 'On field'),
    row('Qualification 31', 'On field'),   // marked, not yet played
    row('Qualification 32', 'On deck'),
  ]);
  assert.deepEqual(d.view(), ['Q24R:0', 'Q31:1', 'Q32:2']);

  // Without the field's word on what is played, the marked rows cannot be
  // sorted, so the old rule stands.
  const e = desk();
  e.load('Qualification 24', 2);
  e.nexus([row('Qualification 30', 'On field'), row('Qualification 31', 'On deck')]);
  assert.deepEqual(e.view(), ['Q31:0']);
});

test('a start the field takes back (a test match after a restart) is not a cycle', () => {
  const d = desk();
  const detach = attachPace(d.bus);
  try {
    const t = Date.now() - 30 * MIN;
    d.load('Qualification 1'); d.start(t); d.commit();
    d.load('Qualification 2'); d.start(t + 7 * MIN); d.commit();
    // The test match's clock arrives first, then the adapter learns a test
    // match is what is loaded and takes it back.
    d.bus.emit({ type: 'match.start', source: 'cheesy', ts: t + 9 * MIN });
    d.bus.emit({ type: 'match.unloaded', source: 'cheesy' });
    assert.equal(d.bus.state.pace.lastStartAt, t + 7 * MIN);
    assert.equal(d.bus.state.pace.cycleSec, 420);

    // A real match that ended is never taken back.
    d.load('Qualification 3'); d.start(t + 14 * MIN); d.bus.emit({ type: 'match.end', source: 'cheesy' });
    d.bus.emit({ type: 'match.unloaded', source: 'cheesy' });
    assert.equal(d.bus.state.pace.lastStartAt, t + 14 * MIN);
  } finally {
    detach();
  }
});
