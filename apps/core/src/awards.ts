/**
 * The awards ceremony: titles, definitions, and the reveal.
 *
 * From the 2026 planning committee's own brainstorm: use the historical
 * CalGames judged awards "with clear award titles/definitions delivered to
 * teams in advance". The broadcast half of that is this module. The award list
 * lives in config.json with a title and a description, the GA reads the
 * description off the program screen while the hall listens, and the desk
 * reveals the winner on a button press. Two stages, one screen, same rhythm as
 * the card call.
 *
 * The one rule in here that is not obvious: THE WINNER NEVER ENTERS THE EVENT
 * BUS BEFORE THE REVEAL. Every audience surface reads the open state snapshot
 * and the open websocket fan-out, so a winner carried in the `award.show`
 * payload would be readable on any phone in the gym while the GA is still
 * building suspense. The pending winner is held here, in this process's
 * memory, and first touches the bus inside `award.presented`, at which point
 * it is public because it just happened on stage.
 *
 * Presented awards are remembered (and rebuilt from the log after a restart)
 * so the console shows the ceremony as a checklist: walk down the list, skip
 * nothing, and know at a glance what is left.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventBus } from './bus.ts';
import type { DeskEvent } from './types.ts';
import { uniqueSlug } from './content.ts';

export interface AwardDef {
  id: string;
  title: string;
  /**
   * What the award means, in the committee's own words. This is what the GA
   * reads aloud and what the projected ceremony deck shows. It is NOT what
   * goes on the broadcast plate: the real definitions run to six hundred
   * characters, and a paragraph that size on a 1080 frame is a wall nobody
   * in the hall reads. See `blurb`.
   */
  description: string;
  /**
   * One line for the broadcast plate: what this award is for, in a breath.
   *
   * The plate is read from across a gym while the GA is already speaking the
   * full definition, so the screen's job is to name the award and orient the
   * room, not to reprint the paragraph. Blank falls back to the description's
   * first sentence, which is usually the right line anyway.
   */
  blurb?: string;
  /**
   * Which ceremony this award belongs to, as a display label ("Saturday",
   * "Sunday"). CalGames runs two: the volunteer and community awards on
   * Saturday, the team awards on Sunday. Grouping by it keeps the Judge
   * Advisor and the desk looking at one ceremony at a time instead of
   * scrolling past nine awards that are not tonight's.
   *
   * A free label rather than an enum on purpose: an event that adds a Friday
   * ceremony should not need a code change. Grouping compares it
   * case-insensitively; display uses it as typed.
   */
  day?: string;
}

/**
 * Caps, sized to the real content rather than to a round number.
 *
 * The longest definition the 2026 committee wrote is the Founders' Award at
 * 597 characters. The cap used to be 400, which silently cut five of the
 * twelve awards off mid-sentence, on air, with nothing anywhere reporting it.
 */
const MAX_DESCRIPTION = 900;
const MAX_BLURB = 150;

export interface PresentedAward {
  winner: string;
  team: number | null;
  at: number;
}

const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Words that end in a period without ending a sentence.
 *
 * Tested against the text ENDING at a candidate period, so each alternative
 * anchors to the end. Single letters cover initials ("J. Smith Award") and
 * the halves of a spelled-out abbreviation ("e.g." reaches here as "g.").
 */
const ABBREVIATION =
  /(?:\s|^|\.)(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|al|Inc|Co|Ltd|Dept|Univ|No|Fig|Capt|Sgt|Gen|Rev|Hon|Ave|Blvd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.$/;

/**
 * The first real sentence, skipping periods that only end an abbreviation.
 *
 * The old rule took everything up to the first period followed by a space,
 * which is the first period in almost any prose that names a person: a
 * definition opening "Dr. Woodie Flowers believed..." put the two characters
 * "Dr." on the plate, alone, in 38px type, under the award title, in front of
 * the hall. Walk the candidates instead and take the first that is not an
 * abbreviation; if every one of them is, fall back to the whole text, which
 * the caller then truncates.
 */
const firstSentenceOf = (text: string): string => {
  const ends = /[.!?](?=\s|$)/g;
  for (let m = ends.exec(text); m; m = ends.exec(text)) {
    const head = text.slice(0, m.index + 1);
    if (!ABBREVIATION.test(head)) return head;
  }
  return text;
};

/**
 * The on-air line for an award: the blurb if one was written, otherwise the
 * description's first sentence. Falling back to the first sentence means an
 * award nobody wrote a blurb for still gets a readable plate instead of a
 * six-line paragraph.
 */
const blurbFor = (blurb: string, description: string): string => {
  if (blurb) return blurb;
  if (!description) return '';
  const firstSentence = firstSentenceOf(description);
  return firstSentence.length <= MAX_BLURB
    ? firstSentence
    : `${firstSentence.slice(0, MAX_BLURB - 1).trimEnd()}\u2026`;
};

const teamOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
};

export interface StagedWinner { winner: string; team: number | null }

export class Awards {
  #bus: EventBus;
  #file: string;
  #dir: string;
  #list: AwardDef[];
  #presented = new Map<string, PresentedAward>();
  /**
   * Winners the Judge Advisor loaded ahead of the ceremony, keyed by award id.
   *
   * Persisted to data/awards-staged.json, and the persistence is not
   * optional: the JA stages winners as judging concludes (early afternoon)
   * and may be unreachable by the ceremony. A desk restart at 4pm that lost
   * every staged winner would wreck the one segment that cannot be re-run.
   * The file lives in the same trust domain as config.json (the desk laptop,
   * gitignored), and each entry is deleted the moment its award is presented,
   * so the file empties itself as the ceremony runs.
   */
  #staged = new Map<string, StagedWinner>();
  /** The award on screen, and the winner being held back for the reveal. */
  #live: { id: string; title: string; winner: string; team: number | null } | null = null;

  /**
   * @param opts.rehearsal  Practice mode: stage winners in a file of their own.
   *
   * Without this the practice ceremony destroyed the real ceremony. `reveal()`
   * deletes a winner from `#staged` and saves, because the file is meant to
   * empty itself as the awards are presented. `--rehearsal` set the event log
   * aside and nothing else, so a desk manager rehearsing Show, Reveal, Clear
   * on Saturday afternoon deleted every winner the Judge Advisor had loaded,
   * from a file no log replay can rebuild, while README.md and the handbook
   * both promised "everything behaves exactly as it does on the day; only the
   * log is set aside".
   *
   * A separate file rather than a read-only pass over the real one, because a
   * rehearsal is run on the real screens: loading the real winners in order to
   * practise revealing them would put them on the projector in front of whoever
   * is in the gym, which is the one thing this whole module exists to prevent.
   * Practice starts with an empty book, the desk manager stages a fake winner,
   * and the real book is not opened at all.
   */
  constructor(root: string, bus: EventBus, list: unknown[] = [],
              opts: { rehearsal?: boolean } = {}) {
    this.#bus = bus;
    this.#dir = join(root, 'data');
    this.#file = join(this.#dir,
      opts.rehearsal ? 'awards-staged.rehearsal.json' : 'awards-staged.json');
    this.#list = (Array.isArray(list) ? list : []).flatMap(raw => {
      const item = raw as Record<string, unknown> | null;
      const id = clean(item?.['id'], 40);
      const title = clean(item?.['title'], 80);
      if (!id || !title) return [];
      return [{
        id, title,
        description: clean(item?.['description'], MAX_DESCRIPTION),
        blurb: clean(item?.['blurb'], MAX_BLURB),
        day: clean(item?.['day'], 20),
      }];
    });
  }

  attach(): () => void {
    return this.#bus.subscribe(ev => this.observe(ev));
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as
        { staged?: Record<string, StagedWinner> };
      for (const [id, v] of Object.entries(raw.staged ?? {})) {
        const winner = clean(v?.winner, 120);
        if (winner) this.#staged.set(id, { winner, team: teamOf(v?.team) });
      }
      if (this.#staged.size) {
        console.log(`[awards] ${this.#staged.size} staged winner(s) restored`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[awards] staged winners could not be read:', (err as Error).message);
      }
    }
  }

  /** The tail of the write queue. Never rejects; see #save. */
  #writing: Promise<void> = Promise.resolve();

  /**
   * One writer at a time, for the same reason EventContent serialises its own.
   *
   * #writeNow stages through a temp file with a FIXED name and renames it into
   * place, which is atomic against a reader and not against another writer.
   * `reveal()` calls this as `void this.#save()` and the ceremony runs one
   * award after another, so two saves overlap whenever the desk moves quickly:
   * the first rename consumes the temp file and the second fails ENOENT, or
   * the `size === 0` branch races a write and leaves `{"staged": {}}` on disk.
   * Both failures are swallowed into a console warning, on the file holding
   * the winners.
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
      if (this.#staged.size === 0) {
        // An empty file named "staged winners" is still an invitation to go
        // looking; delete it instead, so the ceremony ends with no residue.
        await rm(this.#file, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify({
        staged: Object.fromEntries(this.#staged),
      }, null, 2));
      await rename(tmp, this.#file);
    } catch (err) {
      // In-memory staging still works for this session; say so and carry on.
      console.warn('[awards] staged winners could not be saved:', (err as Error).message);
    }
  }

  /**
   * The Judge Advisor loading a winner ahead of the ceremony. Overwrites any
   * previous staging for the award: re-entering is how a typo gets fixed.
   */
  async stage(id: string, opts: { winner?: string; team?: number | null }): Promise<void> {
    if (!this.#list.some(a => a.id === id)) throw new Error(`There is no award "${id}".`);
    const winner = clean(opts.winner, 120);
    if (!winner) throw new Error('Type the winner to load.');
    this.#staged.set(id, { winner, team: teamOf(opts.team) });
    await this.#save();
  }

  /** Take a staged winner back out (wrong award picked, decision reopened). */
  async unstage(id: string): Promise<boolean> {
    const had = this.#staged.delete(id);
    if (had) await this.#save();
    return had;
  }

  /**
   * Called with the full list after every define/remove, so the caller can
   * persist it. The list used to be config.json-only, which meant adding an
   * award required finding the desk laptop and editing JSON by hand; now the
   * Judge Advisor's own page manages it and this hook writes it down.
   */
  onListChanged: ((list: AwardDef[]) => void) | null = null;

  get definitions(): AwardDef[] { return this.#list.map(a => ({ ...a })); }

  /**
   * Add an award, or rewrite the title/description of an existing one.
   * JA-tier only (enforced at the route): definitions are the JA's, the same
   * as winners. An award already presented keeps its id but can still have a
   * typo in its description fixed for the record.
   */
  define(opts: { id?: string; title?: string; description?: string;
    blurb?: string; day?: string }): AwardDef {
    const title = clean(opts.title, 80);
    if (!title) throw new Error('An award needs a title.');
    const description = clean(opts.description, MAX_DESCRIPTION);
    const blurb = clean(opts.blurb, MAX_BLURB);
    const day = clean(opts.day, 20);
    const id = clean(opts.id, 40);

    const existing = id ? this.#list.find(a => a.id === id) : undefined;
    if (id && !existing) throw new Error(`There is no award "${id}".`);
    let def: AwardDef;
    if (existing) {
      existing.title = title;
      existing.description = description;
      existing.blurb = blurb;
      existing.day = day;
      def = existing;
    } else {
      def = {
        id: uniqueSlug(title, new Set(this.#list.map(a => a.id))),
        title, description, blurb, day,
      };
      // Inserted after the last award of its own ceremony, not at the end of
      // the list. Appending put a new Saturday award behind every Sunday one,
      // which reads wrong in config.json and used to break reorder outright.
      const lastOfDay = day
        ? this.#list.map(a => (a.day ?? '').toLowerCase()).lastIndexOf(day.toLowerCase())
        : -1;
      if (lastOfDay >= 0) this.#list.splice(lastOfDay + 1, 0, def);
      else this.#list.push(def);
    }
    this.onListChanged?.(this.definitions);
    return { ...def };
  }

  /**
   * Move an award one place up or down the running order.
   *
   * Scoped to its own ceremony day: "up" from the first Sunday award must
   * not jump it into Saturday's list, which is a different evening. Hitting
   * the end of the day's block is a no-op rather than an error, because the
   * button that does nothing is already disabled in the page and an
   * exception here would only be a scary message for a mis-click.
   */
  reorder(id: string, delta: number): AwardDef[] {
    const from = this.#list.findIndex(a => a.id === id);
    if (from < 0) throw new Error(`There is no award "${id}".`);
    const step = delta < 0 ? -1 : 1;
    const day = (this.#list[from]!.day ?? '').toLowerCase();

    /*
     * Swap with the neighbour IN THIS CEREMONY, which is not always the
     * physical neighbour.
     *
     * This used to compare against `from + step` and refuse when that
     * element belonged to another day. That held only while each day's
     * awards sat together in the array, and define() appends a new award to
     * the END of the list: add one Saturday award to the shipped twelve and
     * it lands behind all nine Sunday awards, so its physical neighbour is a
     * Sunday award and every press was refused. The page enables its buttons
     * from the award's position inside its DAY GROUP, so both buttons at
     * that seam looked live, answered 200, repainted identically, and the
     * award could never be moved at all: the one thing the control exists
     * for. Walking to the next same-day index instead makes the two agree
     * however the array is arranged.
     */
    const peers: number[] = [];
    this.#list.forEach((a, i) => {
      if ((a.day ?? '').toLowerCase() === day) peers.push(i);
    });
    const k = peers.indexOf(from);
    const to = peers[k + step];
    if (to === undefined) return this.definitions;   // already first or last tonight

    const moved = this.#list[from]!;
    this.#list[from] = this.#list[to]!;
    this.#list[to] = moved;
    this.onListChanged?.(this.definitions);
    return this.definitions;
  }

  /**
   * Remove an award from the ceremony list. Refused once presented: the
   * presentation is history and the checklist must keep showing it happened.
   * A staged winner for it is discarded along with it.
   */
  async remove(id: string): Promise<void> {
    const idx = this.#list.findIndex(a => a.id === id);
    if (idx < 0) throw new Error(`There is no award "${id}".`);
    if (this.#presented.has(id)) {
      throw new Error('That award has been presented; the record stays on the list.');
    }
    if (this.#live?.id === id) {
      throw new Error('That award is on screen right now. Clear it first.');
    }
    this.#list.splice(idx, 1);
    if (this.#staged.delete(id)) await this.#save();
    this.onListChanged?.(this.definitions);
  }

  /** Exposed so a restart rebuilds the ceremony checklist from the log. */
  observe(ev: DeskEvent): void {
    if (ev.type !== 'award.presented') return;
    const p = ev.payload as { id?: unknown; winner?: unknown; team?: unknown };
    const id = clean(p.id, 40);
    if (!id) return;
    this.#presented.set(id, {
      winner: clean(p.winner, 120),
      team: teamOf(p.team),
      at: ev.ts,
    });
  }

  /**
   * Put the award up: title and description, winner withheld.
   *
   * Either an `id` from the config list, or a free `title`/`description` pair
   * for the award nobody wrote down in July: a judges' special award invented
   * on Sunday morning is a thing that actually happens.
   */
  show(opts: { id?: string; title?: string; description?: string; blurb?: string;
    winner?: string; team?: number | null }): void {
    const fromList = opts.id ? this.#list.find(a => a.id === opts.id) : undefined;
    if (opts.id && !fromList) throw new Error(`There is no award "${opts.id}".`);

    const title = fromList?.title ?? clean(opts.title, 80);
    if (!title) throw new Error('An award needs a title.');
    const description = fromList?.description ?? clean(opts.description, MAX_DESCRIPTION);
    const blurb = blurbFor(
      fromList?.blurb ?? clean(opts.blurb, MAX_BLURB),
      description,
    );
    const id = fromList?.id ?? `custom-${Date.now().toString(36)}`;

    // A winner typed now wins; otherwise the one the JA staged rides along.
    const staged = this.#staged.get(id);
    const winner = clean(opts.winner, 120) || staged?.winner || '';
    const team = opts.team !== undefined && opts.team !== null
      ? teamOf(opts.team)
      : staged?.team ?? null;
    this.#live = { id, title, winner, team };

    // No winner in this payload, ever. See the header. The blurb rides along
    // because the broadcast plate shows that rather than the full definition.
    this.#bus.emit({
      type: 'award.show',
      source: 'manual',
      payload: { id, title, description, blurb },
    });
  }

  /**
   * The reveal. The winner may have been typed at show time (held here),
   * staged by the JA, or supplied now; either way this is its first
   * appearance on the bus.
   */
  reveal(opts: { winner?: string; team?: number | null } = {}): void {
    if (!this.#live) throw new Error('No award is up. Show one first.');
    const typed = clean(opts.winner, 120);
    // show() copies the staging once, at show time, so a winner the JA staged
    // AFTER the desk pressed Show used to be invisible here: the desk hit
    // Reveal mid-suspense and was told to type a name it cannot even see (the
    // locked snapshot hides staged winners). Re-consult the staged map as the
    // last resort. The ranking is unchanged, a winner typed at the desk (now
    // or at show time) still outranks the staged one, and the staged copy
    // still first touches the bus right here, at the reveal.
    const staged = this.#staged.get(this.#live.id);
    const winner = typed || this.#live.winner || staged?.winner || '';
    if (!winner) throw new Error('Type the winner before revealing.');
    const team = opts.team !== undefined ? teamOf(opts.team)
      : typed || this.#live.winner ? this.#live.team
        : staged?.team ?? null;

    this.#bus.emit({
      type: 'award.presented',
      source: 'manual',
      payload: { id: this.#live.id, award: this.#live.title, winner, team },
    });
    // Presented means public: the staged copy has done its job, and the file
    // of secrets should shrink as the ceremony runs, not linger after it.
    if (this.#staged.delete(this.#live.id)) void this.#save();
  }

  clear(): void {
    this.#live = null;
    this.#bus.emit({ type: 'award.clear', source: 'manual', payload: {} });
  }

  /**
   * The ceremony as a checklist, in two tiers.
   *
   * The FULL view is for a Judge Advisor session: it includes the staged
   * winners, because the JA typed them and has to be able to proof-read them;
   * a typo nobody can re-read goes on the projector at the reveal.
   *
   * The LOCKED view is what a desk session sees before the JA hands over the
   * code: titles, definitions, and what has already been presented (public
   * by then). No staged winners, and no staged FLAGS either: "a winner is
   * loaded for Directors'" is itself timing information the desk does not
   * need before the ceremony.
   */
  /**
   * `onAir` is the line the plate will actually carry.
   *
   * It is the blurb when one was written and the definition's computed first
   * sentence when one was not, and the awards page used to show only the
   * former. So the one award most likely to have no blurb, a Judges' Award
   * typed on the day, was also the one whose on-air line nobody could read
   * until it was on the screen behind the presenter. Sent with every list so
   * the page can show it, and marked `blurbComputed` so the page can say
   * where it came from rather than implying somebody approved it.
   */
  snapshot(full: boolean): {
    list: (AwardDef & {
      presented: PresentedAward | null;
      staged?: StagedWinner | null;
      onAir: string;
      blurbComputed: boolean;
    })[];
    live: string | null;
    pendingWinner?: boolean;
  } {
    const withLine = (a: AwardDef) => ({
      ...a,
      onAir: blurbFor(a.blurb ?? '', a.description),
      blurbComputed: !a.blurb,
    });
    if (!full) {
      return {
        list: this.#list.map(a => ({
          ...withLine(a), presented: this.#presented.get(a.id) ?? null,
        })),
        live: this.#live?.id ?? null,
      };
    }
    return {
      list: this.#list.map(a => ({
        ...withLine(a),
        presented: this.#presented.get(a.id) ?? null,
        staged: this.#staged.get(a.id) ?? null,
      })),
      live: this.#live?.id ?? null,
      pendingWinner: !!this.#live?.winner || (!!this.#live && this.#staged.has(this.#live.id)),
    };
  }
}
