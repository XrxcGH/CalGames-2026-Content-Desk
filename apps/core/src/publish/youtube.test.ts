import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YouTubeClient } from './youtube.ts';

test('angle brackets in operator-typed metadata never reach the wire', async () => {
  // YouTube refuses '<' and '>' in snippet.title and snippet.description
  // with a 400 (invalidTitle / invalidDescription), and a 400 is permanent:
  // one 'Winner: <team 254>' typed into a segment note used to burn all six
  // queue attempts, strand the item in failed, and re-fail identically on
  // every retry, with the raw 400 text never mentioning the brackets. The
  // client now swaps the brackets for parentheses before the metadata goes
  // out, so the upload succeeds and the note still reads as intended.
  const dir = await mkdtemp(join(tmpdir(), 'cg-yt-'));
  const file = join(dir, 'clip.mp4');
  await writeFile(file, 'stand-in bytes for a clip');

  let snippet: { title?: string; description?: string } | null = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
      snippet = (JSON.parse(String(init?.body)) as { snippet: typeof snippet }).snippet;
      return new Response(null, { status: 200, headers: { location: 'https://session.example/1' } });
    }
    // The byte PUT against the session URL: drain the stream so the file
    // handle closes (Windows will not delete the tmpdir under an open fd),
    // then hand back an id.
    if (init?.body) { for await (const chunk of init.body as AsyncIterable<unknown>) void chunk; }
    return Response.json({ id: 'vid123' });
  }) as typeof fetch;

  try {
    const client = new YouTubeClient({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
    const id = await client.upload(file, {
      title: 'FIRST Impact Award <2026> - CalGames',
      description: 'FIRST Impact Award - CalGames\nWinner: <team 254>\n\n<3 the volunteers',
      privacyStatus: 'unlisted',
    });

    assert.equal(id, 'vid123', 'the upload goes through instead of 400ing');
    // Read through a local: TS cannot see the closure assignment above.
    const sent = snippet as { title?: string; description?: string } | null;
    assert.ok(sent, 'the session request carried a snippet');
    assert.ok(!/[<>]/.test((sent.title ?? '') + (sent.description ?? '')),
      'no angle bracket may reach snippet.title or snippet.description');
    assert.equal(sent.title, 'FIRST Impact Award (2026) - CalGames');
    assert.ok(sent.description?.includes('Winner: (team 254)'),
      'the note still reads as intended');
  } finally {
    globalThis.fetch = orig;
    await rm(dir, { recursive: true, force: true });
  }
});
