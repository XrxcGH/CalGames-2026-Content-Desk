/**
 * Every change to the robot-photo map reaches screens that are already open.
 *
 * Surfaces learn the media map only from a snapshot frame, and no event
 * carries it. The OBS Browser Source is set never to reload, so a change the
 * server does not push is a change the stream never shows: an upload made on
 * Saturday morning stayed on the gold-number plinth, and the sample's drawn
 * robot stayed on air for a real team after the sample was cleared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { EventBus } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { DEFAULTS } from './config.ts';
import { clearSampleState, seedSampleState } from './demo.ts';

// The gate off (the documented escape hatch): this is about what reaches an
// open overlay, which never holds a credential anyway.
process.env['REMOTE_PIN'] = '';

type Frame = { t?: string; media?: Record<string, { src: string }> };

/** An opaque block on a transparent ground: a cut-out robot as uploaded. */
async function cutoutPng(w = 1000, h = 800): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = Math.floor(h * 0.2); y < h; y++) {
    for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x++) {
      const i = (y * w + x) * 4;
      raw[i] = 150; raw[i + 1] = 150; raw[i + 2] = 160; raw[i + 3] = 255;
    }
  }
  const sharp = (await import('sharp')).default;
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

test('seed, clear and upload each push the new photo map to an open overlay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-push-'));
  const bus = new EventBus();
  const media = new MediaLibrary(join(dir, 'media'));
  await media.scan();
  const server = startServer({
    bus, media, root: dir, port: 0, host: '127.0.0.1', config: structuredClone(DEFAULTS),
    seedSample: () => seedSampleState(bus, { media }),
    clearSample: () => clearSampleState(bus, { media }),
  });
  const port = await server.listening;
  const overlay = new WebSocket(`ws://127.0.0.1:${port}/ws?surface=program`);
  const frames: Frame[] = [];
  overlay.on('message', d => frames.push(JSON.parse(String(d)) as Frame));
  /** The latest snapshot, once one satisfying `ok` arrives after `from`. */
  const snapshotAfter = async (from: number, ok: (m: Frame['media']) => boolean): Promise<boolean> => {
    for (let i = 0; i < 120; i++) {
      if (frames.slice(from).some(f => f.t === 'snapshot' && ok(f.media))) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const post = (path: string, body: string | Uint8Array = '{}', type = 'application/json') =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    }).then(async r => { await r.arrayBuffer(); return r.status; });

  try {
    await new Promise((res, rej) => { overlay.on('open', res); overlay.on('error', rej); });
    assert.ok(await snapshotAfter(0, () => true), 'the connect-time snapshot');

    let mark = frames.length;
    assert.equal(await post('/api/sample'), 200);
    assert.ok(await snapshotAfter(mark, m => !!m?.['846']?.src.startsWith('/sample/')),
      'the sample photos reach the overlay that was already open');

    mark = frames.length;
    assert.equal(await post('/api/sample/clear'), 200);
    assert.ok(await snapshotAfter(mark, m => !m?.['846']),
      'and the clear takes the drawn robot back off it');

    mark = frames.length;
    assert.equal(await post('/api/media/254', new Uint8Array(await cutoutPng()), 'image/png'), 200);
    assert.ok(await snapshotAfter(mark, m => !!m?.['254']?.src.startsWith('/media/teams/254/')),
      'a photo uploaded after OBS is up reaches the overlay without a reload');
  } finally {
    overlay.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
