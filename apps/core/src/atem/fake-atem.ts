/**
 * Fake ATEM: a stand-in switcher for tests and for rehearsing without the
 * rack.
 *
 * It speaks the switcher's side of the real UDP protocol, as atem-connection
 * 3.10.3 describes it (see protocol.ts for the per-fact citations): it
 * answers a hello, waits for the ack, sends an initial state dump split
 * across sequenced packets that each ask for an ack, ends the dump with
 * InCm, sends an empty ack-requesting keepalive every half second, resends
 * whatever is not acked the way a real switcher does, and drops a client
 * that stops acking. The watcher talks to it with exactly the code it uses
 * against the Constellation on the field network; nothing is stubbed on the
 * desk's side of the wire.
 *
 * The dump is the kit's own setup: an ATEM Constellation 4K in 1080p59.94,
 * Field Wide on program, one upstream DVE key off air, and Cheesy Arena's
 * score overlay on the Graphics input as a luma key on DSK1, on air.
 *
 *   node --experimental-strip-types apps/core/src/atem/fake-atem.ts \
 *     [--port 9910] [--cycle 15]
 *
 * --cycle N cuts program between the camera inputs every N seconds, so a
 * rehearsal sees the desk follow along. It binds 127.0.0.1 only: a fake
 * switcher reachable from the venue network could be found by a real
 * desk's discovery sweep.
 *
 * The server-side encoders live here and NOT in protocol.ts on purpose: the
 * client must have no way to build anything but a hello or an ack, and the
 * fake is the only code that ever needs to build what a switcher sends.
 */

import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { fileURLToPath } from 'node:url';
import {
  HEADER_LENGTH,
  MAX_PACKET_ID,
  PacketFlag,
  VideoModeId,
  parsePacket,
} from './protocol.ts';

// ---- the switcher's half of the wire ----------------------------------------

/** One command: u16 length including the 8-byte header, 2 unknown bytes, 4 ASCII name bytes, body. */
export function encodeCommand(name: string, body: Buffer): Buffer {
  const out = Buffer.alloc(8 + body.length, 0);
  out.writeUInt16BE(8 + body.length, 0);
  out.write(name.slice(0, 4).padEnd(4, ' '), 4, 4, 'latin1');
  body.copy(out, 8);
  return out;
}

/** A switcher packet: the same 12-byte header the client parses. */
export function encodePacket(flags: number, sessionId: number, packetId: number, payload: Buffer = Buffer.alloc(0), ackId = 0): Buffer {
  const out = Buffer.alloc(HEADER_LENGTH + payload.length, 0);
  out.writeUInt16BE(((flags & 0x1f) << 11) | ((HEADER_LENGTH + payload.length) & 0x07ff), 0);
  out.writeUInt16BE(sessionId & 0xffff, 2);
  out.writeUInt16BE(ackId & 0xffff, 4);
  out.writeUInt16BE(packetId & 0xffff, 10);
  payload.copy(out, HEADER_LENGTH);
  return out;
}

function fixedString(text: string, length: number): Buffer {
  const out = Buffer.alloc(length, 0);
  out.write(text, 0, length - 1, 'utf8');
  return out;
}

/** Command bodies, laid out as the parsers in protocol.ts read them (and as atem-connection's do). */
export const Cmd = {
  version: (major: number, minor: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(major, 0);
    b.writeUInt16BE(minor, 2);
    return encodeCommand('_ver', b);
  },
  product: (name: string, model: number): Buffer => {
    const b = Buffer.alloc(44, 0);
    fixedString(name, 40).copy(b, 0);
    b.writeUInt8(model, 40);
    return encodeCommand('_pin', b);
  },
  topology: (mixEffects: number, sources: number, downstreamKeyers: number): Buffer => {
    // Protocol 2.30 layout (one byte more than 2.29): MEs, sources, DSKs,
    // aux, mix-minus, media players, multiviewers, serial, HyperDecks, DVEs,
    // stingers, SuperSources, then padding we never read.
    const b = Buffer.alloc(28, 0);
    b.set([mixEffects, sources, downstreamKeyers, 6, 0, 2, 2, 1, 4, 1, 1, 1], 0);
    return encodeCommand('_top', b);
  },
  videoMode: (mode: number): Buffer => {
    const b = Buffer.alloc(4, 0);
    b.writeUInt8(mode, 0);
    return encodeCommand('VidM', b);
  },
  input: (id: number, longName: string, shortName: string): Buffer => {
    const b = Buffer.alloc(36, 0);
    b.writeUInt16BE(id, 0);
    fixedString(longName, 20).copy(b, 2);
    // The short name fills its 4 bytes with no terminator when it is 4 long.
    Buffer.from(shortName.slice(0, 4), 'utf8').copy(b, 22);
    b.writeUInt8(0, 26);
    return encodeCommand('InPr', b);
  },
  program: (me: number, source: number): Buffer => {
    const b = Buffer.alloc(4, 0);
    b.writeUInt8(me, 0);
    b.writeUInt16BE(source, 2);
    return encodeCommand('PrgI', b);
  },
  preview: (me: number, source: number): Buffer => {
    const b = Buffer.alloc(8, 0);
    b.writeUInt8(me, 0);
    b.writeUInt16BE(source, 2);
    return encodeCommand('PrvI', b);
  },
  keyOnAir: (me: number, keyer: number, onAir: boolean): Buffer => {
    const b = Buffer.alloc(4, 0);
    b.set([me, keyer, onAir ? 1 : 0], 0);
    return encodeCommand('KeOn', b);
  },
  keyBase: (me: number, keyer: number, type: number, fill: number, key: number): Buffer => {
    const b = Buffer.alloc(20, 0);
    b.set([me, keyer, type], 0);
    b.writeUInt16BE(fill, 6);
    b.writeUInt16BE(key, 8);
    return encodeCommand('KeBP', b);
  },
  dskSources: (dsk: number, fill: number, key: number): Buffer => {
    const b = Buffer.alloc(8, 0);
    b.writeUInt8(dsk, 0);
    b.writeUInt16BE(fill, 2);
    b.writeUInt16BE(key, 4);
    return encodeCommand('DskB', b);
  },
  dskState: (dsk: number, onAir: boolean, inTransition = false): Buffer => {
    // The V8 layout (protocol 2.29 and up): isTowardsOnAir at 4, remaining frames at 5.
    const b = Buffer.alloc(8, 0);
    b.set([dsk, onAir ? 1 : 0, inTransition ? 1 : 0, 0, 0, 25], 0);
    return encodeCommand('DskS', b);
  },
  initComplete: (): Buffer => encodeCommand('InCm', Buffer.alloc(4, 0)),
} as const;

// ---- the kit ------------------------------------------------------------------

export interface FakeInput { id: number; longName: string; shortName: string }

/**
 * The travel rack's inputs as the AV crew labels them, plus the switcher's
 * own internal sources, with their real ATEM ids (black 0, bars 1000,
 * colours 2001, media players 3010 and 3011, M/E 1 program and preview
 * 10010 and 10011). Graphics (6) is the browser showing Cheesy Arena's
 * score overlay, through a Teranex Mini.
 */
export const KIT_INPUTS: readonly FakeInput[] = [
  { id: 0, longName: 'Black', shortName: 'BLK' },
  { id: 1, longName: 'Field Wide', shortName: 'WIDE' },
  { id: 2, longName: 'Field Tight', shortName: 'TGHT' },
  { id: 3, longName: 'Red Alliance', shortName: 'RED' },
  { id: 4, longName: 'Blue Alliance', shortName: 'BLUE' },
  { id: 5, longName: 'Handheld', shortName: 'HAND' },
  { id: 6, longName: 'Graphics', shortName: 'GFX' },
  { id: 7, longName: 'Desk Program', shortName: 'DESK' },
  { id: 1000, longName: 'Color Bars', shortName: 'BARS' },
  { id: 2001, longName: 'Color 1', shortName: 'COL1' },
  { id: 3010, longName: 'Media Player 1', shortName: 'MP1' },
  { id: 3011, longName: 'Media Player 1 Key', shortName: 'MP1K' },
  { id: 10010, longName: 'Program', shortName: 'PGM' },
  { id: 10011, longName: 'Preview', shortName: 'PVW' },
];

export const KIT = {
  product: 'ATEM Constellation 4K',
  /** dist/enums/index.js `Model.Constellation4K1ME = 28`. */
  model: 28,
  /** 2.32, dist/enums/index.js `ProtocolVersion.V9_6 = 131104`. */
  protocol: [2, 32] as const,
  videoMode: VideoModeId.N1080p5994,
  program: 1,
  preview: 2,
  graphics: 6,
  deskProgram: 7,
} as const;

export interface FakeAtemOptions {
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 0: any free port. */
  port?: number;
  /** Default 500 ms, the switcher's idle keepalive. */
  keepaliveMs?: number;
  /** An unacked packet is resent after this long. Default 200 ms. */
  retransmitMs?: number;
  /** Resends before the switcher gives up on a client and drops it. Default 10. */
  maxRetries?: number;
  /** Payload bytes per packet. A real switcher fills about 1400; the tests use less to get more packets. */
  packetBudget?: number;
  log?: (line: string) => void;
}

interface Pending { buf: Buffer; sentAt: number; tries: number }

interface FakeSession {
  address: string;
  port: number;
  helloSessionId: number;
  sessionId: number;
  established: boolean;
  helloSentAt: number;
  helloTries: number;
  nextId: number;
  unacked: Map<number, Pending>;
}

/** atemSocketChild.js `_isPacketCoveredByAck`: is `packetId` at or before `ackId`, across the 15-bit wrap? */
function covered(ackId: number, packetId: number): boolean {
  const tolerance = MAX_PACKET_ID / 2;
  const shortlyBefore = packetId < ackId && packetId + tolerance > ackId;
  const shortlyAfter = packetId > ackId && packetId < ackId + tolerance;
  const beforeWrap = packetId > ackId + tolerance;
  return packetId === ackId || ((shortlyBefore || beforeWrap) && !shortlyAfter);
}

export class FakeAtem {
  #opts: Required<Omit<FakeAtemOptions, 'log'>> & { log: (line: string) => void };
  #socket: Socket;
  #port = 0;
  #sessions = new Map<string, FakeSession>();
  #timers: NodeJS.Timeout[] = [];
  #silent = false;
  #loseNext = 0;
  #loseForever = 0;
  #refusing = false;
  #nextSession = 1;
  #closed = false;

  /** Every datagram any client sent, in order (capped). The read-only test checks each one. */
  readonly received: Buffer[] = [];
  /** Counters the tests read. */
  hellos = 0;
  acks = 0;
  retransmits = 0;
  sessionsOpened = 0;
  sessionsDropped = 0;
  /** The most sessions ever established at once. */
  maxConcurrent = 0;

  // The switcher's state, which the dump reports and the setters change.
  #videoMode: number = KIT.videoMode;
  #program: number = KIT.program;
  #preview: number = KIT.preview;
  #uskOnAir = false;
  #dskOnAir: boolean[] = [true, false];

  private constructor(opts: FakeAtemOptions) {
    this.#opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 0,
      keepaliveMs: opts.keepaliveMs ?? 500,
      retransmitMs: opts.retransmitMs ?? 200,
      maxRetries: opts.maxRetries ?? 10,
      packetBudget: Math.max(64, Math.min(1400, opts.packetBudget ?? 1400)),
      log: opts.log ?? (() => {}),
    };
    this.#socket = createSocket({ type: 'udp4' });
  }

  /** Binds and resolves once listening. */
  static async start(opts: FakeAtemOptions = {}): Promise<FakeAtem> {
    const fake = new FakeAtem(opts);
    await fake.#listen();
    return fake;
  }

  get port(): number { return this.#port; }
  get address(): string { return this.#opts.host; }
  /** Sessions that have finished the handshake and not been dropped. */
  get activeSessions(): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (s.established) n++;
    return n;
  }
  /** Packets sent and not yet acked, across every session. */
  get unacked(): number {
    let n = 0;
    for (const s of this.#sessions.values()) n += s.unacked.size;
    return n;
  }

  #listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.#socket;
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => {
        try { this.#onMessage(msg, rinfo); } catch (err) { this.#opts.log(`fake ATEM: ${(err as Error).message}`); }
      });
      sock.bind(this.#opts.port, this.#opts.host, () => {
        sock.off('error', reject);
        sock.on('error', err => this.#opts.log(`fake ATEM socket: ${err.message}`));
        this.#port = sock.address().port;
        const keepalive = setInterval(() => this.#keepalive(), this.#opts.keepaliveMs);
        const resend = setInterval(() => this.#resend(), Math.max(10, Math.floor(this.#opts.retransmitMs / 4)));
        keepalive.unref();
        resend.unref();
        this.#timers.push(keepalive, resend);
        this.#opts.log(`fake ATEM listening on ${this.#opts.host}:${this.#port}`);
        resolve();
      });
    });
  }

  // ---- what a test can do to it -------------------------------------------------

  /** Cuts M/E 1 program to this input. */
  setProgram(input: number): void {
    this.#program = input;
    this.#broadcast([Cmd.program(0, input), encodeCommand('TlIn', Buffer.alloc(24, 0))]);
  }

  setPreview(input: number): void {
    this.#preview = input;
    this.#broadcast([Cmd.preview(0, input)]);
  }

  /**
   * DSK on air or off, counted from 1 as on the panel. inTransition is what
   * the switcher reports part way through an auto transition, when the key
   * is fading in or out and so still visible on program.
   */
  setDskOnAir(dsk: number, onAir: boolean, inTransition = false): void {
    const i = dsk - 1;
    if (i < 0 || i >= this.#dskOnAir.length) return;
    this.#dskOnAir[i] = onAir;
    this.#broadcast([Cmd.dskState(i, onAir, inTransition)]);
  }

  /** Upstream key 1 on M/E 1 on air or off. */
  setKeyOnAir(onAir: boolean): void {
    this.#uskOnAir = onAir;
    this.#broadcast([Cmd.keyOnAir(0, 0, onAir)]);
  }

  setVideoMode(mode: number): void {
    this.#videoMode = mode;
    this.#broadcast([Cmd.videoMode(mode)]);
  }

  /**
   * Silent: sends nothing and hears nothing, like a pulled cable. Coming
   * back drops every session, because a real switcher has long since timed
   * out a client it could not hear.
   */
  goSilent(silent = true): void {
    if (this.#silent && !silent) {
      this.sessionsDropped += this.#sessions.size;
      this.#sessions.clear();
    }
    this.#silent = silent;
  }

  /** Drops the next n sequenced packets on their first transmission, so they arrive late, by resend. */
  loseNext(n: number): void { this.#loseNext = Math.max(0, n); }

  /**
   * Drops the next n sequenced packets for good: never sent and never
   * resent, while everything after them still flows. Only a broken network
   * or switcher does this, and the watcher must notice the gap that never
   * fills rather than sit on stale state because keepalives keep arriving.
   */
  loseForever(n: number): void { this.#loseForever = Math.max(0, n); }

  /**
   * Answers every hello with 0x04 and opens no session. 0x04 is the code
   * the watcher reads as being turned down (protocol.ts
   * HelloAnswerCode.Restart, from openswitcher.org's notes); whether a real
   * switcher with every slot taken sends exactly this has not been seen on
   * the kit, so this tests the watcher's handling of the code, not the
   * switcher.
   */
  refuseHellos(refuse = true): void { this.#refusing = refuse; }

  /**
   * The exact bytes this switcher would send as its next sequenced packet to
   * its first established client, and where to, WITHOUT sending them or
   * using up the packet id. A test sends them from another address, or with
   * other flags, to prove the watcher believes only real switcher packets.
   */
  forgeNext(payload: Buffer, flags: number = PacketFlag.AckRequest): { bytes: Buffer; address: string; port: number } | null {
    for (const s of this.#sessions.values()) {
      if (!s.established) continue;
      return { bytes: encodePacket(flags, s.sessionId, s.nextId, payload), address: s.address, port: s.port };
    }
    return null;
  }

  /** Sends raw command bytes to every client in a properly sequenced packet: for fuzzing inside a session. */
  inject(payload: Buffer): void {
    for (const s of this.#sessions.values()) if (s.established) this.#sendSequenced(s, payload.subarray(0, 2035));
  }

  /** Sends arbitrary bytes, header and all, to every client. */
  sendRaw(bytes: Buffer): void {
    for (const s of this.#sessions.values()) this.#write(bytes, s);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.#sessions.clear();
    await new Promise<void>(resolve => {
      try { this.#socket.close(() => resolve()); } catch { resolve(); }
    });
  }

  // ---- the protocol -------------------------------------------------------------

  #onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    if (this.received.length < 20_000) this.received.push(Buffer.from(msg));
    if (this.#silent || this.#closed) return;
    const pkt = parsePacket(msg);
    if (!pkt) return;
    const key = `${rinfo.address}:${rinfo.port}`;

    if (pkt.flags & PacketFlag.NewSessionId) {
      // A hello. A new one from the same address and port replaces whatever
      // session was there, as a client that restarted would expect.
      if (pkt.payload[0] !== 0x01) return;
      this.hellos++;
      if (this.#refusing) {
        // Turned away: the answer goes back on the client's own session id
        // and nothing is kept, so there is no session for an ack to land in.
        const no = Buffer.from([0x04, 0, 0, 0, 0, 0, 0, 0]);
        this.#write(encodePacket(PacketFlag.NewSessionId, pkt.sessionId, 0, no), rinfo);
        return;
      }
      if (this.#sessions.get(key)?.established) this.sessionsDropped++;
      const s: FakeSession = {
        address: rinfo.address,
        port: rinfo.port,
        helloSessionId: pkt.sessionId,
        sessionId: 0x8000 | (this.#nextSession++ & 0x7fff),
        established: false,
        helloSentAt: Date.now(),
        helloTries: 0,
        nextId: 1,
        unacked: new Map(),
      };
      this.#sessions.set(key, s);
      this.#sendHelloAnswer(s);
      return;
    }

    const s = this.#sessions.get(key);
    if (!s) return;
    if ((pkt.flags & PacketFlag.AckReply) === 0) return;
    this.acks++;
    if (!s.established) {
      // The ack of our hello answer, still on the client's hello session id.
      if (pkt.sessionId !== s.helloSessionId || pkt.ackId !== 0) return;
      s.established = true;
      this.sessionsOpened++;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.activeSessions);
      this.#opts.log(`fake ATEM: session ${s.sessionId.toString(16)} with ${key}`);
      this.#sendDump(s);
      return;
    }
    // Acks are cumulative, and must carry the session id we assigned.
    if (pkt.sessionId !== s.sessionId) return;
    for (const id of [...s.unacked.keys()]) if (covered(pkt.ackId, id)) s.unacked.delete(id);
  }

  #sendHelloAnswer(s: FakeSession): void {
    // socket-child.spec.ts "Establish connection": NewSessionId, length 20,
    // the client's session id, packet id 0, and 0x02 (accepted) as byte 12.
    const payload = Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0]);
    this.#write(encodePacket(PacketFlag.NewSessionId, s.helloSessionId, 0, payload), s);
  }

  #dump(): Buffer[] {
    const out: Buffer[] = [
      Cmd.version(KIT.protocol[0], KIT.protocol[1]),
      Cmd.product(KIT.product, KIT.model),
      Cmd.topology(1, KIT_INPUTS.length, 2),
      // A real dump is hundreds of commands the desk does not read; a few
      // are here so a test proves they are skipped, not choked on.
      encodeCommand('_MeC', Buffer.from([0, 4, 0, 0])),
      encodeCommand('_mpl', Buffer.from([20, 0, 0, 0])),
      Cmd.videoMode(this.#videoMode),
    ];
    for (const i of KIT_INPUTS) out.push(Cmd.input(i.id, i.longName, i.shortName));
    out.push(
      Cmd.program(0, this.#program),
      Cmd.preview(0, this.#preview),
      // Upstream key 1: a DVE picture-in-picture of the desk's program.
      Cmd.keyBase(0, 0, 3, KIT.deskProgram, 0),
      Cmd.keyOnAir(0, 0, this.#uskOnAir),
      // DSK1: Cheesy Arena's overlay, luma-keyed over everything.
      Cmd.dskSources(0, KIT.graphics, KIT.graphics),
      Cmd.dskState(0, this.#dskOnAir[0] ?? false),
      // DSK2: the media player's still and its key, off air.
      Cmd.dskSources(1, 3010, 3011),
      Cmd.dskState(1, this.#dskOnAir[1] ?? false),
      encodeCommand('TlIn', Buffer.alloc(24, 0)),
      Cmd.initComplete(),
    );
    return out;
  }

  #sendDump(s: FakeSession): void {
    let packet: Buffer[] = [];
    let size = 0;
    for (const cmd of this.#dump()) {
      if (size + cmd.length > this.#opts.packetBudget && packet.length > 0) {
        this.#sendSequenced(s, Buffer.concat(packet));
        packet = [];
        size = 0;
      }
      packet.push(cmd);
      size += cmd.length;
    }
    if (packet.length) this.#sendSequenced(s, Buffer.concat(packet));
  }

  #broadcast(commands: Buffer[]): void {
    if (this.#silent) return;
    const payload = Buffer.concat(commands);
    for (const s of this.#sessions.values()) if (s.established) this.#sendSequenced(s, payload);
  }

  #sendSequenced(s: FakeSession, payload: Buffer): void {
    const id = s.nextId;
    s.nextId = (s.nextId + 1) % MAX_PACKET_ID;
    const buf = encodePacket(PacketFlag.AckRequest, s.sessionId, id, payload);
    if (this.#loseForever > 0) {
      // Not even kept for resending: the gap this leaves never fills.
      this.#loseForever--;
      return;
    }
    s.unacked.set(id, { buf, sentAt: Date.now(), tries: 0 });
    if (this.#loseNext > 0) {
      this.#loseNext--;
      return;
    }
    this.#write(buf, s);
  }

  #keepalive(): void {
    if (this.#silent || this.#closed) return;
    for (const s of this.#sessions.values()) if (s.established) this.#sendSequenced(s, Buffer.alloc(0));
  }

  #resend(): void {
    if (this.#silent || this.#closed) return;
    const now = Date.now();
    for (const [key, s] of this.#sessions) {
      if (!s.established) {
        if (now - s.helloSentAt < this.#opts.retransmitMs) continue;
        if (s.helloTries >= this.#opts.maxRetries) {
          this.#drop(key, 'never acked the hello answer');
          continue;
        }
        s.helloTries++;
        s.helloSentAt = now;
        this.#sendHelloAnswer(s);
        continue;
      }
      // Oldest first, as the switcher resends.
      for (const [, p] of s.unacked) {
        if (now - p.sentAt < this.#opts.retransmitMs) continue;
        if (p.tries >= this.#opts.maxRetries) {
          this.#drop(key, 'stopped acking');
          break;
        }
        p.tries++;
        p.sentAt = now;
        this.retransmits++;
        const again = Buffer.from(p.buf);
        again.writeUInt8(again.readUInt8(0) | (PacketFlag.IsRetransmit << 3), 0);
        this.#write(again, s);
      }
    }
  }

  #drop(key: string, why: string): void {
    const s = this.#sessions.get(key);
    if (!s) return;
    this.#sessions.delete(key);
    this.sessionsDropped++;
    this.#opts.log(`fake ATEM: dropped ${key}: ${why}`);
  }

  #write(buf: Buffer, s: { address: string; port: number }): void {
    if (this.#closed) return;
    try {
      this.#socket.send(buf, s.port, s.address, () => { /* a lost reply is just a lost UDP packet */ });
    } catch { /* closed under us */ }
  }
}

// ---- CLI ----------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const cycle = Number(arg('cycle') ?? 0);
  void FakeAtem.start({ port: Number(arg('port') ?? 9910), log: line => console.log(line) }).then(fake => {
    console.log(`fake ATEM: point the desk at 127.0.0.1 (port ${fake.port})`);
    if (cycle > 0) {
      const cameras = [1, 2, 3, 4, 5];
      let i = 0;
      setInterval(() => {
        i = (i + 1) % cameras.length;
        const input = cameras[i] ?? 1;
        fake.setProgram(input);
        console.log(`fake ATEM: program is now input ${input}`);
      }, cycle * 1000);
    }
  });
}
