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
  /** What the award means, in the words the GA reads aloud. */
  description: string;
}

export interface PresentedAward {
  winner: string;
  team: number | null;
  at: number;
}

const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

  constructor(root: string, bus: EventBus, list: unknown[] = []) {
    this.#bus = bus;
    this.#dir = join(root, 'data');
    this.#file = join(this.#dir, 'awards-staged.json');
    this.#list = (Array.isArray(list) ? list : []).flatMap(raw => {
      const item = raw as Record<string, unknown> | null;
      const id = clean(item?.['id'], 40);
      const title = clean(item?.['title'], 80);
      if (!id || !title) return [];
      return [{ id, title, description: clean(item?.['description'], 400) }];
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

  async #save(): Promise<void> {
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
  define(opts: { id?: string; title?: string; description?: string }): AwardDef {
    const title = clean(opts.title, 80);
    if (!title) throw new Error('An award needs a title.');
    const description = clean(opts.description, 400);
    const id = clean(opts.id, 40);

    const existing = id ? this.#list.find(a => a.id === id) : undefined;
    if (id && !existing) throw new Error(`There is no award "${id}".`);
    let def: AwardDef;
    if (existing) {
      existing.title = title;
      existing.description = description;
      def = existing;
    } else {
      def = { id: uniqueSlug(title, new Set(this.#list.map(a => a.id))), title, description };
      this.#list.push(def);
    }
    this.onListChanged?.(this.definitions);
    return { ...def };
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
  show(opts: { id?: string; title?: string; description?: string;
    winner?: string; team?: number | null }): void {
    const fromList = opts.id ? this.#list.find(a => a.id === opts.id) : undefined;
    if (opts.id && !fromList) throw new Error(`There is no award "${opts.id}".`);

    const title = fromList?.title ?? clean(opts.title, 80);
    if (!title) throw new Error('An award needs a title.');
    const description = fromList?.description ?? clean(opts.description, 400);
    const id = fromList?.id ?? `custom-${Date.now().toString(36)}`;

    // A winner typed now wins; otherwise the one the JA staged rides along.
    const staged = this.#staged.get(id);
    const winner = clean(opts.winner, 120) || staged?.winner || '';
    const team = opts.team !== undefined && opts.team !== null
      ? teamOf(opts.team)
      : staged?.team ?? null;
    this.#live = { id, title, winner, team };

    // No winner in this payload, ever. See the header.
    this.#bus.emit({
      type: 'award.show',
      source: 'manual',
      payload: { id, title, description },
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
  snapshot(full: boolean): {
    list: (AwardDef & {
      presented: PresentedAward | null;
      staged?: StagedWinner | null;
    })[];
    live: string | null;
    pendingWinner?: boolean;
  } {
    if (!full) {
      return {
        list: this.#list.map(a => ({ ...a, presented: this.#presented.get(a.id) ?? null })),
        live: this.#live?.id ?? null,
      };
    }
    return {
      list: this.#list.map(a => ({
        ...a,
        presented: this.#presented.get(a.id) ?? null,
        staged: this.#staged.get(a.id) ?? null,
      })),
      live: this.#live?.id ?? null,
      pendingWinner: !!this.#live?.winner || (!!this.#live && this.#staged.has(this.#live.id)),
    };
  }
}
