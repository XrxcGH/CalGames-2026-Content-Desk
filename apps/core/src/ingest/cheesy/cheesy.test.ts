import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  CheesyClient, assertPathAllowed, assertSocketAllowed, ALLOWED_SOCKETS, DEFAULT_SOCKETS,
} from './client.ts';
import { fuelPoints, towerPoints, MatchState, MatchStatus, type MatchWithResult } from './protocol.ts';
import { CheesyAdapter, mapRankings, mapSelection, mapUpcoming } from './adapter.ts';
import { EventBus } from '../../bus.ts';
import type { DeskEvent } from '../../types.ts';

test('refuses sockets that can control the field', () => {
  // These have a read loop in Cheesy Arena and accept commands that abort a
  // match or corrupt scoring. They must be unreachable by construction.
  for (const path of [
    '/match_play/websocket',
    '/panels/scoring/red/websocket',
    '/panels/scoring/blue/websocket',
    '/panels/referee/websocket',
    '/alliance_selection/websocket',
    '/setup/settings/websocket',
  ]) {
    assert.throws(() => assertSocketAllowed(path), /Refusing to open/, path);
  }
});

test('permits only the listener sockets', () => {
  for (const path of ALLOWED_SOCKETS) {
    assert.doesNotThrow(() => assertSocketAllowed(path));
  }
});

test('refuses REST paths outside the read allowlist', () => {
  for (const path of ['/setup/db/clear/matches', '/setup/settings', '/match_play/match_load',
    '/reports/csv/rankings', '/api/../setup/settings']) {
    assert.throws(() => assertPathAllowed(path), /Refusing to request/, path);
  }
  for (const path of ['/api/rankings', '/api/alliances', '/api/matches/qualification',
    '/api/teams/846/avatar', '/api/bracket/svg']) {
    assert.doesNotThrow(() => assertPathAllowed(path), path);
  }
});

test('percent-encoded dot segments cannot sidestep the allowlist', () => {
  // fetch() decodes %2e%2e while parsing the URL, so a raw-string check and
  // the request on the wire saw two different paths. The check must see the
  // parsed path, and the parsed path is what must be requested.
  for (const path of [
    '/api/matches/%2e%2e/%2e%2e/setup/settings',
    '/api/matches/%2E%2E/settings',
    '/api/matches/..%2fsettings',
  ]) {
    assert.throws(() => assertPathAllowed(path), /Refusing to request/, path);
  }
  // The returned string is the one the client fetches: already normalized,
  // query preserved.
  assert.equal(assertPathAllowed('/api/rankings'), '/api/rankings');
  assert.equal(assertPathAllowed('/api/matches/playoff'), '/api/matches/playoff');
});

test('a failed GET lands in the audit log exactly once', async () => {
  // The audit log is shown to the FTA as "every request we have made, in
  // order". A non-ok response used to append two entries for one request.
  const server = createServer((_req, res) => { res.writeHead(500); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = new CheesyClient({ host: `127.0.0.1:${port}`, displayId: 'test', onEvent: () => {} });

  try {
    await assert.rejects(() => client.get('/api/rankings'));
    assert.equal(client.audit.length, 1, 'one request, one entry');
    assert.equal(client.audit[0]?.status, 500);
  } finally {
    // A failing assertion must not leave the port open and hang the runner.
    await new Promise(resolve => server.close(resolve));
  }

  // A request that never got a status still logs one entry, with the error.
  await assert.rejects(() => client.get('/api/rankings'));
  assert.equal(client.audit.length, 2);
  assert.equal(typeof client.audit[1]?.status, 'string');
});

test('fuel and tower points combine auto and teleop', () => {
  const s = { AutoFuelPoints: 12, TeleopFuelPoints: 130, AutoTowerPoints: 15, TeleopTowerPoints: 50 };
  assert.equal(fuelPoints(s), 142);
  assert.equal(towerPoints(s), 65);
  assert.equal(fuelPoints(undefined), 0);
  assert.equal(towerPoints({}), 0);
});

test('synthesizes score deltas from consecutive snapshots', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));

  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 10, FoulPoints: 0 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 4, FoulPoints: 0 } },
  });
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 16, TeleopTowerPoints: 30, FoulPoints: 0 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 4, FoulPoints: 0 } },
  });

  const deltas = seen.filter(e => e.type === 'score.delta')
    .map(e => e.payload as { alliance: string; field: string; amount: number });

  // First snapshot is the baseline from zero; second yields +6 fuel and +30 tower.
  assert.deepEqual(deltas, [
    { alliance: 'red', field: 'fuel', amount: 10 },
    { alliance: 'blue', field: 'fuel', amount: 4 },
    { alliance: 'red', field: 'fuel', amount: 6 },
    { alliance: 'red', field: 'tower', amount: 30 },
  ]);
});

test('never emits a negative delta on a score correction', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 40 } } });
  seen.length = 0;
  // A referee correction takes points away. That is not a highlight, and a
  // marker here would send the replay operator to nothing.
  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 25 } } });

  assert.equal(seen.filter(e => e.type === 'score.delta').length, 0);
});

test('foul points land on the conceding side of the ledger', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // Cheesy credits FoulPoints TO an alliance. Our reducer computes
  // total = fuel + tower + opponent.fouls, so red's 15 foul points must be
  // recorded as blue conceding them, or both totals come out wrong.
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 100, FoulPoints: 15 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 90, FoulPoints: 0 } },
  });

  assert.equal(bus.state.score.red.total, 115, 'red = 100 fuel + 15 conceded by blue');
  assert.equal(bus.state.score.blue.total, 90);
});

test('match start fires once, and only a real end counts', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });

  assert.equal(seen.filter(t => t === 'match.start').length, 1);
  assert.equal(seen.filter(t => t === 'match.end').length, 1);

  // Coming back from a timeout must not look like another match ending.
  seen.length = 0;
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive });
  adapter.ingest('matchTime', { MatchState: MatchState.PostTimeout });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });
  assert.equal(seen.filter(t => t === 'match.end').length, 0);
});

test('maps a loaded match into teams and a display name', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: { Id: 42, LongName: 'Qualification 42', Red1: 846, Red2: 1868, Red3: 253,
             Blue1: 100, Blue2: 115, Blue3: 670 },
    Teams: {
      R1: { Id: 846, Nickname: 'The Funky Monkeys' },
      R2: { Id: 1868, Nickname: 'Space Cookies' },
      R3: { Id: 253, Nickname: 'Boba Bots' },
      B1: { Id: 100, Nickname: 'The Wildhats' },
      B2: { Id: 115, Nickname: 'MVRT' },
      B3: { Id: 670, Nickname: 'Homestead Robotics' },
    },
  });

  assert.equal(bus.state.match?.displayName, 'Qualification 42');
  assert.deepEqual(bus.state.match?.red.map(t => t.number), [846, 1868, 253]);
  assert.equal(bus.state.match?.blue[2]?.name, 'Homestead Robotics');
});

test('a reconnect replay of the same load mid-match does not reset the match', () => {
  const bus = new EventBus();
  const types: string[] = [];
  bus.subscribe(ev => types.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const load = { Match: { Id: 42, LongName: 'Qualification 42', Red1: 846, Blue1: 100 } };
  adapter.ingest('matchLoad', load);
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoFuelPoints: 5 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 2 } },
  });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });

  const started = bus.state.matchStartedAt;
  assert.notEqual(started, null);
  types.length = 0;

  // The websocket drops and comes back mid-match. Cheesy replays its current
  // snapshot to the fresh subscription: the same matchLoad, then matchTime.
  adapter.ingest('matchLoad', load);
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });

  assert.equal(types.filter(t => t === 'match.loaded').length, 0, 'not a fresh load');
  assert.equal(bus.state.matchStartedAt, started, 'clock still anchored');
  assert.equal(bus.state.screen, 'match', 'score bar stays up');

  // The replayed score snapshot diffs against the kept totals, not zero, so
  // no bogus burst markers land on the replay timeline.
  types.length = 0;
  const deltas: unknown[] = [];
  const stop = bus.subscribe(ev => { if (ev.type === 'score.delta') deltas.push(ev.payload); });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { AutoFuelPoints: 5, TeleopFuelPoints: 3 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 2 } },
  });
  stop();
  assert.deepEqual(deltas, [{ alliance: 'red', field: 'fuel', amount: 3 }]);

  // The same match loaded again with the field idle IS a fresh start (a
  // scorekeeper replay), and must reset.
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch });
  types.length = 0;
  adapter.ingest('matchLoad', load);
  assert.equal(types.filter(t => t === 'match.loaded').length, 1);
  assert.equal(bus.state.score.red.total, 0);
});

test('a card is announced once, not once per score frame', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  const frame = (fuel: number) => ({
    Red: { ScoreSummary: { TeleopFuelPoints: fuel } },
    Blue: { ScoreSummary: {} },
    RedCards: { '846': 'yellow' },
  });
  // The card map rides along on EVERY realtime frame for the rest of the
  // match; each frame must not become another Card marker for replay.
  adapter.ingest('realtimeScore', frame(1));
  adapter.ingest('realtimeScore', frame(2));
  adapter.ingest('realtimeScore', frame(3));

  const cards = () => seen.filter(e => e.type === 'card.issued');
  assert.equal(cards().length, 1);
  assert.deepEqual(cards()[0]?.payload,
    { alliance: 'red', team: 846, card: 'yellow', match: 'Qualification 1' });

  // An upgrade to red is a new fact and is announced again.
  adapter.ingest('realtimeScore', { ...frame(4), RedCards: { '846': 'red' } });
  assert.equal(cards().length, 2);

  // The next match starts clean.
  adapter.ingest('matchLoad', { Match: { Id: 2, LongName: 'Qualification 2' } });
  adapter.ingest('realtimeScore', frame(0));
  assert.equal(cards().length, 3);
});

test('teleop start after the pause emits the clock re-anchor event', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.PausePeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });

  // The field's pause has no fixed length, so the desk clock needs the real
  // teleop start to re-anchor on. Its own event type, not a shift_change:
  // the reducer's match.teleop_start case is what re-anchors, and the ticker
  // owns the shift1..4 stream.
  const anchors = seen.filter(e => e.type === 'match.teleop_start');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]?.source, 'cheesy');
  assert.equal(seen.filter(e => e.type === 'match.shift_change').length, 0,
    'the transition must not leak into the shift stream the surfaces render');
});

test('the field decides the auto winner, on fuel alone', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  // Red climbs for 15 auto points but scores no fuel. Cheesy decides auto on
  // AUTO FUEL COUNT, so this is a tied auto despite red leading on points.
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 15, AutoFuelPoints: 0 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 0 } },
  });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 15, AutoFuelPoints: 0 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 0 } },
  });

  // Null, not "red". On a tie Cheesy flips a coin, so there is nothing to
  // derive, and `autoWinnerKnown` stops the local heuristic overwriting it.
  assert.equal(bus.state.autoWinner, null);
  assert.equal(bus.state.autoWinnerKnown, true);
});

test('auto fuel, not points, picks the winner', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 30, AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 9 } },
  });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 30, AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 9 } },
  });

  // Red leads on auto points 34-9 and still loses auto.
  assert.equal(bus.state.autoWinner, 'blue');
});

test('auto fuel that lands on the pause frame still decides the winner', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 3 } },
  });
  // A ball counted after Cheesy's own period transition arrives stamped
  // PausePeriod. Deciding from the cached auto-period values alone called
  // this one for red.
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.PausePeriod,
    Red: { ScoreSummary: { AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 6 } },
  });

  assert.equal(bus.state.autoWinner, 'blue');
  assert.equal(bus.state.autoWinnerKnown, true);
});

test('hub state from the field beats inference', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ActiveRemainingSec: 12, ScoreSummary: {} },
    Blue: { ActiveRemainingSec: 0, ScoreSummary: {} },
  });
  assert.equal(bus.state.hubAuthoritative, 'red');
  assert.equal(bus.state.hubActive, 'red');

  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ActiveRemainingSec: 0, ScoreSummary: {} },
    Blue: { ActiveRemainingSec: 20, ScoreSummary: {} },
  });
  assert.equal(bus.state.hubActive, 'blue');

  // Between matches there is no live hub, so we fall back to inference.
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.PostMatch,
    Red: { ScoreSummary: {} }, Blue: { ScoreSummary: {} },
  });
  assert.equal(bus.state.hubAuthoritative, null);
});

test('rankings map from the REST shape', () => {
  // Field names transcribed from game/ranking_fields.go and web/api.go.
  const out = mapRankings({
    HighestPlayedMatch: 'Q42',
    Rankings: [
      { Rank: 1, PreviousRank: 3, TeamId: 846, Nickname: 'The Funky Monkeys',
        RankingPoints: 34, Wins: 8, Losses: 2, Ties: 1, Played: 11 },
      { Rank: 2, TeamId: 1868, Nickname: 'Space Cookies', RankingPoints: 31 },
    ],
  });

  assert.equal(out.highestPlayedMatch, 'Q42');
  assert.deepEqual(out.rankings[0], {
    rank: 1, previousRank: 3, team: 846, name: 'The Funky Monkeys',
    // The average is what Cheesy orders on: Rankings.Less cross-multiplies
    // RankingPoints by the other team's Played. Printing the raw total put a
    // rank-4 team above a rank-3 team on the number beside its own rank.
    rankingPoints: 34, avgRp: 3.1, record: '8-2-1', played: 11,
  });
  // Missing fields degrade rather than crash a pit TV.
  assert.equal(out.rankings[1]?.record, '0-0-0');
});

// The schedule route is FLAT: web/api.go embeds model.Match anonymously in
// MatchWithResult, and Go promotes an embedded struct's fields, so a row has
// no "Match" key. Every fixture here is shaped the way the wire is, because
// the last set was not, and a queue that returned eight blank rows at a real
// event passed this file cleanly.
const qual = (n: number, status: number, over: Partial<MatchWithResult> = {}) => ({
  Id: n, Type: 2, TypeOrder: n,
  ShortName: `Q${n}`, LongName: `Qualification ${n}`, Status: status,
  Time: new Date(Date.UTC(2026, 9, 17, 20, 0) + n * 7 * 60_000).toISOString(),
  Red1: 846, Red2: 1868, Red3: 253, Blue1: 100, Blue2: 115, Blue3: 670,
  ...over,
});

test('on deck reads the flat schedule rows the arena actually sends', () => {
  const out = mapUpcoming([
    qual(1, MatchStatus.RedWon), qual(2, MatchStatus.Tie),
    ...Array.from({ length: 10 }, (_, i) => qual(i + 3, MatchStatus.Scheduled)),
  ]);

  // Eight on deck: the side screens render four; the phone schedule view
  // needs the longer horizon.
  assert.deepEqual(out.map(u => u.shortName),
    ['Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10'], 'limit of eight');
  assert.deepEqual(out[0]?.red, [846, 1868, 253]);
  assert.deepEqual(out[0]?.blue, [100, 115, 670]);
  assert.equal(out[0]?.name, 'Qualification 3', 'the name survives the trip');
});

test('a match the scorekeeper skipped does not sit at the head of the queue', () => {
  // A no-show or a bit of schedule compression leaves a qual that is neither
  // complete nor hidden. Filtering on played-ness alone left it at position 0
  // for the rest of the weekend, and since the desk concatenates quals ahead
  // of playoffs, one skipped Saturday qual outranked the entire Sunday
  // bracket on every pit monitor. The arena's own rule is a TypeOrder floor.
  const list = [
    qual(40, MatchStatus.Scheduled),   // skipped, never played, never hidden
    qual(41, MatchStatus.RedWon),
    qual(42, MatchStatus.Scheduled),
    qual(43, MatchStatus.Scheduled),
  ];

  assert.equal(mapUpcoming(list)[0]?.shortName, 'Q40',
    'with no loaded match there is no floor, which is the honest answer');
  assert.deepEqual(mapUpcoming(list, { fromTypeOrder: 42 }).map(u => u.shortName),
    ['Q42', 'Q43'], 'the field has moved past Q40, so Q40 is not up next');
});

test('the deck stops at a break rather than carrying across it', () => {
  // field.MaxMatchGapMin. What is on the far side of lunch is not "up next",
  // and a deck that says it is has the room walking an hour early.
  const out = mapUpcoming([
    qual(1, MatchStatus.Scheduled),
    qual(2, MatchStatus.Scheduled),
    qual(3, MatchStatus.Scheduled, { Time: '2026-10-17T21:30:00Z' }),  // +60 min
    qual(4, MatchStatus.Scheduled, { Time: '2026-10-17T21:37:00Z' }),
  ]);
  assert.deepEqual(out.map(u => u.shortName), ['Q1', 'Q2']);
});

test('an unresolved playoff match is not a row with nobody in it', () => {
  // playoff_tournament.go zeroes all six stations on a match whose feeding
  // matchups have not resolved. Those rows are Scheduled, not Hidden, so they
  // reach the deck; without teams or seeds they name nobody.
  const po = (n: number, over: Partial<MatchWithResult> = {}) => ({
    Id: 100 + n, Type: 3, TypeOrder: n, ShortName: `M${n}`,
    LongName: `Playoff ${n}`, Status: MatchStatus.Scheduled,
    Red1: 0, Red2: 0, Red3: 0, Blue1: 0, Blue2: 0, Blue3: 0, ...over,
  });

  const out = mapUpcoming([
    po(5, { Red1: 254, Red2: 846, Red3: 100, Blue1: 1678, Blue2: 115, Blue3: 670 }),
    po(6, { PlayoffRedAlliance: 2, PlayoffBlueAlliance: 3 }),
    po(7),
  ]);

  assert.deepEqual(out.map(u => u.shortName), ['M5', 'M6'], 'M7 names nobody');
  assert.deepEqual(out[1], {
    name: 'Playoff 6', shortName: 'M6', time: null, red: [], blue: [],
    redAlliance: 2, blueAlliance: 3,
  }, 'seeds carry, so the row can still say which alliances meet');
});

test('an empty schedule maps to an empty deck rather than throwing', () => {
  assert.deepEqual(mapUpcoming([]), []);
  assert.deepEqual(mapRankings({}), { highestPlayedMatch: '', rankings: [] });
});

test('the driver station field is named DsConn, and nothing else counts', () => {
  /*
   * field.AllianceStation, verbatim from the 2026 source:
   *
   *     type AllianceStation struct {
   *         DsConn       *DriverStationConnection
   *         TeamMatchLog *TeamMatchLog
   *         Ethernet     bool
   *         AStop        bool
   *         EStop        bool
   *         Bypass       bool
   *         Team         *model.Team
   *         ...
   *     }
   *
   * No json tags anywhere on it, so Go emits those names verbatim, and the
   * arena's own field monitor reads stationStatus.DsConn.RobotLinked.
   *
   * This file used to say `Ds`, in the parser AND in every fixture AND in the
   * fake arena, so the tests passed against a shape the field never sends.
   * With the real shape, `linked` stayed 0 and `down` stayed empty on every
   * frame: the dropped-robot marker could never fire, the health strip showed
   * six healthy robots with three dead, and match.armed is gated on
   * `linked === fielded`, so the desk would never have cut to the score bar
   * before a countdown all weekend.
   *
   * Hence a test on the NAME rather than on the behaviour: renaming the field
   * back breaks this, where every other test in this section would still pass
   * as long as its fixture was renamed to match.
   */
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // The old name, which the arena does not send. A station carrying only this
  // has told the desk nothing, so nobody is down and nobody is linked.
  adapter.ingest('arenaStatus', {
    AllianceStations: {
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: false } },
    } as never,
    MatchState: MatchState.PreMatch,
  });
  const wrong = seen.filter(e => e.type === 'arena.status').at(-1)?.payload as { down: number[] };
  assert.deepEqual(wrong.down, [], '`Ds` is not a key the arena sends');
  assert.equal(seen.some(e => e.type === 'match.armed'), false,
    'and a station the desk cannot read is not a station it can call ready');

  // The real name, same robot, same state.
  adapter.ingest('arenaStatus', {
    AllianceStations: { R1: { Team: { Id: 846 }, DsConn: { RobotLinked: false } } },
  });
  const right = seen.filter(e => e.type === 'arena.status').at(-1)?.payload as { down: number[] };
  assert.deepEqual(right.down, [846]);
});

test('reports robots that have lost their driver station link', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('arenaStatus', {
    AllianceStations: {
      R1: { Team: { Id: 846 }, DsConn: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, DsConn: { RobotLinked: false } },
      R3: { Team: { Id: 253 }, DsConn: { RobotLinked: false }, Bypass: true },
      B1: { Team: null, DsConn: null },
    },
  });

  const status = seen.filter(e => e.type === 'arena.status').at(-1)?.payload as { down: number[] };
  // 1868 is genuinely down; 253 is bypassed on purpose and must not be flagged.
  assert.deepEqual(status.down, [1868]);
});

test('a dropped robot is an edge, not a level: one newlyDown per actual drop', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const frame = (r1: boolean, r2: boolean) => ({
    AllianceStations: {
      R1: { Team: { Id: 846 }, DsConn: { RobotLinked: r1 } },
      R2: { Team: { Id: 1868 }, DsConn: { RobotLinked: r2 } },
    },
  });
  const newlyDowns = () => seen.filter(e => e.type === 'arena.status')
    .map(e => (e.payload as { newlyDown: number[] }).newlyDown);

  // Pre-match link-up: robots connect one by one. None of this is a drop, so
  // no frame may mint a "lost comms" marker: the old level-based marking
  // produced one per unlinked robot per frame here.
  adapter.ingest('arenaStatus', frame(false, false));
  adapter.ingest('arenaStatus', frame(true, false));
  adapter.ingest('arenaStatus', frame(true, true));
  assert.deepEqual(newlyDowns(), [[], [], []], 'link-up is not a drop');

  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  seen.length = 0;

  // Mid-match, 1868 drops and STAYS down. Exactly one edge, then silence:
  // Cheesy re-sends arenaStatus continuously, and every frame used to repeat
  // the marker.
  adapter.ingest('arenaStatus', frame(true, false));
  adapter.ingest('arenaStatus', frame(true, false));
  adapter.ingest('arenaStatus', frame(true, false));
  assert.deepEqual(newlyDowns(), [[1868], [], []], 'one drop, one edge');

  // It relinks, then drops again: that is a second genuine drop.
  seen.length = 0;
  adapter.ingest('arenaStatus', frame(true, true));
  adapter.ingest('arenaStatus', frame(true, false));
  assert.deepEqual(newlyDowns(), [[], [1868]], 'a relink-then-drop is a new edge');
});

test('arms once when every fielded robot links, before the countdown', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const stations = (r2Linked: boolean) => ({
    AllianceStations: {
      R1: { Team: { Id: 846 }, DsConn: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, DsConn: { RobotLinked: r2Linked } },
      R3: { Team: { Id: 253 }, DsConn: { RobotLinked: false }, Bypass: true },
      B1: { Team: { Id: 100 }, DsConn: { RobotLinked: true } },
    },
  });

  // No match loaded yet: a green field between matches must not arm.
  adapter.ingest('arenaStatus', stations(true));
  assert.equal(seen.filter(t => t === 'match.armed').length, 0);

  adapter.ingest('matchLoad', { Match: { Id: 7, LongName: 'Qualification 7' } });

  // One robot still unlinked: not armed. Bypassed 253 must not block arming.
  adapter.ingest('arenaStatus', stations(false));
  assert.equal(seen.filter(t => t === 'match.armed').length, 0);

  // Everyone links: armed, exactly once. This is what flips program to the
  // score bar before the announcer starts counting down.
  adapter.ingest('arenaStatus', stations(true));
  adapter.ingest('arenaStatus', stations(true));
  assert.equal(seen.filter(t => t === 'match.armed').length, 1);
  assert.equal(bus.state.screen, 'match');

  // A drop and relink during the same pre-match must not re-fire it.
  adapter.ingest('arenaStatus', stations(false));
  adapter.ingest('arenaStatus', stations(true));
  assert.equal(seen.filter(t => t === 'match.armed').length, 1);

  // The next match load re-latches.
  adapter.ingest('matchLoad', { Match: { Id: 8, LongName: 'Qualification 8' } });
  assert.equal(bus.state.screen, 'overview');
  adapter.ingest('arenaStatus', stations(true));
  assert.equal(seen.filter(t => t === 'match.armed').length, 2);
});

test('a station with no DS data yet blocks arming but is not "down"', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 9, LongName: 'Qualification 9' } });
  adapter.ingest('arenaStatus', {
    AllianceStations: {
      R1: { Team: { Id: 846 }, DsConn: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, DsConn: null },   // nothing heard yet: unknown, not down
    },
  });

  assert.equal(seen.filter(e => e.type === 'match.armed').length, 0);
  const status = seen.filter(e => e.type === 'arena.status').at(-1)?.payload as { down: number[] };
  assert.deepEqual(status.down, []);
});

test('prestart no longer steals the screen; armed owns the flip', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q1', displayName: 'Qualification 1', red: [], blue: [] },
  });
  assert.equal(bus.state.screen, 'overview');

  // Field reset (PostMatch -> PreMatch) emits prestart; the overview must
  // survive it, since the audience is still reading the alliance overview.
  bus.emit({ type: 'match.prestart', source: 'cheesy' });
  assert.equal(bus.state.screen, 'overview');

  bus.emit({ type: 'match.armed', source: 'cheesy' });
  assert.equal(bus.state.screen, 'match');
});


test('alliance selection maps across, and empty captain slots stay empty', () => {
  // Fired before selection starts: the board is sized but nothing is picked.
  const early = mapSelection({
    Alliances: [{ Id: 1, TeamIds: [] }, { Id: 2, TeamIds: [] }],
    RankedTeams: [{ Rank: 1, TeamId: 254, Picked: false }],
    ShowTimer: false,
    TimeRemainingSec: 0,
  });
  assert.deepEqual(early.alliances, [{ id: 1, teams: [] }, { id: 2, teams: [] }]);
  assert.equal(early.showTimer, false);

  const live = mapSelection({
    Alliances: [
      { Id: 1, TeamIds: [254, 846, 1678] },
      { Id: 2, TeamIds: [100] },
    ],
    RankedTeams: [
      { Rank: 1, TeamId: 254, Picked: true },
      { Rank: 2, TeamId: 846, Picked: true },
      { Rank: 3, TeamId: 604, Picked: false },
    ],
    ShowTimer: true,
    TimeRemainingSec: 42,
  });
  assert.deepEqual(live.alliances[1], { id: 2, teams: [100] });
  assert.equal(live.ranked.filter(r => !r.picked).length, 1);
  assert.equal(live.timeRemainingSec, 42);
  assert.equal(live.showTimer, true);
});

test('a garbled selection message degrades instead of putting team 0 on air', () => {
  const sel = mapSelection({
    Alliances: [{ TeamIds: [254, 0, undefined as unknown as number] }],
    RankedTeams: [{ Rank: 1, TeamId: 0 }, { Rank: 2, TeamId: 846 }],
    TimeRemainingSec: -5,
  });
  assert.deepEqual(sel.alliances, [{ id: 1, teams: [254] }], 'zeroes are holes, not teams');
  assert.deepEqual(sel.ranked.map(r => r.team), [846]);
  assert.equal(sel.timeRemainingSec, 0, 'a negative clock never counts up');
});

test('selection lands in state and every update replaces the whole board', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'alliance_selection.update', source: 'cheesy',
    payload: mapSelection({ Alliances: [{ Id: 1, TeamIds: [254] }], ShowTimer: true, TimeRemainingSec: 60 }),
  });
  assert.deepEqual(bus.state.selection?.alliances, [{ id: 1, teams: [254] }]);

  bus.emit({
    type: 'alliance_selection.update', source: 'cheesy',
    payload: mapSelection({ Alliances: [{ Id: 1, TeamIds: [254, 846] }], ShowTimer: true, TimeRemainingSec: 55 }),
  });
  assert.deepEqual(bus.state.selection?.alliances, [{ id: 1, teams: [254, 846] }]);
  assert.equal(bus.state.selection?.timeRemainingSec, 55);
});

test('playoff seeds ride along, and qualification carries none', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: 'x', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: { Id: 1, LongName: 'Qualification 42', Red1: 846, Red2: 1868, Red3: 253,
             Blue1: 100, Blue2: 115, Blue3: 670, PlayoffRedAlliance: 0, PlayoffBlueAlliance: 0 },
  });
  assert.equal(bus.state.match?.redAlliance, undefined, 'a qual match has no seed');
  assert.equal(bus.state.match?.blueAlliance, undefined);

  adapter.ingest('matchLoad', {
    Match: { Id: 2, LongName: 'Match 7 (R2)', Red1: 254, Red2: 846, Red3: 1678,
             Blue1: 100, Blue2: 115, Blue3: 670, PlayoffRedAlliance: 1, PlayoffBlueAlliance: 4 },
  });
  assert.equal(bus.state.match?.redAlliance, 1);
  assert.equal(bus.state.match?.blueAlliance, 4);
  // Three robots take the field in a playoff match too; the fourth alliance
  // member is a backup and is not on it.
  assert.equal(bus.state.match?.red.length, 3);
});

test('surfaces can size off the alliance rather than a hard-coded three', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: {
      id: 'sf1m1', displayName: 'Match 7 (R2)',
      red: [{ number: 254, name: 'A' }, { number: 846, name: 'B' },
            { number: 1678, name: 'C' }, { number: 25801, name: 'D' }],
      blue: [{ number: 100, name: 'E' }, { number: 115, name: 'F' }],
    },
  });
  // A four-team roster and a short-handed alliance both survive the reducer
  // untouched: nothing clamps, pads, or drops a team on the way through.
  assert.equal(bus.state.match?.red.length, 4);
  assert.equal(bus.state.match?.blue.length, 2);
  assert.deepEqual(bus.state.match?.red.map(t => t.number), [254, 846, 1678, 25801]);
});

test('surrogates come off the field, which is the only place they exist', () => {
  // The desk has had a surrogate mark on the bar and a "does not count" line
  // on the talent view since they were built, and neither could ever appear at
  // a real event: the protocol did not model Cheesy's station flags, so the
  // only thing that ever set the field was a test fixture.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: {
      Id: 42, LongName: 'Qualification 42',
      Red1: 846, Red2: 1868, Red3: 253,
      Blue1: 100, Blue2: 115, Blue3: 670,
      Red2IsSurrogate: true, Blue3IsSurrogate: true,
    },
  });
  assert.deepEqual(bus.state.match?.surrogates, [1868, 670]);

  // A match with none carries an empty list rather than stale flags from the
  // match before it, which is the failure that would actually reach air.
  adapter.ingest('matchLoad', {
    Match: { Id: 43, LongName: 'Qualification 43', Red1: 846, Blue1: 100 },
  });
  assert.deepEqual(bus.state.match?.surrogates, []);
});

test('the arena replaying its last result does not reveal a score mid-match', () => {
  // Cheesy replays every notifier to a display the moment it (re)subscribes.
  // Every other handler accounts for that; this one did not, so one socket
  // blip during match 43 cut the program to match 42's final score and let
  // the auto-queue claim 43's label with a clip ending mid-match.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  const posted = (id: number, r: number, b: number) =>
    ({ Match: { Id: id }, RedScoreSummary: { Score: r }, BlueScoreSummary: { Score: b } });

  adapter.ingest('matchLoad', { Match: { Id: 42, LongName: 'Qualification 42' } });
  adapter.ingest('scorePosted', posted(42, 157, 155));
  adapter.ingest('matchLoad', { Match: { Id: 43, LongName: 'Qualification 43' } });
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });

  adapter.ingest('scorePosted', posted(42, 157, 155));
  assert.equal(bus.state.screen, 'match', 'program stays on the live match');
  assert.equal(bus.state.scorePostedAt, null, 'no reveal is recorded for the running match');
});

test('a re-committed correction for the loaded match still reveals', () => {
  // The guard is on identity, not content, precisely so a scorekeeper fixing
  // a number and committing again reaches air.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 43, LongName: 'Qualification 43' } });
  adapter.ingest('scorePosted',
    { Match: { Id: 43 }, RedScoreSummary: { Score: 100 }, BlueScoreSummary: { Score: 90 } });
  adapter.ingest('scorePosted',
    { Match: { Id: 43 }, RedScoreSummary: { Score: 105 }, BlueScoreSummary: { Score: 90 } });

  assert.equal(bus.state.screen, 'score');
  assert.equal(bus.state.score.red.total, 105, 'the corrected number is the one on air');
});

test('an arena that sends no match id on scorePosted is unaffected', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 43, LongName: 'Qualification 43' } });
  adapter.ingest('scorePosted', { RedScoreSummary: { Score: 77 }, BlueScoreSummary: { Score: 70 } });
  assert.equal(bus.state.screen, 'score');
});

test('a reconnect echo of matchLoad in the post-score gap does not wipe the score', () => {
  // The field sits in PreMatch for minutes after a score posts, and Cheesy
  // replays every notifier when a display socket reconnects. That echo used
  // to run the full load reset: score off air, program yanked back to the
  // finished match's overview, the timestamps the gap cue and publish cut
  // key off nulled. Same id, no IsReplay, score still on the board = echo.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  const load = { Match: { Id: 42, LongName: 'Qualification 12', Type: 'qualification' } };

  adapter.ingest('matchLoad', load);
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });
  adapter.ingest('scorePosted', {
    Match: { Id: 42, LongName: 'Qualification 12', Type: 'qualification' },
    RedScoreSummary: { Score: 100 }, BlueScoreSummary: { Score: 80 },
  });
  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch });
  assert.ok(bus.state.scorePostedAt !== null, 'fixture sanity: a score is on the board');

  const loadsBefore = bus.recent.filter(e => e.type === 'match.loaded').length;
  adapter.ingest('matchLoad', load);                    // the reconnect echo
  assert.equal(bus.recent.filter(e => e.type === 'match.loaded').length, loadsBefore,
    'the echo must not re-emit match.loaded');
  assert.ok(bus.state.scorePostedAt !== null, 'the posted score must stay on air');

  // A GENUINE scorekeeper re-run of the same match says so, and still resets.
  adapter.ingest('matchLoad', { ...load, IsReplay: true });
  assert.equal(bus.recent.filter(e => e.type === 'match.loaded').length, loadsBefore + 1,
    'a flagged replay is a real re-run and must reset');
});

test('a desk that restarts mid-match picks the match up where it is', () => {
  /*
   * #matchState starts at PreMatch, so a desk that connects during teleop
   * sees its first frame as a transition into TeleopPeriod. The teleop arm
   * only re-anchors when it follows auto or the pause, and the start arm only
   * fires for StartMatch and AutoPeriod, so nothing emitted match.start: the
   * clock sat dead at 0:00 and program held the alliance overview for the
   * rest of the match. A restart during the one stretch of the day that
   * cannot be paused is exactly when a restart happens.
   */
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // The field is 42 seconds into teleop when the desk comes back.
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 42 });

  assert.equal(seen.filter(t => t === 'match.start').length, 1,
    'the match is running, so the desk says so');
  assert.ok(bus.state.matchStartedAt !== null, 'and the clock is anchored');

  // Back-dated to the field's own match time, not restarted at zero in front
  // of the hall, and not re-anchored to the top of teleop either.
  const age = Date.now() - (bus.state.matchStartedAt ?? 0);
  assert.ok(age >= 41_000 && age <= 45_000,
    `the clock picks up ~42s in, not at 0:00 (got ${Math.round(age / 1000)}s)`);
  assert.equal(seen.filter(t => t === 'match.teleop_start').length, 0,
    'the teleop re-anchor exists to guess an unknown pause; here the field '
    + 'told us the time, so guessing would throw that away');

  // And it still only fires once as the match plays out.
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });
  assert.equal(seen.filter(t => t === 'match.start').length, 1);
  assert.equal(seen.filter(t => t === 'match.end').length, 1);
});

test('joining at the normal time is unchanged', () => {
  // The late-join path must not double-fire on an ordinary match.
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.PreMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 1 });
  adapter.ingest('matchTime', { MatchState: MatchState.PausePeriod, MatchTimeSec: 16 });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 20 });

  assert.equal(seen.filter(t => t === 'match.start').length, 1, 'exactly one start');
  assert.equal(seen.filter(t => t === 'match.teleop_start').length, 1, 'exactly one re-anchor');
});

test('an arena restart does not wipe the alliance rosters', () => {
  /*
   * Cheesy writes each notifier's current value to a socket the moment it
   * connects. The allianceSelection message comes from
   * arena.AllianceSelectionAlliances, an IN-MEMORY field that is empty after
   * any arena restart and is only repopulated when a human opens
   * /alliance_selection in a browser, which does not fire the notifier.
   *
   * So an arena restart on Sunday, or any socket blip after one, delivered an
   * empty list, and the reducer replaced the rosters wholesale. The fourth
   * alliance member then vanished from the selection board, the result card
   * and the awards graphic for the rest of the playoffs, with nothing short of
   * a desk restart able to bring it back.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('allianceSelection', {
    Alliances: [
      { Id: 1, TeamIds: [254, 846, 1678, 100] },
      { Id: 2, TeamIds: [971, 1868, 115] },
    ],
  });
  assert.deepEqual(bus.state.selection?.alliances[0]?.teams, [254, 846, 1678, 100]);

  // The arena comes back up and immediately tells every display it has no
  // alliances. That is the arena saying it has forgotten, not a fact about
  // the alliances.
  adapter.ingest('allianceSelection', {
    Alliances: [{ Id: 1, TeamIds: [] }, { Id: 2, TeamIds: [] }],
  });
  assert.deepEqual(bus.state.selection?.alliances[0]?.teams, [254, 846, 1678, 100],
    'the fourth member is still there');

  // A real change still lands, including one that shortens an alliance.
  adapter.ingest('allianceSelection', {
    Alliances: [{ Id: 1, TeamIds: [254, 846, 1678] }],
  });
  assert.deepEqual(bus.state.selection?.alliances[0]?.teams, [254, 846, 1678]);
});

test('an empty alliance list before selection is not suppressed', () => {
  // The notifier fires before selection starts, sized to the event with every
  // roster empty. That IS the board at that moment: a row of open slots.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('allianceSelection', {
    Alliances: [{ Id: 1, TeamIds: [] }, { Id: 2, TeamIds: [] }],
  });
  assert.equal(bus.state.selection?.alliances.length, 2);
});

test('the field disagreeing about match timing is noticed and said out loud', () => {
  /*
   * AutoDurationSec and friends are editable on the scorekeeper's settings
   * page, and the arena pushes them to every display on connect. The desk had
   * no case for this notifier at all, so it fell through to `default: return`
   * and kept its compiled-in periods. Shortening practice matches is a normal
   * thing to do at an offseason, and if it happened the phase labels, the
   * endgame chip, the lockdown, the replay markers and the countdown would be
   * wrong for the rest of the day with nothing to say why.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // The arena's defaults, which are the desk's.
  adapter.ingest('matchTiming', {
    AutoDurationSec: 20, PauseDurationSec: 3, TransitionShiftDurationSec: 10,
    ShiftDurationSec: 25, EndgameDurationSec: 30, TimeoutDurationSec: 0,
  });
  assert.equal(adapter.timingMismatch, null, 'the shipped numbers agree');

  // A scorekeeper shortens auto and the endgame for filler matches.
  adapter.ingest('matchTiming', {
    AutoDurationSec: 15, PauseDurationSec: 3, TransitionShiftDurationSec: 10,
    ShiftDurationSec: 25, EndgameDurationSec: 20, TimeoutDurationSec: 0,
  });
  const off: string[] = adapter.timingMismatch ?? [];
  assert.equal(off.length, 2, 'both changes are reported, not just the first');
  assert.ok(off.some(s => s.includes('AutoDurationSec is 15s')), off.join(' | '));
  assert.ok(off.some(s => s.includes('EndgameDurationSec is 20s')), off.join(' | '));

  // Putting it back clears it: this is a live comparison, not a latch.
  adapter.ingest('matchTiming', {
    AutoDurationSec: 20, TransitionShiftDurationSec: 10,
    ShiftDurationSec: 25, EndgameDurationSec: 30,
  });
  assert.equal(adapter.timingMismatch, null);

  // The pause has no counterpart on the desk's clock, which treats teleop
  // start as zero, so changing it moves nothing on air and is not reported.
  adapter.ingest('matchTiming', {
    AutoDurationSec: 20, PauseDurationSec: 8, TransitionShiftDurationSec: 10,
    ShiftDurationSec: 25, EndgameDurationSec: 30,
  });
  assert.equal(adapter.timingMismatch, null);
});

test('bonus ranking points come from the field, not from the desk\'s arithmetic', () => {
  /*
   * The desk used to recompute all three from config thresholds, which asks a
   * different question from the one the arena answers:
   *
   *   - Cheesy scores the fuel bonuses on NumFuel, a COUNT. The desk only has
   *     fuel POINTS, and fuel into an inactive hub scores nothing, so the two
   *     agree only on a match where every shot counted.
   *   - The thresholds are editable on the scorekeeper's settings page
   *     mid-event; the desk reads its own copy from config.json.
   *   - A G206 call strips all three at once and the desk never learns which
   *     rule a foul was for.
   *   - A traversal threshold of zero DISABLES the tower bonus. `tower >= 0`
   *     lit it permanently instead.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // A lot of fuel POINTS, but the arena says the count did not reach the line.
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: {
      TeleopFuelPoints: 400, TeleopTowerPoints: 90,
      EnergizedBonusRankingPoint: false,
      SuperchargedBonusRankingPoint: false,
      TraversalBonusRankingPoint: false,
    } },
  });
  assert.deepEqual(bus.state.score.red.rp,
    { energized: false, supercharged: false, traversal: false },
    'the field says no, whatever the desk would have worked out');

  // And the other way: the arena awards it on a figure the desk cannot see.
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: {
      TeleopFuelPoints: 4, TeleopTowerPoints: 0,
      EnergizedBonusRankingPoint: true,
      SuperchargedBonusRankingPoint: false,
      TraversalBonusRankingPoint: true,
    } },
  });
  assert.deepEqual(bus.state.score.red.rp,
    { energized: true, supercharged: false, traversal: true });
});

test('a summary with no opinion leaves the desk deriving, for a show with no field', () => {
  // The derivation is not dead code: an operator-driven desk with no arena
  // attached is a supported way to run, and the badges still have to work.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 120, TeleopTowerPoints: 60 } },
  });
  assert.equal(bus.state.score.red.rp.energized, true, 'derived against thresholds');
  assert.equal(bus.state.score.red.rp.traversal, true);
});

test('the posted score carries the committed bonuses, not the last live frame', () => {
  // A referee adjustment on the review page lands in the commit and never in
  // a realtime snapshot, and a G206 added there strips all three at once.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 42, LongName: 'Qualification 42' } });
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: {
      TeleopFuelPoints: 150, TeleopTowerPoints: 60,
      EnergizedBonusRankingPoint: true,
      SuperchargedBonusRankingPoint: true,
      TraversalBonusRankingPoint: true,
    } },
  });
  assert.equal(bus.state.score.red.rp.energized, true);

  adapter.ingest('scorePosted', {
    Match: { Id: 42 },
    RedScoreSummary: {
      Score: 210,
      EnergizedBonusRankingPoint: false,
      SuperchargedBonusRankingPoint: false,
      TraversalBonusRankingPoint: false,
    },
    BlueScoreSummary: { Score: 140 },
  });
  assert.deepEqual(bus.state.score.red.rp,
    { energized: false, supercharged: false, traversal: false },
    'G206 on the review page takes all three, and the badges have to follow');
  assert.equal(bus.state.score.red.total, 210, 'and the official total still lands');
});

test('the one socket that CAN read from us is never asked to', async () => {
  /*
   * Five of the six allowlisted sockets are HandleNotifiers-only and cannot
   * process anything the desk sends. /displays/field_monitor/websocket is not
   * one of them: it runs HandleNotifiers in a goroutine and then enters its
   * own read loop, which accepts an `updateTeamNotes` command that sets
   * Team.FtaNotes and calls Database.UpdateTeam. That is a write into the
   * event database from a socket on the allowlist.
   *
   * The arena's gate is `?fta=true` AND userIsAdmin, and userIsAdmin returns
   * true unconditionally when AdminPassword is empty, which is the normal
   * state at an offseason. So the query parameter is effectively the whole
   * gate, and the desk not setting it is the invariant. It used to be a
   * comment claiming all six sockets were safe by construction. It is a test
   * now, because it is ours to keep rather than the arena's to enforce.
   */
  const seen: string[] = [];
  const server = createServer();
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_sock, req) => { seen.push(req.url ?? ''); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const client = new CheesyClient({
    host: `127.0.0.1:${port}`, displayId: 'contentdesk1', onEvent: () => {},
  });
  try {
    client.connect();
    for (let i = 0; i < 80 && seen.length < DEFAULT_SOCKETS.length; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const monitor = seen.find(u => u.startsWith('/displays/field_monitor/'));
    assert.ok(monitor, 'the field monitor socket is opened: it is the only arenaStatus source');
    assert.equal(/\bfta=/i.test(monitor), false,
      'fta is never set, on any socket, ever');
    for (const url of seen) {
      assert.equal(/\bfta=/i.test(url), false, `fta appears in ${url}`);
    }
  } finally {
    client.close();
    wss.close();
    await new Promise(r => server.close(r));
  }
});

test('each display socket registers under its own id, because registering is a write', async () => {
  /*
   * Each connection calls arena.RegisterDisplay, which looks up Displays[id]
   * and overwrites that display's whole configuration, Type included, then
   * notifies every subscriber. Sharing one id across five sockets meant the
   * desk fought with itself: the scorekeeper's /setup/displays page, which is
   * what they open when a screen goes missing, showed one row whose type
   * flickered between five values with a connection count of five.
   *
   * The sharper reason is collision. A browser registered under the same id
   * subscribes to that display's notifier, and the arena's own client
   * navigates on a displayConfiguration whose URL differs, so a real audience
   * projector sharing the id would have been driven to /displays/rankings
   * mid-match by the desk's rankings socket.
   */
  const seen: string[] = [];
  const server = createServer();
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_sock, req) => { seen.push(req.url ?? ''); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const client = new CheesyClient({
    host: `127.0.0.1:${port}`, displayId: 'contentdesk1', onEvent: () => {},
  });
  try {
    client.connect();
    for (let i = 0; i < 80 && seen.length < DEFAULT_SOCKETS.length; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    const ids = seen
      .map(u => new URLSearchParams(u.slice(u.indexOf('?') + 1)).get('displayId'))
      .filter((v): v is string => !!v);
    assert.equal(ids.length, DEFAULT_SOCKETS.filter(p => p.startsWith('/displays/')).length,
      'every display socket opened carries an id');
    assert.equal(new Set(ids).size, ids.length, 'and no two of them are the same');
    for (const id of ids) {
      assert.ok(id.startsWith('contentdesk1-'),
        `${id} should still be recognisably this desk's`);
    }
    // The arena only ever auto-assigns numeric ids, so nothing it hands out
    // can land on one of these.
    for (const id of ids) assert.equal(/^\d+$/.test(id), false, id);

    const bare = seen.find(u => u.startsWith('/api/arena/'));
    assert.ok(bare && !bare.includes('displayId'),
      'the arena socket is not a display and takes no id');
  } finally {
    client.close();
    wss.close();
    await new Promise(r => server.close(r));
  }
});

test('a tiebroken playoff names the winner the bracket advanced, not "TIE"', () => {
  /*
   * Every double elimination match is created with useTiebreakCriteria, so a
   * level score is resolved on major fouls, then auto fuel, then tower
   * points, and the arena advances that alliance. The desk worked its verdict
   * out by comparing the two totals, so it printed TIE on the audience screen
   * and on the card people post, while the announcer and the bracket said Red
   * advances.
   *
   * The arena has been sending RedWon, BlueWon and TiebreakReason on every
   * posted score the whole time.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 7, LongName: 'Match 7', Type: 3 } });

  adapter.ingest('scorePosted', {
    Match: { Id: 7 },
    RedScoreSummary: { Score: 140, AutoFuelPoints: 20 },
    BlueScoreSummary: { Score: 140, AutoFuelPoints: 12 },
    RedWon: true, BlueWon: false,
    TiebreakReason: 'TIEBREAK: AUTO FUEL',
  });

  assert.equal(bus.state.score.red.total, bus.state.score.blue.total, 'the totals ARE level');
  assert.equal(bus.state.officialWinner, 'red', 'and red still won');
  assert.equal(bus.state.tiebreakReason, 'TIEBREAK: AUTO FUEL');
});

test('a disqualified alliance does not get "winner" for holding the higher score', () => {
  // CorrectPlayoffScore sets PlayoffDq from a red card WITHOUT touching Score,
  // and a DQ beats any score. Comparing totals put WINNER under the alliance
  // that had just been disqualified.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 8, LongName: 'Match 8', Type: 3 } });

  adapter.ingest('scorePosted', {
    Match: { Id: 8 },
    RedScoreSummary: { Score: 200, PlayoffDq: true },
    BlueScoreSummary: { Score: 150 },
    RedWon: false, BlueWon: true,
  });

  assert.ok(bus.state.score.red.total > bus.state.score.blue.total, 'red has more points');
  assert.equal(bus.state.officialWinner, 'blue', 'and blue won the match');
});

test('a genuine tie is still a tie, and a new match clears the verdict', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 9, LongName: 'Qualification 9', Type: 2 } });
  adapter.ingest('scorePosted', {
    Match: { Id: 9 },
    RedScoreSummary: { Score: 100 }, BlueScoreSummary: { Score: 100 },
    RedWon: false, BlueWon: false, TiebreakReason: 'TRUE TIE',
  });
  assert.equal(bus.state.officialWinner, 'tie');
  assert.equal(bus.state.tiebreakReason, 'TRUE TIE');

  // The last match's verdict is not this match's.
  adapter.ingest('matchLoad', { Match: { Id: 10, LongName: 'Qualification 10', Type: 2 } });
  assert.equal(bus.state.officialWinner, null);
  assert.equal(bus.state.tiebreakReason, null);
});

test('a playoff alliance names its backup, from the field rather than a join', () => {
  /*
   * The arena resolves the off-field members on every playoff matchLoad and
   * sends them as whole team records. The desk dropped them and believed the
   * fourth member could only be found by joining playoff seeds against the
   * rosters observed during alliance selection, so a desk that restarted
   * through selection could not name the backup at all, and on the day an
   * alliance subbed one in the graphic named three robots and left out the
   * one about to play.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: { Id: 11, LongName: 'Match 11', Type: 3, Red1: 254, Red2: 846, Red3: 100 },
    RedOffFieldTeams: [{ Id: 1678, Nickname: 'Citrus Circuits' }],
    BlueOffFieldTeams: [{ Id: 971, Nickname: 'Spartan Robotics' }, null],
  });

  assert.deepEqual(bus.state.match?.redOffField,
    [{ number: 1678, name: 'Citrus Circuits' }]);
  assert.deepEqual(bus.state.match?.blueOffField?.map(t => t.number), [971],
    'a null slot is not a team zero');

  // Qualification matches have nobody off the field, and must not carry an
  // empty array that a surface would render as a heading with nothing under it.
  adapter.ingest('matchLoad', { Match: { Id: 12, LongName: 'Qualification 12', Type: 2 } });
  assert.equal(bus.state.match?.redOffField, undefined);
});

test('a break says what it is, when it ends, and what comes after', () => {
  /*
   * Starting a scheduled break or a timeout sets breakDescription and
   * breakNextMatchName, fires matchLoad with both, fires matchTiming with the
   * new TimeoutDurationSec, and only then flips the state. The desk read none
   * of it, so through lunch, the awards break and every field repair the
   * arena's own audience display showed the name, the next match and a live
   * countdown while the venue screens and the stream showed an undescribed
   * "timeout" with no clock.
   */
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTiming', {
    AutoDurationSec: 20, TransitionShiftDurationSec: 10, ShiftDurationSec: 25,
    EndgameDurationSec: 30, TimeoutDurationSec: 900,
  });
  adapter.ingest('matchLoad', {
    Match: { Id: 20, LongName: 'Qualification 20', Type: 2 },
    BreakDescription: 'Awards Break',
    BreakNextMatchName: 'Match 11',
  });
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive });

  const brk = seen.filter(e => e.type === 'break.started').at(-1)?.payload as {
    kind: string; label?: string; nextMatch?: string; seconds?: number;
  };
  assert.equal(brk.label, 'Awards Break');
  assert.equal(brk.nextMatch, 'Match 11');
  assert.equal(brk.seconds, 900);
});

test('the same notifier on two sockets is taken from one of them', () => {
  /*
   * matchLoad is published on five of the desk's six sockets, matchTime on
   * four, realtimeScore on two. Each is an independent TCP connection
   * carrying the identical stream, the messages carry no sequence number, and
   * each arena-side listener is a five-deep channel with a NON-BLOCKING send
   * that drops when full, so one socket running seconds behind the others is
   * an ordinary outcome when this process is busy cutting a clip.
   *
   * Identical duplicates were harmless. Reordered ones were not.
   */
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const A = '/displays/audience/websocket';
  const B = '/api/arena/websocket';

  // A plays the match through. B is the same stream a few seconds behind,
  // which is what a five-deep non-blocking channel does under load.
  for (const state of [
    MatchState.StartMatch, MatchState.AutoPeriod, MatchState.PausePeriod,
    MatchState.TeleopPeriod, MatchState.PostMatch,
  ]) {
    adapter.ingest('matchTime', { MatchState: state }, A);
  }
  for (const state of [
    MatchState.StartMatch, MatchState.AutoPeriod, MatchState.PausePeriod,
    MatchState.TeleopPeriod, MatchState.PostMatch,
  ]) {
    adapter.ingest('matchTime', { MatchState: state }, B);
  }

  // Without arbitration, B's lagging copy fired match.end a second time,
  // running the post-match sequence and the automatic upload cut again, and
  // fired match.teleop_start again, which re-anchors the clock and jumps the
  // on-air countdown backwards to 2:20 in the middle of teleop.
  assert.equal(seen.filter(t => t === 'match.end').length, 1, 'one buzzer, one end');
  assert.equal(seen.filter(t => t === 'match.start').length, 1, 'one start');
  assert.equal(seen.filter(t => t === 'match.teleop_start').length, 1,
    'and the clock is not re-anchored mid-teleop');
});

test('a stale score frame from a second socket cannot inflate a delta', () => {
  // 50 on the owner, a delayed 45 from another socket, then 55. The desk used
  // to emit +10 for 5 points of real scoring, and score.delta drives the
  // replay markers, the scoring-rate graphic and the post-match timeline.
  const bus = new EventBus();
  const seen: { field: string; amount: number }[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'score.delta') seen.push(ev.payload as { field: string; amount: number });
  });
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const A = '/displays/audience/websocket';
  const B = '/displays/field_monitor/websocket';
  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 50 } } }, A);
  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 45 } } }, B);
  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 55 } } }, A);

  assert.deepEqual(seen.map(d => d.amount), [50, 5],
    'the baseline, then five points: the stale frame is not in the ledger');
  assert.equal(bus.state.score.red.fuel, 55, 'and the score does not dip and jump back');
});

test('losing the socket that owned a notifier hands it to another', () => {
  // Otherwise losing /displays/audience would silently stop scorePosted for
  // the rest of the event, while three other sockets went on carrying
  // matchLoad and matchTime perfectly well.
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  const A = '/displays/audience/websocket';
  const B = '/api/arena/websocket';

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } }, A);
  assert.equal(seen.filter(t => t === 'match.loaded').length, 1);

  // B is ignored while A owns it.
  adapter.ingest('matchLoad', { Match: { Id: 2, LongName: 'Qualification 2' } }, B);
  assert.equal(bus.state.match?.displayName, 'Qualification 1', 'still A\'s');

  // A drops. B takes over on its next frame.
  adapter.socketDown(A);
  adapter.ingest('matchLoad', { Match: { Id: 2, LongName: 'Qualification 2' } }, B);
  assert.equal(bus.state.match?.displayName, 'Qualification 2');
});

test('a replay or a test feeds one source, so arbitration stays out of the way', () => {
  // ingest() with no path is how a recorded capture and every other test in
  // this file drive the adapter. There is nothing to arbitrate there.
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });
  adapter.ingest('matchLoad', { Match: { Id: 5, LongName: 'Qualification 5' } });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });
  assert.equal(bus.state.match?.displayName, 'Qualification 5');
});

test('the rankings column agrees with the order it is printed in', () => {
  /*
   * Cheesy ranks on AVERAGE ranking points: Rankings.Less compares
   * a.RankingPoints*b.Played against b.RankingPoints*a.Played, and every
   * tiebreaker under it cross-multiplies by Played too.
   *
   * The desk printed the raw total beside the rank. At an offseason, teams
   * playing unequal numbers of matches is routine: somebody drops out, a
   * match is skipped, a DQ counts as played with zero RP. So the on-air
   * table would show a rank-4 team with MORE ranking points than the rank-3
   * team above it, which reads as a broken graphic from the back of a gym and
   * sends people to the scoring table.
   */
  const out = mapRankings({
    Rankings: [
      // 30 RP over 10 matches beats 33 over 12, and the arena ranks it that way.
      { Rank: 1, TeamId: 254, RankingPoints: 30, Played: 10, Wins: 8 },
      { Rank: 2, TeamId: 846, RankingPoints: 33, Played: 12, Wins: 9 },
    ],
  });

  assert.equal(out.rankings[0]?.avgRp, 3);
  assert.equal(out.rankings[1]?.avgRp, 2.8);
  assert.ok(out.rankings[0]!.avgRp > out.rankings[1]!.avgRp,
    'rank 1 has the higher number, which is the whole point');
  assert.ok(out.rankings[0]!.rankingPoints < out.rankings[1]!.rankingPoints,
    'while the raw total says the opposite, which is what was on air');
});

test('a team with no matches played does not divide by zero', () => {
  const out = mapRankings({ Rankings: [{ Rank: 1, TeamId: 254, RankingPoints: 0, Played: 0 }] });
  assert.equal(out.rankings[0]?.avgRp, 0);
});

test('an aborted match is not a played match', () => {
  /*
   * AbortMatch sets the arena's state straight to PostMatch, so from the
   * desk's side an abort looked exactly like a buzzer: match.end fired and
   * the coverage ledger marked the match played. An abort that is never
   * replayed then sat in the gap list reporting no-score AND never-queued,
   * advising somebody to hand-queue a match that was correctly never
   * recorded. A gap report full of those stops being read on the Sunday it
   * matters.
   */
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 2 });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 30 });
  // Stopped at 48s of 160.
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 48 });

  assert.equal(seen.includes('match.aborted'), true);
  assert.equal(seen.includes('match.end'), false, 'an abort is not a result');
});

test('a match that runs to the buzzer still ends normally', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 2 });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 30 });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 160 });

  assert.equal(seen.includes('match.end'), true);
  assert.equal(seen.includes('match.aborted'), false);

  // And a field that sends no match time at all is given the benefit of the
  // doubt: the cost of guessing "ended" is only the behaviour that was there
  // before, where the cost of guessing "aborted" is a lost video.
  const bus2 = new EventBus();
  const seen2: string[] = [];
  bus2.subscribe(ev => seen2.push(ev.type));
  const a2 = new CheesyAdapter({ bus: bus2, host: '127.0.0.1:1', displayId: 'test' });
  a2.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });
  a2.ingest('matchTime', { MatchState: MatchState.PostMatch });
  assert.equal(seen2.includes('match.end'), true);
});

test('the field loading its test match does not put "Test Match" on air', () => {
  /*
   * When the last match of a type is committed, LoadNextMatch finds nothing
   * and calls LoadTestMatch, which loads {Type: Test, Id: 0, LongName: "Test
   * Match"} with no teams. So the program feed and the lower third read "Test
   * Match" with two empty alliances for the whole alliance-selection window,
   * and again through the awards, while the arena's own automation had moved
   * its audience display to the logo for exactly that reason.
   */
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: { Id: 60, Type: 2, LongName: 'Qualification 60', Red1: 254, Blue1: 846 },
  });
  assert.equal(bus.state.match?.displayName, 'Qualification 60');

  adapter.ingest('matchLoad', { Match: { Id: 0, Type: 0, LongName: 'Test Match' } });
  assert.equal(bus.state.match?.displayName, 'Qualification 60',
    'the last real match stays on screen, and the operator moves it on');
});

test('the schedule is not pulled from the arena while a match is running', async () => {
  /*
   * GET /api/matches/{type} is O(N-squared) over the arena's bbolt database:
   * matchesApiHandler calls GetMatchResultForMatch once per match, and that
   * has no index, so it calls getAll() every time and walks the whole bucket
   * doing a json.Unmarshal per record, each carrying two full score structs,
   * then summarizes twice per match. For an 80-match schedule with results
   * that is thousands of unmarshals for ONE request.
   *
   * The desk issued two of those every sixty seconds on a bare timer with no
   * check on match state, in the same process as the arena's Run loop, which
   * warns above 5ms per iteration and above 550ms between driver station
   * packets. Expected symptom: "Arena loop iteration took a long time" in the
   * FTA's log at a steady one a minute, correlated with the new box on their
   * network.
   */
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url?.includes('rankings') ? '{"Rankings":[]}' : '[]');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: `127.0.0.1:${port}`, displayId: 'test' });
  try {
    // Mid-teleop.
    adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 2 });
    adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 40 });
    await adapter.pollNow();

    assert.ok(asked.some(u => u.includes('rankings')),
      'rankings are cheap and are wanted the moment they move');
    assert.equal(asked.some(u => u.includes('/api/matches/')), false,
      'the schedule is not worth a table walk mid-match');

    // The buzzer. Now it is fair game, and it is also when the schedule has
    // actually changed.
    asked.length = 0;
    adapter.ingest('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 160 });
    await adapter.pollNow();
    assert.ok(asked.some(u => u.includes('/api/matches/qualification')));
  } finally {
    adapter.stop();
    await new Promise(r => server.close(r));
  }
});

test('the playoff schedule is not asked for before a bracket exists', async () => {
  // Asking costs the same full table walk as a real answer, and the answer is
  // an empty array right up until alliance selection finalizes.
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url?.includes('rankings') ? '{"Rankings":[]}' : '[]');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: `127.0.0.1:${port}`, displayId: 'test' });
  try {
    await adapter.pollNow();
    assert.ok(asked.some(u => u.includes('/api/matches/qualification')));
    assert.equal(asked.some(u => u.includes('/api/matches/playoff')), false,
      'there is no bracket on Saturday morning');

    // Alliance selection happens.
    asked.length = 0;
    adapter.ingest('allianceSelection', {
      Alliances: [{ Id: 1, TeamIds: [254, 846, 1678, 100] }],
    });
    await adapter.pollNow();
    assert.ok(asked.some(u => u.includes('/api/matches/playoff')));
  } finally {
    adapter.stop();
    await new Promise(r => server.close(r));
  }
});

test('a score changed after the commit is noticed from the schedule poll', async () => {
  /*
   * commitMatchScore guards ScorePostedNotifier.Notify() with
   * `if !isMatchReviewEdit`, so a correction made on /match_review
   * republishes matches and rankings to TBA and tells the desk NOTHING. The
   * only thing that changes on the desk's side is the committed result on the
   * schedule route, which it is already polling.
   */
  let score = { red: 552, blue: 527 };
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.includes('rankings')) return res.end('{"Rankings":[]}');
    if (req.url?.includes('qualification')) {
      return res.end(JSON.stringify([{
        Id: 42, Type: 2, TypeOrder: 42, ShortName: 'Q42',
        LongName: 'Qualification 42', Status: MatchStatus.RedWon,
        Result: { RedSummary: { Score: score.red }, BlueSummary: { Score: score.blue } },
      }]));
    }
    res.end('[]');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };

  const bus = new EventBus();
  const seen: { label: string; red: number; blue: number }[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'match.score_corrected') {
      seen.push(ev.payload as { label: string; red: number; blue: number });
    }
  });
  const adapter = new CheesyAdapter({ bus, host: `127.0.0.1:${port}`, displayId: 'test' });

  try {
    // First sight of a played match is not a correction: it is just a result.
    await adapter.pollNow();
    assert.equal(seen.length, 0);

    // Polling again with nothing changed is not news either.
    await adapter.pollNow();
    assert.equal(seen.length, 0);

    // The head referee changes it on match review.
    score = { red: 548, blue: 527 };
    await adapter.pollNow();
    assert.deepEqual(seen, [{ label: 'Qualification 42', red: 548, blue: 527 }]);

    // And once is enough.
    await adapter.pollNow();
    assert.equal(seen.length, 1);
  } finally {
    adapter.stop();
    await new Promise(r => server.close(r));
  }
});
