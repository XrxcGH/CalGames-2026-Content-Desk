import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaLibrary, readPngHeader } from './media.ts';

/** A team directory with a meta.json, which is what scan() rebuilds from. */
async function libraryWith(
  entries: { team: number; consent?: string; w?: number; h?: number }[],
) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-media-'));
  for (const e of entries) {
    const teamDir = join(dir, 'teams', String(e.team));
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, 'meta.json'), JSON.stringify({
      team: e.team, version: 1, w: e.w ?? 1200, h: e.h ?? 800,
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

test('a declined team is off the airable set, and that is what the server checks', () => {
  // The consent gap that survived the first pass: `airable` kept declined
  // photos off every overlay, but the FILE stayed served at
  // /media/teams/<team>/robot.v1.png (an open prefix, and a URL anyone can
  // guess from a team number). The server now consults the manifest before
  // serving anything under /media/teams/, so this is the shape it relies on.
  return (async () => {
    const { lib, dir } = await libraryWith([{ team: 846, consent: 'declined' }]);
    try {
      assert.equal(lib.manifest[846]?.consent, 'declined',
        'the server reads consent off the manifest, not off airable');
      assert.equal(lib.airable[846], undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
});

test('a cutout too small to render is not put on air', async () => {
  /*
   * ingest() warns below 900px on the long edge, and that warning is advice
   * to whoever is uploading: it changed nothing about what went on screen.
   * The only airing gate was consent, so a 200x150 test image sat in a real
   * manifest for a month with consent "unknown" and would have gone on the
   * alliance overview for a team that is actually attending, rendered about
   * 700px tall, which is a smear of pixels with a team number under it.
   *
   * The tier-3 fallback, a gold number on a chamfered plinth, is a designed
   * state that most teams at an offseason event get anyway. Showing it beats
   * showing a blur.
   */
  const { lib, dir } = await libraryWith([
    { team: 1678, w: 139, h: 109 },          // the real thing that was found
    { team: 254, w: 2400, h: 1600 },         // a proper cutout
    { team: 971, w: 320, h: 240 },           // exactly at the floor
    { team: 846, w: 319, h: 240 },           // one pixel under it
  ]);
  try {
    const air = lib.airable;
    assert.equal(air[254] !== undefined, true, 'a real cutout airs');
    assert.equal(air[971] !== undefined, true, 'the floor itself airs');
    assert.equal(air[1678], undefined, 'a 139px blob does not');
    assert.equal(air[846], undefined, 'and neither does one pixel under the floor');

    // Still in the FULL manifest, because the team media page has to be able
    // to show the operator what is there and why it is not airing.
    assert.equal(lib.manifest[1678] !== undefined, true,
      'the record survives; only its airing does not');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
