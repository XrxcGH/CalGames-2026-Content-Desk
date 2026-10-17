/**
 * The ATEM wire format: the two things the desk can send, the framing it
 * reads, the dozen commands it understands, and a fuzz over all of it.
 *
 * The fuzz matters more than it looks. These parsers run inside the desk's
 * process on bytes from the network, and Buffer.readUInt16BE throws a
 * RangeError one byte past the end. One missing length check is one
 * uncaught exception in a socket handler, which is the whole desk down in
 * the middle of a match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEADER_LENGTH,
  MAX_PACKET_ID,
  PacketFlag,
  buildClientDatagram,
  classifyClientDatagram,
  helloAnswerCode,
  parseCommand,
  parsePacket,
  protocolLabel,
  splitCommands,
  videoModeInfo,
  type RawCommand,
} from './protocol.ts';
import { Cmd, KIT_INPUTS, encodeCommand, encodePacket } from './fake-atem.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** mulberry32: a seeded PRNG, so a fuzz failure can be replayed exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(next: () => number, n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256);
  return b;
}

// ---- what the desk sends ------------------------------------------------------

test('the hello is atem-connection\'s COMMAND_CONNECT_HELLO byte for byte', () => {
  const hello = buildClientDatagram({ kind: 'hello' });
  assert.equal(hello.toString('hex'), '101453ab00000000003a00000100000000000000');
  assert.deepEqual(classifyClientDatagram(hello), { kind: 'hello' });
  // A fresh buffer each time: nobody can scribble on a shared hello.
  assert.notEqual(buildClientDatagram({ kind: 'hello' }), hello);
});

test('the ack is AckReply with length 12, the session id and the acked packet id, and nothing else', () => {
  const ack = buildClientDatagram({ kind: 'ack', sessionId: 0x8001, packetId: 0x1234 });
  // socket-child.spec.ts expects 80 0c <session> 00 00 ... for the ack of a hello answer.
  assert.equal(ack.toString('hex'), '800c80011234000000000000');
  assert.deepEqual(classifyClientDatagram(ack), { kind: 'ack', sessionId: 0x8001, packetId: 0x1234 });
  // Out-of-range numbers are masked into range, never thrown on.
  const wild = buildClientDatagram({ kind: 'ack', sessionId: -1, packetId: 0xffff });
  assert.equal(wild.length, HEADER_LENGTH);
  assert.ok(classifyClientDatagram(wild));
});

test('classifyClientDatagram rejects anything that is not exactly a hello or an ack', () => {
  const ack = buildClientDatagram({ kind: 'ack', sessionId: 1, packetId: 1 });
  const withPayload = Buffer.concat([ack, Buffer.from([0])]);
  const asksForAck = Buffer.from(ack);
  asksForAck.writeUInt16BE(((PacketFlag.AckReply | PacketFlag.AckRequest) << 11) | 12, 0);
  const strayByte = Buffer.from(ack);
  strayByte[11] = 1;
  const command = encodePacket(PacketFlag.AckRequest, 1, 1, Cmd.program(0, 2));
  for (const bad of [withPayload, asksForAck, strayByte, command, Buffer.alloc(0), Buffer.alloc(12)]) {
    assert.equal(classifyClientDatagram(bad), null, bad.toString('hex'));
  }
});

// ---- framing -----------------------------------------------------------------------

test('parsePacket reads the 12-byte header and refuses a length that disagrees with the datagram', () => {
  const payload = Cmd.program(0, 3);
  const pkt = encodePacket(PacketFlag.AckRequest | PacketFlag.IsRetransmit, 0x8003, 77, payload, 5);
  const p = parsePacket(pkt);
  assert.ok(p);
  assert.equal(p.flags, PacketFlag.AckRequest | PacketFlag.IsRetransmit);
  assert.equal(p.sessionId, 0x8003);
  assert.equal(p.packetId, 77);
  assert.equal(p.ackId, 5);
  assert.equal(p.length, pkt.length);
  assert.deepEqual(p.payload, payload);

  // One byte short, one byte long, a header claiming more than is there.
  assert.equal(parsePacket(pkt.subarray(0, pkt.length - 1)), null);
  assert.equal(parsePacket(Buffer.concat([pkt, Buffer.from([0])])), null);
  const lying = Buffer.from(pkt);
  lying.writeUInt16BE((PacketFlag.AckRequest << 11) | 0x07ff, 0);
  assert.equal(parsePacket(lying), null);
  // Too short for a header, and too long for the 11-bit length to describe.
  assert.equal(parsePacket(Buffer.alloc(11)), null);
  assert.equal(parsePacket(Buffer.alloc(4096)), null);
});

test('a hello answer is NewSessionId plus a status byte', () => {
  const accepted = parsePacket(encodePacket(PacketFlag.NewSessionId, 0x53ab, 0, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0])));
  assert.ok(accepted);
  assert.equal(helloAnswerCode(accepted), 2);
  const plain = parsePacket(encodePacket(PacketFlag.AckRequest, 1, 1));
  assert.ok(plain);
  assert.equal(helloAnswerCode(plain), null);
  const empty = parsePacket(encodePacket(PacketFlag.NewSessionId, 1, 0));
  assert.ok(empty);
  assert.equal(helloAnswerCode(empty), null);
});

test('splitCommands walks length-prefixed commands and stops at a truncated or impossible one', () => {
  const a = Cmd.program(0, 1);
  const b = Cmd.dskState(0, true);
  assert.deepEqual(splitCommands(Buffer.concat([a, b])).map(c => c.name), ['PrgI', 'DskS']);

  // The second command claims 4 bytes more than the payload holds: it is
  // dropped whole, not handed to a parser as a short body.
  const truncated = Buffer.concat([a, b.subarray(0, b.length - 4)]);
  assert.deepEqual(splitCommands(truncated).map(c => c.name), ['PrgI']);

  // A length under 8 could never advance; everything from there is dropped.
  const tiny = Buffer.from(a);
  tiny.writeUInt16BE(4, 0);
  assert.deepEqual(splitCommands(Buffer.concat([tiny, b])), []);

  // A header-only command is legal and is kept.
  assert.deepEqual(splitCommands(encodeCommand('InCm', Buffer.alloc(0))).map(c => c.name), ['InCm']);
});

// ---- commands ----------------------------------------------------------------------

function one(cmd: Buffer): ReturnType<typeof parseCommand> {
  const [raw] = splitCommands(cmd);
  assert.ok(raw);
  return parseCommand(raw);
}

test('each command the desk reads comes back with the fields at atem-connection\'s offsets', () => {
  assert.deepEqual(one(Cmd.version(2, 32)), { name: '_ver', version: 0x00020020 });
  assert.deepEqual(one(Cmd.product('ATEM Constellation 4K', 28)), { name: '_pin', product: 'ATEM Constellation 4K', model: 28 });
  assert.deepEqual(one(Cmd.topology(1, 14, 2)), { name: '_top', mixEffects: 1, sources: 14, downstreamKeyers: 2 });
  assert.deepEqual(one(Cmd.videoMode(13)), { name: 'VidM', mode: 13 });
  assert.deepEqual(one(Cmd.input(6, 'Graphics', 'GFX')), { name: 'InPr', id: 6, longName: 'Graphics', shortName: 'GFX' });
  // A four-letter short name fills its field with no NUL.
  assert.deepEqual(one(Cmd.input(1, 'Field Wide', 'WIDE')), { name: 'InPr', id: 1, longName: 'Field Wide', shortName: 'WIDE' });
  assert.deepEqual(one(Cmd.program(0, 10010)), { name: 'PrgI', me: 0, source: 10010 });
  assert.deepEqual(one(Cmd.preview(1, 2)), { name: 'PrvI', me: 1, source: 2 });
  assert.deepEqual(one(Cmd.keyOnAir(0, 1, true)), { name: 'KeOn', me: 0, keyer: 1, onAir: true });
  assert.deepEqual(one(Cmd.keyBase(0, 0, 0, 6, 6)), { name: 'KeBP', me: 0, keyer: 0, type: 'luma', fillSource: 6, keySource: 6 });
  assert.deepEqual(one(Cmd.keyBase(0, 0, 3, 7, 0)), { name: 'KeBP', me: 0, keyer: 0, type: 'dve', fillSource: 7, keySource: 0 });
  assert.deepEqual(one(Cmd.keyBase(0, 0, 9, 7, 0)), { name: 'KeBP', me: 0, keyer: 0, type: null, fillSource: 7, keySource: 0 });
  assert.deepEqual(one(Cmd.dskState(0, true, false)), { name: 'DskS', keyer: 0, onAir: true, inTransition: false });
  assert.deepEqual(one(Cmd.dskSources(1, 3010, 3011)), { name: 'DskB', keyer: 1, fillSource: 3010, keySource: 3011 });
  assert.deepEqual(one(Cmd.initComplete()), { name: 'InCm' });
  assert.equal(one(encodeCommand('TlIn', Buffer.alloc(24))), null);
});

test('the pre-2.29 DskS layout reads the same on air and in transition bytes', () => {
  // DownstreamKeyStateCommand (before V8_0_1): keyer, onAir, inTransition, isAuto, remainingFrames.
  assert.deepEqual(one(encodeCommand('DskS', Buffer.from([1, 0, 1, 1, 12, 0, 0, 0]))), { name: 'DskS', keyer: 1, onAir: false, inTransition: true });
});

test('a name with control characters or no terminator is cleaned, not trusted', () => {
  const body = Buffer.alloc(36, 0x41);
  body.writeUInt16BE(9, 0);
  body.write('Cam\u0007 9\u0000junk', 2, 'utf8');
  const cmd = one(encodeCommand('InPr', body));
  assert.deepEqual(cmd, { name: 'InPr', id: 9, longName: 'Cam 9', shortName: 'AAAA' });
});

test('every command refuses a body too short for the fields it reads', () => {
  const minimum: Record<string, number> = { _ver: 4, _pin: 1, _top: 3, VidM: 1, InPr: 26, PrgI: 4, PrvI: 4, KeOn: 3, KeBP: 10, DskS: 3, DskB: 6 };
  for (const [name, min] of Object.entries(minimum)) {
    for (let len = 0; len < min; len++) {
      assert.equal(parseCommand({ name, body: Buffer.alloc(len, 1) }), null, `${name} with ${len} bytes`);
    }
    assert.notEqual(parseCommand({ name, body: Buffer.alloc(min, 1) }), null, `${name} with ${min} bytes`);
  }
});

test('video modes and protocol versions read as the ATEM menus print them', () => {
  assert.deepEqual(videoModeInfo(13), { id: 13, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 });
  assert.deepEqual(videoModeInfo(16), { id: 16, label: '2160p25', width: 3840, height: 2160, fps: 25 });
  assert.deepEqual(videoModeInfo(6), { id: 6, label: '1080i50', width: 1920, height: 1080, fps: 25 });
  assert.deepEqual(videoModeInfo(27), { id: 27, label: '1080p60', width: 1920, height: 1080, fps: 60 });
  assert.equal(videoModeInfo(25).height, 4320);
  assert.equal(videoModeInfo(200).label, 'unknown video mode 200');
  assert.equal(protocolLabel(131094), '2.22');
  assert.equal(protocolLabel(131104), '2.32');
});

// ---- fuzz --------------------------------------------------------------------------

/** A realistic packet: the fake's own dump, so the fuzz starts from real shapes. */
function realPayload(): Buffer {
  return Buffer.concat([
    Cmd.version(2, 32), Cmd.product('ATEM Constellation 4K', 28), Cmd.topology(1, 14, 2), Cmd.videoMode(13),
    ...KIT_INPUTS.slice(0, 6).map(i => Cmd.input(i.id, i.longName, i.shortName)),
    Cmd.program(0, 1), Cmd.preview(0, 2), Cmd.keyBase(0, 0, 3, 7, 0), Cmd.keyOnAir(0, 0, false),
    Cmd.dskSources(0, 6, 6), Cmd.dskState(0, true), Cmd.initComplete(),
  ]);
}

const NAMES = ['_ver', '_pin', '_top', 'VidM', 'InPr', 'PrgI', 'PrvI', 'KeOn', 'KeBP', 'DskS', 'DskB', 'InCm', 'TlIn', '????'];

/** Runs bytes through every reader the watcher uses, checking the invariants each promises. */
function exercise(bytes: Buffer): void {
  const p = parsePacket(bytes);
  if (p) {
    assert.equal(p.length, bytes.length);
    assert.ok(p.packetId <= 0xffff && p.sessionId <= 0xffff);
    helloAnswerCode(p);
  }
  for (const payload of [bytes, p?.payload ?? Buffer.alloc(0)]) {
    let consumed = 0;
    for (const raw of splitCommands(payload)) {
      // Every command handed on is whole: its declared length is exactly
      // its header plus its body, and it lies inside the payload.
      assert.equal(payload.readUInt16BE(consumed), raw.body.length + 8);
      consumed += raw.body.length + 8;
      assert.ok(consumed <= payload.length);
      parseCommand(raw);
    }
  }
  classifyClientDatagram(bytes);
}

test('fuzz: random datagrams never throw and never yield a command past the end', () => {
  const next = rng(0xa7e3);
  for (let i = 0; i < 20_000; i++) {
    const n = Math.floor(next() * 80);
    const bytes = randomBytes(next, n);
    // Half the time, make the header length honest so the payload path runs.
    if (n >= 12 && next() < 0.5) bytes.writeUInt16BE((Math.floor(next() * 32) << 11) | n, 0);
    exercise(bytes);
  }
});

test('fuzz: every truncation and every single-byte corruption of a real packet is survived', () => {
  const payload = realPayload();
  const pkt = encodePacket(PacketFlag.AckRequest, 0x8001, 1, payload);
  for (let cut = 0; cut <= pkt.length; cut++) {
    exercise(pkt.subarray(0, cut));
    exercise(payload.subarray(0, cut));
  }
  const next = rng(0x5eed);
  for (let i = 0; i < 20_000; i++) {
    const bent = Buffer.from(pkt);
    const flips = 1 + Math.floor(next() * 4);
    for (let f = 0; f < flips; f++) bent[Math.floor(next() * bent.length)] = Math.floor(next() * 256);
    exercise(bent);
    exercise(bent.subarray(HEADER_LENGTH));
  }
});

test('fuzz: every known command name with every body length from 0 to 48', () => {
  const next = rng(0xc0de);
  for (const name of NAMES) {
    for (let len = 0; len <= 48; len++) {
      for (let k = 0; k < 20; k++) {
        const raw: RawCommand = { name, body: randomBytes(next, len) };
        parseCommand(raw);
        exercise(encodeCommand(name, raw.body));
      }
    }
  }
});

test('fuzz: absurd command lengths inside an honest packet are dropped, not followed', () => {
  for (const len of [0, 1, 7, 8, 9, 12, 13, 0x7ff, 0xffff]) {
    const cmd = Cmd.program(0, 1);
    cmd.writeUInt16BE(len, 0);
    const pkt = encodePacket(PacketFlag.AckRequest, 1, 1, cmd);
    exercise(pkt);
    const p = parsePacket(pkt);
    assert.ok(p);
    const cmds = splitCommands(p.payload);
    if (len === 12) assert.equal(cmds.length, 1);
    else if (len < 8 || len > 12) assert.equal(cmds.length, 0, `length ${len}`);
    else assert.ok(cmds.every(c => c.body.length + 8 === len), `length ${len}`);
  }
  // Packet ids from the top of the 16-bit range are carried, never trusted:
  // the watcher discards anything at or above the 15-bit wrap.
  const high = parsePacket(encodePacket(PacketFlag.AckRequest, 1, 0xffff));
  assert.ok(high && high.packetId >= MAX_PACKET_ID);
});

// ---- house rules ----------------------------------------------------------------

test('no em dash, en dash or stray control character in any file of the ATEM client', () => {
  // Built from char codes, so this file is not itself the thing it forbids.
  const em = String.fromCharCode(0x2014);
  const en = String.fromCharCode(0x2013);
  const files = readdirSync(HERE).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 7, 'expected the atem sources and their tests');
  for (const f of files) {
    const text = readFileSync(join(HERE, f), 'utf8');
    assert.ok(!text.includes(em), `${f} has an em dash`);
    assert.ok(!text.includes(en), `${f} has an en dash`);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) assert.fail(`${f} has control character ${c} at ${i}`);
    }
  }
});
