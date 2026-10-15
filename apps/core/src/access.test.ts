import assert from 'node:assert/strict';
import test from 'node:test';

import { OPEN_SURFACES, cookie, needsAuth, safeEqual } from './access.ts';

const get = (path: string): boolean => needsAuth({ method: 'GET', path });
const post = (path: string): boolean => needsAuth({ method: 'POST', path });

test('the surfaces an audience sees never ask for a credential', () => {
  // A Browser Source cannot type a PIN, and a spectator should not have to.
  for (const id of ['program', 'side', 'tele', 'arcade', 'trivia', 'quiz', 'next']) {
    assert.equal(get(`/s/${id}`), false, `/s/${id} must stay open`);
    assert.ok(OPEN_SURFACES.has(id));
  }
  // And the reads those pages depend on.
  for (const p of ['/api/state', '/api/urls', '/api/media/manifest',
    '/api/trivia', '/api/trivia/play']) {
    assert.equal(get(p), false, `${p} must stay open`);
  }
  // Plus their assets.
  for (const p of ['/theme/tokens.css', '/shared/desk-client.js',
    '/media/teams/846/robot.v1.png', '/media/sponsors/acme.png']) {
    assert.equal(get(p), false, `${p} must stay open`);
  }
});

test('every control console is gated', () => {
  for (const id of ['desk', 'replay', 'draw', 'media', 'arcadedesk', 'triviadesk',
    'talent', 'var', 'cards', 'remote']) {
    assert.equal(get(`/s/${id}`), true, `/s/${id} must require the PIN`);
  }
});

test('the audience can still play, but cannot run the show', () => {
  assert.equal(post('/api/trivia/join'), false);
  assert.equal(post('/api/trivia/answer'), false);

  // Everything else that changes something is closed.
  for (const p of ['/api/trivia/open', '/api/trivia/reveal', '/api/trivia/next',
    '/api/trivia/reset', '/api/trivia/pick', '/api/trivia/question/add',
    '/api/clips', '/api/clips/match', '/api/frame', '/api/publish/match',
    '/api/publish/release', '/api/publish/segment', '/api/cues/x/arm',
    '/api/cards/foo']) {
    assert.equal(post(p), true, `${p} must require the PIN`);
  }
});

test('operator reads are private even though they are only reads', () => {
  // Queue state names credentials and upload targets; the audit log is the
  // bridge's own request history. Neither belongs to the crowd.
  for (const p of ['/api/publish', '/api/cheesy/audit', '/api/recorder',
    '/api/chapters', '/api/markers', '/api/events/recent', '/api/trivia/bank']) {
    assert.equal(get(p), true, `${p} must require the PIN`);
  }
});

test('anything new is private until someone opens it deliberately', () => {
  // The allowlist runs in both directions, so a route added later fails
  // closed rather than quietly shipping open.
  assert.equal(get('/api/some-future-thing'), true);
  assert.equal(post('/api/some-future-thing'), true);
  assert.equal(get('/s/a-new-console'), true);
});

test('authenticating is possible without already being authenticated', () => {
  assert.equal(post('/api/auth'), false);
  assert.equal(get('/api/auth/status'), false);
  // The sign-in page itself must be reachable while signed out: it's the only
  // way an operator redirected there for lacking a PIN can ever enter one.
  assert.equal(get('/signin'), false);
  // The index only lists surfaces, so it stays reachable.
  assert.equal(get('/'), false);
});

test('cookies parse without a library, including junk headers', () => {
  assert.equal(cookie('desk_auth=abc123; other=1', 'desk_auth'), 'abc123');
  assert.equal(cookie(' desk_auth = spaced ; x=y', 'desk_auth'), 'spaced');
  assert.equal(cookie('nope=1', 'desk_auth'), null);
  assert.equal(cookie(undefined, 'desk_auth'), null);
  assert.equal(cookie('malformed;;;', 'desk_auth'), null);
  // A cookie value that was percent-encoded on the way out.
  assert.equal(cookie('desk_auth=a%20b', 'desk_auth'), 'a b');
  // A malformed percent escape must come back raw, never throw: this once
  // reached the /ws handshake with no try around it and killed the process.
  assert.equal(cookie('desk_auth=%zz', 'desk_auth'), '%zz');
  assert.equal(cookie('desk_auth=100%', 'desk_auth'), '100%');
});

test('recorded footage is gated even though it is only static files', () => {
  // /clips/ holds pre-publication match cuts and the head referee's review
  // frames. No open surface reads it; the consoles that do are gated and
  // send the session cookie with every subresource request. /frames/ never
  // had a mount at all, and an exemption for it would pre-open whatever gets
  // mounted there next.
  for (const p of ['/clips/match42.mp4', '/clips/frame-program-1.jpg', '/frames/x.jpg']) {
    assert.equal(get(p), true, `${p} must require the PIN`);
  }
});

test('the comparison does not short-circuit on the first wrong character', () => {
  assert.equal(safeEqual('1234', '1234'), true);
  assert.equal(safeEqual('1234', '1235'), false);
  assert.equal(safeEqual('1234', '9234'), false);
  assert.equal(safeEqual('1234', '123'), false);
  assert.equal(safeEqual('', ''), true);
});

test('a verb is not a permission: no method gets a free pass', () => {
  // This shipped broken. needsAuth() opened with a blanket
  // `if (method === 'OPTIONS') return false`, and because the route handlers
  // dispatch on path alone, `curl -X OPTIONS /s/desk` served the whole
  // operator console and `-X OPTIONS /api/trivia/bank` handed out unrevealed
  // trivia answers to anyone on the venue wifi.
  const gated = ['/s/desk', '/s/replay', '/s/remote', '/api/trivia/bank',
    '/api/cheesy/audit', '/api/publish', '/api/events/recent', '/api/markers',
    '/api/chapters', '/api/recorder', '/api/cues'];

  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
    for (const path of gated) {
      assert.equal(needsAuth({ method, path }), true,
        `${method} ${path} must require the PIN`);
    }
  }
});

test('open surfaces stay open under every method too', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    for (const path of ['/s/program', '/s/side', '/s/next', '/api/state', '/api/arcade']) {
      assert.equal(needsAuth({ method, path }), false, `${method} ${path} must stay open`);
    }
  }
  // But an open READ path is not an open WRITE path.
  assert.equal(needsAuth({ method: 'POST', path: '/api/state' }), true);
  assert.equal(needsAuth({ method: 'POST', path: '/api/arcade' }), true);
});

test('the arcade overlay can bootstrap itself without a PIN', () => {
  // It is an open surface, and /api/arcade is the only place it learns the
  // set in progress: the state snapshot carries no arcade fields.
  assert.equal(needsAuth({ method: 'GET', path: '/api/arcade' }), false);
});

test('a team can read its own matches; the coverage report stays gated', () => {
  // The split exists because the allowlist matches paths and not query
  // strings: /api/coverage?team=846 would have opened the whole operational
  // report, gap advice included, to anyone on the venue wifi.
  assert.equal(needsAuth({ method: 'GET', path: '/api/coverage/team/846' }), false);
  assert.equal(needsAuth({ method: 'GET', path: '/api/coverage' }), true);
  // The prefix must not become a wildcard for everything under /api/coverage.
  assert.equal(needsAuth({ method: 'GET', path: '/api/coverage/report' }), true);
  // And it stays a READ: a POST to the same path is still closed.
  assert.equal(needsAuth({ method: 'POST', path: '/api/coverage/team/846' }), true);
});

test('the static asset trees are open to READS, not to every verb', () => {
  // The prefix exemption ran ahead of the method split, so /theme/, /shared/
  // and /media/ were open for POST and DELETE too. Harmless only while the
  // static file sender is the sole handler matching those paths. The moment
  // a write route is mounted under one, it ships pre-opened. That is the
  // same shape as the OPTIONS hole this file already has a test for.
  assert.equal(needsAuth({ method: 'GET', path: '/theme/tokens.css' }), false);
  assert.equal(needsAuth({ method: 'GET', path: '/media/teams/846/robot.v1.png' }), false);
  assert.equal(needsAuth({ method: 'POST', path: '/media/teams/846/robot.v1.png' }), true);
  assert.equal(needsAuth({ method: 'DELETE', path: '/theme/tokens.css' }), true);
});

test('the licensed audio is closed however its path is spelled', () => {
  /*
   * The gate compared the RAW url path against '/media/audio/', while the file
   * sender decodes it, flips %5C into a Windows separator, and opens it on a
   * case-insensitive NTFS. Each of these reached the same walk-up mp3 and went
   * straight past the gate, so anyone on the venue Wi-Fi could read the whole
   * licensed library by typing team numbers.
   */
  const spellings = [
    '/media/Audio/walkups/254.mp3',               // case: NTFS does not care
    '/media/%61udio/walkups/254.mp3',             // a percent-encoded letter
    '/media//audio/walkups/254.mp3',              // a doubled slash
    '/media/audio%5Cwalkups%5C254.mp3',           // %5C is a separator to win32
    '/media/teams/..%2faudio/walkups/254.mp3',    // an encoded slash hides the climb
    // And the cousins of those five.
    '/media/AUDIO/stingers/goal.mp3',
    '/media/audio./walkups/254.mp3',              // win32 drops the trailing dot
    '/media/audio%20/walkups/254.mp3',            // and a trailing space
    '/media/%41%55%44%49%4f/walkups/254.mp3',     // every letter encoded
    '/media/%2561udio/walkups/254.mp3',           // encoded twice
    '/media/teams/..%252faudio/walkups/254.mp3',  // the climb, encoded twice
    '/media/teams/%2e%2e/audio/walkups/254.mp3',  // encoded dots
    '/media/teams/../audio/walkups/254.mp3',      // plain dots
    '/media/sponsors/..\\audio\\walkups\\254.mp3', // a literal backslash
    '/media/teams/846/../../audio/walkups/254.mp3',
    '/media/audio::$INDEX_ALLOCATION/walkups/254.mp3', // an NTFS stream name
  ];
  for (const p of spellings) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(needsAuth({ method, path: p }), true,
        `${method} ${p} would serve licensed audio to anyone`);
    }
  }
});

test('media is private by default: only the picture folders are open', () => {
  // An allowlist, so the next folder somebody drops into media/ is private
  // until someone decides otherwise.
  for (const p of ['/media/846.webp', '/media/frames/x.jpg', '/media/audio/walkups/254.mp3',
    '/media/notes.txt', '/media/', '/media']) {
    assert.equal(get(p), true, `${p} must require the PIN`);
  }
});

test('the open picture folders stay open under every spelling the sender accepts', () => {
  // The other half: normalising must not start refusing the audience surfaces
  // their robot cutouts and sponsor logos, which carry no cookie.
  for (const p of [
    '/media/teams/846/robot.v1.png',
    '/media/Teams/846/robot.v1.png',
    '/media//teams/846/robot.v1.png',
    '/media/teams/%38%34%36/robot.v1.png',
    '/media/teams%5C846%5Crobot.v1.png',
    '/media/teams/845/../846/robot.v1.png',
    '/media/teams/846/robot%20two.png',
    '/media/teams/846/100%25.png',
    '/media/sponsors/acme.png',
    '/media/Sponsors/Acme%20Corp.png',
  ]) {
    assert.equal(get(p), false, `${p} must stay open`);
  }
});

test('a malformed or endlessly re-encoded path is not trusted', () => {
  // The sender answers 404 for a bad escape, so there is nothing to serve, and
  // nothing worth reasoning about. Refusing is the safe direction.
  assert.equal(get('/media/teams/%zz/robot.png'), true);
  assert.equal(get('/media/teams/%/robot.png'), true);
  assert.equal(get('/media/teams/%25252525252e/robot.png'), true,
    'still changing after several decodes');
});

test('an open static tree cannot be used to climb into a closed one', () => {
  // The URL parser flattens plain dot segments before this ever runs; an
  // encoded slash is how a climb survives it. The sender returns 404 for
  // these today, and the gate should not be the thing that depends on that.
  for (const p of ['/theme/a%2f..%2f..%2fclips%2fmatch42.mp4',
    '/shared/..%2f..%2frec%2fclips%2fmatch42.mp4',
    '/theme/..%2fshared%2fdesk-client.js']) {
    assert.equal(get(p), true, `${p} leaves the tree it was requested under`);
  }
  assert.equal(get('/theme/fonts/inter.woff2'), false);
  assert.equal(get('/shared/%64esk-client.js'), false);
});
