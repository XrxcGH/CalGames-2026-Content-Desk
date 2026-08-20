import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CheesyClient, assertPathAllowed, assertSocketAllowed, ALLOWED_SOCKETS } from './client.ts';
import { fuelPoints, towerPoints, MatchState, MatchStatus } from './protocol.ts';
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
    rankingPoints: 34, record: '8-2-1', played: 11,
  });
  // Missing fields degrade rather than crash a pit TV.
  assert.equal(out.rankings[1]?.record, '0-0-0');
});

test('on deck skips matches that have been played', () => {
  const m = (n: number, status: number) => ({
    Match: {
      ShortName: `Q${n}`, LongName: `Qualification ${n}`, Status: status,
      Red1: 846, Red2: 1868, Red3: 253, Blue1: 100, Blue2: 115, Blue3: 670,
    },
  });

  const out = mapUpcoming([
    m(1, MatchStatus.RedWon), m(2, MatchStatus.Tie),
    m(3, MatchStatus.Scheduled), m(4, MatchStatus.Scheduled),
    m(5, MatchStatus.Scheduled), m(6, MatchStatus.Scheduled),
    m(7, MatchStatus.Scheduled), m(8, MatchStatus.Scheduled),
    m(9, MatchStatus.Scheduled), m(10, MatchStatus.Scheduled),
    m(11, MatchStatus.Scheduled), m(12, MatchStatus.Scheduled),
  ]);

  // Eight on deck: the side screens render four; the phone schedule view
  // needs the longer horizon.
  assert.deepEqual(out.map(u => u.shortName),
    ['Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10'], 'limit of eight');
  assert.deepEqual(out[0]?.red, [846, 1868, 253]);
  assert.deepEqual(out[0]?.blue, [100, 115, 670]);
});

test('an empty schedule maps to an empty deck rather than throwing', () => {
  assert.deepEqual(mapUpcoming([]), []);
  assert.deepEqual(mapRankings({}), { highestPlayedMatch: '', rankings: [] });
});

test('reports robots that have lost their driver station link', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('arenaStatus', {
    AllianceStations: {
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, Ds: { RobotLinked: false } },
      R3: { Team: { Id: 253 }, Ds: { RobotLinked: false }, Bypass: true },
      B1: { Team: null, Ds: null },
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
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: r1 } },
      R2: { Team: { Id: 1868 }, Ds: { RobotLinked: r2 } },
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
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, Ds: { RobotLinked: r2Linked } },
      R3: { Team: { Id: 253 }, Ds: { RobotLinked: false }, Bypass: true },
      B1: { Team: { Id: 100 }, Ds: { RobotLinked: true } },
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
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, Ds: null },   // nothing heard yet: unknown, not down
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
