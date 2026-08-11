/**
 * One-time Spotify authorization: turns a client id into a refresh token you
 * can paste into config.json.
 *
 *   npm run auth:spotify
 *
 * Authorization Code with PKCE, which is the only flow that fits here.
 * Implicit Grant was sunset in November 2025, and the plain client-secret flow
 * would put a permanent credential on a laptop that volunteers carry around a
 * gym for no benefit. PKCE needs no secret at all.
 *
 * The redirect URI is 127.0.0.1 and not localhost, and that is not a style
 * choice: Spotify rejects `localhost` by name, requires HTTPS for anything
 * that is not a loopback address, and permits plain HTTP only for an explicit
 * loopback literal. So the browser leg has to happen ON the machine running
 * this, which is worth knowing before somebody tries it from a phone.
 *
 * The token is NOT written to config.json. You paste it, so nothing here ever
 * writes a secret to disk on its own.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { SPOTIFY_SCOPES } from './spotify.ts';

const PORT = 8722;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

/** base64url, which is what PKCE wants and what Buffer does not do by name. */
const b64url = (buf: Buffer): string => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`
Spotify authorization
---------------------
This links the desk to the account that plays the event's house music.

Before you start:

  1. The account must be Spotify PREMIUM. Remote control does not work on a
     free account, and as of 2026 the developer app's owner needs Premium too.
  2. Create an app at https://developer.spotify.com/dashboard
  3. Add this EXACT redirect URI to it:  ${REDIRECT}
     (Spotify rejects "localhost" by name. It has to be the 127.0.0.1 form.)
  4. In the app's Settings > User Management, add the Spotify account that
     will play the music. Development-mode apps only work for accounts listed
     there, and an account that is missing fails with a 403 later rather than
     a clear message now.

Run this on the machine you are sitting at: the browser step only works from
this computer, because 127.0.0.1 means "here".
`);

const clientId = (await rl.question('Client ID: ')).trim();
rl.close();

if (!clientId) {
  console.error('The client ID is required.');
  process.exit(1);
}

// PKCE: a high-entropy secret we keep, and the hash of it that we publish.
const verifier = b64url(randomBytes(64));
const challenge = b64url(createHash('sha256').update(verifier).digest());
// Round-trip guard, so a callback we did not start cannot hand us a code.
const state = b64url(randomBytes(16));

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  response_type: 'code',
  redirect_uri: REDIRECT,
  scope: SPOTIFY_SCOPES,
  code_challenge_method: 'S256',
  code_challenge: challenge,
  state,
}).toString();

console.log(`\nOpen this in a browser on THIS machine, signed in as the music account:\n\n${authUrl}\n`);

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

    const err = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    const back = url.searchParams.get('state');
    const mismatch = back !== state;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // `err` is a query parameter, so it is escaped: it arrives from whatever
    // opened this URL, which on a one-shot loopback listener is nothing
    // valuable, but a page that interpolates a query string raw is a habit
    // worth not having anywhere in the repo.
    res.end(`<body style="font-family:system-ui;padding:48px;background:#0E0113;color:#fff">
      <h1 style="color:#F0AF00">${err || mismatch ? 'Authorization failed' : 'Authorized'}</h1>
      <p>${err ? escapeHtml(err) : mismatch ? 'The reply did not match this request.'
        : 'You can close this tab and go back to the terminal.'}</p></body>`);

    server.close();
    if (err) reject(new Error(err));
    else if (mismatch) reject(new Error('state mismatch: the callback did not come from this request'));
    else resolve(got!);
  });
  server.listen(PORT, '127.0.0.1', () => console.log('Waiting for the redirect...'));
});

const res = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  }),
});

const body = await res.json() as {
  refresh_token?: string; error?: string; error_description?: string;
};
if (!res.ok || !body.refresh_token) {
  console.error(`\nToken exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  process.exit(1);
}

console.log(`
Done. Paste these into config.json under "audio" > "spotify":

  "clientId":     "${clientId}",
  "refreshToken": "${body.refresh_token}"

Then set "deviceName" to the name the music machine's Spotify shows under
Connect (its computer name, usually), and "playlistUri" to the event playlist:
right-click the playlist in Spotify, Share, Copy link, and keep the id, or use
the spotify:playlist:... form.

Two things to write on the run sheet:

  - This token expires SIX MONTHS from today, whether or not it gets used, and
    refreshing does not extend it. If the event is more than six months out,
    re-run this closer to the day.
  - config.json is gitignored. Keep it that way: this token controls playback
    on that Spotify account.
`);
