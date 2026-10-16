/**
 * Segment index + clip extraction.
 *
 * "Give me cam2 from 0:44 to 0:56 of match Q42" becomes: map match clock to
 * wall clock via the event log, find the two or three segments spanning it,
 * concat, trim. Sub-second on NVMe, and it works for any camera because every
 * camera is always recording.
 *
 * The same operation produces replay clips (short, mid-match) and match videos
 * for upload (long, intro through score reveal). Different bounds, one
 * implementation. See docs/04 and docs/11.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { duration, run, type EncoderChoice, type FfmpegTools } from './ffmpeg.ts';

/**
 * Remove scratch files without ever failing the cut that made them.
 *
 * A cleanup error used to reject a cut that had already finished: on Windows
 * an unlink of a list another ffmpeg still had open threw EBUSY out of the
 * finally block, and the publish queue burned an attempt re-cutting a match
 * it already had. A leftover text file is a nuisance; a finished clip
 * reported as failed is a lost upload.
 */
async function sweep(files: string[]): Promise<void> {
  await Promise.all(files.map(f => rm(f, { force: true }).catch(() => undefined)));
}

/** Windows' answers to "replace a file that something still has open". */
const IN_USE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

/** Cuts that may encode at once. See ClipStore.extract. */
export const MAX_CUTS = 2;

export interface Segment {
  file: string;
  /** Wall-clock start, epoch ms, decoded from the strftime filename. */
  startMs: number;
  seconds: number;
}

export interface Range { fromMs: number; toMs: number }

export interface ClipRequest {
  sourceId: string;
  /**
   * One or more ranges, concatenated in order. Multiple ranges exist because a
   * match video is not one continuous pull: the gap between the buzzer and the
   * score being posted is unbounded (referees deliberating fouls and cards
   * routinely run minutes), and nobody wants to watch that. See matchCut().
   */
  ranges: Range[];
  /** Used for the output filename and returned to the caller. */
  label?: string;
  /** 1 = realtime, 0.5 = half speed, 0.25 = quarter. */
  speed?: number;
}

/**
 * How a match video is framed. Defaults are a starting point to tune against
 * the real venue on Friday, since the announcer's cadence and the field's
 * light timing vary.
 */
export const CUT = {
  /**
   * Roll before robots are enabled. `match.start` is the green light; the
   * announcer's "three, two, one, GO" lands just before it, and a match video
   * that opens on the countdown feels like a broadcast rather than a clip.
   */
  preRollMs: 8_000,
  /** After the buzzer: robots coasting, the horn, the first celebration. */
  postMatchMs: 6_000,
  /** A beat before the score screen animates on. */
  revealLeadMs: 2_000,
  /** Long enough for the reveal, RP pips, and ranking movement. */
  revealMs: 15_000,
  /**
   * If the dead time between the two parts is shorter than this, don't bother
   * cutting: a jump cut over four seconds looks like a glitch, not an edit.
   */
  mergeGapMs: 8_000,
} as const;

export interface MatchTimes {
  startedAt: number;
  endedAt: number | null;
  scorePostedAt: number | null;
}

/**
 * Build the ranges for a match video: the match itself, then a jump to the
 * score reveal, skipping however long the referees took.
 */
export function matchCut(t: MatchTimes, cfg = CUT): Range[] {
  const endedAt = t.endedAt ?? t.startedAt + 160_000;   // fall back to nominal length
  const action: Range = {
    fromMs: t.startedAt - cfg.preRollMs,
    toMs: endedAt + cfg.postMatchMs,
  };

  if (t.scorePostedAt === null) return [action];

  const reveal: Range = {
    fromMs: t.scorePostedAt - cfg.revealLeadMs,
    toMs: t.scorePostedAt + cfg.revealMs,
  };

  // Scoring came through fast enough that the join would be invisible anyway,
  // so run it straight through instead of cutting.
  if (reveal.fromMs - action.toMs <= cfg.mergeGapMs) {
    return [{ fromMs: action.fromMs, toMs: reveal.toMs }];
  }
  return [action, reveal];
}

export interface Clip {
  path: string;
  url: string;
  sourceId: string;
  ranges: Range[];
  seconds: number;
  speed: number;
  label: string;
}

/** `20261017-091402.mp4` -> epoch ms, interpreted as local time (strftime is local). */
export function parseSegmentName(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
}

/**
 * How far before the next segment's name a finished segment's file may have
 * last been written and still count as having run up to it. The segment
 * muxer closes one file and opens the next in the same instant, so a normal
 * segment's mtime is within milliseconds of the next name. An encoder that
 * died mid-segment stopped writing at least the restart backoff (a second)
 * plus ffmpeg and camera startup before the next file appeared.
 */
const CLOSE_SLACK_MS = 250;

export interface ClipStoreOptions {
  /**
   * The recorder's segment length (its -segment_time). Bounds how far before
   * a range the index looks for the segment in progress at its start, and
   * how far apart two names can be and still be read as one unbroken
   * segment. Defaults to the recorder's own default of 6.
   */
  segmentSeconds?: number;
  /**
   * Measures one segment when its name cannot say. ffprobe by default; tests
   * substitute it to count exactly which files get probed.
   */
  probe?: (file: string) => Promise<number | null>;
}

export class ClipStore {
  #tools: FfmpegTools;
  #encoder: EncoderChoice;
  #recRoot: string;
  #outDir: string;
  #periodMs: number;
  #probe: (file: string) => Promise<number | null>;
  /** file -> {size, seconds} for segments that had to be probed. */
  #durations = new Map<string, { size: number; seconds: number }>();
  /**
   * Output names a cut in this process is writing right now, lowercased
   * because NTFS does not care about case. The publish queue's auto cut and
   * the replay console's full-match cut of the same match asked for the same
   * name, and a double press of one button does the same: two ffmpeg runs
   * then shared every scratch file and the output. A second cut under a name
   * that is taken gets the next free -2, -3 instead.
   */
  #writing = new Set<string>();
  /** Cuts running now, and the turns of those waiting. See extract(). */
  #cutting = 0;
  #queued: (() => void)[] = [];

  constructor(tools: FfmpegTools, encoder: EncoderChoice, recRoot: string, opts: ClipStoreOptions = {}) {
    this.#tools = tools;
    this.#encoder = encoder;
    this.#recRoot = recRoot;
    this.#outDir = join(recRoot, 'clips');
    // NaN from a mistyped --segment would otherwise empty every window.
    const s = opts.segmentSeconds;
    this.#periodMs = (s && s > 0 ? s : 6) * 1000;
    this.#probe = opts.probe ?? (file => duration(tools.ffprobe, file));
  }

  get outDir(): string { return this.#outDir; }

  /**
   * Source ids get joined into filesystem paths (the segment directory here,
   * the frame filename in frameAt), so anything but a bare id is either a
   * typo or a path traversal attempt. Both stop before any path is built.
   */
  #checkSourceId(sourceId: string): void {
    if (!/^[\w-]+$/.test(sourceId)) {
      throw new Error(`"${sourceId}" is not a recorder source id. ` +
        `Use the id from the recorder config, e.g. "program".`);
    }
  }

  /**
   * The segments on disk for one source, oldest first. With `within`, only
   * the ones that can overlap [fromMs, toMs).
   *
   * Nothing prunes rec/<source>, so by Saturday afternoon each camera has
   * thousands of six-second segments. This used to stat every one of them
   * and ffprobe, serially, each one not already cached, at about a tenth of
   * a second per spawn on Windows: the first replay after a desk restart
   * probed the whole day, and replay, the telestrator frame and match-video
   * cuts all hung for minutes. Filenames carry start times, so the window is
   * picked from names alone and only the few files inside it touch the disk.
   */
  async index(sourceId: string, within?: Range): Promise<Segment[]> {
    this.#checkSourceId(sourceId);
    const dir = join(this.#recRoot, sourceId);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }

    // Pure string work, no I/O: a weekend of names parses in about a
    // millisecond. They sort chronologically because the format is.
    const all: { name: string; startMs: number }[] = [];
    for (const name of names.sort()) {
      const startMs = parseSegmentName(name);
      if (startMs !== null) all.push({ name, startMs });
    }

    let first = 0;
    let end = all.length;
    if (within) {
      // Segments run one period, so one in progress at fromMs began at most
      // a period before it; two periods leave room for whole-second names
      // and a late keyframe stretching a cut.
      const lo = within.fromMs - 2 * this.#periodMs;
      while (first < all.length && all[first]!.startMs < lo) first++;
      // And whatever segment was in progress at fromMs, however far back it
      // started. index.ts does not pass the recorder's --segment here, so a
      // longer one than the default must cost one extra stat, not turn every
      // replay into "the head of this range was never recorded".
      if (first > 0 && (first === all.length || all[first]!.startMs > within.fromMs)) first--;
      end = first;
      while (end < all.length && all[end]!.startMs < within.toMs) end++;
    }

    const picked = all.slice(first, end);
    const stats = await Promise.all(picked.map(e => stat(join(dir, e.name)).catch(() => null)));

    const segments: Segment[] = [];
    for (const [i, { name, startMs }] of picked.entries()) {
      const s = stats[i];
      if (!s || s.size === 0) continue;
      const file = join(dir, name);
      // The next name may lie past the window; only its name is needed.
      const seconds = await this.#seconds(file, s, startMs, all[first + i + 1]?.startMs ?? null);
      // A segment still being written probes as null. Skip it rather than
      // guessing, and pick it up on the next index.
      if (seconds === null) continue;
      segments.push({ file, startMs, seconds });
    }
    return segments;
  }

  /**
   * How long one segment runs, without spawning ffprobe when the names
   * already say.
   *
   * A segment that another one followed, and whose file was last written as
   * that next one opened, ran from its own name to the next one's: the
   * muxer closes one file and opens the next in the same instant. Measuring
   * between names also tiles the timeline exactly, where a probed length
   * against a whole-second name can leave a seam the gap check trips on.
   *
   * Everything else is probed, because it is exactly where an assumption
   * ships a wrong clip: the newest segment, still being written, and one cut
   * short when its encoder died, whose file stopped growing well before the
   * restarted encoder opened the next. Calling that a full segment would
   * splice straight over the hole #extractRange exists to refuse.
   */
  async #seconds(
    file: string, s: Stats, startMs: number, nextStartMs: number | null,
  ): Promise<number | null> {
    const cached = this.#durations.get(file);
    if (cached && cached.size === s.size) return cached.seconds;

    if (nextStartMs !== null) {
      const span = nextStartMs - startMs;
      // The span cap guards a directory copied without its timestamps, where
      // every mtime is "just now" and an overnight gap would pass as footage.
      if (span > 0 && span <= 2 * this.#periodMs && s.mtimeMs >= nextStartMs - CLOSE_SLACK_MS) {
        return span / 1000;
      }
    }

    const probed = await this.#probe(file);
    if (probed === null) return null;
    this.#durations.set(file, { size: s.size, seconds: probed });
    return probed;
  }

  /** Segments overlapping [fromMs, toMs), in order. */
  async covering(sourceId: string, fromMs: number, toMs: number): Promise<Segment[]> {
    const near = await this.index(sourceId, { fromMs, toMs });
    return near.filter(seg => seg.startMs < toMs && seg.startMs + seg.seconds * 1000 > fromMs);
  }

  /** Extract one range from the rolling record into `outFile`. */
  async #extractRange(
    sourceId: string, range: Range, outFile: string, speed: number,
  ): Promise<void> {
    const { fromMs, toMs } = range;
    if (toMs <= fromMs) throw new Error('Clip end must be after its start');

    const segs = await this.covering(sourceId, fromMs, toMs);
    if (!segs.length) {
      throw new Error(`No recorded footage for "${sourceId}" between ` +
        `${new Date(fromMs).toLocaleTimeString()} and ${new Date(toMs).toLocaleTimeString()}. ` +
        `Is the recorder running, and is that window still on disk?`);
    }

    // Overlap is not coverage. A restarted encoder leaves a hole between
    // segments, and the tail of a range may simply not be on disk yet; the
    // concat demuxer splices over either case with exit 0 and ships a clip
    // that is quietly wrong, which is worse than failing. Half a second of
    // slack absorbs normal segment-boundary jitter without hiding a real
    // restart (the supervisor's backoff alone is at least a second).
    const SLACK_MS = 500;
    const when = (ms: number): string => new Date(ms).toLocaleTimeString();
    if (segs[0]!.startMs > fromMs + SLACK_MS) {
      throw new Error(`Recording of "${sourceId}" starts at ${when(segs[0]!.startMs)}, ` +
        `after the requested ${when(fromMs)}. The head of this range was never recorded.`);
    }
    let coveredTo = segs[0]!.startMs;
    for (const seg of segs) {
      if (seg.startMs > coveredTo + SLACK_MS) {
        throw new Error(`Recording of "${sourceId}" has a gap from ${when(coveredTo)} to ` +
          `${when(seg.startMs)} inside the requested range. The encoder likely restarted ` +
          `there; this window cannot be cut cleanly from what is on disk.`);
      }
      coveredTo = Math.max(coveredTo, seg.startMs + seg.seconds * 1000);
    }
    if (coveredTo < toMs - SLACK_MS) {
      throw new Error(`Recording of "${sourceId}" ends at ${when(coveredTo)}, short of the ` +
        `requested ${when(toMs)}. If the recorder is still writing that footage, ` +
        `retrying shortly will pick it up.`);
    }

    // Trim relative to the first covering segment, since the recording almost
    // never starts exactly on the boundary we want.
    const offset = Math.max(0, (fromMs - segs[0]!.startMs) / 1000);
    const wanted = (toMs - fromMs) / 1000;

    // Unique per call because outFile is: extract() names it with a token
    // no other cut shares.
    const listFile = `${outFile}.concat.txt`;
    // ffmpeg's concat demuxer needs forward slashes and escaped quotes.
    await writeFile(listFile,
      segs.map(s => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));

    /*
     * Slow motion trims FIRST, then retimes, then fills in frames cheaply.
     *
     * It used to retime the whole input and motion-interpolate it
     * (minterpolate mi_mode=mci), then throw away the pre-roll with an
     * output-side seek. So every frame from the start of the first covering
     * segment, up to six seconds before the in-point, was synthesized and
     * discarded, at about five interpolated 1080p frames a second: the
     * console's default ten-second window at half speed ran into the five
     * minute kill and never aired. Trimming in the filter graph means only
     * the wanted seconds are ever retimed, and `framerate` blends the gaps
     * at hundreds of frames a second instead of estimating motion. The
     * first frame and the length come out the same.
     */
    const slow = speed !== 1;
    const filters: string[] = slow ? [
      `trim=start=${offset.toFixed(3)}:duration=${wanted.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
      `setpts=${(1 / speed).toFixed(4)}*PTS`,
      'framerate=fps=60',
    ] : [];

    try {
      const { code, stderr } = await run(this.#tools.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        // -ss AFTER -i is the accurate (decode-and-discard) seek. Before -i is
        // faster but keyframe-bound, which lands replays on the wrong moment.
        // Realtime only: slow motion is bounded by its trim above, and an
        // output-side seek there would measure the stretched timeline.
        ...(slow ? [] : ['-ss', offset.toFixed(3), '-t', wanted.toFixed(3)]),
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v', this.#encoder.encoder, ...this.#encoder.args,
        // Audio rides along at realtime: match videos and segments upload with
        // the announcer and the crowd, which is most of why anyone watches them.
        // Slow-mo drops audio instead: setpts stretches only video, so keeping
        // the track would desync it, and a half-speed crowd is noise anyway.
        // A source with no audio stream (test patterns) simply yields no track;
        // -c:a without a forced -map never fails on silent input.
        ...(speed === 1 ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        outFile,
      ], 300_000);

      if (code !== 0) {
        throw new Error(`Clip extraction failed: ${stderr.trim().split('\n').at(-1)}`);
      }
    } finally {
      // The list is scaffolding for one ffmpeg invocation. rec/clips is a
      // served directory on the recorder's own disk, and a text file left
      // beside every cut added up to hundreds of orphans over a weekend, so
      // it goes whether the cut worked or not.
      await sweep([listFile]);
    }
  }

  /**
   * Pull a single frame out of the rolling record as a JPEG.
   *
   * This is what makes the telestrator usable: the analyst draws on the actual
   * frame the audience is looking at, not a blank sheet. Without it they're
   * marking up from memory at a screen across the room, and every circle lands
   * slightly wrong. See docs/04.
   */
  async frameAt(sourceId: string, atMs: number): Promise<{ path: string; url: string }> {
    this.#checkSourceId(sourceId);
    const segs = await this.covering(sourceId, atMs, atMs + 1);
    if (!segs.length) {
      throw new Error(`No footage for "${sourceId}" at ${new Date(atMs).toLocaleTimeString()}.`);
    }
    await mkdir(this.#outDir, { recursive: true });

    const seg = segs[0]!;
    const offset = Math.max(0, (atMs - seg.startMs) / 1000);
    const name = `frame-${sourceId}-${atMs}.jpg`;
    const outFile = join(this.#outDir, name);

    const { code, stderr } = await run(this.#tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', offset.toFixed(3), '-i', seg.file,
      '-frames:v', '1', '-q:v', '2',
      outFile,
    ], 60_000);
    if (code !== 0) throw new Error(`Frame grab failed: ${stderr.trim().split('\n').at(-1)}`);

    return { path: outFile, url: `/clips/${name}` };
  }

  /**
   * Cut a clip. At most MAX_CUTS run at once; the rest wait their turn, in
   * the order they asked.
   *
   * Nothing bounded them before. Every cut is an ffmpeg re-encode on the
   * desk laptop, beside the recorder's encoder for every camera and OBS's
   * stream encoder, and any console holding the PIN can ask: the replay
   * console's held Enter asked thirty times a second, and thirty cuts at
   * once ran thirty-two ffmpeg processes. Two keeps the publish queue's
   * match cut from shutting out the replay console's next clip, and no
   * client can start more than that whatever it sends.
   */
  async extract(req: ClipRequest): Promise<Clip> {
    const ranges = req.ranges.filter(r => r.toMs > r.fromMs);
    if (!ranges.length) throw new Error('At least one range is required');
    if (this.#cutting >= MAX_CUTS) {
      // Handed the slot directly by the cut that finishes; see below.
      await new Promise<void>(go => this.#queued.push(go));
    } else {
      this.#cutting++;
    }
    try {
      return await this.#extract(req, ranges);
    } finally {
      const next = this.#queued.shift();
      if (next) next(); else this.#cutting--;
    }
  }

  async #extract(req: ClipRequest, ranges: Range[]): Promise<Clip> {
    const { sourceId } = req;
    const speed = req.speed ?? 1;

    await mkdir(this.#outDir, { recursive: true });

    const first = ranges[0]!;
    const label = (req.label ?? `${sourceId}-${first.fromMs}`).replace(/[^\w.-]+/g, '_');
    const stamp = new Date(first.fromMs).toISOString().slice(11, 19).replace(/:/g, '');
    const asked = `${label}-${stamp}${speed !== 1 ? `-${String(speed).replace('.', '')}x` : ''}`;

    // Claim a name nobody in this process is writing. See #writing.
    let base = asked;
    for (let n = 2; this.#writing.has(base.toLowerCase()); n++) base = `${asked}-${n}`;
    const claim = base.toLowerCase();
    this.#writing.add(claim);

    // Every file this call writes before the finished clip carries a token
    // no other call shares, and the clip itself is rendered under it too and
    // only moved to its name once it is whole. ffmpeg -y on the real name
    // could truncate a clip the publish queue was halfway through uploading.
    const work = join(this.#outDir, `${base}.${process.pid}-${randomBytes(4).toString('hex')}`);
    const render = `${work}.mp4`;
    let settled: { file: string; name: string };
    try {
      if (ranges.length === 1) {
        await this.#extractRange(sourceId, first, render, speed);
      } else {
        // Render each part separately with an accurate seek, then join. All parts
        // share encoder settings, so the join is a stream copy: no re-encode,
        // no generation loss, and the cut lands exactly where we asked.
        const parts: string[] = [];
        const joinList = `${work}.join.txt`;
        try {
          for (const [i, range] of ranges.entries()) {
            const part = `${work}.part${i}.mp4`;
            // Listed before it is cut, so a part ffmpeg died halfway through
            // writing is swept with the rest.
            parts.push(part);
            await this.#extractRange(sourceId, range, part, speed);
          }

          await writeFile(joinList,
            parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));

          const { code, stderr } = await run(this.#tools.ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'concat', '-safe', '0', '-i', joinList,
            '-c', 'copy', render,
          ], 180_000);
          if (code !== 0) throw new Error(`Joining clip parts failed: ${stderr.trim().split('\n').at(-1)}`);
        } finally {
          // The parts and the join list exist only to feed the join. Each part
          // is a full re-encoded video and a normal match cut makes two of
          // them, so leaving them behind parked two extra copies of every
          // auto-queued match in a served directory on the disk vitals is
          // already watching for recording headroom. Swept on failure too: the
          // queue retries the same cut, and only the finished clip should ever
          // remain in rec/clips.
          await sweep([joinList, ...parts]);
        }
      }
      settled = await this.#settle(render, base);
    } catch (err) {
      await sweep([render]);
      throw err;
    } finally {
      this.#writing.delete(claim);
    }

    const wanted = ranges.reduce((n, r) => n + (r.toMs - r.fromMs) / 1000, 0) / speed;
    const seconds = await duration(this.#tools.ffprobe, settled.file) ?? wanted;
    return {
      path: settled.file,
      url: `/clips/${settled.name}`,
      sourceId, ranges, seconds, speed,
      label: req.label ?? base,
    };
  }

  /**
   * Move a finished render to its name, and never over a clip in use.
   *
   * A re-cut under the same name replaces the old clip, which is what the
   * queue's retries want. But Windows refuses to replace a file something
   * still has open (the queue uploading it, OBS playing it, a console
   * previewing it), and the old -y truncated it in place instead. A refused
   * replace takes the next free -2, -3 rather than failing a cut that
   * finished, and leaves the clip in use exactly as it was.
   */
  async #settle(render: string, base: string): Promise<{ file: string; name: string }> {
    let last: unknown = null;
    for (let n = 1; n <= 20; n++) {
      const stem = n === 1 ? base : `${base}-${n}`;
      // Another cut in flight has claimed this one; it is not ours to take.
      if (n > 1 && this.#writing.has(stem.toLowerCase())) continue;
      const name = `${stem}.mp4`;
      const file = join(this.#outDir, name);
      try {
        await rename(render, file);
        return { file, name };
      } catch (err) {
        if (!IN_USE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        last = err;
      }
    }
    throw new Error(`Every name for this clip is in use: ${(last as Error | null)?.message ?? 'unknown'}`);
  }
}
