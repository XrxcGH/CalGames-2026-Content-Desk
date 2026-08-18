/**
 * Fake Cheesy Arena: a stand-in field for rehearsing WITHOUT a field.
 *
 * Speaks the real wire protocol at the real endpoints: the display websockets
 * from `ALLOWED_SOCKETS` with `{type, data}` frames, and the GET-only REST
 * paths the adapter polls. The content desk connects to it with the SAME
 * hardened client, allowlists, backoff, and adapter it uses against the real
 * arena. Nothing is stubbed on our side of the wire.
 *
 * It drives a scripted but realistic match on a loop:
 *
 *   matchLoad -> robots link one by one (arenaStatus) -> ALL LINKED (the desk
 *   arms here, before any countdown) -> StartMatch -> AutoPeriod with auto
 *   fuel -> PausePeriod (auto winner decided on fuel) -> TeleopPeriod with
 *   alternating hub shifts via ActiveRemainingSec -> endgame tower climbs ->
 *   PostMatch -> scorePosted with bonus RPs -> field reset -> next match.
 *
 *   node --experimental-strip-types apps/core/src/ingest/cheesy/fake-arena.ts \
 *     [--port 8091] [--speed 4]
 *
 * `--speed 4` compresses the 160s match into ~40s so a full validation pass
 * doesn't take an afternoon. Timing scales; the message sequence never does.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MatchState } from './protocol.ts';
import { ALLOWED_SOCKETS } from './client.ts';

// Sourced from the client's own allowlist rather than a second hand-copied
// list: the whole point of the fake arena is validating against the real
// protocol surface, so if the allowlist ever changes, this must move with it
// instead of silently drifting into testing a stale set of endpoints.
const SOCKET_PATHS: readonly string[] = ALLOWED_SOCKETS;

// Real Cheesy fans each notifier out only on the endpoints that carry it (the
// docs/10 endpoint table). This used to broadcast every notifier to every
// socket, so the desk, which subscribes to all six, ingested six copies of
// every frame: six match.loaded per load and sixfold robot_down markers,
// none of which happens against a real field.
const ROUTES: Record<string, readonly string[]> = {
  matchLoad: ['/api/arena/websocket', '/displays/audience/websocket'],
  matchTime: ['/api/arena/websocket', '/displays/audience/websocket'],
  realtimeScore: ['/displays/audience/websocket'],
  scorePosted: ['/displays/audience/websocket'],
  allianceSelection: ['/displays/audience/websocket'],
  arenaStatus: ['/displays/field_monitor/websocket'],
};

const TEAMS = {
  R1: { Id: 846, Nickname: 'The Funky Monkeys' },
  R2: { Id: 1868, Nickname: 'Space Cookies' },
  R3: { Id: 253, Nickname: 'Boba Bots' },
  B1: { Id: 100, Nickname: 'The Wildhats' },
  B2: { Id: 115, Nickname: 'MVRT' },
  B3: { Id: 670, Nickname: 'Homestead Robotics' },
} as const;

const RANKINGS = {
  HighestPlayedMatch: 'Q41',
  Rankings: [
    { Rank: 1, PreviousRank: 1, TeamId: 254, Nickname: 'The Cheesy Poofs', RankingPoints: 38, Wins: 10, Losses: 1, Ties: 0, Played: 11 },
    { Rank: 2, PreviousRank: 3, TeamId: 846, Nickname: 'The Funky Monkeys', RankingPoints: 34, Wins: 8, Losses: 2, Ties: 1, Played: 11 },
    { Rank: 3, PreviousRank: 2, TeamId: 1678, Nickname: 'Citrus Circuits', RankingPoints: 33, Wins: 8, Losses: 3, Ties: 0, Played: 11 },
    { Rank: 4, PreviousRank: 5, TeamId: 1868, Nickname: 'Space Cookies', RankingPoints: 31, Wins: 7, Losses: 3, Ties: 1, Played: 11 },
    { Rank: 5, PreviousRank: 4, TeamId: 100, Nickname: 'The Wildhats', RankingPoints: 29, Wins: 7, Losses: 4, Ties: 0, Played: 11 },
    { Rank: 6, PreviousRank: 6, TeamId: 115, Nickname: 'MVRT', RankingPoints: 27, Wins: 6, Losses: 5, Ties: 0, Played: 11 },
    { Rank: 7, PreviousRank: 8, TeamId: 670, Nickname: 'Homestead Robotics', RankingPoints: 25, Wins: 6, Losses: 5, Ties: 0, Played: 11 },
    { Rank: 8, PreviousRank: 7, TeamId: 253, Nickname: 'Boba Bots', RankingPoints: 24, Wins: 5, Losses: 6, Ties: 0, Played: 11 },
    { Rank: 9, PreviousRank: 9, TeamId: 5940, Nickname: 'BREAD', RankingPoints: 22, Wins: 5, Losses: 6, Ties: 0, Played: 11 },
    { Rank: 10, PreviousRank: 11, TeamId: 649, Nickname: 'M-SET Fish', RankingPoints: 20, Wins: 4, Losses: 7, Ties: 0, Played: 11 },
    { Rank: 11, PreviousRank: 10, TeamId: 8033, Nickname: 'Highlander Robotics', RankingPoints: 19, Wins: 4, Losses: 7, Ties: 0, Played: 11 },
    { Rank: 12, PreviousRank: 12, TeamId: 199, Nickname: 'Deep Blue', RankingPoints: 17, Wins: 3, Losses: 8, Ties: 0, Played: 11 },
  ],
};

const SCHEDULE = [
  { Match: { ShortName: 'Q43', LongName: 'Qualification 43', Status: 0, Red1: 254, Red2: 5940, Red3: 199, Blue1: 1678, Blue2: 649, Blue3: 8033 } },
  { Match: { ShortName: 'Q44', LongName: 'Qualification 44', Status: 0, Red1: 846, Red2: 100, Red3: 649, Blue1: 253, Blue2: 115, Blue3: 5940 } },
  { Match: { ShortName: 'Q45', LongName: 'Qualification 45', Status: 0, Red1: 1868, Red2: 8033, Red3: 254, Blue1: 670, Blue2: 199, Blue3: 1678 } },
  { Match: { ShortName: 'Q46', LongName: 'Qualification 46', Status: 0, Red1: 115, Red2: 253, Red3: 846, Blue1: 100, Blue2: 670, Blue3: 1868 } },
];

export interface FakeArenaOpts {
  port: number;
  /** 1 = real match timing; 4 = a 160s match in ~40s. */
  speed?: number;
  log?: (line: string) => void;
}

export function startFakeArena(opts: FakeArenaOpts) {
  const speed = opts.speed ?? 1;
  const log = opts.log ?? (line => console.log(`[fake-arena] ${line}`));
  const ms = (realMs: number): number => Math.max(20, realMs / speed);

  // Socket -> the path it upgraded on, because delivery is routed per path.
  const sockets = new Map<WebSocket, string>();
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const json = (body: unknown): void => {
      const b = JSON.stringify(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(b);
    };
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/api/rankings') return json(RANKINGS);
    if (path === '/api/matches/qualification') return json(SCHEDULE);
    // The scripted event never reaches Sunday. An empty list is what a real
    // arena serves before the bracket exists, and the desk polls this type.
    if (path === '/api/matches/playoff') return json([]);
    res.writeHead(404).end('fake-arena: not found');
  });

  // Latest frame per notifier. Real Cheesy sends each notifier's current
  // payload the moment a display subscribes, so a desk that boots mid-match
  // still knows who is on the field. The fake must do the same.
  const latest = new Map<string, unknown>();
  const REPLAY_ORDER = ['matchLoad', 'matchTime', 'arenaStatus', 'realtimeScore'];

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!SOCKET_PATHS.includes(path)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.set(ws, path);
      for (const type of REPLAY_ORDER) {
        // Replay only what this endpoint carries on a real arena: the
        // rankings socket never delivers a matchLoad, so neither does this.
        if (!(ROUTES[type] ?? []).includes(path)) continue;
        if (latest.has(type)) ws.send(JSON.stringify({ type, data: latest.get(type) }));
      }
      ws.on('close', () => sockets.delete(ws));
      // The real endpoints are HandleNotifiers-only: they never read. If the
      // desk ever SENDS an application frame, that is an allowlist breach:
      // make the rehearsal fail loudly rather than mask it.
      ws.on('message', () => {
        log(`ERROR: received a frame from the desk on ${path}, the bridge must never write`);
        process.exitCode = 2;
      });
    });
  });

  const send = (type: string, data: unknown): void => {
    latest.set(type, data);
    const routes = ROUTES[type];
    if (!routes) {
      // A notifier nobody routed would vanish silently; fail the rehearsal
      // loudly instead so the routing table gets extended with the script.
      log(`ERROR: no endpoint route for notifier "${type}"`);
      process.exitCode = 2;
      return;
    }
    const frame = JSON.stringify({ type, data });
    for (const [ws, wsPath] of sockets) {
      if (routes.includes(wsPath) && ws.readyState === ws.OPEN) ws.send(frame);
    }
  };

  const at = (realMs: number, fn: () => void): void => {
    const t = setTimeout(() => { timers.delete(t); if (!stopped) fn(); }, ms(realMs));
    timers.add(t);
  };

  // ---- one scripted match -------------------------------------------------
  let matchNumber = 42;

  const stations = (linked: number) => {
    const order = ['R1', 'R2', 'R3', 'B1', 'B2', 'B3'] as const;
    const out: Record<string, unknown> = {};
    order.forEach((key, i) => {
      out[key] = {
        Team: TEAMS[key],
        Ds: { RobotLinked: i < linked, DsLinked: i < linked },
        Bypass: false,
      };
    });
    return out;
  };

  const summary = (autoFuel: number, teleFuel: number, autoTower: number, teleTower: number, fouls: number) => ({
    AutoFuelPoints: autoFuel,
    TeleopFuelPoints: teleFuel,
    AutoTowerPoints: autoTower,
    TeleopTowerPoints: teleTower,
    FoulPoints: fouls,
    MatchPoints: autoFuel + teleFuel + autoTower + teleTower,
    Score: autoFuel + teleFuel + autoTower + teleTower + fouls,
  });

  function runMatch(): void {
    if (stopped) return;
    const name = `Qualification ${matchNumber}`;
    log(`loading ${name}`);

    // t=0: scorekeeper loads the match. Field state resets to PreMatch.
    send('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
    send('matchLoad', {
      Match: {
        Id: matchNumber, Type: 'qualification', TypeOrder: matchNumber,
        LongName: name, ShortName: `Q${matchNumber}`,
        Red1: 846, Red2: 1868, Red3: 253, Blue1: 100, Blue2: 115, Blue3: 670,
      },
      Teams: TEAMS,
      Rankings: { '846': 2, '1868': 4, '253': 8, '100': 5, '115': 6, '670': 7 },
    });

    // Robots link up one at a time over ~9s. The desk must arm only when the
    // LAST one links: that moment precedes the announcer's countdown.
    for (let linked = 1; linked <= 6; linked++) {
      at(1500 * linked, () => send('arenaStatus', {
        MatchId: matchNumber,
        AllianceStations: stations(linked),
        MatchState: MatchState.PreMatch,
        PlcIsHealthy: true, FieldEStop: false, IsFtaReady: linked === 6,
      }));
    }

    // ~8s of announcer countdown after the field goes green, then start.
    const T0 = 9000 + 8000;                       // wall start of AUTO
    at(T0, () => {
      log('match start');
      send('matchTime', { MatchState: MatchState.StartMatch, MatchTimeSec: 0 });
      send('matchTime', { MatchState: MatchState.AutoPeriod, MatchTimeSec: 0 });
    });

    // AUTO, 20s: both hubs live. Blue out-fuels red 9-4 (auto winner: blue,
    // decided on fuel alone, so a red climb must not flip it).
    const autoScore = [
      { t: 6000, red: [1, 0], blue: [3, 0] },
      { t: 12000, red: [3, 0], blue: [6, 0] },
      { t: 18000, red: [4, 15], blue: [9, 0] },   // red climbs for 15 auto tower
    ];
    for (const step of autoScore) {
      at(T0 + step.t, () => send('realtimeScore', {
        MatchState: MatchState.AutoPeriod,
        Red: { ScoreSummary: summary(step.red[0]!, 0, step.red[1]!, 0, 0), ActiveRemainingSec: 20, ActiveDurationSec: 20 },
        Blue: { ScoreSummary: summary(step.blue[0]!, 0, step.blue[1]!, 0, 0), ActiveRemainingSec: 20, ActiveDurationSec: 20 },
      }));
    }

    // Transition pause, then teleop: four 25s shifts. Odd shifts belong to the
    // auto LOSER (red here), even shifts to the winner. Hub state rides on
    // ActiveRemainingSec, exactly like the real field.
    const T_TELE = T0 + 20_000 + 2_000;
    at(T0 + 20_500, () => send('matchTime', { MatchState: MatchState.PausePeriod, MatchTimeSec: 20 }));
    at(T_TELE, () => send('matchTime', { MatchState: MatchState.TeleopPeriod, MatchTimeSec: 22 }));

    let redFuel = 4, blueFuel = 9;
    let redTower = 15, blueTower = 0;
    // Shift plan: [shift index, hub owner]. 10s of transition, then 4x25s,
    // then a FULL 30s endgame, REBUILT's real length. A 10s endgame here
    // buzzed at match clock ~120 while every clock-derived surface still
    // showed 0:20 remaining, which made rehearsals distrust the clock.
    const shiftOwner = ['red', 'blue', 'red', 'blue'] as const;
    for (let tick = 0; tick < 26; tick++) {
      const t = T_TELE + 10_000 + tick * 5_000;   // every 5s of the 130s shifts+endgame
      at(t, () => {
        const elapsed = tick * 5;                  // seconds since shifts began
        const shift = Math.min(3, Math.floor(elapsed / 25));
        const owner = elapsed < 100 ? shiftOwner[shift]! : 'both';   // endgame: both
        const remaining = elapsed < 100 ? 25 - (elapsed % 25) : 0;

        // Rates chosen so both alliances clear the 100-fuel Energized line in
        // their ~12 active ticks: red 4+9x12=112, blue 9+8x12=105.
        if (owner === 'red' || owner === 'both') redFuel += 9;
        if (owner === 'blue' || owner === 'both') blueFuel += 8;
        // Endgame climbs: red L3 (30), blue L2+L3 (50); blue earns Traversal.
        if (elapsed >= 100) {
          if (redTower < 45) redTower += 15;
          if (blueTower < 50) blueTower += 25;
        }

        send('realtimeScore', {
          MatchState: MatchState.TeleopPeriod,
          Red: {
            ScoreSummary: summary(4, redFuel - 4, 15, redTower - 15, 0),
            ActiveRemainingSec: owner === 'red' || owner === 'both' ? remaining || 20 : 0,
            ActiveDurationSec: 25,
          },
          Blue: {
            ScoreSummary: summary(9, blueFuel - 9, 0, blueTower, 0),
            ActiveRemainingSec: owner === 'blue' || owner === 'both' ? remaining || 20 : 0,
            ActiveDurationSec: 25,
          },
        });
      });
    }

    // Buzzer at T_TELE + 140s (10 transition + 4x25 shifts + 30s endgame).
    const T_END = T_TELE + 140_000;
    at(T_END, () => {
      log('match end');
      send('matchTime', { MatchState: MatchState.PostMatch, MatchTimeSec: 160 });
      send('realtimeScore', {
        MatchState: MatchState.PostMatch,
        Red: { ScoreSummary: summary(4, redFuel - 4, 15, redTower - 15, 0), ActiveRemainingSec: 0 },
        Blue: { ScoreSummary: summary(9, blueFuel - 9, 0, blueTower, 0), ActiveRemainingSec: 0 },
      });
    });

    // Referees deliberate ~8s, then the score posts with bonus RPs.
    at(T_END + 8_000, () => {
      log('score posted');
      send('scorePosted', {
        MatchType: 'qualification',
        Match: { Id: matchNumber, LongName: name, ShortName: `Q${matchNumber}` },
        RedScoreSummary: {
          ...summary(4, redFuel - 4, 15, redTower - 15, 0),
          EnergizedBonusRankingPoint: redFuel >= 100,
          SuperchargedBonusRankingPoint: redFuel >= 360,
          TraversalBonusRankingPoint: redTower >= 50,
        },
        BlueScoreSummary: {
          ...summary(9, blueFuel - 9, 0, blueTower, 0),
          EnergizedBonusRankingPoint: blueFuel >= 100,
          SuperchargedBonusRankingPoint: blueFuel >= 360,
          TraversalBonusRankingPoint: blueTower >= 50,
        },
        RedRankingPoints: (redFuel + redTower > blueFuel + blueTower ? 3 : 0) + (redFuel >= 100 ? 1 : 0) + (redTower >= 50 ? 1 : 0),
        BlueRankingPoints: (blueFuel + blueTower > redFuel + redTower ? 3 : 0) + (blueFuel >= 100 ? 1 : 0) + (blueTower >= 50 ? 1 : 0),
      });
    });

    // Field reset, next match.
    at(T_END + 16_000, () => {
      send('matchTime', { MatchState: MatchState.PreMatch, MatchTimeSec: 0 });
      matchNumber++;
      runMatch();
    });
  }

  // Loopback explicitly: a host-less listen() binds every interface, and a
  // rehearsal box plugged into the venue network must not be reachable from it.
  http.listen(opts.port, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${opts.port} at ${speed}x speed`);
    runMatch();
  });

  return {
    close(): void {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const ws of sockets.keys()) ws.close();
      wss.close();
      http.close();
    },
  };
}

// ---- CLI --------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  startFakeArena({
    port: Number(arg('port') ?? 8091),
    speed: Number(arg('speed') ?? 1),
  });
}
