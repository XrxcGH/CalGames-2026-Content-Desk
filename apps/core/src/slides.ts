/**
 * Slides: the full-screen cards that are not sponsors.
 *
 * Three kinds, all from the 2026 planning committee's brainstorm:
 *
 *   recognition  "Thank you, Friday setup crew": the volunteer/BOD/intern
 *                recognition the committee wants on screen, with names.
 *   info         "SystemCore session, 12:30, Room 201": the session
 *                announcements, meeting calls, and food-truck-hours class of
 *                thing that otherwise lives on a paper sign nobody reads.
 *   shoutout     A Gracious Professionalism moment somebody submitted from
 *                their phone, after a human approved it.
 *
 * Deliberately NOT the sponsor system, though it looks like it from the
 * audience. The sponsor rotation keeps an airtime ledger that becomes the
 * proof-of-performance report sent to the people who paid for the event;
 * mixing recognition slides into that plan would corrupt the report in the
 * direction of overstating it, which is the worst direction. Separate deck,
 * separate module, same visual language.
 *
 * The deck is config.json's list plus whatever gets added at the event (typed
 * at the desk, or approved from the shout-out queue). Runtime additions
 * persist to data/slides.json: names get typed on Saturday, and a desk
 * restart must not eat them.
 *
 * Shout-outs are the one crowd-writable path, and the gate is a HUMAN. The
 * name is screened by the trivia name screener and the message takes a coarse
 * banned-word pass, but those only exist to spare the moderator the worst of
 * it: nothing reaches a screen until somebody at the desk presses Approve.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventBus } from './bus.ts';
import { screenName, screenText } from './trivia/names.ts';

export type SlideKind = 'recognition' | 'info' | 'shoutout';

export interface Slide {
  id: string;
  kind: SlideKind;
  title: string;
  /** Up to six short lines. The side screens enforce readability by fiat. */
  lines: string[];
}

export interface GpSubmission {
  id: string;
  name: string;
  team: number | null;
  message: string;
  at: number;
}

const KINDS: SlideKind[] = ['recognition', 'info', 'shoutout'];

const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const linesOf = (v: unknown, max = 90): string[] =>
  (Array.isArray(v) ? v : []).map(l => clean(l, max)).filter(Boolean).slice(0, 6);

/** How many submissions one address gets per window. A gym full of phones is
 *  a gym full of the same three bored people without this. */
const SUBMIT_WINDOW_MS = 10 * 60_000;
const SUBMIT_MAX = 5;
const QUEUE_CAP = 200;

export class Slides {
  #bus: EventBus;
  #file: string;
  #dir: string;
  #config: Slide[];
  #added: Slide[] = [];
  #queue: GpSubmission[] = [];
  #cursor = 0;
  #live: string | null = null;
  #seq = 0;
  #recent = new Map<string, number[]>();

  constructor(root: string, bus: EventBus, configList: unknown[] = []) {
    this.#bus = bus;
    this.#dir = join(root, 'data');
    this.#file = join(this.#dir, 'slides.json');
    const seen = new Set<string>();
    this.#config = (Array.isArray(configList) ? configList : []).flatMap(raw => {
      const item = raw as Record<string, unknown> | null;
      const id = clean(item?.['id'], 40);
      const title = clean(item?.['title'], 80);
      if (!id || !title) return [];
      // A copy-pasted id in hand-edited config.json used to wedge the whole
      // rotation: show() resolves by id and snaps the cursor to the FIRST
      // match, so next() from the first duplicate landed right back on it,
      // forever, and every slide after it never aired while the operator saw
      // the same card repaint with no error. Keep the first, drop the rest,
      // and say so at boot while someone can still fix the file.
      if (seen.has(id)) {
        console.warn(`[slides] config.json lists the slide id "${id}" more than once; `
          + 'keeping the first and skipping the rest.');
        return [];
      }
      seen.add(id);
      const kind = KINDS.includes(item?.['kind'] as SlideKind)
        ? item?.['kind'] as SlideKind : 'info';
      return [{ id, kind, title, lines: linesOf(item?.['lines']) }];
    });
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8')) as
        { added?: unknown[]; queue?: unknown[] };
      this.#added = (Array.isArray(raw.added) ? raw.added : []).flatMap(item => {
        const s = item as Slide;
        // The reload cap matches the widest legitimate writer: approve() puts
        // the whole shout-out message, up to submit()'s 200 characters, on one
        // line. Re-importing through the 90-character desk cap cut an approved
        // message mid-word after a restart, so the projector aired something
        // the moderator never approved. The round-trip must be lossless.
        return s?.id && s?.title
          ? [{ id: String(s.id), kind: KINDS.includes(s.kind) ? s.kind : 'info',
            title: clean(s.title, 80), lines: linesOf(s.lines, 200) }]
          : [];
      });
      this.#queue = (Array.isArray(raw.queue) ? raw.queue : []).flatMap(item => {
        const q = item as GpSubmission;
        return q?.id && q?.message
          ? [{ id: String(q.id), name: clean(q.name, 40), team: q.team ?? null,
            message: clean(q.message, 200), at: Number(q.at) || 0 }]
          : [];
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[slides] could not be read:', (err as Error).message);
      }
    }
  }

  /**
   * Atomic write, and serialised, the same shape as the publish queue's save.
   *
   * They race here too, and worse: submit() is the crowd-writable path, so
   * two phones posting shout-outs in the same instant reach this together.
   * Unserialised, both used one shared `.tmp` path, each opening and
   * truncating it mid-write of the other, and whichever rename landed first
   * published the interleaved bytes as slides.json (the loser's rename failed
   * ENOENT and was swallowed). load() then failed to parse the torn file at
   * the next boot and quietly fell back to config-only: every name typed on
   * Saturday and the whole pending queue, gone. Chaining is enough; these are
   * small writes, and correctness is worth more than concurrency.
   */
  #saving: Promise<void> = Promise.resolve();

  #save(): Promise<void> {
    this.#saving = this.#saving.then(() => this.#writeNow(), () => this.#writeNow());
    return this.#saving;
  }

  async #writeNow(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify({ added: this.#added, queue: this.#queue }, null, 2));
      await rename(tmp, this.#file);
    } catch (err) {
      // In-memory state is already right; losing the file costs a restart's
      // worth of typed names, not the request that added them.
      console.warn('[slides] could not be saved:', (err as Error).message);
    }
  }

  #id(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${(this.#seq++).toString(36)}`;
  }

  /** The whole deck, config first. This is what the side screens rotate. */
  get deck(): Slide[] { return [...this.#config, ...this.#added]; }

  get liveId(): string | null { return this.#live; }

  /** Pending shout-outs. Console-only: nothing here has been approved. */
  get queue(): readonly GpSubmission[] { return this.#queue; }

  show(id: string): Slide {
    const slide = this.deck.find(s => s.id === id);
    if (!slide) throw new Error(`There is no slide "${id}".`);
    this.#live = slide.id;
    this.#cursor = this.deck.findIndex(s => s.id === id);
    this.#bus.emit({ type: 'slide.show', source: 'manual', payload: { ...slide } });
    return slide;
  }

  /** The next slide in deck order, wrapping. One button, like the sponsors. */
  next(): Slide {
    const deck = this.deck;
    if (!deck.length) throw new Error('There are no slides yet.');
    this.#cursor = (this.#live === null ? this.#cursor : this.#cursor + 1) % deck.length;
    return this.show(deck[this.#cursor]!.id);
  }

  hide(): void {
    this.#live = null;
    this.#bus.emit({ type: 'slide.hide', source: 'manual', payload: {} });
  }

  /** Typed at the desk: a recognition or info slide for this event. */
  async add(opts: { kind?: unknown; title?: unknown; lines?: unknown }): Promise<Slide> {
    const title = clean(opts.title, 80);
    if (!title) throw new Error('A slide needs a title.');
    const slide: Slide = {
      id: this.#id('s'),
      kind: KINDS.includes(opts.kind as SlideKind) ? opts.kind as SlideKind : 'info',
      title,
      lines: linesOf(opts.lines),
    };
    this.#added.push(slide);
    await this.#save();
    return slide;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#added.length;
    this.#added = this.#added.filter(s => s.id !== id);
    if (this.#live === id) this.hide();
    if (this.#added.length !== before) { await this.#save(); return true; }
    return false;
  }

  /**
   * A shout-out from a phone in the stands. Screened, rate-limited, queued.
   * And NOT on any screen until a human approves it.
   */
  async submit(opts: { name?: unknown; team?: unknown; message?: unknown },
    addr = 'unknown'): Promise<GpSubmission> {
    const now = Date.now();
    const recent = (this.#recent.get(addr) ?? []).filter(t => now - t < SUBMIT_WINDOW_MS);
    if (recent.length >= SUBMIT_MAX) {
      throw new Error('That is plenty for now. Try again in a few minutes.');
    }

    const name = clean(opts.name, 40);
    const verdict = screenName(name);
    if (!verdict.ok) throw new Error(verdict.reason ?? 'Pick a different name.');

    const message = clean(opts.message, 200);
    if (message.length < 10) {
      throw new Error('Say a little more: who did the gracious thing, and what was it?');
    }
    if (!screenText(message)) {
      throw new Error('Keep it big-screen friendly and try again.');
    }
    if (this.#queue.length >= QUEUE_CAP) {
      // Quietly generous: the submitter did nothing wrong, the queue is full.
      throw new Error('The queue is full. Grab somebody from the content desk!');
    }

    const team = Number(opts.team);
    const sub: GpSubmission = {
      id: this.#id('g'),
      name,
      team: Number.isInteger(team) && team > 0 && team < 100_000 ? team : null,
      message,
      at: now,
    };
    this.#queue.push(sub);
    recent.push(now);
    this.#recent.set(addr, recent);
    await this.#save();
    return sub;
  }

  /** A human said yes: the submission becomes a shout-out slide in the deck. */
  async approve(id: string): Promise<Slide> {
    const sub = this.#queue.find(q => q.id === id);
    if (!sub) throw new Error('That submission is gone.');
    this.#queue = this.#queue.filter(q => q.id !== id);
    const slide: Slide = {
      id: this.#id('s'),
      kind: 'shoutout',
      title: 'Gracious Professionalism',
      lines: [
        sub.message,
        `- ${sub.name}${sub.team ? `, Team ${sub.team}` : ''}`,
      ],
    };
    this.#added.push(slide);
    await this.#save();
    return slide;
  }

  async reject(id: string): Promise<boolean> {
    const before = this.#queue.length;
    this.#queue = this.#queue.filter(q => q.id !== id);
    if (this.#queue.length !== before) { await this.#save(); return true; }
    return false;
  }
}
