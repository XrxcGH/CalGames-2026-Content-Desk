/**
 * Settings: the codes and connections a volunteer sets on the settings page.
 *
 * These used to live in config.json and on the launcher's command line: the
 * awards and settings codes as "pin" under "awards" and "setup", the desk PIN
 * as START-DESK.cmd /pin:NEWCODE, the field's address as /cheesy-host:, the
 * Nexus key as nexus.apiKey. Every one of them meant a first-time volunteer
 * editing a file in Notepad or typing a flag, and a typo in config.json threw
 * the whole file away. Now the settings page sets them, and they are kept
 * here, in data/settings.json, which nobody needs to open.
 *
 * What is stored, and nothing else:
 *   { codes?: { awards?, settings? },
 *     connections?: { fieldHost?, atemHost?, nexusKey? },
 *     graphicsInput?: number | null }
 *
 * The desk PIN is NOT in that file. It stays in desk-pin.txt in the install
 * folder, which is the launcher's own file: the launcher reads it at every
 * start and hands the PIN to the desk in REMOTE_PIN, so writing the file is
 * how a changed PIN survives a restart.
 *
 * Which value is live, first match wins:
 *   1. a change made on the settings page since this process started
 *   2. the environment (REMOTE_PIN, JA_PIN, SETUP_PIN: the launcher sets the
 *      first, tests and the preview tool set all three)
 *   3. data/settings.json (desk-pin.txt for the desk PIN)
 *   4. config.json
 *   5. the shipped defaults
 * The first rule is what makes a change take effect at once even under the
 * launcher, whose REMOTE_PIN would otherwise win until the next start.
 *
 * Secrets: no code and no key is ever logged, put in an error message, or
 * served. The file is written atomically (a temp file, then a rename), so a
 * power cut mid-write leaves the old file or the new one, never half of each.
 * Writes are synchronous and happen BEFORE the in-memory value changes: a
 * code that changed in memory and failed to reach the disk would quietly
 * revert at the next restart, which is worse than an error said now.
 *
 * Fails safe: load() never throws. An unreadable or malformed file is set
 * aside in memory (the desk runs on the next rule down) and said in one line
 * that names no value.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';

/** The codes the desk ships with. They are in the repo, so they are public. */
export const DEFAULT_CODES = { desk: '0864', awards: '1357', settings: '4567' } as const;

export type CodeName = 'desk' | 'awards' | 'settings';

/** What data/settings.json may hold. Anything else in it is dropped on load. */
export interface StoredSettings {
  codes?: { awards?: string; settings?: string };
  connections?: { fieldHost?: string; atemHost?: string; nexusKey?: string };
  graphicsInput?: number | null;
}

export interface ResolvedSettings {
  /** The live codes. An empty string is a tier switched off (the env var's escape hatch). */
  codes: { desk: string; awards: string; settings: string };
  connections: {
    /** host or host:port, or null when none was set here. */
    fieldHost: string | null;
    atemHost: string | null;
    /** The Nexus API key, '' when there is none. */
    nexusKey: string;
  };
  /** The switcher input that carries the desk's graphics, or null when not set. */
  graphicsInput: number | null;
}

/** A change to the connections. A key left out is left alone; '' or null clears it. */
export interface ConnectionsPatch {
  fieldHost?: string | null;
  atemHost?: string | null;
  nexusKey?: string | null;
  graphicsInput?: number | null;
}

/** A value the settings page sent that cannot be used. The message is for a volunteer and names no secret. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/**
 * The value was fine and the disk refused it: nothing changed. Separate from
 * SettingsError's other uses so a route can tell "you typed it wrong" (400)
 * from "the desk could not keep it" (503).
 */
export class SettingsSaveError extends SettingsError {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsSaveError';
  }
}

/** Cheesy Arena's own web port, which a field address with no port means. */
export const CHEESY_PORT = 8080;

/** A code is 4 to 8 digits: easy to type on a phone, and the PIN damper does the rest. */
export const CODE_PATTERN = /^\d{4,8}$/;

/**
 * "host" or "host:port", forgiving a pasted http:// and a trailing slash, or
 * null for empty. Throws SettingsError for anything else.
 *
 * Only an IPv4 address or a plain DNS name: the FRC field network is IPv4,
 * and every address the desk dials (the field, the switcher) is a bare host.
 * No userinfo, path, query or space survives, because these are read back to
 * the settings page and handed to a client that dials them.
 */
export function parseHost(raw: unknown, what: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new SettingsError(`The ${what} has to be text, like 10.0.100.5.`);
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!s) return null;
  if (s.length > 260) throw new SettingsError(`That ${what} is too long to be an address.`);
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(s);
  const bad = new SettingsError(`"${s.slice(0, 60)}" is not an address the desk can use for the ${what}. `
    + 'Type it like 10.0.100.5, or 10.0.100.5:8080 with a port.');
  if (!m) throw bad;
  const host = m[1]!;
  const port = m[2];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) throw bad;
  }
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    if (quad.slice(1).some(o => Number(o) > 255)) throw bad;
  } else {
    // A DNS name: labels of letters, digits and inner hyphens. A string of
    // digits and dots that is not a dotted quad ("10.0.100") is a typo, not
    // a name, and a URL parser would quietly read it as some other address.
    if (/^[\d.]+$/.test(host) || host.length > 253) throw bad;
    const labels = host.split('.');
    if (labels.some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw bad;
  }
  return port === undefined ? host : `${host}:${Number(port)}`;
}

/** The port every ATEM switcher listens on. */
export const ATEM_PORT = 9910;

/**
 * The switcher's address: what parseHost takes, held to what the switcher
 * watcher can dial (atem/watcher.ts, normalizeHost): four numbers with dots,
 * and no port but the switcher's own. Refused here, when Save is pressed, in
 * the watcher's own words. Accepted, it would reach the watcher as an error
 * that the next search for the switcher writes over, and the Switcher row
 * would go back to a gray "none found" with the typo still saved.
 */
export function parseSwitcherHost(raw: unknown): string | null {
  const h = parseHost(raw, 'switcher address');
  if (h === null) return null;
  const m = /^([^:]+)(?::(\d+))?$/.exec(h);
  const host = m?.[1] ?? h;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    throw new SettingsError(`"${h.slice(0, 60)}" is not a switcher address. Type four numbers with dots, `
      + 'like 10.0.100.40 (ATEM Setup shows it under Network).');
  }
  if (m?.[2] !== undefined && Number(m[2]) !== ATEM_PORT) {
    throw new SettingsError(`"${h}" names port ${m[2]}, but the switcher listens on ${ATEM_PORT}. `
      + 'Type just the address, like 10.0.100.40.');
  }
  return h;
}

/** The Nexus key: printable, no spaces, or null for empty. Never echoed in an error. */
export function parseKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new SettingsError('The Nexus key has to be text.');
  const s = raw.trim();
  if (!s) return null;
  if (s.length > 256 || !/^[\x21-\x7e]+$/.test(s)) {
    throw new SettingsError('That does not look like a Nexus key: paste it again exactly as frc.nexus shows it, '
      + 'with no spaces.');
  }
  return s;
}

/** A switcher input number, or null. ATEM ids run from 0 (black) into the 10000s. */
export function parseInput(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new SettingsError('The graphics input has to be the switcher input number, like 6.');
  }
  return n;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One value through a parser, or undefined (dropped) when it does not pass. */
const keep = <T>(parse: () => T): T | undefined => {
  try { return parse(); } catch { return undefined; }
};

/**
 * What a file on disk may be trusted to say. Each value is checked with the
 * same rules the settings page is held to, so a hand edit cannot put a value
 * in the desk that the page itself would have refused.
 */
function sanitize(raw: unknown, dropped: string[]): StoredSettings {
  const out: StoredSettings = {};
  if (!isObj(raw)) { dropped.push('the whole file'); return out; }
  if (isObj(raw['codes'])) {
    const codes: NonNullable<StoredSettings['codes']> = {};
    for (const k of ['awards', 'settings'] as const) {
      const v = raw['codes'][k];
      if (v === undefined) continue;
      if (typeof v === 'string' && CODE_PATTERN.test(v)) codes[k] = v; else dropped.push(`codes.${k}`);
    }
    if (Object.keys(codes).length) out.codes = codes;
  } else if (raw['codes'] !== undefined) dropped.push('codes');
  if (isObj(raw['connections'])) {
    const c = raw['connections'];
    const conn: NonNullable<StoredSettings['connections']> = {};
    for (const [k, what] of [['fieldHost', 'field address'], ['atemHost', 'switcher address']] as const) {
      if (c[k] === undefined) continue;
      const v = keep(() => (k === 'atemHost' ? parseSwitcherHost(c[k]) : parseHost(c[k], what)));
      if (v) conn[k] = v; else if (v === undefined) dropped.push(`connections.${k}`);
    }
    if (c['nexusKey'] !== undefined) {
      const v = keep(() => parseKey(c['nexusKey']));
      if (v) conn.nexusKey = v; else if (v === undefined) dropped.push('connections.nexusKey');
    }
    if (Object.keys(conn).length) out.connections = conn;
  } else if (raw['connections'] !== undefined) dropped.push('connections');
  if (raw['graphicsInput'] !== undefined) {
    const v = keep(() => parseInput(raw['graphicsInput']));
    if (v === undefined) dropped.push('graphicsInput'); else out.graphicsInput = v;
  }
  return out;
}

/**
 * Write a file so that a reader sees the old one or the new one, never half.
 *
 * A temp file then a rename. Windows refuses the rename now and then while an
 * antivirus scan or a sync client holds the target open; then the file is
 * written in place, which is not atomic but beats losing the change, and the
 * temp file is cleaned up either way.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, text, { encoding: 'utf8' });
    try { rmSync(tmp, { force: true }); } catch { /* a stray .tmp is ignored on load */ }
  }
}

export class Settings extends EventEmitter<{ change: [string[]] }> {
  readonly #root: string;
  readonly #config: Config;
  #stored: StoredSettings;
  /** The desk PIN as desk-pin.txt had it at load, or null. */
  #deskFile: string | null;
  /** The environment as it stood at load, read once like the codes always were. */
  readonly #env: { desk?: string; awards?: string; settings?: string };
  /** Codes changed on the settings page since this process started: rule 1. */
  #live: { desk?: string; awards?: string; settings?: string } = {};
  /** Set when data/settings.json could not be used, in words that name no value. */
  #problem: string | null = null;

  private constructor(root: string, config: Config, stored: StoredSettings, deskFile: string | null,
    problem: string | null) {
    super();
    this.#root = root;
    this.#config = config;
    this.#stored = stored;
    this.#deskFile = deskFile;
    this.#problem = problem;
    const env = process.env;
    this.#env = {
      ...(env['REMOTE_PIN'] !== undefined ? { desk: env['REMOTE_PIN'] } : {}),
      ...(env['JA_PIN'] !== undefined ? { awards: env['JA_PIN'] } : {}),
      ...(env['SETUP_PIN'] !== undefined ? { settings: env['SETUP_PIN'] } : {}),
    };
  }

  /** Where the settings live, for the tests and nothing else: nothing serves this path. */
  static fileFor(root: string): string { return join(root, 'data', 'settings.json'); }
  static pinFileFor(root: string): string { return join(root, 'desk-pin.txt'); }

  /**
   * Read data/settings.json and desk-pin.txt from the install folder. Never
   * throws: a missing file is the normal first start, and a broken one is set
   * aside with a line in the log saying so, by key name only.
   */
  static load(root: string, config: Config): Settings {
    let stored: StoredSettings = {};
    let problem: string | null = null;
    try {
      const text = readFileSync(Settings.fileFor(root), 'utf8').replace(/^﻿/, '');
      const dropped: string[] = [];
      try {
        stored = sanitize(JSON.parse(text), dropped);
      } catch {
        dropped.push('the whole file');
      }
      if (dropped.length) {
        problem = dropped.includes('the whole file')
          ? 'data/settings.json could not be read, so the codes and connections saved on the settings '
            + 'page are not in use until they are saved again'
          : `data/settings.json had a value the desk cannot use (${dropped.join(', ')}), so that one `
            + 'is not in use until it is saved again';
        console.warn(`[settings] ${problem}.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        problem = 'data/settings.json could not be opened, so the codes and connections saved on the '
          + 'settings page are not in use';
        console.warn(`[settings] ${problem} (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}).`);
      }
    }
    let deskFile: string | null = null;
    try {
      // The launcher's own rule (ReadSavedPin): the first line, trimmed, and
      // an empty file is no PIN at all rather than an empty one.
      const text = readFileSync(Settings.pinFileFor(root), 'utf8').replace(/^﻿/, '');
      const first = text.split(/\r?\n/)[0]!.trim();
      deskFile = first || null;
    } catch { deskFile = null; }
    return new Settings(root, config, stored, deskFile, problem);
  }

  /** Why data/settings.json is not in use, or null when it is (or there is none). */
  get problem(): string | null { return this.#problem; }

  get resolved(): ResolvedSettings {
    const cfg = this.#config;
    // String() and trim() for the awards and settings codes because config.json
    // is hand-edited and "pin": 2468 unquoted is a number (see server.ts). The
    // desk PIN is used exactly as given: an empty REMOTE_PIN is the gate
    // switched off on purpose, and `??` keeps that empty string.
    const awards = this.#live.awards
      ?? String(this.#env.awards ?? this.#stored.codes?.awards ?? cfg?.awards?.pin ?? DEFAULT_CODES.awards).trim();
    const settings = this.#live.settings
      ?? String(this.#env.settings ?? this.#stored.codes?.settings ?? cfg?.setup?.pin ?? DEFAULT_CODES.settings).trim();
    const desk = this.#live.desk ?? this.#env.desk ?? this.#deskFile ?? DEFAULT_CODES.desk;
    const conn = this.#stored.connections ?? {};
    return {
      codes: { desk, awards, settings },
      connections: {
        fieldHost: conn.fieldHost ?? null,
        atemHost: conn.atemHost ?? null,
        nexusKey: conn.nexusKey ?? String(cfg?.nexus?.apiKey ?? ''),
      },
      graphicsInput: this.#stored.graphicsInput ?? null,
    };
  }

  /** Whether that code is still the one the desk ships with (and so public). */
  isDefault(which: CodeName): boolean {
    return this.resolved.codes[which] === DEFAULT_CODES[which];
  }

  /**
   * Change the connections. Returns the keys that only take effect at the
   * next start of the desk (today only the field address, once the desk is
   * already connected to a field: the bridge attaches once per process).
   *
   * `live.fieldAttached` is the host the desk is connected to now, or null;
   * the caller knows it, this class does not.
   */
  setConnections(patch: ConnectionsPatch, live: { fieldAttached?: string | null } = {}): string[] {
    const next: StoredSettings = structuredClone(this.#stored);
    const conn: NonNullable<StoredSettings['connections']> = { ...(next.connections ?? {}) };
    const changed: string[] = [];
    const set = (k: 'fieldHost' | 'atemHost' | 'nexusKey', v: string | null): void => {
      if ((conn[k] ?? null) === v) return;
      if (v === null) delete conn[k]; else conn[k] = v;
      changed.push(k);
    };
    if ('fieldHost' in patch) set('fieldHost', parseHost(patch.fieldHost, 'field address'));
    if ('atemHost' in patch) set('atemHost', parseSwitcherHost(patch.atemHost));
    if ('nexusKey' in patch) set('nexusKey', parseKey(patch.nexusKey));
    if (Object.keys(conn).length) next.connections = conn; else delete next.connections;
    if ('graphicsInput' in patch) {
      const v = parseInput(patch.graphicsInput);
      if ((next.graphicsInput ?? null) !== v) {
        if (v === null) delete next.graphicsInput; else next.graphicsInput = v;
        changed.push('graphicsInput');
      }
    }
    if (!changed.length) return [];
    this.#save(next);
    this.#stored = next;
    this.#problem = null;
    this.#emit(changed);
    // Compared with Cheesy Arena's own port filled in, as the finder dials
    // it: "10.0.100.5" typed here IS the field at 10.0.100.5:8080, and
    // telling the operator to restart for the field they are already on
    // would be a restart for nothing.
    const attached = live.fieldAttached ?? null;
    const typed = conn.fieldHost ?? null;
    const dialled = typed && !/:\d+$/.test(typed) ? `${typed}:${CHEESY_PORT}` : typed;
    return changed.includes('fieldHost') && attached !== null && dialled !== null && attached !== dialled
      ? ['fieldHost'] : [];
  }

  /**
   * Change one code, at once. The caller has already checked the current
   * code and who may do this; this checks the new one's shape and that it is
   * not one of the other two codes, again, because a code that opens two
   * doors is two tiers collapsed by accident.
   */
  setCode(which: CodeName, next: string): void {
    if (typeof next !== 'string' || !CODE_PATTERN.test(next)) {
      throw new SettingsError('A code is 4 to 8 digits.');
    }
    const codes = this.resolved.codes;
    for (const other of ['desk', 'awards', 'settings'] as const) {
      if (other !== which && codes[other] === next) {
        throw new SettingsError('That code cannot be used: pick a different one.');
      }
    }
    if (which === 'desk') {
      // The launcher's file, in the launcher's format: the PIN and a line end,
      // UTF-8 with no byte-order mark, readable in Notepad.
      try {
        writeAtomic(Settings.pinFileFor(this.#root), `${next}\r\n`);
      } catch (err) {
        throw new SettingsSaveError('The desk could not save the new PIN to desk-pin.txt, so nothing was '
          + `changed (${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}). Close anything that has `
          + 'that file open, then try again.');
      }
      this.#deskFile = next;
    } else {
      const stored: StoredSettings = structuredClone(this.#stored);
      stored.codes = { ...(stored.codes ?? {}), [which]: next };
      this.#save(stored);
      this.#stored = stored;
    }
    this.#live[which] = next;
    this.#emit([`codes.${which}`]);
  }

  #save(stored: StoredSettings): void {
    try {
      mkdirSync(join(this.#root, 'data'), { recursive: true });
      writeAtomic(Settings.fileFor(this.#root), `${JSON.stringify(stored, null, 2)}\n`);
    } catch (err) {
      // The code only, never the path's contents or the value being written.
      throw new SettingsSaveError('The desk could not save that, so nothing was changed '
        + `(${(err as NodeJS.ErrnoException)?.code ?? 'unknown error'}). Check the disk is not full, then try again.`);
    }
  }

  #emit(keys: string[]): void {
    try { this.emit('change', keys); } catch (err) {
      console.warn(`[settings] a listener for settings changes failed (${(err as Error)?.name ?? 'error'})`);
    }
  }
}
