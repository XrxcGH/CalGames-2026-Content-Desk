/**
 * One-time YouTube OAuth helper: turns a client id/secret into a refresh
 * token you can paste into config.json.
 *
 *   npm run auth:youtube
 *
 * Uses the loopback redirect flow (Google retired the out-of-band flow), so it
 * spins a local server, you approve in a browser, and it prints the token. The
 * token is NOT written to config.json automatically. You paste it, so nothing
 * here ever writes a secret to disk on its own.
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { UPLOAD_SCOPE, MANAGE_SCOPE, CAPTION_SCOPE } from './youtube.ts';

const PORT = 8721;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`
YouTube authorization
---------------------
You need a Google Cloud project with the YouTube Data API v3 enabled and an
OAuth 2.0 Client ID of type "Desktop app".

Add this redirect URI to that client:  ${REDIRECT}
`);

const clientId = (await rl.question('Client ID: ')).trim();
const clientSecret = (await rl.question('Client secret: ')).trim();
rl.close();

if (!clientId || !clientSecret) {
  console.error('Both values are required.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  // force-ssl too, or captions.insert answers 403 for every token this mints
  // and the caption feature is dead on arrival for anyone who follows the
  // documented setup. Asking for it here costs one extra line on the consent
  // screen and is the only moment it can be asked for.
  scope: `${UPLOAD_SCOPE} ${MANAGE_SCOPE} ${CAPTION_SCOPE}`,
  access_type: 'offline',
  // Without this, Google only returns a refresh token the FIRST time an
  // account authorizes the app. Re-running the helper would silently give
  // you nothing.
  prompt: 'consent',
}).toString();

console.log(`\nOpen this in a browser, signed in as the channel owner:\n\n${authUrl}\n`);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

    const err = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="font-family:system-ui;padding:48px;background:#1B0322;color:#fff">
      <h1 style="color:#F0AF00">${err ? 'Authorization failed' : 'Authorized'}</h1>
      <p>${err ? err : 'You can close this tab and return to the terminal.'}</p></body>`);

    server.close();
    err ? reject(new Error(err)) : resolve(got!);
  });
  server.listen(PORT, '127.0.0.1', () => console.log('Waiting for the redirect...'));
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: REDIRECT, grant_type: 'authorization_code',
  }),
});

const body = await res.json() as { refresh_token?: string; error_description?: string; error?: string };
if (!res.ok || !body.refresh_token) {
  console.error(`\nToken exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  process.exit(1);
}

console.log(`
Done. Paste these into config.json under "youtube":

  "clientId":     "${clientId}",
  "clientSecret": "${clientSecret}",
  "refreshToken": "${body.refresh_token}"

config.json is gitignored. Keep it that way.
`);
