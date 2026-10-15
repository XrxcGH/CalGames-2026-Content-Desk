import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { Vitals, type Vital, type VitalsDeps, type VitalsReport } from './vitals.ts';
import { DEFAULTS, type Config } from './config.ts';

const cfg = (over: Partial<Config> = {}): Config =>
  ({ ...structuredClone(DEFAULTS), ...over });

const GB = 1024 ** 3;

/**
 * A roomy disk, injected rather than read.
 *
 * The disk check is a blocking one and it reads the REAL drive, so every test
 * built on a bare `base()` passed on a laptop with space and failed on one
 * without: "a bare desk reports off rather than broken" asserts there are no
 * blockers, and under two hours of recording is one. Nothing in these tests is
 * about the disk except the ones that say so, and those set their own.
 */
const roomy = async (): Promise<number> => 10_000 * GB;

const base = (over: Partial<VitalsDeps> = {}): VitalsDeps => ({
  bus: new EventBus(), config: cfg(), root: process.cwd(), freeBytes: roomy, ...over,
});

const find = (report: VitalsReport, id: string): Vital =>
  report.checks.find(c => c.id === id)!;

test('a bare desk reports off rather than broken', async () => {
  // Nothing configured is the normal state of a laptop at a kitchen table, and
  // it must not look like a failing event.
  const r = await new Vitals(base()).report();
  assert.equal(find(r, 'recorder').level, 'off');
  assert.equal(find(r, 'obs').level, 'off');
  assert.equal(find(r, 'field').level, 'off');
  assert.equal(find(r, 'publish').level, 'off');
  assert.equal(r.blockers.length, 0, 'off is not a blocker');
  assert.notEqual(r.worst, 'fail');
  assert.equal(find(r, 'disk').level, 'ok', 'and the injected disk, not this machine\'s, was read');
});

test('a nearly full disk is a blocker, with what to do about it', async () => {
  // The other half of the bare-desk test: injecting a roomy disk there must not
  // mean the check can no longer fail. 1GB is about ten minutes of one source.
  const r = await new Vitals(base({ freeBytes: async () => 1 * GB })).report();
  const disk = find(r, 'disk');
  assert.equal(disk.level, 'fail');
  assert.equal(disk.blocking, true);
  assert.match(disk.detail, /1GB free/);
  assert.match(disk.detail, /0\.\d hours of recording/);
  assert.ok(disk.fix, 'a blocker without a fix is just bad news');
  assert.ok(r.blockers.some(b => b.id === 'disk'), 'it holds the doors shut');
  assert.equal(r.worst, 'fail');
});

test('the disk check hands the probe the folder it is recording into', async () => {
  const asked: string[] = [];
  const root = join(process.cwd(), 'somewhere');
  await new Vitals(base({ root, freeBytes: async dir => { asked.push(dir); return 10_000 * GB; } })).report();
  assert.deepEqual(asked, [root]);
});

test('the disk levels sit where the doors check says they do', async () => {
  // Two hours blocks, five warns, past five is fine. Measured in the one unit
  // the decision is made in, so the test sets hours and not gigabytes.
  const perSec = 1_000_000;
  const config = cfg();
  const sources = Math.max(1, config.recording.sources.filter(s => s.enabled !== false).length);
  const bytesFor = (hours: number) => hours * 3600 * perSec * sources;
  const levelAt = async (hours: number) => find(await new Vitals(base({
    config, recordBytesPerSec: perSec, freeBytes: async () => bytesFor(hours),
  })).report(), 'disk').level;

  assert.equal(await levelAt(1.9), 'fail');
  assert.equal(await levelAt(3), 'warn');
  assert.equal(await levelAt(6), 'ok');
});

test('a drive that cannot be read is unknown, not a pass and not a crash', async () => {
  const gone = await new Vitals(base({ freeBytes: async () => { throw new Error('no such drive'); } }))
    .report();
  assert.equal(find(gone, 'disk').level, 'unknown');
  assert.match(find(gone, 'disk').detail, /no such drive/);
  assert.ok(gone.checks.length > 3, 'the other checks still ran');

  // NaN fails every comparison, so without a guard it would read as "ok".
  const odd = await new Vitals(base({ freeBytes: async () => NaN })).report();
  assert.equal(find(odd, 'disk').level, 'unknown');
  assert.doesNotMatch(find(odd, 'disk').detail, /NaN hours/);
});

test('with nothing injected the disk check still asks the operating system', async () => {
  // The default is unchanged: this is the one test that reads the real drive,
  // and it asserts only that an answer came back in the right shape, never how
  // much room the machine has.
  const r = await new Vitals({ bus: new EventBus(), config: cfg(), root: process.cwd() }).report();
  const disk = find(r, 'disk');
  assert.notEqual(disk.level, 'unknown', disk.detail);
  assert.match(disk.detail, /GB free, about \d+\.\d hours of recording/);
});

test('a stopped recording source is a blocking failure, named', async () => {
  const recorder = {
    status: [
      { id: 'program', running: true },
      { id: 'cam1', running: false },
    ],
  } as unknown as VitalsDeps['recorder'];

  const r = await new Vitals(base({ recorder })).report();
  const rec = find(r, 'recorder');
  assert.equal(rec.level, 'fail');
  assert.match(rec.detail, /cam1/);
  assert.ok(r.blockers.some(b => b.id === 'recorder'));
});

test('disk is reported in hours of recording, not gigabytes', async () => {
  // "38GB free" means nothing to the person deciding whether to start the day.
  const r = await new Vitals(base()).report();
  assert.match(find(r, 'disk').detail, /hours of recording/);
});

test('publishing enabled with no credentials blocks doors', async () => {
  const config = cfg();
  config.publish.enabled = true;
  const r = await new Vitals(base({ config })).report();
  const pub = find(r, 'publish');
  assert.equal(pub.level, 'fail');
  assert.match(pub.detail, /youtube\.clientId/);
  assert.ok(pub.fix, 'a blocker without a fix is just bad news');
  assert.ok(r.blockers.some(b => b.id === 'publish'));
});

test('a muted microphone is surfaced, because nothing else complains', async () => {
  // The single most common broadcast failure: the show runs, the graphics are
  // right, and forty minutes of it have no commentary.
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false }),
    request: async (type: string, data?: { inputName?: string }) => {
      if (type === 'GetInputList') {
        return { inputs: [
          { inputName: 'Announcer Mic', inputKind: 'wasapi_input_capture' },
          { inputName: 'Desk Mic', inputKind: 'wasapi_input_capture' },
          { inputName: 'Field Cam', inputKind: 'dshow_input' },
        ] };
      }
      if (type === 'GetInputMute') return { inputMuted: data?.inputName === 'Announcer Mic' };
      return {};
    },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  const mics = find(r, 'mics');
  assert.equal(mics.level, 'warn');
  assert.match(mics.detail, /Announcer Mic/);
  assert.doesNotMatch(mics.detail, /Field Cam/, 'a camera is not a microphone');
});

test('one unreadable input does not hide the other microphones', async () => {
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false }),
    request: async (type: string, data?: { inputName?: string }) => {
      if (type === 'GetInputList') {
        return { inputs: [
          { inputName: 'Mic A', inputKind: 'wasapi_input_capture' },
          { inputName: 'Mic B', inputKind: 'wasapi_input_capture' },
        ] };
      }
      if (data?.inputName === 'Mic A') throw new Error('gone');
      return { inputMuted: true };
    },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  assert.match(find(r, 'mics').detail, /Mic B/);
});

test('a dropping stream is called out with what to do about it', async () => {
  const obs = {
    connected: true,
    streamStatus: async () => ({
      outputActive: true, outputSkippedFrames: 900, outputTotalFrames: 10_000,
    }),
    request: async () => ({ inputs: [] }),
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  const health = find(r, 'stream-health');
  assert.equal(health.level, 'fail');
  assert.match(health.fix ?? '', /bitrate|degraded/i);
});

test('a check that throws reports unknown instead of taking the report down', async () => {
  // A health report that cannot be read when things are going wrong is worse
  // than no health report.
  const obs = {
    connected: true,
    streamStatus: async () => { throw new Error('socket died'); },
    request: async () => { throw new Error('socket died'); },
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  assert.equal(find(r, 'obs').level, 'unknown');
  assert.ok(r.checks.length > 3, 'the other checks still ran');
});

test('house audio: none armed warns, two armed fails', async () => {
  const withPlayers = (armed: number) => ({
    snapshot: { players: { alive: armed, armed } },
  } as unknown as VitalsDeps['audio']);

  assert.equal(find(await new Vitals(base({ audio: withPlayers(0) })).report(), 'house').level, 'warn');
  assert.equal(find(await new Vitals(base({ audio: withPlayers(1) })).report(), 'house').level, 'ok');
  // Two armed players usually means one of them is the machine OBS captures.
  assert.equal(find(await new Vitals(base({ audio: withPlayers(2) })).report(), 'house').level, 'fail');
});

test('a stream that drops mid-match turns the health page red', async () => {
  /*
   * outputReconnecting is declared on StreamStatus and was read by nobody. If
   * OBS lost its RTMP connection, the OBS vital reported "connected, not
   * streaming" and stream health reported "not streaming", and NEITHER is a
   * failure: both are exactly what the normal between-days state looks like.
   * So the desk's health page stayed green through a stream outage in the
   * finals.
   */
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false, outputReconnecting: true }),
    request: async () => ({ inputs: [] }),
  } as unknown as VitalsDeps['obs'];

  const r = await new Vitals(base({ obs })).report();
  assert.equal(find(r, 'obs').level, 'fail');
  assert.match(find(r, 'obs').detail, /RECONNECT/i);
  assert.equal(find(r, 'stream-health').level, 'fail');
  assert.ok(r.blockers.some(c => c.id === 'obs'), 'and it blocks');
  assert.equal(r.worst, 'fail');
});

test('an unquoted numeric pin in config.json does not take the health report down', async () => {
  // "pin": 2468 is the natural way to write a four-digit code, and JSON hands
  // it over as a number. (2468).trim() threw while the list of checks was
  // still being built, so the whole report rejected, not just the codes row.
  const saved = { desk: process.env['REMOTE_PIN'], ja: process.env['JA_PIN'], setup: process.env['SETUP_PIN'] };
  delete process.env['JA_PIN'];
  delete process.env['SETUP_PIN'];
  process.env['REMOTE_PIN'] = '7391';
  try {
    const config = cfg();
    config.awards = { ...config.awards, pin: 2468 as unknown as string };
    config.setup = { pin: 8642 as unknown as string };
    const codes = find(await new Vitals(base({ config })).report(), 'codes');
    assert.equal(codes.level, 'ok', 'both numbers are real, changed codes');

    // And a numeric pin that happens to BE the shipped default is still seen
    // as the default: coercing must not hide it.
    config.awards = { ...config.awards, pin: 1357 as unknown as string };
    const stale = find(await new Vitals(base({ config })).report(), 'codes');
    assert.equal(stale.level, 'warn');
    assert.match(stale.detail, /awards code/);
  } finally {
    for (const [key, val] of [['REMOTE_PIN', saved.desk], ['JA_PIN', saved.ja], ['SETUP_PIN', saved.setup]] as const) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
  }
});

test('an empty desk PIN is the gate switched off, and the doors check blocks on it', async () => {
  // REMOTE_PIN="" is the kitchen-table escape hatch: the server lets every
  // request through. An empty string is not the shipped default, so it used
  // to count as "changed" and, with the other two codes set, the row read OK
  // while every control surface was open to the venue Wi-Fi.
  const saved = { desk: process.env['REMOTE_PIN'], ja: process.env['JA_PIN'], setup: process.env['SETUP_PIN'] };
  process.env['REMOTE_PIN'] = '';
  process.env['JA_PIN'] = '7531';
  process.env['SETUP_PIN'] = '9753';
  try {
    const r = await new Vitals(base()).report();
    const codes = find(r, 'codes');
    assert.equal(codes.level, 'fail');
    assert.match(codes.detail, /desk PIN is empty/);
    assert.ok(r.blockers.some(c => c.id === 'codes'), 'and it blocks the doors');

    // A real PIN with the other two changed is still the quiet OK.
    process.env['REMOTE_PIN'] = '7391';
    assert.equal(find(await new Vitals(base()).report(), 'codes').level, 'ok');
  } finally {
    for (const [key, val] of [['REMOTE_PIN', saved.desk], ['JA_PIN', saved.ja], ['SETUP_PIN', saved.setup]] as const) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
  }
});

test('an empty desk PIN on a desk only this machine can reach is a note, not a blocker', async () => {
  // The preview renderer runs exactly that on purpose (no PIN, 127.0.0.1),
  // and the doors check painted its console red over a door nobody on the
  // venue Wi-Fi can reach. Any other address is still the blocker.
  const saved = { desk: process.env['REMOTE_PIN'], ja: process.env['JA_PIN'], setup: process.env['SETUP_PIN'] };
  process.env['REMOTE_PIN'] = '';
  process.env['JA_PIN'] = '7531';
  process.env['SETUP_PIN'] = '9753';
  try {
    for (const host of ['127.0.0.1', '127.4.5.6', 'localhost', '::1', '[::1]']) {
      const r = await new Vitals(base({ host })).report();
      const codes = find(r, 'codes');
      assert.equal(codes.level, 'off', host);
      assert.match(codes.detail, /only answers on this machine/);
      assert.ok(!r.blockers.some(c => c.id === 'codes'), `${host} holds no door shut`);
      assert.notEqual(r.worst, 'fail', `${host} paints nothing red`);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.100.40', undefined]) {
      const r = await new Vitals(base(host === undefined ? {} : { host })).report();
      assert.equal(find(r, 'codes').level, 'fail', String(host));
      assert.ok(r.blockers.some(c => c.id === 'codes'), `${String(host)} is reachable, so it blocks`);
    }
  } finally {
    for (const [key, val] of [['REMOTE_PIN', saved.desk], ['JA_PIN', saved.ja], ['SETUP_PIN', saved.setup]] as const) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
  }
});

test('the OBS row says how the exe turns OBS on, not a command-line flag', async () => {
  // The packaged exe has no command line, so "(no --obs)" pointed a
  // first-time crew at something they can never type.
  const off = find(await new Vitals(base()).report(), 'obs');
  assert.equal(off.level, 'off');
  assert.match(off.detail, /"obs": \{ "enabled": true \} in config\.json/);
  assert.doesNotMatch(off.detail, /--obs/);
});

test('"not streaming" is fine on Friday and an emergency during a match', async () => {
  // The same reading means opposite things, and the desk could not tell them
  // apart: OBS idle between days looks identical to OBS idle during a final.
  const obs = {
    connected: true,
    streamStatus: async () => ({ outputActive: false }),
    request: async () => ({ inputs: [] }),
  } as unknown as VitalsDeps['obs'];

  const quiet = await new Vitals(base({ obs })).report();
  assert.equal(find(quiet, 'stream-health').level, 'off', 'nothing is on the field');

  // Now a match is loaded and running.
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
  bus.emit({ type: 'match.start', source: 'cheesy', payload: {} });

  const live = await new Vitals(base({ obs, bus })).report();
  assert.equal(find(live, 'stream-health').level, 'fail');
  assert.match(find(live, 'stream-health').detail, /match is underway/i);
});
