/**
 * The coverage ledger: every match the event played, and what happened to it.
 *
 * The failure this exists to prevent is the one nobody notices until weeks
 * later, when a team asks for their quarterfinal and it is not there. Every
 * piece of the pipeline reports success individually: the recorder was
 * running, the queue says uploaded, the channel has videos. What nothing
 * answers is the only question that matters, which is whether the set of
 * matches that were PLAYED and the set of videos that EXIST are the same set.
 *
 * So this keeps one row per match, built from the event's own bus, and joins
 * it against the publish queue. It is deliberately not part of the queue: the
 * queue knows about the items it was told to make, and the entire point here
 * is to notice the ones it never was.
 *
 * Everything is derived from events the desk already emits, so the ledger
 * rebuilds itself exactly by replaying a log, which is also how it gets tested.
 */

import type { EventBus } from './bus.ts';
import type { PublishQueue } from './publish/queue.ts';
import { identify } from './publish/naming.ts';
import type { DeskEvent } from './types.ts';

/** What we know happened to one match. */
export interface CoverageRow {
  /** The match's display name, which is the only id every source shares. */
  name: string;
  /** TBA-style key when we have one, for the link back. */
  matchKey: string | null;
  /** Wall clock of the buzzer, and of the score finally being posted. */
  playedAt: number | null;
  scorePostedAt: number | null;
  /** Teams, so a per-team view can be built without a second source. */
  red: number[];
  blue: number[];
  /** Final score, once posted. */
  score: { red: number; blue: number } | null;
  /** The publish item covering this match, if one was ever created. */
  publish: {
    id: string;
    state: string;
    videoId: string | null;
    error: string | null;
  } | null;
}

export type CoverageProblem =
  | 'never-queued'      // it was played and nothing was ever cut for it
  | 'not-uploaded'      // queued, but it has not reached the channel
  | 'failed'            // the queue gave up on it
  | 'no-score';         // played, but no score was ever posted

export interface CoverageGap {
  name: string;
  problem: CoverageProblem;
  /** What to actually do about it, in the words the desk would use. */
  detail: string;
}

export interface CoverageReport {
  /** Matches that reached the buzzer. The denominator for everything else. */
  played: number;
  scored: number;
  queued: number;
  uploaded: number;
  gaps: CoverageGap[];
  rows: CoverageRow[];
  updatedAt: number;
}

/** Uploaded-or-better, in the queue's vocabulary. */
const DONE = new Set(['uploaded', 'done']);

export class CoverageLedger {
  #rows = new Map<string, CoverageRow>();
  #publish: PublishQueue | null;
  #unsubscribe: (() => void) | null = null;

  constructor(publish: PublishQueue | null = null) {
    this.#publish = publish;
  }

  attach(bus: EventBus): () => void {
    this.#unsubscribe = bus.subscribe(ev => this.observe(ev));
    return () => this.detach();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** Exposed so a replayed log rebuilds the ledger without a bus. */
  observe(ev: DeskEvent): void {
    switch (ev.type) {
      case 'match.loaded': {
        const p = ev.payload as {
          id?: string; displayName?: string;
          red?: { number?: number }[]; blue?: { number?: number }[];
        };
        const name = (p.displayName ?? '').trim();
        if (!name) return;
        const row = this.#row(name);
        row.matchKey = p.id ?? row.matchKey;
        const nums = (side?: { number?: number }[]): number[] =>
          (side ?? []).map(t => Number(t?.number)).filter(n => Number.isInteger(n) && n > 0);
        // Only overwrite when the payload actually carries a roster: a
        // re-load with an empty list must not erase who played.
        if (nums(p.red).length) row.red = nums(p.red);
        if (nums(p.blue).length) row.blue = nums(p.blue);
        this.#lastLoaded = name;
        return;
      }

      case 'match.end': {
        // The buzzer is what makes a match "played". Not match.start: an
        // aborted match never reaches here and should not count as missing
        // video, which is exactly the false alarm that would make this
        // report ignorable.
        const name = this.#currentName(ev);
        if (name) this.#row(name).playedAt = ev.ts;
        return;
      }

      case 'match.score_posted': {
        const name = this.#currentName(ev);
        if (!name) return;
        const row = this.#row(name);
        row.scorePostedAt = ev.ts;
        // `score` is what the field actually sends (Cheesy's ScorePosted
        // carries RedScoreSummary.Score). This read `total` only, which no
        // live emitter has ever produced, so the score column on the report
        // and on the audience-facing team page was permanently null, while
        // the tests passed on fabricated `{red:{total}}` payloads.
        const p = ev.payload as Record<string, { total?: unknown; score?: unknown } | undefined>;
        const num = (side: string): number | null => {
          const v = p[side]?.score ?? p[side]?.total;
          return typeof v === 'number' && Number.isFinite(v) ? v : null;
        };
        const red = num('red'), blue = num('blue');
        if (red !== null && blue !== null) row.score = { red, blue };
        return;
      }

      default:
        return;
    }
  }

  /**
   * The match these events belong to.
   *
   * match.end and match.score_posted do not carry the match, so it is whatever
   * was loaded last. That has to be tracked explicitly rather than searched
   * for: an earlier version took the first row with no playedAt, which looks
   * equivalent and is not. A match that was loaded and then abandoned (a
   * schedule change, an aborted match, a demo left running) sits unplayed
   * forever at the front of the map and silently collects every later match's
   * result, so the ledger reports the wrong match as played and the right one
   * as missing. Found by running it against a desk that had a stale match
   * loaded, which is the normal state of a desk.
   */
  #lastLoaded: string | null = null;

  #currentName(ev: DeskEvent): string | null {
    const p = ev.payload as { displayName?: string } | undefined;
    if (p?.displayName) return p.displayName.trim();
    return this.#lastLoaded;
  }

  #row(name: string): CoverageRow {
    let row = this.#rows.get(name);
    if (!row) {
      row = {
        name, matchKey: null, playedAt: null, scorePostedAt: null,
        red: [], blue: [], score: null, publish: null,
      };
      this.#rows.set(name, row);
    }
    return row;
  }

  /**
   * Join the ledger against the publish queue and report.
   *
   * Matching is by label, because that is the only string both sides share:
   * the queue's items are labelled with the match's display name when they are
   * created. A rename mid-event would break the join, which is a reason not to
   * rename matches mid-event.
   */
  report(): CoverageReport {
    const items = this.#publish?.items ?? [];
    // Both sides of the join go through identify(), because the queue labels
    // its items with identify(displayName).name and the rows here are keyed on
    // the raw name the field sent. Those agree for quals and DISAGREE for
    // every playoff match: Cheesy's LongName for a playoff is a bare "Match 7"
    // with the round in a separate field, and identify turns that into
    // "Match 7 (R2)". So on Sunday every played match reported never-queued,
    // the report warned about missing videos that were uploading fine, and the
    // per-team page showed no links. That is noise at exactly the moment the
    // report is supposed to be worth reading.
    const byLabel = new Map<string, typeof items[number]>();
    for (const item of items) {
      if (item.kind !== 'match') continue;
      byLabel.set(identify(item.label).name, item);
    }

    const rows: CoverageRow[] = [];
    const gaps: CoverageGap[] = [];
    let played = 0, scored = 0, queued = 0, uploaded = 0;

    for (const row of [...this.#rows.values()].sort((a, b) =>
      (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity))) {
      const item = byLabel.get(identify(row.name).name);
      const joined: CoverageRow = {
        ...row,
        publish: item
          ? { id: item.id, state: item.state, videoId: item.videoId, error: item.error }
          : null,
      };
      rows.push(joined);

      if (row.playedAt === null) continue;   // loaded but not played: not yet news
      played++;
      if (row.scorePostedAt !== null) scored++;
      if (item) queued++;
      if (item && DONE.has(item.state) && item.videoId) uploaded++;

      if (row.scorePostedAt === null) {
        gaps.push({
          name: row.name, problem: 'no-score',
          detail: 'Played, but no score was ever posted. The video will cut, but ' +
            'nothing links it on TBA.',
        });
      }
      if (!item) {
        gaps.push({
          name: row.name, problem: 'never-queued',
          detail: 'Played, and nothing was ever queued for it. Queue it by hand ' +
            'from the desk before the recording rolls off.',
        });
      } else if (item.state === 'failed') {
        gaps.push({
          name: row.name, problem: 'failed',
          detail: `The queue gave up: ${item.error ?? 'no reason recorded'}. Retry it.`,
        });
      } else if (!DONE.has(item.state) || !item.videoId) {
        gaps.push({
          name: row.name, problem: 'not-uploaded',
          detail: `Queued and sitting at "${item.state}". It has not reached the channel yet.`,
        });
      }
    }

    return { played, scored, queued, uploaded, gaps, rows, updatedAt: Date.now() };
  }

  /**
   * Everything one team played, with the link if there is one.
   *
   * This is the single most-asked-for thing after an event and the reason the
   * ledger carries rosters at all: "where is my team's video" should be one
   * page, not an email to whoever ran the stream.
   */
  forTeam(team: number): CoverageRow[] {
    return this.report().rows.filter(r => r.red.includes(team) || r.blue.includes(team));
  }
}
