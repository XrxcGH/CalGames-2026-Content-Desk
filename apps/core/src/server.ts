/**
 * HTTP + WebSocket server. Serves every surface and fans out the event bus.
 *
 * Deliberately small: node:http, one `ws` dependency, no framework. This has
 * to be debuggable at 11pm on a Saturday by whoever is still awake.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus, EmitInit } from './bus.ts';
import type { MediaLibrary } from './media.ts';
import type { Recorder } from './recorder.ts';
import { cookie, needsAuth, safeEqual } from './access.ts';
import { chapterText, chaptersFrom } from './chapters.ts';
import { matchCut, type ClipStore, type Range } from './clips.ts';
import { markersSince } from './markers.ts';
import { streamTitle } from './publish/naming.ts';
import type { PublishQueue } from './publish/queue.ts';
import { redacted, publishReadiness, type Config } from './config.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { ALLOWED_PATHS, ALLOWED_SOCKETS } from './ingest/cheesy/client.ts';
import type { CueEngine } from './cue/engine.ts';
import type { ObsClient } from './cue/obs.ts';
import type { ArcadeBox, ArcadeStore } from './arcade/store.ts';
import type { HouseAudio, HouseSource } from './audio/store.ts';
import type { ClipLibrary } from './audio/library.ts';
import type { ProfileBook, ProfileInput } from './profiles.ts';
import type { CoverageLedger } from './coverage.ts';
import type { CardLedger } from './cards.ts';
import type { Rundown } from './rundown.ts';
import type { Sponsors } from './sponsors.ts';
import type { Vitals } from './vitals.ts';

/** How many people the panel graphic can render and still be readable. */
const PANEL_MAX = 6;
import type { TriviaStore } from './trivia/store.ts';
import type { DeskEvent, DeskEventType } from './types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/** Surfaces, grouped the way an operator thinks about them. */
export const SURFACES = [
  { id: 'program', group: 'On air', name: 'Program overlay', note: 'The broadcast graphic. One OBS Browser Source, 1920x1080. Holds every screen: alliance overview, live match, final score, alliance selection board, the how-to-watch explainer loop, analysis strap and arcade bumper. They switch on their own, or take one by hand from the desk.' },
  { id: 'tele',    group: 'On air', name: 'Telestrator render', note: 'The analyst\'s drawings, transparent. Layer it over the replay in OBS.' },
  { id: 'arcade',  group: 'On air', name: 'Arcade overlay',  note: 'Game sets and standings for the gaps between matches.' },
  { id: 'trivia',  group: 'On air', name: 'Trivia overlay',  note: 'Crowd trivia: question, countdown, answers, leaderboard.' },
  { id: 'side',    group: 'On air', name: 'Side screen',     note: 'For the venue TVs: who plays next, current rankings. Rotates on its own.' },
  { id: 'desk',    group: 'Run the show', name: 'Desk console', note: 'The main control panel. Runs everything, keyboard-first, even with no field connection.' },
  { id: 'talent',  group: 'Run the show', name: 'Talent view', note: 'The announcer\'s tablet: teams, ranks, live RP progress in words, local pronunciation notes.' },
  { id: 'replay',  group: 'Run the show', name: 'Replay console', note: 'Cut replays off the match timeline. Interesting moments are already marked.' },
  { id: 'draw',    group: 'Run the show', name: 'Telestrator pad', note: 'For the analyst\'s tablet. Draw on the frame the audience is seeing.' },
  { id: 'arcadedesk', group: 'Run the show', name: 'Arcade console', note: 'Score the game sets by hand. 2 players versus, 3-4 free-for-all.' },
  { id: 'triviadesk', group: 'Run the show', name: 'Trivia host', note: 'Open a question, reveal the answer, next. That\'s the whole job.' },
  { id: 'house',   group: 'Run the show', name: 'House audio player', note: 'Open this ON THE MUSIC MACHINE, the one wired to the PA and to nothing else. It plays the walk-ups and stingers the desk fires. Never add it to OBS: it refuses to play there, because its audio belongs to the room and never to the stream.' },
  { id: 'var',     group: 'Run the show', name: 'Head referee review', note: 'Frame-step the recording. Read-only: no cut, no air, no publish, no route to the field.' },
  { id: 'media',   group: 'Before the event', name: 'Team media', note: 'Upload robot photos for the pre-match overview. Missing photos fall back gracefully.' },
  { id: 'cards',   group: 'Before the event', name: 'Post-match cards', note: 'Square result graphics for social. They build themselves when a score posts.' },
  { id: 'quiz',    group: 'For the audience', name: 'Trivia play', note: 'The phone page the crowd joins from. The trivia overlay shows this URL.' },
  { id: 'watch',   group: 'On a pit monitor', name: 'Pick a screen', note: 'Every screen below, in one place, with the desk\'s address on this network. Hand this to whoever is setting up a monitor.' },
  // One row per screen a pit TV can show, so the exact URL can be copied
  // rather than assembled. `path` carries the query string the index would
  // otherwise have no way to express.
  { id: 'watch', path: '/s/watch?screen=program', group: 'On a pit monitor', name: 'Program, with the field feed',
    note: 'The broadcast picture: field feed with the live overlay on top. What the stream shows, without OBS.' },
  { id: 'watch', path: '/s/watch?screen=side', group: 'On a pit monitor', name: 'Side screen',
    note: 'On deck and rankings, rotating. Built to be read from across the room.' },
  { id: 'watch', path: '/s/watch?screen=arcade', group: 'On a pit monitor', name: 'Arcade',
    note: 'The side tournament, over the game capture.' },
  { id: 'watch', path: '/s/watch?screen=trivia', group: 'On a pit monitor', name: 'Trivia',
    note: 'The crowd game. Shows the join code between questions.' },
  { id: 'watch', path: '/s/watch?screen=next', group: 'On a pit monitor', name: 'When do we play?',
    note: 'Per-team schedule with drift-adjusted start times. Also fine on a phone.' },
  { id: 'next',    group: 'For the audience', name: 'When do we play?', note: 'Per-team schedule on any phone, with honest drift-adjusted start estimates. Side screens show its QR.' },
  { id: 'remote',  group: 'Run the show', name: 'Phone remote', note: 'Run the show from a phone. Big targets, asks for the event PIN.' },
] as const;

/** Where a surface actually lives. Most are /s/{id}; some carry a query. */
export const surfacePath = (s: { id: string; path?: string }): string => s.path ?? `/s/${s.id}`;

export interface ServerOpts {
  bus: EventBus;
  media: MediaLibrary;
  root: string;
  port: number;
  host: string;
  /** Absent when ffmpeg isn't installed. Everything else still runs. */
  recorder?: Recorder | null;
  clips?: ClipStore | null;
  publish?: PublishQueue | null;
  config?: Config | null;
  /** Absent unless the bridge was started with --cheesy. */
  cheesy?: CheesyAdapter | null;
  cues?: CueEngine | null;
  obs?: ObsClient | null;
  arcade?: ArcadeStore | null;
  trivia?: TriviaStore | null;
  /** Absent unless the house audio player is configured. */
  audio?: HouseAudio | null;
  audioClips?: ClipLibrary | null;
  /** Saved on-camera profiles, so the panel is a checklist not a form. */
  profiles?: ProfileBook | null;
  /** Every match played, and what happened to its video. */
  coverage?: CoverageLedger | null;
  /** One health report across every subsystem. */
  vitals?: Vitals | null;
  /** Cards carried and surrogates, for the talent view and the graphics. */
  cardLedger?: CardLedger | null;
  /** The day as a list, with a clock derived from measured pace. */
  rundown?: Rundown | null;
  /** Sponsor rotation, and the count behind the post-event report. */
  sponsors?: Sponsors | null;
  /** LAN-reachable base URL, e.g. "http://10.0.100.23:8720", for QR codes. */
  lanBase?: string | null;
}

export function startServer(opts: ServerOpts) {
  const { bus, media, root, port, host, recorder = null, clips = null,
          publish = null, config = null, cheesy = null, cues = null, obs = null,
          arcade = null, trivia = null, audio = null, audioClips = null,
          profiles = null, coverage = null, vitals = null, cardLedger = null,
          rundown = null, sponsors = null, lanBase = null } = opts;

  // Crash policy lives in index.ts, in the ONE uncaughtException handler for
  // the whole process: fatal during boot, log-and-continue once the show is
  // up. A second handler here could never run — Node calls listeners in
  // registration order, and index.ts's would already have decided.

  /**
   * Write the question bank back to `data/trivia.json`.
   *
   * Same atomic write the publish queue uses: a torn bank file after a power
   * cut at a venue would lose the whole set. Returns its argument so the
   * endpoints can save and respond in one expression.
   */
  async function saveBank<T>(result: T): Promise<T> {
    if (!trivia) return result;
    const file = join(root, 'data', 'trivia.json');
    // Strip the transient `live` flag; the file is a plain question array.
    const bank = trivia.bank().map(({ live, ...q }) => q);
    try {
      await mkdir(join(root, 'data'), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(bank, null, 2));
      await rename(tmp, file);
    } catch (err) {
      // The edit is already live in memory; losing the file is not worth
      // failing the request the host just made mid-show.
      console.warn('[trivia] could not save the bank:', (err as Error).message);
    }
    return result;
  }

  /** Never let a path escape its mount point. */
  function safeJoin(base: string, urlPath: string): string | null {
    // A malformed percent escape is an unfindable file, not a server error:
    // decoding /theme/%zz used to throw and answer 500 instead of 404.
    let decoded: string;
    try { decoded = decodeURIComponent(urlPath); } catch { return null; }
    const rel = normalize(decoded).replace(/^([/\\])+/, '');
    const full = resolve(base, rel);
    return full === base || full.startsWith(base + sep) ? full : null;
  }

  async function sendFile(res: ServerResponse, path: string): Promise<boolean> {
    try {
      const s = await stat(path);
      if (!s.isFile()) return false;
      res.writeHead(200, {
        'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': s.size,
        // Surfaces are edited live during rehearsal; never cache them.
        'Cache-Control': 'no-store',
      });
      // pipe() only guards the destination. A source that fails after the
      // stat (deleted, or held open by another process, which Windows does)
      // emits 'error' on a later tick, and with no listener that took the
      // whole process down.
      const rs = createReadStream(path);
      rs.on('error', err => {
        console.error('[http] read failed:', path, err.message);
        res.destroy();
      });
      // A browser walking away mid-clip must not leak the descriptor.
      res.on('close', () => rs.destroy());
      rs.pipe(res);
      return true;
    } catch { return false; }
  }

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const b = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(b),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(b);
  };

  const readBody = (req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> =>
    new Promise((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let overflowed = false;
      req.on('data', c => {
        if (overflowed) return;   // draining: count nothing, keep nothing
        size += c.length;
        if (size > limit) {
          overflowed = true;
          chunks.length = 0;
          // Reject with the route's ACTUAL limit — this text reaches the
          // operator, and telling someone with a 6KB body "32MB max" sends
          // them debugging the wrong thing. And never destroy the socket
          // here: that tore down the response too, so the friendly 422 the
          // route writes next could not reach the client. Draining the rest
          // lets 'end' fire and the response deliver normally.
          const shown = limit >= 1024 * 1024
            ? `${Math.round(limit / (1024 * 1024))}MB`
            : `${Math.round(limit / 1024)}KB`;
          fail(new Error(`Body too large (limit ${shown}).`));
          return;
        }
        chunks.push(c as Buffer);
      });
      req.on('end', () => { if (!overflowed) ok(Buffer.concat(chunks)); });
      req.on('error', err => { if (!overflowed) fail(err); });
    });

  /**
   * Chapter landmarks, kept for the whole day.
   *
   * bus.recent is a 5000-event ring, and realtime score traffic alone
   * overflows it by mid-afternoon, which silently dropped the morning's
   * matches from /api/chapters. The moments a chapter can point at number a
   * few hundred a day, so every one of them is kept here instead. A restart
   * still loses the earlier landmarks; the NDJSON log replay recovers them.
   */
  const CHAPTER_EVENTS = new Set<DeskEventType>(
    ['match.loaded', 'match.start', 'award.presented', 'alliance_selection.update']);
  const chapterLog: DeskEvent[] = bus.recent.filter(ev => CHAPTER_EVENTS.has(ev.type));
  // Fallback for "when did the recording begin": the oldest event held at
  // boot, captured once. The oldest event still in the ring drifts all day.
  const firstSeenTs = bus.recent[0]?.ts ?? Date.now();
  const unsubChapters = bus.subscribe(ev => {
    if (CHAPTER_EVENTS.has(ev.type)) chapterLog.push(ev);
  });

  /**
   * The shipped default PIN. It is in the repo, so anyone who has read the
   * code knows it: every event should set its own REMOTE_PIN.
   */
  const DEFAULT_PIN = '0864';

  /**
   * The shared event PIN.
   *
   * Unset falls back to the shipped default, so a deployment that forgets
   * the variable is gated rather than wide open. An explicit REMOTE_PIN=""
   * still turns the gate off: that is the escape hatch for a laptop on a
   * kitchen table with no network. `??` gives exactly that split, because an
   * empty string is not nullish. Do not tidy it into ||.
   */
  const REMOTE_PIN = process.env['REMOTE_PIN'] ?? DEFAULT_PIN;

  /**
   * Trivia joins per source address, for the mint-loop guard on
   * /api/trivia/join. Timestamps rather than a counter: a counter never
   * decayed, so under venue NAT (many phones, one address) it hardened into a
   * 50-player-per-address cap for the entire three-day event. A sliding
   * one-hour window keeps the guard's point — nobody mints 50 players in an
   * hour by accident — without ever locking out a section of the gym for good.
   */
  const JOIN_WINDOW_MS = 60 * 60_000;
  const JOIN_LIMIT = 50;
  const joinsByAddress = new Map<string, number[]>();

  /**
   * Brute-force damper for the PIN.
   *
   * The PIN is four digits and the venue network is full of phones, so
   * unlimited guessing falls in minutes. Failures are counted per source
   * address across both entry points, HTTP /api/auth and the socket auth
   * frame, so neither offers a cheaper channel than the other. Past the
   * limit the address waits out a lockout that doubles with every further
   * failure. A correct PIN clears the slate.
   */
  const FAIL_LIMIT = 5;
  const LOCKOUT_BASE_MS = 60_000;
  const LOCKOUT_MAX_MS = 15 * 60_000;
  // Below the limit, every miss still waits this long for its verdict, so
  // even a spread-out attack is capped at a few guesses a second.
  const FAIL_DELAY_MS = 250;
  const authFails = new Map<string, { count: number; blockedUntil: number }>();

  const authBlocked = (addr: string): boolean =>
    (authFails.get(addr)?.blockedUntil ?? 0) > Date.now();

  function noteAuthFail(addr: string): void {
    const rec = authFails.get(addr) ?? { count: 0, blockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= FAIL_LIMIT) {
      const ms = Math.min(LOCKOUT_BASE_MS * 2 ** (rec.count - FAIL_LIMIT), LOCKOUT_MAX_MS);
      rec.blockedUntil = Date.now() + ms;
      console.warn(`[auth] ${addr} locked out for ${Math.round(ms / 1000)}s ` +
        `after ${rec.count} failed PINs`);
    }
    authFails.set(addr, rec);
  }

  /**
   * One session token per process, handed out on a correct PIN.
   *
   * Regenerated on restart, which signs everyone out. That is the right
   * trade: the alternative is persisting a secret to disk on a machine that
   * gets passed between volunteers all weekend.
   */
  const SESSION = randomUUID();
  const AUTH_COOKIE = 'desk_auth';

  const isAuthed = (req: IncomingMessage): boolean =>
    !REMOTE_PIN || cookie(req.headers.cookie, AUTH_COOKIE) === SESSION;

  const http = createServer(async (req, res) => {
    // Host is client-supplied junk until proven otherwise. `??` keeps an
    // empty string, and new URL against a base of 'http://' throws; this once
    // sat above the try below, where the throw became an unhandled rejection
    // that killed the process. Fall back until parsing cannot fail.
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`); }
    catch {
      try { url = new URL(req.url ?? '/', 'http://localhost'); }
      catch { url = new URL('http://localhost/'); }
    }
    const path = url.pathname;

    try {
      // ---- access control -------------------------------------------------
      // Sign in. The PIN is only ever read from a POST body: putting it in a
      // query string would write it into the server log and the browser
      // history, on a machine several volunteers share.
      if (path === '/api/auth' && req.method === 'POST') {
        const addr = req.socket.remoteAddress ?? 'unknown';
        if (authBlocked(addr)) {
          return json(res, 429, { error: 'Too many wrong PINs. Wait a minute, then try again.' });
        }
        // Malformed JSON is the caller's mistake, not a server error: answer
        // 400 instead of letting the parse throw into the generic 500 handler.
        let body: { pin?: string };
        try {
          body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { pin?: string };
        } catch (err) {
          if (err instanceof SyntaxError) {
            return json(res, 400, { error: 'Body must be JSON, like {"pin":"1234"}.' });
          }
          return json(res, 422, { error: (err as Error).message }); // e.g. body too large
        }
        const ok = !!REMOTE_PIN && safeEqual(String(body.pin ?? ''), REMOTE_PIN);
        if (!ok) {
          noteAuthFail(addr);
          console.warn(`[auth] rejected PIN attempt from ${addr}`);
          await new Promise<void>(r => setTimeout(r, FAIL_DELAY_MS));
          return json(res, 401, { error: 'That PIN was not accepted.' });
        }
        authFails.delete(addr);
        res.setHeader('Set-Cookie',
          `${AUTH_COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/auth/status') {
        return json(res, 200, { required: !!REMOTE_PIN, authed: isAuthed(req) });
      }

      if (needsAuth({ method: req.method ?? 'GET', path }) && !isAuthed(req)) {
        // A page gets the sign-in screen, so an operator opening a bookmark
        // lands somewhere useful. An API call gets a plain 401, because a
        // fetch can do nothing with a login page.
        if (path.startsWith('/s/')) {
          res.writeHead(302, {
            Location: `/signin?next=${encodeURIComponent(url.pathname + url.search)}`,
          });
          return res.end();
        }
        return json(res, 401, { error: 'PIN required' });
      }

      // Answered here so it can never fall through to a handler that only
      // matches on path. Every route below dispatches on `path`, and most do
      // not check the verb, so an unanswered OPTIONS would run the GET body.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS' });
        return res.end();
      }

      if (path === '/signin') {
        if (await sendFile(res, join(root, 'surfaces', '_shared', 'signin.html'))) return;
        res.writeHead(404).end('No sign-in page');
        return;
      }

      // ---- API ----------------------------------------------------------
      if (path === '/api/state') return json(res, 200, bus.state);
      // The LAN-reachable base URL: what phone-facing QR codes must encode
      // (a surface's own location.host may be localhost on the desk box).
      // Open, because every QR code and every pit monitor needs it, and it
      // discloses only what the network already shows.
      if (path === '/api/urls') {
        return json(res, 200, {
          base: lanBase,
          fieldStream: config?.kiosk?.fieldStreamUrl ?? '',
        });
      }

      // , not : this endpoint is open, every overlay reads
      // it, and a team that asked to come off the screen must come off the
      // screen. The full manifest, consent included, is on the gated route
      // below for the media console.
      if (path === '/api/media/manifest') return json(res, 200, media.airable);

      if (path === '/api/media/consent' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { team?: number; consent?: string };
          const team = Number(body.team);
          if (!Number.isInteger(team) || team <= 0) return json(res, 400, { error: 'Which team?' });
          const consent = body.consent;
          if (consent !== 'granted' && consent !== 'unknown' && consent !== 'declined') {
            return json(res, 400, { error: 'Consent is granted, unknown or declined.' });
          }
          const updated = await media.setConsent(team, consent);
          // Push it now rather than at the next match load: a team asking at
          // the pit desk should be off the screen before they walk back.
          broadcastMedia();
          return json(res, 200, updated);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path === '/api/media/all') return json(res, 200, media.manifest);
      if (path === '/api/events/recent') return json(res, 200, bus.recent.slice(-200));

      if (path === '/api/recorder') {
        return json(res, 200, {
          available: !!recorder,
          encoder: recorder?.encoder ?? null,
          sources: recorder?.status ?? [],
        });
      }

      // Extract a clip. Used by the replay console for replays, and later by
      // the publish queue for match videos: same operation, different bounds.
      if (path === '/api/clips' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')) as {
            sourceId?: string; fromMs?: number; toMs?: number;
            ranges?: Range[]; label?: string; speed?: number;
          };
          if (!body.sourceId) return json(res, 400, { error: 'sourceId is required' });

          const ranges = body.ranges?.length
            ? body.ranges
            : (body.fromMs != null && body.toMs != null ? [{ fromMs: body.fromMs, toMs: body.toMs }] : null);
          if (!ranges) return json(res, 400, { error: 'ranges, or fromMs and toMs, are required' });

          const clip = await clips.extract({
            sourceId: body.sourceId, ranges, label: body.label, speed: body.speed,
          });
          bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: clip });
          return json(res, 200, clip);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /**
       * Cut the current (or just-finished) match as a broadcast-framed video:
       * pre-roll over the announcer's countdown, the match, then a jump to the
       * score reveal, skipping however long the referees spent on fouls.
       */
      if (path === '/api/clips/match' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string } | null;
          const st = bus.state;
          const startedAt = st.matchStartedAt ?? bus.lastMatchStartedAt;
          if (startedAt == null) return json(res, 409, { error: 'No match has started yet.' });

          const ranges = matchCut({
            startedAt,
            endedAt: st.matchEndedAt,
            scorePostedAt: st.scorePostedAt,
          });

          const clip = await clips.extract({
            sourceId: body?.sourceId ?? 'program',
            ranges,
            label: st.match?.displayName ?? 'match',
          });
          bus.emit({ type: 'replay.clip_ready', source: 'replay', payload: { ...clip, kind: 'match' } });
          return json(res, 200, { ...clip, parts: ranges.length });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- arcade ----------------------------------------------------------
      if (path === '/api/arcade') return json(res, 200, arcade?.snapshot ?? null);

      if (path.startsWith('/api/arcade/') && req.method === 'POST') {
        if (!arcade) return json(res, 503, { error: 'Arcade is not available.' });
        const action = path.slice('/api/arcade/'.length);
        try {
          const raw = await readBody(req, 32 * 1024);
          const body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : {};

          switch (action) {
            case 'set':
              arcade.startSet(body as unknown as Parameters<ArcadeStore['startSet']>[0]);
              break;
            case 'score':
              arcade.score(Number(body['player'] ?? 0), Number(body['delta'] ?? 1));
              break;
            case 'end': arcade.endSet(); break;
            case 'gp':
              arcade.startGrandPrix(
                String(body['name'] ?? 'Grand Prix'),
                (body['racers'] ?? []) as Parameters<ArcadeStore['startGrandPrix']>[1],
                Number(body['raceCount'] ?? 4),
              );
              break;
            case 'race': arcade.recordRace((body['order'] ?? []) as string[]); break;
            case 'undo': arcade.undoRace(); break;
            case 'upnext': arcade.setUpNext(String(body['text'] ?? '')); break;
            // Show or hide one box, so the game gets the screen back without
            // losing the scores that are still on it.
            case 'box':
              arcade.setBox(String(body['box'] ?? '') as ArcadeBox, body['on'] !== false);
              break;
            case 'boxes': arcade.showAllBoxes(); break;
            case 'clear': arcade.clear(); break;
            default: return json(res, 404, { error: `Unknown arcade action "${action}"` });
          }
          return json(res, 200, arcade.snapshot);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- safety -----------------------------------------------------------
      // Every screen at once, latched until a human clears it. Deliberately a
      // separate route from status cards: those explain a delay and retire
      // themselves, and this must do neither.
      if (path === '/api/emergency' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { message?: string; detail?: string; kind?: string; clear?: boolean };
          if (body.clear) {
            bus.emit({ type: 'emergency.clear', source: 'manual', payload: {} });
            return json(res, 200, { cleared: true });
          }
          const message = String(body.message ?? '').trim();
          if (!message) return json(res, 400, { error: 'A safety message needs words.' });
          bus.emit({
            type: 'emergency.raise', source: 'manual',
            payload: { message, detail: body.detail ?? '', kind: body.kind ?? 'custom' },
          });
          return json(res, 200, { raised: true });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }
      // ---- the camera cut ---------------------------------------------------
      // At the floor of the crew range the desk manager is also the switcher
      // (docs/06), so taking a camera has to be one press on a console they are
      // already looking at rather than a second application to alt-tab into.
      // When a dedicated switcher exists they open the same control.
      if (path === '/api/scenes') {
        return json(res, 200, {
          scenes: cues ? cues.scenes : null,
          live: bus.state.scene,
          obs: obs?.connected ?? false,
        });
      }

      if (path === '/api/scene' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { scene?: string };
          const wanted = String(body.scene ?? '').trim();
          if (!wanted) return json(res, 400, { error: 'Name a scene.' });

          // Only scenes this show declares. A typo must not put OBS on a scene
          // that does not exist and leave the program on whatever was last up.
          const known = cues ? Object.values(cues.scenes) : [];
          if (known.length && !known.includes(wanted)) {
            return json(res, 422, {
              error: `"${wanted}" is not one of this show's scenes: ${known.join(', ')}.`,
            });
          }

          // Source 'manual' is load-bearing: the cue engine's wide-shot lock
          // holds automation away from the field mid-match, and an operator
          // taking a shot by hand is exactly the case it must not block.
          bus.emit({ type: 'scene.change', source: 'manual', payload: { scene: wanted } });
          if (obs?.connected) await obs.setScene(wanted);
          return json(res, 200, { scene: wanted, obs: obs?.connected ?? false });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- sponsors ---------------------------------------------------------
      if (path === '/api/sponsors' && req.method !== 'POST') {
        // ?report=1 answers with pasteable text rather than JSON, because the
        // thing somebody actually needs at 6pm is an email they can send.
        if (sponsors && url.searchParams.get('report')) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(sponsors.report(config?.event.name ?? 'The event'));
        }
        return json(res, 200, sponsors?.snapshot ?? null);
      }

      if (path === '/api/sponsors' && req.method === 'POST') {
        if (!sponsors) return json(res, 503, { error: 'No sponsors are configured.' });
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { action?: string; id?: string };
          switch (body.action) {
            case 'next': return json(res, 200, sponsors.next());
            case 'show': return json(res, 200, sponsors.show(String(body.id ?? '')));
            case 'hide': return json(res, 200, sponsors.hide());
            default: return json(res, 404, { error: 'Unknown sponsor action.' });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- the card call ----------------------------------------------------
      // Puts the card screen up between the buzzer and the score, so the
      // announcer has something on air while they explain it. The reason is
      // typed here because no field system supplies one.
      if (path === '/api/cardcall' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { team?: number; color?: string; alliance?: string; reason?: string; clear?: boolean };

          if (body.clear) {
            bus.emit({ type: 'card.call_clear', source: 'manual', payload: {} });
            return json(res, 200, { cleared: true });
          }
          const team = Number(body.team);
          if (!Number.isInteger(team) || team <= 0) {
            return json(res, 400, { error: 'Which team is the card for?' });
          }
          if (body.color !== 'yellow' && body.color !== 'red') {
            return json(res, 400, { error: 'A card is yellow or red.' });
          }
          bus.emit({
            type: 'card.call',
            source: 'manual',
            payload: {
              team,
              color: body.color,
              alliance: body.alliance === 'blue' ? 'blue' : 'red',
              reason: body.reason ?? '',
            },
          });
          return json(res, 200, { on: true });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- run of show ------------------------------------------------------
      // Open as a READ: the audience-facing countdown on the venue screens and
      // the phone page is the whole point, and it carries nothing private.
      if (path === '/api/rundown' && req.method !== 'POST') {
        return json(res, 200, rundown?.snapshot ?? null);
      }

      if (path === '/api/rundown' && req.method === 'POST') {
        if (!rundown) return json(res, 503, { error: 'No run of show is configured.' });
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { action?: string; id?: string };
          switch (body.action) {
            case 'start':   return json(res, 200, rundown.start(String(body.id ?? '')));
            case 'advance': return json(res, 200, rundown.advance());
            case 'reset':   return json(res, 200, rundown.reset(String(body.id ?? '')));
            default: return json(res, 404, { error: 'Unknown rundown action.' });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- discipline: cards carried, and surrogates ------------------------
      // NOT /api/cards: in this codebase "cards" already means the post-match
      // social graphics, and /api/cards/{name} is where those are saved. Two
      // meanings on one path is how somebody wires the wrong one at 11pm.
      if (path === '/api/discipline') {
        return json(res, 200, cardLedger?.snapshot ?? null);
      }

      // ---- vitals -----------------------------------------------------------
      // Everything the desk can check about itself, in one answer. A read, so
      // it can be polled by a panel and printed before doors.
      if (path === '/api/vitals') {
        if (!vitals) return json(res, 503, { error: 'Vitals are not available.' });
        return json(res, 200, await vitals.report());
      }

      // ---- coverage ---------------------------------------------------------
      // "Did every match that was played end up as a video." Deliberately a
      // read: nothing here changes anything, it only notices.
      if (path === '/api/coverage') {
        if (!coverage) return json(res, 503, { error: 'Coverage is not available.' });
        return json(res, 200, coverage.report());
      }

      // One team's own matches, open to the audience: this is the answer to
      // "where is the video of the match we just played", which is the most
      // asked question after an event and a fair one to ask during it.
      //
      // A separate PATH rather than a query on the route above, because the
      // access allowlist matches paths and not query strings: opening
      // /api/coverage?team= would have opened the whole operational report,
      // gap advice included, to anyone on the venue wifi.
      if (path.startsWith('/api/coverage/team/')) {
        if (!coverage) return json(res, 503, { error: 'Coverage is not available.' });
        const team = Number(path.slice('/api/coverage/team/'.length));
        if (!Number.isInteger(team) || team <= 0) {
          return json(res, 400, { error: 'Team must be a number.' });
        }
        return json(res, 200, { team, rows: coverage.forTeam(team) });
      }

      // ---- who is on camera ------------------------------------------------
      // Method-guarded: an unguarded path match here would swallow the POST
      // below and answer an upsert with the unchanged list.
      if (path === '/api/profiles' && req.method !== 'POST') {
        return json(res, 200, profiles?.list ?? []);
      }

      if (path === '/api/profiles' && req.method === 'POST') {
        if (!profiles) return json(res, 503, { error: 'Profiles are not available.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            Record<string, unknown>;
          return json(res, 200, await profiles.upsert(body as unknown as ProfileInput));
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path === '/api/profiles/delete' && req.method === 'POST') {
        if (!profiles) return json(res, 503, { error: 'Profiles are not available.' });
        try {
          const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')) as
            { id?: string };
          return json(res, 200, { removed: await profiles.remove(String(body.id ?? '')) });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /**
       * Put a panel on air. The desk sends whoever is checked; the book
       * resolves them, remembers anyone new, and the resolved list goes on the
       * bus. Resolving here rather than at the desk means every surface and the
       * event log see the same names, and a second console cannot disagree.
       */
      if (path === '/api/panel' && req.method === 'POST') {
        if (!profiles) return json(res, 503, { error: 'Profiles are not available.' });
        try {
          const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')) as
            { title?: string; people?: ProfileInput[] };
          const wanted = Array.isArray(body.people) ? body.people : [];
          // Six is what the graphic can render legibly across a 1920 frame
          // (docs/08). Refusing is better than rendering a seventh nobody in
          // the room can read.
          if (wanted.length > PANEL_MAX) {
            return json(res, 422, {
              error: `The panel holds ${PANEL_MAX} people. Take one off first.`,
            });
          }
          const people = await profiles.resolve(wanted);
          if (!people.length) {
            bus.emit({ type: 'panel.hide', source: 'manual', payload: {} });
          } else {
            bus.emit({
              type: 'panel.show',
              source: 'manual',
              payload: {
                title: String(body.title ?? '').trim(),
                people: people.map(p => ({ name: p.name, role: p.role, team: p.team })),
              },
            });
          }
          return json(res, 200, { on: people.length, people });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- house audio -----------------------------------------------------
      // Everything here drives the room's PA and has no route to the stream:
      // the only thing that makes a sound is the house player page, running on
      // the machine wired to the house bus. See docs/06.
      if (path === '/api/audio') return json(res, 200, audio?.snapshot ?? null);

      // Upload a walk-up or a stinger: POST /api/audio/clips/walkup/254 - Song
      // with the file as the raw body, the same shape the robot-photo upload
      // uses. Must sit above the JSON action handler below, which would
      // otherwise try to parse an MP3 as JSON.
      if (path.startsWith('/api/audio/clips/') && req.method === 'POST') {
        if (!audioClips) return json(res, 503, { error: 'House audio is not configured.' });
        const rest = path.slice('/api/audio/clips/'.length);
        const slash = rest.indexOf('/');
        const kind = slash < 0 ? rest : rest.slice(0, slash);
        if (kind !== 'walkup' && kind !== 'stinger') {
          return json(res, 400, { error: 'A clip is a "walkup" or a "stinger".' });
        }
        let name: string;
        try { name = decodeURIComponent(slash < 0 ? '' : rest.slice(slash + 1)); }
        catch { return json(res, 400, { error: 'Bad percent-encoding in the clip name.' }); }
        if (!name) return json(res, 400, { error: 'Name the clip after the team, like "254.mp3".' });
        try {
          const clip = await audioClips.ingest(kind, name, await readBody(req, 12 * 1024 * 1024));
          audio?.clipsChanged();
          return json(res, 200, clip);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path.startsWith('/api/audio/') && req.method === 'POST') {
        if (!audio) return json(res, 503, { error: 'House audio is not configured.' });
        const action = path.slice('/api/audio/'.length);
        try {
          const raw = await readBody(req, 32 * 1024);
          const body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : {};

          switch (action) {
            // The house player checking in. Not an operator action: it is how
            // the desk knows there is something out there that will actually
            // make a noise when somebody presses a walk-up button.
            case 'player':
              audio.notePlayer(String(body['id'] ?? 'unknown'), body['armed'] === true);
              return json(res, 200, { ok: true });
            case 'clip-ended':
              return json(res, 200, await audio.clipEnded(
                body['token'] === undefined ? undefined : String(body['token'])));

            // Make the music machine's player active, for proving it works
            // before doors rather than during a match.
            case 'wake':     return json(res, 200, await audio.wake());
            case 'play':     return json(res, 200, await audio.play());
            case 'pause':    return json(res, 200, await audio.pause());
            case 'next':     return json(res, 200, await audio.skip('next'));
            case 'previous': return json(res, 200, await audio.skip('previous'));
            case 'duck':     return json(res, 200, await audio.duck(body['on'] !== false));
            case 'volume':   return json(res, 200, await audio.setVolume(Number(body['percent'])));
            case 'playlist': return json(res, 200, await audio.playPlaylist(String(body['uri'] ?? '')));
            case 'source':
              return json(res, 200, await audio.setSource(
                String(body['source'] ?? 'silent') as HouseSource,
                String(body['reason'] ?? 'Taken at the desk')));
            case 'clip':
              return json(res, 200, await audio.playClip(
                body['team'] !== undefined ? Number(body['team']) : String(body['id'] ?? '')));
            case 'automation':
              audio.setAutomation(body as Record<string, boolean>);
              return json(res, 200, audio.snapshot);
            default: return json(res, 404, { error: `Unknown audio action "${action}"` });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- crowd trivia ----------------------------------------------------
      // The answer to an open question never appears in any of these payloads;
      // scoring is entirely server-side. See trivia/store.ts.
      if (path === '/api/trivia') return json(res, 200, trivia?.snapshot() ?? null);

      // The bank with answers, for the host console's editor only. The phone
      // view is served by /api/trivia/play, which never carries an unrevealed
      // answer, so nothing here widens what a player can see.
      if (path === '/api/trivia/bank') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        return json(res, 200, trivia.bank());
      }

      if (path === '/api/trivia/play') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        return json(res, 200, trivia.playView(url.searchParams.get('player') ?? undefined));
      }

      if (path.startsWith('/api/trivia/') && req.method === 'POST') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        const action = path.slice('/api/trivia/'.length);
        try {
          const raw = await readBody(req, 16 * 1024);
          const body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : {};
          switch (action) {
            case 'join': {
              // The store already evicts idle players at its ceiling; this
              // guards the other end, one caller minting players in a loop.
              // Generous on purpose: a NAT in front of the venue AP collapses
              // many phones onto one address, so single digits would lock out
              // a whole section of the gym.
              const from = req.socket.remoteAddress ?? 'unknown';
              const now = Date.now();
              const recent = (joinsByAddress.get(from) ?? [])
                .filter(t => now - t < JOIN_WINDOW_MS);
              if (recent.length >= JOIN_LIMIT) {
                joinsByAddress.set(from, recent);
                return json(res, 429, { error: 'Too many joins from this connection. Wait a while, or find a volunteer if this is a mistake.' });
              }
              recent.push(now);
              joinsByAddress.set(from, recent);
              return json(res, 200, trivia.join(String(body['name'] ?? ''), Number(body['team']) || undefined));
            }
            case 'answer':
              return json(res, 200, trivia.answer(String(body['playerId'] ?? ''), Number(body['choice'])));
            case 'open':   return json(res, 200, trivia.open(Number(body['seconds']) || 20));
            case 'pick':   return json(res, 200, trivia.pick());
            // Editing the bank. Every one of these persists, because a host
            // who fixes a typo between matches should not lose it to a
            // restart, and restarts happen at events.
            case 'question/add':
              return json(res, 200, await saveBank(trivia.addQuestion(body)));
            case 'question/edit':
              return json(res, 200,
                await saveBank(trivia.editQuestion(Number(body['index']), body)));
            case 'question/remove':
              return json(res, 200, await saveBank(trivia.removeQuestion(Number(body['index']))));
            case 'question/move':
              return json(res, 200, await saveBank(
                trivia.moveQuestion(Number(body['index']), Number(body['delta']) || 0)));
            case 'reveal': return json(res, 200, trivia.reveal());
            case 'next':   return json(res, 200, trivia.next());
            // Pick the round to play in this gap. Resumes a half-finished one
            // rather than replaying it.
            case 'session': return json(res, 200, trivia.startSession(String(body['name'] ?? '')));
            // Whatever gets past the name filter, taken off the big screen in
            // one action while it is up there.
            case 'kick': {
              // Answers with the snapshot like every other trivia action, so
              // the console's shared post() can paint the result. `removed`
              // rides along, because "that name was not found" and "removed"
              // look identical from a snapshot alone.
              const { removed } = trivia.kick(String(body['name'] ?? ''));
              return json(res, 200, { ...trivia.snapshot(), removed });
            }
            case 'reset':  return json(res, 200, trivia.reset(body['hard'] === true));
            default: return json(res, 404, { error: `Unknown trivia action "${action}"` });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- show automation -------------------------------------------------
      if (path === '/api/cues') {
        return json(res, 200, {
          available: !!cues,
          obs: { connected: obs?.connected ?? false, attached: !!obs },
          cues: cues?.status ?? [],
        });
      }

      if (path.startsWith('/api/cues/') && req.method === 'POST') {
        if (!cues) return json(res, 503, { error: 'Cue engine is not running.' });
        const [id, action] = path.slice('/api/cues/'.length).split('/');

        if (id === 'all' && (action === 'arm' || action === 'disarm')) {
          cues.setAll(action === 'arm');
          return json(res, 200, { cues: cues.status });
        }
        if (!id) return json(res, 400, { error: 'Cue id required' });

        if (action === 'arm' || action === 'disarm') {
          const ok = cues.setAutopilot(id, action === 'arm');
          return json(res, ok ? 200 : 404, ok ? { cues: cues.status } : { error: `No cue "${id}"` });
        }
        if (action === 'fire') {
          // Manual always wins, firing regardless of the autopilot setting.
          const ok = await cues.fire(id);
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: `No cue "${id}"` });
        }
        return json(res, 404, { error: `Unknown cue action "${action}"` });
      }

      // ---- live stream ----------------------------------------------------
      // OBS owns the RTMP URL and key; the desk only asks it to go. All of
      // these are PIN-gated by the access allowlist's default.
      if (path === '/api/stream') {
        const connected = obs?.connected ?? false;
        let status = null;
        // A status probe failing (OBS mid-restart) is a "don't know", not an
        // error page: streaming stays null and the panel says so.
        if (connected) { try { status = await obs!.streamStatus(); } catch { /* fall through */ } }
        return json(res, 200, {
          available: !!obs,
          connected,
          streaming: status?.outputActive ?? null,
          reconnecting: status?.outputReconnecting ?? null,
          timecode: status?.outputTimecode ?? null,
        });
      }

      if ((path === '/api/stream/start' || path === '/api/stream/stop') && req.method === 'POST') {
        if (!obs?.connected) {
          return json(res, 409, { error: 'OBS is not connected. Start OBS on this machine, ' +
            'then launch the desk with --obs (and OBS_PASSWORD if OBS has one set).' });
        }
        try {
          const starting = path.endsWith('/start');
          const status = await obs.streamStatus();
          // Pressing Start on an already-live stream is a normal Saturday
          // event, not an error; same for Stop on a stopped one.
          if (starting && !status.outputActive) await obs.startStream();
          if (!starting && status.outputActive) await obs.stopStream();

          if (starting) {
            // Re-register the webcast list on TBA GameDay, exactly as boot
            // does: the list replaces itself on the TBA side, so repeating it
            // is idempotent. Fire-and-forget, because a TBA hiccup must not
            // report the stream start itself as failed.
            if (publish && config?.publish.enabled && config.stream.webcastUrl) {
              publish.registerWebcasts([config.stream.webcastUrl])
                .then(r => { if (r !== null) console.log('[publish] webcast registered on TBA GameDay'); })
                .catch(err => console.warn('[publish] webcast registration failed:', (err as Error).message));
            }
          }
          return json(res, 200, { ok: true, streaming: starting });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // Retitle the active YouTube broadcast for the day: "2026 CalGames - Day 2".
      if (path === '/api/stream/title' && req.method === 'POST') {
        if (!publish || !config) return json(res, 503, { error: 'Publishing is not available.' });
        if (!publish.ready.youtube) {
          return json(res, 409, { error: 'YouTube credentials are not configured (see config.json), ' +
            'so the broadcast title cannot be changed from here.' });
        }
        try {
          const raw = await readBody(req, 4 * 1024);
          const body = raw.length
            ? JSON.parse(raw.toString('utf8')) as { day?: number }
            : {};
          const day = body.day ?? 1;
          if (!Number.isInteger(day) || day < 1) {
            return json(res, 400, { error: 'day must be a positive whole number' });
          }
          const title = streamTitle(config.event.year, config.event.name, day);
          const result = await publish.setLiveTitle(title);
          if (!result) {
            return json(res, 409, { error: 'No active live broadcast was found on the channel. ' +
              'Start the stream, wait for YouTube to show it live, then try again.' });
          }
          return json(res, 200, { ok: true, id: result.id, title: result.title });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- field bridge ---------------------------------------------------
      // docs/10 promises the FTA a printable list of every request we make.
      // This is that list, plus the allowlist it is constrained to.
      if (path === '/api/cheesy') {
        return json(res, 200, {
          bridged: !!cheesy,
          connected: cheesy?.client.connected ?? false,
          allowedSockets: ALLOWED_SOCKETS,
          allowedPaths: ALLOWED_PATHS,
          requests: cheesy?.client.audit.length ?? 0,
        });
      }

      if (path === '/api/cheesy/audit') {
        const rows = cheesy?.client.audit ?? [];
        if (url.searchParams.get('format') === 'text') {
          const text = rows.map(r =>
            `${new Date(r.ts).toISOString()}  ${r.method.padEnd(4)} ${r.status}  ${r.url}`).join('\n');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(text + (rows.length ? '\n' : 'No requests made.\n'));
          return;
        }
        return json(res, 200, rows);
      }

      // ---- publishing ----------------------------------------------------
      // Never returns a credential, only whether each one is present.
      if (path === '/api/publish') {
        return json(res, 200, {
          available: !!publish,
          config: config ? redacted(config) : null,
          missing: config ? publishReadiness(config) : null,
          ready: publish?.ready ?? null,
          // The resumable sessionUrl is a bearer credential: YouTube accepts
          // writes to it with no Authorization header at all. It stays in the
          // queue's own state; the wire only learns a resume is in progress.
          items: (publish?.items ?? []).map(({ sessionUrl, ...rest }) =>
            ({ ...rest, resuming: sessionUrl !== null })),
        });
      }

      if (path.startsWith('/api/publish/') && req.method === 'POST') {
        if (!publish) return json(res, 503, { error: 'Publishing is not available.' });
        const action = path.slice('/api/publish/'.length);
        try {
          if (action === 'match') {
            // manual: an operator pressed the button, so the practice-match
            // auto-queue gate does not apply.
            const item = await publish.queueMatch({ manual: true });
            return json(res, item ? 200 : 409,
              item ?? { error: 'Nothing to queue: no match has started, or it is already queued.' });
          }
          if (action === 'release') {
            return json(res, 200, { released: await publish.release() });
          }
          // The parts of the day that are not matches: alliance selection, the
          // awards ceremony, a single award. The operator marks the bounds,
          // because nothing on the bus knows when a ceremony started.
          if (action === 'segment') {
            const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as {
              segment?: string; fromMs?: number; toMs?: number; note?: string; sourceId?: string;
            };
            if (!body.segment || body.fromMs == null || body.toMs == null) {
              return json(res, 400, { error: 'segment, fromMs and toMs are required' });
            }
            return json(res, 200, await publish.queueSegment({
              segment: body.segment,
              fromMs: body.fromMs,
              toMs: body.toMs,
              note: body.note,
              sourceId: body.sourceId,
            }));
          }
          if (action.startsWith('retry/')) {
            await publish.retry(action.slice('retry/'.length));
            return json(res, 200, { ok: true });
          }
          return json(res, 404, { error: `Unknown publish action "${action}"` });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /**
       * Day-VOD chapters, as text to paste into a YouTube description.
       *
       * `startedAt` is when the recording began, which only the operator
       * knows: the stream starts before the desk does, and often before the
       * first match of the day is even loaded. Defaults to the first event
       * the desk saw, which is right when it was started with the stream.
       */
      if (path === '/api/chapters') {
        const startedAt = Number(url.searchParams.get('startedAt'))
          || firstSeenTs;
        const list = chaptersFrom(chapterLog, startedAt, {
          openingTitle: url.searchParams.get('title') || undefined,
        });
        const text = chapterText(list);
        return json(res, 200, {
          startedAt,
          chapters: list,
          text,
          // An honest empty: YouTube silently ignores a list this short, so
          // saying "not enough yet" beats handing over something inert.
          usable: text !== '',
        });
      }

      if (path === '/api/markers') {
        const since = Number(url.searchParams.get('since') || 0)
          || (bus.lastMatchStartedAt ?? Date.now() - 20 * 60_000) - 60_000;
        return json(res, 200, markersSince(bus, since));
      }

      // Grab a frame and hand it to the telestrator as its backdrop.
      if (path === '/api/frame' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')) as
            { sourceId?: string; atMs?: number; analyst?: string; send?: boolean };
          if (body.atMs == null) return json(res, 400, { error: 'atMs is required' });

          const frame = await clips.frameAt(body.sourceId ?? 'program', body.atMs);
          if (body.send !== false) {
            bus.emit({
              type: 'telestrator.frame',
              source: 'replay',
              payload: { frame: frame.url, ...(body.analyst ? { analyst: body.analyst } : {}) },
            });
          }
          return json(res, 200, frame);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path.startsWith('/api/segments/')) {
        if (!clips) return json(res, 503, { error: 'Recording is not available.' });
        const sourceId = path.slice('/api/segments/'.length);
        const segs = await clips.index(sourceId);
        return json(res, 200, segs.map(s => ({
          startMs: s.startMs, seconds: s.seconds,
          file: s.file.split(/[\\/]/).pop(),
        })));
      }

      if (path.startsWith('/api/media/') && req.method === 'POST') {
        const team = Number(path.slice('/api/media/'.length));
        if (!Number.isInteger(team) || team <= 0) {
          return json(res, 400, { error: 'Bad team number' });
        }
        try {
          return json(res, 200, await media.ingest(team, await readBody(req)));
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // Save a rendered post-match card PNG to the desk, so it's on disk for
      // batch posting or the publish flow rather than only in a browser tab.
      if (path.startsWith('/api/cards/') && req.method === 'POST') {
        // A bad percent-escape (%zz) throws URIError; that is the caller's
        // mistake, not a server error, so answer 400 rather than falling
        // through to the generic 500 below.
        let raw: string;
        try { raw = decodeURIComponent(path.slice('/api/cards/'.length)); }
        catch { return json(res, 400, { error: 'Bad percent-encoding in card name.' }); }
        const name = (raw.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'match');
        try {
          const body = await readBody(req, 8 * 1024 * 1024);
          // Reject anything that isn't actually a PNG, since the byte we serve
          // back as image/png must be one.
          if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) {
            return json(res, 422, { error: 'Body is not a PNG.' });
          }
          const dir = join(root, 'rec', 'cards');
          await mkdir(dir, { recursive: true });
          const file = `${name}.png`;
          await writeFile(join(dir, file), body);
          return json(res, 200, { url: `/cards/${file}`, bytes: body.length });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- Static mounts -------------------------------------------------
      const mounts: [string, string][] = [
        ['/theme/',  join(root, 'packages', 'theme')],
        ['/shared/', join(root, 'surfaces', '_shared')],
        ['/media/',  join(root, 'media')],
        ['/clips/',  join(root, 'rec', 'clips')],
        ['/cards/',  join(root, 'rec', 'cards')],
      ];
      for (const [prefix, base] of mounts) {
        if (!path.startsWith(prefix)) continue;
        const file = safeJoin(base, path.slice(prefix.length));
        if (file && await sendFile(res, file)) return;
        res.writeHead(404).end('Not found');
        return;
      }

      // ---- Surfaces: /s/{id} and /s/{id}/asset ---------------------------
      if (path.startsWith('/s/')) {
        const [id, ...rest] = path.slice(3).split('/');
        const base = safeJoin(join(root, 'surfaces'), id ?? '');
        if (base) {
          const file = rest.length && rest[0]
            ? safeJoin(base, rest.join('/'))
            : join(base, 'index.html');
          if (file && await sendFile(res, file)) return;
        }
        res.writeHead(404).end('No such surface');
        return;
      }

      if (path === '/') return sendIndex(res);

      res.writeHead(404).end('Not found');
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  });

  function sendIndex(res: ServerResponse): void {
    const groups = [...new Set(SURFACES.map(s => s.group))];
    const sections = groups.map(g =>
      `<h2>${g}</h2>` + SURFACES.filter(s => s.group === g).map(s =>
        `<a class="row" href="${surfacePath(s)}"><b>${s.name}</b><code>${surfacePath(s)}</code><i>${s.note}</i></a>`,
      ).join('')).join('');
    const html = `<!doctype html><html lang="en" data-surface="console"><head><meta charset="utf-8">
<title>CalGames 2026 Content Desk</title>
<link rel="stylesheet" href="/theme/tokens.css">
<link rel="stylesheet" href="/shared/fonts.css">
<style>
body{padding:48px;max-width:860px;margin:0 auto;font-size:var(--font-ui-body)}
h1{font-size:38px;font-variation-settings:"wdth" 118;margin:0 0 4px}
p.sub{color:var(--text-dim);margin:0 0 26px}
h2{font-family:var(--font-cond);font-weight:700;font-size:13px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--accent);margin:30px 0 10px}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:16px 20px;
  margin-bottom:10px;background:var(--surface-raised);text-decoration:none;color:var(--text);
  clip-path:var(--chamfer);--ch:12px;transition:background var(--dur-tap) linear}
.row:hover{background:var(--btn-hover)}
.row:focus-visible{outline:3px solid var(--focus-ring)}
.row b{font-size:19px}
.row code{font-family:var(--font-mono);color:var(--accent);font-size:13px}
.row i{grid-column:1/-1;color:var(--text-dim);font-style:normal;font-size:13px}
</style></head><body>
<h1>CalGames 2026 Content Desk</h1>
<p class="sub">Core is running. Open a surface below, or point an OBS Browser Source at it.</p>
${sections}</body></html>`;
    res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ---- WebSocket fan-out -------------------------------------------------
  // maxPayload: the biggest legitimate inbound frame is a telestrator stroke
  // batch, a few KB. Without a cap, ws accepts frames up to its 100MiB default
  // and every one is String()+JSON.parse'd on the show-critical event loop —
  // from any socket, before the PIN gate is even consulted.
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 256 * 1024 });
  const send = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  /**
   * Who may write on the socket.
   *
   * The read path is always open, because overlays and pit TVs must never need
   * a credential and can only observe. Anything that CHANGES the show (emit,
   * relay) requires the PIN once one is set. That matters the moment a phone
   * can reach the desk: without it, anyone on the same Wi-Fi can take the
   * broadcast.
   */
  const authed = new WeakSet<WebSocket>();
  const mayWrite = (ws: WebSocket): boolean => !REMOTE_PIN || authed.has(ws);

  // App-level heartbeat. Between matches the bus can go quiet for minutes,
  // and a silently dropped path (a Wi-Fi roam, an unplugged switch port)
  // leaves a surface's socket looking open with nothing to disprove it. A
  // tiny frame every 10s turns that silence into a close event the client's
  // reconnect logic can act on. Clients ignore unknown frame types.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send('{"t":"hb"}');
    }
  }, 10_000);

  /**
   * Re-send the media set to every surface.
   *
   * Surfaces normally get media once, in their opening snapshot, because robot
   * photos do not change mid-show. A consent change is the exception and the
   * one that cannot wait: a team asking for their robot to come off the screen
   * should not have to wait for a reload of a Browser Source nobody is looking
   * at.
   */
  function broadcastMedia(): void {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        send(ws, { t: 'snapshot', state: bus.state, media: media.airable, needsPin: !!REMOTE_PIN });
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress ?? 'unknown';
    // The surface tag ends up in log lines, and searchParams percent-decodes,
    // so a handshake query could once inject newlines and forge entries in
    // the only record of failed PIN attempts. Strip to id characters.
    const who = (new URL(req.url ?? '/', 'http://x').searchParams.get('surface') ?? 'anon')
      .replace(/[^\w-]/g, '').slice(0, 24) || 'anon';
    // A console that signed in over HTTP arrives with the session cookie, so
    // it is never asked twice. The phone remote, which can be opened straight
    // to its own page, still authenticates over the socket below.
    if (cookie(req.headers.cookie, AUTH_COOKIE) === SESSION) authed.add(ws);
    send(ws, { t: 'snapshot', state: bus.state, media: media.airable, needsPin: !!REMOTE_PIN });

    // Guesses on this one socket. The per-address damper already counts them;
    // this closes the socket too, so a guessing loop cannot even keep its
    // connection.
    let pinFails = 0;

    ws.on('message', raw => {
      let msg: { t?: string; init?: EmitInit; channel?: string; data?: unknown; pin?: string };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }

      if (msg.t === 'auth') {
        if (authBlocked(addr)) {
          send(ws, { t: 'auth', ok: false });
          return;
        }
        // Constant-time-ish: compare full strings, and never echo the PIN back.
        const ok = !!REMOTE_PIN && safeEqual(String(msg.pin ?? ''), REMOTE_PIN);
        if (ok) {
          authed.add(ws);
          authFails.delete(addr);
          send(ws, { t: 'auth', ok: true });
          return;
        }
        pinFails += 1;
        noteAuthFail(addr);
        console.warn(`[ws:${who}] rejected PIN attempt from ${addr}`);
        // Delay the verdict, same as HTTP, so back-to-back frames cannot
        // walk the keyspace.
        setTimeout(() => {
          send(ws, { t: 'auth', ok: false });
          if (pinFails >= FAIL_LIMIT) ws.close(1008, 'too many attempts');
        }, FAIL_DELAY_MS);
        return;
      }

      if ((msg.t === 'emit' || msg.t === 'relay') && !mayWrite(ws)) {
        send(ws, { t: 'denied', reason: 'PIN required' });
        return;
      }

      // Surfaces may inject events. Source is forced to 'manual', so a surface
      // can never claim to be the field.
      if (msg.t === 'emit' && msg.init?.type) {
        bus.emit({ ...msg.init, source: 'manual' });
        return;
      }

      // Relay: ephemeral, high-frequency data that must NOT go through the
      // bus. Telestrator strokes arrive at pointer rate; putting them in the
      // event log would bloat a 3-day NDJSON archive with hundreds of
      // thousands of coordinate pairs and add a reduce+serialize step to every
      // frame of a stroke. Relayed messages are broadcast and forgotten.
      // The durable record of a stroke is emitted separately, once, on finish.
      if (msg.t === 'relay' && msg.channel) {
        const out = JSON.stringify({ t: 'relay', channel: msg.channel, data: msg.data });
        for (const peer of wss.clients) {
          if (peer !== ws && peer.readyState === peer.OPEN) peer.send(out);
        }
      }
    });

    ws.on('error', err => console.error(`[ws:${who}]`, err.message));
  });

  const unsubscribe = bus.subscribe((ev, state) => {
    for (const ws of wss.clients) send(ws, { t: 'event', ev, state });
  });

  // A taken port must read as "close the other desk", not a stack trace.
  // Double-launching is a normal Saturday event.
  http.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[core] port ${port} is already in use. Is the desk already running? ` +
        `Close it, or start again with --port <other>.`);
      process.exit(1);
    }
    console.error('[http] server error:', err);
  });

  http.listen(port, host, () => {
    console.log(`[core] http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    for (const s of SURFACES) console.log(`         ${surfacePath(s).padEnd(24)} ${s.name}`);

    // Said at startup rather than left to be discovered. At a venue the desk
    // is reachable by every phone in the building, and the trivia QR code
    // puts its address on a projector in front of the whole gym.
    if (!REMOTE_PIN) {
      console.warn('[auth] REMOTE_PIN is empty: the gate is OFF, and anyone who can reach ' +
        'this desk can run the show.');
      console.warn('[auth] Only run this way on a machine nobody else can reach.');
    } else if (REMOTE_PIN === DEFAULT_PIN) {
      console.log('[auth] control surfaces are PIN-gated; audience surfaces are open');
      console.warn(`[auth] Using the shipped default PIN (${DEFAULT_PIN}). Anyone with a copy ` +
        'of this code knows it. Set REMOTE_PIN for the event.');
    } else {
      console.log('[auth] control surfaces are PIN-gated; audience surfaces are open');
    }
  });

  return {
    close: () => { clearInterval(heartbeat); unsubscribe(); unsubChapters(); wss.close(); http.close(); },
    broadcastCount: () => wss.clients.size,
  };
}
