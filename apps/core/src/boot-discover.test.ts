/**
 * The desk finding the field and the switcher by itself: index.ts booted as
 * its own process, the way the launcher starts it, against a scratch folder.
 *
 * The field is the fake arena (the real wire protocol) and the switcher is the
 * in-process fake ATEM, both on 127.0.0.1, named in data/settings.json the way
 * the Event settings page saves them. Nothing here sweeps a real network: in
 * every test that passes --discover, the address the settings name answers
 * first, so the search ends after one knock and one GET.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeArena } from './ingest/cheesy/fake-arena.ts';
import { FakeAtem } from './atem/fake-atem.ts';

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

/** boot.test.ts's environment: nothing that points the desk somewhere real. */
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

interface Desk { base: string; output: () => string; stop: () => Promise<void>; exited: () => boolean }

async function bootDesk(root: string, args: string[]): Promise<Desk> {
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
  return { base, output: () => out, stop, exited: () => exited };
}

async function scratch(name: string, settings: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `cg-boot-${name}-`));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  return root;
}

async function fieldConnected(base: string): Promise<boolean> {
  try {
    const state = await (await fetch(`${base}/api/state`)).json() as { connected?: { cheesy?: boolean } };
    return state.connected?.cheesy === true;
  } catch { return false; }
}

/**
 * The fake switcher on 127.0.0.1:9910, or null when that port is taken (by
 * another copy of this suite running at the same time, say). The watcher
 * dials the switcher's real port, so the fake has to be on it.
 */
async function fakeSwitcher(): Promise<FakeAtem | null> {
  try { return await FakeAtem.start({ host: '127.0.0.1', port: 9910, log: () => {} }); } catch { return null; }
}

test('--discover finds the field and the switcher named on the settings page, by itself', async t => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  // When 9910 is taken the switcher half is skipped and the field half
  // still runs. The switcher is named either way, so the watcher asks
  // loopback first and never needs to sweep this machine's networks.
  const atem = await fakeSwitcher();
  const root = await scratch('discover', {
    connections: { fieldHost: `127.0.0.1:${arenaPort}`, atemHost: '127.0.0.1' },
  });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--discover']);
    const d = desk;
    await until('the desk to find the field', () => d.output().includes(`found Cheesy Arena at 127.0.0.1:${arenaPort}`));
    await until('the bridge to connect', () => fieldConnected(d.base));
    assert.match(d.output(), new RegExp(`\\[cheesy\\] bridging 127\\.0\\.0\\.1:${arenaPort} as display "contentdesk1"`));
    // The settings address answered in the lead, alone: there was no fan-out.
    assert.equal((d.output().match(/looking for the field by itself/g) ?? []).length, 1, 'one sweep');

    if (atem) {
      await until('the switcher to be read', () => /\[atem\] ATEM: connected to/.test(d.output()), 20_000);
    } else {
      t.diagnostic('UDP 9910 on 127.0.0.1 is in use on this machine; the switcher half was skipped');
    }

    // The program page's way to reach Cheesy's own display when the desk cannot.
    const info = await (await fetch(`${d.base}/api/info`)).json() as { field?: { host?: string | null } };
    assert.equal(info.field?.host, `127.0.0.1:${arenaPort}`);
  } finally {
    await desk?.stop();
    arena.close();
    await atem?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('without --discover the desk looks for nothing, even with a field address saved', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const root = await scratch('nodiscover', { connections: { fieldHost: `127.0.0.1:${arenaPort}` } });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, []);
    await sleep(2500);
    assert.equal(await fieldConnected(desk.base), false);
    assert.match(desk.output(), /\[cheesy\] bridge off, pass --cheesy/);
    assert.ok(!desk.output().includes('looking for the field by itself'));
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('--discover with --no-field-search (the launcher\'s /no-cheesy) never looks for the field', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const root = await scratch('nofield', { connections: { fieldHost: `127.0.0.1:${arenaPort}` } });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--discover', '--no-field-search']);
    await sleep(2500);
    assert.equal(await fieldConnected(desk.base), false);
    assert.match(desk.output(), /not looking for the field \(started with \/no-cheesy\)/);
    assert.ok(!desk.output().includes('looking for the field by itself'));
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('practice mode never looks for the field, whatever the flags say', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const root = await scratch('demo', { connections: { fieldHost: `127.0.0.1:${arenaPort}` } });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--discover', '--demo']);
    await sleep(2500);
    assert.match(desk.output(), /practice and replay never connect to a field/);
    assert.ok(!desk.output().includes('looking for the field by itself'));
    assert.ok(!desk.output().includes('bridging'));
    // Nor for the switcher: a kitchen-table rehearsal has none to find, and a
    // sweep would put hellos on whatever network the laptop is on.
    assert.ok(!/\[atem\] ATEM: off -> searching/.test(desk.output()), 'no switcher search in practice');
    // The demo itself still runs: nothing bridged, so nothing refused it.
    assert.ok(!desk.output().includes('[demo] not started'));
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a replay never looks for the field or the switcher, whatever the flags say', async () => {
  // The launcher never passes --replay, but `npm run replay` does, often on
  // the event laptop the morning after: recorded matches must not mix with a
  // live field's, and a replay has no business putting hellos on the network.
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  // No switcher address saved: a saved one is dialled in any mode (reading
  // its tally is harmless), so only a search would show up below.
  const root = await scratch('replay', { connections: { fieldHost: `127.0.0.1:${arenaPort}` } });
  await writeFile(join(root, 'data', 'replay.ndjson'), '', 'utf8');
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--discover', '--replay', 'data/replay.ndjson']);
    await sleep(2500);
    assert.match(desk.output(), /practice and replay never connect to a field/);
    assert.ok(!desk.output().includes('looking for the field by itself'));
    assert.ok(!desk.output().includes('bridging'));
    assert.ok(!/\[atem\] ATEM: off -> searching/.test(desk.output()), 'no switcher search in a replay');
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('--cheesy-host from the launcher and a different, answering address in Event settings: the settings win', async () => {
  // The restart the settings page asks for (exit 75) reruns the launcher's
  // original arguments, so this is the only way a new address can land.
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const dead = await freePort();
  const root = await scratch('prefer', { connections: { fieldHost: `127.0.0.1:${arenaPort}` } });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--cheesy', '--cheesy-host', `127.0.0.1:${dead}`]);
    const d = desk;
    await until('the bridge to connect', () => fieldConnected(d.base));
    assert.match(d.output(), new RegExp(`bridging 127\\.0\\.0\\.1:${arenaPort} `));
    assert.ok(!d.output().includes(`bridging 127.0.0.1:${dead}`));
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('--cheesy-host from the launcher and a stale address in Event settings: the launcher\'s field is used', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const dead = await freePort();
  const root = await scratch('stale', { connections: { fieldHost: `127.0.0.1:${dead}` } });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--cheesy', '--cheesy-host', `127.0.0.1:${arenaPort}`]);
    const d = desk;
    await until('the bridge to connect', () => fieldConnected(d.base));
    assert.match(d.output(), /did not answer; using the one found at start/);
    assert.match(d.output(), new RegExp(`bridging 127\\.0\\.0\\.1:${arenaPort} `));
  } finally {
    await desk?.stop();
    arena.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function postConnections(base: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/settings/connections`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('Event settings go live: a switcher address dials at once, a Nexus key is applied without a restart', async t => {
  const atem = await fakeSwitcher();
  if (!atem) {
    t.skip('UDP 9910 on 127.0.0.1 is in use on this machine');
    return;
  }
  // No --discover, so nothing is searched for: only what the page names.
  const root = await scratch('live', {});
  // No event key, so the Nexus half never leaves this machine: the shipped
  // default names the real CalGames event.
  await writeFile(join(root, 'config.json'), JSON.stringify({ nexus: { eventKey: '' } }), 'utf8');
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, []);
    const d = desk;
    await sleep(500);
    assert.ok(!/\[atem\] ATEM: connected/.test(d.output()), 'nothing to dial before the address is set');

    const saved = await postConnections(d.base, { atemHost: '127.0.0.1' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    await until('the switcher to be read', () => /\[atem\] ATEM: connected to/.test(d.output()), 20_000);

    // A Nexus key with no event key in config.json: applied at once, and said
    // in words, without the key itself anywhere in the log.
    const KEY = 'nexus-test-key-1234abcd';
    const nx = await postConnections(d.base, { nexusKey: KEY });
    assert.equal(nx.status, 200, JSON.stringify(nx.json));
    await until('the Nexus change to be applied', () => /\[nexus\] off: there is a Nexus key but config\.json has no nexus\.eventKey/.test(d.output()), 5000)
      .catch(err => {
        const lines = d.output().split(/\r?\n/).filter(l => /nexus|settings/.test(l)).join(' | ');
        throw new Error(`${(err as Error).message}: ${lines}`);
      });
    assert.ok(!d.output().includes(KEY), 'the key never reaches the log');
  } finally {
    await desk?.stop();
    await atem.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a field address typed while the desk is still looking re-aims the search at once', async t => {
  // The switcher is named too, so the watcher's own search ends at its
  // first hello instead of sweeping this machine's real networks.
  const atem = await fakeSwitcher();
  if (!atem) {
    t.skip('UDP 9910 on 127.0.0.1 is in use on this machine');
    return;
  }
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  // Accepts and never answers: the first sweep's lead check hangs on it for
  // its whole timeout, which is the window to change the address in, and
  // keeps that sweep from ever reaching a real network.
  const held: import('node:net').Socket[] = [];
  const silent = createServer(sock => { held.push(sock); });
  await new Promise<void>(res => silent.listen(0, '127.0.0.1', () => res()));
  const silentPort = (silent.address() as { port: number }).port;
  const root = await scratch('retarget', {
    connections: { fieldHost: `127.0.0.1:${silentPort}`, atemHost: '127.0.0.1' },
  });
  let desk: Desk | null = null;
  try {
    desk = await bootDesk(root, ['--discover']);
    const d = desk;
    await until('the first sweep to start', () => d.output().includes('looking for the field by itself'));
    const saved = await postConnections(d.base, { fieldHost: `127.0.0.1:${arenaPort}` });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual((saved.json as { restartNeeded?: string[] }).restartNeeded, [], 'no restart: not attached yet');
    await until('the field to be found at the new address', () => d.output().includes(`found Cheesy Arena at 127.0.0.1:${arenaPort}`), 15_000);
    await until('the bridge to connect', () => fieldConnected(d.base));
    assert.match(d.output(), /looking there first/);

    // Attached now: another address waits for the next start, and says so.
    const later = await postConnections(d.base, { fieldHost: '127.0.0.1:1' });
    assert.equal(later.status, 200);
    assert.deepEqual((later.json as { restartNeeded?: string[] }).restartNeeded, ['fieldHost']);
    await until('the desk to say it stays put', () => /the desk stays on 127\.0\.0\.1:\d+ until its next start/.test(d.output()));
  } finally {
    await desk?.stop();
    for (const s of held) s.destroy();
    silent.close();
    arena.close();
    await atem.close();
    await rm(root, { recursive: true, force: true });
  }
});
