/**
 * A desk that comes back in the middle of something: a match, a break, or
 * just after a break ended.
 *
 * Cheesy writes every notifier's current value to a socket the moment it
 * connects, in each endpoint's own HandleNotifiers order, and the desk opens
 * all of its sockets at once and takes each notifier from whichever delivers
 * it first. So after a restart the clock frame, the load and the break's
 * length can arrive in any order, and every test here tries the orders that
 * real endpoints produce: the field monitor sends matchTime ahead of
 * matchLoad, the arena API sends matchTiming, matchLoad, matchTime.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MatchState } from './protocol.ts';
import { CheesyAdapter } from './adapter.ts';
import { EventBus } from '../../bus.ts';
import { LatchedRestore } from '../../latched.ts';
import type { DeskEvent } from '../../types.ts';

const API = '/api/arena/websocket';
const MONITOR = '/displays/field_monitor/websocket';
const AUDIENCE = '/displays/audience/websocket';

const Q43 = {
  Match: {
    Id: 43, Type: 2, TypeOrder: 43, LongName: 'Qualification 43', ShortName: 'Q43',
    Red1: 846, Red2: 1868, Red3: 253, Blue1: 100, Blue2: 115, Blue3: 670,
  },
};

function desk(bus = new EventBus()) {
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  return { bus, seen, adapter, types: () => seen.map(e => e.type) };
}

// ---- mid-match ----------------------------------------------------------------

test('a desk restarted mid-match keeps the match running when its load lands behind the clock', () => {
  /*
   * The field monitor's opening burst is realtimeScore, matchTime, matchLoad.
   * The clock frame was announced as a late join, back-dated to the field's
   * time, and then the load wiped it: match.loaded clears the start and puts
   * program on the overview, and nothing started the match again. The hall
   * watched the alliance overview over a match in progress, with a dead
   * clock, until the buzzer.
   */
  for (const order of ['clock first', 'load first']) {
    const { bus, seen, adapter, types } = desk();
    const score = (teleopFuel: number) => adapter.ingest('realtimeScore', {
      MatchState: MatchState.TeleopPeriod,
      Red: { ScoreSummary: { AutoFuelPoints: 10, TeleopFuelPoints: teleopFuel } },
      Blue: { ScoreSummary: {} },
    }, MONITOR);
    const clock = () => adapter.ingest('matchTime',
      { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 60 }, MONITOR);
    if (order === 'clock first') {
      score(40);
      clock();
      adapter.ingest('matchLoad', Q43, API);
    } else {
      adapter.ingest('matchLoad', Q43, API);
      score(40);
      clock();
    }

    assert.equal(bus.state.match?.displayName, 'Qualification 43', order);
    assert.ok(bus.state.matchStartedAt !== null, `${order}: the clock is running`);
    const age = Date.now() - (bus.state.matchStartedAt ?? 0);
    assert.ok(age >= 59_000 && age <= 63_000,
      `${order}: and it is the field's 60 s, not a fresh start (got ${Math.round(age / 1000)} s)`);
    assert.equal(bus.state.lastMatchStartedAt, bus.state.matchStartedAt,
      `${order}: the clip cutter's start is the same back-dated one`);
    assert.equal(bus.state.screen, 'match', `${order}: the score bar, not the overview`);

    // One more point is one more point: the ledger the start was diffed
    // against is the match's own, so the next frame is not a second burst.
    const from = seen.length;
    score(41);
    const deltas = seen.slice(from).filter(e => e.type === 'score.delta').map(e => e.payload);
    assert.deepEqual(deltas, [{ alliance: 'red', field: 'fuel', amount: 1 }], order);
    assert.equal(bus.state.score.red.total, 51, order);

    // And the match plays out to one end, as the arena sends it.
    adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 162 }, MONITOR);
    adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 0 }, MONITOR);
    assert.equal(types().filter(t => t === 'match.end').length, 1, order);
    assert.equal(types().includes('match.aborted'), false, order);
    adapter.stop();
  }
});

test('a load between matches still starts the next match from nothing', () => {
  // The resume is only for a load heard while the field is running. The
  // ordinary load, between matches, must not inherit the last match's start.
  const { bus, adapter, types } = desk();
  adapter.ingest('matchLoad', { ...Q43, Match: { ...Q43.Match, Id: 42, TypeOrder: 42, LongName: 'Qualification 42' } });
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 162 });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 0 });
  // The commit, then the arena's display moving on lets Q43 in.
  adapter.ingest('scorePosted', {
    Match: { Id: 42, Type: 2 }, RedScoreSummary: { Score: 90 }, BlueScoreSummary: { Score: 80 },
  });
  adapter.ingest('audienceDisplayMode', 'score');
  adapter.ingest('matchLoad', Q43);
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  adapter.ingest('audienceDisplayMode', 'intro');
  assert.equal(bus.state.match?.displayName, 'Qualification 43');
  assert.equal(bus.state.matchStartedAt, null, 'Q43 has not started');
  assert.equal(types().filter(t => t === 'match.start').length, 1, 'only Q42 started');
  adapter.stop();
});

test('a clock that went quiet mid-match does not hand that match\'s start to the next one', () => {
  /*
   * The socket carrying the clock goes quiet in the middle of Q42: half-open,
   * which the watchdog takes 45 s to notice, or the end and reset frames
   * lost from a full channel. The score and the next load still arrive on
   * the others. The desk read Q42 as running when Q43 was let in, and gave
   * Q43 Q42's start: its own ticker ran Q43's clock out and buzzed it before
   * it had started, and Q43's real start was then swallowed as a repeat.
   */
  const Q42 = { Match: { ...Q43.Match, Id: 42, TypeOrder: 42, LongName: 'Qualification 42', ShortName: 'Q42' } };
  // Q43's first word from the clock once it is heard again: its own start,
  // or a reconnect's replay of where it already is, which reads the very
  // state the stale clock was stuck on.
  const resumed = {
    'its start': { MatchState: MatchState.AutoPeriod, MatchTimeSec: 0 },
    'a reconnect mid-teleop': { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 80 },
  };
  for (const [name, frame] of Object.entries(resumed)) {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const { bus, adapter, types } = desk();
      adapter.ingest('matchLoad', Q42, API);
      adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 }, MONITOR);
      adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 0 }, MONITOR);
      adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 }, MONITOR);
      adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 60 }, MONITOR);
      adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 161 }, MONITOR);
      // Nothing more on the clock, its buzzer and reset frames lost. Q42 is
      // committed, the arena loads Q43 behind its result, and its display
      // moves on.
      mock.timers.tick(120_000);
      adapter.ingest('scorePosted', {
        Match: { Id: 42, Type: 2 }, RedScoreSummary: { Score: 90 }, BlueScoreSummary: { Score: 80 },
      }, AUDIENCE);
      adapter.ingest('audienceDisplayMode', 'score', AUDIENCE);
      adapter.ingest('matchLoad', Q43, API);
      mock.timers.tick(20_000);
      adapter.ingest('audienceDisplayMode', 'intro', AUDIENCE);

      assert.equal(bus.state.match?.displayName, 'Qualification 43', name);
      assert.equal(bus.state.matchStartedAt, null, `${name}: Q43 has not started`);
      assert.equal(types().filter(t => t === 'match.start').length, 1, `${name}: only Q42 started`);
      // So the desk's own clock has nothing to run out.
      bus.advance();
      mock.timers.tick(170_000);
      bus.advance();
      assert.equal(bus.state.matchEndedAt, null, `${name}: Q43 is not buzzed before it starts`);

      // And when the clock is heard again, Q43 is started from it.
      adapter.ingest('matchTime', frame, MONITOR);
      assert.equal(types().filter(t => t === 'match.start').length, 2, `${name}: Q43 starts`);
      const age = Math.round((Date.now() - (bus.state.matchStartedAt ?? 0)) / 1000);
      assert.equal(age, frame.MatchTimeSec, `${name}: on the field's own time`);

      // And how far Q42's clock got is not Q43's: Q43 stopped at once is an
      // abort, not a match that ran to 161 s.
      if (frame.MatchTimeSec === 0) {
        mock.timers.tick(600);
        adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 0 }, MONITOR);
        assert.equal(types().includes('match.aborted'), true,
          `${name}: Q43 stopped inside its first second`);
        assert.equal(types().filter(t => t === 'match.end').length, 0, `${name}: nothing ran to a buzzer`);
      }
      adapter.stop();
    } finally {
      mock.timers.reset();
    }
  }
});

// ---- mid-break ----------------------------------------------------------------

const LUNCH_LOAD = {
  Match: { Id: 0, Type: 0, ShortName: 'T', LongName: 'Test Match' },
  BreakDescription: 'Lunch', BreakNextMatchName: 'Qualification 41',
};

/** Today's log holds `ev`; the desk boots and puts back what it finds. */
function bootWith(ev: Pick<DeskEvent, 'ts' | 'source' | 'type' | 'payload'>, now: number): EventBus {
  const bus = new EventBus();
  const latched = new LatchedRestore(now);
  latched.observe({ id: 'logged', seq: 1, matchClock: null, confidence: 'authoritative', ...ev });
  latched.apply(bus, now);
  return bus;
}

test('a desk that comes back mid-break counts down what is left of it, in any order', () => {
  /*
   * Thirty minutes into a forty-five minute lunch. The log puts the card
   * back with its own end time; then the field's reconnect burst announced
   * the timeout again with its FULL length, stamped from now, and every
   * screen said lunch was back half an hour after the field's own countdown
   * ended it. In the other orders the card lost its time, or its name.
   */
  const now = Date.now();
  const began = now - 30 * 60_000;
  const length = 45 * 60;
  const ends = began + length * 1000;
  /*
   * Every socket says the break's length first, and the field monitor then
   * sends its clock ahead of its load, so 'timing clock load' is the order a
   * real arena most often produces. The card the desk came back with is the
   * right one, and it stays up, untouched, until the field has said all of
   * it: then it is said once. It used to be repainted as a bare "Field
   * timeout" first, and the day's log gained a break with no name.
   */
  for (const order of ['timing load clock', 'timing clock load', 'load clock timing', 'clock timing load']) {
    const bus = bootWith({
      ts: began, source: 'cheesy', type: 'break.started',
      payload: { kind: 'timeout', label: 'Lunch', nextMatch: 'Qualification 41', seconds: length },
    }, now);
    assert.equal(bus.state.status?.backAt, ends, 'fixture sanity: the card is back with its own time');

    const { adapter, seen } = desk(bus);
    const step: Record<string, () => void> = {
      timing: () => adapter.ingest('matchTiming', { TimeoutDurationSec: length }, API),
      load: () => adapter.ingest('matchLoad', LUNCH_LOAD, API),
      clock: () => adapter.ingest('matchTime',
        { MatchState: MatchState.TimeoutActive, MatchTimeSec: 30 * 60 }, MONITOR),
    };
    for (const name of order.split(' ')) {
      step[name]!();
      assert.equal(bus.state.status?.message, 'Lunch', `${order}: still Lunch after the ${name}`);
    }

    const card = bus.state.status;
    const off = Math.round(((card?.backAt ?? 0) - ends) / 1000);
    assert.ok(Math.abs(off) <= 2, `${order}: back at the field's own end (${off} s off)`);
    const said = seen.filter(e => e.type === 'break.started').map(e => e.payload as
      { label?: string; seconds?: number; nextMatch?: string });
    assert.equal(said.length, 1, `${order}: said once`);
    assert.equal(said[0]?.label, 'Lunch', `${order}: and by name`);
    assert.ok(Math.abs((said[0]?.seconds ?? 0) - 15 * 60) <= 1, `${order}: the time LEFT is what is sent`);
    assert.equal(said[0]?.nextMatch, 'Qualification 41', order);
    adapter.stop();
  }
});

test('a break held back for its words on a restart is said on the next tick if they never come', () => {
  // An arena build that never sends matchTiming. The card the desk came back
  // with stays through the opening burst; the field's next tick of the break
  // is the end of waiting, and the break is said with what has been heard.
  const now = Date.now();
  const bus = bootWith({
    ts: now - 30 * 60_000, source: 'cheesy', type: 'break.started',
    payload: { kind: 'timeout', label: 'Lunch', seconds: 45 * 60 },
  }, now);
  const { adapter, seen } = desk(bus);
  const said = () => seen.filter(e => e.type === 'break.started');
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 1800 }, MONITOR);
  adapter.ingest('matchLoad', { ...LUNCH_LOAD, BreakDescription: 'Lunch: back at 12:45' }, MONITOR);
  assert.equal(said().length, 0, 'still waiting on the length');
  assert.equal(bus.state.status?.message, 'Lunch');
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 1801 }, MONITOR);
  assert.equal(said().length, 1, 'the next tick says it');
  assert.equal(bus.state.status?.message, 'Lunch: back at 12:45');
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 1802 }, MONITOR);
  assert.equal(said().length, 1, 'and only once');

  // A desk with no card to keep says the break at once, as it always did.
  const { bus: bare, adapter: second, seen: seen2 } = desk();
  second.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 1800 }, MONITOR);
  assert.equal(seen2.filter(e => e.type === 'break.started').length, 1);
  assert.equal(bare.state.status?.message, 'Field timeout');
  adapter.stop();
  second.stop();
});

test('a break that starts live is its full length, and is said again only when it changes', () => {
  const { bus, adapter } = desk();
  const breaks = () => bus.recent.filter(e => e.type === 'break.started')
    .map(e => e.payload as { label?: string; seconds?: number });
  adapter.ingest('matchTiming', { TimeoutDurationSec: 900 });
  adapter.ingest('matchLoad', { ...Q43, BreakDescription: 'Awards Break' });
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 0 });
  assert.deepEqual(breaks().map(b => b.seconds), [900], 'the frame that starts it says 0 s gone');

  // A reconnect sends the same again, mid-break: nothing new to say.
  adapter.ingest('matchTiming', { TimeoutDurationSec: 900 });
  adapter.ingest('matchLoad', { ...Q43, BreakDescription: 'Awards Break' });
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 120 });
  assert.equal(breaks().length, 1, 'a replay of the same break is not a new one');

  // The scorekeeper retitles it (SetTimeoutDisplay fires matchLoad). Said
  // again, on the break's own clock, not as a fresh fifteen minutes.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 300_000 });
  try {
    adapter.ingest('matchLoad', { ...Q43, BreakDescription: 'Awards: Engineering Inspiration' });
  } finally {
    mock.timers.reset();
  }
  assert.equal(breaks().length, 2);
  assert.equal(breaks()[1]?.label, 'Awards: Engineering Inspiration');
  assert.ok(Math.abs((breaks()[1]?.seconds ?? 0) - 600) <= 1,
    `the time left, ten minutes (got ${breaks()[1]?.seconds} s)`);
  adapter.stop();
});

// ---- after a break ------------------------------------------------------------

test('a desk that comes back after the break ended takes the restored card down', () => {
  /*
   * The log puts the last break card back, and only a prestart or a start
   * retires an automatic one. A field already back in PreMatch sends no
   * transition to a desk whose state starts at PreMatch, so the card kept
   * promising a return time for a break that was over, until the next match
   * started.
   */
  const now = Date.now();
  const lunch = {
    ts: now - 50 * 60_000, source: 'cheesy' as const, type: 'break.started' as const,
    payload: { kind: 'timeout', label: 'Lunch', seconds: 45 * 60 },
  };
  for (const first of [MatchState.PreMatch, MatchState.PostMatch]) {
    const bus = bootWith(lunch, now);
    assert.equal(bus.state.status?.message, 'Lunch', 'fixture sanity: the card came back');
    const { adapter } = desk(bus);
    adapter.ingest('matchTime', { MatchState: first, MatchTimeSec: 0 });
    assert.equal(bus.state.status, null, `first frame ${first}: the break is over`);
    adapter.stop();
  }

  // Still in the break's last moments: PostTimeout keeps it, as it does live.
  const late = bootWith(lunch, now);
  const { adapter } = desk(late);
  adapter.ingest('matchTime', { MatchState: MatchState.PostTimeout, MatchTimeSec: 2700 });
  assert.equal(late.state.status?.message, 'Lunch', 'not over until the field says PreMatch');
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  assert.equal(late.state.status, null);
  adapter.stop();

  // An operator's own card is theirs to take down, whatever the field says.
  const mine = bootWith({
    ts: now - 10 * 60_000, source: 'manual', type: 'status.show',
    payload: { kind: 'delay', message: 'Field repair, back soon' },
  }, now);
  const second = desk(mine);
  second.adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  assert.equal(mine.state.status?.message, 'Field repair, back soon');
  second.adapter.stop();
});
