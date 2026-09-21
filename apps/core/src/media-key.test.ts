import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_FLOOR, floorBlack } from './media.ts';

/**
 * Pure black keys out.
 *
 * A luma downstream keyer cuts on brightness, so black anywhere in a graphic
 * becomes a hole with live field video showing through it. Cheesy Arena ships
 * a whole script for this on its team avatars alone; the desk has the same
 * hazard over a robot photo shot against a dark pit curtain, and over a
 * sponsor wordmark, which arrives black-on-transparent and would have played
 * the match through the letterforms of somebody's name.
 */
const sharp = await (async () => {
  try { return (await import('sharp')).default; } catch { return null; }
})();

test('pure black is lifted off the floor, and alpha is left alone', { skip: !sharp }, async () => {
  // Four pixels: pure black opaque, near-black opaque, pure black TRANSPARENT,
  // and a mid grey that must not move.
  const raw = Buffer.from([
    0, 0, 0, 255,
    5, 2, 9, 255,
    0, 0, 0, 0,
    128, 128, 128, 255,
  ]);
  const png = await sharp!(raw, { raw: { width: 2, height: 2, channels: 4 } })
    .png().toBuffer();

  const out = await floorBlack(sharp!, png);
  const { data } = await sharp!(out).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  assert.deepEqual([...data.subarray(0, 4)], [KEY_FLOOR, KEY_FLOOR, KEY_FLOOR, 255],
    'pure black is raised to the floor');
  assert.deepEqual([...data.subarray(4, 8)], [KEY_FLOOR, KEY_FLOOR, KEY_FLOOR, 255],
    'near-black too: a keyer does not care about the last few levels');
  assert.equal(data[11], 0,
    'a transparent pixel stays transparent: this is about what is DRAWN');
  assert.deepEqual([...data.subarray(12, 16)], [128, 128, 128, 255],
    'and nothing else in the image moves');
});

test('an image already clear of the floor is returned untouched', { skip: !sharp }, async () => {
  // The common case for a well-lit cutout. Re-encoding every upload for
  // nothing would cost quality on a file that has no problem.
  const raw = Buffer.from([200, 180, 160, 255, 90, 90, 90, 255]);
  const png = await sharp!(raw, { raw: { width: 2, height: 1, channels: 4 } })
    .png().toBuffer();
  const out = await floorBlack(sharp!, png);
  assert.equal(out, png, 'the same buffer, not a re-encode of it');
});

test('the floor is dark enough to still read as black in the room', () => {
  // It has to survive the keyer AND still look like black on a projector.
  // 0x22 is the number Cheesy Arena uses for the same job.
  assert.equal(KEY_FLOOR, 0x22);
  assert.ok(KEY_FLOOR > 0x10, 'clear of anything a keyer would take');
  assert.ok(KEY_FLOOR < 0x30, 'and still black to the eye');
});
