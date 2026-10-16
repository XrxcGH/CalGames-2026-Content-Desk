/**
 * The commit, as a real Cheesy Arena sends it.
 *
 * web/match_play.go commitPostAndLoadNextMatch commits the score (scorePosted),
 * sets the arena's audience display to "score", resets the field and loads the
 * NEXT match (matchLoad, then an all-zero realtimeScore), all in one handler.
 * The arena's own audience screen keeps the score up from its own saved copy;
 * the desk keeps it by holding that next load back until the arena moves on.
 *
 * Every test here drives the adapter with that order. The desk's earlier model
 * (the field sitting in PreMatch with the finished match still loaded) is what
 * the fake arena used to do and no real field ever does.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MatchState } from './protocol.ts';
import { CheesyAdapter, POSTED_HOLD_MS, POST_RACE_MS } from './adapter.ts';
import { startFakeArena } from './fake-arena.ts';
import { EventBus } from '../../bus.ts';
import type { DeskEvent } from '../../types.ts';

const load = (id: number, extra: Record<string, unknown> = {}) => ({
  Match: {
    Id: id, Type: 2, TypeOrder: id, LongName: `Qualification ${id}`, ShortName: `Q${id}`,
    Red1: 846, Red2: 9999, Red3: 253, Blue1: 100, Blue2: 115, Blue3: 670,
  },
  ...extra,
});

const bonus = (on: boolean) => ({
  EnergizedBonusRankingPoint: on, SuperchargedBonusRankingPoint: false, TraversalBonusRankingPoint: false,
});

/** What LoadMatch sends right behind the matchLoad: nothing on the board. */
const zeroFrame = {
  MatchState: MatchState.PreMatch,
  Red: { ScoreSummary: { AutoFuelPoints: 0, TeleopFuelPoints: 0, TeleopTowerPoints: 0, ...bonus(false) } },
  Blue: { ScoreSummary: { AutoFuelPoints: 0, TeleopFuelPoints: 0, TeleopTowerPoints: 0, ...bonus(false) } },
};

const posted42 = {
  Match: { Id: 42, Type: 2, TypeOrder: 42, LongName: 'Qualification 42', ShortName: 'Q42' },
  RedScoreSummary: { Score: 130, ...bonus(true) },
  BlueScoreSummary: { Score: 100, ...bonus(false) },
  RedWon: true, BlueWon: false,
};

/**
 * Q42 loaded, played to the buzzer, and waiting on the referees. The arena's
 * post-buzzer "blank" arrives at once unless `blank` is false (the audience
 * socket running behind).
 */
function played42(opts: { blank?: boolean } = {}) {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', load(42));
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 23 });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { TeleopFuelPoints: 100, TeleopTowerPoints: 30, ...bonus(true) } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 100, ...bonus(false) } },
  });
  // The last of the arena's once-a-second ticks, then the buzzer, whose frame
  // says 0: MatchTimeSec() is zero in PostMatch.
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 162 });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 0 });
  // matchEndScoreDwellSec after the buzzer the arena blanks its own screen.
  if (opts.blank !== false) adapter.ingest('audienceDisplayMode', 'blank');
  const types = () => seen.map(e => e.type);
  const loads = () => seen.filter(e => e.type === 'match.loaded')
    .map(e => (e.payload as { displayName?: string }).displayName);
  return { bus, seen, adapter, types, loads };
}

/** commitAndPost, frame for frame, in the order one socket carries it. */
function commit(adapter: CheesyAdapter, next: unknown = load(43)): void {
  adapter.ingest('scorePosted', posted42);
  adapter.ingest('audienceDisplayMode', 'score');
  adapter.ingest('matchLoad', next);
  adapter.ingest('realtimeScore', zeroFrame);
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
}

const finalIsUp = (bus: EventBus, why: string): void => {
  assert.equal(bus.state.screen, 'score', `${why}: the Final screen is up`);
  assert.equal(bus.state.match?.displayName, 'Qualification 42', `${why}: for the match just played`);
  assert.ok(bus.state.scorePostedAt !== null, `${why}: with its reveal time kept`);
  assert.equal(bus.state.score.red.total, 130, `${why}: the posted total`);
  assert.equal(bus.state.score.red.teleopFuel, 100, `${why}: and the breakdown under it`);
  assert.equal(bus.state.score.red.rp.energized, true, `${why}: and the badge the field awarded`);
  assert.equal(bus.state.officialWinner, 'red', `${why}: and the verdict`);
};

test('the posted score stays up while the arena loads the next match in the same breath', () => {
  const { bus, adapter, loads, types } = played42();
  commit(adapter);
  finalIsUp(bus, 'right after the commit');
  assert.deepEqual(loads(), ['Qualification 42'], 'the next match is held, not loaded over the result');
  assert.equal(types().filter(t => t === 'match.score_posted').length, 1);
  adapter.stop();
});

test('the arena\'s audience display moving off the score releases the next match', () => {
  // AutomateAudienceDisplay: 'intro' after 20 s, 'bracket' after a non-final
  // playoff, 'timeout' into a scheduled break, 'logoLuma' at the end. Or the
  // scorekeeper picks anything by hand. Whatever it is, the arena has moved on.
  for (const mode of ['intro', 'bracket', 'timeout', 'blank', 'match', 'logoLuma']) {
    const { bus, adapter, loads } = played42();
    commit(adapter);
    adapter.ingest('audienceDisplayMode', 'score');   // a reconnect replaying it
    finalIsUp(bus, `${mode}: before`);
    adapter.ingest('audienceDisplayMode', mode);
    assert.deepEqual(loads(), ['Qualification 42', 'Qualification 43'], mode);
    assert.equal(bus.state.screen, 'overview', mode);
    assert.equal(bus.state.scorePostedAt, null, `${mode}: Q43 has not been played`);
    assert.equal(bus.state.score.red.total, 0, mode);
    adapter.stop();
  }
});

test('a start flushes the held load first, so the start is the next match\'s', () => {
  for (const via of ['matchTime', 'realtimeScore', 'arenaStatus']) {
    const { bus, adapter, types } = played42();
    commit(adapter);
    if (via === 'matchTime') {
      adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
    } else if (via === 'realtimeScore') {
      // The score socket can beat the clock socket to the start.
      adapter.ingest('realtimeScore', {
        MatchState: MatchState.AutoPeriod,
        Red: { ScoreSummary: { AutoFuelPoints: 3 } }, Blue: { ScoreSummary: {} },
      });
      adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
    } else {
      adapter.ingest('arenaStatus', { MatchId: 43, MatchState: MatchState.AutoPeriod });
      adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 });
    }
    // Only what happened after the result: Q42 had its own load and start.
    const t = types().slice(types().indexOf('match.score_posted'));
    const loaded = t.indexOf('match.loaded');
    const started = t.indexOf('match.start');
    assert.ok(loaded > 0 && started > loaded,
      `${via}: Q43 is loaded before it starts (${t.join(' ')})`);
    assert.equal(t.filter(x => x === 'match.start').length, 1, `${via}: one start, not lost`);
    assert.equal(bus.state.match?.displayName, 'Qualification 43', via);
    assert.ok(bus.state.matchStartedAt !== null, `${via}: the clock runs`);
    if (via === 'realtimeScore') {
      assert.equal(bus.state.score.red.autoFuel, 3, 'the frame that carried the start lands on Q43');
    }
    adapter.stop();
  }
});

test('only the newest load is kept, and a re-sent one keeps the hold', () => {
  const { bus, adapter, loads } = played42();
  commit(adapter);
  // A scheduled break 5 s later re-sends the same load with its description,
  // as do a Nexus substitution and a reconnect. Not a reason to drop the
  // result: the arena is still showing it.
  adapter.ingest('matchLoad', load(43, { BreakDescription: 'Lunch', BreakNextMatchName: 'Qualification 43' }));
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive, MatchTimeSec: 0 });
  finalIsUp(bus, 'through the break re-send');
  assert.deepEqual(loads(), ['Qualification 42']);
  const brk = bus.recent.filter(e => e.type === 'break.started').at(-1)?.payload as { label?: string };
  assert.equal(brk?.label, 'Lunch', 'the break text was read off the held load');

  // The scorekeeper loading a different match by hand (Q44 ahead of the
  // auto-loaded Q43) is ResetMatch and LoadMatch, neither of which moves the
  // arena's audience display: the hall is still looking at Q42's result.
  // Only the newest load is worth loading, and only when the arena moves on.
  adapter.ingest('matchLoad', load(44));
  finalIsUp(bus, 'through a reorder');
  assert.deepEqual(loads(), ['Qualification 42'], 'Q44 waits behind the result too');
  adapter.ingest('audienceDisplayMode', 'intro');
  assert.deepEqual(loads(), ['Qualification 42', 'Qualification 44'], 'and Q43 is never loaded');
  assert.equal(bus.state.match?.displayName, 'Qualification 44');
  adapter.stop();
});

test('a reorder late in the hold does not restart the fallback', () => {
  // The fallback is counted from the post, not from the newest load: a
  // scorekeeper reordering 59 s in must not keep the result up for two minutes.
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const { bus, adapter, loads } = played42();
    commit(adapter);
    mock.timers.tick(POSTED_HOLD_MS - 1);
    adapter.ingest('matchLoad', load(44));
    finalIsUp(bus, 'after the reorder');
    mock.timers.tick(1);
    assert.deepEqual(loads(), ['Qualification 42', 'Qualification 44']);
    adapter.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a re-run of the match just committed is loaded at once, even if the reset tick was lost', () => {
  /*
   * The field faults in the last seconds and the head referee has the match
   * replayed. The arena's commit has already loaded Q43 behind the result, so
   * the scorekeeper loads Q42 again, and a committed match always loads with
   * IsReplay. The first result is void: Q42 is the match now.
   *
   * ResetMatch moves the field to PreMatch silently, and the arena's loop
   * sends ONE matchTime for it. A listener channel that is full drops it, and
   * the commit is exactly when this process is busy starting a clip. Without
   * that frame the desk's field state still reads PostMatch, which is what
   * the mid-match reconnect guard keys on, so the re-run's load was taken for
   * an echo and swallowed. Its start then released the held Q43, and the
   * re-run was filed against Q43, its result dropped as stale.
   *
   * And on an arena build that posts without loading the next match, the
   * re-run was itself held behind the result it voids, as if it were the
   * next match: the robots linking for it could not arm it.
   */
  for (const tick of ['lost', 'received', 'no next load']) {
    const { bus, adapter, seen } = played42();
    adapter.ingest('scorePosted', posted42);
    adapter.ingest('audienceDisplayMode', 'score');
    if (tick !== 'no next load') {
      adapter.ingest('matchLoad', load(43));
      adapter.ingest('realtimeScore', zeroFrame);
    }
    if (tick !== 'lost') {
      adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
    }
    const from = seen.length;
    adapter.ingest('matchLoad', load(42, { IsReplay: true }));
    assert.equal(bus.state.matchRun, 2, `${tick}: the re-run is the match on screen at once`);
    assert.equal(bus.state.scorePostedAt, null, `${tick}: and the void result is off it`);
    adapter.ingest('arenaStatus', {
      MatchId: 42, MatchState: MatchState.PreMatch,
      AllianceStations: { R1: { Team: { Id: 846 }, DsConn: { RobotLinked: true } } },
    });
    adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
    adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 });
    adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 160 });
    adapter.ingest('scorePosted', {
      ...posted42,
      RedScoreSummary: { Score: 55 }, BlueScoreSummary: { Score: 60 }, RedWon: false, BlueWon: true,
    });

    const after = seen.slice(from);
    const order = after.map(e => e.type).join(' ');
    const loaded = after.filter(e => e.type === 'match.loaded')
      .map(e => e.payload as { displayName?: string; run?: number })
      .map(p => [p.displayName, p.run]);
    assert.deepEqual(loaded, [['Qualification 42', 2]],
      `${tick}: the re-run is loaded, and the held Q43 is not (${order})`);
    assert.ok(after.findIndex(e => e.type === 'match.loaded')
      < after.findIndex(e => e.type === 'match.start'), `${tick}: loaded before it starts (${order})`);
    assert.equal(after.filter(e => e.type === 'match.armed').length, 1,
      `${tick}: and armed when its robots link (${order})`);
    assert.equal(after.filter(e => e.type === 'match.score_posted').length, 1,
      `${tick}: the re-run's result is accepted (${order})`);
    assert.equal(bus.state.match?.displayName, 'Qualification 42', tick);
    assert.equal(bus.state.matchRun, 2, tick);
    assert.equal(bus.state.screen, 'score', tick);
    assert.equal(bus.state.score.blue.total, 60, `${tick}: the re-run's result is on screen`);
    adapter.stop();
  }
});

test('with nothing else to release it, the held load lands after the fallback', () => {
  // The clock too: the fallback is counted from the post, by Date.now().
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const { bus, adapter, loads } = played42();
    commit(adapter);
    mock.timers.tick(POSTED_HOLD_MS - 1);
    finalIsUp(bus, 'a moment before the fallback');
    mock.timers.tick(1);
    assert.deepEqual(loads(), ['Qualification 42', 'Qualification 43']);
    assert.equal(bus.state.screen, 'overview');
    adapter.stop();
  } finally {
    mock.timers.reset();
  }
});

test('the next load can beat the posted score onto the desk, and the score still lands', () => {
  // matchLoad is usually taken from /api/arena/websocket and scorePosted only
  // ever comes on /displays/audience/websocket. Two sockets, no ordering: the
  // identity check used to drop Q42's result as a replay once Q43 was loaded.
  const { bus, adapter, loads, types } = played42();
  adapter.ingest('matchLoad', load(43));
  adapter.ingest('realtimeScore', zeroFrame);
  adapter.ingest('scorePosted', posted42);
  adapter.ingest('audienceDisplayMode', 'score');
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  assert.equal(types().filter(t => t === 'match.score_posted').length, 1, 'the result is not lost');
  finalIsUp(bus, 'load first');
  assert.deepEqual(loads(), ['Qualification 42']);
  adapter.ingest('audienceDisplayMode', 'intro');
  assert.deepEqual(loads(), ['Qualification 42', 'Qualification 43']);
  adapter.stop();
});

test('the audience socket running behind: its post-buzzer blank lands after the next load, and the result survives', () => {
  // The arena API socket delivers the commit's load and reset; the audience
  // socket, behind it, then delivers the "blank" the arena sent 3 s after the
  // buzzer, and only then the post. A blank must not release a load that is
  // waiting on a result not yet seen.
  const { bus, adapter, loads, types } = played42({ blank: false });
  adapter.ingest('matchLoad', load(43));
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  adapter.ingest('audienceDisplayMode', 'blank');
  adapter.ingest('scorePosted', posted42);
  adapter.ingest('audienceDisplayMode', 'score');
  assert.equal(types().filter(t => t === 'match.score_posted').length, 1, 'the result is not lost');
  finalIsUp(bus, 'after the late blank');
  assert.deepEqual(loads(), ['Qualification 42']);
  adapter.stop();
});

test('a post that arrives after the next load gets the full hold, not the short wait for a post', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    const { bus, adapter, loads } = played42();
    adapter.ingest('matchLoad', load(43));
    adapter.ingest('scorePosted', posted42);
    adapter.ingest('audienceDisplayMode', 'score');
    mock.timers.tick(POST_RACE_MS + 1);
    finalIsUp(bus, 'past the short wait');
    mock.timers.tick(POSTED_HOLD_MS - POST_RACE_MS - 2);
    finalIsUp(bus, 'a moment before the fallback');
    mock.timers.tick(1);
    assert.deepEqual(loads(), ['Qualification 42', 'Qualification 43']);
    adapter.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a load after an unposted end waits only a moment for a score that may not come', () => {
  // Discard results, then load another match by hand: nothing is coming.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { bus, adapter, loads } = played42();
    adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
    adapter.ingest('matchLoad', load(44));
    assert.deepEqual(loads(), ['Qualification 42'], 'held for the race window');
    mock.timers.tick(POST_RACE_MS);
    assert.deepEqual(loads(), ['Qualification 42', 'Qualification 44']);
    assert.equal(bus.state.match?.displayName, 'Qualification 44');
    // And a score for Q42 arriving now really is late: it is not revealed
    // over a match nobody has played.
    adapter.ingest('scorePosted', posted42);
    assert.equal(bus.state.scorePostedAt, null);
    adapter.stop();
  } finally {
    mock.timers.reset();
  }
});

test('no zero frame wipes the final, whichever socket it rides', () => {
  for (const order of ['frame after load', 'frame before load', 'frame twice']) {
    const { bus, adapter } = played42();
    adapter.ingest('scorePosted', posted42);
    adapter.ingest('audienceDisplayMode', 'score');
    if (order === 'frame before load') adapter.ingest('realtimeScore', zeroFrame);
    adapter.ingest('matchLoad', load(43));
    if (order !== 'frame before load') adapter.ingest('realtimeScore', zeroFrame);
    if (order === 'frame twice') adapter.ingest('realtimeScore', zeroFrame);
    adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
    finalIsUp(bus, order);
    adapter.stop();
  }
});

test('the finished match is not armed while the next one is held', () => {
  // Arming flips program to the score bar. Arming Q42 again would put the
  // finished match's bar over its own result.
  const { bus, adapter, types } = played42();
  commit(adapter);
  const linked = {
    MatchId: 43, MatchState: MatchState.PreMatch,
    AllianceStations: { R1: { Team: { Id: 846 }, DsConn: { RobotLinked: true } } },
  };
  adapter.ingest('arenaStatus', linked);
  assert.equal(types().includes('match.armed'), false);
  finalIsUp(bus, 'robots linked under the result');
  adapter.ingest('audienceDisplayMode', 'intro');
  adapter.ingest('arenaStatus', linked);
  assert.equal(types().filter(t => t === 'match.armed').length, 1, 'Q43 arms once it is loaded');
  adapter.stop();
});

test('a reconnect during the hold replays the arena without disturbing the result', () => {
  // Cheesy writes every notifier's current value to a socket that
  // (re)subscribes: the arena's CURRENT match (Q43), its last result (Q42),
  // its pre-match clock and score, and the display mode.
  const { bus, adapter, types, loads } = played42();
  commit(adapter);
  const postedAt = bus.state.scorePostedAt;
  adapter.ingest('audienceDisplayMode', 'score');
  adapter.ingest('matchLoad', load(43));
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
  adapter.ingest('realtimeScore', zeroFrame);
  adapter.ingest('scorePosted', posted42);
  assert.equal(types().filter(t => t === 'match.score_posted').length, 1, 'no second reveal');
  assert.equal(bus.state.scorePostedAt, postedAt, 'the reveal time the video cut keys off is kept');
  assert.deepEqual(loads(), ['Qualification 42']);
  finalIsUp(bus, 'after the reconnect');
  adapter.stop();
});

test('the end of quals: the test match after the last commit, nothing held, nothing replayed', () => {
  const { bus, adapter, types, loads } = played42();
  commit(adapter, { Match: { Id: 0, Type: 0, ShortName: 'T', LongName: 'Test Match' } });
  finalIsUp(bus, 'with the test match loaded');
  // 40 s later the arena goes to its logo for the awards.
  adapter.ingest('audienceDisplayMode', 'logoLuma');
  finalIsUp(bus, 'logo mode does not load the test match');
  // Alliance selection, and the audience socket blips.
  adapter.ingest('scorePosted', posted42);
  assert.equal(types().filter(t => t === 'match.score_posted').length, 1);

  // Sunday: the first playoff match is a real load, not a held one.
  adapter.ingest('matchLoad', {
    Match: { Id: 101, Type: 3, TypeOrder: 1, LongName: 'Match 1', Red1: 254, Blue1: 846 },
  });
  assert.deepEqual(loads(), ['Qualification 42', 'Match 1']);
  assert.equal(bus.state.screen, 'overview');
  adapter.stop();
});

test('a held load is dropped when the arena loads its test match instead', () => {
  // The FTA loading the test match to check a robot in the hold window.
  const { bus, adapter, loads } = played42();
  commit(adapter);
  adapter.ingest('matchLoad', { Match: { Id: 0, Type: 0, ShortName: 'T', LongName: 'Test Match' } });
  adapter.ingest('audienceDisplayMode', 'intro');
  assert.deepEqual(loads(), ['Qualification 42'], 'neither the test nor the stale Q43');
  // Q43 reloaded after the test is an ordinary load.
  adapter.ingest('matchLoad', load(43));
  assert.deepEqual(loads(), ['Qualification 42', 'Qualification 43']);
  assert.equal(bus.state.screen, 'overview');
  adapter.stop();
});

test('rehearsal: the fake arena commits and loads at once, like a real field', async () => {
  // Real sockets, the real client, the real adapter. Fast, so the whole match
  // cycle takes a few seconds.
  const speed = 60;
  // One ordered record of what the arena did and what the desk did, each
  // desk event with the state snapshotted as it landed. The assertions are
  // on ORDER, never on elapsed time: at this speed the arena's 20 s on the
  // score is a third of a second, and a busy machine running the rest of the
  // suite alongside can stall this process for longer than that.
  const events: {
    type: string; screen?: string; match?: string | undefined; teleopFuel?: number;
  }[] = [];
  const arena = startFakeArena({ port: 0, speed, log: line => events.push({ type: `arena: ${line}` }) });
  const port = await arena.ready;
  const bus = new EventBus();
  bus.subscribe(ev => events.push({
    type: ev.type, screen: bus.state.screen, match: bus.state.match?.displayName,
    teleopFuel: bus.state.score.red.teleopFuel,
  }));
  const adapter = new CheesyAdapter({ bus, host: `127.0.0.1:${port}`, displayId: 'rehearsal' });
  try {
    adapter.start();
    const waitFor = async (what: () => boolean, ms: number): Promise<void> => {
      const t0 = Date.now();
      while (!what()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${events.map(e => e.type).join(' ')}`);
        await new Promise(r => setTimeout(r, 20));
      }
    };
    await waitFor(() => events.some(e => e.type === 'match.score_posted'), 20_000);
    const posted = events.findIndex(e => e.type === 'match.score_posted');
    // A full match, read as one: the buzzer's frame says 0 s, as a real
    // arena's does, and the ticks before it say how far the match got.
    assert.ok(events.slice(0, posted).some(e => e.type === 'match.end'), 'the buzzer is a result');
    assert.equal(events.some(e => e.type === 'match.aborted'), false, 'not an abort');
    const post = events[posted]!;
    assert.equal(post.screen, 'score');
    assert.equal(post.match, 'Qualification 42', 'the result is the match that was played');
    assert.ok((post.teleopFuel ?? 0) > 0, 'the breakdown was not zeroed by the next load');

    await waitFor(() => events.filter(e => e.type === 'match.loaded').length >= 2, 20_000);
    const loaded = events.findIndex((e, i) => i > posted && e.type === 'match.loaded');
    const trace = events.map(e => e.type).join(' | ');
    assert.equal(events[loaded]!.match, 'Qualification 43');
    // The arena loaded Q43 in the commit, and the desk let it in only once
    // the arena's own automation moved its display off the score.
    const intro = events.findIndex(e => e.type === 'arena: audience display to intro');
    assert.ok(intro > -1 && intro < loaded,
      `Q43 is loaded after the arena leaves the score, not with the commit (${trace})`);
    assert.ok(events.slice(posted, loaded).every(e => e.type.startsWith('arena: ')
      || (e.screen === 'score' && e.match === 'Qualification 42')),
      `the result stayed up until then (${trace})`);
    assert.equal(events.filter(e => e.type === 'match.score_posted').length, 1);
  } finally {
    adapter.stop();
    arena.close();
  }
});
