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
    const raw = this.#plan.map(s => WEIGHT[s.tier ?? 'supporting'] ?? 1);
    const sum = raw.reduce((n, w) => n + w, 0);
    /*
     * A weight is capped at what the rest of the plan can actually space out.
     *
     * With a title (3) and ONE supporting (1), three-in-a-row is arithmetic
     * rather than a scheduling mistake: three of four slots go to the same
     * sponsor, so whatever order they are in, the wrap puts them together.
     * Capping the title at (everyone else + 1) gives t s t, which honours
     * both halves of the promise: the title still appears more often, and
     * the graphic never sits on one sponsor three cards running.
     *
     * A plan with enough other sponsors to space a 3 is unaffected.
     */
    const buckets = this.#plan.map((s, i) => {
      const others = sum - (raw[i] ?? 1);
      const weight = Math.max(1, Math.min(raw[i] ?? 1, others + 1));
      return { id: s.id, weight };
    });
    const total = buckets.reduce((n, b) => n + b.weight, 0);
    const out: string[] = [];

    /*
     * Largest-remainder spacing, not round-robin-until-empty.
     *
     * The old loop drained a bucket per pass, so a title (3) plus a
     * supporting (1) built [t, s, t, t], and cycling that gives t, s, t, t,
     * t, s: the title THREE times running across the wrap, which is the exact
     * "stuck graphic" the docstring says the interleave prevents. The test
     * drew precisely one cycle, so it never crossed the wrap.
     *
     * This picks, at each slot, whichever sponsor is furthest behind the share
     * its weight entitles it to, which spreads a heavy sponsor evenly and,
     * because the whole cycle is built from the same rule, leaves the wrap
     * no worse than any other join.
     */
    const credit = buckets.map(() => 0);
    for (let slot = 0; slot < total; slot++) {
      buckets.forEach((b, i) => { credit[i] = (credit[i] ?? 0) + b.weight; });
      let best = 0;
      for (let i = 1; i < credit.length; i++) {
        if ((credit[i] ?? 0) > (credit[best] ?? 0)) best = i;
      }
      out.push(buckets[best]!.id);
      credit[best] = (credit[best] ?? 0) - total;
    }
    return out;
  }

  attach(): () => void {
    return this.#bus.subscribe(ev => {
      // The auto-hide's EMIT lives here, on the live bus only. observe() is
      // also the rebuild path (index.ts feeds it the day's log directly), so
      // an emit inside observe() would fire sponsor.hide onto the live bus
      // during replay, violating rebuild's nothing-reaches-air contract.
      const autoHide = this.#live
        && (ev.type === 'match.armed' || ev.type === 'match.start');
      this.observe(ev);
      if (autoHide) {
        this.#bus.emit({ type: 'sponsor.hide', source: 'manual', payload: {} });
      }
    });
  }

  /**
   * Also the rebuild path: the airing ledger is the proof of performance a
   * sponsor is shown after the event, and it lived only in memory, so a
   * restart silently reset every count to zero and the report under-reported
   * whoever paid most. Rebuilding from the log restores it.
   *
   * This cannot double count on the live path. hide() clears #live BEFORE it
   * emits, so the sponsor.hide that comes back around finds nothing open and
   * does nothing. During a replay nobody called hide(), #live is whatever the
   * logged sponsor.show set, and the airing is recorded here instead.
   */
  observe(ev: DeskEvent): void {
    // A sponsor card must never be on screen when a match starts. The desk
    // manager has enough to do; this gets itself out of the way. Closed with
    // EV.TS, not Date.now(), and without emitting: this branch also runs
    // during the boot-time log replay, where hide()'s wall clock recorded an
    // airing of (restart time - original show time), hours instead of the
    // true two minutes, in the exact report a sponsor is shown after the
    // event. The live-path emit that actually takes the card down rides in
    // attach()'s subscription wrapper instead.
    if (ev.type === 'match.armed' || ev.type === 'match.start') {
      const live = this.#live;
      if (live) {
        const seconds = Math.max(0, Math.round((ev.ts - live.since) / 1000));
        if (seconds >= 1) this.#airings.push({ id: live.id, at: live.since, seconds });
        this.#live = null;
      }
      return;
    }

    if (ev.type === 'sponsor.show') {
      const id = String((ev.payload as { id?: unknown }).id ?? '').trim();
      if (id) this.#live = { id, since: ev.ts };
      return;
    }

    if (ev.type === 'sponsor.hide' && this.#live) {
      const live = this.#live;
      const seconds = Math.max(0, Math.round((ev.ts - live.since) / 1000));
      // Same one-second floor the live path uses: a card up for under a
      // second was a mis-tap, and the report is only worth having if a
      // sponsor could audit it.
      if (seconds >= 1) this.#airings.push({ id: live.id, at: live.since, seconds });
      this.#live = null;
    }
  }

  get plan(): SponsorPlan[] { return this.#plan; }

  /**
   * Replace the plan while the desk is running: the sponsor list is editable
   * at the desk now, and a restart mid-event to pick up a new sponsor would
   * cost more than the sponsor bought. The airing ledger is kept: it is the
   * proof of performance, and a sponsor edited out mid-day was still shown
   * all morning. If the sponsor currently on air was removed, it comes down
   * first so its airing is counted before the plan forgets its name.
   */
  setPlan(plan: SponsorPlan[]): void {
    const next = plan.filter(s => s?.id && s?.name);
    if (this.#live && !next.some(s => s.id === this.#live!.id)) this.hide();
    this.#plan = next;
    this.#order = this.#weighted();
    this.#cursor = 0;
  }

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
