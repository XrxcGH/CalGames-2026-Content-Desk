/**
 * Team media library: robot cutouts for the pre-match alliance overview.
 * See docs/07-team-media.md.
 *
 * The validation here exists because of one specific, predictable failure:
 * most FRC robots are bare aluminum and white polycarbonate, shot on a white
 * backdrop, so an automated background remover eats holes in them, and you
 * don't notice until it's on a screen at 1080p. Catching a bad cutout at
 * upload time on Friday is worth a lot more than catching it Sunday.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Whether this team's image may go on air.
 *
 *   granted   somebody at the event asked the team and they said yes
 *   unknown   nobody has asked. The DEFAULT, and it shows: an event that has
 *             not asked has not been told yes
 *   declined  they said no, or asked for it to come down
 *
 * `unknown` still airs, and that is a deliberate line rather than an
 * oversight. These are photographs of ROBOTS, taken in a public hall by the
 * event that invited them, and treating a missing checkbox as a refusal would
 * empty the alliance overview at every event that never got round to a form.
 * `declined` is absolute and instant, which is the part that matters: a team
 * that asks for their robot to come off the screen gets that in one click,
 * without anybody deleting a file.
 */
export type MediaConsent = 'granted' | 'unknown' | 'declined';

export interface RobotMedia {
  team: number;
  version: number;
  src: string;
  w: number;
  h: number;
  uploadedAt: number;
  warnings: string[];
  /** Absent on anything uploaded before this existed, which reads as unknown. */
  consent?: MediaConsent;
}

export type Manifest = Record<number, RobotMedia>;

const WIDTHS = [400, 800, 1600] as const;

// ---------------------------------------------------------------------------
// PNG header parsing. Pure JS so the single most important check ("does this
// image even have an alpha channel") works with no native dependency.
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngHeader { w: number; h: number; colorType: number; hasAlpha: boolean }

export function readPngHeader(buf: Buffer): PngHeader | null {
  if (buf.length < 26 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const colorType = buf.readUInt8(25);
  return {
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20),
    colorType,
    // 4 = gray+alpha, 6 = truecolor+alpha, and 0/3 with a tRNS chunk. That
    // last case is not exotic: TinyPNG and pngquant palettize to colorType 3
    // and carry the transparency in tRNS, so a correctly cut robot photo run
    // through either was rejected with a message telling the volunteer their
    // background had not been removed — which it had, on upload day, with the
    // team standing there.
    hasAlpha: colorType === 4 || colorType === 6 || hasTrns(buf),
  };
}

/**
 * Does this PNG carry a tRNS chunk?
 *
 * Walks the chunk list rather than searching the bytes: the four ASCII
 * characters "tRNS" can appear inside compressed image data by chance, and a
 * false positive here would wave through a photo with an opaque background.
 * Stops at IDAT, because tRNS is required to precede the image data.
 */
function hasTrns(buf: Buffer): boolean {
  let at = 8;                                   // past the signature
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    // length + 4 type + payload + 4 CRC. A length that overflows the buffer
    // is a truncated file, not a reason to loop forever.
    const next = at + 12 + len;
    if (next <= at || next > buf.length) return false;
    at = next;
  }
  return false;
}

// ---------------------------------------------------------------------------

// sharp 0.35 ships ESM: the callable lives on the default export, so the
// module type itself stopped being callable. Alias the default instead.
type Sharp = (typeof import('sharp'))['default'];
let sharpMod: Sharp | null | undefined;

async function getSharp(): Promise<Sharp | null> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    sharpMod = null;
    console.warn('[media] sharp unavailable: uploads are stored as-is, without ' +
      'trimming, resizing, or the opacity check. Run `npm i sharp` before the event.');
  }
  return sharpMod;
}

export class MediaLibrary {
  #root: string;
  #manifest: Manifest = {};

  constructor(root: string) { this.#root = root; }

  get manifest(): Manifest { return this.#manifest; }

  /**
   * What the OVERLAY may draw: everything except teams who said no.
   *
   * A separate accessor rather than a filter at each call site, because there
   * are several call sites and the one that gets forgotten is the one on air.
   */
  get airable(): Manifest {
    const out: Manifest = {};
    for (const [team, m] of Object.entries(this.#manifest)) {
      if (m.consent === 'declined') continue;
      out[Number(team)] = m;
    }
    return out;
  }

  /**
   * Record what a team said. Takes effect on the next state push, so a team
   * asking at the pit desk is off the screen before they walk back.
   */
  async setConsent(team: number, consent: MediaConsent): Promise<RobotMedia> {
    const media = this.#manifest[team];
    if (!media) throw new Error('No robot photo has been uploaded for team ' + team + '.');
    media.consent = consent;
    await writeFile(join(this.#root, 'teams', String(team), 'meta.json'),
      JSON.stringify(media, null, 2));
    return media;
  }

  /** Rebuild from disk on boot: the manifest lives in memory, built from each
   *  team's meta.json. No manifest file exists on disk, deliberately. */
  async scan(): Promise<void> {
    const teamsDir = join(this.#root, 'teams');
    await mkdir(teamsDir, { recursive: true });
    const next: Manifest = {};

    for (const entry of await readdir(teamsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const team = Number(entry.name);
      if (!Number.isInteger(team)) continue;
      try {
        const meta = JSON.parse(
          await readFile(join(teamsDir, entry.name, 'meta.json'), 'utf8'),
        ) as RobotMedia;
        next[team] = meta;
      } catch { /* no meta yet: team dir exists but nothing usable in it */ }
    }

    this.#manifest = next;
    console.log(`[media] ${Object.keys(next).length} robot cutouts loaded`);
  }

  /**
   * Ingest one upload. Returns warnings rather than throwing on anything but
   * a hard reject, because a slightly-imperfect cutout on Sunday morning still
   * beats the fallback plinth.
   */
  async ingest(team: number, buf: Buffer): Promise<RobotMedia> {
    const warnings: string[] = [];
    const header = readPngHeader(buf);

    if (!header) {
      throw new Error('Not a PNG. The robot photo needs its background removed ' +
        'and saved as a PNG with transparency. A JPEG can\'t hold one.');
    }
    if (!header.hasAlpha) {
      throw new Error('This PNG has no alpha channel, so the background hasn\'t ' +
        'been removed yet. Cut it out first, then re-upload.');
    }
    if (Math.max(header.w, header.h) < 900) {
      warnings.push(`Only ${header.w}x${header.h}. This renders ~700px tall at ` +
        '1080p, so it will look soft. 3000px on the long edge is the target.');
    }

    const dir = join(this.#root, 'teams', String(team));
    await mkdir(dir, { recursive: true });
    const version = (this.#manifest[team]?.version ?? 0) + 1;

    let w = header.w, h = header.h;
    const sharp = await getSharp();

    if (sharp) {
      const img = sharp(buf, { failOn: 'none' });

      // Trim to the alpha bounding box, then record real dimensions so the
      // overview can normalize by HEIGHT: normalizing by width puts a robot
      // the size of a bus next to one the size of a shoebox.
      const trimmed = await img.trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
      w = trimmed.info.width;
      h = trimmed.info.height;

      const { perimeter, area } = await this.#opacity(sharp, trimmed.data);
      // Perimeter is the discriminating signal, not area. Plenty of FRC robots
      // are boxy enough to fill their own bounding box, so an area test flags
      // perfectly good cutouts. An *uncut* photo is the one whose edges are
      // solid backdrop all the way round. The bottom edge is excluded because
      // a correctly cut robot sits flush on its own floor line.
      if (perimeter > 0.9) {
        warnings.push('The edges of this image are solid, which usually means ' +
          'it is still an uncut photo on a white background. Check it against a ' +
          'dark background before trusting it.');
      } else if (area > 0.995) {
        warnings.push('Almost no transparency anywhere in this image. It may not ' +
          'have been cut out. Worth a second look.');
      }

      await writeFile(join(dir, `robot.v${version}.png`), trimmed.data);
      for (const width of WIDTHS) {
        if (width > w) continue;
        await sharp(trimmed.data).resize({ width }).webp({ quality: 88 })
          .toFile(join(dir, `robot.v${version}@${width}.webp`));
      }
    } else {
      await writeFile(join(dir, `robot.v${version}.png`), buf);
      warnings.push('Stored without processing because sharp is not installed.');
    }

    const media: RobotMedia = {
      team, version, w, h,
      src: `/media/teams/${team}/robot.v${version}.png`,
      uploadedAt: Date.now(),
      warnings,
      // Preserved across a re-upload: a team that said no does not have to say
      // it again because somebody replaced the photo.
      consent: this.#manifest[team]?.consent ?? 'unknown',
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(media, null, 2));
    this.#manifest[team] = media;
    return media;
  }

  /**
   * Opacity of the top/left/right border ring, and of the whole image.
   * A genuine cutout has a mostly-transparent perimeter; an uncut photo's is
   * solid backdrop.
   */
  async #opacity(sharp: Sharp, png: Buffer): Promise<{ perimeter: number; area: number }> {
    const { data, info } = await sharp(png)
      .resize({ width: 160, height: 160, fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width: w, height: h, channels } = info;
    const alphaAt = (x: number, y: number): number => data[(y * w + x) * channels + channels - 1] ?? 0;
    const OPAQUE = 250;

    let ring = 0, ringTotal = 0;
    const band = Math.max(1, Math.round(w * 0.02));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const onTop = y < band;
        const onSide = x < band || x >= w - band;
        // Bottom edge deliberately excluded, since a robot sits on its floor line.
        if (!onTop && !onSide) continue;
        ringTotal++;
        if (alphaAt(x, y) > OPAQUE) ring++;
      }
    }

    let opaque = 0, total = 0;
    for (let i = channels - 1; i < data.length; i += channels) {
      total++;
      if (data[i]! > OPAQUE) opaque++;
    }

    return {
      perimeter: ringTotal ? ring / ringTotal : 1,
      area: total ? opaque / total : 1,
    };
  }

}
