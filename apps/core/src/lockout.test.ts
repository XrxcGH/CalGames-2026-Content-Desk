/**
 * The brute-force lockout has to END.
 *
 * It is the one security control here whose failure mode is denial of service
 * against the event itself: the desk PIN, the awards code and the settings
 * code all run through it, and the lockout is keyed by address, which under
 * venue NAT is every phone in the building at once.
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

const PORT = 18773;
const PIN = '0864';
const JA = '1357';
const LOCKOUT_MS = 700;

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
  process.env['REMOTE_PIN'] = PIN;
  process.env['JA_PIN'] = JA;
  process.env['SETUP_PIN'] = '';
  const dir = await mkdtemp(join(tmpdir(), 'cg-lockout-'));
  const server = startServer({
    bus: new EventBus(), media: new MediaLibrary(dir), root: dir,
    port: PORT, host: '127.0.0.1', config: structuredClone(DEFAULTS),
    lockoutBaseMs: LOCKOUT_MS,
  });
  const base = `http://127.0.0.1:${PORT}`;
  const tryPin = async (path: string, pin: string) => {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    return res.status;
  };

  try {
    // Five wrong guesses is the budget, and the sixth is refused.
    for (let i = 0; i < 5; i++) {
      assert.equal(await tryPin('/api/auth', '9999'), 401, `guess ${i + 1} is simply wrong`);
    }
    assert.equal(await tryPin('/api/auth', '9999'), 429, 'the sixth is locked out');
    assert.equal(await tryPin('/api/auth', PIN), 429,
      'and the CORRECT pin is refused while the lockout stands, which is the point of it');

    // Serve it.
    await new Promise(r => setTimeout(r, LOCKOUT_MS + 250));

    assert.equal(await tryPin('/api/auth', PIN), 200,
      'once the lockout is served the right pin works again');

    // The awards door keeps its own counter, and it releases too. This is the
    // one that matters most: it is a tablet in a judging room, typed on by
    // somebody who has not seen it before.
    for (let i = 0; i < 5; i++) await tryPin('/api/awards/auth', '0000');
    assert.equal(await tryPin('/api/awards/auth', JA), 429, 'the awards door locks');
    await new Promise(r => setTimeout(r, LOCKOUT_MS + 250));
    assert.equal(await tryPin('/api/awards/auth', JA), 200,
      'and the Judge Advisor gets their tablet back');
  } finally {
    delete process.env['REMOTE_PIN'];
    delete process.env['JA_PIN'];
    delete process.env['SETUP_PIN'];
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
