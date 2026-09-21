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

/**
 * Like `int`, but a number out of range is an ERROR rather than a default.
 *
 * Used for the ranking-point thresholds, where silently substituting a default
 * is the worst of the three options. The settings page reports success, the
 * typed value is gone, the PREVIOUS value is gone too, and the badges on every
 * screen now light at a number nobody in the building agreed to. The content
 * lead sees "Saved" and has no reason to look again.
 */
const intOrThrow = (v: unknown, lo: number, hi: number, label: string): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new Error(`${label} must be a whole number between ${lo} and ${hi}.`);
  }
  return n;
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
      // Refused by name rather than replaced by a default: these decide when
      // a ranking-point badge lights on every screen in the building.
      rpEnergizedFuel: intOrThrow(o['rpEnergizedFuel'], 0, 10_000, 'Energized fuel'),
      rpSuperchargedFuel: intOrThrow(o['rpSuperchargedFuel'], 0, 10_000, 'Supercharged fuel'),
      rpTraversalTower: intOrThrow(o['rpTraversalTower'], 0, 10_000, 'Traversal tower'),
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
      // "//host/x" is off-origin too (protocol-relative), so one leading
      // slash exactly.
      // Normalised rather than discarded. A path with no scheme and no leading
      // slash is the spelling the section's own hint printed
      // ("media/sponsors/..."), and it was silently dropped: the sponsor saved,
      // reported success, and aired with no logo. Off-origin is still refused
      // below, because a logo fetched from the internet makes the broadcast
      // depend on venue Wi-Fi mid-ceremony.
      const logoRaw = line(r['logo'], 200);
      const logo = logoRaw
        && !/^[a-z]+:/i.test(logoRaw) && !logoRaw.startsWith('//') && !logoRaw.startsWith('/')
        ? `/${logoRaw}`
        : logoRaw;
      list.push({
        id, name,
        ...(SPONSOR_TIERS.has(tier) ? { tier: tier as SponsorPlan['tier'] } : {}),
        ...(line(r['line'], 140) ? { line: line(r['line'], 140) } : {}),
        ...(logo.startsWith('/') && !logo.startsWith('//') ? { logo } : {}),
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
      // Every field the award model carries, or an edit through this path
      // silently strips the ones it does not name: the Judge Advisor fixing
      // one typo would have wiped the blurb and ceremony day off all twelve.
      const blurb = line(r['blurb'], 150);
      const day = line(r['day'], 20);
      list.push({
        id, title,
        description: line(r['description'], 900),
        ...(blurb ? { blurb } : {}),
        ...(day ? { day } : {}),
      });
    }
    return { list };
  },
};

export const EDITABLE_SECTIONS = Object.keys(SANITIZERS);

/**
 * What the Event settings page is allowed to write. NOT the same list.
 *
 * `awards` has a sanitizer because awards.onListChanged persists the Judge
 * Advisor's own edits through this store. That made it reachable from POST
 * /api/setup, which takes `section` straight from the request body behind the
 * settings gate alone: anyone holding the settings code could send
 * {"section":"awards","value":{"list":[]}} and write the whole ceremony out of
 * data/event-content.json.
 *
 * Nothing would look wrong either. The live Awards instance keeps its
 * in-memory copy, so the loss only appears at the next restart, and restarts
 * happen at events. The awards tier exists precisely so the desk side of the
 * house cannot reach the ceremony; a settings code that can delete it is the
 * same boundary crossed from the other direction.
 */
export const DESK_EDITABLE_SECTIONS = EDITABLE_SECTIONS.filter(s => s !== 'awards');

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

  /**
   * The tail of the write queue. Never rejects; see #save.
   */
  #writing: Promise<void> = Promise.resolve();

  /**
   * One writer at a time.
   *
   * #writeNow stages through a temp file with a FIXED name and renames it
   * into place, which is atomic against a reader and not against another
   * writer: two overlapping saves interleave their writes into the one temp
   * file and then both rename it, so what lands is half of each.
   *
   * Nothing awaited a save either. The awards list persists through
   * `onListChanged`, which index.ts fires as `void content.set(...)` on every
   * change, and the JA reorders the running order with a pair of arrow
   * buttons. Two presses inside one write is not a stress test, it is a
   * double-click, and the file that tears is the one holding the ceremony.
   *
   * Chaining serialises them. Coalescing falls out for free: each link reads
   * `#overrides` when its turn comes, so a burst of presses leaves the last
   * state on disk rather than replaying every intermediate one.
   */
  #save(): Promise<void> {
    this.#writing = this.#writing.then(
      () => this.#writeNow(),
      () => this.#writeNow(),   // a broken link must not stop the queue
    );
    return this.#writing;
  }

  async #writeNow(): Promise<void> {
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
