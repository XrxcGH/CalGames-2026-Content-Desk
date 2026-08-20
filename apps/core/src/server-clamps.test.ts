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
import { DEFAULTS } from './config.ts';
import { EventContent } from './content.ts';

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
        type: 'score.delta', confidence: 'authoritative',
        payload: { alliance: 'red', kind: 'fuel', amount: 1 },
      },
    }));
    await new Promise(r => setTimeout(r, 300));
    const scored = bus.recent.filter(e => e.type === 'score.delta').pop();
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

test('a declined team\'s photo is unreachable by every path spelling', async () => {
  // The consent block used to regex the URL's surface form while safeJoin
  // opened the RESOLVED path, and the two disagreed four ways on Windows.
  // The block now derives the team from the same string the filesystem sees.
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'cg-consent-'));
  const teamDir = join(dir, 'media', 'teams', '254');
  await mkdir(teamDir, { recursive: true });
  await writeFile(join(teamDir, 'robot.v1.png'), 'not-really-a-png');
  await writeFile(join(teamDir, 'meta.json'), JSON.stringify({
    team: 254, version: 1, w: 1200, h: 800,
    src: '/media/teams/254/robot.v1.png',
    uploadedAt: 1, warnings: [], consent: 'declined',
  }));
  const media = new MediaLibrary(join(dir, 'media'));
  await media.scan();
  assert.equal(media.manifest[254]?.consent, 'declined', 'fixture sanity');

  const bus = new EventBus();
  const server = startServer({ bus, media, root: dir, port: PORT + 1, host: '127.0.0.1' });
  try {
    const spellings = [
      '/media/teams/254/robot.v1.png',            // the plain path
      '/media/teams/%32%35%34/robot.v1.png',      // percent-encoded digits
      '/media//teams/254/robot.v1.png',           // doubled slash
      '/media/teams%5C254%5Crobot.v1.png',        // backslash separators
      '/media/Teams/254/robot.v1.png',            // case variant
      '/media/teams./254/robot.v1.png',           // Win32 trailing-dot open
      '/media/teams/253/../254/robot.v1.png',     // dot-segment resolution
    ];
    for (const p of spellings) {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}${p}`);
      assert.equal(res.status, 404, `${p} must not serve a declined team's photo`);
    }
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the three codes open three doors, and none opens another\'s', async () => {
  // Desk PIN, awards code, settings code: three people, three secrets. Each
  // session must open exactly its own routes. The defaults ship as desk
  // 0864, JA 1357, settings 4567, all warned about at boot.
  process.env['SETUP_PIN'] = '4567';
  process.env['JA_PIN'] = '1357';
  const dir = await mkdtemp(join(tmpdir(), 'cg-tiers-'));
  const bus = new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: PORT + 2, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), content: new EventContent(dir),
  });
  const base = `http://127.0.0.1:${PORT + 2}`;
  try {
    // The desk session (gate off via REMOTE_PIN='') cannot read settings.
    const deskRead = await fetch(`${base}/api/setup`);
    assert.equal(deskRead.status, 403);
    assert.match(((await deskRead.json()) as { error: string }).error, /settings code/);

    // The settings code unlocks /api/setup...
    const auth = await fetch(`${base}/api/setup/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '4567' }),
    });
    assert.equal(auth.status, 200);
    const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0]!;
    const read = await fetch(`${base}/api/setup`, { headers: { cookie } });
    assert.equal(read.status, 200);

    // ...and nothing else: not the desk's own reads, not awards writes.
    // (REMOTE_PIN is '' here so the desk itself is open; the award POST is
    // the closed door that proves the settings cookie is not a skeleton key.)
    const aw = await fetch(`${base}/api/awards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ action: 'clear' }),
    });
    assert.equal(aw.status, 403);

    // A wrong settings code counts against the lockout and is refused.
    const bad = await fetch(`${base}/api/setup/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(bad.status, 401);
  } finally {
    delete process.env['SETUP_PIN'];
    delete process.env['JA_PIN'];
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
