/**
 * Configuration, including credentials.
 *
 * `config.json` is gitignored and never committed. `config.example.json` is
 * the template. Nothing in this file should ever be logged verbatim. See
 * `redacted()`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceConfig } from './recorder.ts';

export interface Config {
  event: {
    /** TBA event key, e.g. "2026cacg". Required for any TBA publishing. */
    key: string;
    /**
     * The event name as it appears in video titles, following the official
     * FIRST channel convention: "Qualification 1 - {name}".
     */
    name: string;
    /** Used in livestream titles: "{year} {name} - Day {n}". */
    year: number;
    /** Linked in every video description. Blank to omit the line. */
    resultsUrl: string;
  };
  /**
   * Bonus RP thresholds.
   *
   * Configuration rather than constants: off-season events move these, and
   * the 2026 REBUILT numbers were still being argued over while this was
   * built. They travel on the state snapshot, so changing one here changes
   * the reducer, every badge, and the talent view together.
   */
  game: {
    rpEnergizedFuel: number;
    rpSuperchargedFuel: number;
    rpTraversalTower: number;
  };
  /**
   * Screens shown on their own monitors, with no OBS in front of them.
   *
   * A pit TV opens /s/watch and gets the finished picture. The field feed can
   * be a YouTube live URL, an MJPEG stream off a capture box or IP camera, or
   * any video URL a browser plays natively. Blank is fine: the overlay then
   * draws on the CalGames backdrop instead of a black rectangle.
   */
  kiosk: {
    fieldStreamUrl: string;
  };
  publish: {
    /** Master switch. Nothing uploads while this is false. */
    enabled: boolean;
    /**
     * deferred: queue during the event, upload after the venue closes.
     * trickle:  upload during the event; no upload starts while a match is
     *           live, and there is no bandwidth cap beyond that.
     * live:     upload as soon as a video is cut.
     * Default is deferred: the live stream must never compete with an upload.
     */
    mode: 'deferred' | 'trickle' | 'live';
    /** Queue a match video automatically when the score is posted. */
    autoQueueMatches: boolean;
    /**
     * Whether the automatic path queues practice matches too. Anything that
     * happens at the event should be recordable and postable, so this
     * defaults on; a manual queue from the desk ignores it entirely.
     */
    autoQueuePractice: boolean;
    /** Queue each finished arcade set as its own segment video. */
    autoQueueArcade: boolean;
    /** Which recorded source to cut from. The program feed, normally. */
    sourceId: string;
    /** Uploaded unlisted, flipped to public only once TBA linking succeeds. */
    privacy: 'private' | 'unlisted' | 'public';
    publicAfterLink: boolean;
    playlists: { match: string; segment: string };
    /**
     * Closing lines of every description. FIRST's own videos end
     * "(c) 2026 FIRST Robotics Competition", theirs to claim. CalGames is a
     * WRRF off-season event, so the default credits WRRF instead.
     */
    credit: string;
    copyright: string;
  };
  // The Cheesy Arena bridge is deliberately NOT configured here. It is a
  // launch flag (`--cheesy`). It needs FTA sign-off, so switching it on should
  // be an explicit act at the point of use rather than something inherited
  // from a file copied between machines. See docs/10-field-bridge.md.
  /**
   * Who paid for this, and what they were promised.
   *
   * Tier decides how often a sponsor comes round in the rotation, never how
   * big it is drawn. Empty is fine and means no sponsor graphics at all.
   */
  sponsors: {
    list: { id: string; name: string; tier?: 'title' | 'major' | 'supporting'; line?: string; logo?: string }[];
  };
  /**
   * The judged awards, with the definitions the committee wants "delivered to
   * teams in advance" also read on air. Empty is fine: the desk can still put
   * up a custom award typed on the day.
   */
  awards: {
    /**
     * The Judge Advisor's code. The award panel runs in two tiers: winner
     * entry, the award editor and the reveal need THIS code, while the rest
     * of the desk runs on the ordinary PIN. Ships with the default 1357
     * (change it for the event, like the desk PIN); an explicitly empty
     * value collapses the tier so the desk PIN governs awards too, which is
     * right for a small event. The env var JA_PIN overrides it.
     */
    pin?: string;
    list: { id: string; title: string; description?: string }[];
  };
  /**
   * The event-settings code: who may edit the content half of config on the
   * Event settings page (/s/setup). A third tier, separate from the desk PIN
   * and the JA code, because the person trusted to rename the event or
   * rewrite the sponsor list is the content lead, not every desk volunteer.
   * Ships with the default 4567 (change it for the event); an explicitly
   * empty value collapses the tier onto the desk PIN. The env var SETUP_PIN
   * overrides it.
   */
  setup: {
    pin?: string;
  };
  /**
   * Recognition and info slides: volunteer thank-yous, session announcements,
   * SystemCore info, food-truck hours. More get typed at the event and those
   * persist to data/slides.json, so this list is the ones known in advance.
   */
  slides: {
    list: { id: string; kind?: 'recognition' | 'info'; title: string; lines?: string[] }[];
  };
  /**
   * The day as a list. Empty is fine and means the desk shows no rundown.
   *
   * A matches block gives a COUNT rather than a duration: the length comes
   * from the pace model measuring real cycle time, because the difference
   * between a printed seven minutes and a measured nine is an hour by the end
   * of the day.
   */
  rundown: {
    segments: {
      id: string; label: string;
      kind: 'matches' | 'break' | 'ceremony' | 'selection' | 'awards' | 'gap';
      minutes?: number; matches?: number; audience?: string;
    }[];
  };
  /**
   * What the event offers, and where it is.
   *
   * On the screens rather than in a pre-event email, because the person who
   * needs a quiet room is deciding at 11am on the day, in a loud building,
   * from a phone. Empty by default: an event that lists nothing shows nothing,
   * which is honest. Never invent a service the event does not have.
   */
  accessibility: {
    /** Each is one line the audience can act on. */
    services: { label: string; detail: string }[];
    /** Who to ask. A name and a place beats a policy statement. */
    ask: string;
  };
  /**
   * FRC Nexus: what the QUEUERS are doing.
   *
   * The only source that knows a match is being called before the field does,
   * which is where the four minutes before a match live. Read-only, over the
   * internet, nothing to do with the field network. Starts when both fields
   * are set; useful only if the event is actually running its queueing on
   * Nexus, because otherwise the timings it returns look authoritative and
   * are not.
   */
  nexus: {
    /** From frc.nexus/api. Sent as the Nexus-Api-Key header. */
    apiKey: string;
    /** The Nexus event key, e.g. "2026cacg". Often the same as event.key. */
    eventKey: string;
  };
  /**
   * start.gg side-tournament bracket. Metadata only: round labels and
   * entrants for the arcade console's pre-fill; live scores stay
   * operator-authoritative (docs/05-arcade.md). Starts when both fields are
   * set; there is no field-safety concern here, so no launch flag.
   */
  startgg: {
    token: string;
    /** "tournament/calgames-2026-arcade/event/smash-singles" */
    eventSlug: string;
  };
  /**
   * Rolling-record inputs, used when the desk is launched with --record.
   * Each entry mirrors recorder.ts's SourceConfig: { id, label, role, input },
   * where role is 'program' (the composited broadcast, what uploads are cut
   * from) or 'iso' (a raw camera, replay source only) and input is the ffmpeg
   * input arguments as an array. --test-sources overrides this with synthetic
   * color bars.
   */
  recording: {
    sources: SourceConfig[];
  };
  /**
   * The room's PA, and only the room's PA. See docs/06: the music source is
   * physically absent from the stream bus, and nothing here can change that.
   * This is a control surface for the machine that already had the music on it.
   *
   * The clip player needs no configuration and no internet: walk-ups and
   * stingers play off this disk. The service below is only the background
   * playlist, and the desk runs fine with none configured.
   */
  audio: {
    enabled: boolean;
    spotify: {
      /** From the Spotify developer dashboard. Not a secret; PKCE needs no secret. */
      clientId: string;
      /** Minted once by `npm run auth:spotify`. */
      refreshToken: string;
      /**
       * The Spotify Connect device to drive: the music machine's own Spotify
       * app. Named rather than an id, because ids change when the app restarts
       * and a volunteer can read a name off the screen.
       */
      deviceName: string;
      /** The event playlist. "spotify:playlist:..." */
      playlistUri: string;
    };
  };
  youtube: { clientId: string; clientSecret: string; refreshToken: string };
  tba: { authId: string; authSecret: string; readKey: string };
  stream: {
    /** Registered on TBA so the event appears on GameDay. */
    webcastUrl: string;
  };
}

export const DEFAULTS: Config = {
  event: { key: '', name: 'CalGames', year: 2026, resultsUrl: '' },
  game: { rpEnergizedFuel: 100, rpSuperchargedFuel: 360, rpTraversalTower: 50 },
  kiosk: { fieldStreamUrl: '' },
  publish: {
    enabled: false,
    mode: 'deferred',
    autoQueueMatches: true,
    autoQueuePractice: true,
    autoQueueArcade: true,
    sourceId: 'program',
    privacy: 'unlisted',
    publicAfterLink: true,
    playlists: { match: '', segment: '' },
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  },
  recording: { sources: [] },
  audio: {
    enabled: true,
    spotify: { clientId: '', refreshToken: '', deviceName: '', playlistUri: '' },
  },
  sponsors: { list: [] },
  awards: { pin: '1357', list: [] },
  setup: { pin: '4567' },
  slides: { list: [] },
  rundown: { segments: [] },
  accessibility: { services: [], ask: '' },
  nexus: { apiKey: '', eventKey: '' },
  startgg: { token: '', eventSlug: '' },
  youtube: { clientId: '', clientSecret: '', refreshToken: '' },
  tba: { authId: '', authSecret: '', readKey: '' },
  stream: { webcastUrl: '' },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge the user's config over the defaults, so a partial config.json is
 * valid and new settings pick up sensible values without anyone editing.
 * Keys starting with "//" are comments in the example file and merge
 * harmlessly.
 */
function merge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null || v === undefined) continue;
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? merge(base[k], v) : v;
  }
  return out;
}

/**
 * Keep only the sections that are actually objects, and say so about the rest.
 *
 * merge() takes any JSON: a top-level array replaced the whole config, and a
 * section set to a string or a number replaced that section, so a plausible
 * hand edit ("publish": []) reached the show as a raw TypeError on a property
 * of undefined, at boot, on a laptop with nobody around who reads stacks. A
 * section that is not an object cannot mean anything, so it is dropped with a
 * line naming it and the defaults stand.
 */
function usableSections(parsed: unknown, expected: unknown = DEFAULTS, path = ''): Record<string, unknown> {
  if (!isPlainObject(parsed)) {
    console.warn('[config] config.json is not a JSON object, so none of it could be used. ' +
      'It should start with { and end with }. Using defaults.');
    return {};
  }
  const exp = isPlainObject(expected) ? expected : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith('//')) continue;                 // a comment in the example file
    const want = exp[k];
    const where = path ? `${path}.${k}` : k;
    if (isPlainObject(want) && !isPlainObject(v)) {
      console.warn(`[config] "${where}" should be a group of settings like { ... }, but it is ` +
        `${Array.isArray(v) ? 'a list' : typeof v}. Ignoring it and using the defaults for ${where}.`);
      continue;
    }
    // Recurse so a nested group gets the same treatment: publish.playlists set
    // to a string used to leave String.prototype.match standing in for a
    // YouTube playlist id, which is not a crash and not a value either.
    out[k] = isPlainObject(want) && isPlainObject(v) ? usableSections(v, want, where) : v;
  }
  return out;
}

/** The three the queue actually implements. Anything else silently meant "live". */
const PUBLISH_MODES = ['deferred', 'trickle', 'live'] as const;

export async function loadConfig(root: string): Promise<Config> {
  try {
    const raw = await readFile(join(root, 'config.json'), 'utf8');
    const cfg = merge(DEFAULTS, usableSections(JSON.parse(raw))) as Config;

    // A typo here used to behave as 'live': uploads starting mid-match and
    // competing with the stream for the venue uplink, which is the one thing
    // the deferred default exists to prevent.
    if (!(PUBLISH_MODES as readonly string[]).includes(cfg.publish.mode)) {
      console.warn(`[config] publish.mode "${String(cfg.publish.mode)}" is not one of ` +
        `${PUBLISH_MODES.join(', ')}. Using deferred, which uploads after the event.`);
      cfg.publish.mode = 'deferred';
    }
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run on a fresh machine. Say so now, or the missing publish
      // credentials get discovered at upload time.
      console.log('[config] no config.json, using defaults. Copy config.example.json to configure publishing.');
    } else {
      console.warn(`[config] config.json could not be read (${(err as Error).message}), using defaults.`);
    }
    return structuredClone(DEFAULTS);
  }
}

/** Safe to log, and safe to send to a browser surface. */
export function redacted(cfg: Config): Record<string, unknown> {
  const has = (s: string): string => s ? 'set' : 'missing';
  // recording is deliberately absent: an ffmpeg input arg can embed an IP
  // camera credential (rtsp://user:pass@...), and this object reaches browsers.
  return {
    event: cfg.event,
    publish: cfg.publish,
    stream: cfg.stream,
    audio: {
      enabled: cfg.audio.enabled,
      spotify: {
        clientId: has(cfg.audio.spotify.clientId),
        refreshToken: has(cfg.audio.spotify.refreshToken),
        deviceName: cfg.audio.spotify.deviceName,
        playlistUri: cfg.audio.spotify.playlistUri,
      },
    },
    youtube: { clientId: has(cfg.youtube.clientId), clientSecret: has(cfg.youtube.clientSecret), refreshToken: has(cfg.youtube.refreshToken) },
    tba: { authId: has(cfg.tba.authId), authSecret: has(cfg.tba.authSecret), readKey: has(cfg.tba.readKey) },
    startgg: { token: has(cfg.startgg.token), eventSlug: cfg.startgg.eventSlug },
    nexus: { apiKey: has(cfg.nexus.apiKey), eventKey: cfg.nexus.eventKey },
  };
}

/** What's missing before publishing can actually work. */
export function publishReadiness(cfg: Config): { youtube: string[]; tba: string[] } {
  const youtube: string[] = [];
  if (!cfg.youtube.clientId) youtube.push('youtube.clientId');
  if (!cfg.youtube.clientSecret) youtube.push('youtube.clientSecret');
  if (!cfg.youtube.refreshToken) youtube.push('youtube.refreshToken');

  const tba: string[] = [];
  if (!cfg.event.key) tba.push('event.key');
  if (!cfg.tba.authId) tba.push('tba.authId');
  if (!cfg.tba.authSecret) tba.push('tba.authSecret');

  return { youtube, tba };
}
