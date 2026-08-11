/**
 * The profile book: everyone who has ever been on camera at this event.
 *
 * The panel graphic takes a name and a role. Typing those while a guest is
 * already sitting down is exactly when nobody wants to be typing, and the same
 * six people are on camera all weekend: the two commentators, the analyst, the
 * pit reporter, and whichever drive coach came over. So the book remembers
 * them and the desk becomes a checklist.
 *
 * It fills itself. Anyone put on air is remembered, which means the book is
 * complete after the first segment without anybody having sat down to
 * "manage profiles" beforehand. Nobody at an event does that.
 *
 * Persisted to `data/profiles.json` because the desk restarts, and the whole
 * point is not typing the same thing twice.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Profile {
  /** Stable across edits, so the desk's checked set survives a rename. */
  id: string;
  name: string;
  role: string;
  team: number | null;
  /**
   * A student, and therefore probably a minor. See shortenForMinor: the only
   * thing this changes is what the LOWER THIRD says. Nothing is hidden, nobody
   * is kept off camera, and the book keeps the full name.
   */
  student: boolean;
  /** What the graphic prints. Derived from name + student, never stored. */
  display: string;
  /** Sorts the book by who is actually being used. */
  lastUsedAt: number;
  uses: number;
}

/** What the desk sends: an existing id, or a new person to remember. */
export interface ProfileInput {
  id?: string;
  name: string;
  role?: string;
  team?: number | null;
  student?: boolean;
}

const clean = (s: unknown, max: number): string =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const teamOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
};

/**
 * What a student's lower third says: given name and family initial.
 *
 * The thing being avoided is specific and it is not "a kid on TV". Students
 * are on camera at every FRC event and should be — that is the point of the
 * event. What a broadcast graphic adds is a durable, indexed, searchable
 * record: FULL NAME + TEAM NUMBER + FACE, burnt into a public video that
 * outlives the weekend and that the student cannot take down. A first name and
 * an initial identifies them to everyone in the hall, to their team, and to
 * their family watching at home — which is the entire audience the graphic is
 * for — while being useless to a search engine.
 *
 * Adults keep their full names. A drive coach, a mentor, an FTA and the
 * commentators are doing a public job under their own name.
 *
 * Single-word names are left alone: there is nothing to shorten, and "A." is
 * worse than the name. Hyphenated and multi-part family names shorten on the
 * first letter of the last part, which is the convention that reads right for
 * "Nguyen Van Minh" and "Rivera-Cruz" alike.
 */
export function shortenForMinor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1]!;
  // Take the first LETTER, not the first character: an initial of "(" or a
  // quote mark would be gibberish on the graphic.
  const letter = [...last].find(c => /\p{L}/u.test(c));
  if (!letter) return parts.slice(0, -1).join(' ');
  return `${parts.slice(0, -1).join(' ')} ${letter.toUpperCase()}.`;
}

/** Name plus team is the identity. Two people called Alex are two profiles;
 *  the same Alex typed twice is one. */
const keyOf = (name: string, team: number | null): string =>
  `${name.toLowerCase()}#${team ?? ''}`;

/** Stamp the derived display name. One place, so it cannot drift from `name`. */
function withDisplay(p: Omit<Profile, 'display'>): Profile {
  return { ...p, display: p.student ? shortenForMinor(p.name) : p.name };
}

export class ProfileBook {
  #file: string;
  #dir: string;
  #profiles = new Map<string, Profile>();
  #seq = 0;

  constructor(root: string) {
    this.#dir = join(root, 'data');
    this.#file = join(this.#dir, 'profiles.json');
  }

  /** Most-recently-used first: the people on camera today sort to the top. */
  get list(): Profile[] {
    return [...this.#profiles.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map(withDisplay);
  }

  get(id: string): Profile | null {
    const p = this.#profiles.get(id);
    return p ? withDisplay(p) : null;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as Profile[];
      for (const p of Array.isArray(raw) ? raw : []) {
        if (!p?.id || !p?.name) continue;
        this.#profiles.set(p.id, {
          id: String(p.id),
          name: clean(p.name, 40),
          role: clean(p.role, 40),
          team: teamOf(p.team),
          // Books written before this flag existed default to false, which is
          // the right default: a book full of adults must not have everybody's
          // surname vanish on upgrade.
          student: p.student === true,
          display: '',
          lastUsedAt: Number(p.lastUsedAt) || 0,
          uses: Number(p.uses) || 0,
        });
      }
      console.log(`[profiles] ${this.#profiles.size} saved`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[profiles] could not be read:', (err as Error).message);
      }
    }
  }

  async #save(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      // `display` is derived, so it is not written: a stale one in the file
      // would outrank the name it came from after a hand edit.
      const stored = this.list.map(({ display: _d, ...rest }) => rest);
      await writeFile(tmp, JSON.stringify(stored, null, 2));
      await rename(tmp, this.#file);
    } catch (err) {
      // The book is already correct in memory. Losing the file is not worth
      // failing the request that just put somebody on air.
      console.warn('[profiles] could not be saved:', (err as Error).message);
    }
  }

  #id(): string {
    return `p${Date.now().toString(36)}${(this.#seq++).toString(36)}`;
  }

  /**
   * Resolve what the desk sent into real profiles, remembering anyone new.
   * An id that no longer exists (deleted on another console) falls back to the
   * name that came with it rather than dropping the person off the graphic.
   */
  async resolve(inputs: ProfileInput[]): Promise<Profile[]> {
    const byKey = new Map<string, Profile>();
    for (const p of this.#profiles.values()) byKey.set(keyOf(p.name, p.team), p);

    const out: Profile[] = [];
    const now = Date.now();
    let dirty = false;

    for (const input of inputs) {
      const name = clean(input.name, 40);
      if (!name) continue;
      const role = clean(input.role, 40);
      const team = teamOf(input.team);

      let profile = input.id ? this.#profiles.get(input.id) : undefined;
      if (!profile) profile = byKey.get(keyOf(name, team));

      if (profile) {
        // A role typed at the desk wins: the same person is an analyst in one
        // segment and a drive coach in the next, and what they are RIGHT NOW
        // is what belongs on the graphic.
        if (role && role !== profile.role) { profile.role = role; dirty = true; }
        if (name !== profile.name) { profile.name = name; dirty = true; }
        // Only an explicit flag moves this. A desk that omits the field is not
        // saying "this person is an adult", it is saying nothing, and a stray
        // omission must not quietly restore a student's full surname.
        if (input.student !== undefined && input.student !== profile.student) {
          profile.student = input.student === true; dirty = true;
        }
      } else {
        profile = { id: this.#id(), name, role, team, student: input.student === true,
          display: '', lastUsedAt: 0, uses: 0 };
        this.#profiles.set(profile.id, profile);
        byKey.set(keyOf(name, team), profile);
        dirty = true;
      }

      profile.lastUsedAt = now;
      profile.uses++;
      dirty = true;
      out.push(withDisplay(profile));
    }

    if (dirty) await this.#save();
    return out;
  }

  /** Edit or add one by hand, from the book editor on the desk. */
  async upsert(input: ProfileInput): Promise<Profile> {
    const name = clean(input.name, 40);
    if (!name) throw new Error('A profile needs a name.');
    const existing = input.id ? this.#profiles.get(input.id) : null;
    const profile: Profile = existing
      ? { ...existing, name, role: clean(input.role, 40), team: teamOf(input.team),
        student: input.student === undefined ? existing.student : input.student === true }
      : {
        id: this.#id(), name, role: clean(input.role, 40), team: teamOf(input.team),
        student: input.student === true, display: '',
        lastUsedAt: 0, uses: 0,
      };
    this.#profiles.set(profile.id, profile);
    await this.#save();
    return withDisplay(profile);
  }

  async remove(id: string): Promise<boolean> {
    const had = this.#profiles.delete(id);
    if (had) await this.#save();
    return had;
  }
}
