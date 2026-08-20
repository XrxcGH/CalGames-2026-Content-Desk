/**
 * YouTube Data API v3 upload client. See docs/11-distribution.md.
 *
 * Resumable uploads, because a venue uplink at a high-school gym will drop
 * mid-file and restarting a 2GB match video from byte zero is not acceptable.
 *
 * Quota note: videos.insert cost dropped from ~1600 units to ~100 in December
 * 2025, so the default 10,000/day project quota supports ~100 uploads a day
 * rather than six. The limit that actually bites is the per-CHANNEL daily
 * upload cap, which is separate and low for unverified channels, so use an
 * established, verified channel.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API_URL = 'https://www.googleapis.com/youtube/v3';

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube';
/** captions.insert needs this one specifically. See uploadCaption. */
export const CAPTION_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export interface YouTubeAuth { clientId: string; clientSecret: string; refreshToken: string }

export interface VideoMeta {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus: 'private' | 'unlisted' | 'public';
  /** 28 = Science & Technology. */
  categoryId?: string;
}

/**
 * YouTube refuses '<' and '>' anywhere in snippet.title or
 * snippet.description: the API answers 400 invalidTitle or
 * invalidDescription, and that verdict is permanent, not transient, so a
 * single 'Winner: <team 254>' typed into a segment note burned every retry
 * and stranded the item in failed with an error that never mentioned the
 * brackets. The metadata is assembled from free text (operator notes, award
 * names, config credit lines), so the brackets are swapped out here at the
 * API boundary, where every caller passes through, instead of being chased
 * through each text source. Parentheses rather than deletion, so
 * 'Winner: (team 254)' still reads as intended.
 */
const noAngles = (s: string): string => s.replace(/</g, '(').replace(/>/g, ')');

export class YouTubeClient {
  #auth: YouTubeAuth;
  #token: string | null = null;
  #tokenExpiry = 0;

  constructor(auth: YouTubeAuth) { this.#auth = auth; }

  get configured(): boolean {
    return !!(this.#auth.clientId && this.#auth.clientSecret && this.#auth.refreshToken);
  }

  /** Access tokens last an hour; refresh a minute early to avoid a race. */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpiry - 60_000) return this.#token;
    if (!this.configured) throw new Error('YouTube credentials are not configured (see config.json).');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#auth.clientId,
        client_secret: this.#auth.clientSecret,
        refresh_token: this.#auth.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const body = await res.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`YouTube token refresh failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    this.#token = body.access_token;
    this.#tokenExpiry = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.#token;
  }

  /** Begin a resumable session. Returns the URL to PUT bytes to. */
  async #startSession(meta: VideoMeta, size: number): Promise<string> {
    const token = await this.#accessToken();
    const res = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: noAngles(meta.title).slice(0, 100),          // hard API limit
          description: noAngles(meta.description).slice(0, 5000),
          tags: meta.tags?.slice(0, 30),
          categoryId: meta.categoryId ?? '28',
        },
        status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: false },
      }),
    });

    const location = res.headers.get('location');
    if (!res.ok || !location) {
      throw new Error(`YouTube upload session failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return location;
  }

  /**
   * Find out where a resumable session actually stands: how many bytes it
   * has, whether it already finished (YouTube can fully receive a file and
   * this process can still crash before it records the video id, a real gap
   * during a venue power blip), or whether the session itself is gone, in
   * which case a fresh one is opened so the caller always gets one back.
   */
  async #resume(sessionUrl: string, size: number, meta: VideoMeta):
      Promise<{ id: string } | { sessionUrl: string; offset: number }> {
    const res = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${size}` },
    });
    if (res.status === 200 || res.status === 201) {
      const body = await res.json().catch(() => null) as { id?: string } | null;
      if (body?.id) return { id: body.id };
      throw new Error('YouTube reports the upload complete but returned no video id.');
    }
    if (res.status === 308) {
      const range = res.headers.get('range');           // e.g. "bytes=0-12345"
      return { sessionUrl, offset: range ? Number(range.split('-')[1]) + 1 : 0 };
    }
    if (res.status === 404) {                            // session expired: start over
      return { sessionUrl: await this.#startSession(meta, size), offset: 0 };
    }
    throw new Error(`Could not query upload progress (${res.status})`);
  }

  /**
   * Upload a file, resuming across interruptions. Returns the video id.
   * `onProgress` is fed committed-byte counts so the desk can show something
   * honest while a 40-minute upload runs.
   */
  async upload(
    file: string, meta: VideoMeta,
    opts: { sessionUrl?: string; onProgress?: (sent: number, total: number) => void;
            onSession?: (url: string) => void; attempts?: number } = {},
  ): Promise<string> {
    const size = (await stat(file)).size;
    // A session handed in from a previous, interrupted run may already have
    // bytes, or even the whole file, committed, so it has to be checked
    // before the first byte goes out, not only on a retry within this call.
    const resuming = !!opts.sessionUrl;
    let sessionUrl = opts.sessionUrl ?? await this.#startSession(meta, size);
    opts.onSession?.(sessionUrl);

    const maxAttempts = opts.attempts ?? 5;
    let offset = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1 || resuming) {
          const status = await this.#resume(sessionUrl, size, meta);
          if ('id' in status) { opts.onProgress?.(size, size); return status.id; }
          if (status.sessionUrl !== sessionUrl) { sessionUrl = status.sessionUrl; opts.onSession?.(sessionUrl); }
          offset = status.offset;
        }
        if (offset >= size) break;

        const stream = createReadStream(file, { start: offset });
        const res = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(size - offset),
            'Content-Range': `bytes ${offset}-${size - 1}/${size}`,
            'Content-Type': 'video/mp4',
          },
          body: Readable.toWeb(stream) as ReadableStream,
          // Node requires this for a streaming request body.
          duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        if (res.status === 200 || res.status === 201) {
          const body = await res.json() as { id?: string };
          if (!body.id) throw new Error('Upload finished but YouTube returned no video id');
          opts.onProgress?.(size, size);
          return body.id;
        }
        if (res.status === 308) {                  // more bytes wanted
          const status = await this.#resume(sessionUrl, size, meta);
          if ('id' in status) { opts.onProgress?.(size, size); return status.id; }
          if (status.sessionUrl !== sessionUrl) { sessionUrl = status.sessionUrl; opts.onSession?.(sessionUrl); }
          // "Progress isn't a failure," but only when the committed offset
          // actually MOVED. A session that answers 308 without advancing
          // (a proxy swallowing the body, a wedged session) used to refund
          // the attempt unconditionally and loop forever, re-sending the
          // whole file remainder flat-out with no backoff.
          const advanced = status.offset > offset;
          offset = status.offset;
          opts.onProgress?.(offset, size);
          if (advanced) { attempt--; continue; }
          if (attempt === maxAttempts) throw new Error('Upload stalled: the session stopped accepting bytes.');
          await new Promise(r => setTimeout(r, Math.min(30_000, 2 ** attempt * 1000)));
          continue;
        }
        // 404 means the session expired, so start a fresh one and try again.
        if (res.status === 404) {
          sessionUrl = await this.#startSession(meta, size);
          opts.onSession?.(sessionUrl);
          offset = 0;
          continue;
        }
        throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        // Backoff, then resume from whatever the server actually has.
        await new Promise(r => setTimeout(r, Math.min(30_000, 2 ** attempt * 1000)));
      }
    }

    throw new Error('Upload did not complete');
  }

  /**
   * Flip privacy, used to publish only once TBA linking has succeeded.
   *
   * videos.update is a REPLACE of every mutable field in the parts sent:
   * a body carrying only privacyStatus wiped the selfDeclaredMadeForKids=false
   * declaration made at upload (re-answering the COPPA question as "unset",
   * which YouTube may then re-decide), along with embeddable/license. The
   * fields the upload set are re-sent alongside the flip, same read-modify-
   * write discipline as setLiveBroadcastTitle below.
   */
  async setPrivacy(videoId: string, privacyStatus: VideoMeta['privacyStatus']): Promise<void> {
    const token = await this.#accessToken();
    const res = await fetch(`${API_URL}/videos?part=status`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: videoId,
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
          embeddable: true,
          license: 'youtube',
        },
      }),
    });
    if (!res.ok) throw new Error(`Privacy update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  /**
   * Attach a caption track to a video. Returns the caption id.
   *
   * Scope note, because this is the one call that needs more than the others:
   * captions.insert requires youtube.force-ssl, NOT the upload scope the rest
   * of the pipeline runs on. A desk authorised for uploads only will get a 403
   * here, which is why the caller treats a caption failure as a warning rather
   * than a failed video. Re-consent with CAPTION_SCOPE to turn it on.
   *
   * Multipart rather than resumable: a caption file is kilobytes. The manual
   * boundary construction is unavoidable: YouTube's multipart upload wants
   * related/mixed with a JSON part first, which fetch's FormData cannot build.
   */
  async uploadCaption(
    videoId: string, file: string,
    opts: { language?: string; name?: string; draft?: boolean } = {},
  ): Promise<string> {
    const token = await this.#accessToken();
    const body = await readFile(file);
    const meta = JSON.stringify({
      snippet: {
        videoId,
        language: opts.language ?? 'en',
        // The track name shown in the player's caption menu. Empty is a valid
        // and common choice; YouTube then labels it by language alone.
        name: opts.name ?? '',
        isDraft: opts.draft ?? false,
      },
    });

    const boundary = `cg2026-${videoId}-${body.length}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: payload,
      });
    if (!res.ok) {
      throw new Error(`Caption upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return ((await res.json()) as { id: string }).id;
  }

  /**
   * Find the channel's active live broadcast and retitle it, for the Day 1 ->
   * Day 2 flip without anyone opening YouTube Studio.
   *
   * broadcastType=all matters: the list default filters to "event" broadcasts,
   * which hides the persistent default-stream broadcast most OBS rigs stream
   * to, and the lookup would come back empty exactly when it is needed.
   *
   * The update is a read-modify-write of the snippet: liveBroadcasts.update
   * DELETES any mutable snippet field the request omits (description,
   * scheduledStartTime, scheduledEndTime), so the listed values are sent back
   * alongside the new title. Only fields the broadcast actually has go out; a
   * persistent broadcast has no scheduledStartTime to preserve.
   *
   * Returns null when nothing is live, so the caller can say so usefully.
   */
  async setLiveBroadcastTitle(title: string): Promise<{ id: string; title: string } | null> {
    const token = await this.#accessToken();

    const listRes = await fetch(
      `${API_URL}/liveBroadcasts?part=id,snippet&broadcastStatus=active&broadcastType=all&maxResults=1`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    if (!listRes.ok) {
      throw new Error(`Live broadcast lookup failed (${listRes.status}): ${(await listRes.text()).slice(0, 200)}`);
    }
    const list = await listRes.json() as {
      items?: { id?: string; snippet?: Record<string, unknown> }[];
    };
    const active = list.items?.[0];
    if (!active?.id || !active.snippet) return null;

    const snippet: Record<string, unknown> = { title: title.slice(0, 100) };  // hard API limit
    for (const field of ['description', 'scheduledStartTime', 'scheduledEndTime'] as const) {
      if (active.snippet[field] != null) snippet[field] = active.snippet[field];
    }

    const res = await fetch(`${API_URL}/liveBroadcasts?part=snippet`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: active.id, snippet }),
    });
    if (!res.ok) {
      throw new Error(`Live broadcast title update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return { id: active.id, title: snippet['title'] as string };
  }

  async addToPlaylist(videoId: string, playlistId: string): Promise<void> {
    if (!playlistId) return;
    const token = await this.#accessToken();
    const res = await fetch(`${API_URL}/playlistItems?part=snippet`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      }),
    });
    // Non-fatal: a video in the wrong playlist still beats no video.
    if (!res.ok) console.warn(`[youtube] playlist insert failed (${res.status})`);
  }
}

export const watchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;
