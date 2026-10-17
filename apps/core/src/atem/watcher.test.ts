/**
 * The watcher against a fake switcher over real UDP on loopback.
 *
 * Each test drives the same code the desk will run against the
 * Constellation at 10.0.100.40; only the address and port differ. Long
 * waits (5 s of silence, the 5 s to 60 s backoff, the once-a-minute sweep)
 * are measured on the watcher's injected clock, which these tests move by
 * hand, so a minute of backoff costs a quarter of a second to test.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ATEM_TIMING, AtemWatcher, onAirSummary, type AtemStatus } from './watcher.ts';
import { FakeAtem, KIT, KIT_INPUTS } from './fake-atem.ts';
import { PacketFlag, VideoModeId, classifyClientDatagram, parsePacket } from './protocol.ts';
import { encodeCommand, Cmd } from './fake-atem.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A clock the test moves by hand. It starts at a real-looking epoch time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_792_000_000_000;
  return { now: () => t, advance: ms => { t += ms; } };
}

/** One tick of the watcher, in real time, plus a little for the packets it causes. */
const settle = (): Promise<void> => sleep(ATEM_TIMING.tickMs + 80);

/**
 * Pulls the fake's cable, then lets anything it sent just before land
 * BEFORE the test moves the clock: a keepalive arriving after the jump
 * would be heard at the new time and restart the silence.
 */
async function pullCable(fake: FakeAtem): Promise<void> {
  fake.goSilent();
  await sleep(40);
}

interface Sent { bytes: Buffer; host: string; port: number; at: number; socket: dgram.Socket }

/**
 * Records every datagram any socket in this process sends that is not the
 * fake's own. That covers hellos to dead addresses, which no fake can see.
 */
function spySends(t: TestContext, fake?: FakeAtem): Sent[] {
  const sent: Sent[] = [];
  const proto = dgram.Socket.prototype as unknown as { send: (...args: unknown[]) => void };
  const original = proto.send;
  proto.send = function (this: dgram.Socket, ...args: unknown[]): void {
    let fromPort = 0;
    try { fromPort = this.address().port; } catch { /* not bound yet: not the fake */ }
    const [bytes, port, host] = args as [Buffer | Buffer[], number, string];
    // A send made before the bind completes is queued by dgram and replayed
    // through send() again with the buffers in an array. The first call was
    // already recorded; the replay is Node's, not the watcher's.
    if (!Array.isArray(bytes) && (fake === undefined || fromPort !== fake.port)) {
      sent.push({ bytes: Buffer.from(bytes), host, port, at: performance.now(), socket: this });
    }
    original.apply(this, args);
  };
  t.after(() => { proto.send = original; });
  return sent;
}

const hellosTo = (sent: Sent[], host?: string): Sent[] =>
  sent.filter(s => classifyClientDatagram(s.bytes)?.kind === 'hello' && (host === undefined || s.host === host));

async function rig(t: TestContext, opts: { host?: string | null; discover?: boolean; candidates?: () => string[]; packetBudget?: number; keepaliveMs?: number } = {}) {
  const fake = await FakeAtem.start({ packetBudget: opts.packetBudget ?? 160, keepaliveMs: opts.keepaliveMs });
  const c = clock();
  const log: string[] = [];
  const w = new AtemWatcher({
    host: opts.host === undefined ? '127.0.0.1' : opts.host,
    discover: opts.discover ?? false,
    candidates: opts.candidates,
    port: fake.port,
    now: c.now,
    log: line => log.push(line),
  });
  const changes: AtemStatus[] = [];
  w.on('change', s => changes.push(s));
  t.after(async () => {
    await w.stop();
    await fake.close();
  });
  return { fake, c, w, changes, log };
}

const EXPECTED_INPUTS = KIT_INPUTS.map(i => ({ id: i.id, longName: i.longName, shortName: i.shortName }));

const EXPECTED_KEYERS = [
  { kind: 'upstream', me: 1, index: 1, onAir: false, type: 'dve', fillSource: KIT.deskProgram, keySource: 0 },
  { kind: 'downstream', me: null, index: 1, onAir: true, type: 'luma', fillSource: KIT.graphics, keySource: KIT.graphics },
  { kind: 'downstream', me: null, index: 2, onAir: false, type: 'luma', fillSource: 3010, keySource: 3011 },
];

// ---- the handshake and the dump ---------------------------------------------------

test('handshake to connected, with the whole dump in the status and one change for it', async t => {
  const { fake, c, w, changes } = await rig(t);
  w.start();
  assert.equal(w.status.state, 'connecting');
  assert.equal(w.status.host, '127.0.0.1');
  await until(() => w.status.state === 'connected', 'connected');
  await sleep(40);

  assert.deepEqual(w.status, {
    state: 'connected',
    host: '127.0.0.1',
    model: 'ATEM Constellation 4K',
    protocol: '2.32',
    videoMode: { id: VideoModeId.N1080p5994, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 },
    program: KIT.program,
    preview: KIT.preview,
    inputs: EXPECTED_INPUTS,
    keyers: EXPECTED_KEYERS,
    since: c.now(),
    lastHeard: c.now(),
    error: null,
  });
  // The dump came in several packets (a 160-byte budget), and still made
  // exactly one 'connected' change, carrying all of it.
  const connected = changes.filter(s => s.state === 'connected');
  assert.equal(connected.length, 1);
  assert.deepEqual(connected[0], w.status);
  // Any 'connecting' change carried none of the half-read dump.
  for (const s of changes.filter(x => x.state === 'connecting')) {
    assert.equal(s.inputs.length, 0);
    assert.equal(s.program, null);
  }
  assert.equal(fake.sessionsOpened, 1);
  assert.equal(onAirSummary(w.status), 'Program: Field Wide. Preview: Field Tight. On air over it: DSK1 (luma key of Graphics).');
});

test('every packet that asks for an ack gets one, so the switcher never has to resend', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  // Three keepalives' worth, and a burst of changes.
  for (let i = 0; i < 20; i++) fake.setProgram(1 + (i % 5));
  await sleep(3 * 500 + 100);
  await until(() => fake.unacked === 0, 'everything acked', 1000);
  assert.equal(fake.retransmits, 0, 'the fake had to resend something the desk never acked');
  assert.equal(fake.activeSessions, 1);
  assert.ok(fake.acks > 0);
});

test('a lost packet is resent by the switcher, held for, and the state still comes out right', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  fake.loseNext(1);
  fake.setProgram(3);
  fake.setDskOnAir(1, false);
  fake.setPreview(4);
  await until(() => w.status.program === 3 && w.status.preview === 4, 'the cut and the preview');
  assert.equal(w.status.keyers.find(k => k.kind === 'downstream' && k.index === 1)?.onAir, false);
  assert.ok(fake.retransmits >= 1, 'the dropped packet came back as a resend');
  await until(() => fake.unacked === 0, 'everything acked');
  assert.equal(w.status.state, 'connected');
});

test('a packet that never arrives, while keepalives still do, is lost within 5 s instead of held forever', async t => {
  // Keepalives every 50 ms of real time, so one is heard after each clock
  // step below and silence never explains the loss. The fake keeps resending
  // what follows the gap (the desk's acks stop at it) and must not give up
  // on the desk inside the test, or that would end the session instead.
  const fake = await FakeAtem.start({ keepaliveMs: 50, maxRetries: 1000 });
  const c = clock();
  const w = new AtemWatcher({ host: '127.0.0.1', discover: false, port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  await until(() => w.status.state === 'connected', 'connected');

  fake.loseForever(1);
  fake.setProgram(3);
  fake.setPreview(4);
  // Let the preview and a keepalive land at this instant: the gap opens now.
  await sleep(100);
  const heardNow = (): boolean => w.status.lastHeard === c.now();
  for (const step of [1000, 1000, 1000, 1000, 900]) {
    c.advance(step);
    await until(heardNow, 'a keepalive after the step');
  }
  await settle();
  assert.equal(w.status.state, 'connected', 'not lost before 5 s of a gap');
  // Held behind the gap, not applied out of order: the cut never arrived.
  assert.equal(w.status.program, KIT.program);
  assert.equal(w.status.preview, KIT.preview);

  c.advance(100);
  await until(() => w.status.state === 'lost', 'lost once the gap is 5 s old');
  assert.equal(w.status.error, 'Lost the ATEM Constellation 4K at 127.0.0.1: part of what it sent never arrived. Check its power and network cable. Trying again in 5 s.');
  assert.equal(w.status.program, null);

  // A new session's dump brings back everything, the missed cut included.
  c.advance(ATEM_TIMING.backoffMinMs);
  await until(() => w.status.state === 'connected', 'reconnected');
  assert.equal(w.status.program, 3);
  assert.equal(w.status.preview, 4);
});

test('a cut and a DSK change each reach the status and emit change once', async t => {
  const { fake, w, changes } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  await sleep(50);
  const base = changes.length;

  fake.setProgram(2);
  await until(() => w.status.program === 2, 'program 2');
  await sleep(60);
  assert.equal(changes.length, base + 1);
  assert.equal(changes.at(-1)?.program, 2);

  fake.setDskOnAir(1, false);
  await until(() => w.status.keyers.some(k => k.kind === 'downstream' && k.index === 1 && !k.onAir), 'DSK1 off');
  await sleep(60);
  assert.equal(changes.length, base + 2);
  assert.match(onAirSummary(w.status), /No keys on air\.$/);

  // The same cut again changes nothing, and neither do keepalives.
  fake.setProgram(2);
  await sleep(1200);
  assert.equal(changes.length, base + 2);
  assert.ok((w.status.lastHeard ?? 0) > 0);
});

test('a video mode change reads as the switcher menus print it', async t => {
  const { fake, w, changes } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  await sleep(40);
  const base = changes.length;
  fake.setVideoMode(VideoModeId.P4KHDp25);
  await until(() => w.status.videoMode?.label === '2160p25', '2160p25');
  await sleep(40);
  assert.equal(changes.length, base + 1);
  assert.deepEqual(w.status.videoMode, { id: VideoModeId.P4KHDp25, label: '2160p25', width: 3840, height: 2160, fps: 25 });
});

test('a DSK part way through an auto transition reads as on air, whichever way it is going', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  const dsk1 = (): boolean | undefined => w.status.keyers.find(k => k.kind === 'downstream' && k.index === 1)?.onAir;

  // Fading the score overlay out: still on program until the fade ends.
  // DSK1 was on air already, so wait for the ack: the watcher applies a
  // packet before it acks it, and the check below is not vacuous.
  fake.setDskOnAir(1, false, true);
  await until(() => fake.unacked === 0, 'the fade acked');
  assert.equal(dsk1(), true, 'a DSK fading out is still on air');
  assert.match(onAirSummary(w.status), /On air over it: DSK1 \(luma key of Graphics\)\.$/);
  fake.setDskOnAir(1, false);
  await until(() => dsk1() === false, 'DSK1 off once the fade is done');

  // Fading back in: on air from the first frame of the transition.
  fake.setDskOnAir(1, false, true);
  await until(() => dsk1() === true, 'a DSK fading in is on air');
  fake.setDskOnAir(1, true);
  await until(() => fake.unacked === 0, 'the end of the fade acked');
  assert.equal(dsk1(), true);
});

// ---- losing it, and getting it back politely -----------------------------------------

test('silence becomes lost, and the reconnect waits out a backoff that doubles', async t => {
  const { fake, c, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');

  await pullCable(fake);
  c.advance(ATEM_TIMING.silenceMs - 100);
  await settle();
  assert.equal(w.status.state, 'connected', 'not lost before 5 s of silence');
  c.advance(100);
  await until(() => w.status.state === 'lost', 'lost');
  const lost = w.status;
  assert.equal(lost.host, '127.0.0.1');
  assert.equal(lost.program, null, 'what was on air is not what is on air');
  assert.deepEqual(lost.keyers, []);
  assert.equal(lost.model, 'ATEM Constellation 4K', 'the model stays, so the message can name it');
  assert.equal(lost.error, 'Lost the ATEM Constellation 4K at 127.0.0.1: nothing heard from it for 5 s. Check its power and network cable. Trying again in 5 s.');
  assert.equal(onAirSummary(lost), 'Lost the switcher at 127.0.0.1. What is on air is unknown.');

  // The switcher comes back at once; the desk still waits its 5 s.
  fake.goSilent(false);
  const hellos = fake.hellos;
  c.advance(ATEM_TIMING.backoffMinMs - 100);
  await settle();
  assert.equal(fake.hellos, hellos, 'no hello inside the first 5 s');
  assert.equal(w.status.state, 'lost');
  c.advance(100);
  await until(() => w.status.state === 'connected', 'reconnected');
  assert.equal(fake.hellos, hellos + 1, 'one hello, one session');
  assert.equal(w.status.program, KIT.program);
  assert.equal(w.status.error, null);

  // Lost again straight away: this session never settled, so the wait doubles.
  await pullCable(fake);
  c.advance(ATEM_TIMING.silenceMs);
  await until(() => w.status.state === 'lost', 'lost again');
  assert.match(w.status.error ?? '', /Trying again in 10 s\.$/);
  fake.goSilent(false);
  c.advance(10_000 - 100);
  await settle();
  assert.equal(fake.hellos, hellos + 1);
  c.advance(100);
  await until(() => w.status.state === 'connected', 'reconnected again');
  assert.equal(fake.maxConcurrent, 1, 'never two sessions at once');
});

test('a session that stayed up earns a fast retry: the backoff resets after 30 s connected', async t => {
  // Keepalives every 50 ms of real time, so the watcher hears one between
  // each of the clock's 3 s steps below and never mistakes them for silence.
  const { fake, c, w } = await rig(t, { keepaliveMs: 50 });
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  for (let round = 0; round < 3; round++) {
    // Up for 30 s on the watcher's clock.
    for (let s = 0; s < 30; s += 3) {
      const heard = fake.acks;
      c.advance(3000);
      await until(() => fake.acks > heard + 1, 'a keepalive heard after the step');
    }
    await settle();
    assert.equal(w.status.state, 'connected');
    await pullCable(fake);
    c.advance(ATEM_TIMING.silenceMs);
    await until(() => w.status.state === 'lost', `lost, round ${round}`);
    assert.match(w.status.error ?? '', /Trying again in 5 s\.$/, `round ${round}`);
    fake.goSilent(false);
    c.advance(ATEM_TIMING.backoffMinMs);
    await until(() => w.status.state === 'connected', `back, round ${round}`);
  }
});

test('a switcher that never answers is asked again at 5, 10, 20, 40, 60 and 60 s, one hello each time', async t => {
  const fake = await FakeAtem.start();
  const sent = spySends(t, fake);
  const c = clock();
  // Nothing listens on 127.0.0.9: a switcher that is off.
  const w = new AtemWatcher({ host: '127.0.0.9', discover: false, port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  await until(() => hellosTo(sent).length === 1, 'the first hello');
  for (const waitS of [5, 10, 20, 40, 60, 60]) {
    const before = hellosTo(sent).length;
    c.advance(ATEM_TIMING.helloWaitMs);
    await settle();
    assert.equal(w.status.state, 'connecting');
    assert.equal(w.status.error, `No answer from the switcher at 127.0.0.9. Check that it is powered on and plugged into the field network, and that 127.0.0.9 is what ATEM Setup shows under Network. Trying again in ${waitS === 60 ? '1 minute' : `${waitS} s`}.`);
    c.advance(waitS * 1000 - 1);
    await settle();
    assert.equal(hellosTo(sent).length, before, `no hello before ${waitS} s`);
    c.advance(1);
    await until(() => hellosTo(sent).length === before + 1, `the hello after ${waitS} s`);
  }
  assert.ok(hellosTo(sent).every(s => s.host === '127.0.0.9' && s.port === fake.port));
});

test('a switcher that turns the desk down is never acked, is explained, and is asked again only after a backoff', async t => {
  const fake = await FakeAtem.start();
  const sent = spySends(t, fake);
  const c = clock();
  fake.refuseHellos();
  const w = new AtemWatcher({ host: '127.0.0.1', discover: false, port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  const refusal = (waitS: number): string => `The switcher at 127.0.0.1 turned the desk down. It may have no free connection slots: close any copy of ATEM Software Control nobody is using. Trying again in ${waitS} s.`;
  await until(() => w.status.error === refusal(5), 'the refusal, explained');
  assert.equal(w.status.state, 'connecting');
  assert.equal(fake.hellos, 1);

  for (const [waitS, nextS] of [[5, 10], [10, 20]] as const) {
    // Annotated: strict assert.equal narrows fake.hellos, which would
    // otherwise feed back into this type around the loop.
    const before: number = fake.hellos;
    c.advance(waitS * 1000 - 1);
    await settle();
    assert.equal(fake.hellos, before, `no hello before ${waitS} s`);
    c.advance(1);
    await until(() => w.status.error === refusal(nextS), `turned down again after ${waitS} s, next try in ${nextS} s`);
    assert.equal(fake.hellos, before + 1, 'one hello per try');
    assert.equal(w.status.state, 'connecting');
  }

  // Nothing but hellos went out: a refusal is no session to ack into.
  assert.equal(hellosTo(sent).length, 3);
  for (const s of sent) assert.equal(classifyClientDatagram(s.bytes)?.kind, 'hello', s.bytes.toString('hex'));
  for (const b of fake.received) assert.equal(classifyClientDatagram(b)?.kind, 'hello', b.toString('hex'));
  assert.equal(fake.sessionsOpened, 0);

  // Once somebody frees a slot, the next try connects.
  fake.refuseHellos(false);
  c.advance(20_000);
  await until(() => w.status.state === 'connected', 'connected once a slot is free');
  assert.equal(w.status.error, null);
});

// ---- setHost -------------------------------------------------------------------

test('setHost moves a running watcher live, and leaves the old switcher alone for 5 s', async t => {
  const { fake, c, w, log } = await rig(t, { host: '127.0.0.9' });
  w.start();
  await settle();
  assert.equal(w.status.state, 'connecting');
  assert.equal(w.status.host, '127.0.0.9');

  // The right address arrives from the settings page: tried at once, no backoff.
  w.setHost('127.0.0.1');
  await until(() => w.status.state === 'connected', 'connected after setHost');
  assert.equal(w.status.host, '127.0.0.1');

  // The same address again is a no-op: no new session.
  w.setHost(' 127.0.0.1 ');
  await sleep(100);
  assert.equal(fake.hellos, 1);
  assert.equal(w.status.state, 'connected');

  // Cleared, with discovery off: off, and the desk stops acking.
  w.setHost(null);
  await sleep(40);
  assert.equal(w.status.state, 'off');
  assert.equal(w.status.host, null);
  assert.equal(w.status.program, null);
  await until(() => fake.activeSessions === 0, 'the fake drops the abandoned session', 5000);

  // Garbage is explained, not tried.
  w.setHost('the switcher');
  await sleep(40);
  assert.equal(w.status.state, 'off');
  assert.match(w.status.error ?? '', /^"the switcher" is not a switcher address\. Type four numbers with dots, like 10\.0\.100\.40/);
  w.setHost('127.0.0.1:9999');
  await sleep(40);
  assert.match(w.status.error ?? '', /names port 9999, but the switcher listens on/);

  // Back to the same switcher, with the port spelled out: it waits until 5 s
  // after the desk left it, so the old slot has lapsed.
  w.setHost(`127.0.0.1:${fake.port}`);
  await settle();
  assert.equal(w.status.state, 'connecting');
  assert.equal(w.status.error, null);
  assert.equal(fake.hellos, 1);
  c.advance(ATEM_TIMING.backoffMinMs);
  await until(() => w.status.state === 'connected', 'connected again');
  assert.equal(fake.hellos, 2);
  assert.ok(log.some(l => l.includes('leaving the switcher at 127.0.0.1')));
});

test('setHost(null) with discovery on goes back to searching and finds the switcher again', async t => {
  const { c, w } = await rig(t, { host: '127.0.0.1', discover: true, candidates: () => ['127.0.0.7', '127.0.0.1'] });
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  w.setHost(null);
  await sleep(40);
  assert.equal(w.status.state, 'searching');
  assert.equal(w.status.host, null);
  c.advance(ATEM_TIMING.backoffMinMs);
  await until(() => w.status.state === 'connected', 'found again');
  assert.equal(w.status.host, '127.0.0.1');
});

// ---- discovery -----------------------------------------------------------------

test('discovery finds the fake among dead addresses, paces its hellos, and stops once connected', async t => {
  const fake = await FakeAtem.start();
  const sent = spySends(t, fake);
  const c = clock();
  const dead = Array.from({ length: 12 }, (_, i) => `127.0.0.${i + 2}`);
  const w = new AtemWatcher({ host: null, discover: true, candidates: () => [...dead, '127.0.0.1'], port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  assert.equal(w.status.state, 'searching');
  await until(() => w.status.state === 'connected', 'found and connected');
  assert.equal(w.status.host, '127.0.0.1');
  assert.equal(w.status.model, 'ATEM Constellation 4K');

  const hellos = hellosTo(sent);
  assert.deepEqual(hellos.map(h => h.host), [...dead, '127.0.0.1']);
  for (let i = 1; i < hellos.length; i++) {
    const gap = (hellos[i]?.at ?? 0) - (hellos[i - 1]?.at ?? 0);
    assert.ok(gap >= 17, `hello ${i} came ${gap.toFixed(1)} ms after the one before`);
  }
  // Connected: no more sweeps, however long the day.
  c.advance(10 * ATEM_TIMING.sweepEveryMs);
  await sleep(600);
  assert.equal(hellosTo(sent).length, hellos.length);
  assert.equal(fake.sessionsOpened, 1);
});

test('with nothing to find, a sweep repeats no sooner than once a minute, with a plain message', async t => {
  const fake = await FakeAtem.start();
  const sent = spySends(t, fake);
  const c = clock();
  // The fake's port, but addresses nothing listens on.
  const w = new AtemWatcher({ host: null, discover: true, candidates: () => ['127.0.0.2', '127.0.0.3'], port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  await until(() => hellosTo(sent).length === 2, 'the first sweep');
  c.advance(ATEM_TIMING.helloWaitMs);
  await settle();
  assert.equal(w.status.state, 'searching');
  assert.equal(w.status.error, 'No ATEM switcher answered on 127.0.0.x (2 addresses tried). Check that it is powered on and plugged into the same network as this computer, or type its address on the settings page. Searching again in 58 s.');
  assert.equal(onAirSummary(w.status), 'Looking for the switcher on the network.');
  c.advance(ATEM_TIMING.sweepEveryMs - ATEM_TIMING.helloWaitMs - 1);
  await settle();
  assert.equal(hellosTo(sent).length, 2, 'no second sweep inside the minute');
  c.advance(1);
  await until(() => hellosTo(sent).length === 4, 'the second sweep');
});

test('a kit with no switcher and discovery off is simply off, and sends nothing', async t => {
  const sent = spySends(t);
  const w = new AtemWatcher({ host: null, discover: false });
  t.after(() => w.stop());
  w.start();
  await settle();
  assert.equal(w.status.state, 'off');
  assert.equal(w.status.error, null);
  assert.equal(onAirSummary(w.status), 'Not watching a switcher.');
  assert.equal(sent.length, 0);
});

// ---- read-only, by construction ---------------------------------------------------

test('read-only: across a whole day in miniature, every datagram the desk sent was a hello or an ack', async t => {
  const fake = await FakeAtem.start({ packetBudget: 120 });
  const sent = spySends(t, fake);
  const c = clock();
  const w = new AtemWatcher({ host: '127.0.0.5', discover: true, candidates: () => ['127.0.0.6', '127.0.0.1'], port: fake.port, now: c.now });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.start();
  await until(() => w.status.state === 'connected', 'found by discovery');
  fake.loseNext(2);
  fake.setProgram(4);
  fake.setDskOnAir(1, false);
  fake.setKeyOnAir(true);
  fake.setVideoMode(VideoModeId.P1080p50);
  await until(() => w.status.videoMode?.label === '1080p50', 'the changes');
  await pullCable(fake);
  c.advance(ATEM_TIMING.silenceMs);
  await until(() => w.status.state === 'lost', 'lost');
  fake.goSilent(false);
  c.advance(ATEM_TIMING.backoffMinMs);
  await until(() => w.status.state === 'connected', 'back');
  // Back on the switcher discovery found, not stuck asking the configured
  // address nobody answers at.
  assert.equal(w.status.host, '127.0.0.1');
  w.setHost('127.0.0.1');
  await sleep(200);
  await w.stop();

  // Acks are cumulative and batched, so a whole session is only a handful.
  const kinds = sent.map(x => classifyClientDatagram(x.bytes)?.kind);
  assert.ok(kinds.filter(k => k === 'hello').length >= 4, 'two attempts, one of them a sweep');
  assert.ok(kinds.filter(k => k === 'ack').length >= 4, `only ${sent.length} datagrams: the session did not run`);
  for (const s of sent) {
    const kind = classifyClientDatagram(s.bytes);
    assert.ok(kind, `the desk sent something that is neither a hello nor an ack: ${s.bytes.toString('hex')}`);
    assert.equal(s.port, fake.port);
  }
  // And from the switcher's side of the wire, the same.
  assert.ok(fake.received.length > 0);
  for (const b of fake.received) assert.ok(classifyClientDatagram(b), b.toString('hex'));
  assert.ok(sent.some(s => classifyClientDatagram(s.bytes)?.kind === 'ack'));
});

test('read-only: the watcher has exactly one send call, and it sends only what buildClientDatagram built', () => {
  // Code only: the comments are allowed to talk about sending.
  const code = (f: string): string => readFileSync(join(HERE, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const src = code('watcher.ts');
  const sends = src.match(/\.send\(/g) ?? [];
  assert.equal(sends.length, 1, 'one socket send in watcher.ts');
  assert.ok(src.includes('sock.send(bytes, this.#port, host,'));
  assert.equal((src.match(/const bytes = buildClientDatagram\(d\);/g) ?? []).length, 1);
  assert.ok(!/fake-atem|encodeCommand|encodePacket/.test(src), 'the watcher cannot reach the switcher-side encoders');
  const protocol = code('protocol.ts');
  assert.ok(!/encodeCommand|encodePacket|\.send\(|createSocket/.test(protocol), 'protocol.ts builds no switcher packets and sends nothing');
  const discover = code('discover.ts');
  assert.ok(!/createSocket|node:dgram/.test(discover), 'discovery owns no socket');
});

// ---- never crash, never stall --------------------------------------------------------

test('garbage inside a live session is survived, and the session carries on', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  let seed = 0x1234;
  const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const junk = (n: number): Buffer => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256)));
  for (let i = 0; i < 200; i++) {
    // Sequenced packets full of nonsense commands, truncated commands, and
    // commands with lengths that run off the end.
    fake.inject(junk(Math.floor(next() * 120)));
    // And raw datagrams that are not ATEM packets at all.
    fake.sendRaw(junk(Math.floor(next() * 64)));
  }
  // Known commands with bodies too short to read, and a 'PrgI' on an M/E the desk does not show.
  fake.inject(Buffer.concat([encodeCommand('PrgI', Buffer.alloc(2)), encodeCommand('InPr', Buffer.alloc(10)), Cmd.program(5, 99)]));
  // A packet claiming an id far ahead, and one at the top of the 16-bit range.
  fake.sendRaw(Buffer.from('080c800100000000000003e8', 'hex'));
  fake.sendRaw(Buffer.from('080c80010000000000007fff', 'hex'));
  fake.setProgram(5);
  await until(() => w.status.program === 5, 'a real cut after the garbage');
  assert.equal(w.status.state, 'connected');
  assert.equal(w.status.inputs.length, KIT_INPUTS.length);
  await until(() => fake.unacked === 0, 'still acking');
});

test('a listener that throws, and a logger that throws, do not reach the socket', async t => {
  const fake = await FakeAtem.start();
  const w = new AtemWatcher({ host: '127.0.0.1', discover: false, port: fake.port, log: () => { throw new Error('logger'); } });
  t.after(async () => { await w.stop(); await fake.close(); });
  w.on('change', () => { throw new Error('listener'); });
  w.start();
  await until(() => w.status.state === 'connected', 'connected despite both');
  fake.setProgram(3);
  await until(() => w.status.program === 3, 'still following');
});

test('stop closes the socket and leaves nothing running', async t => {
  const fake = await FakeAtem.start();
  const c = clock();
  const sent = spySends(t, fake);
  const changes: AtemStatus[] = [];
  const w = new AtemWatcher({ host: '127.0.0.1', discover: false, port: fake.port, now: c.now });
  t.after(async () => {
    await w.stop();
    await fake.close();
    // If stop() ever regresses and leaves a socket open, this test must
    // FAIL, not hang the whole npm test run waiting for the handle.
    for (const sock of new Set(sent.map(s => s.socket))) {
      try { sock.close(); } catch { /* already closed, which is the passing case */ }
    }
  });
  w.on('change', s => changes.push(s));
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  const sockets = new Set(sent.map(s => s.socket));
  assert.equal(sockets.size, 1, 'one socket for the whole session');
  await w.stop();
  // address() throws on a closed dgram socket and only on a closed one.
  for (const sock of sockets) assert.throws(() => sock.address(), /Not running/);
  assert.equal(w.status.state, 'off');
  assert.equal(changes.at(-1)?.state, 'off', 'stop says so');
  const count = sent.length;
  const emitted = changes.length;
  // Nothing fires afterwards: no tick, no retry, no ack, no emit.
  c.advance(10 * ATEM_TIMING.backoffMaxMs);
  fake.setProgram(2);
  await sleep(ATEM_TIMING.tickMs * 3);
  assert.equal(sent.length, count);
  assert.equal(changes.length, emitted);
  await w.stop();
  // And it starts again cleanly, on a new socket.
  w.start();
  await until(() => w.status.state === 'connected', 'connected after a restart');
  await w.stop();
  for (const sock of new Set(sent.map(s => s.socket))) assert.throws(() => sock.address(), /Not running/);
});

test('a process that used a watcher exits on its own after stop: no handle is left open', async () => {
  const url = (f: string): string => pathToFileURL(join(HERE, f)).href;
  const script = `
    import { AtemWatcher } from ${JSON.stringify(url('watcher.ts'))};
    import { FakeAtem } from ${JSON.stringify(url('fake-atem.ts'))};
    const fake = await FakeAtem.start();
    const w = new AtemWatcher({ host: '127.0.0.1', discover: true, candidates: () => ['127.0.0.3'], port: fake.port });
    w.start();
    const end = Date.now() + 3000;
    while (w.status.state !== 'connected' && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    console.log(w.status.state);
    await w.stop();
    await fake.close();
  `;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { err += String(d); });
  const code = await new Promise<number | null>(resolve => {
    const kill = setTimeout(() => { child.kill(); resolve(null); }, 8000);
    child.on('exit', c => { clearTimeout(kill); resolve(c); });
  });
  assert.notEqual(code, null, `the process did not exit on its own: something is still holding it open. ${err}`);
  assert.equal(code, 0, err);
  assert.equal(out.trim(), 'connected');
});

test('a hello answer the desk did not ask for, or from the wrong port, is ignored', async t => {
  // A "switcher port" with nobody behind it but this test, and a second
  // socket on some other port.
  const atPort = dgram.createSocket('udp4');
  const elsewhere = dgram.createSocket('udp4');
  await new Promise<void>(r => atPort.bind(0, '127.0.0.1', () => r()));
  await new Promise<void>(r => elsewhere.bind(0, '127.0.0.1', () => r()));
  const switcherPort = atPort.address().port;
  const sent = spySends(t);
  const c = clock();
  const w = new AtemWatcher({ host: '127.0.0.9', discover: false, port: switcherPort, now: c.now });
  t.after(async () => {
    await w.stop();
    await new Promise<void>(r => atPort.close(() => r()));
    await new Promise<void>(r => elsewhere.close(() => r()));
  });
  w.start();
  await until(() => hellosTo(sent).length === 1, 'the hello to 127.0.0.9');
  await sleep(20);
  // The hello may go out before the bind completes, so the port is read now.
  const watcherPort = sent[0]?.socket.address().port ?? 0;
  assert.ok(watcherPort > 0);
  const answer = Buffer.from('101453ab00000000000000000200000000000000', 'hex');
  assert.equal(parsePacket(answer)?.flags, PacketFlag.NewSessionId);
  // Right port, wrong host: 127.0.0.1 was never asked.
  atPort.send(answer, watcherPort, '127.0.0.1');
  // Wrong port altogether.
  elsewhere.send(answer, watcherPort, '127.0.0.1');
  await settle();
  assert.equal(w.status.state, 'connecting');
  assert.ok(!sent.some(x => classifyClientDatagram(x.bytes)?.kind === 'ack'), 'nothing was acked');
});

// ---- believing only the switcher -------------------------------------------------

test('during a session, a well formed packet from any other address is ignored', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  // Another machine on the switcher's port: the bind is the only way to
  // send FROM that port, and 127.0.0.2 is a second loopback address.
  const impostor = dgram.createSocket('udp4');
  const bound = await new Promise<boolean>(resolve => {
    impostor.once('error', () => resolve(false));
    impostor.bind(fake.port, '127.0.0.2', () => resolve(true));
  });
  t.after(() => new Promise<void>(r => { try { impostor.close(() => r()); } catch { r(); } }));
  if (!bound) {
    t.skip('this machine has no second loopback address (127.0.0.2)');
    return;
  }
  const forged = fake.forgeNext(Cmd.program(0, 4));
  assert.ok(forged);
  impostor.send(forged.bytes, forged.port, forged.address);
  await settle();
  assert.equal(w.status.program, KIT.program, 'the impostor cut nothing');
  // The switcher's own packet with that same id is still taken.
  fake.setProgram(5);
  await until(() => w.status.program === 5, 'the real cut');
  assert.equal(w.status.state, 'connected');
  await until(() => fake.unacked === 0, 'still acking the real switcher');
});

test('commands in a packet that does not ask for an ack are not applied', async t => {
  const { fake, w } = await rig(t);
  w.start();
  await until(() => w.status.state === 'connected', 'connected');
  // Right switcher, right session, the very next id, but without the
  // AckRequest flag: atemSocketChild.js reads commands only from packets
  // that ask for an ack, and so does the watcher.
  for (const flags of [0, PacketFlag.AckReply]) {
    const forged = fake.forgeNext(Cmd.program(0, 4), flags);
    assert.ok(forged);
    fake.sendRaw(forged.bytes);
  }
  await settle();
  assert.equal(w.status.program, KIT.program);
  fake.setProgram(5);
  await until(() => w.status.program === 5, 'the real cut');
  await until(() => fake.unacked === 0, 'still acking');
});
