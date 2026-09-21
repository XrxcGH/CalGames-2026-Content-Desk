/**
 * Make hand-dropped logos safe for the downstream keyer.
 *
 *     npm run fix:logos
 *
 * A luma DSK cuts on brightness, so PURE BLACK anywhere in a graphic becomes a
 * hole with live field video showing through it. For the graphic whose whole
 * purpose is to show somebody's mark, that means the match plays through the
 * letterforms of their name.
 *
 * Team robot photos are already handled: they come in through the media
 * library, which floors black on import. Sponsor logos do not. They are
 * dropped into media/sponsors/ by hand, usually as the black-on-transparent
 * PNG or SVG the sponsor's brand pack ships, which is the worst possible case
 * because it is black end to end.
 *
 * So this is the same pre-event pass Cheesy Arena runs over its downloaded
 * team avatars (`fix_avatar_colors_for_overlay`, an ImageMagick one-liner
 * replacing #000 with #222). Same idea, same number, our own pixels.
 *
 * Run it on Friday, after the logos are in and before doors. Safe to run
 * twice: a file already above the floor is left alone and reported as such.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_FLOOR, floorBlack } from '../apps/core/src/media.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['media/sponsors', 'media/slides'];
const RASTER = new Set(['.png', '.webp']);

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('This needs sharp. Run `npm i sharp` and try again.');
  process.exit(1);
}

let looked = 0, fixed = 0, skipped = 0;

for (const rel of DIRS) {
  const dir = join(ROOT, rel);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    continue;                                  // the folder is optional
  }

  for (const name of names) {
    const ext = extname(name).toLowerCase();
    if (ext === '.svg') {
      // An SVG is text, and its black is `fill="#000"` rather than a pixel.
      // Say so rather than pretending to have handled it: nothing else in the
      // pipeline will catch it either.
      const body = await readFile(join(dir, name), 'utf8');
      if (/#000(?:000)?\b|\bfill\s*=\s*["']black["']/i.test(body)) {
        console.log(`  CHECK ${rel}/${name}: pure black in an SVG. Open it and ` +
          `change #000 to #${KEY_FLOOR.toString(16).repeat(3)}, or export a PNG ` +
          'and run this again.');
        skipped++;
      }
      continue;
    }
    if (!RASTER.has(ext)) continue;

    looked++;
    const path = join(dir, name);
    const before = await readFile(path);
    const after = await floorBlack(sharp, before);
    if (after === before) {
      continue;                                // nothing below the floor
    }
    // floorBlack returns PNG bytes; keep the file's own extension working by
    // re-encoding webp back to webp.
    const out = ext === '.webp'
      ? await sharp(after).webp({ quality: 92 }).toBuffer()
      : after;
    await writeFile(path, out);
    console.log(`  fixed ${rel}/${name}`);
    fixed++;
  }
}

console.log('');
console.log(`${looked} image(s) looked at, ${fixed} lifted off pure black.`);
if (skipped) console.log(`${skipped} SVG(s) need a hand, listed above.`);
if (!looked && !skipped) {
  console.log('Nothing in media/sponsors or media/slides yet. Run this again ' +
    'once the logos are in.');
}
