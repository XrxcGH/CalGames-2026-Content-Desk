/**
 * The desk's LAN address is asked for per request and cached for a short time.
 *
 * It used to be fixed at boot, so a laptop that got a new IP (or was plugged in
 * after the desk started) kept printing QR codes for an address that no longer
 * reached it, for the rest of the event, with nothing on screen to say so.
 * These pin the rules that fix it without needing an adapter to unplug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { createLanBase } from './lan.ts';

/** A probe whose answer the test controls, and a clock it moves by hand. */
function rig(first: string | null | Error, opts: { ttlMs?: number; missTtlMs?: number } = {}) {
  let address: string | null | Error = first;
  let probes = 0;
  let clock = 1_000;
  const changes: Array<[string | null, string | null | undefined]> = [];
  const lan = createLanBase({
    port: 8720,
    probe: () => {
      probes++;
      if (address instanceof Error) throw address;
      return address;
    },
    now: () => clock,
    onChange: (base, was) => { changes.push([base, was]); },
    ...opts,
  });
  return {
    lan,
    changes,
    set: (a: string | null | Error) => { address = a; },
    wait: (ms: number) => { clock += ms; },
    probes: () => probes,
  };
}

test('the address is built with the port and cached, so a burst of screens costs one probe', () => {
  const r = rig('172.22.0.23');
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720');
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720');
  r.wait(29_000);
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720');
  assert.equal(r.probes(), 1, 'inside the 30 seconds nobody asks the network again');
});

test('a new IP reaches the QR codes within the cache window, with no restart', () => {
  const r = rig('172.22.0.23');
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720');

  r.set('10.0.5.77');
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720', 'still cached, by design');
  r.wait(30_000);
  assert.equal(r.lan.get(), 'http://10.0.5.77:8720',
    'after the window the next request sees the laptop\'s real address');
});

test('a desk started before the laptop had a network picks the address up once it has one', () => {
  const r = rig(null);
  assert.equal(r.lan.get(), null, 'no address is null, never a localhost that looks valid');

  // The operator plugs the cable in and reloads. "No address" is only trusted
  // for a few seconds, so they are not told to wait half a minute.
  r.set('192.168.1.40');
  r.wait(3_000);
  assert.equal(r.lan.get(), 'http://192.168.1.40:8720');
});

test('"no address" is rechecked far sooner than a good address', () => {
  const r = rig(null);
  r.lan.get();
  r.lan.get();
  assert.equal(r.probes(), 1, 'a second screen in the same moment does not re-probe');
  r.wait(2_999);
  r.lan.get();
  assert.equal(r.probes(), 1);
  r.wait(1);
  r.lan.get();
  assert.equal(r.probes(), 2);
});

test('losing the network turns the base back to null instead of keeping a dead address', () => {
  const r = rig('172.22.0.23');
  r.lan.get();
  r.set(null);
  r.wait(30_000);
  assert.equal(r.lan.get(), null,
    'the poster page refuses to print on null, which beats printing an address that no longer works');
});

test('refresh() ignores the cache, which is what the slow patrol relies on', () => {
  const r = rig('172.22.0.23');
  r.lan.get();
  r.set('10.0.5.77');
  assert.equal(r.lan.refresh(), 'http://10.0.5.77:8720');
  assert.equal(r.lan.get(), 'http://10.0.5.77:8720', 'and the cache now holds the fresh answer');
});

test('the change listener fires on the first answer and on real changes only', () => {
  const r = rig('172.22.0.23');
  r.lan.get();
  assert.deepEqual(r.changes, [['http://172.22.0.23:8720', undefined]],
    'the first answer announces itself, with no previous value');

  r.wait(30_000);
  r.lan.get();
  assert.equal(r.changes.length, 1, 'an unchanged address is not news');

  r.set('10.0.5.77');
  r.wait(30_000);
  r.lan.get();
  assert.deepEqual(r.changes[1], ['http://10.0.5.77:8720', 'http://172.22.0.23:8720']);

  r.set(null);
  r.wait(30_000);
  r.lan.get();
  assert.deepEqual(r.changes[2], [null, 'http://10.0.5.77:8720']);
});

test('a first answer of "nothing" still announces, so the later one is a change from none', () => {
  const r = rig(null);
  r.lan.get();
  assert.deepEqual(r.changes, [[null, undefined]]);
  r.set('172.22.0.23');
  r.wait(3_000);
  r.lan.get();
  assert.deepEqual(r.changes[1], ['http://172.22.0.23:8720', null]);
});

test('a probe that throws keeps the last address rather than blanking every QR', () => {
  const r = rig('172.22.0.23');
  r.lan.get();
  r.set(new Error('uv_interface_addresses returned an error'));
  r.wait(30_000);
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720',
    'an adapter mid-change is not the same as having no network');

  // And it is not retried on every request while it keeps failing.
  const before = r.probes();
  r.lan.get();
  r.lan.get();
  assert.equal(r.probes(), before);
});

test('a probe that throws before any answer is "nothing yet", and the next success announces', () => {
  const r = rig(new Error('no adapters'));
  assert.equal(r.lan.get(), null);
  r.set('172.22.0.23');
  r.wait(3_000);
  assert.equal(r.lan.get(), 'http://172.22.0.23:8720');
  assert.deepEqual(r.changes, [['http://172.22.0.23:8720', null]]);
});

test('a listener that throws cannot break the request that triggered it', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const lan = createLanBase({
      port: 8720,
      probe: () => '172.22.0.23',
      onChange: () => { throw new Error('boom'); },
    });
    assert.equal(lan.get(), 'http://172.22.0.23:8720');
  } finally {
    console.warn = warn;
  }
});

test('the served routes resolve the address per request: /api/urls and the start panel follow a new IP', async () => {
  // The gate off: this is about the address, not the door.
  process.env['REMOTE_PIN'] = '';
  const dir = await mkdtemp(join(tmpdir(), 'cg-lan-'));
  let now: string | null = null;
  const server = startServer({
    bus: new EventBus(), media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    lanBase: () => now,
  });
  const port = await server.listening;
  const urls = async (): Promise<{ base: string | null }> =>
    fetch(`http://127.0.0.1:${port}/api/urls`).then(r => r.json()) as Promise<{ base: string | null }>;
  const index = async (): Promise<string> =>
    fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
  try {
    // Started with no network: the QR base is null (the poster refuses to
    // print, the side screen hides its code) and the panel says so.
    assert.equal((await urls()).base, null);
    assert.match(await index(), /no address on a network yet/);

    // The cable goes in. Same running server, no restart.
    now = 'http://172.22.0.23:8720';
    assert.equal((await urls()).base, 'http://172.22.0.23:8720');
    const page = await index();
    assert.match(page, /172\.22\.0\.23:8720\//);
    assert.doesNotMatch(page, /no address on a network yet/);

    // And the laptop roams to another address.
    now = 'http://10.0.5.77:8720';
    assert.equal((await urls()).base, 'http://10.0.5.77:8720');
    assert.match(await index(), /10\.0\.5\.77:8720\//);
  } finally {
    delete process.env['REMOTE_PIN'];
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the start panel shows the PIN only to a browser that asked for the desk by a local name', async () => {
  // DNS rebinding: a web page open on the desk laptop points its own domain
  // at 127.0.0.1. The connection is local, but the Host header is the page's.
  process.env['REMOTE_PIN'] = '4726';
  const dir = await mkdtemp(join(tmpdir(), 'cg-lan-'));
  const server = startServer({
    bus: new EventBus(), media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    lanBase: 'http://172.22.0.23:8720',
  });
  const port = await server.listening;
  const { request } = await import('node:http');
  const get = (host: string): Promise<string> => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', headers: { host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject).end();
  });
  try {
    assert.match(await get(`localhost:${port}`), /4726/);
    assert.match(await get(`127.0.0.1:${port}`), /4726/);
    const rebound = await get(`attacker.example:${port}`);
    assert.doesNotMatch(rebound, /4726/);
    assert.match(rebound, /172\.22\.0\.23:8720/, 'the address is still shown to everyone');
  } finally {
    delete process.env['REMOTE_PIN'];
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fixed string base still works for callers that predate the live one', async () => {
  process.env['REMOTE_PIN'] = '';
  const dir = await mkdtemp(join(tmpdir(), 'cg-lan-'));
  const server = startServer({
    bus: new EventBus(), media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    lanBase: 'http://172.22.0.23:8720',
  });
  const port = await server.listening;
  try {
    const urls = await fetch(`http://127.0.0.1:${port}/api/urls`).then(r => r.json()) as
      { base: string | null };
    assert.equal(urls.base, 'http://172.22.0.23:8720');
  } finally {
    delete process.env['REMOTE_PIN'];
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
