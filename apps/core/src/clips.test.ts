import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
