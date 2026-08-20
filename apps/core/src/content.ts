/**
 * Event content, editable at the desk.
 *
 * config.json started as the home of everything, which meant the award list,
 * the sponsor list and the run of show could only be changed by finding the
 * right laptop, opening a JSON file, and not breaking a comma, at an event
 * staffed by first-time volunteers. So the CONTENT half of config now has a
 * second home: data/event-content.json, written by the desk's own editors and
 * merged over config.json at boot. config.json stays the home of credentials
 * and machine wiring (PINs, API tokens, ffmpeg inputs), which no browser
 * should ever be able to read or write, and it still seeds the first run.
 *
 * The allowlist below is the whole security story: a section not named here
 * cannot be written through the desk, whatever the request says. Tokens,
 * PINs and recording inputs are not in the list and never will be.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { SponsorPlan } from './sponsors.ts';
import type { SegmentPlan } from './rundown.ts';
import type { AwardDef } from './awards.ts';

const line = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
};

/** Slug for a list row that arrived without an id. */
export const slug = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

/** The same slug, made unique against ids already taken. */
export function uniqueSlug(title: string, taken: Set<string>): string {
  const base = slug(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 36)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const SEGMENT_KINDS = new Set(['matches', 'break', 'ceremony', 'selection', 'awards', 'gap']);
const SPONSOR_TIERS = new Set(['title', 'major', 'supporting']);

/**
 * One sanitizer per editable section. Each takes whatever JSON the desk sent
 * and returns the section as it will be stored and applied, or throws a
 * sentence the operator can read. Caps are generous for a one-day event and
 * exist so a stuck key or a paste of the wrong file cannot balloon the state
 * snapshot every surface downloads.
 */
const SANITIZERS: Record<string, (v: unknown) => unknown> = {
  event(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      name: line(o['name'], 80) || 'CalGames',
      year: int(o['year'], 2000, 2100, new Date().getFullYear()),
      key: line(o['key'], 40).toLowerCase(),
      resultsUrl: line(o['resultsUrl'], 200),
    };
  },
  game(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      rpEnergizedFuel: int(o['rpEnergizedFuel'], 0, 10_000, 100),
      rpSuperchargedFuel: int(o['rpSuperchargedFuel'], 0, 10_000, 360),
      rpTraversalTower: int(o['rpTraversalTower'], 0, 10_000, 50),
    };
  },
  kiosk(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    return { fieldStreamUrl: line(o['fieldStreamUrl'], 300) };
  },
  stream(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    return { webcastUrl: line(o['webcastUrl'], 300) };
  },
  sponsors(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(o['list']) ? o['list'].slice(0, 50) : [];
    const taken = new Set<string>();
    const list: SponsorPlan[] = [];
    for (const raw of rows) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = line(r['name'], 80);
      if (!name) continue;
      const id = line(r['id'], 40) || uniqueSlug(name, taken);
      if (taken.has(id)) continue;
      taken.add(id);
      const tier = String(r['tier'] ?? '');
      // Logos are served from this process or not at all: an off-origin URL
      // would make the broadcast depend on venue internet mid-ceremony.
      const logo = line(r['logo'], 200);
      list.push({
        id, name,
        ...(SPONSOR_TIERS.has(tier) ? { tier: tier as SponsorPlan['tier'] } : {}),
        ...(line(r['line'], 140) ? { line: line(r['line'], 140) } : {}),
        ...(logo.startsWith('/') ? { logo } : {}),
      });
    }
    return { list };
  },
  rundown(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(o['segments']) ? o['segments'].slice(0, 60) : [];
    const taken = new Set<string>();
    const segments: SegmentPlan[] = [];
    for (const raw of rows) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const label = line(r['label'], 80);
      if (!label) continue;
      const id = line(r['id'], 40) || uniqueSlug(label, taken);
      if (taken.has(id)) continue;
      taken.add(id);
      const kind = String(r['kind'] ?? '');
      const minutes = int(r['minutes'], 0, 600, 0);
      const matches = int(r['matches'], 0, 200, 0);
      const audience = line(r['audience'], 80);
      segments.push({
        id, label,
        kind: (SEGMENT_KINDS.has(kind) ? kind : 'break') as SegmentPlan['kind'],
        ...(minutes ? { minutes } : {}),
        ...(matches ? { matches } : {}),
        ...(audience ? { audience } : {}),
      });
    }
    return { segments };
  },
  accessibility(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(o['services']) ? o['services'].slice(0, 20) : [];
    const services = rows.flatMap(raw => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const label = line(r['label'], 80);
      return label ? [{ label, detail: line(r['detail'], 200) }] : [];
    });
    return { services, ask: line(o['ask'], 160) };
  },
  awards(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(o['list']) ? o['list'].slice(0, 40) : [];
    const taken = new Set<string>();
    const list: AwardDef[] = [];
    for (const raw of rows) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const title = line(r['title'], 80);
      if (!title) continue;
      const id = line(r['id'], 40) || uniqueSlug(title, taken);
      if (taken.has(id)) continue;
      taken.add(id);
      list.push({ id, title, description: line(r['description'], 400) });
    }
    return { list };
  },
};

export const EDITABLE_SECTIONS = Object.keys(SANITIZERS);

export class EventContent {
  #file: string;
  #dir: string;
  #overrides: Record<string, unknown> = {};

  constructor(root: string) {
    this.#dir = join(root, 'data');
    this.#file = join(this.#dir, 'event-content.json');
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const sanitize = SANITIZERS[k];
        // Only allowlisted sections survive the read: a hand-edited file
        // cannot smuggle a "youtube" section into the live config.
        if (sanitize) this.#overrides[k] = sanitize(v);
      }
      const n = Object.keys(this.#overrides).length;
      if (n) console.log(`[content] ${n} section(s) loaded from data/event-content.json`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[content] event content could not be read, using config.json:',
          (err as Error).message);
      }
    }
  }

  async #save(): Promise<void> {
    try {
      if (!Object.keys(this.#overrides).length) {
        await rm(this.#file, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#overrides, null, 2));
      await rename(tmp, this.#file);
    } catch (err) {
      console.warn('[content] event content could not be saved:', (err as Error).message);
    }
  }

  /** Which sections currently override config.json. */
  get overridden(): string[] { return Object.keys(this.#overrides); }

  /**
   * Overlay every stored section onto the live config object, IN PLACE.
   *
   * In place is the mechanism that makes later reads pick the edits up:
   * config is a singleton passed by reference, and things like the stream
   * title and the kiosk field URL read it at the moment of use.
   */
  apply(config: Config): void {
    const c = config as unknown as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(this.#overrides)) {
      Object.assign(c[k] ?? (c[k] = {}), v as Record<string, unknown>);
    }
  }

  /**
   * Store one section, sanitized, and overlay it onto the live config.
   * Returns the section as stored. Throws on a section outside the allowlist:
   * the list of editable sections IS the security boundary between event
   * content and credentials.
   */
  async set(section: string, value: unknown, config: Config): Promise<unknown> {
    const sanitize = SANITIZERS[section];
    if (!sanitize) {
      throw new Error(`"${section}" is not editable from the desk. ` +
        'Credentials and machine wiring live in config.json on the desk machine.');
    }
    const cleanValue = sanitize(value);
    this.#overrides[section] = cleanValue;
    this.apply(config);
    await this.#save();
    return cleanValue;
  }
}
