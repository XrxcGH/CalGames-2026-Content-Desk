/**
 * Spotify as the house playlist, driven over Spotify Connect.
 *
 * The desk does NOT play the audio. The Spotify desktop app on the music
 * machine plays it, exactly as it did before this existed, and this file only
 * sends it transport commands. That split is deliberate and load-bearing:
 *
 *   - The audio path does not change, so the two-bus guarantee does not change.
 *     The machine that was wired to the house bus is still the machine making
 *     the sound. Nothing new is patched anywhere.
 *   - Spotify's own app handles login, device output, and, for a Premium
 *     account with the playlist downloaded, offline playback. When the venue
 *     uplink dies the music keeps playing; we lose only the ability to change
 *     it, which is a far better failure than silence.
 *   - Nothing here needs a browser, an SDK, or DRM playback in a page.
 *
 * Everything below is shaped by four facts checked against Spotify's own
 * documentation, because each one is a way this fails on a Saturday:
 *
 *   1. Every playback-control endpoint requires PREMIUM. A free account cannot
 *      be driven at all, and the failure is a 403 with no explanation.
 *   2. An IDLE desktop app is not an "active device". The single most likely
 *      day-of failure is `play` returning 404 because nobody has pressed play
 *      on that machine since it booted. So this transfers playback to the
 *      configured device and retries, rather than reporting a dead end.
 *   3. Refresh tokens MAY rotate on any refresh, and they hard-expire six
 *      months after the original authorization whether used or not. A rotated
 *      token that only lives in memory is a working desk that breaks on its
 *      next restart, so rotations are persisted.
 *   4. Rate limiting is a rolling 30-second window whose size Spotify does not
 *      publish. One poller on the server, never one per surface.
 *
 * Every method throws on failure and the store catches. A dead music service
 * degrades to "the walk-up clips still work", never to a broken desk.
 */

import type { MusicController, MusicStatus, NowPlaying } from './store.ts';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * What the refresh token has to have been minted with. Kept here next to the
 * calls that need them so a 403 has one obvious place to look.
 *
 *   user-read-playback-state     what is playing, and which device is active
 *   user-read-currently-playing  the current track. NOT covered by the above:
 *                                the two read endpoints take different scopes,
 *                                which is the kind of asymmetry you find out
 *                                about from a 403 at the worst moment
 *   user-modify-playback-state   play, pause, skip, volume, transfer
 *   playlist-read-private        list the event playlist when it is not public
 */
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export interface SpotifyConfig {
  clientId: string;
  refreshToken: string;
  deviceName: string;
  playlistUri: string;
}

export interface SpotifyOptions {
  /**
   * Called when Spotify hands back a NEW refresh token, which it may do on any
   * refresh. Persist it: the one in config.json is only the cold-start token,
   * and a rotation kept in memory dies at the next restart.
   */
  onTokenRotated?: (token: string) => void;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface Device {
  id: string | null;
  name: string;
  is_active: boolean;
  /** True means Spotify will accept no Web API command for this device at all. */
  is_restricted?: boolean;
  supports_volume?: boolean;
  volume_percent?: number | null;
}

/** Thrown when the refresh token is dead and only a human can fix it. */
export class SpotifyRelinkNeeded extends Error {
  constructor(detail: string) {
    super(`Spotify needs re-linking: ${detail}. Run npm run auth:spotify.`);
    this.name = 'SpotifyRelinkNeeded';
  }
}

export class SpotifyController implements MusicController {
  readonly name = 'Spotify';
  #clientId: string;
  #refresh: string;
  #deviceName: string;
  #onRotate: ((token: string) => void) | undefined;
  #fetch: typeof fetch;

  #token = '';
  #tokenExpires = 0;
  /** Resolved from deviceName, dropped whenever it stops working. */
  #device: Device | null = null;
  #relink = false;
  /** The in-flight token refresh, so concurrent callers share one request. */
  #refreshing: Promise<string> | null = null;

  constructor(cfg: SpotifyConfig, opts: SpotifyOptions = {}) {
    this.#clientId = cfg.clientId;
    this.#refresh = cfg.refreshToken;
    this.#deviceName = cfg.deviceName;
    this.#onRotate = opts.onTokenRotated;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get linked(): boolean { return !!this.#clientId && !!this.#refresh && !this.#relink; }
  /** True once a refresh has been refused: only re-authorization fixes it. */
  get needsRelink(): boolean { return this.#relink; }
  /** The device being driven, once known. Shown on the desk. */
  get deviceLabel(): string | null { return this.#device?.name ?? null; }

  // ---- auth --------------------------------------------------------------

  /**
   * Access tokens last an hour. Refreshed 60s early so one never expires
   * between the check and the call, which is the sort of race that only shows
   * up on the command that mattered.
   */
  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpires) return this.#token;
    // Single-flight, and this one is not theoretical. start() fires
    // loadPlaylists() and refresh() without awaiting either, so EVERY boot
    // sent two refresh_token POSTs carrying the same token at the same
    // moment. Spotify rotates refresh tokens: when it does, one of the pair
    // is answered with the rotation and the other is answered `invalid_grant`
    // for a token that was valid microseconds earlier. invalid_grant is
    // latched as terminal below, so the desk would come up permanently
    // needing a re-link while holding a perfectly good rotated token.
    // A second hazard the same race carries: two rotations racing into
    // saveRefreshToken share one .tmp path, so the older token can win.
    this.#refreshing ??= this.#doRefresh().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<string> {
    const res = await this.#fetch(TOKEN_URL, {
      // The same 6s cap every API call gets. Without it this one call fell
      // back to undici's ~300s headers timeout, so a venue wifi stall on the
      // hourly refresh hung the operator's next button press for minutes.
      signal: AbortSignal.timeout(6000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.#refresh,
        client_id: this.#clientId,
      }),
    });
    const body = await res.json().catch(() => ({})) as {
      access_token?: string; expires_in?: number; refresh_token?: string;
      error?: string; error_description?: string;
    };

    if (!res.ok || !body.access_token) {
      // invalid_grant is terminal: the token is revoked or past its six-month
      // life, and retrying forever just burns rate limit. Latch it so the desk
      // can show a re-link button instead of an error every five seconds.
      if (body.error === 'invalid_grant') {
        this.#relink = true;
        throw new SpotifyRelinkNeeded(body.error_description ?? 'the saved token was refused');
      }
      throw new Error(body.error_description ?? body.error ?? `token refresh failed (${res.status})`);
    }

    this.#token = body.access_token;
    this.#tokenExpires = Date.now() + ((body.expires_in ?? 3600) - 60) * 1000;
    // Spotify may or may not return a new one; when it does not, the old one
    // stays valid. Adopting whatever comes back is the only safe rule.
    if (body.refresh_token && body.refresh_token !== this.#refresh) {
      this.#refresh = body.refresh_token;
      this.#onRotate?.(body.refresh_token);
    }
    return this.#token;
  }

  // ---- requests ----------------------------------------------------------

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.#accessToken();
    const res = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(6000),
    });

    // 204 is the normal answer to every transport command, and to "nothing is
    // playing" on the state read.
    if (res.status === 204) return null;

    if (res.status === 429) {
      // Spotify's own guidance is to honour Retry-After rather than guess. We
      // do not sleep and retry: a mid-show command that lands a few seconds
      // late is worse than one that failed and said so.
      throw new Error(`rate limited by Spotify, retry after ${res.headers.get('Retry-After') ?? '?'}s`);
    }
    if (res.status === 404) {
      // Almost always "no active device": the app on the music machine is open
      // but idle. Callers that can wake it catch this by name.
      this.#device = null;
      throw new Error('NO_ACTIVE_DEVICE');
    }
    if (res.status === 401) {
      // The token went stale under us. Drop it so the next call re-mints.
      this.#token = '';
      throw new Error('Spotify rejected the token; it will be renewed on the next try.');
    }
    if (res.status === 403) {
      const detail = await res.text().catch(() => '');
      // The two 403s that actually happen, told apart by their bodies, because
      // "Forbidden" sends a volunteer to the wrong place entirely.
      if (/premium/i.test(detail)) {
        throw new Error('Spotify refused: remote control needs a PREMIUM account on the ' +
          'device being driven.');
      }
      throw new Error('Spotify refused (403). Usually this account is not on the ' +
        "developer app's user list, or it is not Premium. " + detail.slice(0, 120));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Spotify ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * The device to drive, by name.
   *
   * By name rather than by id, because ids change whenever the Spotify app
   * restarts and a volunteer can read a name off a screen and type it into
   * config.json. With no name configured we drive whatever is active, which is
   * right for the common case of exactly one machine running Spotify.
   */
  async #resolveDevice(): Promise<Device | null> {
    if (this.#device) return this.#device;

    const body = await this.#call('GET', '/me/player/devices') as { devices?: Device[] } | null;
    const devices = body?.devices ?? [];

    let found: Device | undefined;
    if (this.#deviceName) {
      const want = this.#deviceName.trim().toLowerCase();
      found = devices.find(d => d.name.trim().toLowerCase() === want);
      if (!found) {
        throw new Error(`no Spotify device called "${this.#deviceName}". Visible now: ` +
          `${devices.map(d => d.name).join(', ') || 'none'}. Open Spotify on the music machine.`);
      }
    } else {
      found = devices.find(d => d.is_active) ?? devices[0];
      if (!found) {
        throw new Error('no Spotify devices are visible. Open Spotify on the music machine ' +
          'and sign in as the house account.');
      }
    }

    if (found.is_restricted) {
      throw new Error(`Spotify reports "${found.name}" as restricted, which means it accepts ` +
        'no remote commands. Use the desktop app on the music machine.');
    }
    this.#device = found;
    return found;
  }

  /**
   * Make the configured device the active one.
   *
   * This is the fix for the commonest day-of failure: the Spotify app is open
   * on the music machine but nobody has pressed play since it booted, so
   * Spotify considers it to have no active device and every transport command
   * 404s. Transfer wakes it. `play: false` so waking is not itself an
   * unexpected burst of music in the room.
   */
  async wake(): Promise<void> {
    const device = await this.#resolveDevice();
    if (!device?.id) throw new Error('that Spotify device cannot be targeted by id');
    await this.#call('PUT', '/me/player', { device_ids: [device.id], play: false });
  }

  /** `?device_id=` on transport calls, when we know which one we mean. */
  async #target(): Promise<string> {
    const device = await this.#resolveDevice();
    return device?.id ? `?device_id=${encodeURIComponent(device.id)}` : '';
  }

  /**
   * Run a transport command, and if Spotify says there is no active device,
   * wake the configured one and try exactly once more. Once, deliberately: a
   * retry loop against a device that will never wake is how a desk hangs.
   */
  async #transport(method: string, path: string, body?: unknown): Promise<void> {
    try {
      await this.#call(method, `${path}${await this.#target()}`, body);
    } catch (err) {
      if ((err as Error).message !== 'NO_ACTIVE_DEVICE') throw err;
      await this.wake();
      await this.#call(method, `${path}${await this.#target()}`, body);
    }
  }

  // ---- MusicController ---------------------------------------------------

  async status(): Promise<MusicStatus> {
    let body: {
      is_playing?: boolean;
      device?: Device;
      progress_ms?: number;
      context?: { uri?: string };
      item?: {
        name?: string; duration_ms?: number;
        artists?: { name?: string }[];
        album?: { name?: string; images?: { url?: string; width?: number }[] };
      };
    } | null;

    try {
      body = await this.#call('GET', '/me/player') as typeof body;
    } catch (err) {
      // An idle device is not an error to report on a read: it is the normal
      // state before anyone has pressed play all morning.
      if ((err as Error).message === 'NO_ACTIVE_DEVICE') {
        return { playing: false, device: null, volume: null, now: null, context: null };
      }
      throw err;
    }

    if (!body) return { playing: false, device: null, volume: null, now: null, context: null };

    const item = body.item;
    let now: NowPlaying | null = null;
    if (item) {
      // Smallest image that is still recognizable: this is a 78px tile on the
      // house player and a thumbnail on the desk, over venue wifi. Spotify
      // returns them largest first.
      const images = item.album?.images ?? [];
      const art = images.length ? (images[images.length - 1]?.url ?? null) : null;
      now = {
        title: item.name ?? '',
        artist: (item.artists ?? []).map(a => a.name ?? '').filter(Boolean).join(', '),
        art,
        durationMs: item.duration_ms ?? 0,
        progressMs: body.progress_ms ?? 0,
        sampledAt: Date.now(),
      };
    }

    return {
      playing: body.is_playing === true,
      device: body.device?.name ?? null,
      volume: typeof body.device?.volume_percent === 'number' ? body.device.volume_percent : null,
      now,
      // The playlist name costs a second request, so the uri alone rides here
      // and the store shows the configured playlist's name from its own list.
      context: body.context?.uri ? { uri: body.context.uri, name: '' } : null,
    };
  }

  async play(opts?: { contextUri?: string }): Promise<void> {
    // An empty body resumes whatever was loaded; context_uri starts a playlist.
    // Sending context_uri on a plain resume would restart the playlist from the
    // top, which sounds exactly like a mistake to a room that was mid-song.
    const body = opts?.contextUri ? { context_uri: opts.contextUri } : undefined;
    await this.#transport('PUT', '/me/player/play', body);
  }

  async pause(): Promise<void> {
    try {
      await this.#transport('PUT', '/me/player/pause');
    } catch (err) {
      // Pausing something already paused is the desk agreeing with reality,
      // not a failure worth showing an operator mid-match.
      if (/already paused|Restriction violated/i.test((err as Error).message)) return;
      throw err;
    }
  }

  async next(): Promise<void> { await this.#transport('POST', '/me/player/next'); }
  async previous(): Promise<void> { await this.#transport('POST', '/me/player/previous'); }

  async setVolume(percent: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    const device = await this.#resolveDevice();
    // Phones and some speakers report supports_volume: false, and asking them
    // anyway earns a 403 that reads like an auth problem.
    if (device && device.supports_volume === false) {
      throw new Error(`"${device.name}" does not accept volume changes from Spotify. ` +
        'Set the level on the machine itself.');
    }
    const q = `?volume_percent=${v}` + (device?.id ? `&device_id=${encodeURIComponent(device.id)}` : '');
    await this.#call('PUT', `/me/player/volume${q}`);
  }

  async playlists(): Promise<{ uri: string; name: string }[]> {
    const body = await this.#call('GET', '/me/playlists?limit=50') as {
      items?: { uri?: string; name?: string }[];
    } | null;
    return (body?.items ?? [])
      .filter(p => !!p.uri)
      .map(p => ({ uri: p.uri!, name: p.name ?? p.uri! }));
  }
}

/** Null when it is not configured, which is a supported way to run: the clip
 *  player needs no service at all. */
export function createSpotify(
  cfg: SpotifyConfig, opts: SpotifyOptions = {},
): SpotifyController | null {
  if (!cfg.clientId || !cfg.refreshToken) return null;
  return new SpotifyController(cfg, opts);
}
