/**
 * The real entry point, index.ts, booted as its own process.
 *
 * Against a scratch folder (CG_DESK_ROOT), so nothing here reads or writes the
 * event's own config.json or data/. The questions are about the boot itself,
 * which nothing short of running it answers: what it dials, what it restores,
 * and what it prints.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { EventBus } from './bus.ts';
import { sign } from './cue/obs.ts';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const { port } = srv.address() as { port: number };
  await new Promise<void>(res => srv.close(() => res()));
  return port;
}

/** Wait for `ok()`, or fail saying what was being waited for. */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Environment for the desk under test: this one's, minus anything that would
 * point it somewhere real or slow it down. Keys are matched without regard to
 * case, because Windows spells PATH "Path" and two spellings in one block is
 * a coin toss.
 */
function deskEnv(root: string, extra: Record<string, string>): Record<string, string> {
  const drop = new Set(['PATH', 'LOCALAPPDATA', 'OBS_PASSWORD', 'REMOTE_PIN', 'JA_PIN', 'SETUP_PIN',
    'HOST', 'PORT', 'LAN_IP', 'CG_DESK_ROOT', 'CG_PREVIEW_DESK']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !drop.has(k.toUpperCase())) out[k] = v;
  }
  return {
    ...out,
    // No ffmpeg on the path and no winget folder: recording stays off and
    // the boot does not stop to probe encoders.
    PATH: dirname(process.execPath),
    LOCALAPPDATA: root,
    CG_DESK_ROOT: root,
    HOST: '127.0.0.1',
    REMOTE_PIN: '', JA_PIN: '', SETUP_PIN: '',
    ...extra,
  };
}

interface Desk { base: string; output: () => string; stop: () => Promise<void> }

async function bootDesk(root: string, env: Record<string, string> = {}): Promise<Desk> {
  const port = await freePort();
  const child = spawn(process.execPath, [
    '--experimental-strip-types', INDEX, '--port', String(port), '--exit-with-parent',
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: deskEnv(root, env) });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  let exited = false;
  const gone = new Promise<void>(res => child.on('exit', () => { exited = true; res(); }));
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    // The launcher's way out: close stdin, and the desk shuts down properly.
    // The backstop timer is unref'd, so it cannot hold this test file open
    // for its whole length after the desk has already gone.
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

/**
 * A stand-in for OBS's WebSocket server: asks for a password the way OBS
 * does, records what the desk answers, and says yes to every request.
 */
async function fakeObs() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(res => wss.on('listening', () => res()));
  const salt = 'c2FsdC1mb3ItdGhlLXRlc3Q=';
  const challenge = 'Y2hhbGxlbmdlLWZvci10aGUtdGVzdA==';
  const seen = { connections: 0, auth: [] as string[] };
  wss.on('connection', (ws: WebSocket) => {
    seen.connections++;
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt, challenge } } }));
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (msg.op === 1) {
        seen.auth.push(String(msg.d['authentication'] ?? ''));
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (msg.op === 6) {
        ws.send(JSON.stringify({ op: 7, d: {
          requestType: msg.d['requestType'], requestId: msg.d['requestId'],
          requestStatus: { result: true, code: 100 },
          responseData: { scenes: [], sceneItems: [], inputs: [], currentProgramSceneName: 'CG_MATCH' },
        } }));
      }
    });
  });
  const { port } = wss.address() as { port: number };
  return {
    host: `127.0.0.1:${port}`, seen,
    signed: (password: string) => sign(password, salt, challenge),
    close: () => new Promise<void>(res => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => res());
    }),
  };
}

test('config.json alone connects OBS, and the password goes nowhere but the handshake', async () => {
  /*
   * The packaged exe has no command line, and the desk only dialled OBS with
   * --obs, so no automatic camera cut and no replay Take could ever work in
   * the deployment the handbook describes. The handbook's line in config.json
   * is now the whole job.
   */
  const PW = 'Obs-boot-pw-8421';
  const root = await mkdtemp(join(tmpdir(), 'cg-boot-obs-'));
  const obs = await fakeObs();
  let desk: Desk | null = null;
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({
      obs: { enabled: true, host: obs.host, password: PW },
    }), 'utf8');
    desk = await bootDesk(root);
    const d = desk;
    await until('the desk to answer OBS\'s password challenge', () => obs.seen.auth.length > 0);
    assert.equal(obs.seen.auth[0], obs.signed(PW), 'signed with the password from config.json');
    await until('the desk to log the connection', () => /\[obs\] connected/.test(d.output()));

    // OBS is up as far as the doors check is concerned.
    const vitals = await (await fetch(`${d.base}/api/vitals`)).json() as
      { checks: { id: string; level: string }[] };
    assert.notEqual(vitals.checks.find(c => c.id === 'obs')?.level, 'off');

    for (const route of ['/api/state', '/api/setup', '/api/publish', '/api/vitals', '/api/stream',
      '/api/urls', '/api/cues', '/api/events/recent']) {
      const body = await (await fetch(d.base + route)).text();
      assert.ok(!body.includes(PW), `${route} carries the OBS password`);
    }
    assert.match(d.output(), /\[obs\] connecting to 127\.0\.0\.1:\d+ \(turned on in config\.json/);
    assert.ok(!d.output().includes(PW), 'no log line carries the OBS password');
  } finally {
    await desk?.stop();
    await obs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the preview desk restores nothing from today\'s log and never dials OBS', async () => {
  /*
   * tools/render-previews.mjs boots a desk against the real folder to
   * photograph fixtures. The boot rebuild put today's real safety message,
   * delay card, announcement and card marks into it first, so every shot
   * before the script cleared them photographed the real day, and previews/
   * is committed. And with OBS switched on in config.json, that desk would
   * have dialled the show's own OBS.
   */
  const root = await mkdtemp(join(tmpdir(), 'cg-boot-preview-'));
  const obs = await fakeObs();
  let desk: Desk | null = null;
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({
      obs: { enabled: true, host: obs.host, password: 'Preview-pw-1' },
    }), 'utf8');
    // Earlier today, the way a running desk writes it.
    const now = Date.now();
    const before = new EventBus();
    await before.openLog(join(root, 'data', 'events'));
    before.emit({ type: 'emergency.raise', source: 'manual', ts: now - 60_000,
      payload: { kind: 'evacuate', message: 'Leave the gym by the north doors', detail: '' } } as never);
    before.emit({ type: 'announcement.posted', source: 'manual', ts: now - 50_000,
      payload: { text: 'Lunch is in the cafeteria', postedAt: now - 50_000, from: 'Event' } } as never);
    before.emit({ type: 'card.issued', source: 'cheesy', ts: now - 40_000,
      payload: { team: 846, card: 'yellow', match: 'Qualification 3' } } as never);
    await before.closeLog();

    desk = await bootDesk(root, { CG_PREVIEW_DESK: '1' });
    const fresh = await (await fetch(`${desk.base}/api/state`)).json() as {
      emergency: unknown; announcement: unknown; cards: { byTeam: Record<string, unknown> };
    };
    assert.equal(fresh.emergency, null, 'no real safety message in the shots');
    assert.equal(fresh.announcement, null);
    assert.deepEqual(fresh.cards.byTeam, {}, 'no real card marks either');
    assert.match(desk.output(), /\[rebuild\] skipped on the preview desk/);

    // The renderer's desk is ungated on 127.0.0.1 on purpose: a note, not a
    // red doors check across the console shot.
    const vitals = await (await fetch(`${desk.base}/api/vitals`)).json() as
      { blockers: { id: string }[]; checks: { id: string; level: string }[] };
    assert.equal(vitals.checks.find(c => c.id === 'codes')?.level, 'off');
    assert.ok(!vitals.blockers.some(b => b.id === 'codes'));

    await sleep(1500);
    assert.equal(obs.seen.connections, 0, 'the preview desk never touched OBS');
    await desk.stop();
    desk = null;

    // The same folder without the switch: the log really does hold all three,
    // so the empty screens above were the switch and not a broken fixture.
    desk = await bootDesk(root);
    const restored = await (await fetch(`${desk.base}/api/state`)).json() as {
      emergency: { message?: string } | null; announcement: { text?: string } | null;
      cards: { byTeam: Record<string, { yellows: number }> };
    };
    assert.equal(restored.emergency?.message, 'Leave the gym by the north doors');
    assert.equal(restored.announcement?.text, 'Lunch is in the cafeteria');
    assert.equal(restored.cards.byTeam['846']?.yellows, 1);
  } finally {
    await desk?.stop();
    await obs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a malformed --obs-host is refused at the door in one line, not a stack', async () => {
  // The first threw out of new WebSocket() as a fatal stack mid-boot; the
  // second booted and dialled nothing, forever.
  for (const bad of ['127.0.0.1:99999', 'ws://127.0.0.1:4455/obs']) {
    const root = await mkdtemp(join(tmpdir(), 'cg-boot-host-'));
    try {
      // --exit-with-parent and a deadline: a desk that wrongly boots must not
      // outlive this test.
      const child = spawn(process.execPath, [
        '--experimental-strip-types', INDEX, '--port', String(await freePort()),
        '--obs', '--obs-host', bad, '--exit-with-parent',
      ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: deskEnv(root, {}) });
      let out = '';
      child.stdout.on('data', d => { out += String(d); });
      child.stderr.on('data', d => { out += String(d); });
      const exit = new Promise<number | null>(res => child.on('exit', c => res(c)));
      const code = await Promise.race([exit,
        new Promise<'running'>(r => setTimeout(() => r('running'), 15_000).unref())]);
      if (code === 'running') { child.kill(); await exit; }
      assert.equal(code, 1, `${bad}: the desk should refuse to start:\n${out}`);
      assert.match(out, /--obs-host needs a host:port like 127\.0\.0\.1:4455/, bad);
      assert.doesNotMatch(out, /\n\s+at /, `${bad}: no stack trace`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
