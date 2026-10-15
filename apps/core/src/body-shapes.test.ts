/**
 * A request body that parses but is not an object, against every route that
 * reads one.
 *
 * Every POST handler did `JSON.parse(...) as { ... }` and read fields off the
 * result. JSON.parse also returns null, arrays, numbers, strings and booleans.
 * On a literal `null` the first field read is a TypeError: a route that caught
 * it answered 422 with "Cannot read properties of null (reading 'team')", and
 * one that did not answered 500 and logged a stack. The three sign-in doors
 * were fixed first because theirs also leaked a guessing slot (see
 * auth-doors.test.ts); this is every other door.
 *
 * What the right answer is: 400, a sentence that says what was wrong, and the
 * desk left exactly as it was.
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
import { ArcadeStore } from './arcade/store.ts';
import { TriviaStore } from './trivia/store.ts';

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

/**
 * A module the route must never reach. The handler may test that it exists
 * (that is how a desk built without one answers 503) and may read the
 * properties named in `allow`; anything else it touches throws, so a bad body
 * that got past the guard would fail loudly here instead of by luck.
 */
const untouched = (name: string, allow: Record<string, unknown> = {}): never =>
  new Proxy(allow, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      throw new Error(`${name}.${String(prop)} was reached with a body that is not an object`);
    },
  }) as never;

const BODIES: [text: string, kind: RegExp][] = [
  ['null', /not null/],
  ['[]', /not an array/],
  ['7', /not a number/],
  ['"x"', /not a string/],
  ['true', /not a boolean/],
];

/**
 * Every route that reads a JSON body, with the verb and path a client uses.
 * The gate is off and the awards and settings tiers are collapsed onto it
 * (REMOTE_PIN, JA_PIN and SETUP_PIN all empty), so what is under test is the
 * body and nothing else.
 */
const ROUTES = [
  '/api/media/consent',
  '/api/clips', '/api/clips/match', '/api/frame',
  '/api/arcade/set', '/api/arcade/score',
  '/api/emergency', '/api/scene', '/api/emit',
  '/api/sponsors', '/api/awards', '/api/slides', '/api/gp',
  '/api/timer', '/api/cardcall', '/api/rundown',
  '/api/setup',
  '/api/profiles', '/api/profiles/delete', '/api/panel',
  '/api/audio/play', '/api/audio/player',
  '/api/trivia/open', '/api/trivia/join', '/api/trivia/answer',
  '/api/stream/title',
  '/api/publish/segment',
];

const post = async (base: string, path: string, body: string) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    // A route that returned without answering would otherwise hang the test.
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json: { error?: string } = {};
  try { json = JSON.parse(text) as { error?: string }; } catch { /* not JSON: a 500 page */ }
  return { status: res.status, error: json.error ?? text, json };
};

test('a body that is not an object is a 400 on every route that reads one', async () => {
  await withEnv({ REMOTE_PIN: '', JA_PIN: '', SETUP_PIN: '' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-bodies-'));
    const bus = new EventBus();
    const arcade = new ArcadeStore(bus);
    const trivia = new TriviaStore(bus);
    const server = startServer({
      bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
      config: structuredClone(DEFAULTS),
      arcade, trivia,
      clips: untouched('clips'),
      publish: untouched('publish', { ready: { youtube: true } }),
      audio: untouched('audio'),
      profiles: untouched('profiles'),
      sponsors: untouched('sponsors'),
      awards: untouched('awards'),
      slides: untouched('slides'),
      rundown: untouched('rundown'),
      content: untouched('content'),
    });
    const base = `http://127.0.0.1:${await server.listening}`;
    const eventsBefore = bus.recent.length;
    const arcadeBefore = JSON.stringify(arcade.snapshot);
    try {
      for (const path of ROUTES) {
        for (const [text, kind] of BODIES) {
          const r = await post(base, path, text);
          assert.equal(r.status, 400, `${path} must answer a ${text} body with 400, got ${r.status}: ${r.error}`);
          assert.match(r.error, /JSON object/, `${path}: the sentence says what was wrong`);
          assert.match(r.error, kind, `${path}: and what it was instead`);
          assert.doesNotMatch(r.error, /Cannot read properties/, `${path}: and is not a stack message`);
        }
      }

      // And the refusals changed nothing: no event reached the bus, and the
      // two real stores did not move.
      assert.equal(bus.recent.length, eventsBefore, 'a refused body emits nothing');
      assert.equal(trivia.snapshot().phase, 'idle');
      assert.equal(JSON.stringify(arcade.snapshot), arcadeBefore);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('a real object still reaches the route\'s own checks, and an empty body still means {}', async () => {
  // The guard must refuse the wrong shapes and nothing else.
  await withEnv({ REMOTE_PIN: '', JA_PIN: '', SETUP_PIN: '' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-bodies-'));
    const bus = new EventBus();
    const arcade = new ArcadeStore(bus);
    const trivia = new TriviaStore(bus);
    const server = startServer({
      bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
      config: structuredClone(DEFAULTS), arcade, trivia,
    });
    const base = `http://127.0.0.1:${await server.listening}`;
    try {
      // An empty object is valid JSON of the right shape: the route's own
      // validation answers, in its own words.
      const noTeam = await post(base, '/api/media/consent', '{}');
      assert.equal(noTeam.status, 400);
      assert.match(noTeam.error, /Which team/);
      const noScene = await post(base, '/api/scene', '{}');
      assert.equal(noScene.status, 400);
      assert.match(noScene.error, /Name a scene/);

      // Ordinary valid bodies do what they always did.
      assert.equal((await post(base, '/api/emergency', '{"message":"Hold all matches"}')).status, 200);
      assert.ok(bus.recent.some(e => e.type === 'emergency.raise'));
      assert.equal((await post(base, '/api/emergency', '{"clear":true}')).status, 200);
      assert.equal((await post(base, '/api/timer', '{"seconds":30,"label":"Field setup"}')).status, 200);
      assert.equal((await post(base, '/api/scene', '{"scene":"Field"}')).status, 200);
      assert.equal((await post(base, '/api/cardcall', '{"clear":true}')).status, 200);

      // The routes whose body is optional: no body at all is the empty object.
      assert.equal((await post(base, '/api/arcade/clear', '')).status, 200);
      const opened = await post(base, '/api/trivia/open', '');
      assert.equal(opened.status, 200);
      assert.equal(trivia.snapshot().phase, 'open');
      trivia.reveal();                     // closes the question and its 20 second timer

      // Text that is not JSON at all is unchanged: the route's own 422.
      const garbage = await post(base, '/api/emergency', '{not json');
      assert.equal(garbage.status, 422);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('a socket frame that is not an object is ignored, not thrown', async () => {
  /*
   * A frame of literal `null` parses, and the handler read `.t` off it. That
   * throw is inside an EventEmitter listener, so it is not an error to answer
   * but an uncaught exception, which the one handler in index.ts logs and
   * carries on from once the show is up. Reachable by anything on the venue
   * network that can open /ws, no PIN needed: the read path is open.
   */
  await withEnv({ REMOTE_PIN: '2468', JA_PIN: '', SETUP_PIN: '' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-bodies-'));
    const server = startServer({
      bus: new EventBus(), media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
      config: structuredClone(DEFAULTS),
    });
    const port = await server.listening;
    const thrown: unknown[] = [];
    const onThrow = (err: unknown) => { thrown.push(err); };
    process.on('uncaughtException', onThrow);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?surface=test`);
      const frames: { t?: string; ok?: boolean }[] = [];
      ws.on('message', d => frames.push(JSON.parse(String(d))));
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

      for (const junk of ['null', '[]', '7', '"x"', 'true', '{not json']) ws.send(junk);
      // The socket is still being served after all of them: a real frame gets
      // a real answer.
      ws.send(JSON.stringify({ t: 'auth', pin: '2468' }));
      const deadline = Date.now() + 10_000;
      while (!frames.some(f => f.t === 'auth') && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      assert.deepEqual(thrown, [], 'no frame threw out of the message handler');
      assert.equal(frames.find(f => f.t === 'auth')?.ok, true, 'and the socket still answers');
      ws.close();
    } finally {
      process.off('uncaughtException', onThrow);
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
