/**
 * What a console and the day's records keep across a weekend of restarts and
 * long sign-ins, against a real listening server.
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
import type { DeskEvent } from './types.ts';

/** Set env vars for one test and put them back, whatever the test does. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await run(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function boot(opts: { chapterSeed?: DeskEvent[]; bus?: EventBus } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-restart-'));
  const bus = opts.bus ?? new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), chapterSeed: opts.chapterSeed ?? null,
  });
  const port = await server.listening;
  return {
    bus, port, base: `http://127.0.0.1:${port}`,
    done: async () => { server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a desk sign-in lasts the whole event weekend, and stays HttpOnly and SameSite', async () => {
  // It was 16 hours: a tablet signed in for Friday's 6 PM practice lost its
  // session at 10 AM Saturday, as qualifications started, while its socket
  // kept reading "linked" and every gated read quietly failed.
  await withEnv({ REMOTE_PIN: '4826' }, async () => {
    const d = await boot();
    try {
      const res = await fetch(`${d.base}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '4826' }),
      });
      assert.equal(res.status, 200);
      const set = res.headers.get('set-cookie') ?? '';
      const maxAge = Number(/Max-Age=(\d+)/.exec(set)?.[1]);
      // Thursday load-in to Sunday teardown is a little under four days.
      assert.ok(maxAge >= 4 * 24 * 3600, `Max-Age=${maxAge} does not cover the weekend`);
      assert.match(set, /HttpOnly/);
      assert.match(set, /SameSite=Lax/);
    } finally {
      await d.done();
    }
  });
});

test('a socket hears the server clock before its first snapshot', async () => {
  // A surface that has never heard a beat takes its clock skew from the
  // snapshot's updatedAt, the last EVENT's time. After a restart that can be
  // a state restored from this morning's log, so a venue screen loaded in the
  // first ten seconds counted down against a clock hours out.
  await withEnv({ REMOTE_PIN: '' }, async () => {
    const d = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?surface=side`);
    const frames: { t?: string; now?: number }[] = [];
    ws.on('message', m => frames.push(JSON.parse(String(m))));
    try {
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      for (let i = 0; i < 80 && !frames.some(f => f.t === 'snapshot'); i++) {
        await new Promise(r => setTimeout(r, 25));
      }
      const first = frames.findIndex(f => f.t === 'hb');
      const snap = frames.findIndex(f => f.t === 'snapshot');
      assert.ok(first >= 0 && snap >= 0 && first < snap, JSON.stringify(frames.map(f => f.t)));
      assert.ok(Math.abs((frames[first]!.now ?? 0) - Date.now()) < 5_000);
    } finally {
      ws.close();
      await d.done();
    }
  });
});

test('the day VOD chapters keep the morning across a restart, and never a sample match', async () => {
  // A midday restart used to list only the matches after it, and 0:00 fell
  // back to the restart time.
  await withEnv({ REMOTE_PIN: '' }, async () => {
    const t0 = Date.now() - 3 * 3600_000;
    const before = new EventBus();
    before.emit({ type: 'match.loaded', source: 'cheesy', ts: t0,
      payload: { id: 'q3', displayName: 'Qualification 3', red: [], blue: [] } } as never);
    before.emit({ type: 'match.start', source: 'cheesy', ts: t0 + 120_000 } as never);
    const d = await boot({ chapterSeed: [...before.recent] });
    try {
      // The sample, pressed after the restart, is not a landmark.
      d.bus.emit({ type: 'match.loaded', source: 'demo',
        payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] } } as never);
      d.bus.emit({ type: 'match.start', source: 'demo' } as never);

      const body = await (await fetch(`${d.base}/api/chapters`)).json() as
        { startedAt: number; chapters: { title: string }[] };
      assert.equal(body.startedAt, t0, '0:00 falls back to the first landmark of the day');
      const titles = body.chapters.map(c => c.title);
      assert.ok(titles.includes('Qualification 3'), `the morning is there: ${titles.join(', ')}`);
      assert.equal(titles.includes('Qualification 42'), false, 'the sample is not');
    } finally {
      await d.done();
    }
  });
});

test('the page probe the consoles rely on: only a signed-out gated page is sent to /signin', async () => {
  // desk-client.js asks the server about its own page (a HEAD, redirects
  // followed) and goes to sign in only if it lands on /signin. That is safe
  // on air only while an open page is never redirected, so pin both halves.
  await withEnv({ REMOTE_PIN: '4826' }, async () => {
    const d = await boot();
    const head = (path: string, cookie = '') =>
      fetch(`${d.base}${path}`, { method: 'HEAD', headers: cookie ? { cookie } : {} });
    try {
      const out = await head('/s/talent');
      assert.equal(out.redirected, true);
      assert.equal(new URL(out.url).pathname, '/signin', 'a signed-out console is sent to sign in');

      for (const open of ['/s/program', '/s/side', '/s/next']) {
        assert.equal((await head(open)).redirected, false, `${open} is never redirected`);
      }

      const auth = await fetch(`${d.base}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '4826' }),
      });
      const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0]!;
      assert.equal((await head('/s/talent', cookie)).redirected, false, 'signed in, it stays');
    } finally {
      await d.done();
    }
  });
});
