import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ClipStore, parseSegmentName } from './clips.ts';
import { findFfmpeg, run, type FfmpegTools } from './ffmpeg.ts';

// These tests cut real video, because the failure they pin down lives in
// what ffmpeg leaves on disk afterwards. A machine without ffmpeg (a bare CI
// runner) skips them; every desk this project actually runs on has it.
const tools = await findFfmpeg();
const skip = tools ? false : 'ffmpeg is not installed on this machine';

/** libx264 everywhere: hardware encoders vary by machine and tests must not. */
const ENCODER = { encoder: 'libx264', args: ['-preset', 'ultrafast'], reason: 'test' };

/**
 * A recording tree with two consecutive six-second segments for `program`,
 * named the way the recorder names them (local-time strftime), so the index
 * finds and probes them exactly as it would at the venue.
 */
async function recordingTree(
  t: FfmpegTools, size = '192x108', rate = 15,
): Promise<{ root: string; t0: number }> {
  const root = await mkdtemp(join(tmpdir(), 'cg-clips-'));
  const dir = join(root, 'program');
  await mkdir(dir, { recursive: true });
  const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();
  for (const [i, name] of ['20260110-120000.mp4', '20260110-120006.mp4'].entries()) {
    assert.equal(parseSegmentName(name), t0 + i * 6000, 'the fixture names must parse');
    const { code, stderr } = await run(t.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`,
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      join(dir, name),
    ], 60_000);
    assert.equal(code, 0, `test segment encode failed: ${stderr}`);
  }
  return { root, t0 };
}

test('a multi-range cut leaves only the finished clip in rec/clips', { skip }, async () => {
  // A normal match video is a two-part cut (the match, then the score
  // reveal), and extraction used to leave both full re-encoded part files
  // plus three text lists next to the result. rec/clips is a served static
  // mount on the same disk the recorder is filling, so a day of matches
  // stacked hundreds of orphaned intermediates on exactly the disk vitals
  // worries about running out of during playoffs.
  const { root, t0 } = await recordingTree(tools!);
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    const clip = await store.extract({
      sourceId: 'program',
      ranges: [
        { fromMs: t0 + 1000, toMs: t0 + 3000 },
        { fromMs: t0 + 7000, toMs: t0 + 9000 },
      ],
      label: 'Qualification 1',
    });
    assert.ok(clip.seconds > 3 && clip.seconds < 5,
      `the joined clip should run about 4s, got ${clip.seconds}`);

    const left = await readdir(store.outDir);
    assert.deepEqual(left, [basename(clip.path)],
      'no .part*.mp4, .concat.txt, or .join.txt may survive a successful cut');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed cut sweeps the parts it already rendered', { skip }, async () => {
  const { root, t0 } = await recordingTree(tools!);
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    // Part 0 is cuttable; part 1 reaches past everything on disk, so the
    // coverage check refuses it after part 0 has already been rendered.
    await assert.rejects(() => store.extract({
      sourceId: 'program',
      ranges: [
        { fromMs: t0 + 1000, toMs: t0 + 3000 },
        { fromMs: t0 + 9000, toMs: t0 + 30_000 },
      ],
      label: 'Qualification 2',
    }), /short of the requested/);

    // The queue retries the same cut under the same base name, and rec/clips
    // is served, so a failed attempt must leave nothing behind: no orphan
    // part video, no list files.
    assert.deepEqual(await readdir(store.outDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- the index on a full disk ---------------------------------------------
// These run without ffmpeg: the probe is substituted so every call to it is
// counted, and nothing below reaches the point of spawning an encoder.

/** Never spawned; a wrong code path fails on ENOENT instead of passing. */
const NO_FFMPEG: FfmpegTools = { ffmpeg: 'no-ffmpeg-in-this-test', ffprobe: 'no-ffprobe-in-this-test' };

/** `t` the way the recorder's local-time strftime pattern names it. */
function segmentName(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
}

/**
 * Record which files under `dir` get stat'd while `body` runs. clips.ts
 * imports stat by name from node:fs/promises; replacing it on the shared
 * module object and syncing the builtin's ESM exports updates that live
 * binding, so the store is watched exactly as it runs at the venue, with no
 * test-only hook in the production path.
 */
async function watchingStats<T>(
  dir: string, body: () => Promise<T>,
): Promise<{ result: T; statted: string[] }> {
  const fsp = createRequire(import.meta.url)('node:fs/promises') as
    { stat: (p: string) => Promise<Stats> };
  const real = fsp.stat;
  const statted: string[] = [];
  fsp.stat = (p: string) => {
    if (String(p).startsWith(dir)) statted.push(basename(String(p)));
    return real(p);
  };
  syncBuiltinESMExports();
  try {
    return { result: await body(), statted };
  } finally {
    fsp.stat = real;
    syncBuiltinESMExports();
  }
}

/** Empty-ish files named like segments. Their mtime is now, after every name. */
async function fakeSegments(dir: string, starts: number[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const names = starts.map(segmentName);
  for (let i = 0; i < names.length; i += 200) {
    await Promise.all(names.slice(i, i + 200).map(n => writeFile(join(dir, n), 'x')));
  }
  return names;
}

test('a replay late in a long day stats and probes only the segments around it', async () => {
  // Nothing prunes rec/<source>. The index used to stat every segment and
  // ffprobe, one spawn at a time, each it had not cached, so the first replay
  // after a desk restart on Saturday afternoon probed the whole day at a
  // tenth of a second per file: replay, the telestrator frame and the match
  // video cuts all sat there for minutes. Four hours of one camera here.
  const root = await mkdtemp(join(tmpdir(), 'cg-clips-'));
  const dir = join(root, 'program');
  // Last year's Saturday, so files written now carry an mtime after every
  // name, the way a finished segment's does.
  const t0 = new Date(2025, 9, 18, 8, 0, 0).getTime();
  const N = 2400;
  const names = await fakeSegments(dir, Array.from({ length: N }, (_, i) => t0 + i * 6000));
  assert.equal(parseSegmentName(names[1234]!), t0 + 1234 * 6000, 'the fixture names must parse');
  const newest = names.at(-1)!;

  try {
    const probed: string[] = [];
    const store = new ClipStore(NO_FFMPEG, ENCODER, root, {
      probe: async file => {
        probed.push(basename(file));
        return basename(file) === newest ? 4 : 6;
      },
    });

    // A 12s replay starting 1.5s into segment 2000, at 11:20.
    const k = 2000;
    const fromMs = t0 + k * 6000 + 1500;
    const { result: segs, statted } = await watchingStats(dir,
      () => store.covering('program', fromMs, fromMs + 12_000));

    assert.deepEqual(segs.map(s => basename(s.file)), names.slice(k, k + 3));
    assert.deepEqual(segs.map(s => s.startMs), [k, k + 1, k + 2].map(j => t0 + j * 6000));
    assert.deepEqual(segs.map(s => s.seconds), [6, 6, 6]);

    // [fromMs - two periods, toMs): segment k-1 is the earliest starting in it.
    assert.deepEqual(statted.sort(), names.slice(k - 1, k + 3),
      'only the segments whose names fall in the window may be stat\'d');
    assert.deepEqual(probed, [],
      'a segment that another one followed is measured from the names, never probed');

    // The live edge: the newest segment has nothing after it to measure
    // against, so it is the one file that gets probed, and only because the
    // range reaches it.
    const newestMs = t0 + (N - 1) * 6000;
    const live = await store.covering('program', newestMs + 1000, newestMs + 1001);
    assert.deepEqual(live.map(s => [basename(s.file), s.seconds]), [[newest, 4]]);
    assert.deepEqual(probed, [newest]);

    // /api/segments still lists the whole day, and still without probing:
    // the newest file has not changed size, so its earlier probe stands.
    assert.equal((await store.index('program')).length, N);
    assert.deepEqual(probed, [newest]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a segment cut short by an encoder restart is still probed, so its hole is refused', async () => {
  // Measuring a segment by the gap to the next name is only true when the
  // first ran right up to the second. Here the encoder dies 2s into 12:00:06
  // and the restarted one opens 12:00:10. Read from the names, 12:00:06
  // would look like four unbroken seconds and the cut would splice straight
  // over 12:00:08 to 12:00:10 with exit 0. Its file stopped being written at
  // 12:00:08, long before 12:00:10 opened, so it has to be probed.
  const root = await mkdtemp(join(tmpdir(), 'cg-clips-'));
  const dir = join(root, 'program');
  const t0 = new Date(2025, 9, 18, 12, 0, 0).getTime();
  const at = (s: number): number => t0 + s * 1000;
  // 12:00:10 runs to the next clock multiple, then the cadence resumes.
  const names = await fakeSegments(dir, [0, 6, 10, 12, 18].map(at));
  const cut = names[1]!;
  await utimes(join(dir, cut), new Date(at(8)), new Date(at(8)));

  try {
    const probed: string[] = [];
    const store = new ClipStore(NO_FFMPEG, ENCODER, root, {
      probe: async file => {
        probed.push(basename(file));
        return basename(file) === cut ? 2 : null;
      },
    });
    await assert.rejects(() => store.extract({
      sourceId: 'program',
      ranges: [{ fromMs: at(3), toMs: at(15) }],
    }), /has a gap/);
    assert.deepEqual(probed, [cut], 'only the segment that stopped early needs ffprobe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('names an overnight apart are not read as one fourteen-hour segment', async () => {
  // A rec/ directory copied to another disk without its timestamps has every
  // mtime at "just now", which would pass the closed-on-time check for the
  // last segment of Friday too. Read from the names alone, it would run until
  // Saturday morning and a cut past 18:00 would be footage of nothing.
  const root = await mkdtemp(join(tmpdir(), 'cg-clips-'));
  const dir = join(root, 'program');
  const friday = new Date(2025, 9, 17, 17, 59, 54).getTime();
  const saturday = new Date(2025, 9, 18, 8, 0, 0).getTime();
  const names = await fakeSegments(dir, [friday - 6000, friday, saturday, saturday + 6000]);

  try {
    const probed: string[] = [];
    const store = new ClipStore(NO_FFMPEG, ENCODER, root, {
      probe: async file => { probed.push(basename(file)); return 6; },
    });
    await assert.rejects(() => store.extract({
      sourceId: 'program',
      ranges: [{ fromMs: friday + 2000, toMs: friday + 10_000 }],
    }), /short of the/);
    assert.deepEqual(probed, [names[1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- slow motion, and cuts that share a name ------------------------------------

/** What ffprobe says about a clip's video stream, and whether it has audio. */
async function probeClip(t: FfmpegTools, file: string) {
  const { stdout } = await run(t.ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate:format=duration',
    '-of', 'json', file,
  ], 30_000);
  const j = JSON.parse(stdout) as {
    streams: { codec_type: string; r_frame_rate: string }[]; format: { duration: string };
  };
  return {
    seconds: Number(j.format.duration),
    fps: j.streams.find(s => s.codec_type === 'video')?.r_frame_rate,
    audio: j.streams.some(s => s.codec_type === 'audio'),
  };
}

/**
 * How alike the first frame of `clip` is to the frame `at` seconds into
 * `source`, as ffmpeg's SSIM (1 is identical). Both are decoded and lined up
 * on their first frame, so two encodes of the same moment score near 1 and a
 * frame one sixtieth of a second away, on this moving test pattern, does not.
 */
async function firstFrameLikeness(
  t: FfmpegTools, clip: string, source: string, at: number,
): Promise<number> {
  const { code, stderr } = await run(t.ffmpeg, [
    '-hide_banner', '-nostats',
    '-i', clip,
    // Input-side and accurate: decoded up to `at`, so its first frame is the
    // frame at `at`, not the keyframe before it.
    '-ss', at.toFixed(3), '-i', source,
    '-filter_complex',
    '[0:v]trim=end_frame=1,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=1,setpts=PTS-STARTPTS[b];[a][b]ssim',
    '-f', 'null', '-',
  ], 60_000);
  const all = /SSIM .*All:([\d.]+)/.exec(stderr)?.[1];
  assert.ok(code === 0 && all, `ffmpeg could not compare the frames: ${stderr}`);
  return Number(all);
}

test('a quarter-speed replay finishes in seconds, at the right length', { skip }, async () => {
  /*
   * Slow motion used to retime and motion-interpolate everything from the
   * start of the first covering segment, then throw the pre-roll away with
   * an output-side seek. At 1080p that is about five frames a second, so the
   * console's default ten-second window at half speed hit the five-minute
   * kill and never aired. Here, a one-second range 4.5s into a 60fps segment
   * at quarter speed: about thirty seconds the old way on a fast desk, well
   * under one now. The ten-second bound leaves a slow laptop its margin.
   */
  const { root, t0 } = await recordingTree(tools!, '640x360', 60);
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    const began = Date.now();
    const clip = await store.extract({
      sourceId: 'program', ranges: [{ fromMs: t0 + 4500, toMs: t0 + 5500 }],
      label: 'Qualification 3', speed: 0.25,
    });
    const took = Date.now() - began;
    assert.ok(took < 10_000, `a one-second quarter-speed cut took ${took}ms`);

    const p = await probeClip(tools!, clip.path);
    assert.ok(Math.abs(p.seconds - 4) < 0.15, `one second at quarter speed runs four, got ${p.seconds}`);
    assert.equal(p.fps, '60/1', 'smooth, not the source rate stretched');
    assert.equal(p.audio, false, 'slow motion carries no audio');

    // And it starts where it was asked to. The length and the rate above
    // all hold for a cut from the wrong place (a trim from the top of the
    // segment passed every one), and a replay of the wrong moment is the
    // failure the operator cannot see until it is on air.
    const segment = join(root, 'program', '20260110-120000.mp4');
    const atIn = await firstFrameLikeness(tools!, clip.path, segment, 4.5);
    assert.ok(atIn >= 0.97, `the first frame is the in-point's frame (SSIM ${atIn})`);
    // The measure itself can tell half a second apart, or the check above
    // would pass whatever it was given.
    const early = await firstFrameLikeness(tools!, clip.path, segment, 4.0);
    assert.ok(early < 0.95, `and is not the frame half a second earlier (SSIM ${early})`);

    assert.deepEqual(await readdir(store.outDir), [basename(clip.path)], 'and nothing else is left');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two cuts of the same match at the same time both finish, in their own files', { skip }, async () => {
  /*
   * The publish queue's auto cut and the replay console's "Cut full match
   * video" ask for the same label and the same ranges, so they used to share
   * every scratch file and the output: on Windows one died on EBUSY
   * unlinking a list the other ffmpeg still had open, and ffmpeg -y rewrote
   * the clip under the other. A double press of the button does the same.
   */
  const { root, t0 } = await recordingTree(tools!);
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    const req = {
      sourceId: 'program', label: 'Qualification 42',
      ranges: [{ fromMs: t0 + 1000, toMs: t0 + 3000 }, { fromMs: t0 + 7000, toMs: t0 + 9000 }],
    };
    const [a, b] = await Promise.all([store.extract(req), store.extract(req)]);
    assert.notEqual(a.path, b.path, 'never one file for two cuts');
    for (const c of [a, b]) {
      assert.ok(Math.abs((await probeClip(tools!, c.path)).seconds - 4) < 0.3, c.path);
      assert.equal(c.url, `/clips/${basename(c.path)}`);
    }
    assert.deepEqual((await readdir(store.outDir)).sort(),
      [basename(a.path), basename(b.path)].sort(), 'and no scratch file survives either');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a re-cut never rewrites a clip that is still open, and still finishes', { skip }, async () => {
  // The queue streams the clip to YouTube from an open handle; OBS plays a
  // replay from one; the console previews one. ffmpeg -y on the same name
  // truncated it underneath them. The new render goes in under the name
  // only when that is safe, and under the next free one when it is not.
  const { root, t0 } = await recordingTree(tools!);
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    const req = { sourceId: 'program', label: 'Qualification 7', ranges: [{ fromMs: t0 + 1000, toMs: t0 + 3000 }] };
    const first = await store.extract(req);
    const before = await readFile(first.path);
    const held = await open(first.path, 'r');
    try {
      const again = await store.extract({ ...req, ranges: [{ fromMs: t0 + 1000, toMs: t0 + 2000 }] });
      assert.ok(again.seconds > 0.5 && again.seconds < 1.6, 'the re-cut is the new one');
      const { size } = await held.stat();
      const seen = Buffer.alloc(size);
      await held.read(seen, 0, size, 0);
      assert.ok(seen.equals(before), 'the open clip is byte for byte what it was');
      const left = await readdir(store.outDir);
      assert.ok(left.every(f => /^Qualification_7-\d{6}(-\d+)?\.mp4$/.test(f)), `only clips: ${left.join(', ')}`);
    } finally {
      await held.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scratch file that will not delete never fails a finished cut', { skip }, async () => {
  // Windows refuses to unlink a file another process has open. That threw
  // out of the cleanup in the finally block and turned a clip that had
  // rendered perfectly into a failed cut: a lost attempt for the queue, an
  // error on the console.
  const { root, t0 } = await recordingTree(tools!);
  const fsp = createRequire(import.meta.url)('node:fs/promises') as
    { rm: (p: string, o?: unknown) => Promise<void> };
  const real = fsp.rm;
  fsp.rm = async (p: string, o?: unknown) => {
    if (/\.(concat|join)\.txt$/.test(String(p))) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), { code: 'EBUSY' });
    }
    return real(p, o);
  };
  syncBuiltinESMExports();
  try {
    const store = new ClipStore(tools!, ENCODER, root);
    const clip = await store.extract({
      sourceId: 'program', label: 'Qualification 9',
      ranges: [{ fromMs: t0 + 1000, toMs: t0 + 3000 }, { fromMs: t0 + 7000, toMs: t0 + 9000 }],
    });
    assert.ok(clip.seconds > 3, 'the cut is reported finished');
  } finally {
    fsp.rm = real;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
