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
 * memory, and first touches the bus inside `award.presented` — at which point
 * it is public because it just happened on stage.
 *
 * Presented awards are remembered (and rebuilt from the log after a restart)
 * so the console shows the ceremony as a checklist: walk down the list, skip
 * nothing, and know at a glance what is left.
 */

import type { EventBus } from './bus.ts';
import type { DeskEvent } from './types.ts';

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

export class Awards {
  #bus: EventBus;
  #list: AwardDef[];
  #presented = new Map<string, PresentedAward>();
  /** The award on screen, and the winner being held back for the reveal. */
  #live: { id: string; title: string; winner: string; team: number | null } | null = null;

  constructor(bus: EventBus, list: unknown[] = []) {
    this.#bus = bus;
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
   * for the award nobody wrote down in July — a judges' special award invented
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

    const winner = clean(opts.winner, 120);
    this.#live = { id, title, winner, team: teamOf(opts.team) };

    // No winner in this payload, ever. See the header.
    this.#bus.emit({
      type: 'award.show',
      source: 'manual',
      payload: { id, title, description },
    });
  }

  /**
   * The reveal. The winner may have been typed at show time (held here) or is
   * supplied now; either way this is its first appearance on the bus.
   */
  reveal(opts: { winner?: string; team?: number | null } = {}): void {
    if (!this.#live) throw new Error('No award is up. Show one first.');
    const winner = clean(opts.winner, 120) || this.#live.winner;
    if (!winner) throw new Error('Type the winner before revealing.');
    const team = opts.team !== undefined ? teamOf(opts.team) : this.#live.team;

    this.#bus.emit({
      type: 'award.presented',
      source: 'manual',
      payload: { id: this.#live.id, award: this.#live.title, winner, team },
    });
  }

  clear(): void {
    this.#live = null;
    this.#bus.emit({ type: 'award.clear', source: 'manual', payload: {} });
  }

  /**
   * The ceremony as a checklist. `pendingWinner` says whether a reveal is
   * armed WITHOUT saying what it is: the console is behind the PIN, but a
   * snapshot is the kind of thing that ends up in a screen share.
   */
  get snapshot(): {
    list: (AwardDef & { presented: PresentedAward | null })[];
    live: string | null;
    pendingWinner: boolean;
  } {
    return {
      list: this.#list.map(a => ({ ...a, presented: this.#presented.get(a.id) ?? null })),
      live: this.#live?.id ?? null,
      pendingWinner: !!this.#live?.winner,
    };
  }
}
