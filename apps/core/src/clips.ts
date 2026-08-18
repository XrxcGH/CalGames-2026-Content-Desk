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

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { duration, run, type EncoderChoice, type FfmpegTools } from './ffmpeg.ts';

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

export class ClipStore {
  #tools: FfmpegTools;
  #encoder: EncoderChoice;
  #recRoot: string;
  #outDir: string;
  /** file -> {size, seconds}. Probing every segment on every request is slow. */
  #durations = new Map<string, { size: number; seconds: number }>();

  constructor(tools: FfmpegTools, encoder: EncoderChoice, recRoot: string) {
    this.#tools = tools;
    this.#encoder = encoder;
    this.#recRoot = recRoot;
    this.#outDir = join(recRoot, 'clips');
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

  async index(sourceId: string): Promise<Segment[]> {
    this.#checkSourceId(sourceId);
    const dir = join(this.#recRoot, sourceId);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }

    const segments: Segment[] = [];
    for (const name of names.sort()) {
      const startMs = parseSegmentName(name);
      if (startMs === null) continue;
      const file = join(dir, name);

      const s = await stat(file).catch(() => null);
      if (!s || s.size === 0) continue;

      const cached = this.#durations.get(file);
      let seconds: number;
      if (cached && cached.size === s.size) {
        seconds = cached.seconds;
      } else {
        const probed = await duration(this.#tools.ffprobe, file);
        // A segment still being written probes as null. Skip it rather than
        // guessing, and pick it up on the next index.
        if (probed === null) continue;
        seconds = probed;
        this.#durations.set(file, { size: s.size, seconds });
      }
      segments.push({ file, startMs, seconds });
    }
    return segments;
  }

  /** Segments overlapping [fromMs, toMs), in order. */
  async covering(sourceId: string, fromMs: number, toMs: number): Promise<Segment[]> {
    const all = await this.index(sourceId);
    return all.filter(seg => seg.startMs < toMs && seg.startMs + seg.seconds * 1000 > fromMs);
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

    const listFile = `${outFile}.concat.txt`;
    // ffmpeg's concat demuxer needs forward slashes and escaped quotes.
    await writeFile(listFile,
      segs.map(s => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));

    const filters: string[] = [];
    if (speed !== 1) {
      // setpts alone gives choppy slow-mo; minterpolate synthesizes frames.
      // Too slow for live, fine for a 12s clip in the gap between matches.
      filters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
      filters.push('minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1');
    }

    // Output-side -ss/-t measure the timeline AFTER the filter chain runs,
    // where setpts has already stretched it by 1/speed. Seek and duration
    // must stretch the same way, or a slow-mo clip seeks to the wrong
    // footage and comes out at the realtime length.
    const outSeek = offset / speed;
    const outLen = wanted / speed;

    const { code, stderr } = await run(this.#tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      // -ss AFTER -i is the accurate (decode-and-discard) seek. Before -i is
      // faster but keyframe-bound, which lands replays on the wrong moment.
      '-ss', outSeek.toFixed(3),
      '-t', outLen.toFixed(3),
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

  async extract(req: ClipRequest): Promise<Clip> {
    const { sourceId } = req;
    const speed = req.speed ?? 1;
    const ranges = req.ranges.filter(r => r.toMs > r.fromMs);
    if (!ranges.length) throw new Error('At least one range is required');

    await mkdir(this.#outDir, { recursive: true });

    const first = ranges[0]!;
    const label = (req.label ?? `${sourceId}-${first.fromMs}`).replace(/[^\w.-]+/g, '_');
    const stamp = new Date(first.fromMs).toISOString().slice(11, 19).replace(/:/g, '');
    const base = `${label}-${stamp}${speed !== 1 ? `-${String(speed).replace('.', '')}x` : ''}`;
    const outFile = join(this.#outDir, `${base}.mp4`);

    if (ranges.length === 1) {
      await this.#extractRange(sourceId, first, outFile, speed);
    } else {
      // Render each part separately with an accurate seek, then join. All parts
      // share encoder settings, so the join is a stream copy: no re-encode,
      // no generation loss, and the cut lands exactly where we asked.
      const parts: string[] = [];
      for (const [i, range] of ranges.entries()) {
        const part = join(this.#outDir, `${base}.part${i}.mp4`);
        await this.#extractRange(sourceId, range, part, speed);
        parts.push(part);
      }

      const joinList = join(this.#outDir, `${base}.join.txt`);
      await writeFile(joinList,
        parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));

      const { code, stderr } = await run(this.#tools.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', joinList,
        '-c', 'copy', outFile,
      ], 180_000);
      if (code !== 0) throw new Error(`Joining clip parts failed: ${stderr.trim().split('\n').at(-1)}`);
    }

    const wanted = ranges.reduce((n, r) => n + (r.toMs - r.fromMs) / 1000, 0) / speed;
    const seconds = await duration(this.#tools.ffprobe, outFile) ?? wanted;
    return {
      path: outFile,
      url: `/clips/${base}.mp4`,
      sourceId, ranges, seconds, speed,
      label: req.label ?? base,
    };
  }
}
