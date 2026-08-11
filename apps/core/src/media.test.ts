import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaLibrary, readPngHeader } from './media.ts';

/** A team directory with a meta.json, which is what scan() rebuilds from. */
async function libraryWith(entries: { team: number; consent?: string }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-media-'));
  for (const e of entries) {
    const teamDir = join(dir, 'teams', String(e.team));
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, 'meta.json'), JSON.stringify({
      team: e.team, version: 1, w: 1200, h: 800,
      src: `/media/teams/${e.team}/robot.v1.png`,
      uploadedAt: Date.now(), warnings: [],
      ...(e.consent ? { consent: e.consent } : {}),
    }));
  }
  const lib = new MediaLibrary(dir);
  await lib.scan();
  return { lib, dir };
}

test('a photo with no consent recorded still airs', async () => {
  // Deliberate. These are photographs of ROBOTS taken in a public hall by the
  // event that invited them, and treating a missing checkbox as a refusal
  // would empty the alliance overview at every event that never got round to
  // a form.
  const { lib, dir } = await libraryWith([{ team: 846 }, { team: 254, consent: 'unknown' }]);
  try {
    assert.ok(lib.airable[846]);
    assert.ok(lib.airable[254]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a team that declined is absent from what the overlays can see', async () => {
  const { lib, dir } = await libraryWith([
    { team: 846, consent: 'declined' },
    { team: 254, consent: 'granted' },
  ]);
  try {
    assert.equal(lib.airable[846], undefined, 'gone from the airable set');
    assert.ok(lib.airable[254]);
    assert.ok(lib.manifest[846], 'still on disk and still in the full manifest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('declining takes effect immediately and survives a restart', async () => {
  const { lib, dir } = await libraryWith([{ team: 846 }]);
  try {
    await lib.setConsent(846, 'declined');
    assert.equal(lib.airable[846], undefined);

    // A team that asked at the pit desk must stay off after the desk restarts.
    const reopened = new MediaLibrary(dir);
    await reopened.scan();
    assert.equal(reopened.airable[846], undefined);
    assert.equal(reopened.manifest[846]?.consent, 'declined');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a team can be un-declined, which is why the full manifest exists', async () => {
  const { lib, dir } = await libraryWith([{ team: 846, consent: 'declined' }]);
  try {
    await lib.setConsent(846, 'granted');
    assert.ok(lib.airable[846]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setting consent for a team with no photo says so', async () => {
  const { lib, dir } = await libraryWith([]);
  try {
    await assert.rejects(() => lib.setConsent(999, 'declined'),
      /No robot photo has been uploaded for team 999/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the PNG header check still rejects what it always did', () => {
  // Guarding the neighbours: consent work touched this file.
  assert.equal(readPngHeader(Buffer.from('not a png at all, really')), null);
});
