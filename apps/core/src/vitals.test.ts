import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { type WriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
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

test('the OBS row is gray and short on a setup without OBS, with nothing to type or edit', async () => {
  // The packaged exe has no command line, so "(no --obs)" pointed a
  // first-time crew at something they can never type; and a venue whose kit
  // is a hardware switcher has no OBS at all, so telling it to edit
  // config.json to turn OBS on read as a fault to fix.
  const off = find(await new Vitals(base()).report(), 'obs');
  assert.equal(off.level, 'off');
  assert.equal(off.detail, 'not used on this setup');
  assert.equal(off.fix, undefined);
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

test('a config.json the desk could not use holds the doors, and says where to look', async () => {
  // It used to be one line in desk-log.txt, while every code, the awards list
  // and OBS were silently back to their defaults.
  const typo = await new Vitals(base({
    configFile: () => ({ state: 'unusable', reason: 'typo', line: 315, duplicates: [] }),
  })).report();
  const row = find(typo, 'config-file');
  assert.equal(row.label, 'Settings file');
  assert.equal(row.level, 'fail');
  assert.equal(row.blocking, true);
  assert.match(row.detail, /typo near line 315, so none of it is in use/);
  assert.match(row.detail, /awards and settings codes are back to the shipped defaults, OBS is off/);
  assert.match(row.fix ?? '', /around line 315/);
  assert.ok(typo.blockers.some(b => b.id === 'config-file'), 'it holds the doors shut');
  assert.equal(typo.worst, 'fail');

  for (const reason of ['not-an-object', 'unreadable'] as const) {
    const r = find(await new Vitals(base({
      configFile: () => ({ state: 'unusable', reason, duplicates: [] }),
    })).report(), 'config-file');
    assert.equal(r.level, 'fail', reason);
    assert.match(r.detail, /none of it is in use/, reason);
    assert.ok(r.fix, reason);
  }
});

test('a section written twice is a warning naming it and its lines, not a blocker', async () => {
  // The example file already has "obs" near the end, so the handbook's line
  // pasted in near the top parsed fine and left OBS off: the later one wins.
  const r = await new Vitals(base({
    configFile: () => ({ state: 'read', duplicates: [{ section: 'obs', lines: [2, 310] }] }),
  })).report();
  const row = find(r, 'config-file');
  assert.equal(row.level, 'warn');
  assert.match(row.detail, /"obs" on lines 2 and 310/);
  assert.match(row.detail, /uses only the last/);
  assert.ok(row.fix);
  assert.ok(!r.blockers.some(b => b.id === 'config-file'), 'the file is in use; one section is not');
});

test('the Settings file row reads a missing file as defaults, and stays away before any load', async () => {
  const missing = find(await new Vitals(base({
    configFile: () => ({ state: 'missing', duplicates: [] }),
  })).report(), 'config-file');
  assert.equal(missing.level, 'off');
  assert.match(missing.detail, /shipped default/);

  const read = find(await new Vitals(base({
    configFile: () => ({ state: 'read', duplicates: [] }),
  })).report(), 'config-file');
  assert.equal(read.level, 'ok');

  // A test or a tool that built its own Config never ran loadConfig.
  const unread = await new Vitals(base({ configFile: () => ({ state: 'unread', duplicates: [] }) })).report();
  assert.equal(unread.checks.find(c => c.id === 'config-file'), undefined);
});

test('a desk in practice says so on the doors check, and holds the doors', async () => {
  // A double-click on a running desk only reopens it, so a rehearsal left up
  // on Friday night ran Saturday's show keeping none of the day.
  for (const mode of ['rehearsal', 'demo', 'replay'] as const) {
    const r = await new Vitals(base({ mode })).report();
    const row = find(r, 'mode');
    assert.equal(row.label, 'Desk mode');
    assert.equal(row.level, 'warn', mode);
    assert.equal(row.blocking, true, mode);
    assert.match(row.detail, /^(PRACTICE|REPLAY)/, mode);
    assert.match(row.detail, /staged winners go to a practice file/, mode);
    assert.match(row.fix ?? '', /Task Manager/, mode);
    assert.ok(r.blockers.some(b => b.id === 'mode'), mode);
  }
  assert.match(find(await new Vitals(base({ mode: 'rehearsal' })).report(), 'mode').detail, /\/rehearsal/);

  const show = await new Vitals(base({ mode: null })).report();
  assert.equal(find(show, 'mode').level, 'ok');
  assert.ok(!show.blockers.some(b => b.id === 'mode'));
});

test('the Recording row says which half of its setup is missing, and never holds the doors', async () => {
  // "Started without --record" named a flag the exe cannot pass. The exe
  // records once ffmpeg is installed and a camera is listed in config.json.
  const camera = cfg();
  camera.recording.sources = [{ id: 'program', label: 'Program', role: 'program', input: ['-i', 'x'] }];
  const rowFor = async (ffmpeg: boolean, config: Config) => {
    const r = await new Vitals(base({ config, ffmpegFound: async () => ffmpeg })).report();
    assert.ok(!r.blockers.some(b => b.id === 'recorder'), 'never a blocker');
    const row = find(r, 'recorder');
    assert.equal(row.level, 'off');
    assert.doesNotMatch(row.detail, /--record/);
    return row.detail;
  };

  // Neither half is a kit that records on its own hardware: gray, plain,
  // and no chapter of a manual to go and read.
  const neither = await rowFor(false, cfg());
  assert.match(neither, /^not used on this setup/);
  assert.match(neither, /ffmpeg is not installed/);
  assert.match(neither, /no cameras are listed under "recording" in config\.json/);
  assert.doesNotMatch(neither, /chapter|handbook/);

  const noFfmpeg = await rowFor(false, camera);
  assert.match(noFfmpeg, /ffmpeg is not installed/);
  assert.doesNotMatch(noFfmpeg, /no cameras/);

  const noCameras = await rowFor(true, cfg());
  assert.match(noCameras, /no cameras are listed/);
  assert.doesNotMatch(noCameras, /ffmpeg is not installed/);

  // A disabled camera is not a camera the recorder will open.
  const disabled = cfg();
  disabled.recording.sources = [{ ...camera.recording.sources[0]!, enabled: false }];
  assert.match(await rowFor(true, disabled), /no cameras are listed/);

  assert.match(await rowFor(true, camera), /desk-log\.txt says why/);
});

test('the Field bridge row says what the exe can do, not a flag it cannot take', async () => {
  const off = find(await new Vitals(base({ mode: null })).report(), 'field');
  assert.equal(off.level, 'off');
  assert.doesNotMatch(off.detail, /--cheesy|cheesy-host|START-DESK|chapter/);
  assert.match(off.detail, /not looking for the field/);
  assert.match(off.detail, /restart the desk/);
  assert.match(off.detail, /finds the field by itself/);

  // Practice runs without the field on purpose; restarting would not help.
  const demo = find(await new Vitals(base({ mode: 'demo' })).report(), 'field');
  assert.match(demo.detail, /practice mode runs without the field/);
});

test('an event log that stopped writing holds the doors, says why, and clears when it is back', async () => {
  // A full disk used to switch the log off for the rest of the process with a
  // line in desk-log.txt and nothing on any screen; the next restart then
  // rebuilt the day only up to the failure. The bus now retries by itself, and
  // the doors check says so while it is down. A real bus and a real failure:
  // the stream the bus opened raises the error Node raises on a full disk.
  const dir = await mkdtemp(join(tmpdir(), 'cg-vitals-log-'));
  const real = fs.createWriteStream;
  const made: WriteStream[] = [];
  fs.createWriteStream = ((...args: Parameters<typeof real>) => {
    const s = real(...args);
    made.push(s);
    return s;
  }) as typeof real;
  syncBuiltinESMExports();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const bus = new EventBus();
  try {
    const none = await new Vitals(base()).report();
    assert.equal(none.checks.find(c => c.id === 'event-log'), undefined, 'no row when no log was asked for');

    await bus.openLog(dir);
    bus.emit({ type: 'screen.change', payload: { screen: 'match' } });
    const fine = find(await new Vitals(base({ bus, mode: null })).report(), 'event-log');
    assert.equal(fine.label, 'Event log');
    assert.equal(fine.level, 'ok');
    assert.match(fine.detail, /restart rebuilds the day/);
    // A practice desk's file is the one the next boot leaves out, and the
    // row must not promise otherwise right under the Desk mode row.
    const practice = find(await new Vitals(base({ bus, mode: 'rehearsal' })).report(), 'event-log');
    assert.equal(practice.level, 'ok');
    assert.doesNotMatch(practice.detail, /restart rebuilds the day/);
    assert.match(practice.detail, /practice file/);

    made.at(-1)!.emit('error', Object.assign(
      new Error("ENOSPC: no space left on device, write 'C:/Users/volunteer/data/events/x.ndjson'"),
      { code: 'ENOSPC' }));
    const down = await new Vitals(base({ bus })).report();
    const row = find(down, 'event-log');
    assert.equal(row.level, 'fail');
    assert.equal(row.blocking, true);
    assert.ok(down.blockers.some(b => b.id === 'event-log'), 'it holds the doors shut');
    assert.match(row.detail, /not being written \(ENOSPC: no space left on device\)/);
    assert.match(row.detail, /rebuild the day only up to the moment it stopped/);
    assert.doesNotMatch(JSON.stringify(row), /volunteer|ndjson/, 'the error, not the path it names');
    assert.match(row.fix ?? '', /tries again by itself every 30 seconds/);
    assert.match(row.fix ?? '', /Disk row/);

    // The bus's own retry, then the row goes green with nobody touching it.
    mock.timers.tick(EventBus.LOG_RETRY_MS);
    bus.emit({ type: 'screen.change', payload: { screen: 'score' } });
    const back = await new Vitals(base({ bus })).report();
    assert.equal(find(back, 'event-log').level, 'ok');
    assert.ok(!back.blockers.some(b => b.id === 'event-log'));
  } finally {
    mock.timers.reset();
    fs.createWriteStream = real;
    syncBuiltinESMExports();
    // The bus closes its current file; the one that "failed" is still ours.
    await bus.closeLog();
    made[0]?.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Disk row says what a first-time crew can do, not a flag the exe cannot take', async () => {
  const disk = find(await new Vitals(base({ freeBytes: async () => 1 * GB })).report(), 'disk');
  assert.doesNotMatch(disk.fix ?? '', /--record/);
  assert.match(disk.fix ?? '', /Recycle Bin/);
  assert.match(disk.fix ?? '', /rec folder inside the desk folder/);
  assert.match(disk.fix ?? '', /leave its clips folder alone/, 'the cut match videos stay');
});

test('a section that is not a group of settings is a warning naming it, never its value', async () => {
  // "obs": true parsed fine and was dropped with a line in the log, while the
  // doors check said config.json was read and in use and OBS stayed off.
  const r = await new Vitals(base({
    configFile: () => ({ state: 'read', duplicates: [], ignored: ['obs'] }),
  })).report();
  const row = find(r, 'config-file');
  assert.equal(row.level, 'warn');
  assert.match(row.detail, /gives "obs" something other than a group of settings/);
  assert.match(row.detail, /\(so OBS is off\)/);
  assert.match(row.fix ?? '', /config\.example\.json/);
  assert.ok(!r.blockers.some(b => b.id === 'config-file'), 'the rest of the file is in use');

  // Two, and alongside a repeated section: one row that says both.
  const both = find(await new Vitals(base({
    configFile: () => ({ state: 'read', duplicates: [{ section: 'awards', lines: [3, 40] }],
      ignored: ['publish.playlists', 'recording'] }),
  })).report(), 'config-file');
  assert.equal(both.level, 'warn');
  assert.match(both.detail, /"awards" on lines 3 and 40/);
  assert.match(both.detail, /"publish\.playlists" and "recording"/);
  assert.doesNotMatch(both.detail, /OBS is off/);
  assert.match(both.fix ?? '', /merge each repeated section/);
  assert.match(both.fix ?? '', /write each as a group/);
});
