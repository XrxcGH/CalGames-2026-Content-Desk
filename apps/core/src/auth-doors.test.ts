/**
 * The three sign-in doors, end to end against a real listening server.
 *
 * Both of these were found as live holes: a request body that parses but is not
 * an object could lock an address out of a door for good, and an unquoted
 * number in config.json stopped the desk from booting at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { DEFAULTS, type Config } from './config.ts';

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

const post = async (base: string, path: string, body: string): Promise<number> => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  await res.arrayBuffer();
  return res.status;
};

test('a body that parses but is not an object never locks a door', async () => {
  /*
   * JSON.parse('null') is null, and the doors read `body.pin` straight after.
   * That TypeError was thrown AFTER authReserve took a guessing slot and
   * outside the try that releases it, so the reservation was never resolved.
   * Five such requests (the limit) left the address locked out of that door
   * for the life of the process, correct code and all: the desk, the Judge
   * Advisor's tablet, and the settings page, from one curl, and under venue
   * NAT from every phone in the building.
   */
  await withEnv({ REMOTE_PIN: '0864', JA_PIN: '1357', SETUP_PIN: '4567' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-doors-'));
    const server = startServer({
      bus: new EventBus(), media: new MediaLibrary(dir), root: dir,
      // Port 0: the operating system picks a free one, so a second run of this
      // suite (or a desk left open on the machine) cannot take a fixed number.
      port: 0, host: '127.0.0.1', config: structuredClone(DEFAULTS),
    });
    const base = `http://127.0.0.1:${await server.listening}`;
    try {
      const doors: [string, string][] = [
        ['/api/auth', '0864'],
        ['/api/awards/auth', '1357'],
        ['/api/setup/auth', '4567'],
      ];
      for (const [path, pin] of doors) {
        // More than the five-guess budget, so a leak cannot hide behind it.
        for (const junk of ['null', 'null', 'null', 'null', 'null', 'null',
          '[]', '5', '"1357"', 'true']) {
          assert.equal(await post(base, path, junk), 400,
            `${path} must answer a ${junk} body with 400, not a 500 or a lockout`);
        }
        assert.equal(await post(base, path, JSON.stringify({ pin })), 200,
          `${path}: the right code still works afterwards`);
      }
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('an unquoted numeric pin in config.json boots and signs in', async () => {
  /*
   * "pin": 2468 is the natural way to write a four-digit code, and JSON
   * hands it over as a number. `(config.awards.pin ?? '1357').trim()` threw
   * at startup, so the desk never served a page on the morning of the event.
   */
  await withEnv({ REMOTE_PIN: '0864', JA_PIN: undefined, SETUP_PIN: undefined }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-doors-'));
    const config = structuredClone(DEFAULTS) as Config;
    config.awards = { ...config.awards, pin: 2468 as unknown as string };
    config.setup = { pin: 8642 as unknown as string };
    const server = startServer({
      bus: new EventBus(), media: new MediaLibrary(dir), root: dir,
      port: 0, host: '127.0.0.1', config,
    });
    const base = `http://127.0.0.1:${await server.listening}`;
    try {
      // Typed into the page as text, which is how the browser sends it.
      assert.equal(await post(base, '/api/awards/auth', JSON.stringify({ pin: '2468' })), 200);
      assert.equal(await post(base, '/api/setup/auth', JSON.stringify({ pin: '8642' })), 200);
      // And a number, as a hand-written client might send it.
      assert.equal(await post(base, '/api/awards/auth', JSON.stringify({ pin: 2468 })), 200);
      // The shipped defaults are NOT what is live.
      assert.equal(await post(base, '/api/awards/auth', JSON.stringify({ pin: '1357' })), 401);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
