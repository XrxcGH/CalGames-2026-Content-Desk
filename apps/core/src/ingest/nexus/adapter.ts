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

/**
 * Nexus has no terminal match status, and this file was written as though it
 * did.
 *
 * The published enum is exactly ["Queuing soon", "Now queuing", "On deck",
 * "On field"]. There is no "Completed", no "Scheduled", no "Waiting". A match
 * that has been played KEEPS "On field" for the rest of the event: in the
 * spec's own mid-playoffs example, with `nowQueuing: "Playoff 5"`, every
 * practice match, every qualification match and Playoff 1 through 4 are all
 * still "On field". The `matches` array is the whole schedule, in play order,
 * and nothing is ever removed from it.
 *
 * The old filter matched all four values, so it kept the entire schedule and
 * took the first six. From the first successful poll on Friday until shutdown
 * on Sunday, the side screens, the pit monitor and the announcer's page would
 * all have shown Practice 1 through Practice 6 as the upcoming queue, with
 * Saturday-morning times, while the "now queuing" banner directly above them
 * correctly said Qualification 47. Worse than having no Nexus at all, because
 * a queue.updated kept arriving every twenty seconds so nothing looked stale.
 *
 * So the rule is positional rather than textual. The array is in play order,
 * "On field" means on the field now or already played, and therefore
 * everything after the LAST "On field" row is what has not happened yet. That
 * also handles the replay rows Nexus interleaves, which sit in play order
 * where they will actually be run.
 */
const ON_FIELD = 'on field';

/**
 * Matches that have not been played, in play order.
 *
 * Exported because the rule is the whole feature, and it is worth being able
 * to point a test at it directly with the spec's own payloads.
 */
export function pendingMatches(matches: NexusMatch[]): NexusMatch[] {
  let lastOnField = -1;
  for (let i = 0; i < matches.length; i++) {
    if ((matches[i]!.status ?? '').trim().toLowerCase() === ON_FIELD) lastOnField = i;
  }
  return matches.slice(lastOnField + 1).filter(m => {
    if (!(m.label ?? '').trim()) return false;
    // AutoQueue events stamp a commit time when the scores go up. Nothing
    // before the cut should carry one, so this only catches a row that has
    // somehow been played out of order.
    return !m.times?.actualCommitTime;
  });
}

const teamNumbers = (raw: (string | null)[] | undefined): number[] =>
  (raw ?? []).map(t => Number(t)).filter(n => Number.isInteger(n) && n > 0);

/**
 * "Qualification 12" -> "Q12", so a side screen can fit it.
 *
 * Nexus documents exactly five label forms: `Practice 1`, `Qualification 24`,
 * `Qualification 24 Replay`, `Playoff 8`, `Final 1`.
 *
 * M for a playoff match is not an invention: Cheesy Arena's own double
 * elimination bracket names them `M1`..`M13` (playoff/double_elimination.go),
 * so the field monitor, the bracket graphic and the announcer all say M8 too.
 * It used to reach M only by falling through a generic `match` branch, which
 * was right by accident; it is spelled out now.
 *
 * The replay suffix is the real fix here. Without it `Qualification 24 Replay`
 * shortened to `Q24`, identical to the match it replaces, so the deck showed
 * two rows both reading Q24 with different teams in them. The spec's own
 * mid-qualifications example has exactly this case.
 */
export function shortLabel(label: string): string {
  const text = label.trim();
  const m = /^(practice|qualification|playoff|final|match)\s*(\d+)(\s+replay)?/i.exec(text);
  if (!m) return text.slice(0, 12);
  const kind = m[1]!.toLowerCase();
  const letter = kind === 'qualification' ? 'Q'
    : kind === 'practice' ? 'P'
      : kind === 'final' ? 'F' : 'M';
  return `${letter}${m[2]}${m[3] ? 'R' : ''}`;
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
  /**
   * Team number -> pit address, fetched once. Static for the weekend, and it
   * is what turns "1678 needs polycarb" into somewhere to walk.
   */
  #pits: Record<string, string> = {};

  constructor(opts: NexusAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = opts.client ?? new NexusClient({
      apiKey: opts.apiKey, eventKey: opts.eventKey,
    });
    this.#pollMs = opts.pollMs ?? 20_000;
  }

  start(): void {
    if (this.#timer) return;
    // Pit addresses do not move once the event opens, so this is fetched once
    // and never again. A failure is not worth a retry loop: it costs a parts
    // request its "(pit A1)" and nothing else.
    void this.#client.pits()
      .then(pits => { if (pits && typeof pits === 'object') this.#pits = pits; })
      .catch(() => { /* addresses are a nicety, not a feed */ });
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
      // quiet" throttle fired every twenty seconds all afternoon: precisely
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
    // This used to be three bare statements. One malformed item (an
    // `announcements: [null]`, or `matches` arriving as an object rather than
    // an array) threw out of apply() before the last line, so #started stayed
    // false forever. queue.called is gated on #started, so "teams to the
    // field" never fired again for the rest of the day, while queue.updated
    // kept flowing and everything looked alive.
    const wasStarted = this.#started;
    this.#started = true;
    try { this.#applyQueue(status); } catch (err) { this.#warn('queue', err); }
    try {
      this.#applyAnnouncements(status, wasStarted);
    } catch (err) { this.#warn('announcements', err); }
    try {
      this.#applyPartsRequests(status, wasStarted);
    } catch (err) { this.#warn('parts requests', err); }
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

    const upcoming: UpcomingMatch[] = pendingMatches(matches).slice(0, 6).map(m => ({
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
      // What happens after this match. Nexus is where the queuers type
      // "lunch after Q6", and it is the one thing the whole building plans
      // its day around; the desk had been parsing it away.
      ...(m.breakAfter ? { breakAfter: m.breakAfter } : {}),
      ...(m.replayOf ? { replayOf: m.replayOf } : {}),
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

  /**
   * A team asking the room for a part, mirrored onto the venue screens.
   *
   * Same de-duplicated, backlog-suppressed path as announcements, and for the
   * same reasons: the request carries an id, the whole open list arrives on
   * every poll, and replaying this morning's requests at 2pm would send
   * people looking for a part that was found hours ago.
   *
   * Phrased as an announcement rather than given its own event type because
   * "1678 needs 1/8 polycarb" is exactly what the announcement rail is for,
   * and every surface that can carry one already does.
   */
  #applyPartsRequests(status: NexusEventStatus, wasStarted: boolean): void {
    const list = Array.isArray(status.partsRequests) ? status.partsRequests : [];
    for (const p of list) {
      const parts = (p?.parts ?? '').trim();
      if (!parts) continue;
      const id = `parts:${p.id ?? `${p.postedTime ?? 0}:${parts}`}`;
      if (this.#seenAnnouncements.has(id)) continue;
      this.#seenAnnouncements.add(id);
      if (!wasStarted) continue;

      const team = (p.requestedByTeam ?? '').trim();
      const pit = team ? this.#pits[team] : undefined;
      const who = team ? `Team ${team}${pit ? ` (pit ${pit})` : ''}` : 'A team';
      this.#bus.emit({
        type: 'announcement.posted',
        source: 'nexus',
        payload: {
          text: `${who} needs ${parts}`,
          postedAt: p.postedTime ?? Date.now(),
          from: 'Nexus parts request',
        },
      });
    }
  }
}
