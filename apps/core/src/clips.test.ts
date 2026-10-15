import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
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
async function recordingTree(t: FfmpegTools): Promise<{ root: string; t0: number }> {
  const root = await mkdtemp(join(tmpdir(), 'cg-clips-'));
  const dir = join(root, 'program');
  await mkdir(dir, { recursive: true });
  const t0 = new Date(2026, 0, 10, 12, 0, 0).getTime();
  for (const [i, name] of ['20260110-120000.mp4', '20260110-120006.mp4'].entries()) {
    assert.equal(parseSegmentName(name), t0 + i * 6000, 'the fixture names must parse');
    const { code, stderr } = await run(t.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=15',
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
