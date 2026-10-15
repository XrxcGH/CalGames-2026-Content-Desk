/**
 * The replay console's full-match cut never shares the publish queue's files.
 *
 * Both cut the same match from the same ranges, and clips.ts names every
 * scratch file and the output from the label plus the start time. Under the
 * same label the two ffmpeg runs shared the concat list, the parts and the
 * .mp4: one cut failed on a locked file (EBUSY on Windows), and ffmpeg -y
 * could rewrite the very file the queue was uploading.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { DEFAULTS } from './config.ts';
import { identify } from './publish/naming.ts';

process.env['REMOTE_PIN'] = '';

test('the console cut is labelled apart from the match name the queue uses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-cutlabel-'));
  const bus = new EventBus();
  const labels: string[] = [];
  // Only the one method the route calls: what matters is the label it asks for.
  const clips = {
    extract: async (req: { label?: string }) => {
      labels.push(req.label ?? '');
      return { url: '/clips/x.mp4', label: req.label ?? '', file: 'x.mp4' };
    },
  };
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), clips: clips as never,
  });
  const port = await server.listening;
  try {
    bus.emit({ type: 'match.loaded', source: 'cheesy',
      payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] } } as never);
    bus.emit({ type: 'match.start', source: 'cheesy' } as never);

    const res = await fetch(`http://127.0.0.1:${port}/api/clips/match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(labels.length, 1);
    const queueLabel = identify('Qualification 42')?.name;
    assert.ok(queueLabel, 'the queue names this match');
    assert.notEqual(labels[0], queueLabel, 'never the label the publish queue cuts under');
    assert.match(labels[0]!, /Qualification 42/, 'still says which match it is');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
