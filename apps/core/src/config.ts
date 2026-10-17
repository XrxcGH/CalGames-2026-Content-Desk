/**
 * Configuration, including credentials.
 *
 * `config.json` is gitignored and never committed. `config.example.json` is
 * the template. Nothing in this file should ever be logged verbatim. See
 * `redacted()`.
 */

import { CALGAMES_2026_TEAMS } from './teams.ts';
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
  // The Cheesy Arena bridge is deliberately NOT configured here, and neither
  // is the video switcher. The desk finds both on the network by itself
  // (--discover, which the launcher passes), and an address the search cannot
  // find is typed on the Event settings page, which keeps it in
  // data/settings.json (settings.ts): never in a file copied between
  // machines, and never something a volunteer edits by hand. The bridge stays
  // receive-only and GET-only either way. See docs/10-field-bridge.md.
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
   * The teams at the event: names, pit codes, and the label printed in place
   * of a second robot's placeholder number (9999 prints as 100B). Ships with
   * CalGames 2026; another event replaces the list. See teams.ts.
   */
  teams: {
    list: { number: number; name: string; label?: string; pit?: string }[];
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
   * The OBS WebSocket connection: automatic camera cuts, Take to program on
   * the replay console, the stream button and the doors check's OBS rows.
   *
   * Here as well as the --obs flag because the packaged exe has no command
   * line: its launcher passes no --obs, so a desk deployed exactly the way the
   * handbook says could never drive OBS, and every replay Take answered NOT on
   * air. Unlike the field bridge there is no FTA sign-off to protect: OBS is
   * the desk's own software on the desk's own laptop, so config alone may
   * switch it on, the way it does for Nexus.
   *
   * `password` is the WebSocket server password. It lives here with the other
   * credentials and nowhere else: never argv (visible in Task Manager and the
   * shell history), never a query string, never redacted() or the settings
   * page. The OBS_PASSWORD environment variable overrides it.
   */
  obs: {
    enabled: boolean;
    /** host:port of the WebSocket server. OBS on this laptop is 127.0.0.1:4455. */
    host: string;
    password: string;
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
  /*
   * The people who make the event happen and never get a match of their own:
   * the WRRF Board, the interns, the planning committee, the volunteers, the
   * host school. They rotate on the side screens from the first boot, so the
   * thank-yous do not depend on somebody remembering to type them on Friday.
   * Generic on purpose: no individual is named here, because a name invented
   * in code is a name that can be wrong on a screen.
   *
   * The last one advertises the shout-out form. It lands on the slide pane,
   * which is exactly where the side screen's corner QR switches to that form.
   */
  slides: {
    list: [
      { id: "thanks-wrrf-board", kind: "recognition", title: "Thank you, WRRF Board of Directors",
        lines: ["For making CalGames possible", "Western Region Robotics Forum"] },
      { id: "thanks-wrrf-interns", kind: "recognition", title: "Thank you, WRRF Interns",
        lines: ["For the hours behind the scenes", "that made this weekend run"] },
      { id: "thanks-planning-committee", kind: "recognition", title: "Thank you, CalGames Planning Committee",
        lines: ["Months of planning", "for three days of robots"] },
      { id: "thanks-volunteers", kind: "recognition", title: "Thank you, volunteers",
        lines: ["Referees, scorekeepers, queuers,", "inspectors, judges, field reset,", "safety, and everyone in a lanyard"] },
      { id: "thanks-host", kind: "recognition", title: "Thank you, Woodside High School",
        lines: ["For hosting CalGames 2026"] },
      { id: "how-to-shout-out", kind: "info", title: "Send a shout-out",
        lines: ["Scan the code on this screen", "to thank a volunteer, a team or a mentor"] },
    ],
  },
  teams: { list: CALGAMES_2026_TEAMS },
  rundown: { segments: [] },
  accessibility: { services: [], ask: '' },
  // CalGames queues on Nexus (frc.nexus/cacg). Nexus keys events the way TBA
  // does, so only the API key is left to fill in; with no key the adapter
  // never starts, so this default cannot reach out on its own.
  nexus: { apiKey: '', eventKey: '2026cacg' },
  startgg: { token: '', eventSlug: '' },
  // Off until somebody says otherwise: a desk that dials OBS on a laptop with
  // no OBS just logs reconnects all day, and the doors check would read it as
  // a broken OBS rather than an absent one.
  obs: { enabled: false, host: '127.0.0.1:4455', password: '' },
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
 *
 * `dropped` collects the path of each group thrown away, for the Start here
 * box and the doors check: a line in the log was all "obs": true ever got,
 * and OBS stayed off with "config.json read and in use" on every screen.
 */
function usableSections(
  parsed: unknown, expected: unknown = DEFAULTS, path = '', dropped: string[] = [],
): Record<string, unknown> {
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
      // Only a name the desk itself defines goes to a screen, never the value.
      if (Object.hasOwn(exp, k)) dropped.push(where);
      continue;
    }
    // Recurse so a nested group gets the same treatment: publish.playlists set
    // to a string used to leave String.prototype.match standing in for a
    // YouTube playlist id, which is not a crash and not a value either.
    out[k] = isPlainObject(want) && isPlainObject(v) ? usableSections(v, want, where, dropped) : v;
  }
  return out;
}

/** The three the queue actually implements. Anything else silently meant "live". */
const PUBLISH_MODES = ['deferred', 'trickle', 'live'] as const;

/**
 * Where in config.json a parse error is, as a line number, without ever
 * printing the parser's message.
 *
 * V8's JSON errors quote up to ten characters either side of the mistake, and
 * the commonest mistake in this file is a password typed without quotes, or
 * pasted with curly ones: the message carried most of the OBS password into
 * the launcher window and desk-log.txt, the file a radio call asks for first.
 */
export function jsonErrorLine(message: string, raw: string): number | null {
  const line = /\(line (\d+) column \d+\)/.exec(message);
  if (line) return Number(line[1]);
  const pos = /at position (\d+)/.exec(message);
  const at = pos ? Number(pos[1]) : (() => {
    // The quoted context can cross a line break, and usually does: a value
    // typed without quotes at the end of a line is followed by "\n}". With
    // `.` here it matched nothing, so the commonest typos (an unquoted
    // password, curly quotes) said "a typo" with no line to look at.
    const ctx = /\.\.\."([\s\S]+?)"\.\.\./.exec(message)?.[1]
      ?? /"([\s\S]+)" is not valid JSON/.exec(message)?.[1];
    const start = ctx ? raw.indexOf(ctx) : -1;
    if (start < 0) return -1;
    // The context opens up to ten characters BEFORE the mistake, which can be
    // the line above it. The mistake is the token V8 names, so find that.
    const token = /^Unexpected token '([\s\S])'/.exec(message)?.[1];
    const hit = token ? raw.indexOf(token, start) : -1;
    return hit >= start && hit < start + ctx!.length ? hit : start;
  })();
  return at >= 0 ? raw.slice(0, at).split('\n').length : null;
}

/**
 * What became of config.json at boot, for the screens rather than the log.
 *
 * A file the parser refused used to be one line in desk-log.txt, and then
 * every code, the awards list and OBS were silently back to their defaults:
 * the Start here box said "still on the shipped default" as if nobody had
 * tried, and the doors check called OBS switched off. The lead had changed
 * all of it, and nothing they would look at said the change never landed.
 * So loadConfig keeps its verdict here, and the Start here box and the doors
 * check read it (see configFileVital in vitals.ts for the words).
 *
 * Never the file's text: a line number, and the names of sections the desk
 * itself defines. The commonest typo is in a password.
 */
export interface ConfigFileReport {
  /**
   * unread: loadConfig has not run (a test, or a tool building its own Config).
   * missing: no config.json, so everything is the shipped default; normal on
   * a fresh install. read: in use. unusable: the file is there and NONE of it
   * is in use.
   */
  state: 'unread' | 'missing' | 'read' | 'unusable';
  /** Why an unusable file is unusable. */
  reason?: 'typo' | 'not-an-object' | 'unreadable';
  /** Where the typo is, when the parser could say. */
  line?: number | null;
  /** Top-level sections written more than once. JSON keeps only the last. */
  duplicates: { section: keyof Config; lines: number[] }[];
  /**
   * Groups of settings the file gave something other than a group ("obs":
   * true), by path ("obs", "publish.playlists"), which the desk dropped for
   * its defaults. Only the desk's own names; never the value written there.
   */
  ignored?: string[];
}

let lastConfigFile: ConfigFileReport = { state: 'unread', duplicates: [] };

/** How the most recent loadConfig went. Module state because the running desk loads once. */
export const configFileReport = (): ConfigFileReport => lastConfigFile;

/**
 * Sections written more than once at the top of the file, with the line of
 * each.
 *
 * JSON.parse keeps the LAST of a repeated key and says nothing. The copied
 * example file already has an "obs" block near the end, so pasting the
 * handbook's "obs" line in near the top, comma and all, made a file that
 * parsed perfectly and left OBS off: the example's later enabled: false won.
 * Only run on text JSON.parse accepted, so this can be a plain scan. Only the
 * desk's own section names are reported, so nothing typed into the file is
 * ever repeated back.
 */
export function repeatedSections(raw: string): { section: keyof Config; lines: number[] }[] {
  const at = new Map<string, number[]>();
  let depth = 0;
  let line = 1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\n') line++;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      // A JSON string cannot hold a raw newline, so nothing in here moves the line.
      let end = i + 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
      const token = raw.slice(i, end + 1);
      i = end;
      if (depth !== 1) continue;
      let k = end + 1;
      while (k < raw.length && ' \t\r\n'.includes(raw[k]!)) k++;
      if (raw[k] !== ':') continue;                   // a value, not a key
      let key: unknown;
      try { key = JSON.parse(token); } catch { continue; }
      if (typeof key !== 'string' || !Object.hasOwn(DEFAULTS, key)) continue;
      at.set(key, [...(at.get(key) ?? []), line]);
    }
  }
  return [...at]
    .filter(([, lines]) => lines.length > 1)
    .map(([section, lines]) => ({ section: section as keyof Config, lines }));
}

export async function loadConfig(root: string): Promise<Config> {
  let raw = '';
  lastConfigFile = { state: 'unread', duplicates: [] };
  try {
    // A byte-order mark is not JSON, and JSON.parse refuses the whole file
    // over it. Notepad's "UTF-8 with BOM" and Windows PowerShell's
    // Set-Content -Encoding UTF8 both write one, so a correct file saved
    // either way read as "not valid JSON near line 1" and none of it applied.
    raw = (await readFile(join(root, 'config.json'), 'utf8')).replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      lastConfigFile = { state: 'unusable', reason: 'not-an-object', duplicates: [] };
    } else {
      const duplicates = repeatedSections(raw);
      for (const d of duplicates) {
        console.warn(`[config] "${d.section}" appears ${d.lines.length} times in config.json `
          + `(lines ${d.lines.join(', ')}). Only the last one is used.`);
      }
      lastConfigFile = { state: 'read', duplicates };
    }
    const ignored: string[] = [];
    const cfg = merge(DEFAULTS, usableSections(parsed, DEFAULTS, '', ignored)) as Config;
    if (ignored.length && lastConfigFile.state === 'read') lastConfigFile = { ...lastConfigFile, ignored };

    // A typo here used to behave as 'live': uploads starting mid-match and
    // competing with the stream for the venue uplink, which is the one thing
    // the deferred default exists to prevent.
    if (!(PUBLISH_MODES as readonly string[]).includes(cfg.publish.mode)) {
      console.warn(`[config] publish.mode "${String(cfg.publish.mode)}" is not one of ` +
        `${PUBLISH_MODES.join(', ')}. Using deferred, which uploads after the event.`);
      cfg.publish.mode = 'deferred';
    }
    cfg.obs = usableObs(cfg.obs);
    return cfg;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run on a fresh machine. Say so now, or the missing publish
      // credentials get discovered at upload time.
      lastConfigFile = { state: 'missing', duplicates: [] };
      console.log('[config] no config.json, using defaults. Copy config.example.json to configure publishing.');
    } else if (err instanceof SyntaxError) {
      const line = jsonErrorLine(err.message, raw);
      lastConfigFile = { state: 'unusable', reason: 'typo', line, duplicates: [] };
      console.warn(`[config] config.json is not valid JSON${line ? ` near line ${line}` : ''}: `
        + 'check the quotes and commas there (text values need straight "double quotes"). '
        + 'Using defaults, so nothing in it is in effect.');
    } else {
      lastConfigFile = { state: 'unusable', reason: 'unreadable', duplicates: [] };
      console.warn(`[config] config.json could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}), using defaults.`);
    }
    return structuredClone(DEFAULTS);
  }
}

/** OBS's own default WebSocket port, which its Connect Info dialog shows. */
const OBS_PORT = 4455;

/**
 * "host:port" for the OBS WebSocket, or null when it cannot be one.
 *
 * ObsClient dials `ws://${host}`. new WebSocket() THROWS on a URL it cannot
 * parse (a stray space, a port past 65535), synchronously, at boot, which
 * took the whole desk down before a single screen came up. A host pasted as
 * "ws://127.0.0.1:4455/" does not throw: it dials a machine called "ws",
 * forever, and OBS just reads as down. So a leading ws:// and a trailing
 * slash are forgiven, a bare host gets OBS's own port (a URL parser would
 * otherwise hand it port 80, where OBS never listens), and anything else
 * that is not a plain host:port is refused.
 */
export function obsHost(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
  if (!s) return null;
  // A URL parser forgives these and quietly changes the address: an empty
  // "?" or "#" swallows the port, and a host of bare digits ("4455", the
  // port typed into the host box) is read as an IPv4 number, 0.0.17.103.
  if (/[?#@]/.test(s) || /^\d+(:\d*)?$/.test(s)) return null;
  let url: URL;
  try { url = new URL(`ws://${s}`); } catch { return null; }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const port = /:(\d{1,5})$/.exec(s)?.[1];
  if (port === undefined) return `${url.hostname}:${OBS_PORT}`;
  const n = Number(port);
  return n >= 1 && n <= 65535 ? `${url.hostname}:${n}` : null;
}

/**
 * The obs section, checked field by field like every hand-edited section.
 *
 * No warning here ever prints the password, whatever shape it arrived in:
 * these lines go to the launcher window, which is on screen at the desk.
 */
function usableObs(raw: Config['obs']): Config['obs'] {
  const o = raw as unknown as Record<string, unknown>;
  const out = { ...DEFAULTS.obs };

  // "true" in quotes is a slip anybody makes in a JSON file, and what it
  // means is not in doubt. Anything else unclear leaves OBS off and says so.
  const on = o['enabled'];
  if (typeof on === 'boolean') out.enabled = on;
  else if (typeof on === 'string' && /^(true|false)$/i.test(on.trim())) {
    out.enabled = on.trim().toLowerCase() === 'true';
  } else if (on !== undefined) {
    console.warn('[config] obs.enabled should be true or false. Leaving the OBS connection off.');
  }

  // The bad value is not echoed: somebody who tried ws://:secret@host has
  // put the password in it.
  const host = obsHost(o['host']);
  if (host) out.host = host;
  else if (o['host'] !== undefined && o['host'] !== '') {
    console.warn(`[config] obs.host is not a host:port like ${DEFAULTS.obs.host}. ` +
      `Using ${DEFAULTS.obs.host}, which is OBS on this laptop.`);
  }

  // Digits typed without quotes arrive as a number; that is still the
  // password somebody meant.
  const pw = o['password'];
  if (typeof pw === 'string') out.password = pw;
  else if (typeof pw === 'number' && Number.isFinite(pw)) out.password = String(pw);
  else if (pw !== undefined && pw !== null) {
    console.warn('[config] obs.password should be the text from OBS\'s Connect Info, in quotes. ' +
      'Ignoring it, so OBS will refuse the desk if it has a password set.');
  }
  return out;
}

export interface ObsPlan {
  /** Whether to dial OBS at all. */
  enabled: boolean;
  host: string;
  /** Absent when neither OBS_PASSWORD nor config.json has one. */
  password?: string;
  /** One line for the boot log, saying where each setting came from. Never the password. */
  summary: string;
}

/**
 * Whether and how to reach OBS, from the launch flags, config.json and the
 * environment, decided in one place so the boot log can say where each part
 * came from. The --obs flag still works for a from-source start; the config
 * switch is the one the exe has. The password never arrives as a flag.
 */
export function obsPlan(
  cfg: Config,
  opts: { flag?: boolean; host?: string; env?: Record<string, string | undefined> } = {},
): ObsPlan {
  const env = opts.env ?? process.env;
  const enabled = !!opts.flag || cfg.obs.enabled === true;
  const host = opts.host || cfg.obs.host || DEFAULTS.obs.host;
  const fromEnv = env['OBS_PASSWORD'] || '';
  const password = fromEnv || cfg.obs.password || '';
  const why = [
    opts.flag ? 'turned on by --obs' : 'turned on in config.json',
    `host from ${opts.host ? '--obs-host' : 'config.json'}`,
    fromEnv ? 'password from OBS_PASSWORD' : password ? 'password from config.json' : 'no password',
  ].join(', ');
  return {
    enabled, host,
    ...(password ? { password } : {}),
    summary: enabled
      ? `connecting to ${host} (${why})`
      : 'off, set "obs": { "enabled": true } in config.json to let the desk drive OBS',
  };
}

/**
 * A practice session, by the launch flag that started it, or null for the
 * real show.
 *
 * index.ts decides practice from these same three flags (its rehearsalTag),
 * and practice changes what the day keeps: the log is set aside for the next
 * boot's rebuild, no match video is queued, and the Judge Advisor's staged
 * winners go to a practice file. None of that showed anywhere, and a
 * double-click on a desk that is already up only reopens it, so a desk left
 * in rehearsal on Friday night ran Saturday's show in rehearsal. The Start
 * here box, the doors check and the launcher (through the open /api/info)
 * read this to say so. Read from argv like index.ts's own has(), so the two
 * can never disagree about which session this is.
 */
export type LaunchMode = 'demo' | 'replay' | 'rehearsal';

export function launchMode(argv: readonly string[] = process.argv): LaunchMode | null {
  if (argv.includes('--demo')) return 'demo';
  if (argv.includes('--replay')) return 'replay';
  if (argv.includes('--rehearsal')) return 'rehearsal';
  return null;
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
