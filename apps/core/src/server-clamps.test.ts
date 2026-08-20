/**
 * The two integrity clamps on the operator entry points, tested end to end
 * against a real listening server, because both were found as live holes:
 * a desk-PIN socket could fire a fabricated award.presented (a fake winner
 * on the projector, bypassing the Judge Advisor tier), and either emit path
 * could publish a typed score at the field's own confidence tier, which the
 * graphics then drew solid instead of outlined.
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

// The gate deliberately OFF (the documented escape hatch): these tests are
// about what an ALREADY-AUTHORIZED session may do, not about the door.
process.env['REMOTE_PIN'] = '';

const PORT = 18733;

test('a desk session cannot reach the award family or the field\'s confidence tier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-server-'));
  const bus = new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: PORT, host: '127.0.0.1',
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?surface=test`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const frames: { t?: string; reason?: string }[] = [];
    ws.on('message', d => frames.push(JSON.parse(String(d))));

    // 1. The award family is refused BY TYPE. Winners and reveals live behind
    //    the JA code on /api/awards; a socket authenticates with the desk PIN
    //    alone and must not be able to stage a fake reveal.
    ws.send(JSON.stringify({
      t: 'emit',
      init: { type: 'award.presented', payload: { award: 'Fake', winner: 'Nobody', team: 1 } },
    }));
    await new Promise(r => setTimeout(r, 300));
    const denied = frames.find(f => f.t === 'denied');
    assert.ok(denied, 'the socket must answer with a denied frame');
    assert.match(denied!.reason ?? '', /JA code/);
    assert.equal(bus.recent.some(e => e.type === 'award.presented'), false,
      'the fabricated award must never reach the bus');

    // 2. Confidence is clamped to estimated. The desk doctrine: a typed score
    //    renders OUTLINED, never solid, and only the field bridge (which
    //    emits server-side) speaks at authoritative.
    ws.send(JSON.stringify({
      t: 'emit',
      init: {
        type: 'match.score', confidence: 'authoritative',
        payload: { alliance: 'red', kind: 'fuel', amount: 1 },
      },
    }));
    await new Promise(r => setTimeout(r, 300));
    const scored = bus.recent.filter(e => e.type === 'match.score').pop();
    assert.equal(scored?.confidence, 'estimated',
      'a socket-spoofed authoritative score must land as estimated');

    // 3. The Stream Deck route has the same clamp: a mapped button press is
    //    an operator's hand too.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/emit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'match.score' }),
    });
    assert.equal(res.status, 200);
    const posted = bus.recent.filter(e => e.type === 'match.score_posted').pop();
    assert.equal(posted?.confidence, 'estimated',
      'a control-map Post score must not publish at the field\'s tier');

    ws.close();
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
