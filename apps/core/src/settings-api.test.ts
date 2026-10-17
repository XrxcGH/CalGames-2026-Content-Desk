/**
 * The settings page's routes (C5), the field as the server sees it (C3, C6),
 * and the restart (C9's half that lives here), against the real server.
 *
 * What these hold: every code changes only with the current code, in a POST
 * body, through the same PIN damper the sign-in doors use; the desk PIN only
 * from the desk laptop; every session made with an old code signed out the
 * moment it changes; nothing secret in any answer, log or file a browser can
 * reach; and the restart answers before it exits with 75.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { EventBus } from './bus.ts';
import { DEFAULTS } from './config.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { FieldLink } from './ingest/cheesy/field-link.ts';
import { MediaLibrary } from './media.ts';
import { ScreenRegistry } from './screens.ts';
import { startServer } from './server.ts';
import { Settings } from './settings.ts';
import { Vitals } from './vitals.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const CODES = { REMOTE_PIN: '4726', JA_PIN: '2580', SETUP_PIN: '3691' };

interface Boot {
  root: string; port: number; bus: EventBus; field: FieldLink; settings: Settings;
  exits: number[]; flushed: () => number;
  done: () => Promise<void>;
}

/** `restartable: null` boots the way index.ts does: from the process's own arguments. */
async function boot(o: { restartable?: boolean | null; codes?: Record<string, string | undefined>; vitals?: boolean } = {}): Promise<Boot> {
  const root = await mkdtemp(join(tmpdir(), 'cg-settings-api-'));
  const env = o.codes ?? CODES;
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const bus = new EventBus();
  let flushes = 0;
  const closeLog = bus.closeLog.bind(bus);
  bus.closeLog = () => { flushes += 1; return closeLog(); };
  const config = structuredClone(DEFAULTS);
  const settings = Settings.load(root, config);
  const field = new FieldLink();
  const exits: number[] = [];
  const server = startServer({
    bus, media: new MediaLibrary(root), root, port: 0, host: '127.0.0.1', config, mode: null,
    settings, field, screens: new ScreenRegistry(),
    ...(o.vitals ? { vitals: new Vitals({ bus, config, root, settings, field, host: '127.0.0.1',
      freeBytes: async () => 1024 ** 4 }) } : {}),
    configFile: () => ({ state: 'read', duplicates: [] }),
    seedSample: () => {}, clearSample: () => false,
    exit: code => { exits.push(code); },
    ...(o.restartable === null ? {} : { restartable: o.restartable ?? true }),
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const port = await server.listening;
  return {
    root, port, bus, field, settings, exits, flushed: () => flushes,
    done: async () => { server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

interface Reply { status: number; body: string; json: Record<string, unknown>; cookie: string | null }

/**
 * One request, naming the desk by `host` (the desk laptop is
 * localhost:PORT; anything else is another computer on the network).
 */
function call(port: number, method: string, path: string,
  o: { host?: string; cookie?: string | null; body?: unknown; pin?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = request({
      host: '127.0.0.1', port, path, method,
      headers: {
        host: o.host ?? `localhost:${port}`,
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.pin ? { 'x-desk-pin': o.pin } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        const set = res.headers['set-cookie']?.[0];
        resolve({ status: res.statusCode ?? 0, body, json, cookie: set ? set.split(';')[0]! : null });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const signIn = async (port: number, door: '/api/auth' | '/api/setup/auth' | '/api/awards/auth', pin: string) => {
  const r = await call(port, 'POST', door, { body: { pin } });
  assert.equal(r.status, 200, `${door} sign-in`);
  return r.cookie!;
};

// ---- GET /api/settings ----------------------------------------------------------------

test('the settings page reads what is set, behind the settings code, and never a code or a whole key', async () => {
  const d = await boot({ codes: { REMOTE_PIN: undefined, JA_PIN: undefined, SETUP_PIN: '3691' } });
  try {
    assert.equal((await call(d.port, 'GET', '/api/settings')).status, 401, 'no session at all');
    const desk = await signIn(d.port, '/api/auth', '0864');
    const locked = await call(d.port, 'GET', '/api/settings', { cookie: desk });
    assert.equal(locked.status, 403, 'the desk PIN alone does not open the settings page');
    assert.equal(locked.json['locked'], true);

    const setup = await signIn(d.port, '/api/setup/auth', '3691');
    const save = await call(d.port, 'POST', '/api/settings/connections', { cookie: setup,
      body: { atemHost: '10.0.100.40', nexusKey: 'nexus-secret-key-wxyz', graphicsInput: 6 } });
    assert.equal(save.status, 200);

    const here = await call(d.port, 'GET', '/api/settings', { cookie: setup });
    assert.equal(here.status, 200);
    assert.deepEqual(here.json, {
      codes: { desk: { isDefault: true }, awards: { isDefault: true }, settings: { isDefault: false } },
      connections: { fieldHost: null, atemHost: '10.0.100.40', nexusKey: { set: true, hint: 'wxyz' } },
      graphicsInput: 6,
      deskMachine: true,
      field: { host: null, connected: false, searching: false },
      atem: { state: 'off', host: null, model: null, videoMode: null, inputs: [] },
    });

    // From another computer: the same page, but "still the default" about
    // codes the caller does not hold is a default-code warning, and those
    // stay on the desk laptop.
    const away = await call(d.port, 'GET', '/api/settings', { cookie: setup, host: `172.22.0.23:${d.port}` });
    assert.equal(away.status, 200);
    assert.deepEqual(away.json['codes'],
      { desk: { isDefault: null }, awards: { isDefault: null }, settings: { isDefault: false } });
    assert.equal(away.json['deskMachine'], false);

    for (const r of [here, away]) {
      for (const secret of ['0864', '1357', '3691', 'nexus-secret-key-wxyz', 'nexus-secret']) {
        assert.ok(!r.body.includes(secret), `"${secret}" is never in the answer`);
      }
    }
    // The file holding them is never served, by any spelling.
    for (const p of ['/data/settings.json', '/settings.json', '/s/../data/settings.json', '/theme/../data/settings.json',
      '/desk-pin.txt', '/shared/..%2f..%2fdata%2fsettings.json']) {
      const r = await call(d.port, 'GET', p, { cookie: desk });
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.body.includes('nexus-secret'), p);
    }
  } finally {
    await d.done();
  }
});

// ---- POST /api/settings/connections ---------------------------------------------------

test('connections are checked, saved, and say when a change waits for the next start', async () => {
  const d = await boot();
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const post = (body: unknown) => call(d.port, 'POST', '/api/settings/connections', { cookie: setup, body });

    const bad = await post({ atemHost: '10.0.100' });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json['error']), /not an address the desk can use for the switcher address/);
    const wrongKey = await post({ deskPin: '1234' });
    assert.equal(wrongKey.status, 400, 'a code sent here is refused by name, never read as saved');
    assert.match(String(wrongKey.json['error']), /Not something this page sets: "deskPin"/);
    assert.equal((await call(d.port, 'POST', '/api/settings/connections', { cookie: setup })).status, 400,
      'no body');
    assert.equal((await call(d.port, 'POST', '/api/settings/connections', { body: { atemHost: '10.0.100.40' } })).status,
      401, 'no session');
    const deskOnly = await signIn(d.port, '/api/auth', CODES.REMOTE_PIN);
    assert.equal((await call(d.port, 'POST', '/api/settings/connections',
      { cookie: deskOnly, body: { atemHost: '10.0.100.40' } })).status, 403, 'the desk PIN alone');

    const ok = await post({ fieldHost: '10.0.100.5', atemHost: '10.0.100.40', graphicsInput: '6' });
    assert.deepEqual(ok.json, { ok: true, restartNeeded: [] });
    assert.deepEqual(d.settings.resolved.connections.atemHost, '10.0.100.40');
    assert.equal(d.settings.resolved.graphicsInput, 6);
    assert.deepEqual(JSON.parse(readFileSync(join(d.root, 'data', 'settings.json'), 'utf8')).connections,
      { fieldHost: '10.0.100.5', atemHost: '10.0.100.40' });

    // The field is found at .5; moving the address elsewhere waits a start.
    d.field.attach({ client: { connected: true, audit: [] } } as unknown as CheesyAdapter, '10.0.100.5:8080');
    assert.deepEqual((await post({ fieldHost: '10.0.100.5:8080' })).json, { ok: true, restartNeeded: [] });
    assert.deepEqual((await post({ fieldHost: '10.0.100.6' })).json, { ok: true, restartNeeded: ['fieldHost'] });
    // '' clears.
    assert.deepEqual((await post({ fieldHost: '', graphicsInput: null })).json, { ok: true, restartNeeded: [] });
    assert.equal(d.settings.resolved.connections.fieldHost, null);
    assert.equal(d.settings.resolved.graphicsInput, null);
  } finally {
    await d.done();
  }
});

// ---- POST /api/settings/code ----------------------------------------------------------

test('a wrong current code changes nothing, and counts on that code\'s own lockout', async () => {
  const d = await boot();
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    for (let i = 0; i < 5; i++) {
      const r = await call(d.port, 'POST', '/api/settings/code',
        { cookie: setup, body: { which: 'settings', current: String(1000 + i), next: '55555' } });
      assert.equal(r.status, 401, `guess ${i + 1}`);
      assert.match(String(r.json['error']), /not the current settings code, so nothing was changed/);
    }
    const sixth = await call(d.port, 'POST', '/api/settings/code',
      { cookie: setup, body: { which: 'settings', current: CODES.SETUP_PIN, next: '55555' } });
    assert.equal(sixth.status, 429, 'locked out, even with the right code now');
    // The same counter as the settings sign-in door: no cheaper channel.
    assert.equal((await call(d.port, 'POST', '/api/setup/auth', { body: { pin: CODES.SETUP_PIN } })).status, 429);
    assert.equal(d.settings.resolved.codes.settings, CODES.SETUP_PIN);
    assert.ok(!existsSync(join(d.root, 'data', 'settings.json')), 'nothing written');
  } finally {
    await d.done();
  }
});

test('the desk PIN changes only from the desk laptop, writes desk-pin.txt, and signs every desk session out', async () => {
  const d = await boot();
  const sockets: WebSocket[] = [];
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const desk = await signIn(d.port, '/api/auth', CODES.REMOTE_PIN);
    const change = { which: 'desk', current: CODES.REMOTE_PIN, next: '86420' };

    // Another computer, even with a settings session and the right PIN.
    const away = await call(d.port, 'POST', '/api/settings/code',
      { cookie: setup, host: `172.22.0.23:${d.port}`, body: change });
    assert.equal(away.status, 403);
    assert.match(String(away.json['error']), /only be changed on the desk laptop itself/);
    // A page on the desk laptop that named itself something else (DNS rebinding).
    assert.equal((await call(d.port, 'POST', '/api/settings/code',
      { cookie: setup, host: `attacker.example:${d.port}`, body: change })).status, 403);
    assert.ok(!existsSync(join(d.root, 'desk-pin.txt')));

    // A desk console's socket, signed in by its cookie.
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=desk`, { headers: { cookie: desk } });
    // And an overlay, which never had the PIN and must stay on air.
    const overlay = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=program`);
    sockets.push(ws, overlay);
    // Bounded, so a socket that is never closed fails the test instead of hanging it.
    const closed = new Promise<number>(res => {
      ws.once('close', code => res(code));
      setTimeout(() => res(-1), 3000).unref();
    });
    for (const s of sockets) {
      await new Promise<void>((res, rej) => {
        if (s.readyState === WebSocket.OPEN) return res();
        s.once('open', () => res()); s.once('error', rej);
      });
    }

    const { log } = console;
    const said: string[] = [];
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    let ok: Reply;
    try {
      ok = await call(d.port, 'POST', '/api/settings/code', { cookie: setup, body: change });
    } finally {
      console.log = log;
    }
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true });
    assert.equal(ok.cookie, null, 'the caller is on the settings code, which did not change: no desk session handed out');
    assert.equal(readFileSync(join(d.root, 'desk-pin.txt'), 'utf8'), '86420\r\n', 'what the launcher reads next start');
    assert.ok(said.some(l => /the desk PIN was changed/.test(l)));
    assert.ok(said.every(l => !l.includes('86420') && !l.includes(CODES.REMOTE_PIN)), 'never the code in the log');

    // Every desk session made with the old PIN is gone, the socket included.
    assert.equal(await closed, 4001, 'the signed-in socket is closed, and its page goes to sign in');
    assert.equal(overlay.readyState, WebSocket.OPEN, 'the overlay is left alone');
    assert.equal((await call(d.port, 'GET', '/api/auth/status', { cookie: desk })).json['authed'], false);
    assert.equal((await call(d.port, 'GET', '/api/vitals', { cookie: desk })).status, 401);
    assert.equal((await call(d.port, 'POST', '/api/auth', { body: { pin: CODES.REMOTE_PIN } })).status, 401,
      'the old PIN is dead');
    const fresh = await signIn(d.port, '/api/auth', '86420');
    assert.equal((await call(d.port, 'GET', '/api/auth/status', { cookie: fresh })).json['authed'], true);
    // The header door (Stream Deck buttons) moves with it.
    assert.equal((await call(d.port, 'GET', '/api/screens', { pin: '86420' })).status, 200);
    // The settings session was not touched: that code did not change.
    assert.equal((await call(d.port, 'GET', '/api/settings', { cookie: setup })).status, 200);
  } finally {
    for (const s of sockets) s.terminate();
    await d.done();
  }
});

test('the settings code changes at once, signs every settings session out, and keeps the changer signed in', async () => {
  const d = await boot();
  try {
    const mine = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const other = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const r = await call(d.port, 'POST', '/api/settings/code',
      { cookie: mine, host: `172.22.0.23:${d.port}`, body: { which: 'settings', current: CODES.SETUP_PIN, next: '97531' } });
    assert.equal(r.status, 200, 'the settings code may be changed from the content lead\'s own laptop');
    assert.ok(r.cookie, 'a fresh session for the person who changed it');
    assert.equal((await call(d.port, 'GET', '/api/settings', { cookie: other })).status, 401, 'the old session is gone');
    assert.equal((await call(d.port, 'GET', '/api/settings', { cookie: mine })).status, 401, 'the old cookie too');
    assert.equal((await call(d.port, 'GET', '/api/settings', { cookie: r.cookie })).status, 200);
    assert.equal((await call(d.port, 'POST', '/api/setup/auth', { body: { pin: CODES.SETUP_PIN } })).status, 401);
    assert.equal((await call(d.port, 'POST', '/api/setup/auth', { body: { pin: '97531' } })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(d.root, 'data', 'settings.json'), 'utf8')),
      { codes: { settings: '97531' } });

    // The awards code is not this page's to change.
    const awards = await call(d.port, 'POST', '/api/settings/code',
      { cookie: r.cookie, body: { which: 'awards', current: CODES.JA_PIN, next: '11223' } });
    assert.equal(awards.status, 400);
    assert.match(String(awards.json['error']), /Judge Advisor page/);
    const shape = await call(d.port, 'POST', '/api/settings/code',
      { cookie: r.cookie, body: { which: 'settings', current: '97531', next: '12' } });
    assert.equal(shape.status, 400);
    assert.match(String(shape.json['error']), /4 to 8 digits/);
  } finally {
    await d.done();
  }
});

test('a new code that is another code is refused without saying which, and counts as a guess at that code', async () => {
  const d = await boot();
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const answers = new Set<string>();
    for (let i = 0; i < 5; i++) {
      // The awards code, the one secret the settings tier must never reach.
      const r = await call(d.port, 'POST', '/api/settings/code',
        { cookie: setup, body: { which: 'settings', current: CODES.SETUP_PIN, next: CODES.JA_PIN } });
      assert.equal(r.status, 409);
      answers.add(String(r.json['error']));
    }
    assert.deepEqual([...answers], ['That code cannot be used here: pick a different one.']);
    // Five of those are five wrong guesses at the awards door: walking the
    // keyspace this way is no faster than at the Judge Advisor's sign-in.
    assert.equal((await call(d.port, 'POST', '/api/awards/auth', { body: { pin: CODES.JA_PIN } })).status, 429);
    assert.equal(d.settings.resolved.codes.settings, CODES.SETUP_PIN, 'nothing changed');
  } finally {
    await d.done();
  }
});

// ---- POST /api/awards/code ------------------------------------------------------------

test('the awards code is the Judge Advisor\'s to change, and every awards session goes with the old one', async () => {
  const d = await boot();
  try {
    const desk = await signIn(d.port, '/api/auth', CODES.REMOTE_PIN);
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const change = { current: CODES.JA_PIN, next: '11223' };
    assert.equal((await call(d.port, 'POST', '/api/awards/code', { cookie: desk, body: change })).status, 403,
      'the desk PIN cannot change it');
    assert.equal((await call(d.port, 'POST', '/api/awards/code', { cookie: setup, body: change })).status, 401,
      'nor the settings code: it opens nothing under /api/awards');
    const ja = await signIn(d.port, '/api/awards/auth', CODES.JA_PIN);
    const tablet = await signIn(d.port, '/api/awards/auth', CODES.JA_PIN);
    const wrong = await call(d.port, 'POST', '/api/awards/code', { cookie: ja, body: { current: '0000', next: '11223' } });
    assert.equal(wrong.status, 401);

    const ok = await call(d.port, 'POST', '/api/awards/code', { cookie: ja, host: `172.22.0.23:${d.port}`, body: change });
    assert.equal(ok.status, 200, 'from the Judge Advisor\'s own tablet');
    // An award write: the old session no longer gets past the door, the
    // fresh one does (and finds no ceremony configured on this test desk).
    const clear = { action: 'clear' };
    assert.equal((await call(d.port, 'POST', '/api/awards', { cookie: tablet, body: clear })).status, 401,
      'the other tablet is signed out');
    assert.equal((await call(d.port, 'POST', '/api/awards', { cookie: ja, body: clear })).status, 401,
      'and so is the cookie it was changed with');
    assert.equal((await call(d.port, 'POST', '/api/awards', { cookie: ok.cookie, body: clear })).status, 503);
    assert.equal(d.settings.resolved.codes.awards, '11223');
    assert.equal((await call(d.port, 'POST', '/api/awards/auth', { body: { pin: CODES.JA_PIN } })).status, 401);
  } finally {
    await d.done();
  }
});

test('with no separate settings code, the page that changes the desk PIN stays signed in with the new one', async () => {
  const d = await boot({ codes: { REMOTE_PIN: '4726', JA_PIN: '2580', SETUP_PIN: '' } });
  try {
    const desk = await signIn(d.port, '/api/auth', '4726');
    const other = await signIn(d.port, '/api/auth', '4726');
    const r = await call(d.port, 'POST', '/api/settings/code',
      { cookie: desk, body: { which: 'desk', current: '4726', next: '86420' } });
    assert.equal(r.status, 200);
    assert.ok(r.cookie?.startsWith('desk_auth='), 'a fresh desk session for the person who changed it');
    assert.equal((await call(d.port, 'GET', '/api/auth/status', { cookie: r.cookie })).json['authed'], true);
    assert.equal((await call(d.port, 'GET', '/api/settings', { cookie: r.cookie })).status, 200,
      'the settings page that made the change still reads');
    // Everybody else signed in with the old PIN is still signed out.
    assert.equal((await call(d.port, 'GET', '/api/auth/status', { cookie: other })).json['authed'], false);
    assert.equal((await call(d.port, 'GET', '/api/auth/status', { cookie: desk })).json['authed'], false,
      'and the cookie it was changed with');
  } finally {
    await d.done();
  }
});

test('the awards code and the desk PIN open none of the settings page\'s routes', async () => {
  const d = await boot();
  try {
    const ja = await signIn(d.port, '/api/awards/auth', CODES.JA_PIN);
    const toSettings = { which: 'settings', current: CODES.SETUP_PIN, next: '55555' };
    const toDesk = { which: 'desk', current: CODES.REMOTE_PIN, next: '86420' };
    // The awards code opens /api/awards* and nothing else: not a read, not a
    // code, not the restart, not the screens list.
    for (const [method, path, body] of [
      ['GET', '/api/settings', undefined], ['POST', '/api/settings/code', toSettings],
      ['POST', '/api/settings/code', toDesk], ['POST', '/api/settings/restart', undefined],
      ['POST', '/api/settings/connections', { atemHost: '10.0.100.40' }], ['GET', '/api/screens', undefined],
    ] as const) {
      const r = await call(d.port, method, path, { cookie: ja, body });
      assert.equal(r.status, 401, `the awards code at ${method} ${path}`);
    }
    // The desk PIN, by cookie or by the hardware header, on the desk laptop
    // itself: past the desk door, and still not the settings code.
    const desk = await signIn(d.port, '/api/auth', CODES.REMOTE_PIN);
    for (const how of [{ cookie: desk }, { pin: CODES.REMOTE_PIN }]) {
      for (const [path, body] of [
        ['/api/settings/code', toSettings], ['/api/settings/code', toDesk], ['/api/settings/restart', undefined],
      ] as const) {
        const r = await call(d.port, 'POST', path, { ...how, body });
        assert.equal(r.status, 403, `the desk PIN (${Object.keys(how)[0]}) at ${path}`);
        assert.match(String(r.json['error']), /behind the settings code/);
      }
    }
    await sleep(300);
    assert.deepEqual(d.exits, [], 'nothing restarted');
    assert.equal(d.settings.resolved.codes.settings, CODES.SETUP_PIN);
    assert.equal(d.settings.resolved.codes.desk, CODES.REMOTE_PIN);
    assert.ok(!existsSync(join(d.root, 'desk-pin.txt')), 'nothing written');
    assert.ok(!existsSync(join(d.root, 'data', 'settings.json')));
  } finally {
    await d.done();
  }
});

test('a Nexus key too short to hint at shows no hint at all', async () => {
  const d = await boot();
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const read = async () => ((await call(d.port, 'GET', '/api/settings', { cookie: setup })).json['connections'] as
      { nexusKey: unknown }).nexusKey;
    assert.deepEqual(await read(), { set: false, hint: null });
    // Four characters of a seven-character key is most of it.
    assert.equal((await call(d.port, 'POST', '/api/settings/connections',
      { cookie: setup, body: { nexusKey: 'abc1234' } })).status, 200);
    assert.deepEqual(await read(), { set: true, hint: null });
    assert.equal((await call(d.port, 'POST', '/api/settings/connections',
      { cookie: setup, body: { nexusKey: 'abcd5678' } })).status, 200);
    assert.deepEqual(await read(), { set: true, hint: '5678' }, 'eight is enough to name it by its last four');
  } finally {
    await d.done();
  }
});

// ---- POST /api/settings/restart -------------------------------------------------------

test('a restart answers first, flushes the day, then exits with 75 for the launcher to start it again', async () => {
  const d = await boot();
  try {
    assert.equal((await call(d.port, 'POST', '/api/settings/restart')).status, 401);
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    const away = await call(d.port, 'POST', '/api/settings/restart', { cookie: setup, host: `172.22.0.23:${d.port}` });
    assert.equal(away.status, 403, 'only from the desk laptop');
    assert.deepEqual(d.exits, []);

    const r = await call(d.port, 'POST', '/api/settings/restart', { cookie: setup });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.deepEqual(d.exits, [], 'the answer goes out before the exit');
    for (let i = 0; i < 100 && !d.exits.length; i++) await sleep(20);
    assert.deepEqual(d.exits, [75]);
    assert.equal(d.flushed(), 1, 'the event log was flushed first');
    // A second press while it is going down does not start a second exit.
    await call(d.port, 'POST', '/api/settings/restart', { cookie: setup });
    await sleep(300);
    assert.deepEqual(d.exits, [75]);
  } finally {
    await d.done();
  }

  // A desk started by hand has nobody to bring it back: refused, said why.
  const byHand = await boot({ restartable: false });
  try {
    const setup = await signIn(byHand.port, '/api/setup/auth', CODES.SETUP_PIN);
    const r = await call(byHand.port, 'POST', '/api/settings/restart', { cookie: setup });
    assert.equal(r.status, 409);
    assert.match(String(r.json['error']), /not started by the CalGames exe/);
    await sleep(300);
    assert.deepEqual(byHand.exits, []);
  } finally {
    await byHand.done();
  }
});

test('whether the desk can restart is read from how it was started, when nobody says', async () => {
  // This test process was not started by the launcher.
  assert.ok(!process.argv.includes('--exit-with-parent'));
  const plain = await boot({ restartable: null });
  try {
    const setup = await signIn(plain.port, '/api/setup/auth', CODES.SETUP_PIN);
    const r = await call(plain.port, 'POST', '/api/settings/restart', { cookie: setup });
    assert.equal(r.status, 409, 'started by hand: nothing would bring it back');
    await sleep(300);
    assert.deepEqual(plain.exits, []);
  } finally {
    await plain.done();
  }

  // The launcher starts the desk with --exit-with-parent (C9).
  process.argv.push('--exit-with-parent');
  let byExe: Boot;
  try {
    byExe = await boot({ restartable: null });
  } finally {
    process.argv.splice(process.argv.indexOf('--exit-with-parent'), 1);
  }
  try {
    const setup = await signIn(byExe.port, '/api/setup/auth', CODES.SETUP_PIN);
    const r = await call(byExe.port, 'POST', '/api/settings/restart', { cookie: setup });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100 && !byExe.exits.length; i++) await sleep(20);
    assert.deepEqual(byExe.exits, [75]);
  } finally {
    await byExe.done();
  }
});

// ---- the field, attached late (C3, C6) -------------------------------------------------

test('a field found after the start is the server\'s field from that moment, everywhere it asks', async () => {
  const d = await boot();
  try {
    d.field.setSearching(true);
    const desk = await signIn(d.port, '/api/auth', CODES.REMOTE_PIN);
    assert.deepEqual((await call(d.port, 'GET', '/api/info')).json, { mode: 'normal', field: { host: null } });
    assert.equal((await call(d.port, 'GET', '/api/cheesy', { cookie: desk })).json['bridged'], false);
    assert.match((await call(d.port, 'GET', '/', { host: `172.22.0.23:${d.port}` })).body,
      /<b>Field:<\/b> searching for the field by itself/);
    assert.equal((await call(d.port, 'POST', '/api/sample', { cookie: desk })).status, 200,
      'sample data while there is no field');

    const adapter = { client: { connected: true, audit: [{ ts: 1, method: 'GET', status: 200, url: '/x' }] },
      timingMismatch: null } as unknown as CheesyAdapter;
    d.field.attach(adapter, '10.0.100.5:8080');

    assert.deepEqual((await call(d.port, 'GET', '/api/info')).json,
      { mode: 'normal', field: { host: '10.0.100.5:8080' } }, 'the program page learns where Cheesy is');
    const cheesy = (await call(d.port, 'GET', '/api/cheesy', { cookie: desk })).json;
    assert.equal(cheesy['bridged'], true);
    assert.equal(cheesy['requests'], 1);
    assert.equal((await call(d.port, 'POST', '/api/sample', { cookie: desk })).status, 409,
      'and the demo guard holds the moment the field is there');
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    assert.deepEqual((await call(d.port, 'GET', '/api/settings', { cookie: setup })).json['field'],
      { host: '10.0.100.5:8080', connected: false, searching: false });
    assert.match((await call(d.port, 'GET', '/', { host: `172.22.0.23:${d.port}` })).body,
      /<b>Field:<\/b> (connecting now|not answering)/);

    d.bus.emit({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } });
    assert.equal(((await call(d.port, 'GET', '/api/settings', { cookie: setup })).json['field'] as
      { connected: boolean }).connected, true);
    const vitals = await new Vitals({ bus: d.bus, config: structuredClone(DEFAULTS), root: d.root,
      freeBytes: async () => 1024 ** 4, field: d.field }).report();
    const row = vitals.checks.find(c => c.id === 'field')!;
    assert.equal(row.level, 'ok');
    assert.equal(row.detail, 'connected to Cheesy Arena at 10.0.100.5:8080');
  } finally {
    await d.done();
  }
});

test('which codes are still the shipped defaults reaches the doors check on the desk laptop only', async () => {
  // The awards code left at its default, the other two set: the row would
  // name the awards code as public, which is the code that opens the winners.
  const d = await boot({ codes: { REMOTE_PIN: '4726', JA_PIN: undefined, SETUP_PIN: '3691' }, vitals: true });
  try {
    const desk = await signIn(d.port, '/api/auth', '4726');
    const here = await call(d.port, 'GET', '/api/vitals', { cookie: desk });
    assert.equal(here.status, 200);
    const row = (here.json['checks'] as { id: string; level: string; detail: string }[]).find(c => c.id === 'codes');
    assert.equal(row?.level, 'warn', 'the desk laptop is told');
    assert.match(row!.detail, /awards code/);

    for (const host of [`10.0.100.21:${d.port}`, `evil.example:${d.port}`]) {
      const far = await call(d.port, 'GET', '/api/vitals', { cookie: desk, host });
      assert.equal(far.status, 200, host);
      const checks = far.json['checks'] as { id: string; level: string }[];
      assert.ok(checks.length > 3, 'the rest of the doors check is still there');
      assert.equal(checks.find(c => c.id === 'codes'), undefined, `no Access codes row via ${host}`);
      assert.doesNotMatch(far.body, /shipped default|awards code/, `nothing about the defaults via ${host}`);
      // The dot is worked out from the rows that were sent, never the hidden one.
      const order = ['ok', 'unknown', 'warn', 'fail'];
      const worst = checks.filter(c => c.level !== 'off')
        .reduce((w, c) => (order.indexOf(c.level) > order.indexOf(w) ? c.level : w), 'ok');
      assert.equal(far.json['worst'], worst, `worst matches what was sent via ${host}`);
    }
  } finally {
    await d.done();
  }
});

test('a switcher address the watcher cannot dial is refused at Save, in its own words, and nothing is saved', async () => {
  const d = await boot();
  try {
    const setup = await signIn(d.port, '/api/setup/auth', CODES.SETUP_PIN);
    for (const atemHost of ['10.0.100.40:8080', 'atem.local']) {
      const r = await call(d.port, 'POST', '/api/settings/connections', { cookie: setup, body: { atemHost } });
      assert.equal(r.status, 400, atemHost);
      assert.match(String(r.json['error']), /names port 8080, but the switcher listens on 9910|is not a switcher address/);
      assert.equal(d.settings.resolved.connections.atemHost, null, `${atemHost} not saved`);
    }
    const ok = await call(d.port, 'POST', '/api/settings/connections', { cookie: setup, body: { atemHost: '10.0.100.40:9910' } });
    assert.equal(ok.status, 200);
    assert.equal(d.settings.resolved.connections.atemHost, '10.0.100.40:9910');
  } finally {
    await d.done();
  }
});
