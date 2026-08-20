/**
 * Render every screen to previews/, one PNG per page.
 *
 *   npm run previews
 *
 * What this is for: showing somebody what the desk looks like without setting
 * one up. A folder of PNGs can go in a planning meeting, a sponsor deck, or a
 * message to a volunteer who is deciding whether to help. Nobody is going to
 * clone a repo to see whether the graphics are any good.
 *
 * How it works: boot a desk on a spare port, drive it into each state over the
 * same WebSocket the consoles use, and screenshot with headless Chrome. That
 * means these are REAL renders of the real surfaces, not mockups that drift
 * from the code the week after they are made.
 *
 * Re-run it after changing anything visual. It is deliberately one command
 * with no arguments, because a step that needs remembering is a step that
 * stops happening.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'previews');
const PORT = 8791;
const PIN = '0864';
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

/** Chrome, wherever this machine keeps it. */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  throw new Error('No Chrome or Edge found. Previews need one of them installed.');
}

/**
 * A shot: which page, at what size, after putting the desk into some state.
 *
 * `setup` runs before the screenshot and gets an `emit` for bus events. The
 * desk is left in whatever state the previous shot put it in, so shots are
 * ordered deliberately: the pre-match overview before the match, the match
 * before the final score.
 */
const TEAMS = {
  red: [
    { number: 846, name: 'The Funky Monkeys' },
    { number: 1868, name: 'Space Cookies' },
    { number: 253, name: 'Raid Zero' },
  ],
  blue: [
    { number: 971, name: 'Spartan Robotics' },
    { number: 100, name: 'The WildHats' },
    { number: 670, name: 'Nemesis' },
  ],
};

const loadMatch = emit => emit({
  type: 'match.loaded', source: 'cheesy',
  payload: { id: 'q12', displayName: 'Qualification 12', ...TEAMS },
});

const someScore = emit => emit({
  type: 'score.realtime', source: 'cheesy',
  payload: {
    red: { autoFuel: 40, teleopFuel: 74, autoTower: 0, teleopTower: 30, fouls: 0 },
    blue: { autoFuel: 30, teleopFuel: 61, autoTower: 15, teleopTower: 20, fouls: 5 },
  },
});

const rankings = emit => emit({
  type: 'rankings.updated', source: 'cheesy',
  payload: {
    rankings: [
      { rank: 1, previousRank: 2, team: 254, name: 'The Cheesy Poofs', rankingPoints: 34, record: '9-1-0', played: 10 },
      { rank: 2, previousRank: 1, team: 846, name: 'The Funky Monkeys', rankingPoints: 31, record: '8-2-0', played: 10 },
      { rank: 3, previousRank: 4, team: 971, name: 'Spartan Robotics', rankingPoints: 30, record: '8-2-0', played: 10 },
      { rank: 4, previousRank: 3, team: 1868, name: 'Space Cookies', rankingPoints: 28, record: '7-3-0', played: 10 },
      { rank: 5, previousRank: 6, team: 100, name: 'The WildHats', rankingPoints: 25, record: '6-4-0', played: 10 },
      { rank: 6, previousRank: 5, team: 670, name: 'Nemesis', rankingPoints: 24, record: '6-4-0', played: 10 },
    ],
  },
});

const upcoming = emit => emit({
  type: 'queue.updated', source: 'nexus', confidence: 'derived',
  payload: {
    nowQueuing: 'Qualification 13',
    upcoming: [
      { name: 'Qualification 13', shortName: 'Q13', time: null, red: [254, 8, 604], blue: [1678, 199, 5] },
      { name: 'Qualification 14', shortName: 'Q14', time: null, red: [846, 971, 100], blue: [1868, 253, 670] },
    ],
  },
});

const SHOTS = [
  // ---- program overlay, one per screen ----
  {
    name: 'program-alliance-overview',
    url: '/s/program',
    note: 'Pre-match: the RSN-style alliance overview with robot cutouts.',
    setup: emit => {
      loadMatch(emit);
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'overview' } });
    },
  },
  {
    name: 'program-match-scorebug',
    url: '/s/program',
    note: 'Live match: score bar, clock, hub indicator, RP thresholds.',
    setup: emit => {
      emit({ type: 'match.start', source: 'cheesy' });
      someScore(emit);
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'match' } });
    },
  },
  {
    name: 'program-match-cards',
    url: '/s/program',
    note: 'The same bar with a red card, a carried yellow and a surrogate marked.',
    setup: emit => {
      emit({ type: 'card.issued', source: 'cheesy', payload: { team: 846, card: 'red', alliance: 'red' } });
      emit({ type: 'card.issued', source: 'cheesy', payload: { team: 1868, card: 'yellow', alliance: 'red' } });
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'match' } });
    },
  },
  {
    name: 'program-card-call',
    url: '/s/program',
    note: 'The card call: what the announcer talks over before the score.',
    setup: emit => emit({
      type: 'card.call', source: 'manual',
      payload: {
        team: 846, color: 'red', alliance: 'red',
        reason: 'Repeated contact inside the protected zone',
      },
    }),
  },
  {
    name: 'program-final-score',
    url: '/s/program',
    note: 'Final score, with the breakdown, RP badges and any cards issued.',
    setup: emit => {
      emit({ type: 'card.call_clear', source: 'manual', payload: {} });
      emit({ type: 'match.end', source: 'cheesy' });
      emit({ type: 'match.score_posted', source: 'cheesy', payload: {} });
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'score' } });
    },
  },
  {
    name: 'program-analysis-panel',
    url: '/s/program',
    note: 'Analysis segment: one card per person, in screen order. The two ' +
      'students are marked as such at the desk, so their cards carry a given ' +
      'name and a family initial.',
    // Through the real route rather than a hand-built event, because the name
    // shortening happens in the profile book and a hand-built panel.show would
    // render a picture of a code path nobody uses.
    setup: async emit => {
      await post('/api/panel', {
        title: 'Match preview',
        people: [
          { name: 'Priya Raman', role: 'Analyst' },
          { name: 'Marcus Webb', role: 'Play-by-play' },
          { name: 'Dana Okafor', role: 'Drive coach', team: 254 },
          { name: 'Alex Rivera', role: 'Driver', team: 846, student: true },
          { name: 'Sofia Delgado', role: 'Human player', team: 846, student: true },
        ],
      });
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'analysis' } });
    },
  },
  {
    name: 'program-award-reveal',
    url: '/s/program',
    note: 'The awards ceremony at the reveal: title, definition, winner. ' +
      'Until the reveal button, the winner exists nowhere the audience can read.',
    setup: async () => {
      await post('/api/awards', {
        action: 'show',
        title: "Directors' Award",
        description: 'For the team that best embodies the spirit of CalGames: ' +
          'competitive on the field, generous everywhere else.',
        winner: 'The Funky Monkeys', team: 846,
      });
      await post('/api/awards', { action: 'reveal' });
    },
  },
  {
    name: 'program-recognition-slide',
    url: '/s/program',
    note: 'A recognition slide on the program. The side screens rotate the ' +
      'same deck ambiently; this is the desk deliberately taking one to air.',
    setup: async () => {
      await post('/api/awards', { action: 'clear' });
      const slide = await post('/api/slides', {
        action: 'add', kind: 'recognition', title: 'Thank you, setup crew',
        lines: ['Friday load-in and field build', 'Ana · Ben · Cy · Dee · the WRRF interns'],
      });
      await post('/api/slides', { action: 'show', id: slide.id });
    },
  },
  {
    name: 'side-screen-timer',
    url: '/s/side',
    note: 'The event timer taking over a side screen: field setup, meetings, ' +
      'doors. Turn one TV to face the field and that is the committee ask met.',
    setup: async () => {
      await post('/api/slides', { action: 'hide' });
      await post('/api/timer', { label: 'Field setup', seconds: 96 });
    },
  },
  {
    name: 'testcard',
    url: '/s/testcard',
    note: 'The AV test pattern for installing any display: crop wedges, the ' +
      'broadcast safe areas, a stretch circle, brand and gray ramps, a live ' +
      'clock. Built for the committee’s LED-wall row.',
  },
  {
    name: 'phone-gp-shoutout',
    url: '/s/gp',
    width: 430, height: 932,
    note: 'The Gracious Professionalism shout-out form. Everything submitted ' +
      'goes through a human moderator at the desk before any screen sees it.',
    setup: async () => {
      await post('/api/timer', { clear: true });
    },
  },
  {
    name: 'program-alliance-selection',
    url: '/s/program',
    note: 'Alliance selection, mirrored from the field, with the pick clock.',
    setup: emit => {
      emit({
        type: 'alliance_selection.update', source: 'cheesy',
        payload: {
          alliances: [
            { id: 1, teams: [254, 846, 971] },
            { id: 2, teams: [1678, 1868] },
            { id: 3, teams: [604] },
            { id: 4, teams: [8] },
          ],
          ranked: [
            { rank: 1, team: 254, picked: true }, { rank: 2, team: 846, picked: true },
            { rank: 3, team: 971, picked: true }, { rank: 4, team: 1678, picked: true },
            { rank: 5, team: 1868, picked: true }, { rank: 6, team: 604, picked: true },
            { rank: 7, team: 8, picked: true }, { rank: 8, team: 100, picked: false },
            { rank: 9, team: 670, picked: false }, { rank: 10, team: 253, picked: false },
            { rank: 11, team: 199, picked: false }, { rank: 12, team: 5, picked: false },
          ],
          showTimer: true, timeRemainingSec: 42, updatedAt: Date.now(),
        },
      });
      emit({ type: 'screen.change', source: 'manual', payload: { screen: 'selection' } });
    },
  },
  {
    name: 'program-explainer',
    url: '/s/program',
    note: 'The explainer loop, for the parent who arrived twenty minutes ago.',
    setup: emit => emit({ type: 'screen.change', source: 'manual', payload: { screen: 'explain' } }),
  },
  {
    name: 'program-arcade-bumper',
    url: '/s/program',
    note: 'The bumper while the switcher moves to the console capture.',
    setup: emit => emit({ type: 'screen.change', source: 'manual', payload: { screen: 'arcade' } }),
  },
  {
    name: 'program-safety-message',
    url: '/s/program',
    note: 'A safety message: covers the frame, latches until cleared.',
    setup: emit => emit({
      type: 'emergency.raise', source: 'manual',
      payload: {
        kind: 'evacuate',
        message: 'Leave the gym by the north doors',
        detail: 'Muster on the practice field',
      },
    }),
  },

  // ---- the other on-air surfaces ----
  {
    name: 'side-screen-on-deck',
    url: '/s/side',
    note: 'Venue TVs: who is up, who is being called, drift-adjusted times.',
    setup: emit => {
      emit({ type: 'emergency.clear', source: 'manual', payload: {} });
      upcoming(emit);
      rankings(emit);
    },
  },
  {
    name: 'arcade-overlay',
    url: '/s/arcade',
    note: 'The side tournament: a versus set and the grand prix standings.',
    api: [
      ['/api/arcade/set', { game: 'smash', round: 'Winners Final', bestOf: 5,
        players: [{ id: 'a', name: 'Ana', team: '846' }, { id: 'b', name: 'Ben', team: '1868' }] }],
      ['/api/arcade/score', { player: 0, delta: 2 }],
      ['/api/arcade/gp', { name: 'Pit Crew Cup', raceCount: 4, racers: [
        { id: 'a', name: 'Ana', team: '846' }, { id: 'b', name: 'Ben', team: '1868' },
        { id: 'c', name: 'Cy', team: '254' }, { id: 'd', name: 'Dee' }] }],
      ['/api/arcade/race', { order: ['a', 'b', 'c', 'd'] }],
      ['/api/arcade/upnext', { text: 'Grand Final · 1678 vs 254' }],
    ],
  },
  {
    name: 'trivia-overlay',
    url: '/s/trivia',
    note: 'Crowd trivia on the big screen: question, countdown, join code.',
    api: [
      ['/api/trivia/session', { name: 'Round 3 · WRRF and CalGames' }],
      ['/api/trivia/open', { seconds: 20 }],
    ],
  },
  {
    name: 'telestrator-render',
    url: '/s/tele',
    note: 'The analyst\'s ink, transparent, layered over the replay in OBS. '
      + 'Mostly empty by design: it is a layer, and the ink is drawn live.',
    setup: emit => emit({
      // Without an analyst there is genuinely nothing on this layer, and a
      // blank tile in a gallery reads as a broken render rather than as a
      // transparent overlay doing its job.
      type: 'telestrator.frame', source: 'manual',
      payload: { analyst: 'Priya Raman', frame: null },
    }),
  },

  // ---- audience phone pages ----
  { name: 'phone-when-do-we-play', url: '/s/next', width: 430, height: 932,
    note: 'The phone page: per-team schedule with honest start estimates.' },
  { name: 'phone-trivia-play', url: '/s/quiz', width: 430, height: 932,
    note: 'What the crowd plays trivia on.' },

  // ---- operator consoles ----
  { name: 'console-desk', url: '/s/desk', auth: true, height: 2200,
    note: 'The main desk console: everything, keyboard-first.' },
  { name: 'console-talent', url: '/s/talent', auth: true, height: 1400,
    note: 'The announcer tablet: ranks, RP in words, cards, pronunciation notes.' },
  { name: 'console-replay', url: '/s/replay', auth: true, height: 1400,
    note: 'Replay: match-clock timeline, auto markers, cut and send.' },
  { name: 'console-telestrator-pad', url: '/s/draw', auth: true,
    note: 'The analyst draws here, on the frame the audience is seeing.' },
  { name: 'console-arcade', url: '/s/arcadedesk', auth: true, height: 1600,
    note: 'Scoring the side tournament by hand.' },
  { name: 'console-trivia-host', url: '/s/triviadesk', auth: true, height: 1800,
    note: 'Running the crowd game: rounds, open, reveal, next.' },
  { name: 'console-house-audio', url: '/s/house', auth: true,
    note: 'The music machine: walk-ups, stingers, the playlist.' },
  { name: 'console-referee-review', url: '/s/var', auth: true, height: 1200,
    note: 'Head referee frame-step. Read-only: no cut, no air, no publish.' },
  { name: 'console-team-media', url: '/s/media', auth: true, height: 1200,
    note: 'Robot cutout uploads for the alliance overview.' },
  { name: 'console-post-match-cards', url: '/s/cards', auth: true, height: 1400,
    note: '1080x1080 result graphics, built when a score posts.' },
  { name: 'phone-remote', url: '/s/remote', auth: true, width: 430, height: 1400,
    note: 'Run the show from a phone: screens, cameras, music, cues.' },
  { name: 'index', url: '/', note: 'The page every screen is picked from.' },
];

// ---------------------------------------------------------------------------

async function main() {
  const chrome = findChrome();
  console.log(`[previews] chrome: ${chrome}`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Every file the photographed desk will write to, put back afterwards.
  //
  // This desk runs against the REAL data directory (ROOT is fixed in
  // index.ts), so a render posts its fixture people into the operator's
  // profile book and its fixture question into their trivia bank. Rendering
  // the site's own screenshots must not edit the event's live state, and a
  // volunteer who runs this the morning of the event should not find five
  // people who do not exist ticked into their on-camera list.
  const restore = await snapshot([
    join(ROOT, 'data', 'profiles.json'),
    join(ROOT, 'data', 'trivia.json'),
    // The publish queue too, and this one bites hardest. The shots emit a
    // whole match lifecycle, auto-queueing is on by default, so a render
    // persisted a held "Qualification 12". The queue refuses a second
    // item with the same label, so the event's REAL Qualification 12 would
    // silently never be queued. A volunteer re-rendering previews on Saturday
    // morning, exactly as the README tells them to, would lose that match's
    // video with nothing anywhere reporting it.
    join(ROOT, 'data', 'publish-queue.json'),
    // The slide deck and shout-out queue: the render adds fixtures to both.
    join(ROOT, 'data', 'slides.json'),
    // Desk-edited event content: nothing in the render edits it today, but
    // the fixture desk and the operator's desk share this file, and the
    // snapshot costs nothing.
    join(ROOT, 'data', 'event-content.json'),
  ]);
  // The event log too, and snapshot() cannot cover it: the desk opens a NEW
  // file per boot, named for the moment it started, so there is nothing to
  // back up in advance. The render emits a whole fixture match into it, and
  // rebuild.ts replays today's logs at the next boot, so a preview run left a
  // match nobody played in the card ledger, the coverage report and the run of
  // show. Note what to remove rather than what to keep.
  const sweepFixtureLog = fixtureLogSweeper(join(ROOT, 'data', 'events'));

  const restoreNow = restoreOnExit(() => { restore(); sweepFixtureLog(); });

  // Started with the gate explicitly OFF. That is the documented escape hatch
  // (an empty REMOTE_PIN, see access.ts) and it is the right tool here: this
  // desk lives for thirty seconds, binds a spare port on this machine, and
  // exists only to be photographed. The alternative is teaching headless
  // Chrome to carry a session cookie, which it has no flag for.
  const desk = spawn(process.execPath, [
    '--experimental-strip-types', 'apps/core/src/index.ts',
    '--port', String(PORT),
  ], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      REMOTE_PIN: '',
      // Loopback, explicitly. The desk defaults to 0.0.0.0, so an ungated
      // full-control desk was reachable from the venue LAN for the length of
      // every render. The comment above claimed it merely "binds a spare
      // port on this machine", which 0.0.0.0 is not.
      HOST: '127.0.0.1',
      // An empty JA_PIN collapses the Judge Advisor tier the same way the
      // empty REMOTE_PIN collapses the desk gate: this desk exists only to
      // be photographed, and the award shot has to be able to drive a reveal.
      JA_PIN: '',
    },
  });
  desk.stdout.on('data', () => {});
  desk.stderr.on('data', d => process.stderr.write(`[desk] ${d}`));

  try {
    await waitForDesk();
    const cookie = null;
    const emit = await openSocket();

    for (const shot of SHOTS) {
      if (shot.setup) await shot.setup(emit);
      for (const [path, body] of shot.api ?? []) await post(path, body);
      // Let the state land and any entrance animation settle.
      await sleep(700);
      await capture(chrome, shot, cookie);
      console.log(`[previews] ${shot.name}`);
    }

    await writeIndex();
    console.log(`[previews] ${SHOTS.length} renders in previews/`);
  } finally {
    desk.kill();
    // After the kill, not before: the desk saves on the way down.
    await sleep(400);
    restoreNow();
  }
}

/**
 * Copy some files aside and hand back the function that puts them back.
 *
 * A file that did not exist is restored by being deleted again, which is the
 * common case on a fresh clone and the one worth getting right: leaving an
 * empty profile book behind would make the next `git status` look like the
 * render had changed something.
 */
/**
 * Put the files back on the ways out that skip `finally`.
 *
 * Ctrl+C on a slow render used to leave the fixture people in the live profile
 * book, and then the NEXT run snapshotted the polluted file as its baseline,
 * so the pollution became the thing faithfully restored.
 */
/**
 * Delete the event logs this render creates, and only those.
 *
 * Anything already in the directory belongs to the event and is never touched,
 * including a log written earlier today by a real desk.
 */
function fixtureLogSweeper(dir) {
  const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
  return () => {
    try {
      for (const name of readdirSync(dir)) {
        if (!before.has(name) && name.endsWith('.ndjson')) {
          rmSync(join(dir, name), { force: true });
        }
      }
    } catch { /* no log directory: nothing was written */ }
  };
}

function restoreOnExit(restore) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    restore();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => { once(); process.exit(130); });
  }
  process.on('exit', once);
  return once;
}

async function snapshot(files) {
  const saved = [];
  for (const file of files) {
    const had = existsSync(file);
    if (had) await copyFile(file, `${file}.preview-backup`);
    saved.push({ file, had });
  }
  // Synchronous, so the same function works from an `exit` handler, where
  // nothing asynchronous gets a chance to run.
  return () => {
    for (const { file, had } of saved) {
      try {
        if (had) {
          copyFileSync(`${file}.preview-backup`, file);
          rmSync(`${file}.preview-backup`, { force: true });
        } else {
          // A file that did not exist is restored by being deleted again,
          // which is the common case on a fresh clone and the one worth
          // getting right: an empty profile book left behind would make the
          // next `git status` look like the render had changed something.
          rmSync(file, { force: true });
        }
      } catch (err) {
        console.error(`[previews] could not restore ${file}: ${err.message}`);
      }
    }
  };
}

async function waitForDesk() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('the desk did not come up');
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) console.warn(`[previews] ${path} -> ${res.status}`);
  // The slide shot needs the id the add returned; everyone else ignores it.
  return res.json().catch(() => null);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?surface=previews`);
    // No auth frame: this desk was started with the gate off, and offering a
    // PIN to a desk that has none is rejected rather than ignored. The first
    // snapshot is the signal that the socket is usable.
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'snapshot') {
        resolve(init => ws.send(JSON.stringify({ t: 'emit', init })));
      }
    });
    ws.on('error', reject);
  });
}

/**
 * Screenshot one page.
 *
 * Gated consoles need the session cookie, and headless Chrome has no way to be
 * handed one directly, so those are captured through a tiny local page that
 * sets the cookie and then navigates. Same origin, so the cookie sticks.
 */
async function capture(chrome, shot, cookie) {
  const width = shot.width ?? 1920;
  const height = shot.height ?? 1080;
  const out = join(OUT, `${shot.name}.png`);

  void cookie;   // the gate is off for this desk; see main()

  await new Promise((done, fail) => {
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      `--window-size=${width},${height}`,
      // 12000, empirically. At 6000 a capture LOSES the websocket race often
      // enough to ship blank backdrops: virtual time pauses for document
      // resources but not for the socket handshake, so whether the snapshot
      // lands before the screenshot is a coin toss the desk machine mostly
      // won and this one mostly lost. The REST first-paint in desk-client
      // narrows the window; the bigger budget covers the rest.
      '--virtual-time-budget=12000',
      `--screenshot=${out}`,
      BASE + shot.url,
    ];
    const p = spawn(chrome, args, { stdio: 'ignore' });
    p.on('exit', () => done());
    p.on('error', fail);
  });
}

/** A contact sheet, so the folder is browsable without opening 27 files. */
async function writeIndex() {
  const files = (await readdir(OUT)).filter(f => f.endsWith('.png')).sort();
  const byName = new Map(SHOTS.map(s => [`${s.name}.png`, s]));
  const rows = files.map(f => {
    const shot = byName.get(f);
    return `  <figure>
    <a href="${f}"><img src="${f}" alt="${shot?.name ?? f}"></a>
    <figcaption><b>${f.replace(/\.png$/, '')}</b>${shot?.note ? `<span>${shot.note}</span>` : ''}</figcaption>
  </figure>`;
  }).join('\n');

  await writeFile(join(OUT, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>CalGames Content Desk · every screen</title>
<style>
  body { margin: 0; padding: 32px; background: #0E0113; color: #fff;
    font: 16px/1.5 system-ui, sans-serif; }
  h1 { font-size: 28px; margin: 0 0 6px; }
  p.sub { color: #A18FAE; margin: 0 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 24px; }
  figure { margin: 0; background: #270A33; padding: 12px; }
  img { width: 100%; display: block; background: #000; }
  figcaption { padding-top: 10px; font-size: 14px; }
  figcaption b { display: block; font-family: ui-monospace, monospace; color: #F0AF00; }
  figcaption span { color: #C9BCD0; }
  a { color: inherit; }
</style></head><body>
<h1>Every screen</h1>
<p class="sub">Real renders of the real surfaces, not mockups.
  Regenerate with <code>npm run previews</code> after any visual change.</p>
<div class="grid">
${rows}
</div>
</body></html>
`);
}

await main();
