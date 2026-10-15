/**
 * The brute-force lockout has to END.
 *
 * It is the one security control here whose failure mode is denial of service
 * against the event itself: the desk PIN, the awards code and the settings
 * code all run through it, and the lockout is keyed by address, which under
 * venue NAT is every phone in the building at once.
 *
 * Time is the test's to move, not the machine's. These used to run on the real
 * clock with a 700 ms lockout, and the failed guess that starts a lockout does
 * not answer for another 250 ms, so the "still locked out" requests had a
 * 450 ms window to land in. A process stalled for longer than that, which the
 * whole suite running in parallel on a busy machine does to it, turned a 429
 * into a 401: a failing test about a control that was working. The server takes
 * its lockout clock as an option for exactly this (see lockoutClock).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer, type ServerOpts } from './server.ts';
import { DEFAULTS } from './config.ts';

const PIN = '0864';
const JA = '1357';
const LOCKOUT_MS = 700;

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
 * A desk on a port the operating system picked, so no fixed number can be
 * taken by another run of this suite or a desk left open on the machine.
 */
async function withDesk(
  extra: Partial<ServerOpts>,
  run: (base: string) => Promise<void>,
) {
  await withEnv({ REMOTE_PIN: PIN, JA_PIN: JA, SETUP_PIN: '' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-lockout-'));
    const server = startServer({
      bus: new EventBus(), media: new MediaLibrary(dir), root: dir,
      port: 0, host: '127.0.0.1', config: structuredClone(DEFAULTS),
      lockoutBaseMs: LOCKOUT_MS, ...extra,
    });
    try {
      await run(`http://127.0.0.1:${await server.listening}`);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const tryPin = async (base: string, path: string, pin: string): Promise<number> => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  await res.arrayBuffer();
  return res.status;
};

/** Five wrong guesses: the whole budget. The fifth one starts the lockout. */
const spendTheBudget = async (base: string, path: string) => {
  for (let i = 0; i < 5; i++) {
    assert.equal(await tryPin(base, path, '9999'), 401, `guess ${i + 1} is simply wrong`);
  }
};

test('a served lockout hands back a fresh budget of guesses', async () => {
  /*
   * It did not. authBlocked answered `count >= FAIL_LIMIT` and `count` was
   * only ever cleared by noteAuthPass, which can never run, because every
   * door consults authBlocked BEFORE comparing the code. So five wrong
   * guesses locked an address out for the life of the process and the right
   * code was never compared again.
   *
   * On the awards door that is the Judge Advisor's tablet bricked for the
   * weekend: no winner can be staged, none revealed, and the only recovery is
   * a desk restart, which rotates every session token and signs every console
   * out in the middle of the show.
   */
  let now = 1_000_000;
  await withDesk({ lockoutClock: () => now }, async base => {
    // Five wrong guesses is the budget, and the sixth is refused.
    await spendTheBudget(base, '/api/auth');
    assert.equal(await tryPin(base, '/api/auth', '9999'), 429, 'the sixth is locked out');
    assert.equal(await tryPin(base, '/api/auth', PIN), 429,
      'and the CORRECT pin is refused while the lockout stands, which is the point of it');

    // Serve it, to the millisecond: one short of the sentence is still inside it.
    now += LOCKOUT_MS - 1;
    assert.equal(await tryPin(base, '/api/auth', PIN), 429,
      'a millisecond before the lockout ends it still stands');
    now += 1;
    assert.equal(await tryPin(base, '/api/auth', PIN), 200,
      'once the lockout is served the right pin works again');

    // The awards door keeps its own counter, and it releases too. This is the
    // one that matters most: it is a tablet in a judging room, typed on by
    // somebody who has not seen it before.
    await spendTheBudget(base, '/api/awards/auth');
    assert.equal(await tryPin(base, '/api/awards/auth', JA), 429, 'the awards door locks');
    now += LOCKOUT_MS - 1;
    assert.equal(await tryPin(base, '/api/awards/auth', JA), 429,
      'and holds until its own sentence is served');
    now += 1;
    assert.equal(await tryPin(base, '/api/awards/auth', JA), 200,
      'and the Judge Advisor gets their tablet back');
  });
});

test('a lockout is not just served once: the next one for the same address is twice as long', async () => {
  /*
   * The escalation is the other half of the control. A lockout that always
   * lasts a minute lets a patient guesser walk the four-digit space at five
   * tries a minute; doubling is what makes that a losing trade. It lives in
   * `rounds`, which has to survive the fresh budget a served lockout hands
   * back, and nothing had ever checked that it did.
   */
  let now = 5_000_000;
  await withDesk({ lockoutClock: () => now }, async base => {
    await spendTheBudget(base, '/api/auth');
    assert.equal(await tryPin(base, '/api/auth', PIN), 429, 'round one locks');
    now += LOCKOUT_MS;

    // A fresh budget of five, spent the same way.
    await spendTheBudget(base, '/api/auth');
    assert.equal(await tryPin(base, '/api/auth', PIN), 429, 'round two locks');

    now += LOCKOUT_MS;
    assert.equal(await tryPin(base, '/api/auth', PIN), 429,
      'the length of round one is not enough the second time');
    now += LOCKOUT_MS - 1;
    assert.equal(await tryPin(base, '/api/auth', PIN), 429, 'a millisecond short of double');
    now += 1;
    assert.equal(await tryPin(base, '/api/auth', PIN), 200, 'twice the length, served');
  });
});

test('on the real clock a lockout still releases', async () => {
  /*
   * The two tests above move time by hand, which proves the comparison and not
   * that the server was handed a real clock when nobody injected one. This is
   * the one that does, and it can only fail by never releasing: it asserts
   * nothing about how long the lockout lasted, so a slow machine cannot fail
   * it. The wait is a poll against a generous deadline, not a sleep with a
   * margin.
   */
  await withDesk({ lockoutBaseMs: 300 }, async base => {
    await spendTheBudget(base, '/api/auth');

    const deadline = Date.now() + 20_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = await tryPin(base, '/api/auth', PIN);
      if (status !== 429) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(status, 200, 'the right pin is accepted once the lockout has run out');
  });
});
