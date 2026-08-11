import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyController, SpotifyRelinkNeeded, createSpotify } from './spotify.ts';

/**
 * A stand-in for Spotify. Records every request, and can be told to behave the
 * way the real one does in the specific situations that break a show: an idle
 * device, a free account, a dead refresh token.
 */
function fakeSpotify(opts: {
  devices?: { id: string; name: string; is_active: boolean; is_restricted?: boolean; supports_volume?: boolean }[];
  /** Fail transport with 404 until the device has been transferred to. */
  idleUntilTransfer?: boolean;
  tokenBody?: Record<string, unknown>;
  tokenStatus?: number;
  playStatus?: number;
  playBody?: string;
} = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let woken = !opts.idleUntilTransfer;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init?.body) body = String(init.body);
    calls.push({ method, url: u, body });

    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

    if (u === 'https://accounts.spotify.com/api/token') {
      return json(opts.tokenStatus ?? 200,
        opts.tokenBody ?? { access_token: 'tok', expires_in: 3600 });
    }
    if (u.startsWith('https://api.spotify.com/v1/me/player/devices')) {
      return json(200, { devices: opts.devices ?? [{ id: 'dev1', name: 'Music Mac', is_active: false, supports_volume: true }] });
    }
    // Transfer: PUT /me/player with device_ids.
    if (method === 'PUT' && /\/v1\/me\/player(\?|$)/.test(u)) {
      woken = true;
      return new Response(null, { status: 204 });
    }
    if (u.includes('/me/player/play')) {
      if (!woken) return new Response('{"error":{"reason":"NO_ACTIVE_DEVICE"}}', { status: 404 });
      if (opts.playStatus) return new Response(opts.playBody ?? '', { status: opts.playStatus });
      return new Response(null, { status: 204 });
    }
    if (u.includes('/me/player/volume')) return new Response(null, { status: 204 });
    if (u.includes('/me/player')) {
      return json(200, { is_playing: true, device: { name: 'Music Mac', volume_percent: 70 }, item: null });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, get woken() { return woken; } };
}

const cfg = {
  clientId: 'client', refreshToken: 'refresh',
  deviceName: 'Music Mac', playlistUri: 'spotify:playlist:x',
};

test('an idle Spotify app is woken and the command retried, not reported dead', async () => {
  // THE day-of failure: the app is open on the music machine but nobody has
  // pressed play since it booted, so Spotify says there is no active device.
  const fake = fakeSpotify({ idleUntilTransfer: true });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });

  await spotify.play({ contextUri: 'spotify:playlist:x' });

  const transfers = fake.calls.filter(c => c.method === 'PUT' && /\/v1\/me\/player(\?|$)/.test(c.url));
  assert.equal(transfers.length, 1, 'the device was woken exactly once');
  assert.deepEqual((transfers[0]!.body as { device_ids: string[] }).device_ids, ['dev1']);
  assert.equal((transfers[0]!.body as { play: boolean }).play, false,
    'waking must not itself start music in the room');
  const plays = fake.calls.filter(c => c.url.includes('/me/player/play'));
  assert.equal(plays.length, 2, 'the play was retried after the wake');
});

test('the wake retry happens once, never in a loop', async () => {
  // A device that will never wake must fail, not hang the desk.
  const fake = fakeSpotify({ idleUntilTransfer: true });
  let woke = 0;
  let plays = 0;
  const stubborn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    // Counted here rather than off fake.calls: this wrapper answers the play
    // itself and never passes it down, so the fake never sees one.
    if (u.includes('/me/player/play')) { plays++; return new Response('', { status: 404 }); }
    const res = await fake.fetchImpl(url as string, init);
    if (/\/v1\/me\/player(\?|$)/.test(u) && (init?.method ?? 'GET') === 'PUT') woke++;
    return res;
  }) as unknown as typeof fetch;

  const spotify = new SpotifyController(cfg, { fetchImpl: stubborn });
  await assert.rejects(() => spotify.play(), /NO_ACTIVE_DEVICE/);
  // The counts are the actual claim in the title. Without them, code that woke
  // and retried three times passed this test, and only a truly infinite loop
  // failed it — by timing the suite out.
  assert.equal(woke, 1, 'woke exactly once');
  assert.equal(plays, 2, 'the original attempt and one retry, no more');
});

test('one token refresh, however many callers ask at once', async () => {
  // start() fires loadPlaylists() and refresh() without awaiting either, so
  // this is every boot, not an edge case. Two refreshes of the same refresh
  // token race Spotify's rotation, and the loser is told invalid_grant, which
  // is latched as terminal — the desk comes up permanently needing a re-link
  // while holding a good token.
  const fake = fakeSpotify({});
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await Promise.all([spotify.status(), spotify.status(), spotify.status()]);
  const refreshes = fake.calls.filter(c => c.url.includes('/api/token'));
  assert.equal(refreshes.length, 1, 'three concurrent callers, one token request');
});

test('a failed refresh is not cached, so the next command retries', async () => {
  // The flip side of single-flighting: a network blip on the first refresh
  // must not leave a rejected promise pinned for the rest of the weekend.
  let fail = true;
  const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/api/token') && fail) {
      fail = false;
      throw new Error('venue wifi');
    }
    return fakeSpotify({}).fetchImpl(url as string, init);
  }) as unknown as typeof fetch;

  const spotify = new SpotifyController(cfg, { fetchImpl: flaky });
  await assert.rejects(() => spotify.status(), /venue wifi/);
  await spotify.status();   // must not re-throw the cached rejection
});

test('a rotated refresh token is handed back for persisting', async () => {
  // Spotify may return a new refresh token on any refresh, and the old one
  // then stops working. Keeping it only in memory means the desk dies at the
  // next restart, which is Sunday morning.
  const rotated: string[] = [];
  const fake = fakeSpotify({
    tokenBody: { access_token: 'tok', expires_in: 3600, refresh_token: 'newer-token' },
  });
  const spotify = new SpotifyController(cfg, {
    fetchImpl: fake.fetchImpl,
    onTokenRotated: t => rotated.push(t),
  });

  await spotify.status();
  assert.deepEqual(rotated, ['newer-token']);
});

test('a dead refresh token latches into needs-relink instead of retrying forever', async () => {
  const fake = fakeSpotify({
    tokenStatus: 400,
    tokenBody: { error: 'invalid_grant', error_description: 'Refresh token revoked' },
  });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });

  await assert.rejects(() => spotify.status(), SpotifyRelinkNeeded);
  assert.equal(spotify.needsRelink, true);
  assert.equal(spotify.linked, false, 'the desk stops treating it as usable');
});

test('a free account gets told it is a Premium problem, not an auth problem', async () => {
  const fake = fakeSpotify({
    playStatus: 403,
    playBody: '{"error":{"status":403,"message":"Player command failed: Premium required","reason":"PREMIUM_REQUIRED"}}',
  });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await assert.rejects(() => spotify.play(), /PREMIUM/i);
});

test('a missing device names what IS visible, so it can be fixed', async () => {
  const fake = fakeSpotify({ devices: [{ id: 'p1', name: "Someone's Phone", is_active: false }] });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await assert.rejects(() => spotify.play(), /no Spotify device called "Music Mac".*Someone's Phone/s);
});

test('a restricted device is refused with the reason, not a bare 403 later', async () => {
  const fake = fakeSpotify({
    devices: [{ id: 'x', name: 'Music Mac', is_active: false, is_restricted: true }],
  });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await assert.rejects(() => spotify.play(), /restricted/);
});

test('a device that cannot take volume says so rather than erroring obscurely', async () => {
  const fake = fakeSpotify({
    devices: [{ id: 'x', name: 'Music Mac', is_active: true, supports_volume: false }],
  });
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await assert.rejects(() => spotify.setVolume(50), /does not accept volume changes/);
});

test('resume does not restart the playlist from the top', async () => {
  const fake = fakeSpotify();
  const spotify = new SpotifyController(cfg, { fetchImpl: fake.fetchImpl });
  await spotify.play();
  const play = fake.calls.find(c => c.url.includes('/me/player/play'));
  assert.equal(play?.body, undefined,
    'a bare resume sends no context_uri, or the room hears the playlist jump to track one');
});

test('createSpotify is null until it is actually configured', () => {
  assert.equal(createSpotify({ clientId: '', refreshToken: '', deviceName: '', playlistUri: '' }), null);
  assert.ok(createSpotify(cfg) instanceof SpotifyController);
});
