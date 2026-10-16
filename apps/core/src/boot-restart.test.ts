/**
 * What a restart of the real desk keeps: index.ts booted as its own process,
 * against a scratch folder (CG_DESK_ROOT), the way boot.test.ts boots it.
 *
 * Restarts happen at events (a kicked cable, a crash, the handbook's own fix
 * of closing the desk and starting it again), and what they quietly dropped
 * was only ever found on air. Each question here is answered by stopping a
 * real desk and starting another on the same folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStamp } from './bus.ts';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const { port } = srv.address() as { port: number };
  await new Promise<void>(res => srv.close(() => res()));
  return port;
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** This environment minus anything pointing somewhere real; see boot.test.ts. */
function deskEnv(root: string): Record<string, string> {
  const drop = new Set(['PATH', 'LOCALAPPDATA', 'OBS_PASSWORD', 'REMOTE_PIN', 'JA_PIN', 'SETUP_PIN',
    'HOST', 'PORT', 'LAN_IP', 'CG_DESK_ROOT', 'CG_PREVIEW_DESK']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !drop.has(k.toUpperCase())) out[k] = v;
  }
  return {
    ...out,
    PATH: dirname(process.execPath),
    LOCALAPPDATA: root,
    CG_DESK_ROOT: root,
    HOST: '127.0.0.1',
    REMOTE_PIN: '', JA_PIN: '', SETUP_PIN: '',
  };
}

interface Desk { base: string; output: () => string; stop: () => Promise<void> }

async function bootDesk(root: string, args: string[] = []): Promise<Desk> {
  const port = await freePort();
  const child = spawn(process.execPath, [
    '--experimental-strip-types', INDEX, '--port', String(port), '--exit-with-parent', ...args,
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: deskEnv(root) });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  let exited = false;
  const gone = new Promise<void>(res => child.on('exit', () => { exited = true; res(); }));
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    child.stdin.end();
    await Promise.race([gone, new Promise(r => setTimeout(r, 8000).unref())]);
    if (!exited) { child.kill(); await gone; }
  };
  try {
    await until('the desk to answer', async () => {
      if (exited) throw new Error(`the desk exited during boot:\n${out}`);
      try { return (await fetch(`${base}/api/state`)).ok; } catch { return false; }
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, output: () => out, stop };
}

type CueRow = { id: string; autopilot: boolean };
const armedIds = async (d: Desk): Promise<string[]> =>
  ((await (await fetch(`${d.base}/api/cues`)).json()) as { cues: CueRow[] })
    .cues.filter(c => c.autopilot).map(c => c.id);
const post = async (d: Desk, path: string): Promise<void> => {
  const res = await fetch(d.base + path, { method: 'POST' });
  assert.equal(res.status, 200, path);
};

test('armed cues come back after a restart; a rehearsal neither inherits nor keeps them', async () => {
  /*
   * The arm map lived only in memory and the packaged desk passes no
   * --autopilot, so a crew that armed every cue at doors and restarted at
   * lunch came back with every cue silently off.
   */
  const root = await mkdtemp(join(tmpdir(), 'cg-boot-cues-'));
  const file = join(root, 'data', 'cues.json');
  let desk: Desk | null = null;
  try {
    await writeFile(join(root, 'config.json'), '{}', 'utf8');
    desk = await bootDesk(root);
    assert.deepEqual(await armedIds(desk), [], 'the first boot of the event starts with nothing armed');
    await post(desk, '/api/cues/all/arm');
    await post(desk, '/api/cues/gap-filler/disarm');
    const wanted = await armedIds(desk);
    assert.ok(wanted.includes('on-deck') && !wanted.includes('gap-filler'));
    // The write is a moment behind the answer; give it that moment, and only
    // then look. Polling the file would hold it open under the desk's own
    // rename, which Windows refuses (nothing reads it at the event but the
    // desk itself, at boot).
    await sleep(1000);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { armed: Record<string, boolean> };
    assert.equal(saved.armed['on-deck'], true, desk.output());
    assert.equal(saved.armed['gap-filler'], false);
    await desk.stop();
    desk = null;

    // The restart.
    desk = await bootDesk(root);
    assert.deepEqual(await armedIds(desk), wanted, 'every switch as the crew left it');
    assert.match(desk.output(), new RegExp(`autopilot on for ${wanted.length}, as they were left`));
    await desk.stop();
    desk = null;

    // A rehearsal starts with nothing armed and saves nothing it changes.
    const before = await readFile(file, 'utf8');
    desk = await bootDesk(root, ['--rehearsal']);
    assert.deepEqual(await armedIds(desk), [], 'a rehearsal does not inherit the show\'s switches');
    await post(desk, '/api/cues/live/arm');
    await sleep(500);
    assert.equal(await readFile(file, 'utf8'), before, 'nor leave its own behind');
    await desk.stop();
    desk = null;

    // And the show's switches are still there after it.
    desk = await bootDesk(root);
    assert.deepEqual(await armedIds(desk), wanted);
    await desk.stop();
    desk = null;

    // --autopilot still arms every cue, whatever was saved.
    desk = await bootDesk(root, ['--autopilot']);
    const all = ((await (await fetch(`${desk.base}/api/cues`)).json()) as { cues: CueRow[] }).cues;
    assert.ok(all.every(c => c.autopilot), '--autopilot arms them all');
  } finally {
    await desk?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a desk started on Sunday still knows Saturday\'s qual yellows', async () => {
  /*
   * Qualifications run Saturday into Sunday morning, and the boot rebuild
   * read only today's events: a team carded in Saturday's Q30 was clean on
   * the score bar, on the talent view and at /api/discipline all Sunday.
   */
  const root = await mkdtemp(join(tmpdir(), 'cg-boot-cards-'));
  let desk: Desk | null = null;
  try {
    await writeFile(join(root, 'config.json'), '{}', 'utf8');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(15, 0, 0, 0);
    const at = (min: number): number => yesterday.getTime() + min * 60_000;
    const line = (type: string, payload: unknown, ts: number): string => JSON.stringify({
      id: `e${ts}`, seq: 1, ts, matchClock: null, source: 'cheesy', confidence: 'authoritative',
      type, payload,
    });
    await mkdir(join(root, 'data', 'events'), { recursive: true });
    await writeFile(join(root, 'data', 'events', `${localStamp(yesterday)}.ndjson`), [
      line('match.loaded', { id: 'q30', displayName: 'Qualification 30', red: [], blue: [] }, at(1)),
      line('card.issued', { team: 253, card: 'yellow', alliance: 'red', match: 'Qualification 30' }, at(3)),
      // Not a card: the rest of yesterday is yesterday's record, not today's.
      line('emergency.raise', { kind: 'custom', message: 'Yesterday only', detail: '' }, at(4)),
    ].join('\n') + '\n', 'utf8');

    desk = await bootDesk(root);
    const state = await (await fetch(`${desk.base}/api/state`)).json() as {
      cards: { byTeam: Record<string, { yellows: number }> }; emergency: unknown;
    };
    assert.equal(state.cards.byTeam['253']?.yellows, 1, 'the score bar still marks 253');
    assert.equal(state.emergency, null, 'and nothing else of yesterday came back');
    const discipline = await (await fetch(`${desk.base}/api/discipline`)).json() as {
      teams: { team: number; carrying: boolean }[];
    };
    assert.equal(discipline.teams.find(t => t.team === 253)?.carrying, true,
      'the announcer is told 253 is carrying a yellow');
    assert.match(desk.output(), /\[rebuild\].*3 from yesterday for the cards/);
  } finally {
    await desk?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
