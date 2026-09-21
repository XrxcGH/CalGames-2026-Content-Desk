/**
 * Local validation harness. Acts as the SCOREKEEPER and REFEREE against a dev
 * Cheesy Arena so a real match runs with real scoring, and the content desk
 * bridge can be observed end to end.
 *
 * The bridge itself never touches these control endpoints. This is a separate
 * client standing in for the volunteers who would normally drive them.
 *
 * IT WRITES TO THE ARENA. It refuses to run unless it is pointed at loopback
 * and armed with an explicit flag, and it is held out of the volunteer payload
 * by tools/launcher/build.ps1. Never run it against an event arena.
 *
 *   node harness.mjs --drive-a-dev-arena
 */
import { WebSocket } from 'ws';

const ARENA = process.env.ARENA ?? 'localhost:8080';

/*
 * This script WRITES to Cheesy Arena. It bypasses stations, starts the match,
 * injects scoring and commits a result into the event database and the
 * rankings. It exists to drive a `cheesy-arena -dev` build on this machine so
 * the bridge can be watched end to end, and the content desk's own bridge
 * never touches any of these endpoints.
 *
 * Two guards, because the failure is unrecoverable and the instruction to run
 * it used to sit on an event-day checklist. It refuses unless it is pointed at
 * loopback, and refuses unless a human typed a flag that cannot be arrived at
 * by accident. A crew member on the field network who runs `node harness.mjs`
 * now gets a paragraph instead of a fabricated Qualification result.
 */
const HOST = ARENA.replace(/^\w+:\/\//, '').split(':')[0].toLowerCase();
const LOOPBACK = HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '::1'
  || HOST === '[::1]';
const ARMED = process.argv.includes('--drive-a-dev-arena');
if (!LOOPBACK || !ARMED) {
  console.error(`
This is not a test client. It drives Cheesy Arena as the scorekeeper and the
referees: it bypasses all six stations, starts the match, injects scoring, and
commits a result into the event database and the rankings.

  ARENA is "${ARENA}" (host "${HOST}") -> ${LOOPBACK ? 'loopback, ok' : 'REFUSED: not loopback'}
  --drive-a-dev-arena              -> ${ARMED ? 'given' : 'REFUSED: not given'}

Run it only against a cheesy-arena -dev build on this machine:

  node harness.mjs --drive-a-dev-arena

To watch the desk's bridge with no arena at all, which is what you almost
certainly want at an event:

  npm run fake-arena
`);
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = url => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const send = (ws, type, data) => ws.send(JSON.stringify({ type, data }));

const play = await open(`ws://${ARENA}/match_play/websocket`);
play.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.type === 'error') console.log('ARENA ERROR:', JSON.stringify(m.data));
});

// Scoring panels. The 2026 build uses plain "red"/"blue" positions, not the
// older near/far split.
const redScore = await open(`ws://${ARENA}/panels/scoring/red/websocket`);
const blueScore = await open(`ws://${ARENA}/panels/scoring/blue/websocket`);
console.log('harness connected');

for (const s of ['R1', 'R2', 'R3', 'B1', 'B2', 'B3']) {
  send(play, 'toggleBypass', s);
  await sleep(150);
}
await sleep(800);

send(play, 'startMatch', { MuteMatchSounds: true });
console.log('match started', new Date().toISOString());

// Auto: red climbs, which should give red the auto win.
await sleep(6000);
send(redScore, 'autoTower', { TeamPosition: 1, AutoTowerStatus: 1 });
console.log('auto: red 1 climbs');

// Teleop climbs so tower points move mid-match.
await sleep(30_000);
send(blueScore, 'endgame', { TeamPosition: 1, EndgameTowerStatus: 2 });
console.log('teleop: blue 1 climbs L2');

await sleep(40_000);
send(redScore, 'endgame', { TeamPosition: 2, EndgameTowerStatus: 3 });
console.log('teleop: red 2 climbs L3');

// Run out the match, then commit the results.
await sleep(100_000);
console.log('committing results');
send(play, 'commitAndPost', {});
await sleep(4000);
console.log('harness done');
process.exit(0);
