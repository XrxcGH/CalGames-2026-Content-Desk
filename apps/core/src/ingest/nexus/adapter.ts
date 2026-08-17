/**
 * FRC Nexus -> desk adapter. Queue lifecycle and announcements.
 *
 * The desk already knows what the FIELD is doing. What it has never known is
 * what the QUEUERS are doing, and that is where the four minutes before a
 * match live: teams are called, they walk, they arrive on deck, and only then
 * does Cheesy Arena load the match. Nexus is what the queuers type into, so it
 * is the only source that can say "1678 is being called right now".
 *
 * Three things come out of this:
 *
 *   1. A real on-deck state. "Now queuing" is a fact from a human, not an
 *      inference from a schedule, so the side screens and the phone page can
 *      stop guessing.
 *   2. Better start estimates than the desk's own pace model, because Nexus's
 *      estimates come from a queuer who knows the field is being reset. The
 *      pace model stays as the fallback for when Nexus is absent or stale.
 *   3. Announcements. Nexus is where "lunch is at 12:15" and "please clear the
 *      pit aisle" get typed, and mirroring them onto the venue screens is free.
 *
 * Trust rules, because two sources disagreeing on air is worse than one being
 * absent:
 *
 *   - Nexus NEVER touches the live match. Scores, the clock, the hub, and
 *     which match is loaded are the field's, always.
 *   - Nexus times are `derived`, never `authoritative`. They are somebody's
 *     estimate, and the desk labels estimates.
 *   - A stale payload is dropped. Nexus recomputes on every request and its
 *     own docs warn that repeated requests can arrive out of order, so
 *     anything older than the newest `dataAsOfTime` seen is ignored.
 */

import type { EventBus } from '../../bus.ts';
import type { UpcomingMatch } from '../../types.ts';
import { NexusClient, type NexusEventStatus, type NexusMatch } from './client.ts';

export interface NexusAdapterOpts {
  bus: EventBus;
  apiKey: string;
  eventKey: string;
  /** Poll interval. 20s is well inside a queuer's own update rate. */
  pollMs?: number;
  client?: NexusClient;
}

/** Statuses Nexus uses that mean the match has not been played yet. */
const PENDING = /queuing|on deck|on field|scheduled|waiting/i;

const teamNumbers = (raw: (string | null)[] | undefined): number[] =>
  (raw ?? []).map(t => Number(t)).filter(n => Number.isInteger(n) && n > 0);

/** "Qualification 12" -> "Q12", so a side screen can fit it. */
export function shortLabel(label: string): string {
  const m = /^(practice|qualification|playoff|final|match)\s*(\d+)/i.exec(label.trim());
  if (!m) return label.trim().slice(0, 12);
  const kind = m[1]!.toLowerCase();
  const letter = kind === 'qualification' ? 'Q'
    : kind === 'practice' ? 'P'
      : kind === 'final' ? 'F' : 'M';
  return `${letter}${m[2]}`;
}

/**
 * The single best start estimate Nexus has for a match, preferring what has
 * actually happened over what is predicted to.
 */
export function bestStartEstimate(m: NexusMatch): number | null {
  const t = m.times ?? {};
  return t.estimatedStartTime ?? t.estimatedOnFieldTime ?? t.estimatedOnDeckTime
    ?? t.estimatedQueueTime ?? null;
}

/**
 * Consecutive failed polls before the queueing banner is treated as stale.
 * Three at the 20s poll is about a minute, which is shorter than the walk from
 * the pits and long enough to ride out one flaky response.
 */
const STALE_AFTER_FAILURES = 3;

export class NexusAdapter {
  #bus: EventBus;
  #client: NexusClient;
  #pollMs: number;
  #timer: NodeJS.Timeout | null = null;
  #lastData = 0;
  #seenAnnouncements = new Set<string>();
  #lastNowQueuing: string | null = null;
  #failures = 0;
  /** Per-half apply failures, so a broken feed is loud once and then quiet. */
  #applyFails = new Map<string, number>();
  #started = false;

  constructor(opts: NexusAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = opts.client ?? new NexusClient({
      apiKey: opts.apiKey, eventKey: opts.eventKey,
    });
    this.#pollMs = opts.pollMs ?? 20_000;
  }

  start(): void {
    if (this.#timer) return;
    void this.poll();
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async poll(): Promise<void> {
    try {
      const status = await this.#client.status();
      this.apply(status);
      // After apply, not before. Resetting first meant an apply that threw
      // counted as failure #1 every single time, so the "loud once, then
      // quiet" throttle fired every twenty seconds all afternoon — precisely
      // the spam it exists to prevent. (apply() no longer throws, but the
      // ordering was wrong on its own terms.)
      this.#failures = 0;
    } catch (err) {
      this.#failures++;
      // Loud once, then quiet: a venue whose uplink is down would otherwise
      // fill the log with the same line every twenty seconds all afternoon.
      if (this.#failures === 1 || this.#failures % 15 === 0) {
        console.warn(`[nexus] poll failed (${this.#failures}x): ${(err as Error).message}`);
      }
      // Stop calling a team that was called a minute ago. Nothing else can
      // clear this banner: the reducer keeps nowQueuing until something sends
      // an explicit null, and the only other source of queue.updated is the
      // Cheesy adapter, whose payload has no opinion on queueing at all. So a
      // dead uplink left the side screens and every pit monitor telling a team
      // to walk to the field, indefinitely.
      //
      // Exactly at three, so it fires once rather than on every later failure.
      // #lastNowQueuing is deliberately left alone: recovery's next successful
      // apply() republishes the banner, and clearing it here would re-announce
      // the same team as freshly called.
      if (this.#failures === STALE_AFTER_FAILURES) {
        console.warn('[nexus] no queueing data for a while, clearing the "now queuing" banner');
        this.#bus.emit({
          type: 'queue.updated', source: 'nexus', confidence: 'derived',
          payload: { nowQueuing: null },
        });
      }
    }
  }

  /** Exposed for tests and for the webhook path, if one is ever added. */
  apply(status: NexusEventStatus): void {
    // Nexus warns that repeated requests can land out of order. The newest
    // dataAsOfTime wins, and an older payload is simply not news.
    const asOf = Number(status.dataAsOfTime ?? 0);
    if (asOf && asOf < this.#lastData) return;
    this.#lastData = asOf || this.#lastData;

    // Each half is caught on its own, and #started latches BEFORE either runs.
    //
    // This used to be three bare statements. One malformed item — an
    // `announcements: [null]`, or `matches` arriving as an object rather than
    // an array — threw out of apply() before the last line, so #started stayed
    // false forever. queue.called is gated on #started, so "teams to the
    // field" never fired again for the rest of the day, while queue.updated
    // kept flowing and everything looked alive.
    const wasStarted = this.#started;
    this.#started = true;
    try { this.#applyQueue(status); } catch (err) { this.#warn('queue', err); }
    try {
      this.#applyAnnouncements(status, wasStarted);
    } catch (err) { this.#warn('announcements', err); }
  }

  /** Loud once per kind, then quiet. A broken feed must not fill the log. */
  #warn(what: string, err: unknown): void {
    const n = (this.#applyFails.get(what) ?? 0) + 1;
    this.#applyFails.set(what, n);
    if (n === 1 || n % 15 === 0) {
      console.warn(`[nexus] could not read ${what} (${n}x): ${(err as Error).message}`);
    }
  }

  #applyQueue(status: NexusEventStatus): void {
    const matches = Array.isArray(status.matches) ? status.matches : [];
    const pending = matches.filter(m => {
      const label = (m.label ?? '').trim();
      if (!label) return false;
      // No status at all is treated as pending: an event that has not started
      // has a schedule and nothing else.
      return !m.status || PENDING.test(m.status);
    });

    const upcoming: UpcomingMatch[] = pending.slice(0, 6).map(m => ({
      name: (m.label ?? '').trim(),
      shortName: shortLabel(m.label ?? ''),
      // ISO-ish local time string is what the surfaces render; null when Nexus
      // has no estimate, which is honest rather than inventing one.
      time: (() => {
        const at = bestStartEstimate(m);
        return at ? new Date(at).toISOString() : null;
      })(),
      red: teamNumbers(m.redTeams),
      blue: teamNumbers(m.blueTeams),
    }));

    // Emitted even when empty. It used to return early on an empty list, so
    // once Nexus marked the last qual Completed the side screens went on
    // advertising a played match as "up next" through alliance selection and
    // into the playoffs, with nothing able to clear it short of a restart.
    {
      this.#bus.emit({
        type: 'queue.updated',
        source: 'nexus',
        // Derived, not authoritative: these are a queuer's estimates, and the
        // desk's contract is that an estimate is labelled as one.
        confidence: 'derived',
        payload: {
          upcoming,
          nowQueuing: status.nowQueuing ?? null,
          from: 'nexus',
        },
      });
    }

    // A change in who is being called is the event worth announcing on its
    // own, separately from the list: it is what drives "teams to the field".
    // Not gated on the first poll: unlike the announcement backlog, the CURRENT
    // call is news the moment the desk learns it, and suppressing it meant a
    // desk started mid-session showed nobody being called until the queuer
    // moved on.
    const now = (status.nowQueuing ?? '').trim() || null;
    if (now !== this.#lastNowQueuing) {
      this.#lastNowQueuing = now;
      if (now) {
        const match = matches.find(m => (m.label ?? '').trim() === now);
        this.#bus.emit({
          type: 'queue.called',
          source: 'nexus',
          confidence: 'authoritative',   // a human pressed this
          payload: {
            label: now,
            red: teamNumbers(match?.redTeams),
            blue: teamNumbers(match?.blueTeams),
          },
        });
      }
    }
  }

  #applyAnnouncements(status: NexusEventStatus, wasStarted: boolean): void {
    const list = Array.isArray(status.announcements) ? status.announcements : [];
    for (const a of list) {
      const text = (a?.announcement ?? '').trim();
      if (!text) continue;
      const id = a.id ?? `${a.postedTime ?? 0}:${text}`;
      if (this.#seenAnnouncements.has(id)) continue;
      this.#seenAnnouncements.add(id);
      // On the first poll the whole backlog is already "seen": mirroring
      // this morning's announcements onto the screens at 2pm would be worse
      // than useless. The pre-latch value, since apply() now sets the flag
      // before calling either half.
      if (!wasStarted) continue;

      this.#bus.emit({
        type: 'announcement.posted',
        source: 'nexus',
        payload: { text, postedAt: a.postedTime ?? Date.now(), from: 'Nexus' },
      });
    }
  }
}
