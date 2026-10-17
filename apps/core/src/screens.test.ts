/**
 * Where every open page says it is showing: the hello frame (C1), the
 * registry that keeps it (C2), and GET /api/screens.
 *
 * The hello is the one frame a page with no PIN may send that the server
 * keeps, so these hold it to its promises: checked field by field, kept
 * against its own socket only, never on the bus, never echoed, gone when the
 * socket closes. The socket cases run the real server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { EventBus } from './bus.ts';
import { DEFAULTS } from './config.ts';
import { MediaLibrary } from './media.ts';
import { MAX_SCREENS, ScreenRegistry, validateHello } from './screens.ts';
import { startServer } from './server.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A hello as desk-client.js sends it from the switcher feed. */
const HELLO = {
  t: 'hello', surface: 'program', key: 'luma', embedded: false, full: true,
  w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk',
} as const;

// ---- the frame ----------------------------------------------------------------

test('a hello from the desk client is taken as it was sent', () => {
  const h = validateHello(HELLO);
  assert.deepEqual(h, {
    surface: 'program', key: 'luma', embedded: false, full: true,
    w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', backup: null,
  });
  // Nulls where the contract allows them: no key yet, a hidden page's rate,
  // a page that is not the program page.
  assert.ok(validateHello({ ...HELLO, key: null, hz: null, showing: null }));
  // A scaled Windows screen: 1536 CSS pixels at 125% is a 1920 signal.
  assert.equal(validateHello({ ...HELLO, sw: 1536, sh: 864, dpr: 1.25 })?.dpr, 1.25);
  assert.equal(validateHello({ ...HELLO, hz: 59.7 })?.hz, 60, 'a measured rate is rounded');
  assert.equal(validateHello({ ...HELLO, w: 1919.6 })?.w, 1920);
  // backup is an addition to C1: each of its words is kept, and a page from
  // before it (no backup at all) is still taken, as "not said".
  for (const word of ['none', 'ready', 'bad'] as const) {
    assert.equal(validateHello({ ...HELLO, backup: word })?.backup, word);
  }
  assert.equal(validateHello({ ...HELLO, backup: null })?.backup, null);
  assert.equal(validateHello(HELLO)?.backup, null, 'an older client sends none');
});

test('a hello with any one impossible field is dropped whole', () => {
  const bad: [string, unknown][] = [
    ['not an object', null], ['an array', [HELLO]], ['a string', 'hello'],
    ['another frame type', { ...HELLO, t: 'emit' }],
    ['no surface', { ...HELLO, surface: undefined }],
    ['a surface that is not an id', { ...HELLO, surface: 'program\n[auth] forged log line' }],
    ['a surface too long', { ...HELLO, surface: 'p'.repeat(33) }],
    ['a key nobody paints', { ...HELLO, key: 'chroma' }],
    ['embedded as text', { ...HELLO, embedded: 'false' }],
    ['full missing', { ...HELLO, full: undefined }],
    ['a negative width', { ...HELLO, w: -1 }],
    ['a width past 16K', { ...HELLO, sw: 40_000 }],
    ['a height that is not a number', { ...HELLO, h: '1080' }],
    ['infinity', { ...HELLO, sh: Infinity }],
    ['NaN', { ...HELLO, w: NaN }],
    ['a zero pixel ratio', { ...HELLO, dpr: 0 }],
    ['a pixel ratio of 50', { ...HELLO, dpr: 50 }],
    ['a rate of zero', { ...HELLO, hz: 0 }],
    ['a rate of a million', { ...HELLO, hz: 1e6 }],
    ['showing something else', { ...HELLO, showing: 'obs' }],
    ['a backup word nobody sends', { ...HELLO, backup: 'nope' }],
    ['a backup that is not a word', { ...HELLO, backup: true }],
  ];
  for (const [what, frame] of bad) assert.equal(validateHello(frame), null, what);
});

// ---- the registry ---------------------------------------------------------------

test('the registry keeps one entry per socket, nulls until its hello, and forgets it on close', () => {
  let t = 1000;
  const reg = new ScreenRegistry({ now: () => t });
  let changes = 0;
  reg.on('change', () => { changes += 1; });
  reg.add('a', { surface: 'program', addr: '::ffff:10.0.100.21' });
  t = 2000;
  reg.add('b', { surface: 'desk', addr: '127.0.0.1' });
  assert.equal(changes, 2);
  const [a] = reg.list();
  assert.deepEqual(a, {
    id: 'a', surface: 'program', addr: '10.0.100.21', since: 1000,
    key: null, embedded: null, full: null, w: null, h: null, sw: null, sh: null,
    dpr: null, hz: null, showing: null, backup: null,
  });

  assert.equal(reg.hello('a', { ...HELLO, full: false }), true);
  assert.equal(reg.list()[0]!.full, false);
  assert.equal(reg.list()[0]!.since, 1000, 'the hello keeps when the socket opened');
  assert.equal(reg.hello('a', { ...HELLO, w: -5 }), false, 'a bad frame changes nothing');
  assert.equal(reg.list()[0]!.w, 1920);
  assert.equal(reg.hello('nobody', HELLO), false, 'a socket it does not track');
  assert.equal(reg.list().length, 2);

  // A copy: a caller editing what it read does not edit the registry.
  reg.list()[0]!.surface = 'tampered';
  assert.equal(reg.list()[0]!.surface, 'program');

  reg.remove('a');
  assert.deepEqual(reg.list().map(s => s.id), ['b']);
  const before = changes;
  reg.remove('a');
  assert.equal(changes, before, 'removing twice is not a change');
});

test('the registry is capped, cleans the handshake tag, and a listener that throws stays inside it', () => {
  const reg = new ScreenRegistry();
  for (let i = 0; i < MAX_SCREENS + 5; i++) reg.add(String(i), { surface: 'quiz', addr: '10.1.1.1' });
  assert.equal(reg.list().length, MAX_SCREENS, 'a gym of phones cannot grow it without end');

  const quiet = new ScreenRegistry();
  quiet.add('x', { surface: 'pro<gram>\n', addr: '' });
  assert.equal(quiet.list()[0]!.surface, 'program');
  assert.equal(quiet.list()[0]!.addr, 'unknown');

  const { warn } = console;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  try {
    quiet.on('change', () => { throw new Error('secret 4726 in a message'); });
    assert.doesNotThrow(() => quiet.hello('x', HELLO));
    assert.doesNotThrow(() => quiet.remove('x'));
  } finally {
    console.warn = warn;
  }
  assert.ok(said.length >= 1);
  assert.ok(said.every(l => !l.includes('4726')), 'the listener\'s message is never copied into the log');
});

// ---- over the real socket -----------------------------------------------------------

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'cg-screens-'));
  const bus = new EventBus();
  const screens = new ScreenRegistry();
  const saved = process.env['REMOTE_PIN'];
  process.env['REMOTE_PIN'] = '4726';
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), mode: null, screens,
    configFile: () => ({ state: 'read', duplicates: [] }),
  });
  if (saved === undefined) delete process.env['REMOTE_PIN']; else process.env['REMOTE_PIN'] = saved;
  const port = await server.listening;
  return {
    bus, screens, port, base: `http://127.0.0.1:${port}`,
    done: async () => { server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function socket(port: number, surface: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?surface=${surface}`);
  const frames: { t?: string }[] = [];
  ws.on('message', m => frames.push(JSON.parse(String(m))));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  return { ws, frames };
}

const until = async (ok: () => boolean, what: string, ms = 2000): Promise<void> => {
  for (let i = 0; i < ms / 20; i++) { if (ok()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}`);
};

test('a page\'s hello needs no PIN, is kept against its own socket, and goes nowhere else', async () => {
  const d = await boot();
  const program = await socket(d.port, 'program');
  const other = await socket(d.port, 'side');
  try {
    await until(() => d.screens.list().length === 2, 'both sockets tracked');
    const recent = d.bus.recent.length;
    program.ws.send(JSON.stringify({ ...HELLO, full: false, sw: 1366, sh: 768 }));
    await until(() => d.screens.list().some(s => s.surface === 'program' && s.full === false), 'the hello');

    const mine = d.screens.list().find(s => s.surface === 'program')!;
    assert.equal(mine.addr, '127.0.0.1');
    assert.equal(mine.sw, 1366);
    assert.equal(d.screens.list().find(s => s.surface === 'side')!.full, null, 'the other socket is untouched');
    await sleep(60);
    assert.equal(d.bus.recent.length, recent, 'never on the bus');
    assert.ok(!other.frames.some(f => JSON.stringify(f).includes('1366')), 'never echoed to another socket');
    assert.ok(!program.frames.some(f => f.t === 'hello'), 'and no answer: no client waits for one');

    // A forged frame is dropped, and the socket stays up and keeps its last
    // report. After the hello floor, so it is the checks that drop it.
    await sleep(250);
    program.ws.send(JSON.stringify({ ...HELLO, surface: 'x'.repeat(500), hz: -1 }));
    program.ws.send('null');
    program.ws.send('{"t":"hello"');
    await sleep(80);
    assert.equal(program.ws.readyState, WebSocket.OPEN);
    assert.equal(d.screens.list().find(s => s.id === mine.id)!.sw, 1366);

    // The desk reads it, with the desk PIN, and nobody else does.
    assert.equal((await fetch(`${d.base}/api/screens`)).status, 401, 'the AV table\'s addresses need the PIN');
    const r = await fetch(`${d.base}/api/screens`, { headers: { 'x-desk-pin': '4726' } });
    assert.equal(r.status, 200);
    const body = await r.json() as { screens: { surface: string; full: boolean | null }[] };
    assert.ok(body.screens.some(s => s.surface === 'program' && s.full === false));

    program.ws.close();
    await until(() => !d.screens.list().some(s => s.id === mine.id), 'forgotten on close');
  } finally {
    program.ws.close();
    other.ws.close();
    await d.done();
  }
});

test('a hello cannot write: an unsigned page that says hello still cannot emit', async () => {
  const d = await boot();
  const page = await socket(d.port, 'program');
  try {
    page.ws.send(JSON.stringify(HELLO));
    page.ws.send(JSON.stringify({ t: 'emit', init: { type: 'screen.change', payload: { screen: 'final' } } }));
    await until(() => page.frames.some(f => f.t === 'denied'), 'the emit refused');
    assert.ok(!d.bus.recent.some(e => e.type === 'screen.change'));
  } finally {
    page.ws.close();
    await d.done();
  }
});

test('a flood of hellos from one socket costs one, and the next honest one is still taken', async () => {
  const d = await boot();
  const page = await socket(d.port, 'program');
  try {
    let changes = 0;
    d.screens.on('change', () => { changes += 1; });
    for (let i = 0; i < 50; i++) page.ws.send(JSON.stringify({ ...HELLO, sw: 1000 + i }));
    await until(() => d.screens.list().some(s => s.sw !== null), 'the first hello');
    await sleep(100);
    assert.equal(changes, 1, 'one change for fifty frames');
    assert.equal(d.screens.list().find(s => s.surface === 'program')!.sw, 1000, 'the first, not the last');
    await sleep(250);
    page.ws.send(JSON.stringify({ ...HELLO, sw: 1920 }));
    await until(() => d.screens.list().some(s => s.sw === 1920), 'a hello after the floor');
  } finally {
    page.ws.close();
    await d.done();
  }
});

test('the desk console reads the switcher with the desk PIN, in one shape with or without one', async () => {
  const d = await boot();
  try {
    assert.equal((await fetch(`${d.base}/api/atem`)).status, 401);
    const off = await (await fetch(`${d.base}/api/atem`, { headers: { 'x-desk-pin': '4726' } })).json();
    assert.deepEqual(off, {
      state: 'off', host: null, model: null, protocol: null, videoMode: null, program: null, preview: null,
      inputs: [], keyers: [], since: null, lastHeard: null, error: null, graphicsInput: null,
    });
  } finally {
    await d.done();
  }
});
