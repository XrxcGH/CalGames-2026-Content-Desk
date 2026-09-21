/**
 * The awards ceremony, end to end, against a real listening server.
 *
 * Every other award test checks one piece. This one walks the whole evening
 * in the order it actually happens, over the real HTTP routes, because the
 * property being protected is a property of the SEQUENCE: the desk crew signs
 * in hours before the Judge Advisor stages anything, the JA loads winners
 * from their own page all afternoon, the code changes hands minutes before
 * the ceremony, and the winner must be unreachable from an ordinary phone in
 * the gym for every one of those hours.
 *
 * It is the one segment of the weekend that cannot be re-run, so it gets the
 * one test that refuses to take any single layer's word for it.
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
import { Awards } from './awards.ts';
import { DEFAULTS } from './config.ts';

const PORT = 18751;
const DESK_PIN = '0864';
const JA_PIN = '1357';

process.env['REMOTE_PIN'] = DESK_PIN;
process.env['JA_PIN'] = JA_PIN;
process.env['SETUP_PIN'] = '';

const LIST = [
  { id: 'directors', day: 'Saturday', title: "Directors' Award",
    blurb: 'From the WRRF Board, for outstanding service.',
    description: "The Directors' Award is presented by the WRRF Board." },
  { id: 'volunteer', day: 'Saturday', title: 'Volunteer of the Year',
    blurb: 'For the volunteer whose work sets the standard.',
    description: 'CalGames is grateful to have many dedicated volunteers.' },
  { id: 'founders', day: 'Sunday', title: "Founders' Award",
    blurb: "CalGames' highest honor for impact beyond the field.",
    description: "The Founders' Award is CalGames' highest recognition." },
];

/** The secret, in a form no layer can leak by accident and still pass. */
const WINNER = 'Zzyzx Robotics Collective';
const TEAM = 9999;

test('a winner is unreachable from the stands until the reveal, all evening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-ceremony-'));
  const bus = new EventBus();
  const awards = new Awards(dir, bus, LIST);
  awards.attach();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: PORT, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), awards,
  });
  const base = `http://127.0.0.1:${PORT}`;

  const jar: Record<string, string> = {};
  const call = async (path: string, opts: {
    method?: string; body?: unknown; who?: string;
  } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (opts.who && jar[opts.who]) headers['cookie'] = jar[opts.who]!;
    const res = await fetch(base + path, {
      method: opts.method ?? 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set && opts.who) jar[opts.who] = set.split(';')[0]!;
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, text: JSON.stringify(json) };
  };
  /** A phone in the stands: on the network, holding nothing. */
  const fromTheStands = async (path: string) =>
    fetch(base + path).then(async r => ({ status: r.status, text: await r.text() }));

  /*
   * The same phone's SOCKET, recording every frame the desk ever sends it.
   *
   * This is the channel that matters and the one a state-only test misses.
   * The read path is open on purpose (an OBS Browser Source cannot type a
   * PIN), so every surface in the building receives each event's full
   * payload. The reducer happens to copy only four fields onto the state, so
   * a winner smuggled into the award.show PAYLOAD never shows up in
   * /api/state and a test that checks only state passes while the secret is
   * being broadcast to the room. Verified by mutation: adding `winner` to
   * that payload does not move /api/state at all.
   */
  const heard: string[] = [];
  const spectator = new WebSocket(`ws://127.0.0.1:${PORT}/ws?surface=stands`);
  spectator.on('message', d => heard.push(String(d)));
  await new Promise((res, rej) => { spectator.on('open', res); spectator.on('error', rej); });
  const nothingHeardYet = (when: string) => {
    const leak = heard.find(f => f.includes(WINNER) || f.includes(String(TEAM)));
    assert.equal(leak, undefined,
      `${when}: a frame reached the stands carrying the winner: ${leak?.slice(0, 160)}`);
  };
  /*
   * Wait for the socket to go quiet, rather than sleeping a guessed number of
   * milliseconds. A fixed sleep passed alone and failed under the full suite,
   * where every test file runs at once and 120ms is not always enough for a
   * frame to cross a loopback socket: a flaky test on THIS invariant is worse
   * than no test, because the next person to see it red will assume it is the
   * flake again.
   */
  const settle = async () => {
    let n = -1;
    for (let i = 0; i < 40 && n !== heard.length; i++) {
      n = heard.length;
      await new Promise(r => setTimeout(r, 25));
    }
  };
  /** Wait until a frame carrying `needle` arrives, or give up and fail. */
  const waitForFrame = async (needle: string): Promise<boolean> => {
    for (let i = 0; i < 80; i++) {
      if (heard.some(f => f.includes(needle))) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };

  try {
    // ---- the desk crew signs in, hours early ------------------------------
    assert.equal((await call('/api/auth', {
      method: 'POST', body: { pin: DESK_PIN }, who: 'desk',
    })).status, 200);

    const deskEarly = await call('/api/awards', { who: 'desk' });
    assert.equal((deskEarly.json as { locked: boolean }).locked, true,
      'the desk sees the panel locked');
    assert.equal(deskEarly.text.includes('staged'), false,
      'and is told nothing about what the JA has loaded, not even that anything is');

    // ---- the Judge Advisor loads winners from their own page --------------
    assert.equal((await call('/api/awards/auth', {
      method: 'POST', body: { pin: JA_PIN }, who: 'ja',
    })).status, 200, 'the JA code is not the desk PIN and opens its own door');

    for (const a of LIST) {
      assert.equal((await call('/api/awards', {
        method: 'POST', who: 'ja',
        body: { action: 'stage', id: a.id, winner: WINNER, team: TEAM },
      })).status, 200);
    }

    // The JA can proof-read their own typing. Nobody else can.
    const jaView = await call('/api/awards', { who: 'ja' });
    assert.equal(jaView.text.includes(WINNER), true,
      'the JA can re-read what they staged, or a typo reaches the projector');

    // ---- the long wait: the afternoon, with winners sitting on the desk ---
    for (const path of ['/api/state', '/api/awards', '/api/events/recent']) {
      const open = await fromTheStands(path);
      assert.equal(open.text.includes(WINNER), false,
        `${path} must not carry the winner to an unauthenticated phone`);
      assert.equal(open.text.includes(String(TEAM)), false,
        `${path} must not carry the winning team number either`);
    }
    const deskWait = await call('/api/awards', { who: 'desk' });
    assert.equal(deskWait.text.includes(WINNER), false,
      'the signed-in DESK still cannot read a winner before the handover');
    await settle();
    nothingHeardYet('after an afternoon of staging');

    // ---- the ceremony ------------------------------------------------------
    for (const a of LIST) {
      assert.equal((await call('/api/awards', {
        method: 'POST', who: 'ja', body: { action: 'show', id: a.id },
      })).status, 200);

      const up = await fromTheStands('/api/state');
      const shown = (JSON.parse(up.text) as {
        award: { revealed: boolean; blurb: string; title: string };
      }).award;
      assert.equal(shown.revealed, false, `${a.id}: the plate is up, not revealed`);
      assert.equal(shown.title, a.title);
      assert.equal(shown.blurb, a.blurb,
        `${a.id}: the plate carries the one line blurb, not the definition`);
      assert.equal(up.text.includes(WINNER), false,
        `${a.id}: the winner is STILL not on the open feed with the plate up`);
      await settle();
      nothingHeardYet(`${a.id}: plate up, GA building the moment`);

      assert.equal((await call('/api/awards', {
        method: 'POST', who: 'ja', body: { action: 'reveal' },
      })).status, 200);

      const out = await fromTheStands('/api/state');
      const revealed = (JSON.parse(out.text) as {
        award: { revealed: boolean; winner: string; team: number };
      }).award;
      assert.equal(revealed.revealed, true);
      assert.equal(revealed.winner, WINNER,
        `${a.id}: the winner reaches the audience for the first time, now`);
      assert.equal(revealed.team, TEAM);

      assert.ok(await waitForFrame(WINNER),
        `${a.id}: the reveal DOES reach the stands, which proves this socket `
        + 'was listening the whole time rather than quietly disconnected');
      heard.length = 0;

      await call('/api/awards', { method: 'POST', who: 'ja', body: { action: 'clear' } });
    }

    // ---- afterwards --------------------------------------------------------
    const done = await call('/api/awards', { who: 'ja' });
    const list = (done.json as { list: { presented: unknown; staged: unknown }[] }).list;
    assert.equal(list.filter(a => a.presented).length, LIST.length,
      'every award ticks off the checklist');
    assert.equal(list.filter(a => a.staged).length, 0,
      'and the file of secrets has emptied itself as the ceremony ran');

    // The JA locks the page again on their way out.
    assert.equal((await call('/api/awards/signout', { method: 'POST', who: 'ja' })).status, 200);
    jar['ja'] = '';
    const relocked = await call('/api/awards', { who: 'ja' });
    assert.ok(relocked.status === 401
      || (relocked.json as { locked?: boolean } | null)?.locked === true,
      'and the page is shut again');
  } finally {
    delete process.env['REMOTE_PIN'];
    delete process.env['JA_PIN'];
    delete process.env['SETUP_PIN'];
    spectator.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
