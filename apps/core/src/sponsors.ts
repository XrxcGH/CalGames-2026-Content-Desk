/**
 * Sponsor recognition, and proof that it happened.
 *
 * Two problems, and the second is the one nobody builds for.
 *
 * The first is showing sponsors at all: an offseason event runs on money from
 * organisations who were promised visibility, and what usually happens is a
 * slide deck somebody remembers to put up during lunch, which means the
 * sponsor who paid most gets shown least because lunch is when the operator is
 * eating.
 *
 * The second is that after the event somebody has to tell those organisations
 * what they got, and the honest answer is currently "quite a lot, I think".
 * So every airing is counted. The report at the end is a real number of
 * appearances and seconds on screen, per sponsor, which is the difference
 * between asking for money again and being able to show why it was worth it.
 *
 * Deliberately NOT automatic-on-air: this hands the desk a rotation it can
 * take, and cues can take it during a gap, but nothing here seizes the program
 * feed. A sponsor card that interrupts a match is worth less than no sponsor
 * card, to the sponsor most of all.
 */

import type { EventBus } from './bus.ts';
import type { DeskEvent } from './types.ts';

export interface SponsorPlan {
  id: string;
  name: string;
  /** Tier drives how often it comes round, not how big it is drawn. */
  tier?: 'title' | 'major' | 'supporting';
  /** One line the announcer could read. Optional. */
  line?: string;
  /** Path under /media, e.g. "/media/sponsors/acme.png". Optional. */
  logo?: string;
}

export interface SponsorAiring {
  id: string;
  at: number;
  seconds: number;
}

export interface SponsorRow extends SponsorPlan {
  airings: number;
  seconds: number;
  lastAt: number | null;
}

export interface SponsorSnapshot {
  /** The sponsor currently on air, or null. */
  live: { id: string; name: string; line: string; logo: string | null; since: number } | null;
  rows: SponsorRow[];
  totalAirings: number;
  updatedAt: number;
}

/**
 * How many rotation slots each tier gets. A title sponsor comes round three
 * times as often as a supporting one, which is what the money bought; it is
 * not drawn three times bigger, because that is not.
 */
const WEIGHT: Record<string, number> = { title: 3, major: 2, supporting: 1 };

export class Sponsors {
  #bus: EventBus;
  #plan: SponsorPlan[];
  #airings: SponsorAiring[] = [];
  #live: { id: string; since: number } | null = null;
  /** Round-robin cursor over the weighted list. */
  #cursor = 0;
  #order: string[];

  constructor(bus: EventBus, plan: SponsorPlan[] = []) {
    this.#bus = bus;
    this.#plan = plan.filter(s => s?.id && s?.name);
    this.#order = this.#weighted();
  }

  /**
   * The rotation order: each sponsor repeated by its tier weight, then
   * interleaved so a title sponsor does not appear three times in a row.
   * Three in a row reads as a stuck graphic, which is worse for that sponsor
   * than appearing once.
   */
  #weighted(): string[] {
    const buckets = this.#plan.map(s => ({
      id: s.id, left: WEIGHT[s.tier ?? 'supporting'] ?? 1,
    }));
    const out: string[] = [];
    let any = true;
    while (any) {
      any = false;
      for (const b of buckets) {
        if (b.left <= 0) continue;
        out.push(b.id);
        b.left--;
        any = true;
      }
    }
    return out;
  }

  attach(): () => void {
    return this.#bus.subscribe(ev => this.observe(ev));
  }

  observe(ev: DeskEvent): void {
    // A sponsor card must never be on screen when a match starts. The desk
    // manager has enough to do; this gets itself out of the way.
    if (ev.type === 'match.armed' || ev.type === 'match.start') this.hide();
  }

  get plan(): SponsorPlan[] { return this.#plan; }

  /** Put the next sponsor up, in rotation order. */
  next(): SponsorSnapshot {
    if (!this.#order.length) throw new Error('No sponsors are configured.');
    const id = this.#order[this.#cursor % this.#order.length]!;
    this.#cursor++;
    return this.show(id);
  }

  show(id: string): SponsorSnapshot {
    const sponsor = this.#plan.find(s => s.id === id);
    if (!sponsor) throw new Error(`There is no sponsor "${id}".`);
    this.hide();                       // close out whatever was up
    this.#live = { id, since: Date.now() };
    this.#bus.emit({
      type: 'sponsor.show', source: 'manual',
      payload: {
        id, name: sponsor.name, line: sponsor.line ?? '', logo: sponsor.logo ?? null,
      },
    });
    return this.snapshot;
  }

  /**
   * Take it down, and record how long it was actually up.
   *
   * Counted on the way DOWN rather than on the way up, because the number that
   * matters to a sponsor is seconds on screen, and that is not knowable until
   * it leaves.
   */
  hide(): SponsorSnapshot {
    const live = this.#live;
    if (live) {
      const seconds = Math.max(0, Math.round((Date.now() - live.since) / 1000));
      // A card up for under a second was a mis-tap, not an airing. Counting it
      // would inflate the report, and the report is only worth anything if it
      // is one a sponsor could audit.
      if (seconds >= 1) this.#airings.push({ id: live.id, at: live.since, seconds });
      this.#live = null;
      this.#bus.emit({ type: 'sponsor.hide', source: 'manual', payload: {} });
    }
    return this.snapshot;
  }

  get snapshot(): SponsorSnapshot {
    const rows: SponsorRow[] = this.#plan.map(s => {
      const mine = this.#airings.filter(a => a.id === s.id);
      return {
        ...s,
        airings: mine.length,
        seconds: mine.reduce((n, a) => n + a.seconds, 0),
        lastAt: mine.length ? mine[mine.length - 1]!.at : null,
      };
    });

    const liveSponsor = this.#live
      ? this.#plan.find(s => s.id === this.#live!.id) ?? null
      : null;

    return {
      live: liveSponsor && this.#live
        ? {
          id: liveSponsor.id, name: liveSponsor.name,
          line: liveSponsor.line ?? '', logo: liveSponsor.logo ?? null,
          since: this.#live.since,
        }
        : null,
      rows,
      totalAirings: this.#airings.length,
      updatedAt: Date.now(),
    };
  }

  /**
   * The proof-of-performance report, as text somebody can paste into an email.
   *
   * Text rather than a chart on purpose: this gets forwarded to a person at a
   * company who wants one number, and a PNG in an email thread is where a
   * number goes to be ignored.
   */
  report(eventName: string): string {
    const rows = this.snapshot.rows
      .slice()
      .sort((a, b) => b.seconds - a.seconds);
    const lines = rows.map(r => {
      const mins = Math.floor(r.seconds / 60);
      const secs = r.seconds % 60;
      const time = mins ? `${mins}m ${secs}s` : `${secs}s`;
      return `  ${r.name}: ${r.airings} appearance${r.airings === 1 ? '' : 's'}, ${time} on screen`;
    });
    return [
      `${eventName}: sponsor recognition`,
      '',
      ...(lines.length ? lines : ['  Nothing was shown.']),
      '',
      'Counted from the broadcast itself: each figure is time the sponsor was',
      'on the program feed, which went to the venue screens and the stream.',
    ].join('\n');
  }
}
