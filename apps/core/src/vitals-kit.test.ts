/**
 * The doors check for the AV kit: the Switcher row, the Screens row, the
 * gray rows for hardware a setup does not have, and the codes as the
 * settings page leaves them.
 *
 * The switcher case runs the real read-only watcher against the in-process
 * ATEM emulator dressed as the travel rack (fake-atem.ts KIT): a Constellation
 * at 1080p59.94, Cheesy's overlay on input 6 keyed on DSK1. The screens cases
 * feed the registry real hello frames through validateHello.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { DEFAULTS } from './config.ts';
import { AtemWatcher, type AtemStatus } from './atem/watcher.ts';
import { FakeAtem, KIT } from './atem/fake-atem.ts';
import { matchUnderway } from './publish/queue.ts';
import { ScreenRegistry, type ScreenInfo } from './screens.ts';
import { Settings } from './settings.ts';
import {
  NO_SWITCHER, Vitals, screensVital, switcherVital, type Vital, type VitalsDeps,
} from './vitals.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (ok: () => boolean, what: string, ms = 4000): Promise<void> => {
  for (let i = 0; i < ms / 20; i++) { if (ok()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}`);
};

const base = (over: Partial<VitalsDeps> = {}): VitalsDeps => ({
  bus: new EventBus(), config: structuredClone(DEFAULTS), root: process.cwd(),
  freeBytes: async () => 1024 ** 4, ...over,
});
const row = async (deps: VitalsDeps, id: string): Promise<Vital | undefined> =>
  (await new Vitals(deps).report()).checks.find(c => c.id === id);

/** The rack's switcher, as the watcher reports it once connected. */
const RACK: AtemStatus = {
  state: 'connected', host: '10.0.100.40', model: 'ATEM Constellation 4K', protocol: '2.32',
  videoMode: { id: 13, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 },
  program: 1, preview: 2,
  inputs: [
    { id: 1, longName: 'Field Wide', shortName: 'WIDE' },
    { id: 6, longName: 'Graphics', shortName: 'GFX' },
    { id: 7, longName: 'Desk Program', shortName: 'DESK' },
    { id: 3010, longName: 'Media Player 1', shortName: 'MP1' },
  ],
  keyers: [
    { kind: 'upstream', me: 1, index: 1, onAir: false, type: 'dve', fillSource: 7, keySource: 0 },
    { kind: 'downstream', me: null, index: 1, onAir: true, type: 'luma', fillSource: 6, keySource: 6 },
    { kind: 'downstream', me: null, index: 2, onAir: false, type: 'luma', fillSource: 3010, keySource: 3010 },
  ],
  since: 1, lastHeard: 1, error: null,
};
const keyed = (on: boolean[]): AtemStatus => ({
  ...RACK, keyers: RACK.keyers.map((k, i) => ({ ...k, onAir: on[i] ?? false })),
});

// ---- the Switcher row ---------------------------------------------------------------

test('no switcher is gray, in the same plain words wherever it is said', () => {
  for (const st of [null, { ...RACK, state: 'off' as const }, { ...RACK, state: 'searching' as const }]) {
    const v = switcherVital(st);
    assert.equal(v.level, 'off');
    assert.equal(v.detail, 'No video switcher found on the network. Fine if this setup has none.');
    assert.equal(v.detail, NO_SWITCHER);
    assert.equal(v.fix, undefined);
  }
});

test('a switcher that is connecting, not answering or lost says so, and what to check', () => {
  assert.equal(switcherVital({ ...RACK, state: 'connecting' }).level, 'unknown');
  const typo = switcherVital({ ...RACK, state: 'connecting', error: 'Nothing answered at 10.0.100.41.' });
  assert.equal(typo.level, 'warn');
  assert.match(typo.detail, /not answering at 10\.0\.100\.40/);
  assert.match(typo.fix ?? '', /Nothing answered at 10\.0\.100\.41\. The desk keeps trying by itself/);
  const lost = switcherVital({ ...RACK, state: 'lost' });
  assert.equal(lost.level, 'warn');
  assert.match(lost.detail, /lost the switcher at 10\.0\.100\.40, so what is on air is unknown/);
  assert.match(lost.fix ?? '', /network cable/);
});

test('a connected switcher is one line: model, address, format, program, and each key on air', () => {
  const v = switcherVital(RACK);
  assert.equal(v.level, 'ok');
  assert.equal(v.detail, 'ATEM Constellation 4K at 10.0.100.40 running 1080p59.94. Program: Field Wide. '
    + 'Keyed on air: DSK1 (Graphics).');
  assert.match(switcherVital(keyed([false, false, false])).detail, /No keys on air\./);
});

test('two overlays keyed at once is a warning; a picture-in-picture box with the score is not', () => {
  const two = switcherVital(keyed([false, true, true]));
  assert.equal(two.level, 'warn');
  assert.match(two.detail, /DSK1 \(Graphics\), DSK2 \(Media Player 1\)/);
  assert.match(two.detail, /2 overlays on air at once/);
  assert.match(two.fix ?? '', /take all but one of those keys off air/);
  assert.equal(switcherVital(keyed([true, true, false])).level, 'ok', 'a DVE box is not an overlay');
});

test('a match running with the graphics input keyed off is a warning naming that input', () => {
  const off = keyed([false, false, false]);
  const during = switcherVital(off, { graphicsInput: 6, matchRunning: true });
  assert.equal(during.level, 'warn');
  assert.match(during.detail, /graphics input \(Graphics\) is not keyed on air, so the stream shows no score/);
  assert.match(during.fix ?? '', /DSK 1/);
  assert.equal(switcherVital(off, { graphicsInput: 6, matchRunning: false }).level, 'ok', 'between matches it is fine');
  assert.equal(switcherVital(off, { graphicsInput: null, matchRunning: true }).level, 'ok', 'not set: nothing to hold it to');
  assert.equal(switcherVital(RACK, { graphicsInput: 6, matchRunning: true }).level, 'ok', 'keyed: fine');
  assert.equal(switcherVital(keyed([false, false, true]), { graphicsInput: 6, matchRunning: true }).level, 'warn',
    'another input keyed is not the graphics');
});

test('a switcher that turns the desk down, or an address it cannot use, is amber in the watcher\'s own words', async (t: TestContext) => {
  // Found by the search (no typed address), and refused: the watcher stays
  // "searching", which alone would read as no switcher at all.
  const fake = await FakeAtem.start({ log: () => {} });
  fake.refuseHellos();
  const found = new AtemWatcher({ discover: true, candidates: () => ['127.0.0.1'], port: fake.port, log: () => {} });
  t.after(async () => { await found.stop(); await fake.close(); });
  found.start();
  await until(() => /turned the desk down/.test(found.status.error ?? ''), 'the refusal');
  const refused = switcherVital(found.status);
  assert.equal(refused.level, 'warn', `${found.status.state}: ${refused.detail}`);
  assert.equal(refused.detail, 'there is a switcher, but it would not let the desk connect.');
  assert.match(refused.fix ?? '', /close any copy of ATEM Software Control nobody is using/);

  // An address with the wrong port, as the settings page lets through
  // (host:port), handed over live as index.ts does: never started, so
  // nothing goes on the network.
  const typo = new AtemWatcher({ discover: false, log: () => {} });
  typo.setHost('10.0.100.40:8080');
  const v = switcherVital(typo.status);
  assert.equal(v.level, 'warn', `${typo.status.state}: ${String(typo.status.error)}`);
  assert.equal(v.detail, 'the switcher address on the Event settings page cannot be used.');
  assert.match(v.fix ?? '', /names port 8080, but the switcher listens on 9910\. .*Change it on the Event settings page/);

  // Anything else while off or searching is still the gray "none found".
  for (const error of [null, 'No ATEM switcher answered on this network.']) {
    assert.equal(switcherVital({ ...typo.status, state: 'searching', error }).level, 'off', String(error));
  }
});

test('the real watcher on the travel rack feeds the Switcher row, and the row follows the panel', async (t: TestContext) => {
  const fake = await FakeAtem.start({ packetBudget: 400 });
  const atem = new AtemWatcher({ host: '127.0.0.1', discover: false, port: fake.port, log: () => {} });
  const root = await mkdtemp(join(tmpdir(), 'cg-vitals-kit-'));
  t.after(async () => { await atem.stop(); await fake.close(); await rm(root, { recursive: true, force: true }); });
  const settings = Settings.load(root, structuredClone(DEFAULTS));
  settings.setConnections({ graphicsInput: KIT.graphics });
  const bus = new EventBus();
  atem.start();
  await until(() => atem.status.state === 'connected' && atem.status.keyers.length > 0, 'connected to the rack');

  const deps = base({ bus, atem, settings, root });
  const ok = (await row(deps, 'switcher'))!;
  assert.equal(ok.level, 'ok', ok.detail);
  assert.match(ok.detail, /^ATEM Constellation 4K at 127\.0\.0\.1 running 1080p59\.94\. Program: Field Wide\./);
  assert.match(ok.detail, /Keyed on air: DSK1 \(Graphics\)\./);

  fake.setDskOnAir(2, true);
  await until(() => atem.status.keyers.filter(k => k.onAir).length === 2, 'DSK2 up');
  assert.match((await row(deps, 'switcher'))!.detail, /2 overlays on air at once/);

  fake.setDskOnAir(1, false);
  fake.setDskOnAir(2, false);
  await until(() => !atem.status.keyers.some(k => k.onAir), 'both keys down');
  assert.equal((await row(deps, 'switcher'))!.level, 'ok', 'no match yet');
  bus.emit({ type: 'match.loaded', source: 'manual',
    payload: { id: 'Q1', displayName: 'Qualification 1', red: [], blue: [] } });
  assert.ok(matchUnderway(bus.state));
  const noScore = (await row(deps, 'switcher'))!;
  assert.equal(noScore.level, 'warn');
  assert.match(noScore.detail, /graphics input \(Graphics\) is not keyed on air/);
});

// ---- the Screens row ------------------------------------------------------------------

/** One open page, as the registry would hold it after a hello. */
const page = (over: Partial<ScreenInfo> = {}): ScreenInfo => ({
  id: 'x', surface: 'program', addr: '10.0.100.21', since: 1, key: 'luma', embedded: false, full: true,
  w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', backup: null, ...over,
});

test('no program page anywhere is a warning that says which computer to open it on', () => {
  const v = screensVital([page({ surface: 'desk' }), page({ surface: 'quiz' })]);
  assert.equal(v.level, 'warn');
  assert.match(v.detail, /no program page is open anywhere/);
  assert.match(v.fix ?? '', /feeds the switcher's overlay input, open this desk's address with \/s\/program/);
  assert.match(v.fix ?? '', /F11/);
});

test('the clean second-stream feed is a program page too, held to the same checks', () => {
  const clean = screensVital([page({ surface: 'program-clean' })], { atem: RACK });
  assert.equal(clean.level, 'ok', clean.detail);
  assert.equal(clean.detail, 'the program graphics are open on 1 page: 10.0.100.21.');
  const windowed = screensVital([page({ surface: 'program-clean', full: false })], { atem: RACK });
  assert.equal(windowed.level, 'warn');
  assert.match(windowed.detail, /in a window, not full screen/);
  // A name that merely starts the same way is some other page.
  assert.match(screensVital([page({ surface: 'programs' })]).detail, /no program page is open anywhere/);
});

test('the switcher feed at the switcher\'s format, full screen, is all fine; a scaled Windows screen too', () => {
  const v = screensVital([page(), page({ id: 'y', addr: '127.0.0.1', embedded: true, key: 'fill', full: null })],
    { atem: RACK });
  assert.equal(v.level, 'ok', v.detail);
  assert.equal(v.detail, 'the program graphics are open on 2 pages: 10.0.100.21, this laptop.');
  assert.equal(screensVital([page({ sw: 1536, sh: 864, dpr: 1.25 })], { atem: RACK }).level, 'ok',
    '1536 CSS pixels at 125% is a 1920 signal');
  assert.equal(screensVital([page({ hz: 59 })], { atem: RACK }).level, 'ok', 'within two frames a second');
});

test('a window, a wrong resolution and a wrong refresh rate each name the computer and the fix', () => {
  const windowed = screensVital([page({ full: false })], { atem: RACK });
  assert.equal(windowed.level, 'warn');
  assert.match(windowed.detail, /The program page on 10\.0\.100\.21 is in a window, not full screen\./);
  assert.match(windowed.fix ?? '', /^On 10\.0\.100\.21, click the page and press F11\.$/);

  const small = screensVital([page({ sw: 1366, sh: 768 })], { atem: RACK });
  assert.equal(small.level, 'warn');
  assert.match(small.detail, /on a 1366x768 screen, but the switcher runs 1080p59\.94 \(1920x1080\)/);
  assert.match(small.fix ?? '', /Settings, System, Display.*Display resolution to 1920 x 1080/);

  const fast = screensVital([page({ hz: 75 })], { atem: RACK });
  assert.equal(fast.level, 'warn');
  assert.match(fast.detail, /refreshing at 75 Hz, but the switcher runs 1080p59\.94/);
  assert.match(fast.fix ?? '', /set the refresh rate to 60 Hz/);

  // An interlaced format runs the computer at the field rate.
  const i50 = { ...RACK, videoMode: { id: 6, label: '1080i50', width: 1920, height: 1080, fps: 25 } };
  assert.equal(screensVital([page({ hz: 50 })], { atem: i50 }).level, 'ok');
  assert.equal(screensVital([page({ hz: 60 })], { atem: i50 }).level, 'warn');

  // Only the switcher feed is held to the switcher's format: a projector page
  // (fill, or framed in /s/watch) and an OBS source run at their own sizes,
  // and with no switcher there is no format to hold anything to.
  for (const p of [page({ key: 'fill', sw: 1366, sh: 768 }), page({ embedded: true, sw: 1366, sh: 768 }),
    page({ key: 'alpha', hz: 144 })]) {
    assert.equal(screensVital([p], { atem: RACK }).level, 'ok', JSON.stringify(p));
  }
  assert.equal(screensVital([page({ sw: 1366, sh: 768, hz: 75 })]).level, 'ok');
  assert.equal(screensVital([page({ sw: 1366, sh: 768 })], { atem: { ...RACK, state: 'lost' } }).level, 'ok');
  // A page that never said hello (an old browser tab) is counted, never judged.
  assert.equal(screensVital([page({ full: null, key: null, sw: null, sh: null, dpr: null, hz: null })],
    { atem: RACK }).level, 'ok');
});

test('a program page showing Cheesy Arena\'s overlay is said, with why, and that it comes back by itself', () => {
  const down = screensVital([page({ showing: 'cheesy' })], { atem: RACK, fieldConnected: false });
  assert.equal(down.level, 'warn');
  assert.match(down.detail, /showing Cheesy Arena's own score overlay instead of the desk's, because the desk's field connection is down/);
  assert.match(down.fix ?? '', /switches back to the desk's graphics by itself/);
  const back = screensVital([page({ showing: 'cheesy' })], { atem: RACK, fieldConnected: true });
  assert.match(back.detail, /switches back by itself in a few seconds/);
});

test('the white page (see-through, in a plain browser, on a desk with no OBS) is named, with the address to open instead', () => {
  const white = page({ key: 'alpha', full: false });
  const v = screensVital([white], { atem: RACK, fieldConnected: true, obs: false });
  assert.equal(v.level, 'warn');
  assert.match(v.detail, /on 10\.0\.100\.21 is the see-through version made for OBS, so a plain browser shows it on white/);
  assert.match(v.fix ?? '', /open this desk's address with \/s\/program on the end and nothing after it, then press F11/);
  assert.doesNotMatch(v.detail, /in a window/, 'one thing to fix at a time: the address first');
  // A desk with OBS set up: that page is an OBS source, held to nothing.
  assert.equal(screensVital([page({ key: 'alpha' })], { atem: RACK, obs: true }).level, 'ok');
  // Not told whether there is OBS: no guess.
  assert.equal(screensVital([page({ key: 'alpha' })], { atem: RACK }).level, 'ok');
  // Framed in /s/watch is a projector page, never the switcher's.
  assert.equal(screensVital([page({ key: 'alpha', embedded: true })], { atem: RACK, obs: false }).level, 'ok');
});

test('the doors check names the white page only on a desk with no OBS', async () => {
  const screens = new ScreenRegistry();
  screens.add('w', { surface: 'program', addr: '10.0.100.21' });
  assert.ok(screens.hello('w', { t: 'hello', surface: 'program', key: 'alpha', embedded: false, full: true,
    w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk' }));
  const none = (await row(base({ screens }), 'screens'))!;
  assert.equal(none.level, 'warn');
  assert.match(none.detail, /see-through version made for OBS/);
  // Any OBS client at all means that page may be an OBS source: no accusation.
  const withObs = (await row(base({ screens, obs: {} as unknown as VitalsDeps['obs'] }), 'screens'))!;
  assert.doesNotMatch(withObs.detail, /see-through version/);
});

test('a switcher feed whose stand-in for the field is unreachable is said while the field is up', () => {
  const v = screensVital([page({ backup: 'bad' })], { atem: RACK, fieldConnected: true });
  assert.equal(v.level, 'warn');
  assert.match(v.detail, /on 10\.0\.100\.21 cannot reach Cheesy Arena's own score display, so if the desk stops, that input keeps its last picture/);
  assert.match(v.fix ?? '', /Put 10\.0\.100\.21 on the field network/);
  // The field down: the Field bridge row says so, and this would repeat it.
  assert.equal(screensVital([page({ backup: 'bad' })], { atem: RACK, fieldConnected: false }).level, 'ok');
  for (const backup of ['ready', 'none', null] as const) {
    assert.equal(screensVital([page({ backup })], { atem: RACK, fieldConnected: true }).level, 'ok', String(backup));
  }
  // The registry carries it from the page's own hello.
  const reg = new ScreenRegistry();
  reg.add('p', { surface: 'program', addr: '10.0.100.21' });
  assert.ok(reg.hello('p', { t: 'hello', surface: 'program', key: 'luma', embedded: false, full: true,
    w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', backup: 'bad' }));
  assert.equal(screensVital(reg.list(), { atem: RACK, fieldConnected: true }).level, 'warn');
});

test('the doors check reads the registry it is given, and has no Screens row without one', async () => {
  assert.equal(await row(base(), 'screens'), undefined, 'a guess is not a report');
  const screens = new ScreenRegistry();
  assert.equal((await row(base({ screens }), 'screens'))!.level, 'warn');
  screens.add('a', { surface: 'program', addr: '10.0.100.21' });
  assert.ok(screens.hello('a', { t: 'hello', surface: 'program', key: 'luma', embedded: false, full: false,
    w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk' }));
  const r = (await row(base({ screens }), 'screens'))!;
  assert.match(r.detail, /10\.0\.100\.21 is in a window/);
  // A bare desk with a registry and nothing open is a warning, never a blocker.
  const report = await new Vitals(base({ screens })).report();
  assert.ok(!report.blockers.some(b => b.id === 'screens' || b.id === 'switcher'));
});

// ---- gray for what the kit does not have, and the codes as set -------------------------

test('hardware this setup does not have is gray "not used on this setup", with no chapter to read', async () => {
  const r = await new Vitals(base({ ffmpegFound: async () => false })).report();
  for (const id of ['obs', 'recorder', 'house']) {
    const v = r.checks.find(c => c.id === id)!;
    assert.equal(v.level, 'off', id);
    assert.match(v.detail, /^not used on this setup/, id);
  }
  assert.equal(r.checks.find(c => c.id === 'switcher')!.detail, NO_SWITCHER);
  for (const v of r.checks.filter(c => c.level === 'off')) {
    assert.doesNotMatch(`${v.detail} ${v.fix ?? ''}`, /chapter|handbook/i, v.id);
  }
  assert.ok(!r.blockers.length, 'none of them holds the doors');
});

test('the field row while the desk looks for the field by itself, and the codes as the settings page left them', async () => {
  const searching = (await row(base({ mode: null, field: { adapter: null, host: null, searching: true } }), 'field'))!;
  assert.equal(searching.level, 'off');
  assert.match(searching.detail, /^searching for the field by itself/);
  assert.match(searching.detail, /matches are run by hand/);

  const root = await mkdtemp(join(tmpdir(), 'cg-vitals-codes-'));
  const saved = { REMOTE_PIN: process.env['REMOTE_PIN'], JA_PIN: process.env['JA_PIN'], SETUP_PIN: process.env['SETUP_PIN'] };
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    const settings = Settings.load(root, structuredClone(DEFAULTS));
    const before = (await row(base({ settings }), 'codes'))!;
    assert.equal(before.level, 'warn');
    assert.match(before.detail, /desk PIN, awards code, settings code/);
    assert.match(before.fix ?? '', /Event settings page \(\/s\/setup\)/);
    assert.doesNotMatch(before.fix ?? '', /REMOTE_PIN|config\.json/, 'a page, not a file or a variable');
    settings.setCode('desk', '4726');
    settings.setCode('settings', '3691');
    settings.setCode('awards', '2580');
    assert.equal((await row(base({ settings }), 'codes'))!.level, 'ok', 'read live, as the server runs on them');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    await rm(root, { recursive: true, force: true });
  }
});
