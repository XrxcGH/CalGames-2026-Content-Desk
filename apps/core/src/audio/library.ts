/**
 * The house clip library: walk-up songs and stingers.
 *
 * Deliberately separate from the music service. A playoff introduction needs a
 * specific twelve seconds of a specific track to start on the beat the
 * announcer hands over, and a streaming service is the wrong instrument for
 * that: it needs the internet to be up, it starts when it feels like starting,
 * and skipping to a cue point is a second round trip. A file on the disk of the
 * machine wired to the PA plays instantly, plays the same way every time, and
 * plays when the venue uplink is down. Alliance introductions are the moment
 * with the least tolerance for "it'll start in a second".
 *
 * Files live in `media/audio/walkups` and `media/audio/stingers`. A walk-up is
 * named for the team it belongs to: `254.mp3`, or `254 - Chariots of Fire.mp3`
 * if whoever loaded it wanted the title visible on the desk. Everything else is
 * a stinger and is picked by name.
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ClipKind = 'walkup' | 'stinger';

export interface Clip {
  /** Stable id: the kind and the file's base name. */
  id: string;
  kind: ClipKind;
  /** What the desk button says. */
  label: string;
  /** Walk-ups only: whose introduction this plays under. */
  team: number | null;
  /** Served to the house player, which is the only page that fetches it. */
  src: string;
  bytes: number;
}

const DIRS: Record<ClipKind, string> = { walkup: 'walkups', stinger: 'stingers' };

/**
 * Formats a browser plays without a plugin, which is the whole bar here: the
 * house player is a page in Chrome. Ordered by how likely someone is to hand
 * us one.
 */
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm']);

/** 8MB is a generous ceiling for the twenty seconds any of these should be. */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

/**
 * Sniff the container rather than trusting the extension. Somebody will
 * eventually rename a .wav to .mp3, and a walk-up that fails to decode does so
 * in front of the whole gym with an alliance standing on the field.
 */
export function looksLikeAudio(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const head = buf.subarray(0, 4).toString('latin1');
  if (head === 'ID3' || head.startsWith('ID3')) return true;             // mp3 with tags
  if (head === 'OggS' || head === 'fLaC') return true;
  if (head === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return true;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return true;     // m4a/mp4
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // webm
  // Bare MPEG audio: frame sync is eleven set bits.
  if (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0) return true;
  return false;
}

/**
 * "254 - Chariots of Fire.mp3" -> team 254, label "Chariots of Fire".
 * "254.mp3" -> team 254, no label. Anything with no leading number is a
 * stinger even if it landed in the walkups folder, because guessing a team
 * number wrong is worse than showing one fewer button.
 *
 * A plain space separates too: "846 Funky Town.mp3" is team 846. It did not,
 * and the failure was silent in the worst way — the clip scanned fine, showed
 * up on the desk as a stinger, and then playClip(846) threw "No walk-up loaded
 * for team 846" in the middle of alliance introductions. A file in the
 * walkups/ folder that starts with a number is a walk-up; that is what the
 * folder means, and stingers have their own.
 *
 * The cost is a real ambiguity, so it is worth naming: "2026 Season Intro.mp3"
 * dropped in walkups/ now binds to team 2026 rather than reading as a stinger.
 * That is the right way round. It is visible — the desk draws it as a team
 * button — and it is one rename to fix, whereas the old behaviour was a
 * missing button nobody looked for until the team was already standing there.
 */
export function parseWalkupName(base: string): { team: number | null; label: string } {
  const m = /^(\d{1,5})(?:[\s\-_.]+(.*))?$/.exec(base.trim());
  if (!m) return { team: null, label: base };
  const team = Number(m[1]);
  const rest = (m[2] ?? '').trim();
  // No title given: the label is empty rather than a repeat of the number.
  // Surfaces draw the team number themselves, and "846 846" on a button is
  // the kind of small wrongness that makes a graphic look unfinished.
  return { team, label: rest };
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
};

/** Same character class the card route uses: keeps a name safe as a path. */
const safeName = (s: string): string => s.replace(/[^\w.\- ]+/g, '_').slice(0, 80);

export class ClipLibrary {
  #root: string;
  #clips: Clip[] = [];

  constructor(root: string) { this.#root = root; }

  get clips(): Clip[] { return this.#clips; }

  /** Walk-ups indexed by team, for the desk's per-team buttons. */
  get byTeam(): Record<number, Clip> {
    const out: Record<number, Clip> = {};
    for (const c of this.#clips) if (c.team !== null) out[c.team] = c;
    return out;
  }

  find(id: string): Clip | null {
    return this.#clips.find(c => c.id === id) ?? null;
  }

  forTeam(team: number): Clip | null {
    return this.#clips.find(c => c.team === team) ?? null;
  }

  /**
   * Rebuild from disk. Called at boot and again whenever something is
   * uploaded, so a clip dropped into the folder by hand on Saturday morning
   * appears without a restart.
   */
  async scan(): Promise<void> {
    const next: Clip[] = [];
    for (const kind of Object.keys(DIRS) as ClipKind[]) {
      const dir = join(this.#root, 'audio', DIRS[kind]);
      await mkdir(dir, { recursive: true });
      let entries: string[];
      try { entries = await readdir(dir); } catch { continue; }

      for (const name of entries) {
        const ext = extOf(name);
        if (!AUDIO_EXT.has(ext)) continue;
        const base = name.slice(0, name.length - ext.length);
        let bytes = 0;
        try { bytes = (await stat(join(dir, name))).size; } catch { continue; }

        const parsed = kind === 'walkup'
          ? parseWalkupName(base)
          : { team: null, label: base };

        next.push({
          id: `${kind}:${base}`,
          kind,
          label: parsed.label,
          team: parsed.team,
          src: `/media/audio/${DIRS[kind]}/${encodeURIComponent(name)}`,
          bytes,
        });
      }
    }

    // Teams first and in number order, then stingers alphabetically: the desk
    // renders this list straight through, and an introduction runs in seed
    // order under time pressure.
    next.sort((a, b) => {
      if ((a.team === null) !== (b.team === null)) return a.team === null ? 1 : -1;
      if (a.team !== null && b.team !== null) return a.team - b.team;
      return (a.label || a.id).localeCompare(b.label || b.id);
    });

    this.#clips = next;
    const walkups = next.filter(c => c.kind === 'walkup').length;
    console.log(`[audio] ${walkups} walk-ups, ${next.length - walkups} stingers`);
  }

  /**
   * Store an upload. Rejects rather than warns: unlike a robot cutout, a
   * half-good audio file has no degraded mode. It either plays or it is
   * silence at the loudest moment of the weekend.
   */
  async ingest(kind: ClipKind, name: string, buf: Buffer): Promise<Clip> {
    if (!buf.length) throw new Error('That file is empty.');
    if (buf.length > MAX_CLIP_BYTES) {
      throw new Error(`That file is ${Math.round(buf.length / (1024 * 1024))}MB. ` +
        'Walk-ups are a few seconds long; trim it first and keep it under 8MB.');
    }
    if (!looksLikeAudio(buf)) {
      throw new Error('That does not look like an audio file a browser can play. ' +
        'MP3 is the safe choice.');
    }
    const ext = extOf(name) || '.mp3';
    if (!AUDIO_EXT.has(ext)) {
      throw new Error(`"${ext}" is not a format the house player can play. Use MP3.`);
    }
    const base = safeName(name.slice(0, name.length - extOf(name).length)) || 'clip';

    const dir = join(this.#root, 'audio', DIRS[kind]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${base}${ext}`), buf);
    await this.scan();

    const clip = this.find(`${kind}:${base}`);
    if (!clip) throw new Error('Stored, but it did not come back on the rescan.');
    return clip;
  }
}
