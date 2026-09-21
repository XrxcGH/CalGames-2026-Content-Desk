/**
 * Minimal FRC Nexus client. GET-only.
 *
 * Nexus (frc.nexus) is what the queuers at the event are actually typing into,
 * which makes it the only source that knows a match is being called BEFORE the
 * field knows. Cheesy Arena can tell us a match was loaded; Nexus can tell us
 * six teams were asked to start walking four minutes earlier, which is the
 * difference between "on deck" being a graphic and being useful.
 *
 * This talks to frc.nexus over the internet, not to the field network, so none
 * of the field-bridge safety machinery applies. It is GET-only anyway, because
 * this project does not write to other people's event systems.
 *
 * Nexus asks that anything using their data links back to frc.nexus. The
 * surfaces that show queue data carry that credit.
 */

export const NEXUS_BASE = 'https://frc.nexus/api/v1';

export interface NexusClientOpts {
  apiKey: string;
  eventKey: string;
  base?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * The four values Nexus's `Match.status` can take. This is the WHOLE enum:
 * there is no terminal state, so a played match keeps "On field" for the rest
 * of the event. See pendingMatches() in adapter.ts for what that means.
 */
export type NexusMatchStatus = 'Queuing soon' | 'Now queuing' | 'On deck' | 'On field';

/** One scheduled match as Nexus sees it. Every field is optional on the wire. */
export interface NexusMatch {
  /** "Practice 1", "Qualification 24", "Qualification 24 Replay", "Playoff 8", "Final 1". */
  label?: string;
  /**
   * Typed rather than free text, because the reason this file used to say
   * "free text" is that somebody assumed a "Completed" that does not exist.
   * Widened to string so an enum Nexus adds later still parses.
   */
  status?: NexusMatchStatus | string | null;
  redTeams?: (string | null)[];
  blueTeams?: (string | null)[];
  /**
   * The break that begins after this match. Lunch, alliance selection and
   * awards are the three things the whole building plans its day around, and
   * this is a queuer's own answer for when they are.
   */
  breakAfter?: 'Break' | 'Lunch' | 'End of day' | 'Alliance selection' | 'Awards break'
    | string | null;
  /** The label of the match this one replays, or null. */
  replayOf?: string | null;
  times?: {
    scheduledStartTime?: number | null;
    estimatedQueueTime?: number | null;
    estimatedOnDeckTime?: number | null;
    estimatedOnFieldTime?: number | null;
    estimatedStartTime?: number | null;
    actualQueueTime?: number | null;
    actualOnDeckTime?: number | null;
    actualOnFieldTime?: number | null;
    /** AutoQueue events only; null everywhere else. */
    actualStartTime?: number | null;
    /** AutoQueue events only. The one true "this match is over" signal. */
    actualCommitTime?: number | null;
  };
}

export interface NexusAnnouncement {
  id?: string;
  announcement?: string;
  postedTime?: number;
}

/**
 * A team asking the room for a part. At an offseason this is some of the most
 * useful content a pit monitor can carry: it is the kind of thing that
 * actually gets a robot back on the field.
 */
export interface NexusPartsRequest {
  id?: string;
  parts?: string;
  requestedByTeam?: string;
  postedTime?: number;
}

export interface NexusEventStatus {
  eventKey?: string;
  /** Nexus recomputes on every request; the newest wins. */
  dataAsOfTime?: number;
  nowQueuing?: string | null;
  matches?: NexusMatch[];
  announcements?: NexusAnnouncement[];
  partsRequests?: NexusPartsRequest[];
}

/** Team number -> pit address. */
export type NexusPitAddresses = Record<string, string>;

/** Team number -> inspection state. Cached by Nexus; a couple of minutes old. */
export type NexusInspection = Record<string, {
  inspected?: boolean;
  status?: 'hold' | 'in-progress' | 'complete' | 'reinspection' | 'queued' | 'not-started' | null;
  queuePosition?: number | null;
}>;

export class NexusClient {
  #key: string;
  #event: string;
  #base: string;
  #fetch: typeof fetch;
  #lastRequestAt = 0;

  constructor(opts: NexusClientOpts) {
    this.#key = opts.apiKey;
    this.#event = opts.eventKey;
    this.#base = opts.base ?? NEXUS_BASE;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  get eventKey(): string { return this.#event; }

  async #get<T>(path: string): Promise<T> {
    // Nexus does not publish a rate limit. A one-second floor costs nothing at
    // a 20s poll and stops a polling bug from turning into a ban mid-event.
    const since = Date.now() - this.#lastRequestAt;
    if (since < 1000) await new Promise(r => setTimeout(r, 1000 - since));
    this.#lastRequestAt = Date.now();

    const res = await this.#fetch(`${this.#base}${path}`, {
      method: 'GET',
      headers: { 'Nexus-Api-Key': this.#key },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 401) {
      throw new Error('Nexus got no API key (401). Set nexus.apiKey in config.json ' +
        'from frc.nexus/api, or clear nexus.eventKey to turn the feed off.');
    }
    if (res.status === 403) {
      throw new Error('Nexus refused the API key (403). Check it at frc.nexus/api, ' +
        'and that it has not been disabled.');
    }
    if (res.status === 404) {
      throw new Error(`Nexus has no event "${this.#event}". Check the event key, ` +
        'and that the event is registered on Nexus.');
    }
    if (!res.ok) throw new Error(`Nexus HTTP ${res.status}`);
    return await res.json() as T;
  }

  /**
   * Live queue status. Only meaningful for events actually using Nexus to
   * manage queuing: for anything else Nexus returns the schedule with no
   * useful timing, which is worse than nothing because it looks authoritative.
   */
  status(): Promise<NexusEventStatus> {
    return this.#get<NexusEventStatus>(`/event/${encodeURIComponent(this.#event)}`);
  }

  /**
   * Team number -> pit address. Static for the weekend; fetched once.
   *
   * A BARE object, `{"100":"A1","200":"C12"}`. This used to be typed as
   * `{ pits?: ... }`, so the first caller to read `.pits` would have got
   * undefined and quietly shown no addresses at all.
   */
  pits(): Promise<NexusPitAddresses> {
    return this.#get(`/event/${encodeURIComponent(this.#event)}/pits`);
  }

  /**
   * Team number -> inspection state, including the live queue position.
   *
   * Nexus caches this, so it can be a couple of minutes out of date, and it
   * is not set at all for demo events. Slow-poll it.
   */
  inspection(): Promise<NexusInspection> {
    return this.#get(`/event/${encodeURIComponent(this.#event)}/inspection`);
  }

  /**
   * Playoff alliances, in pick order: [[captain, first, second], ...].
   *
   * Live during selection, so it arrives partial, with missing alliances and
   * null members while picking is still going on. That is the point: it is
   * the graphic the audience display wants during the most content-starved
   * twenty minutes of the day.
   */
  alliances(): Promise<(string | null)[][]> {
    return this.#get(`/event/${encodeURIComponent(this.#event)}/alliances`);
  }
}
