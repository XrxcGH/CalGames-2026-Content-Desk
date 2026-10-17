/**
 * The codes and connections the settings page sets (C4), as the Settings
 * class keeps them: which value wins, what reaches the disk and in what form,
 * and that nothing secret is ever logged. Real files in a scratch folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, type Config } from './config.ts';
import {
  DEFAULT_CODES, Settings, SettingsError, SettingsSaveError, parseHost, parseInput, parseKey, parseSwitcherHost,
} from './settings.ts';
import { AtemWatcher } from './atem/watcher.ts';

/** Set env vars for one test and put them back, whatever the test does. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void> | void) {
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

const NO_ENV = { REMOTE_PIN: undefined, JA_PIN: undefined, SETUP_PIN: undefined };

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'cg-settings-'));
  return { root, done: () => rm(root, { recursive: true, force: true }) };
}

/** Console output while `run` runs. */
function quietly<T>(run: () => T): { value: T; said: string } {
  const { warn, log } = console;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { return { value: run(), said: lines.join('\n') }; } finally { console.warn = warn; console.log = log; }
}

const cfg = (over: (c: Config) => void = () => {}): Config => {
  const c = structuredClone(DEFAULTS);
  over(c);
  return c;
};

test('a first start has nothing saved: the shipped defaults, and no problem to report', async () => {
  const s = await scratch();
  try {
    await withEnv(NO_ENV, () => {
      const { value: set, said } = quietly(() => Settings.load(s.root, cfg()));
      assert.deepEqual(set.resolved, {
        codes: { desk: DEFAULT_CODES.desk, awards: DEFAULT_CODES.awards, settings: DEFAULT_CODES.settings },
        connections: { fieldHost: null, atemHost: null, nexusKey: '' },
        graphicsInput: null,
      });
      assert.equal(set.problem, null);
      assert.equal(said, '', 'a missing file is the normal first start');
      assert.ok(set.isDefault('desk') && set.isDefault('awards') && set.isDefault('settings'));
    });
  } finally { await s.done(); }
});

test('which value wins: a change made now, then the environment, then the saved file, then config.json', async () => {
  const s = await scratch();
  try {
    mkdirSync(join(s.root, 'data'));
    writeFileSync(join(s.root, 'data', 'settings.json'), JSON.stringify({
      codes: { awards: '24680', settings: '13579' },
      connections: { fieldHost: '10.0.100.5', atemHost: '10.0.100.40', nexusKey: 'nexus-key-abcdef' },
      graphicsInput: 6,
    }));
    writeFileSync(join(s.root, 'desk-pin.txt'), '4726\r\nstray second line\r\n');
    const config = cfg(c => { c.awards.pin = '1111'; c.setup.pin = '2222'; c.nexus.apiKey = 'from-config'; });

    await withEnv(NO_ENV, () => {
      const set = Settings.load(s.root, config);
      assert.deepEqual(set.resolved.codes, { desk: '4726', awards: '24680', settings: '13579' },
        'the file over config.json, and desk-pin.txt by the launcher\'s own first-line rule');
      assert.deepEqual(set.resolved.connections,
        { fieldHost: '10.0.100.5', atemHost: '10.0.100.40', nexusKey: 'nexus-key-abcdef' });
      assert.equal(set.resolved.graphicsInput, 6);
    });

    await withEnv({ REMOTE_PIN: '9999', JA_PIN: ' 8888 ', SETUP_PIN: '7777' }, () => {
      const set = Settings.load(s.root, config);
      assert.deepEqual(set.resolved.codes, { desk: '9999', awards: '8888', settings: '7777' },
        'the environment over the file (tests and the preview tool set it)');
      // A change on the settings page wins even over the environment, which
      // is how it takes effect at once under the launcher's REMOTE_PIN.
      set.setCode('awards', '3141');
      assert.equal(set.resolved.codes.awards, '3141');
      set.setCode('desk', '2718');
      assert.equal(set.resolved.codes.desk, '2718');
    });

    // An explicitly empty desk PIN is the gate switched off, and is kept.
    await withEnv({ ...NO_ENV, REMOTE_PIN: '' }, () => {
      assert.equal(Settings.load(s.root, config).resolved.codes.desk, '');
    });

    // config.json under nothing saved; an unquoted number still a code.
    const bare = await scratch();
    try {
      await withEnv(NO_ENV, () => {
        const set = Settings.load(bare.root, cfg(c => { (c.awards as { pin: unknown }).pin = 2468; c.setup.pin = '2222'; }));
        assert.deepEqual(set.resolved.codes, { desk: DEFAULT_CODES.desk, awards: '2468', settings: '2222' });
        assert.equal(set.resolved.connections.nexusKey, '');
      });
    } finally { await bare.done(); }
  } finally { await s.done(); }
});

test('a broken settings file is set aside, said by name, and never quoted', async () => {
  const s = await scratch();
  try {
    mkdirSync(join(s.root, 'data'));
    const file = join(s.root, 'data', 'settings.json');
    await withEnv(NO_ENV, () => {
      writeFileSync(file, '{ "codes": { "awards": "24680", }');
      const torn = quietly(() => Settings.load(s.root, cfg()));
      assert.equal(torn.value.resolved.codes.awards, DEFAULT_CODES.awards);
      assert.match(torn.value.problem ?? '', /could not be read/);
      assert.match(torn.said, /\[settings\] data\/settings\.json could not be read/);
      assert.doesNotMatch(torn.said, /24680/);

      // One bad value is dropped by its key, the good ones kept.
      writeFileSync(file, JSON.stringify({
        codes: { awards: '12', settings: '13579' },
        connections: { fieldHost: 'http://10.0.100.5:8080/', atemHost: 'not an address!', nexusKey: 'has space in it' },
        graphicsInput: 'six',
        extra: { secret: 'x' },
      }));
      const part = quietly(() => Settings.load(s.root, cfg()));
      assert.equal(part.value.resolved.codes.awards, DEFAULT_CODES.awards);
      assert.equal(part.value.resolved.codes.settings, '13579');
      assert.equal(part.value.resolved.connections.fieldHost, '10.0.100.5:8080', 'a pasted URL is forgiven');
      assert.equal(part.value.resolved.connections.atemHost, null);
      assert.equal(part.value.resolved.graphicsInput, null);
      assert.match(part.said, /codes\.awards, connections\.atemHost, connections\.nexusKey, graphicsInput/);
      for (const v of ['13579', 'has space', 'not an address', '"12"']) {
        assert.ok(!part.said.includes(v), `"${v}" is not repeated`);
      }

      writeFileSync(file, '[1,2,3]');
      assert.match(quietly(() => Settings.load(s.root, cfg())).value.problem ?? '', /could not be read/);
    });
  } finally { await s.done(); }
});

test('addresses: host or host:port, a pasted URL forgiven, anything else refused in plain words', () => {
  assert.equal(parseHost('10.0.100.40', 'switcher address'), '10.0.100.40');
  assert.equal(parseHost(' HTTP://10.0.100.5:8080/ ', 'field address'), '10.0.100.5:8080');
  assert.equal(parseHost('cheesy-arena.local:08080', 'field address'), 'cheesy-arena.local:8080');
  assert.equal(parseHost('', 'field address'), null);
  assert.equal(parseHost(null, 'field address'), null);
  for (const bad of ['10.0.100', '10.0.100.256', '10.0.100.5:0', '10.0.100.5:70000', 'user:pw@10.0.100.5',
    '10.0.100.5/path', '10.0.100.5?x=1', 'two words', '-bad.local', 'a..b', 'ws://10.0.100.5', '::1']) {
    assert.throws(() => parseHost(bad, 'field address'), SettingsError, bad);
  }
  assert.throws(() => parseHost(42, 'field address'), /has to be text/);
  assert.match((() => { try { parseHost('10.0.100', 'field address'); } catch (e) { return (e as Error).message; } return ''; })(),
    /Type it like 10\.0\.100\.5/);

  // The switcher's address is held to what the switcher watcher can dial,
  // so a typo is refused at Save rather than saved and shown as a gray
  // "no switcher" once the next search writes over the watcher's error.
  assert.equal(parseSwitcherHost(' 10.0.100.40 '), '10.0.100.40');
  assert.equal(parseSwitcherHost('10.0.100.40:9910'), '10.0.100.40:9910');
  assert.equal(parseSwitcherHost(''), null);
  for (const bad of ['10.0.100.40:8080', 'atem.local', 'atem', '10.0.100']) {
    assert.throws(() => parseSwitcherHost(bad), SettingsError, bad);
    // Whatever Save lets through, the watcher takes without an error.
    const w = new AtemWatcher({ discover: false, log: () => {} });
    w.setHost(bad);
    assert.ok(w.status.error, `the watcher refuses ${bad} too`);
  }
  for (const good of ['10.0.100.40', '10.0.100.40:9910', '127.0.0.1']) {
    const w = new AtemWatcher({ discover: false, log: () => {} });
    w.setHost(parseSwitcherHost(good));
    assert.equal(w.status.error, null, `the watcher takes ${good}`);
  }
  assert.match((() => { try { parseSwitcherHost('10.0.100.40:8080'); } catch (e) { return (e as Error).message; } return ''; })(),
    /names port 8080, but the switcher listens on 9910/);

  assert.equal(parseKey('  abc-DEF_123  '), 'abc-DEF_123');
  assert.equal(parseKey(''), null);
  for (const bad of ['two words', 'tab\there', 'x'.repeat(300)]) {
    let msg = '';
    try { parseKey(bad); } catch (e) { msg = (e as Error).message; }
    assert.ok(msg && !msg.includes(bad.slice(0, 8)), 'refused, and the key is never echoed');
  }
  assert.equal(parseInput(6), 6);
  assert.equal(parseInput('7'), 7);
  assert.equal(parseInput(''), null);
  assert.throws(() => parseInput(-1), SettingsError);
  assert.throws(() => parseInput(1.5), SettingsError);
  assert.throws(() => parseInput(70000), SettingsError);
});

test('connections: saved atomically, a change said by key, and a restart named only when it is one', async () => {
  const s = await scratch();
  try {
    await withEnv(NO_ENV, () => {
      const set = Settings.load(s.root, cfg());
      const heard: string[][] = [];
      set.on('change', keys => heard.push(keys));

      const restart = set.setConnections({ atemHost: '10.0.100.40', nexusKey: 'nexus-key-abcdef', graphicsInput: 6 });
      assert.deepEqual(restart, []);
      assert.deepEqual(heard, [['atemHost', 'nexusKey', 'graphicsInput']]);
      const file = join(s.root, 'data', 'settings.json');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
        connections: { atemHost: '10.0.100.40', nexusKey: 'nexus-key-abcdef' }, graphicsInput: 6,
      });
      assert.ok(!existsSync(`${file}.tmp`), 'the temp file was renamed into place');

      assert.deepEqual(set.setConnections({ atemHost: '10.0.100.40' }), [], 'the same value is no change');
      assert.equal(heard.length, 1, 'and is not announced');

      // Not attached to a field: the finder re-aims, no restart.
      assert.deepEqual(set.setConnections({ fieldHost: '10.0.100.5' }), []);
      // Attached to that same field: "10.0.100.5" is 10.0.100.5:8080.
      assert.deepEqual(set.setConnections({ fieldHost: '10.0.100.5:8080' }, { fieldAttached: '10.0.100.5:8080' }), []);
      assert.deepEqual(set.setConnections({ fieldHost: '10.0.100.5' }, { fieldAttached: '10.0.100.5:8080' }), []);
      // Attached to another one: that takes the next start.
      assert.deepEqual(set.setConnections({ fieldHost: '10.0.100.6' }, { fieldAttached: '10.0.100.5:8080' }),
        ['fieldHost']);

      // A bad value changes nothing at all, including the good values beside it.
      const before = readFileSync(file, 'utf8');
      assert.throws(() => set.setConnections({ atemHost: '10.0.100.41', fieldHost: 'nope nope' }), SettingsError);
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(set.resolved.connections.atemHost, '10.0.100.40');

      // '' and null clear.
      set.setConnections({ atemHost: null, nexusKey: null, graphicsInput: null, fieldHost: null });
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
      assert.equal(set.resolved.connections.nexusKey, '');
    });
  } finally { await s.done(); }
});

test('codes: the desk PIN goes to desk-pin.txt the way the launcher reads it, the others to the settings file', async () => {
  const s = await scratch();
  try {
    await withEnv(NO_ENV, () => {
      const set = Settings.load(s.root, cfg());
      const heard: string[][] = [];
      set.on('change', keys => heard.push(keys));
      const { said } = quietly(() => {
        set.setCode('desk', '4726');
        set.setCode('settings', '13579');
        set.setCode('awards', '24680');
      });
      assert.equal(said, '', 'no code is ever logged');
      const pin = readFileSync(join(s.root, 'desk-pin.txt'));
      assert.equal(pin.toString('utf8'), '4726\r\n', 'the PIN and a line end');
      assert.notEqual(pin[0], 0xef, 'no byte-order mark: the launcher reads the first line as the PIN');
      assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'data', 'settings.json'), 'utf8')),
        { codes: { settings: '13579', awards: '24680' } }, 'the desk PIN is not in this file');
      assert.deepEqual(heard, [['codes.desk'], ['codes.settings'], ['codes.awards']]);
      assert.ok(heard.flat().every(k => !/\d{4}/.test(k)), 'the change names the code, never its value');

      // The next start reads both back.
      const again = Settings.load(s.root, cfg());
      assert.deepEqual(again.resolved.codes, { desk: '4726', awards: '24680', settings: '13579' });
      assert.ok(!again.isDefault('desk'));

      // The shape, and never the same as another code.
      assert.throws(() => set.setCode('settings', '12'), /4 to 8 digits/);
      assert.throws(() => set.setCode('settings', '123456789'), /4 to 8 digits/);
      assert.throws(() => set.setCode('settings', '12a4'), /4 to 8 digits/);
      assert.throws(() => set.setCode('settings', '4726'), /cannot be used/);
      assert.throws(() => set.setCode('desk', '24680'), /cannot be used/);
      assert.equal(set.resolved.codes.settings, '13579', 'a refused code changes nothing');
    });
  } finally { await s.done(); }
});

test('a disk that refuses the write changes nothing, and says so as a save failure', async () => {
  const s = await scratch();
  try {
    await withEnv(NO_ENV, () => {
      // A file where the data folder should be: mkdir and the write both fail.
      writeFileSync(join(s.root, 'data'), 'not a folder');
      const set = Settings.load(s.root, cfg());
      assert.throws(() => set.setCode('settings', '13579'), SettingsSaveError);
      assert.equal(set.resolved.codes.settings, DEFAULT_CODES.settings);
      let msg = '';
      try { set.setConnections({ atemHost: '10.0.100.40' }); } catch (e) { msg = (e as Error).message; }
      assert.match(msg, /could not save that, so nothing was changed/);
      assert.equal(set.resolved.connections.atemHost, null);
    });
  } finally { await s.done(); }
});
