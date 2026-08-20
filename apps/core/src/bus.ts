/**
 * The event bus: append-only log + snapshot + fan-out.
 *
 * The log is the point. Record Friday's practice matches to NDJSON, then
 * `npm run replay -- data/events/friday.ndjson 4` and every graphic can be
 * built and tested on a laptop in March with no field. Volunteer-run systems
 * live or die on whether people can practice without hardware.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { phaseAt, PHASE_ORDER } from './clock.ts';
import { reduce, tick } from './state.ts';
import {
  eventId, initialState, EVENT_SCHEMA_VERSION,
  type Confidence, type DeskEvent, type DeskEventType, type DeskState, type Source,
} from './types.ts';

export type Subscriber = (ev: DeskEvent, state: DeskState) => void;

export interface EmitInit<T = unknown> {
  type: DeskEventType;
  payload?: T;
  source?: Source;
  confidence?: Confidence;
  ts?: number;
}

export class EventBus {
  #state: DeskState = initialState();
  #subscribers = new Set<Subscriber>();
  #log: WriteStream | null = null;
  /** Recent history, for late-joining surfaces and the replay timeline. */
  #ring: DeskEvent[] = [];
  #ringMax = 5000;
  /**
   * Per-process event counter. Lets a client that reconnected ask "what did I
   * miss after N" and get a complete answer out of the ring above, rather than
   * guessing from timestamps.
   */
  #seq = 0;
  #lastPhase = phaseAt(null);
  /**
   * While a replay runs, the 10Hz ticker must tick on the REPLAY's time axis,
   * not the wall clock. Replayed events are restamped by a constant offset,
   * but pacing (speed, the 5s gap cap) makes the two axes diverge: left on
   * Date.now(), advance() crosses phase boundaries on the wall axis while the
   * replayed events cross them on theirs, double-firing every boundary and
   * flip-flopping bus.state between the two. Null outside a replay.
   */
  #replayClock: { logicalTs: number; wallTs: number; speed: number } | null = null;

  get state(): DeskState { return this.#state; }
  get recent(): readonly DeskEvent[] { return this.#ring; }

  /** Where the current (or just-finished) match began. Survives the buzzer. */
  get lastMatchStartedAt(): number | null { return this.#state.lastMatchStartedAt; }

  async openLog(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    this.#log = createWriteStream(path, { flags: 'a' });
    // A write failure mid-show (disk full, media ejected) raises the stream's
    // 'error' event, and an unhandled one kills the whole process. Losing the
    // log is survivable; losing the overlay is not.
    this.#log.on('error', err => {
      console.error('[bus] event log write failed, logging disabled:', err.message);
      this.#log = null;
    });
  }

  /**
   * Flush and close the event log. A WriteStream buffers its tail in memory,
   * and exiting without end() drops the session's last events: exactly the
   * ones a post-mortem replay would want. Resolves once the tail is on disk
   * (or immediately if logging was never enabled).
   */
  closeLog(): Promise<void> {
    const log = this.#log;
    this.#log = null;
    if (!log) return Promise.resolve();
    return new Promise(res => log.end(() => res()));
  }

  emit<T>(init: EmitInit<T>): DeskEvent<T> {
    const ts = init.ts ?? Date.now();
    const ev: DeskEvent<T> = {
      id: eventId(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      seq: ++this.#seq,
      ts,
      matchClock: this.#state.matchClock,
      source: init.source ?? 'manual',
      confidence: init.confidence ?? 'authoritative',
      type: init.type,
      payload: (init.payload ?? {}) as T,
    };

    this.#state = reduce(this.#state, ev);
    // The Cheesy adapter emits match.end straight from the field's own
    // notifier, outside of advance()'s tick. If we didn't sync #lastPhase
    // here too, the next 10Hz tick would find the clock-derived phase
    // already at 'post' but #lastPhase still stuck on 'endgame', read that
    // as a fresh transition, and fire a second, duplicate match.end (and
    // the same for match.auto_end/match.endgame/match.shift_change) a
    // moment after the real one, double-firing every subscriber downstream
    // (scene cuts, replay markers). This only closes the race when the
    // authoritative event lands before the ticker's own estimate does; see
    // the review notes for the remaining direction. match.teleop_start is in
    // the list because re-anchoring can pull the clock back across a boundary
    // the ticker already crossed, which would otherwise read as a fresh
    // transition and re-fire it.
    if (ev.type === 'match.auto_end' || ev.type === 'match.endgame'
      || ev.type === 'match.end' || ev.type === 'match.shift_change'
      || ev.type === 'match.teleop_start') {
      this.#lastPhase = this.#state.phase;
    }
    this.#record(ev);
    return ev;
  }

  /**
   * "Now" on whichever time axis is currently authoritative: the wall clock
   * normally, the replay's logical clock while a replay runs. Between replayed
   * events the logical clock advances continuously at the replay speed, so
   * phase boundaries that fall between two logged events still fire on time.
   */
  #now(): number {
    const rc = this.#replayClock;
    if (!rc) return Date.now();
    return rc.logicalTs + (Date.now() - rc.wallTs) * rc.speed;
  }

  /**
   * Phase boundaries have to fire even when nothing else is happening.
   * Endgame lockdown and the auto-end marker are both time-driven, not
   * event-driven. Called at 10Hz by the server.
   */
  advance(now = this.#now()): void {
    const before = this.#state;
    const after = tick(before, now);
    if (after.phase === this.#lastPhase) { this.#state = after; return; }

    this.#state = after;
    const from = this.#lastPhase;
    this.#lastPhase = after.phase;

    /*
     * EVERY boundary crossed, not only the newest.
     *
     * This used to emit one event for the phase it landed in, which is right
     * at 10Hz and wrong whenever the clock jumps. It does jump: replay caps
     * long gaps deliberately (see replay()), and a stalled event loop does the
     * same live. Skipping match.auto_end means the reducer's auto-winner
     * heuristic never runs, so the hub indicator shows "both" for all four
     * shifts of a rehearsal where the live run alternated: a replay
     * reconstructing different state than the run it is replaying, which is
     * the one property the whole log format exists to provide.
     */
    const start = PHASE_ORDER.indexOf(from);
    const end = PHASE_ORDER.indexOf(after.phase);
    // Backwards means a new match loaded and the clock reset. Nothing to
    // replay through: the boundaries ahead will fire as they arrive.
    const crossed = end > start ? PHASE_ORDER.slice(start + 1, end + 1) : [after.phase];

    for (const phase of crossed) {
      // Source 'clock', never 'cue': the cue engine drops cue-sourced events
      // to break feedback loops, so stamping these 'cue' made every
      // clock-driven boundary invisible to cues. The endgame trigger was dead
      // code and the buzzer hold could not fire at all in desk-only or demo
      // operation.
      if (phase === 'transition') this.emit({ type: 'match.auto_end', source: 'clock', ts: now });
      else if (phase === 'endgame') this.emit({ type: 'match.endgame', source: 'clock', ts: now });
      else if (phase === 'post') this.emit({ type: 'match.end', source: 'clock', ts: now });
      else if (phase.startsWith('shift')) {
        this.emit({ type: 'match.shift_change', payload: { phase }, source: 'clock', ts: now });
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #record(ev: DeskEvent): void {
    this.#ring.push(ev);
    if (this.#ring.length > this.#ringMax) this.#ring.shift();
    this.#log?.write(JSON.stringify(ev) + '\n');
    for (const fn of this.#subscribers) {
      try { fn(ev, this.#state); }
      catch (err) { console.error('[bus] subscriber threw:', err); }
    }
  }

  /**
   * Fold one logged event into the state snapshot, and do nothing else: no
   * log write, no subscribers, no sequence. This exists for the boot-time
   * rebuild, where the overlay-facing halves of the snapshot (the card
   * marks) have to come back after a restart, but nothing may reach air and
   * nothing may re-enter the log. Use it for anything else and cues fire.
   */
  restore(ev: DeskEvent): void {
    this.#state = reduce(this.#state, ev);
  }

  /** Replay a recorded log. speed=0 replays as fast as possible. */
  async replay(path: string, speed = 1): Promise<void> {
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    console.log(`[bus] replaying ${lines.length} events from ${path} at ` +
      (speed ? `${speed}x` : 'max speed'));
    let prev: number | null = null;
    let offset: number | null = null;

    try {
    for (const line of lines) {
      let ev: DeskEvent;
      try { ev = JSON.parse(line) as DeskEvent; }
      catch {
        // A truncated last line (e.g. the process was killed mid-write) is
        // normal; anything else silently dropping here would make replay
        // quietly skip real events with nothing in the console to explain it.
        console.error('[bus] skipping unparseable log line:', line.slice(0, 200));
        continue;
      }

      // attachMarkers and attachPace stay attached during replay and re-derive
      // from the primary events, so re-emitting the logged copies doubled
      // every automatic marker and mixed the recording's stale pace numbers
      // with fresh ones. Manual markers are primary: nothing regenerates
      // them, so they must replay. Clock-sourced phase boundaries
      // (match.auto_end/endgame/shift_change/end) are derived the same way:
      // advance() regenerates them from the replayed clock state, so replaying
      // the logged copies double-fired every boundary: duplicate timeline
      // markers and double-fired cues in the exact rehearsals replay exists
      // for.
      if (ev.type === 'pace.updated') continue;
      if (ev.type === 'replay.marker' && ev.source !== 'manual') continue;
      if (ev.source === 'clock') continue;

      if (speed > 0 && prev !== null) {
        const wait = (ev.ts - prev) / speed;
        if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      }
      prev = ev.ts;

      // Re-stamp by a constant offset so the clock runs live rather than in
      // 2026-10-17. The offset preserves the recording's own spacing: the
      // reducer attributes score deltas by ev.ts, so re-stamping each event
      // to its delivery time pushed auto scores into teleop at any pacing
      // other than exact 1x.
      offset ??= Date.now() - ev.ts;
      const logicalTs = ev.ts + offset;
      // Hand the ticker the replay's time axis (see #replayClock). speed=0
      // (max speed) pins the logical clock to the event stream itself.
      this.#replayClock = { logicalTs, wallTs: Date.now(), speed: speed > 0 ? speed : 1 };
      this.emit({
        type: ev.type, payload: ev.payload, source: ev.source,
        confidence: ev.confidence, ts: logicalTs,
      });
      // At max speed the loop never yields, so the 10Hz ticker that
      // regenerates clock-derived boundaries (auto_end, endgame,
      // shift_change; match.end in desk-only logs) never runs until the
      // replay is over and the axis is gone. Since those events were
      // filtered above ON THE PROMISE that advance() re-fires them, the
      // promise has to be kept inline: advance on the replay axis after
      // every event. At real-time speeds the ticker interleaves anyway and
      // this is a cheap no-op between boundaries.
      if (speed === 0) this.advance(logicalTs);
    }
    } finally {
      // Always hand time back to the wall clock, even if the replay threw
      // mid-stream: a ticker stranded on a dead replay axis would misphase
      // every live match that follows.
      this.#replayClock = null;
    }
    console.log('[bus] replay complete');
  }
}

/**
 * Wall-clock stamp for log names, in LOCAL time.
 *
 * Deliberately not toISOString(). At a Pacific venue UTC midnight is 5pm
 * local, so a UTC stamp filed the evening's log under tomorrow's date: a
 * restart after 5pm rebuilt every ledger from zero files, and the next
 * morning replayed the previous evening into a fresh day. That is exactly
 * the cross-day bleed rebuild.ts exists to prevent.
 *
 * rebuildFromLog derives its day filter from this same function, so the
 * name and the filter cannot drift apart again. Zero-padded because
 * rebuildFromLog sorts the names lexicographically to replay in order.
 */
export function localStamp(d: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * `tag` marks a session whose events must never feed the boot-time rebuild:
 * a --demo tech check or a --replay rehearsal appends to a log too, and an
 * untagged one landed in the day's real history, where the next boot
 * resurrected rehearsal cards, phantom coverage rows and inflated sponsor
 * counts into the live ledgers. isFromDay() refuses tagged names.
 */
export const logPathFor = (dir: string, d = new Date(), tag?: string): string =>
  join(dir, `${localStamp(d)}${tag ? `.${tag}` : ''}.ndjson`);
