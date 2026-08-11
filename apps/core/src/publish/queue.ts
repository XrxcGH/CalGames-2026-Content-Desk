/**
 * Durable publish queue: cut -> upload -> link on TBA.
 *
 * Deliberately boring. A JSON file, a state machine, exponential backoff, and
 * `GET /api/publish` reporting what's stuck (there is no desk-console panel
 * over it yet — see docs/11). It has to survive a crash, the venue internet
 * dropping, and the event ending. Nobody should have to SSH into anything on
 * a Sunday.
 *
 * See docs/11-distribution.md.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.ts';
import type { EventBus } from '../bus.ts';
import { matchCut, type ClipStore, type Range } from '../clips.ts';
import { TbaClient } from './tba.ts';
import { description, identify, isPractice, segmentDescription, segmentName, videoTitle } from './naming.ts';
import { YouTubeClient, watchUrl, type VideoMeta } from './youtube.ts';
import { findSidecar } from './captions.ts';

// There is no 'analysis' kind: the docs once promised automatic detection of
// telestrator sessions, but no detector was ever built, so the kind was
// unreachable dead weight. Analysis clips go up through the segment flow.
export type ItemKind = 'match' | 'segment';

export type ItemState =
  | 'pending'    // queued, nothing done
  | 'cut'        // clip exists on disk
  | 'uploaded'   // on YouTube, not yet linked
  | 'done'
  | 'failed'
  | 'held';      // deferred mode, waiting for the go-ahead

export interface QueueItem {
  id: string;
  kind: ItemKind;
  label: string;
  sourceId: string;
  ranges: Range[];
  /** TBA match key, when this is a match video. */
  matchKey: string | null;
  meta: { title: string; description: string };
  state: ItemState;
  /**
   * The operator's go-ahead. Without a durable flag, the cut branch re-parked
   * every deferred-mode item the moment release() woke it, so the end-of-day
   * upload could never actually happen.
   */
  released: boolean;
  clipPath: string | null;
  videoId: string | null;
  /** Set once a caption sidecar has been attached, so a resume never doubles it. */
  captionId: string | null;
  sessionUrl: string | null;
  attempts: number;
  error: string | null;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_ATTEMPTS = 6;

/**
 * Plausible durations, per kind of video.
 *
 * FIRST's own auto-uploader has shipped 11-second "match videos" and whole
 * wrong matches, which is what this guards against. The bounds have to differ
 * by kind: 15 minutes is far too long for a match and far too short for an
 * awards ceremony, and one set of numbers would either wave through a broken
 * match cut or hold every ceremony.
 */
export const QC_BOUNDS: Record<ItemKind, { minSec: number; maxSec: number }> = {
  match: { minSec: 60, maxSec: 900 },
  segment: { minSec: 30, maxSec: 7200 },
};

/** The hold reason, or null when the cut looks like what it claims to be. */
export function qcHold(kind: ItemKind, cutSeconds: number): string | null {
  const { minSec, maxSec } = QC_BOUNDS[kind];
  const seconds = Math.round(cutSeconds);
  if (seconds < minSec || seconds > maxSec) {
    return `QC hold: cut totals ${seconds}s, outside ${minSec}-${maxSec}s for a ${kind}. `
      + 'Check the clip, then release.';
  }
  return null;
}

export class PublishQueue {
  #file: string;
  #captions: string;
  #items: QueueItem[] = [];
  #cfg: Config;
  #bus: EventBus;
  #clips: ClipStore | null;
  #yt: YouTubeClient;
  #tba: TbaClient;
  #running = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(root: string, cfg: Config, bus: EventBus, clips: ClipStore | null) {
    this.#file = join(root, 'data', 'publish-queue.json');
    this.#captions = join(root, 'data', 'captions');
    this.#cfg = cfg;
    this.#bus = bus;
    this.#clips = clips;
    this.#yt = new YouTubeClient(cfg.youtube);
    this.#tba = new TbaClient(cfg.tba, cfg.event.key);
  }

  get items(): readonly QueueItem[] { return this.#items; }
  get ready(): { youtube: boolean; tba: boolean } {
    return { youtube: this.#yt.configured, tba: this.#tba.configured };
  }

  /**
   * Register the stream on TBA GameDay. The list REPLACES what TBA has, so
   * the caller sends every webcast the event should show. Exposed here
   * rather than handing out the TbaClient: the queue owns all TBA writes.
   */
  registerWebcasts(urls: string[]): Promise<unknown> {
    if (!this.#tba.configured) return Promise.resolve(null);
    return this.#tba.setWebcasts(urls);
  }

  /**
   * Retitle the active YouTube live broadcast ("2026 CalGames - Day 2").
   * Exposed here for the same reason as registerWebcasts: the queue owns the
   * one authenticated YouTube client. Null when no broadcast is live.
   */
  setLiveTitle(title: string): Promise<{ id: string; title: string } | null> {
    return this.#yt.setLiveBroadcastTitle(title);
  }

  async load(): Promise<void> {
    try {
      this.#items = JSON.parse(await readFile(this.#file, 'utf8')) as QueueItem[];
      // Queue files written before these fields existed lack them.
      for (const item of this.#items) { item.released ??= false; item.captionId ??= null; }
      // Crash recovery is restore AND resume: without this kick, a machine
      // that died mid-upload restarted with every item faithfully restored in
      // 'cut'/'uploaded' and then did nothing — a second Release finds no
      // 'held' items and returns 0, so the overnight batch silently never
      // finished. If the restored file holds runnable work, start the worker.
      if (this.#next()) this.kick();
      const unfinished = this.#items.filter(i => i.state !== 'done').length;
      if (this.#items.length) {
        console.log(`[publish] restored ${this.#items.length} item(s), ${unfinished} unfinished`);
      }
    } catch { this.#items = []; }
  }

  /** Atomic write: a torn queue file on a power cut would be worse than none. */
  async #save(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#items, null, 2));
    await rename(tmp, this.#file);
  }

  async add(init: Omit<QueueItem, 'id' | 'state' | 'released' | 'clipPath' | 'videoId'
    | 'captionId' | 'sessionUrl' | 'attempts' | 'error' | 'progress' | 'createdAt' | 'updatedAt'>,
    hold: string | null = null): Promise<QueueItem> {
    const item: QueueItem = {
      ...init,
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      // In deferred mode items are cut but parked. The live stream must never
      // compete with an upload for the venue uplink.
      // A QC-flagged item enters the queue already held: pushing it pending
      // and holding a moment later left a window where a running worker
      // picked it up and later overwrote the hold with 'cut'.
      state: hold ? 'held' : 'pending',
      released: false,
      clipPath: null, videoId: null, captionId: null, sessionUrl: null,
      attempts: 0, error: hold, progress: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.#items.push(item);
    await this.#save();
    if (hold) console.warn(`[publish] ${item.label} held for QC`);
    else this.kick();
    return item;
  }

  /** Queue the current or just-finished match, framed for broadcast. */
  async queueMatch(opts: { manual?: boolean } = {}): Promise<QueueItem | null> {
    const st = this.#bus.state;
    const startedAt = st.lastMatchStartedAt;
    if (!startedAt) return null;

    const displayName = st.match?.displayName ?? 'Match';
    // Practice matches publish like anything else; only the AUTOMATIC path is
    // gated, because Friday load-in runs dozens of them and an event may not
    // want each one on the channel. An operator pressing the button knows
    // what they asked for, so a manual queue always goes through.
    if (isPractice(displayName) && !opts.manual && !this.#cfg.publish.autoQueuePractice) {
      return null;
    }

    // Official FIRST-channel naming: "Qualification 42 - CalGames".
    const { name, key } = identify(displayName);
    const title = videoTitle(name, this.#cfg.event.name, this.#cfg.event.year);

    if (this.#items.some(i => i.kind === 'match' && i.label === name && i.state !== 'failed')) {
      return null;                                   // already queued
    }

    const ranges = matchCut({
      startedAt, endedAt: st.matchEndedAt, scorePostedAt: st.scorePostedAt,
    });

    const teams = (side: 'red' | 'blue'): number[] =>
      (st.match?.[side] ?? []).map(t => t.number);

    // A cut whose duration is implausible goes up HELD, not published. The
    // operator eyeballs it and releases, reusing the deferred-mode go-ahead.
    const hold = qcHold('match', ranges.reduce((s, r) => s + (r.toMs - r.fromMs) / 1000, 0));

    return this.add({
      kind: 'match',
      label: name,
      sourceId: this.#cfg.publish.sourceId,
      ranges,
      matchKey: key,
      meta: {
        title,
        description: description({
          title,
          red: { teams: teams('red'), score: st.score.red.total },
          blue: { teams: teams('blue'), score: st.score.blue.total },
          resultsUrl: this.#cfg.event.resultsUrl,
          credit: this.#cfg.publish.credit,
          copyright: this.#cfg.publish.copyright,
        }),
      },
    }, hold);
  }

  /**
   * Queue one of the parts of the day that is not a match: alliance selection,
   * an awards ceremony, a single award. The operator marks the start and the
   * end, because nothing on the bus knows when a ceremony began.
   *
   * These carry no TBA match key, so the queue links them to the event as
   * media rather than to a match, which is the same path the analysis desk
   * clips already take.
   */
  async queueSegment(opts: {
    /** A `SEGMENTS` id, or any literal title such as an award name. */
    segment: string;
    fromMs: number;
    toMs: number;
    note?: string;
    sourceId?: string;
  }): Promise<QueueItem> {
    if (!(opts.toMs > opts.fromMs)) {
      throw new Error('The segment ends before it starts.');
    }

    const name = segmentName(opts.segment);
    const title = videoTitle(name, this.#cfg.event.name, this.#cfg.event.year);
    const ranges: Range[] = [{ fromMs: opts.fromMs, toMs: opts.toMs }];
    const hold = qcHold('segment', (opts.toMs - opts.fromMs) / 1000);

    return this.add({
      kind: 'segment',
      label: name,
      sourceId: opts.sourceId ?? this.#cfg.publish.sourceId,
      ranges,
      matchKey: null,
      meta: {
        title,
        description: segmentDescription({
          title,
          note: opts.note,
          resultsUrl: this.#cfg.event.resultsUrl,
          credit: this.#cfg.publish.credit,
          copyright: this.#cfg.publish.copyright,
        }),
      },
    }, hold);
  }

  async #hold(item: QueueItem, reason: string): Promise<void> {
    item.state = 'held';
    item.error = reason;
    item.updatedAt = Date.now();
    await this.#save();
    console.warn(`[publish] ${item.label} held for QC`);
  }

  /** Nudge the worker. Safe to call from anywhere, any number of times. */
  kick(): void {
    if (this.#running || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#work(); }, 250);
  }

  /**
   * Release everything parked by DEFERRED MODE: "the venue is closed, go".
   *
   * QC-held items are deliberately NOT swept up. A QC hold means the cut's
   * duration is implausible and a human must eyeball the clip; the routine
   * end-of-day release is exactly the moment nobody is reviewing anything, so
   * publishing them here would upload the one category of video the hold
   * exists to stop. Each QC item is released individually via retry(id) once
   * someone has actually looked at it.
   */
  async release(): Promise<number> {
    let n = 0;
    let qcSkipped = 0;
    for (const item of this.#items) {
      if (item.state !== 'held') continue;
      if (item.error?.startsWith('QC hold')) { qcSkipped++; continue; }
      // The durable flag is what lets the cut branch proceed in deferred
      // mode; changing only the state sent the item straight back to held.
      item.released = true;
      item.state = item.clipPath ? 'cut' : 'pending';
      // An operator go-ahead earns a fresh retry budget, same as retry().
      item.attempts = 0;
      item.error = null;
      item.updatedAt = Date.now();
      n++;
    }
    if (qcSkipped) {
      console.warn(`[publish] release left ${qcSkipped} QC-held item(s) parked — ` +
        'review each clip and use its Retry to publish it.');
    }
    if (n) { await this.#save(); this.kick(); }
    return n;
  }

  async retry(id: string): Promise<void> {
    const item = this.#items.find(i => i.id === id);
    if (!item) return;
    // Retrying a held item is the per-item go-ahead — it is how a QC-held cut
    // gets published after someone has eyeballed it, so it carries the same
    // durable released flag the bulk release sets. Without it, deferred mode
    // would re-park the item the moment the worker looked at it.
    if (item.state === 'held') item.released = true;
    item.state = item.videoId ? 'uploaded' : item.clipPath ? 'cut' : 'pending';
    item.attempts = 0;
    item.error = null;
    await this.#save();
    this.kick();
  }

  #next(): QueueItem | undefined {
    return this.#items.find(i =>
      (i.state === 'pending' || i.state === 'cut' || i.state === 'uploaded')
      && i.attempts < MAX_ATTEMPTS);
  }

  async #work(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const item = this.#next();
        if (!item) break;
        const advanced = await this.#step(item);
        await this.#save();
        if (!advanced) break;                        // backoff or blocked
      }
    } finally {
      this.#running = false;
    }
  }

  /** Returns true if it made progress and the loop should continue. */
  async #step(item: QueueItem): Promise<boolean> {
    const fail = (err: unknown): boolean => {
      item.attempts++;
      item.error = (err as Error).message;
      item.updatedAt = Date.now();
      if (item.attempts >= MAX_ATTEMPTS) item.state = 'failed';
      console.warn(`[publish] ${item.label}: ${item.error}`);
      // Back off before the next sweep rather than hammering.
      this.#timer = setTimeout(() => { this.#timer = null; void this.#work(); },
        Math.min(120_000, 2 ** item.attempts * 1000));
      return false;
    };

    try {
      if (item.state === 'pending') {
        if (!this.#clips) throw new Error('Recording is unavailable, so nothing can be cut.');
        const clip = await this.#clips.extract({
          sourceId: item.sourceId, ranges: item.ranges, label: item.label,
        });
        item.clipPath = clip.path;
        item.updatedAt = Date.now();
        this.#bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: { ...clip, kind: item.kind } });
        // Queue-time QC only saw the requested ranges. The probed duration of
        // the real file is the truth: a recorder with only part of the match
        // on disk cuts short, and that must hold here rather than upload.
        const hold = qcHold(item.kind, clip.seconds);
        if (hold) { await this.#hold(item, hold); return true; }
        item.state = 'cut';
        item.error = null;
        // A fresh retry budget per stage: an auto-queued match routinely
        // burns cut attempts waiting for the score reveal to land on disk,
        // and that must not starve the upload of retries.
        item.attempts = 0;
        return true;
      }

      if (item.state === 'cut') {
        // The master switch outranks everything, including a release.
        if (!this.#cfg.publish.enabled) { item.state = 'held'; return true; }
        if (this.#cfg.publish.mode === 'deferred' && !item.released) { item.state = 'held'; return true; }
        if (this.#cfg.publish.mode === 'trickle' && this.#bus.state.matchStartedAt !== null) {
          // Trickle's promise is that an upload never starts against a live
          // match. Stay 'cut', block the loop, and look again shortly.
          if (!this.#timer) {
            this.#timer = setTimeout(() => { this.#timer = null; void this.#work(); }, 15_000);
          }
          return false;
        }
        if (!this.#yt.configured) throw new Error('YouTube credentials are not configured.');

        const meta: VideoMeta = {
          title: item.meta.title,
          description: item.meta.description,
          privacyStatus: this.#cfg.publish.privacy,
          tags: ['FRC', 'FIRST Robotics', this.#cfg.event.name],
        };
        item.videoId = await this.#yt.upload(item.clipPath!, meta, {
          sessionUrl: item.sessionUrl ?? undefined,
          // Persist the session now, not at the end of the step: it is only
          // useful to a process that crashed mid-upload, and that process
          // never reaches the save after this step. Without it a restart
          // re-uploaded from byte zero, and a session that had quietly
          // finished became a duplicate video on the channel.
          onSession: url => { item.sessionUrl = url; void this.#save(); },
          onProgress: (sent, total) => { item.progress = total ? sent / total : 0; },
        });
        item.progress = 1;
        item.state = 'uploaded';
        item.error = null;
        item.attempts = 0;
        item.updatedAt = Date.now();

        // Captions, if somebody produced a file for this one. Wrapped, and
        // deliberately so: a caption track is worth having and is never worth
        // failing a video over. The likeliest failure here is a 403 because
        // the desk was consented for uploads only (captions.insert needs
        // force-ssl), and that must read as a line in the log, not as a match
        // video stuck in the queue.
        try {
          // Not if one is already attached: a crash between the upload and
          // the save re-enters this branch, the resumable session hands back
          // the SAME video id, and a second insert would put two identical
          // tracks in the player's caption menu.
          const sidecar = item.captionId ? null
            : await findSidecar(this.#captions, [item.matchKey ?? '', item.label]);
          if (sidecar) {
            item.captionId = await this.#yt.uploadCaption(item.videoId, sidecar.path,
              { language: sidecar.language });
            console.log(`[publish] ${item.label}: ${sidecar.cues} captions attached`);
          }
        } catch (err) {
          console.warn(`[publish] ${item.label}: captions not attached (${(err as Error).message})`);
        }
        // A crash between here and the playlist insert must restart as
        // 'uploaded' with this video id, not re-upload a duplicate.
        await this.#save();

        const playlist = this.#cfg.publish.playlists[item.kind];
        if (playlist) await this.#yt.addToPlaylist(item.videoId, playlist);
        return true;
      }

      if (item.state === 'uploaded') {
        if (this.#tba.configured) {
          if (item.kind === 'match') {
            if (item.matchKey) {
              await this.#tba.addMatchVideo(item.matchKey, item.videoId!);
            } else {
              // A keyless match is a practice match: TBA has no keys for
              // practice, and linking one as event media would misfile a
              // scrimmage alongside the ceremonies. Skip TBA entirely.
              console.log(`[publish] ${item.label} has no TBA match key (practice), ` +
                'skipping the TBA link');
            }
          } else {
            await this.#tba.addEventMedia(item.videoId!);
          }
        }
        // Publish only after linking succeeds, so a failed link never leaves
        // an orphan video with no context.
        if (this.#cfg.publish.publicAfterLink && this.#cfg.publish.privacy !== 'public') {
          await this.#yt.setPrivacy(item.videoId!, 'public');
        }
        item.state = 'done';
        item.error = null;
        item.updatedAt = Date.now();
        console.log(`[publish] ${item.label} -> ${watchUrl(item.videoId!)}`);
        return true;
      }
    } catch (err) {
      return fail(err);
    }
    return false;
  }
}
