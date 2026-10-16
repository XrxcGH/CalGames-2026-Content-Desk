/**
 * What the first screens a first-timer reads say about the desk itself: the
 * Start here box, the open /api/info the launcher reads, and the sign-in hop
 * between them. Plus what the open socket must never carry.
 *
 * The config.json cases run the real loadConfig on real files, and the last
 * case boots the real index.ts against a scratch folder (CG_DESK_ROOT), so the
 * wiring is proved without a word of it being assumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { EventBus } from './bus.ts';
import {
  DEFAULTS, configFileReport, launchMode, loadConfig, repeatedSections,
  type ConfigFileReport, type LaunchMode,
} from './config.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** loadConfig on a config.json holding exactly `text`, quietly. */
async function loadText(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-start-config-'));
  const { warn, log } = console;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
  try {
    await writeFile(join(dir, 'config.json'), text, 'utf8');
    const cfg = await loadConfig(dir);
    return { cfg, report: configFileReport(), said: said.join('\n') };
  } finally {
    console.warn = warn;
    console.log = log;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Set env vars for one test and put them back, whatever the test does. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await run(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function boot(opts: { mode?: LaunchMode | null; configFile?: () => ConfigFileReport; bus?: EventBus } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-start-'));
  const bus = opts.bus ?? new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), lanBase: 'http://172.22.0.23:8720',
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.configFile ? { configFile: opts.configFile } : {}),
  });
  const port = await server.listening;
  return {
    bus, port, base: `http://127.0.0.1:${port}`,
    done: async () => { server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

/** The front page as a browser naming the desk by `host` sees it. */
const page = (port: number, host: string): Promise<string> => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/', headers: { host } }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject).end();
});

/** Just the Start here box: the surface list below it names config.json too. */
const startBox = (html: string): string => {
  const from = html.indexOf('<div class="start">');
  return from < 0 ? '' : html.slice(from, html.indexOf('</div>', from));
};

// ---- config.json, as loadConfig reads it -----------------------------------

test('a config.json with a typo is remembered with its line, and never quoted', async () => {
  const { cfg, report } = await loadText(
    '{\n  "awards": { "pin": "2468" },\n  "obs": { "enabled": true, "password": Zq7Rk }\n}\n');
  assert.equal(cfg.obs.enabled, false, 'defaults, as before');
  assert.equal(report.state, 'unusable');
  assert.equal(report.reason, 'typo');
  assert.equal(report.line, 3);
  assert.doesNotMatch(JSON.stringify(report), /Zq7Rk|2468/, 'nothing typed into the file');

  // Curly quotes pasted from a document, and a missing comma: the line each
  // time, whichever way the parser words it.
  const curly = await loadText(
    '{\n  "setup": { "pin": "2468" },\n  "awards": { "pin": \u201c1470\u201d }\n}\n');
  assert.equal(curly.report.line, 3);
  assert.doesNotMatch(curly.said, /1470/);
  const comma = await loadText('{\n  "setup": { "pin": "2468" }\n  "obs": { "enabled": true }\n}\n');
  assert.equal(comma.report.line, 3);
  // The parser's quoted context starts on the line above the mistake here.
  const wrapped = await loadText('{\n  "obs": {\n    "enabled": true,\n    "password":\nZq7Rk\n  }\n}\n');
  assert.equal(wrapped.report.line, 5);

  const list = await loadText('[{ "obs": { "enabled": true } }]');
  assert.equal(list.report.state, 'unusable');
  assert.equal(list.report.reason, 'not-an-object');

  const dir = await mkdtemp(join(tmpdir(), 'cg-start-none-'));
  const { log } = console;
  console.log = () => {};
  try {
    await loadConfig(dir);
    assert.equal(configFileReport().state, 'missing');
  } finally {
    console.log = log;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a section pasted in twice is caught, with both lines, because JSON keeps the last silently', async () => {
  // The copied example already has an "obs" block near the end; the handbook's
  // line added near the top, comma and all, parses fine and leaves OBS off.
  const text = [
    '{',
    '  "obs": { "enabled": true, "password": "Hx7-secret" },',
    // Top-level VALUES that spell a section's name: a key, not a value, is a section.
    '  "//": "obs",',
    '  "name": "awards",',
    '  "//": "a comment, which the example file repeats",',
    '  "//": "and repeats again",',
    '  "awards": { "pin": "2468", "list": [ { "id": "obs", "title": "obs" } ] },',
    '  "publish": { "playlists": { "match": "", "segment": "" } },',
    '  "notASection": 1,',
    '  "notASection": 2,',
    '  "obs": {',
    '    "enabled": false',
    '  }',
    '}',
  ].join('\n');
  const { cfg, report, said } = await loadText(text);
  assert.equal(cfg.obs.enabled, false, 'the later one won, which is the problem');
  assert.equal(report.state, 'read');
  assert.deepEqual(report.duplicates, [{ section: 'obs', lines: [2, 11] }],
    'only the desk\'s own sections, at the top level, and never a value that looks like a key');
  assert.match(said, /"obs" appears 2 times in config\.json \(lines 2, 11\)/);
  assert.doesNotMatch(said, /Hx7-secret/);

  assert.deepEqual(repeatedSections('{"event":{"name":"a","name":"b"},"game":{}}'), [],
    'a repeat inside a section is not a repeated section');
  assert.deepEqual(repeatedSections('{"//":"obs","obs":{}}'), [],
    'a comment whose text is a section name is one section, not two');
  assert.deepEqual(repeatedSections('{"//" :\n "obs", "obs" : {}}'), [],
    'nor when the colon sits apart from the key');
  assert.deepEqual(repeatedSections('{"ev\\u0065nt":{},\n"event":{}}'),
    [{ section: 'event', lines: [1, 2] }], 'spelled as the parser reads it');
});

test('a config.json saved with a byte-order mark is read, not refused', async () => {
  // Notepad's "UTF-8 with BOM" and Windows PowerShell's Set-Content both
  // write one, and JSON.parse rejected the whole file over it at line 1.
  const { cfg, report } = await loadText('\uFEFF{ "obs": { "enabled": true } }');
  assert.equal(report.state, 'read');
  assert.equal(cfg.obs.enabled, true);
  assert.equal(report.ignored, undefined, 'a good file drops nothing');
});

test('a section that is not a group of settings is remembered by name, never by value', async () => {
  // "obs": true parses, is dropped for the defaults, and used to leave only a
  // log line while every screen said config.json was read and in use.
  const { cfg, report } = await loadText(JSON.stringify({
    obs: 'Hx7-secret',
    publish: { playlists: 'PLq9-secret' },
    awards: true,
    event: { name: 'CalGames 2026' },
    '//': 'a comment is not a section',
  }, null, 2));
  assert.equal(report.state, 'read');
  assert.deepEqual(report.ignored, ['obs', 'publish.playlists', 'awards']);
  assert.equal(cfg.obs.enabled, false, 'the defaults stand in for what was dropped');
  assert.doesNotMatch(JSON.stringify(report), /secret|true/, 'the names only');
});

test('the launch mode is read from the same flags index.ts reads', () => {
  assert.equal(launchMode(['node', 'index.ts']), null);
  assert.equal(launchMode(['node', 'index.ts', '--rehearsal']), 'rehearsal');
  assert.equal(launchMode(['node', 'index.ts', '--demo', '--rehearsal']), 'demo');
  assert.equal(launchMode(['node', 'index.ts', '--replay', 'x.ndjson']), 'replay');
  assert.equal(launchMode(['node', 'index.ts', '--cheesy']), null);
});

// ---- the Start here box --------------------------------------------------

test('a config.json the desk is not using is said on the Start here box, to this laptop only', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const d = await boot({
      mode: null,
      configFile: () => ({ state: 'unusable', reason: 'typo', line: 315, duplicates: [] }),
    });
    try {
      const here = await page(d.port, `localhost:${d.port}`);
      assert.match(here, /config\.json has a typo near line 315, so none of it is in use/);
      assert.match(here, /around line 315/);
      // Not "fine for practice": the codes are defaults because the file is broken.
      assert.match(here, /config\.json is not in use \(see above\)/);
      assert.doesNotMatch(here, /Fine for practice/);

      const other = await page(d.port, `172.22.0.23:${d.port}`);
      assert.doesNotMatch(other, /typo/, 'the desk\'s own file is the desk\'s business');
      assert.doesNotMatch(other, /4726/);
    } finally {
      await d.done();
    }
  });
});

test('a section written twice is a warning on the Start here box; a good file says nothing', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const dup = await boot({
      mode: null,
      configFile: () => ({ state: 'read', duplicates: [{ section: 'obs', lines: [2, 310] }] }),
    });
    const fine = await boot({ mode: null, configFile: () => ({ state: 'read', duplicates: [] }) });
    const shape = await boot({
      mode: null, configFile: () => ({ state: 'read', duplicates: [], ignored: ['obs'] }),
    });
    try {
      assert.match(startBox(await page(dup.port, `localhost:${dup.port}`)),
        /&quot;obs&quot; on lines 2 and 310/);
      assert.match(startBox(await page(shape.port, `localhost:${shape.port}`)),
        /class="warn"><b>config\.json gives &quot;obs&quot; something other than a group of settings/);
      const ok = startBox(await page(fine.port, `localhost:${fine.port}`));
      assert.match(ok, /Start here/);
      assert.doesNotMatch(ok, /config\.json/);
      assert.doesNotMatch(ok, /PRACTICE|REPLAY/);
    } finally {
      await dup.done();
      await fine.done();
      await shape.done();
    }
  });
});

test('practice is said at the top of the Start here box, to everyone', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const d = await boot({ mode: 'rehearsal' });
    try {
      for (const host of [`localhost:${d.port}`, `172.22.0.23:${d.port}`]) {
        const body = await page(d.port, host);
        const box = body.slice(body.indexOf('class="start"'));
        assert.match(box, /class="mode"><b>PRACTICE: started with \/rehearsal/, host);
        assert.match(box, /Task Manager/, host);
        assert.ok(box.indexOf('class="mode"') < box.indexOf('class="addr"'), `${host}: above the address`);
      }
    } finally {
      await d.done();
    }
  });
});

test('the Start here box says why other screens may not reach the address', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const d = await boot({ mode: null });
    try {
      const here = await page(d.port, `localhost:${d.port}`);
      assert.match(here, /If other screens cannot open this address, it is the Windows\s+Firewall on this laptop or a Wi-Fi that keeps devices apart/);
      assert.match(here, /chapter 11/);
      assert.ok(here.indexOf('Firewall') > here.indexOf('class="addr"'), 'under the address');
    } finally {
      await d.done();
    }
  });
});

// ---- /api/info, which the launcher reads ----------------------------------

test('/api/info tells the launcher, with no PIN, whether the desk is in practice', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    for (const [mode, want] of [['rehearsal', 'rehearsal'], ['demo', 'demo'], ['replay', 'replay'],
      [null, 'normal']] as const) {
      const d = await boot({ mode });
      try {
        const res = await fetch(`${d.base}/api/info`);
        assert.equal(res.status, 200, 'open: the launcher holds no PIN');
        assert.deepEqual(await res.json(), { mode: want });
      } finally {
        await d.done();
      }
    }
  });
});

// ---- the open socket -------------------------------------------------------

test('no phone on the venue Wi-Fi reads the desk\'s file paths off a replay event', async () => {
  const PATH = 'C:\\Users\\volunteer\\Downloads\\CalGames2026-ContentDesk\\rec\\clips\\q12.mp4';
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const d = await boot({ mode: null });
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=side`);
    const frames: { t?: string; ev?: { type?: string; payload?: Record<string, unknown> } }[] = [];
    ws.on('message', m => frames.push(JSON.parse(String(m))));
    try {
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      const clip = { path: PATH, url: '/clips/q12.mp4', sourceId: 'program', ranges: [],
        seconds: 8, speed: 1, label: 'Q12 climb' };
      d.bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: clip });
      d.bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, takeId: 't1' } });
      for (let i = 0; i < 50 && frames.filter(f => f.t === 'event').length < 2; i++) await sleep(20);

      const events = frames.filter(f => f.t === 'event');
      assert.equal(events.length, 2);
      for (const f of events) {
        assert.equal('path' in (f.ev?.payload ?? {}), false, `${f.ev?.type} carried a path`);
        assert.equal(f.ev?.payload?.['url'], '/clips/q12.mp4', 'the rest of the clip still goes');
        assert.equal(f.ev?.payload?.['label'], 'Q12 climb');
      }
      assert.equal(events[1]!.ev?.payload?.['takeId'], 't1');
      assert.ok(!frames.some(f => JSON.stringify(f).includes('volunteer')), 'not anywhere in any frame');

      // The cue engine plays from the bus in this process, so it still has it.
      const inProcess = d.bus.recent.filter(e => e.type.startsWith('replay.'));
      assert.ok(inProcess.every(e => (e.payload as { path?: string }).path === PATH));
    } finally {
      ws.close();
      await d.done();
    }
  });
});

test('an event type that is not text is refused at the socket, and never stops the fan-out', async () => {
  // A number got past the truthy check, was logged, and threw in the first
  // subscriber that read it as text: that event reached no screen, and a
  // stack trace landed in desk-log.txt for every such frame.
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const d = await boot({ mode: null });
    const { error } = console;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    const sender = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=desk`);
    const watcher = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=side`);
    type Frame = { t?: string; ok?: boolean; reason?: string; ev?: { type?: unknown } };
    const fromSender: Frame[] = [];
    const fromWatcher: Frame[] = [];
    sender.on('message', m => fromSender.push(JSON.parse(String(m))));
    watcher.on('message', m => fromWatcher.push(JSON.parse(String(m))));
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await sleep(20); };
    try {
      await Promise.all([sender, watcher].map(ws =>
        new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); })));
      sender.send(JSON.stringify({ t: 'auth', pin: '4726' }));
      await until(() => fromSender.some(f => f.t === 'auth'));
      assert.ok(fromSender.some(f => f.t === 'auth' && f.ok), 'signed in');

      const before = d.bus.recent.length;
      for (const type of [5, { x: 1 }, ['award.presented'], true]) {
        sender.send(JSON.stringify({ t: 'emit', init: { type, payload: { x: 1 } } }));
      }
      await until(() => fromSender.filter(f => f.t === 'denied').length >= 4);
      assert.equal(fromSender.filter(f => f.t === 'denied').length, 4, 'each one is answered');
      assert.equal(d.bus.recent.length, before, 'and none reached the log');

      // An emitter in this process is not checked at the socket; the fan-out
      // must still carry its event to every screen without throwing.
      d.bus.emit({ type: 7 as unknown as 'screen.change', payload: { screen: 'match' } });
      sender.send(JSON.stringify({ t: 'emit', init: { type: 'screen.change', payload: { screen: 'score' } } }));
      await until(() => fromWatcher.some(f => f.t === 'event' && f.ev?.type === 'screen.change'));
      const types = fromWatcher.filter(f => f.t === 'event').map(f => f.ev?.type);
      assert.deepEqual(types, [7, 'screen.change'], 'both went out, in order');
      assert.ok(!errors.some(e => /subscriber threw/.test(e)), errors.join('\n'));
    } finally {
      console.error = error;
      sender.close();
      watcher.close();
      await d.done();
    }
  });
});

// ---- what desk-log.txt says about the codes -----------------------------------

test('the desk\'s own startup lines name no code and say nothing about whether one is the default', async () => {
  // The launcher relays every line of this output into desk-log.txt, the file
  // a radio call asks for and a crew chat gets pasted. "The awards code is the
  // shipped default (1357)" there handed out the code that opens the staged
  // winners. The lines must be the same whatever the codes are.
  const linesWith = async (env: Record<string, string | undefined>): Promise<string[]> => {
    const said: string[] = [];
    const { log, warn } = console;
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    try {
      await withEnv(env, async () => {
        const d = await boot({ mode: null });
        await sleep(50);
        await d.done();
      });
    } finally {
      console.log = log;
      console.warn = warn;
    }
    return said.filter(l => l.startsWith('[auth]'));
  };
  const onDefaults = await linesWith({ REMOTE_PIN: undefined, JA_PIN: undefined, SETUP_PIN: undefined });
  const chosen = await linesWith({ REMOTE_PIN: '4726', JA_PIN: '2580', SETUP_PIN: '3691' });
  assert.ok(onDefaults.length > 0, 'it still says the controls are gated');
  for (const line of [...onDefaults, ...chosen]) {
    assert.doesNotMatch(line, /0864|1357|4567|4726|2580|3691/, line);
  }
  assert.deepEqual(onDefaults, chosen, 'nothing in the log tells the two apart');
});

test('no line the launcher writes to desk-log.txt is built from the PIN', () => {
  // The launcher is C#, built only on Windows, so this reads its source: every
  // WriteLog call, argument and all, and the lines it relays come from the
  // desk, which the test above holds to the same rule.
  const src = readFileSync(join(HERE, '..', '..', '..', 'tools', 'launcher', 'Launcher.cs'), 'utf8');
  const calls: string[] = [];
  for (let at = src.indexOf('WriteLog('); at >= 0; at = src.indexOf('WriteLog(', at + 1)) {
    if (/void\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue;   // the definition
    let depth = 0;
    let end = at + 'WriteLog'.length;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    calls.push(src.slice(at, end + 1));
  }
  assert.ok(calls.length > 5, 'found the calls');
  assert.ok(calls.some(c => c.includes('READY on')), 'including the ready line');
  for (const c of calls) assert.doesNotMatch(c, /\bPin\b|DefaultPin|PinGiven/, c);
});

// ---- the sign-in hop ---------------------------------------------------------

/** Run signin.html's own script against a stubbed page, and submit the right PIN. */
async function signIn(search: string, hash: string): Promise<string[]> {
  const html = readFileSync(join(HERE, '..', '..', '..', 'surfaces', '_shared', 'signin.html'), 'utf8');
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'signin.html has its script');
  const replaced: string[] = [];
  type Submit = (e: { preventDefault(): void }) => Promise<void>;
  const form: { submit?: Submit } = {};
  const el = () => ({
    textContent: '', value: '2468', select() {},
    addEventListener(_t: string, fn: Submit) { form.submit = fn; },
  });
  const location = { search, hash, replace: (to: string) => { replaced.push(to); } };
  const fetch = async () => ({ ok: true, json: async () => ({}) });
  const document = { getElementById: () => el() };
  new Function('document', 'location', 'fetch', 'URLSearchParams', script!)(
    document, location, fetch, URLSearchParams);
  assert.ok(form.submit, 'the form is wired');
  await form.submit({ preventDefault() {} });
  return replaced;
}

test('signing in returns to the very section the link pointed at', async () => {
  // The Start here box links to /s/desk#sec-sample; the browser carries the
  // fragment through the redirect to /signin, and it was dropped after the PIN.
  assert.deepEqual(await signIn('?next=%2Fs%2Fdesk', '#sec-sample'), ['/s/desk#sec-sample']);
  assert.deepEqual(await signIn('?next=%2Fs%2Fdesk', ''), ['/s/desk']);
  // Still only ever a path on this desk.
  assert.deepEqual(await signIn('?next=%2F%2Fevil.example', '#sec-sample'), ['/#sec-sample']);
});

// ---- the real boot -----------------------------------------------------------

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const { port } = srv.address() as { port: number };
  await new Promise<void>(res => srv.close(() => res()));
  return port;
}

test('the real desk, started in rehearsal on a broken config.json, says both where a first-timer looks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cg-start-boot-'));
  await writeFile(join(root, 'config.json'),
    '{\n  "setup": { "pin": "2468" },\n  "obs": { "enabled": true "password": "x" }\n}\n', 'utf8');
  const port = await freePort();
  const drop = new Set(['PATH', 'LOCALAPPDATA', 'OBS_PASSWORD', 'REMOTE_PIN', 'JA_PIN', 'SETUP_PIN',
    'HOST', 'PORT', 'LAN_IP', 'CG_DESK_ROOT', 'CG_PREVIEW_DESK']);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k.toUpperCase())) env[k] = v;
  const child = spawn(process.execPath, [
    '--experimental-strip-types', join(HERE, 'index.ts'), '--port', String(port), '--rehearsal',
    '--exit-with-parent',
  ], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    // No ffmpeg and no winget folder, so the boot does not stop to probe encoders.
    env: { ...env, PATH: dirname(process.execPath), LOCALAPPDATA: root, CG_DESK_ROOT: root,
      HOST: '127.0.0.1', REMOTE_PIN: '', JA_PIN: '', SETUP_PIN: '' },
  });
  let out = '';
  child.stdout.on('data', c => { out += String(c); });
  child.stderr.on('data', c => { out += String(c); });
  const gone = new Promise<void>(res => child.on('exit', () => res()));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) {
      try { up = (await fetch(`${base}/api/state`)).ok; } catch { await sleep(100); }
    }
    assert.ok(up, `the desk never answered:\n${out}`);

    assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), { mode: 'rehearsal' });

    const front = await (await fetch(`${base}/`)).text();
    assert.match(front, /PRACTICE: started with \/rehearsal/);
    assert.match(front, /config\.json has a typo near line 3, so none of it is in use/);

    const vitals = await (await fetch(`${base}/api/vitals`)).json() as
      { checks: { id: string; level: string }[]; blockers: { id: string }[] };
    assert.equal(vitals.checks.find(c => c.id === 'config-file')?.level, 'fail');
    assert.equal(vitals.checks.find(c => c.id === 'mode')?.level, 'warn');
    assert.ok(vitals.blockers.some(b => b.id === 'config-file'));
    assert.ok(vitals.blockers.some(b => b.id === 'mode'));
  } finally {
    child.stdin.end();
    await Promise.race([gone, new Promise(r => setTimeout(r, 8000).unref())]);
    child.kill();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
