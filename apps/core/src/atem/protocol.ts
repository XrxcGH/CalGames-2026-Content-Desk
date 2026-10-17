/**
 * The ATEM switcher protocol: the read-only subset the desk needs.
 *
 * Blackmagic never published this protocol. Everything here comes from
 * atem-connection 3.10.3 (MIT, github.com/nrkno/sofie-atem-connection), which
 * reverse-engineered it, and each fact below names the file in that package's
 * dist/ it was read from. We do NOT depend on atem-connection: it pulls in a
 * native freetype module, and exit-hook, which takes over SIGINT and would
 * cut off the desk's event-log flush on Ctrl+C.
 *
 * Two halves, kept apart on purpose:
 *
 *   What the desk SENDS: exactly two datagram shapes, the hello and the
 *   acknowledgement, both built by buildClientDatagram() and nothing else.
 *   There is no command encoder on the client side at all, so there is no
 *   way to write a "cut to camera 2" from this code even by mistake. The
 *   switcher on the AV table is shared with ATEM Software Control, and the
 *   desk changing what is on air would be the worst possible failure.
 *
 *   What the desk READS: packet framing and the dozen commands that say
 *   what is on air. Every read is bounds-checked. A malformed, truncated or
 *   absurd datagram is dropped, never thrown on, because this runs inside
 *   the desk's process and a crash here takes the whole show down.
 *
 * Server-side encoders (the switcher's half) live in fake-atem.ts, which is
 * the only thing that ever needs to build them.
 */

/** dist/atem.js: `DEFAULT_PORT = 9910`. */
export const ATEM_PORT = 9910;

/**
 * The five header flags, from dist/lib/atemSocketChild.js `PacketFlag`. They
 * occupy the top five bits of the first header word (`readUInt8(0) >> 3`).
 * A const object rather than an enum: this file runs under
 * --experimental-strip-types, which only accepts erasable TypeScript.
 */
export const PacketFlag = {
  AckRequest: 0x01,
  NewSessionId: 0x02,
  IsRetransmit: 0x04,
  RetransmitRequest: 0x08,
  AckReply: 0x10,
} as const;

/** Every packet starts with a 12-byte header (atemSocketChild.js `sendPacket`: `Buffer.alloc(12 + payloadLength)`). */
export const HEADER_LENGTH = 12;

/**
 * Packet ids are 15 bits and wrap (atemSocketChild.js: `MAX_PACKET_ID = 1 << 15`,
 * "Atem expects 15 not 16 bits before wrapping").
 */
export const MAX_PACKET_ID = 1 << 15;

/** The length lives in the low 11 bits of the first header word (`& 0x07ff`), so no valid datagram is longer. */
export const MAX_DATAGRAM = 0x07ff;

/**
 * Byte 12 of the switcher's hello answer. atem-connection's own socket test
 * (src/lib/__tests__/socket-child.spec.ts, "Establish connection") feeds 0x02
 * as the answer, and docs.openswitcher.org/udptransport.html says "On a
 * successful connection this should be 0x02" and that on 0x04 "you should
 * restart the connection". atem-connection itself ignores the byte; we treat
 * 0x04 as the switcher turning us down, because carrying on as if we had a
 * session would leave the desk acking into nothing.
 */
export const HelloAnswerCode = {
  Accepted: 0x02,
  Restart: 0x04,
} as const;

export interface AtemPacket {
  /** Header flags, see PacketFlag. */
  flags: number;
  /** Header length field, always equal to the datagram size once parsed. */
  length: number;
  sessionId: number;
  /** Bytes 4-5: the packet id being acknowledged, on an AckReply. */
  ackId: number;
  /** Bytes 6-7: the first packet to resend, on a RetransmitRequest. */
  retransmitFrom: number;
  /** Bytes 10-11: the sender's own packet id, on an AckRequest. */
  packetId: number;
  /** Everything after the 12-byte header: zero or more commands. */
  payload: Buffer;
}

/**
 * Parses one datagram's header, or returns null for anything that is not a
 * well-formed ATEM packet.
 *
 * Layout, from atemSocketChild.js `_receivePacket` and `sendPacket`:
 *   0-1   flags (top 5 bits) and length (low 11 bits)
 *   2-3   session id
 *   4-5   ack id (the remote packet being acknowledged)
 *   6-7   retransmit-from id
 *   8-9   unknown (the hello carries 0x003a here)
 *   10-11 packet id
 *   12-   payload
 *
 * The length check is atem-connection's own (`if (length !== rinfo.size)
 * return`) and it is the important one: it is what makes a stray datagram on
 * port 9910, or a truncated one, fall on the floor instead of being read as
 * commands.
 */
export function parsePacket(buf: Buffer): AtemPacket | null {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length < HEADER_LENGTH || buf.length > MAX_DATAGRAM) return null;
  const word = buf.readUInt16BE(0);
  const length = word & 0x07ff;
  if (length !== buf.length) return null;
  return {
    flags: word >> 11,
    length,
    sessionId: buf.readUInt16BE(2),
    ackId: buf.readUInt16BE(4),
    retransmitFrom: buf.readUInt16BE(6),
    packetId: buf.readUInt16BE(10),
    payload: buf.subarray(HEADER_LENGTH),
  };
}

/**
 * A hello answer is the switcher's reply to our hello: the NewSessionId flag
 * and a status byte (see HelloAnswerCode). Returns that byte, or null when
 * the packet is not a hello answer at all.
 */
export function helloAnswerCode(p: AtemPacket): number | null {
  if ((p.flags & PacketFlag.NewSessionId) === 0) return null;
  const code = p.payload[0];
  return code === undefined ? null : code;
}

// ---- What the desk sends: the only two shapes there are ---------------------

/**
 * Every datagram the desk can ever send to a switcher.
 *
 * The hello opens a session. The ack tells the switcher which of its packets
 * we have, and it is also the protocol's keepalive from our side: the
 * switcher sends an empty AckRequest packet every so often and drops a
 * client that stops acking them, while the client itself sends nothing
 * unprompted (atemSocketChild.js has no client-initiated keepalive; its only
 * sends are the hello, acks, and commands, and we have no commands).
 */
export type ClientDatagram =
  | { kind: 'hello' }
  | { kind: 'ack'; sessionId: number; packetId: number };

/**
 * atemSocketChild.js `COMMAND_CONNECT_HELLO`, byte for byte: flags
 * NewSessionId with length 20 (0x10 0x14), session id 0x53ab, 0x003a in the
 * unknown bytes 8-9, and a payload whose first byte 0x01 means "hello".
 */
const HELLO: readonly number[] = [
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/** The ack's first header word: AckReply in the flag bits, length 12 (atemSocketChild.js `_sendAck`). */
const ACK_WORD = (PacketFlag.AckReply << 11) | HEADER_LENGTH;

/**
 * Builds a client datagram. This is the ONLY function in the client that
 * produces bytes for the wire, and the watcher's one send path takes its
 * argument from here. It masks rather than throws: a bad number must never
 * become an exception inside a socket handler.
 */
export function buildClientDatagram(d: ClientDatagram): Buffer {
  if (d.kind === 'hello') return Buffer.from(HELLO);
  // atemSocketChild.js `_sendAck`: 12 bytes, session id at 2, the acked
  // packet id at 4, everything else zero.
  const buf = Buffer.alloc(HEADER_LENGTH, 0);
  buf.writeUInt16BE(ACK_WORD, 0);
  buf.writeUInt16BE((d.sessionId >>> 0) & 0xffff, 2);
  buf.writeUInt16BE(((d.packetId >>> 0) & 0xffff) % MAX_PACKET_ID, 4);
  return buf;
}

/**
 * The inverse, for tests and for the fake switcher: what kind of client
 * datagram these bytes are, or null when they are anything else. The
 * read-only test runs a whole session and requires every byte the watcher
 * sent to come back non-null from this.
 */
export function classifyClientDatagram(buf: Buffer): ClientDatagram | null {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length === HELLO.length && HELLO.every((b, i) => buf[i] === b)) return { kind: 'hello' };
  if (buf.length !== HEADER_LENGTH) return null;
  if (buf.readUInt16BE(0) !== ACK_WORD) return null;
  for (let i = 6; i < HEADER_LENGTH; i++) if (buf[i] !== 0) return null;
  const packetId = buf.readUInt16BE(4);
  if (packetId >= MAX_PACKET_ID) return null;
  return { kind: 'ack', sessionId: buf.readUInt16BE(2), packetId };
}

// ---- What the desk reads: commands ------------------------------------------

export interface RawCommand {
  /** Four ASCII characters, e.g. "PrgI". */
  name: string;
  body: Buffer;
}

/** A command is at least its 8-byte header (dist/lib/atemSocket.js `_parseCommands`). */
export const COMMAND_HEADER_LENGTH = 8;

/**
 * Splits a packet payload into commands.
 *
 * Framing, from dist/lib/atemSocket.js `_parseCommands`: each command is a
 * 2-byte length that INCLUDES the 8-byte header, 2 unknown bytes, a 4-byte
 * ASCII name, then the body (`buffer.subarray(8, length)`).
 *
 * Two checks atem-connection does not make, because it trusts the switcher
 * and we cannot afford to: a command whose length runs past the end of the
 * payload stops the split (subarray would silently hand back a short body,
 * and the parsers below would read a truncated command as if it were
 * whole), and so does a length under 8 (atem-connection's own rule, since
 * that could never advance the loop). atem-connection also loops on
 * `length > 8`, which skips a header-only command at the very end; we take
 * it, since nothing about such a command is malformed.
 */
export function splitCommands(payload: Buffer): RawCommand[] {
  const out: RawCommand[] = [];
  let off = 0;
  while (off + COMMAND_HEADER_LENGTH <= payload.length) {
    const len = payload.readUInt16BE(off);
    if (len < COMMAND_HEADER_LENGTH || off + len > payload.length) break;
    out.push({
      name: payload.toString('latin1', off + 4, off + 8),
      body: payload.subarray(off + COMMAND_HEADER_LENGTH, off + len),
    });
    off += len;
  }
  return out;
}

/** Upstream keyer types, in wire order: dist/enums/index.js `MixEffectKeyType` (Luma 0, Chroma 1, Pattern 2, DVE 3). */
export const KEY_TYPES = ['luma', 'chroma', 'pattern', 'dve'] as const;
export type KeyType = typeof KEY_TYPES[number];

/**
 * The commands the desk understands. Indexes (M/E, keyer, DSK) are as on the
 * wire, counted from 0; the watcher turns them into the 1-based numbers
 * printed on the panel.
 */
export type AtemCommand =
  | { name: '_ver'; version: number }
  | { name: '_pin'; product: string; model: number | null }
  | { name: '_top'; mixEffects: number; sources: number; downstreamKeyers: number }
  | { name: 'VidM'; mode: number }
  | { name: 'InPr'; id: number; longName: string; shortName: string }
  | { name: 'PrgI'; me: number; source: number }
  | { name: 'PrvI'; me: number; source: number }
  | { name: 'KeOn'; me: number; keyer: number; onAir: boolean }
  | { name: 'KeBP'; me: number; keyer: number; type: KeyType | null; fillSource: number; keySource: number }
  | { name: 'DskS'; keyer: number; onAir: boolean; inTransition: boolean }
  | { name: 'DskB'; keyer: number; fillSource: number; keySource: number }
  | { name: 'InCm' };

/**
 * dist/lib/atemUtil.js `bufToNullTerminatedString`: the bytes up to the
 * first NUL, as UTF-8. Then one thing it does not do: strip control
 * characters. Input names are typed by whoever set the switcher up, they end
 * up on the desk console, and a stray control byte has no business there.
 */
function nameAt(body: Buffer, start: number, length: number): string {
  const slice = body.subarray(start, start + length);
  const nul = slice.indexOf(0);
  const raw = slice.toString('utf8', 0, nul < 0 ? slice.length : nul);
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

/**
 * Reads one command, or returns null when it is one we do not need, or is
 * too short for the fields we read. Each case states the minimum body length
 * it requires, and that check comes BEFORE any read: Buffer.readUInt16BE
 * throws a RangeError past the end, and a throw here would surface inside
 * the socket's message handler.
 */
export function parseCommand(raw: RawCommand): AtemCommand | null {
  const b = raw.body;
  switch (raw.name) {
    // dist/commands/DeviceProfile/versionCommand.js: `readUInt32BE(0)`.
    case '_ver':
      if (b.length < 4) return null;
      return { name: '_ver', version: b.readUInt32BE(0) };

    // dist/commands/DeviceProfile/productIdentifierCommand.js: the product
    // name is a NUL-terminated string in bytes 0-39, the model enum byte 40.
    case '_pin': {
      if (b.length < 1) return null;
      const product = nameAt(b, 0, 40);
      return { name: '_pin', product, model: b.length > 40 ? b.readUInt8(40) : null };
    }

    // dist/commands/DeviceProfile/topologyCommand.js: mixEffects at 0,
    // sources at 1, downstreamKeyers at 2. Those three do not move between
    // protocol versions; the fields after byte 6 do, and we read none of them.
    case '_top':
      if (b.length < 3) return null;
      return { name: '_top', mixEffects: b.readUInt8(0), sources: b.readUInt8(1), downstreamKeyers: b.readUInt8(2) };

    // dist/commands/Settings/VideoMode.js `VideoModeUpdateCommand`: `readUInt8(0)`.
    case 'VidM':
      if (b.length < 1) return null;
      return { name: 'VidM', mode: b.readUInt8(0) };

    // dist/commands/Inputs/InputPropertiesCommand.js `InputPropertiesUpdateCommand`:
    // inputId u16 at 0, longName 20 bytes at 2, shortName 4 bytes at 22.
    case 'InPr':
      if (b.length < 26) return null;
      return { name: 'InPr', id: b.readUInt16BE(0), longName: nameAt(b, 2, 20), shortName: nameAt(b, 22, 4) };

    // dist/commands/MixEffects/ProgramInputCommand.js and PreviewInputCommand.js:
    // mixEffect u8 at 0, source u16 at 2.
    case 'PrgI':
    case 'PrvI':
      if (b.length < 4) return null;
      return { name: raw.name === 'PrgI' ? 'PrgI' : 'PrvI', me: b.readUInt8(0), source: b.readUInt16BE(2) };

    // dist/commands/MixEffects/Key/MixEffectKeyOnAirCommand.js `MixEffectKeyOnAirUpdateCommand`:
    // mixEffect at 0, keyer at 1, onAir at 2 (`=== 1`).
    case 'KeOn':
      if (b.length < 3) return null;
      return { name: 'KeOn', me: b.readUInt8(0), keyer: b.readUInt8(1), onAir: b.readUInt8(2) === 1 };

    // dist/commands/MixEffects/Key/MixEffectKeyPropertiesGetCommand.js:
    // mixEffect at 0, keyer at 1, key type at 2, fillSource u16 at 6,
    // cutSource (the key source) u16 at 8.
    case 'KeBP': {
      if (b.length < 10) return null;
      const t = b.readUInt8(2);
      return {
        name: 'KeBP',
        me: b.readUInt8(0),
        keyer: b.readUInt8(1),
        type: KEY_TYPES[t] ?? null,
        fillSource: b.readUInt16BE(6),
        keySource: b.readUInt16BE(8),
      };
    }

    // dist/commands/DownstreamKey/DownstreamKeyStateCommand.js: keyer at 0,
    // onAir at 1, inTransition at 2. The V8 variant (protocol 2.29 and up)
    // inserts isTowardsOnAir at 4 and moves remainingFrames, but bytes 0-2
    // are the same in both, so one reader serves every firmware.
    case 'DskS':
      if (b.length < 3) return null;
      return { name: 'DskS', keyer: b.readUInt8(0), onAir: b.readUInt8(1) === 1, inTransition: b.readUInt8(2) === 1 };

    // dist/commands/DownstreamKey/DownstreamKeySourcesCommand.js: keyer at 0,
    // fillSource u16 at 2, cutSource u16 at 4.
    case 'DskB':
      if (b.length < 6) return null;
      return { name: 'DskB', keyer: b.readUInt8(0), fillSource: b.readUInt16BE(2), keySource: b.readUInt16BE(4) };

    // dist/commands/InitCompleteCommand.js: no fields. The switcher sends it
    // once, after the initial state dump, and atem-connection's dist/atem.js
    // only reports CONNECTED on it.
    case 'InCm':
      return { name: 'InCm' };

    default:
      return null;
  }
}

// ---- Labels ------------------------------------------------------------------

export interface VideoModeInfo {
  id: number;
  /** As the ATEM menus print it: 1080p59.94, 2160p25, 1080i50. */
  label: string;
  width: number;
  height: number;
  /** Frames per second. For an interlaced mode the label shows the field rate, so 1080i50 is 25. */
  fps: number;
}

/**
 * The VidM mode byte, from dist/enums/index.js `VideoMode` (the enum value is
 * the index here), with sizes from dist/lib/videoMode.js `VideoModeInfoImpl`.
 * Two notes on those sizes: the SD modes are what atem-connection reports
 * (640x480 for 525 lines, 720x576 for 625), and its 8K height is a typo
 * (4260), corrected here to 7680x4320, the 8K UHD raster.
 */
const VIDEO_MODES: readonly (readonly [label: string, width: number, height: number, fps: number])[] = [
  ['525i59.94 NTSC', 640, 480, 29.97], // 0  N525i5994NTSC
  ['625i50 PAL', 720, 576, 25], // 1  P625i50PAL
  ['525i59.94 16:9', 640, 480, 29.97], // 2  N525i5994169
  ['625i50 16:9', 720, 576, 25], // 3  P625i50169
  ['720p50', 1280, 720, 50], // 4  P720p50
  ['720p59.94', 1280, 720, 59.94], // 5  N720p5994
  ['1080i50', 1920, 1080, 25], // 6  P1080i50
  ['1080i59.94', 1920, 1080, 29.97], // 7  N1080i5994
  ['1080p23.98', 1920, 1080, 23.98], // 8  N1080p2398
  ['1080p24', 1920, 1080, 24], // 9  N1080p24
  ['1080p25', 1920, 1080, 25], // 10 P1080p25
  ['1080p29.97', 1920, 1080, 29.97], // 11 N1080p2997
  ['1080p50', 1920, 1080, 50], // 12 P1080p50
  ['1080p59.94', 1920, 1080, 59.94], // 13 N1080p5994
  ['2160p23.98', 3840, 2160, 23.98], // 14 N4KHDp2398
  ['2160p24', 3840, 2160, 24], // 15 N4KHDp24
  ['2160p25', 3840, 2160, 25], // 16 P4KHDp25
  ['2160p29.97', 3840, 2160, 29.97], // 17 N4KHDp2997
  ['2160p50', 3840, 2160, 50], // 18 P4KHDp5000
  ['2160p59.94', 3840, 2160, 59.94], // 19 N4KHDp5994
  ['4320p23.98', 7680, 4320, 23.98], // 20 N8KHDp2398
  ['4320p24', 7680, 4320, 24], // 21 N8KHDp24
  ['4320p25', 7680, 4320, 25], // 22 P8KHDp25
  ['4320p29.97', 7680, 4320, 29.97], // 23 N8KHDp2997
  ['4320p50', 7680, 4320, 50], // 24 P8KHDp50
  ['4320p59.94', 7680, 4320, 59.94], // 25 N8KHDp5994
  ['1080p30', 1920, 1080, 30], // 26 N1080p30
  ['1080p60', 1920, 1080, 60], // 27 N1080p60
];

/** VidM ids that atem-connection names. Exported so the fake and the tests use the same numbers. */
export const VideoModeId = {
  P720p50: 4,
  N720p5994: 5,
  P1080i50: 6,
  N1080i5994: 7,
  P1080p25: 10,
  P1080p50: 12,
  N1080p5994: 13,
  P4KHDp25: 16,
  N4KHDp5994: 19,
  N1080p60: 27,
} as const;

/**
 * A mode the table does not know (newer firmware) still gets a label, with
 * zero sizes, rather than null: the switcher did tell us something, and
 * "unknown video mode 31" is more use to the AV crew than a blank.
 */
export function videoModeInfo(id: number): VideoModeInfo {
  const row = VIDEO_MODES[id];
  if (!row) return { id, label: `unknown video mode ${id}`, width: 0, height: 0, fps: 0 };
  const [label, width, height, fps] = row;
  return { id, label, width, height, fps };
}

/**
 * The _ver value is major in the high 16 bits and minor in the low 16:
 * dist/enums/index.js `ProtocolVersion` has V7_2 = 131094 (0x00020016, so
 * "2.22") up to V9_6 = 131104 (0x00020020, "2.32").
 */
export function protocolLabel(version: number): string {
  const v = version >>> 0;
  return `${v >>> 16}.${v & 0xffff}`;
}
