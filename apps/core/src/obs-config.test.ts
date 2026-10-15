/**
 * The OBS connection as config.json describes it: the switch the packaged exe
 * has, since its launcher passes no --obs. And the one promise that comes
 * with putting a password in that file: it goes to OBS and nowhere else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { DEFAULTS, loadConfig, obsHost, obsPlan, redacted, type Config } from './config.ts';
import { EventContent } from './content.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { Vitals } from './vitals.ts';

/** loadConfig on a config.json holding `json`, and every line it printed while reading it. */
async function load(json: unknown): Promise<{ cfg: Config; said: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-obs-config-'));
  const lines: string[] = [];
  const { warn, log } = console;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify(json), 'utf8');
    const cfg = await loadConfig(dir);
    return { cfg, said: lines.join('\n') };
  } finally {
    console.warn = warn;
    console.log = log;
    await rm(dir, { recursive: true, force: true });
  }
}

test('OBS is off and on this laptop until config.json says otherwise', async () => {
  assert.deepEqual(DEFAULTS.obs, { enabled: false, host: '127.0.0.1:4455', password: '' });
  const { cfg } = await load({ event: { name: 'CalGames' } });
  assert.deepEqual(cfg.obs, DEFAULTS.obs);
  const plan = obsPlan(cfg, { env: {} });
  assert.equal(plan.enabled, false, 'a desk nobody configured never dials OBS');
  assert.match(plan.summary, /"obs": \{ "enabled": true \} in config\.json/);
});

test('the handbook\'s one line in config.json turns OBS on, with no command line at all', async () => {
  const { cfg, said } = await load({ obs: { enabled: true, password: 'Hx7-obs-handbook' } });
  assert.deepEqual(cfg.obs, { enabled: true, host: '127.0.0.1:4455', password: 'Hx7-obs-handbook' });
  const plan = obsPlan(cfg, { env: {} });
  assert.equal(plan.enabled, true, 'no --obs needed');
  assert.equal(plan.host, '127.0.0.1:4455');
  assert.equal(plan.password, 'Hx7-obs-handbook');
  assert.match(plan.summary, /turned on in config\.json/);
  assert.match(plan.summary, /password from config\.json/);
  assert.doesNotMatch(plan.summary + said, /Hx7-obs-handbook/, 'the password is never printed');
});

test('hand-edit slips are forgiven where the meaning is plain, and refused where it is not', async () => {
  const quoted = await load({ obs: { enabled: ' TRUE ', host: 'ws://127.0.0.1:4455/', password: 482913 } });
  assert.equal(quoted.cfg.obs.enabled, true, '"true" in quotes still means true');
  assert.equal(quoted.cfg.obs.host, '127.0.0.1:4455', 'pasted with the scheme and a slash');
  assert.equal(quoted.cfg.obs.password, '482913', 'digits typed without quotes');
  assert.equal(quoted.said, '', 'and none of that is worth a warning');

  const bad = await load({
    obs: { enabled: 'yes please', host: 'ws://:Pw-in-the-host@127.0.0.1:4455', password: { v: 'Pw-in-an-object' } },
  });
  assert.equal(bad.cfg.obs.enabled, false, 'unclear means off');
  assert.equal(bad.cfg.obs.host, '127.0.0.1:4455', 'an unusable host falls back to this laptop');
  assert.equal(bad.cfg.obs.password, '');
  assert.match(bad.said, /obs\.enabled should be true or false/);
  assert.match(bad.said, /obs\.host is not a host:port/);
  assert.match(bad.said, /obs\.password should be the text/);
  assert.doesNotMatch(bad.said, /Pw-in-the-host|Pw-in-an-object/, 'no warning echoes a password');

  // A section that is not a group of settings is dropped whole, as for any section.
  const scalar = await load({ obs: 'on' });
  assert.deepEqual(scalar.cfg.obs, DEFAULTS.obs);
  assert.match(scalar.said, /"obs" should be a group of settings/);
});

test('a host that would crash the WebSocket dial never reaches it', () => {
  // new WebSocket('ws://' + host) throws on a malformed URL, at boot.
  assert.equal(obsHost('127.0.0.1:4455'), '127.0.0.1:4455');
  assert.equal(obsHost('192.168.1.40'), '192.168.1.40:4455', 'a bare host gets OBS\'s port, not 80');
  assert.equal(obsHost('OBS-PC:4460'), 'obs-pc:4460');
  assert.equal(obsHost('[::1]:4455'), '[::1]:4455');
  assert.equal(obsHost('wss://127.0.0.1:4455'), '127.0.0.1:4455');
  for (const bad of ['', '   ', '127.0.0.1:70000', '127.0.0.1:0', '127.0.0.1:4455/obs',
    'user:pw@127.0.0.1', '127.0.0.1 4455', 'http://127.0.0.1:4455', null, undefined,
    // The port typed into the host box reads as an IPv4 number (0.0.17.103),
    // and an empty query or fragment quietly swapped the port for 4455.
    '4455', '0', '4455:4455', '127.0.0.1:4456?', '127.0.0.1:4455#']) {
    assert.equal(obsHost(bad), null, String(bad));
  }
});

test('the password comes from OBS_PASSWORD or config.json, and the flag still works', () => {
  const cfg = structuredClone(DEFAULTS);
  cfg.obs.password = 'Cfg-pw-31';

  // Off in config, on by the flag: a from-source start is unchanged.
  const flagged = obsPlan(cfg, { flag: true, host: '10.0.100.20:4455', env: {} });
  assert.equal(flagged.enabled, true);
  assert.equal(flagged.host, '10.0.100.20:4455');
  assert.match(flagged.summary, /--obs.*--obs-host/);

  // The environment overrides the file; an empty variable does not.
  const env = obsPlan(cfg, { flag: true, env: { OBS_PASSWORD: 'Env-pw-77' } });
  assert.equal(env.password, 'Env-pw-77');
  assert.match(env.summary, /password from OBS_PASSWORD/);
  assert.equal(obsPlan(cfg, { flag: true, env: { OBS_PASSWORD: '' } }).password, 'Cfg-pw-31');

  // Neither: no password, said as much.
  cfg.obs.password = '';
  const none = obsPlan(cfg, { flag: true, env: {} });
  assert.equal('password' in none, false);
  assert.match(none.summary, /no password/);

  for (const p of [flagged, env, none]) {
    assert.doesNotMatch(p.summary, /Cfg-pw-31|Env-pw-77/);
  }
});

test('the OBS password stays off every open, desk and settings API', async () => {
  /*
   * Every gate is open here (empty desk, awards and settings codes), so each
   * route answers with everything it would ever show anybody, and the
   * settings page is asked to write the obs section the way a hostile
   * request would.
   */
  const PW = 'Obs-pw-never-on-the-wire-5150';
  const saved = { desk: process.env['REMOTE_PIN'], ja: process.env['JA_PIN'], setup: process.env['SETUP_PIN'] };
  process.env['REMOTE_PIN'] = '';
  process.env['JA_PIN'] = '';
  process.env['SETUP_PIN'] = '';
  const dir = await mkdtemp(join(tmpdir(), 'cg-obs-api-'));
  const config = structuredClone(DEFAULTS);
  config.obs = { enabled: true, host: '127.0.0.1:4455', password: PW };
  const bus = new EventBus();
  const content = new EventContent(dir);
  await content.load();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1', config, content,
    vitals: new Vitals({ bus, config, root: dir, freeBytes: async () => 1024 ** 4, host: '127.0.0.1' }),
  });
  try {
    const port = await server.listening;
    const base = `http://127.0.0.1:${port}`;
    const routes = ['/api/state', '/api/setup', '/api/publish', '/api/vitals', '/api/urls',
      '/api/stream', '/api/cues', '/api/scenes', '/api/control-map', '/api/events/recent',
      '/api/auth/status', '/api/cheesy', '/api/recorder', '/api/audio'];
    for (const route of routes) {
      const res = await fetch(base + route);
      const body = await res.text();
      assert.ok(!body.includes(PW), `${route} (${res.status}) carries the OBS password`);
    }
    // The settings page answered for real, not with a locked door.
    assert.equal((await fetch(`${base}/api/setup`)).status, 200);

    const write = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'obs', value: { enabled: false, password: 'swapped' } }),
    });
    assert.ok(write.status >= 400, 'the settings page cannot write the obs section');
    assert.deepEqual(config.obs, { enabled: true, host: '127.0.0.1:4455', password: PW });
    await assert.rejects(() => content.set('obs', { password: 'x' }, config), /not editable from the desk/);
    assert.ok(!JSON.stringify(redacted(config)).includes(PW), 'nor the redacted config');
  } finally {
    server.close();
    for (const [key, val] of [['REMOTE_PIN', saved.desk], ['JA_PIN', saved.ja], ['SETUP_PIN', saved.setup]] as const) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a config.json the parser chokes on never prints the password, only where to look', async () => {
  // V8's JSON errors quote ten characters either side of the mistake, and the
  // commonest mistake is a password typed without quotes, or with curly ones.
  for (const [what, text] of [
    ['unquoted', '{\n  "obs": {\n    "enabled": true,\n    "password": Zq7RkT2mWx9Lp4Hd\n  }\n}\n'],
    ['curly quotes', '{\n  "obs": {\n    "enabled": true,\n    "password": \u201cZq7RkT2mWx9Lp4Hd\u201d\n  }\n}\n'],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'cg-obs-config-'));
    const lines: string[] = [];
    const { warn, log } = console;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      await writeFile(join(dir, 'config.json'), text!, 'utf8');
      const cfg = await loadConfig(dir);
      const said = lines.join('\n');
      assert.equal(cfg.obs.enabled, false, `${what}: defaults`);
      assert.doesNotMatch(said, /Zq7RkT/, `${what}: no part of the password`);
      assert.match(said, /near line 4/, `${what}: where to look`);
    } finally {
      console.warn = warn;
      console.log = log;
      await rm(dir, { recursive: true, force: true });
    }
  }
});
