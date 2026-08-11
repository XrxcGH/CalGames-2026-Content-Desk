import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { countCues, findSidecar, languageOf } from './captions.ts';

const SRT = `1
00:00:01,000 --> 00:00:04,200
Welcome back to CalGames.

2
00:00:04,400 --> 00:00:07,000
Red alliance: 846, 254, 1678.
`;

/** A captions folder with the given files in it. */
async function folder(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-cap-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

test('counts cues in both timestamp dialects', () => {
  assert.equal(countCues(SRT), 2);
  // VTT uses a dot for the decimal and may omit the hour.
  assert.equal(countCues('WEBVTT\n\n00:01.000 --> 00:04.200\nHello\n'), 1);
  // SBV separates with a comma instead of an arrow.
  assert.equal(countCues('0:00:01.000,0:00:04.200\nHello\n'), 1);
  assert.equal(countCues('WEBVTT\n\nNOTE nothing but a header\n'), 0);
});

test('reads a language tag off the filename, and only a real one', () => {
  assert.equal(languageOf('2026cagg_qm12.es.srt'), 'es');
  assert.equal(languageOf('2026cagg_qm12.pt-BR.vtt'), 'pt-BR');
  assert.equal(languageOf('2026cagg_qm12.srt'), 'en');
  // Not a language: uploading this as language "final" would 400 at YouTube
  // and read as the caption feature being broken.
  assert.equal(languageOf('2026cagg_qm12.final.srt'), 'en');
});

test('finds the file for a match key, tolerating case and punctuation', async () => {
  const dir = await folder({ '2026CAGG_QM12.srt': SRT });
  try {
    const found = await findSidecar(dir, ['2026cagg_qm12', 'Qualification 12']);
    assert.equal(basename(found!.path), '2026CAGG_QM12.srt');
    assert.equal(found!.language, 'en');
    assert.equal(found!.cues, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a near-miss key claims nothing', async () => {
  // The reason substring matching is not used: qm1's captions on qm12 is an
  // error nobody catches until somebody who needs them hits play.
  const dir = await folder({ 'qm1.srt': SRT });
  try {
    assert.equal(await findSidecar(dir, ['qm12']), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an empty caption file is refused, not uploaded', async () => {
  // An empty track shows in the player as captions being AVAILABLE, which is
  // a worse lie than their absence.
  const dir = await folder({ 'qm12.srt': 'WEBVTT\n\n' });
  try {
    assert.equal(await findSidecar(dir, ['qm12']), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keys are tried in order, so the match key beats the label', async () => {
  const dir = await folder({ 'qm12.srt': SRT, 'Qualification 12.srt': SRT });
  try {
    const found = await findSidecar(dir, ['qm12', 'Qualification 12']);
    assert.equal(basename(found!.path), 'qm12.srt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no captions folder is the normal case, not an error', async () => {
  assert.equal(await findSidecar(join(tmpdir(), 'cg-cap-does-not-exist'), ['qm12']), null);
});

test('a file the API cannot take is ignored', async () => {
  const dir = await folder({ 'qm12.txt': SRT, 'qm12.docx': SRT });
  try {
    assert.equal(await findSidecar(dir, ['qm12']), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
