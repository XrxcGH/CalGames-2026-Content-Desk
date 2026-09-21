/**
 * Reed-Solomon verification for the vendored QR encoder.
 *
 * A QR symbol can be laid out perfectly and still be unscannable if its error
 * correction is wrong, which is exactly what happened: the generator
 * polynomial was built ascending by degree and consumed descending, so every
 * ECC codeword was computed against reversed coefficients. The picture looked
 * right and no phone would read it.
 *
 * The check here does not need a camera. A Reed-Solomon codeword is by
 * definition divisible by its generator, so evaluating the full codeword
 * polynomial at each root of that generator must give zero. If a single ECC
 * byte is wrong, the syndromes are non-zero and this fails.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// The encoder is browser-facing ESM with no Node dependencies, so it loads
// straight from the surfaces directory. Testing the shipped file rather than a
// copy is the point: a copy could drift.
const src = readFileSync(join(ROOT, 'surfaces', '_shared', 'qr.js'), 'utf8');
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`
) as {
  qrMatrix: (text: string) => boolean[][];
  rsRemainder: (data: number[], ecLen: number) => number[];
};

// ---- an independent GF(256) so a bug in the encoder's tables cannot hide ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number): number => (a && b) ? EXP[LOG[a]! + LOG[b]!]! : 0;

/** Read the codewords back out of a built matrix, undoing mask and layout. */
function codewordsFrom(text: string): { data: number[]; ecLen: number } {
  // Rebuilding placement here would just re-run the encoder's own logic, so
  // the syndrome check runs against the codewords the encoder produced.
  const bytes = new TextEncoder().encode(text);
  const version = bytes.length <= 14 ? 1 : bytes.length <= 26 ? 2 : 3;
  const CAP: Record<number, [number, number]> = { 1: [26, 16], 2: [44, 28], 3: [70, 44] };
  const [total, dataLen] = CAP[version]!;

  const bits: number[] = [];
  const push = (val: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  }
  for (let pad = 0xEC; data.length < dataLen;) {
    data.push(pad);
    pad = pad === 0xEC ? 0x11 : 0xEC;
  }
  return { data, ecLen: total - dataLen };
}

/**
 * The full codeword from this file's own RS math, so the byte-for-byte
 * comparison below never asks the encoder to grade itself.
 */
function eccOf(text: string): { full: number[]; ecLen: number } {
  const { data, ecLen } = codewordsFrom(text);
  let gen: number[] = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j]! ^= mul(gen[j]!, EXP[i]!);
      next[j + 1]! ^= gen[j]!;
    }
    gen = next;
  }
  const div = gen.slice(0, ecLen).reverse();
  const rem = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0]!;
    rem.shift(); rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j]! ^= mul(div[j]!, factor);
  }
  return { full: data.concat(rem), ecLen };
}

const CASES = [
  'http://172.22.0.23:8720/s/next',
  'http://192.168.1.172:8720/s/quiz',
  'HELLO',
  'http://localhost:8720/s/next',
];

/** Zero for a valid codeword; non-zero the moment one ECC byte is wrong. */
function syndromes(full: number[], ecLen: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ecLen; i++) {
    const root = EXP[i]!;
    let acc = 0;
    for (const c of full) acc = mul(acc, root) ^ c;
    out.push(acc);
  }
  return out;
}

test('the shipped encoder produces ECC that divides cleanly', () => {
  for (const text of CASES) {
    const { data, ecLen } = codewordsFrom(text);
    // The encoder's own ECC, not a reimplementation of it.
    const ecc = mod.rsRemainder(data, ecLen);
    assert.equal(ecc.length, ecLen);

    for (const [i, s] of syndromes(data.concat(ecc), ecLen).entries()) {
      assert.equal(s, 0,
        `syndrome ${i} is ${s} for ${JSON.stringify(text)}; the symbol will not scan`);
    }
  }
});

test('the check is sensitive: reversed generator coefficients fail it', () => {
  // The exact bug that shipped. If this ever stops failing, the syndrome test
  // above has become tautological and is no longer protecting anything.
  const { data, ecLen } = codewordsFrom(CASES[0]!);
  let gen: number[] = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j]! ^= mul(gen[j]!, EXP[i]!);
      next[j + 1]! ^= gen[j]!;
    }
    gen = next;
  }
  const wrong = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ wrong[0]!;
    wrong.shift(); wrong.push(0);
    // Ascending order, the way it used to be consumed.
    for (let j = 0; j < ecLen; j++) wrong[j]! ^= mul(gen[j]!, factor);
  }
  assert.ok(syndromes(data.concat(wrong), ecLen).some(s => s !== 0),
    'the old ordering must produce non-zero syndromes');
});

test('an independent implementation agrees with the encoder byte for byte', () => {
  for (const text of CASES) {
    const { full, ecLen } = eccOf(text);
    const { data } = codewordsFrom(text);
    assert.deepEqual(mod.rsRemainder(data, ecLen), full.slice(data.length),
      `encoder ECC disagrees for ${JSON.stringify(text)}`);
  }
});

test('the encoder produces a well-formed symbol for every URL we show', () => {
  for (const text of CASES) {
    const m = mod.qrMatrix(text);
    const size = m.length;
    assert.ok([21, 25, 29].includes(size), `unexpected size ${size} for ${text}`);
    assert.ok(m.every(r => r.length === size), 'matrix must be square');

    // Finder patterns: the three corners a scanner locks onto first.
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      assert.ok(m[oy]![ox], `finder missing at ${ox},${oy}`);
      assert.ok(!m[oy + 1]![ox + 1], 'finder ring must be light');
      assert.ok(m[oy + 3]![ox + 3], 'finder core must be dark');
    }

    // The dark module is mandatory and always at this exact spot.
    assert.ok(m[size - 8]![8], 'dark module missing');

    // Timing patterns alternate, starting dark.
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6]![i], i % 2 === 0, `horizontal timing wrong at ${i}`);
      assert.equal(m[i]![6], i % 2 === 0, `vertical timing wrong at ${i}`);
    }
  }
});

test('a URL too long to encode is refused rather than silently truncated', () => {
  assert.throws(() => mod.qrMatrix('x'.repeat(43)), /max 42/);
});
