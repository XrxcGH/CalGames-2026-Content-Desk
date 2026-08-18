/**
 * Caption sidecars: attach a subtitle file to a published video.
 *
 * This deliberately does NOT transcribe anything. There is no speech
 * recognition in this repo and there should not be: a laptop cutting video in
 * a gym has nothing spare, and an unreviewed machine transcript of a team
 * number is worse than no captions at all ("one six seven eight" is a coin
 * flip). YouTube already runs ASR on every upload for free and does it better.
 *
 * What this adds is the thing YouTube's ASR cannot do: if somebody produced a
 * real caption file (a volunteer typing along, a paid captioner on the finals,
 * a corrected export of the auto-captions from last year's identical award
 * script), the pipeline picks it up and uploads it as a proper track, which
 * outranks ASR on the video. Drop a file in data/captions named after the
 * match key or the item label. That is the whole interface, because the
 * person most likely to produce one is not the person running the desk.
 *
 * Accessibility is the reason, and worth stating plainly: the stream plays on
 * a muted phone in a loud gym as often as it plays with sound. Captions are
 * for everyone in that hall, not only for the people the ADA is named after.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** Formats YouTube's captions.insert accepts. */
const FORMATS = new Set(['.srt', '.vtt', '.sbv', '.sub']);

export interface Sidecar {
  path: string;
  /** BCP-47, from the filename ("qm12.es.srt" -> "es"). Defaults to English. */
  language: string;
  /** Cues found. Zero means the file is empty or malformed, and is refused. */
  cues: number;
}

/**
 * Count the cues in a caption file.
 *
 * Format-agnostic on purpose: every format this accepts marks a cue with a
 * timestamp range on its own line, and the separator is either `-->` (SRT,
 * VTT, SUB) or a comma (SBV). Counting those is enough to answer the only
 * question worth asking here: is this a caption file with something in it,
 * or an empty export somebody dropped in the folder by accident.
 */
export function countCues(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*(?:-->|,)\s*(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/
      .test(line)) n++;
  }
  return n;
}

/**
 * Pull the language tag out of a filename, if there is one.
 *
 * "2026cagg_qm12.es.srt" -> "es". A single trailing dotted segment that looks
 * like a language tag counts; anything else is part of the name. Being strict
 * matters: "qm12.final.srt" must not upload as language "final", which YouTube
 * would reject and which would look like the caption feature being broken.
 */
export function languageOf(file: string): string {
  const stem = basename(file, extname(file));
  const tail = stem.includes('.') ? stem.slice(stem.lastIndexOf('.') + 1) : '';
  // Case-insensitive on the primary subtag, because BCP-47 is. "qm12.ES.srt"
  // used to fail the test, fall back to "en", ALSO fail the strip, and end up
  // normalising to "qm12es", so it matched nothing at all and logged nothing
  // either. Wrong language would have been a bug; silence was worse.
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(tail) ? tail : 'en';
}

/** Normalise a key for matching: case and punctuation are not the point. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Find a caption file for an item.
 *
 * `keys` are the names worth answering to, best first: the TBA match key,
 * then the label. A file matches when its stem, minus any language tag, equals
 * a key. Substring matching is deliberately not used: "qm1" would otherwise
 * claim the captions for qm12, and a caption track on the wrong match is the
 * kind of error nobody catches until somebody who needs it hits play.
 */
export async function findSidecar(dir: string, keys: string[]): Promise<Sidecar[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // No captions folder is the normal case, not an error.
  }

  const wanted = keys.filter(Boolean).map(norm);
  for (const want of wanted) {
    const found: Sidecar[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const ext = extname(name).toLowerCase();
      if (!FORMATS.has(ext)) continue;
      let stem = basename(name, extname(name));
      const lang = languageOf(name);
      if (/\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(stem)) {
        stem = stem.slice(0, stem.lastIndexOf('.'));
      }
      if (norm(stem) !== want) continue;

      const path = join(dir, name);
      const cues = countCues(await readFile(path, 'utf8'));
      // An empty file is refused rather than uploaded. A caption track with no
      // cues shows up in the player as captions being AVAILABLE, which is a
      // worse lie than their absence.
      if (cues === 0) {
        console.warn(`[captions] ${name} has no cues, skipping it`);
        continue;
      }
      // One track per language. Two files claiming the same language is a
      // mistake somebody made in the folder, not a choice, and the second
      // insert would simply fail at YouTube.
      const key = lang.toLowerCase();
      if (seen.has(key)) {
        console.warn(`[captions] ${name} duplicates language "${lang}", skipping it`);
        continue;
      }
      seen.add(key);
      found.push({ path, language: lang, cues });
    }
    // ALL of them, not the first. Returning one meant a volunteer who added a
    // Spanish track alongside the English one published a video with only
    // Spanish captions: readdir is lexicographic, so ".es" sorted ahead of
    // the untagged file and shadowed it. The opposite of the point.
    if (found.length) {
      // English first when it is there: it is the track most viewers want
      // selected by default, and YouTube honours insert order for ties.
      found.sort((a, b) => Number(b.language === 'en') - Number(a.language === 'en'));
      return found;
    }
  }
  return [];
}
