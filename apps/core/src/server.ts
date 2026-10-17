/**
 * HTTP + WebSocket server. Serves every surface and fans out the event bus.
 *
 * Deliberately small: node:http, one `ws` dependency, no framework. This has
 * to be debuggable at 11pm on a Saturday by whoever is still awake.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
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
import {
  DEFAULTS, configFileReport, launchMode, redacted, publishReadiness,
  type Config, type ConfigFileReport, type LaunchMode,
} from './config.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { ScreenRegistry, isProgramPage, plainAddr } from './screens.ts';
import { DEFAULT_CODES, Settings, SettingsError, type CodeName, type ConnectionsPatch } from './settings.ts';
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
import type { Awards } from './awards.ts';
import { DESK_EDITABLE_SECTIONS, type EventContent } from './content.ts';
import type { Slides } from './slides.ts';
import { CONTROL_ACTIONS, controlGroups } from './control-map.ts';
import {
  configFileVital, forAnotherComputer, modeVital, screensVital, switcherVital, whereIs,
  type AtemView, type FieldView, type Vitals,
} from './vitals.ts';
import { matchUnderway } from './publish/queue.ts';

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
  '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  /*
   * The house audio library. Every type the clip sniffer accepts, because a
   * file it accepts on upload has to be playable afterwards.
   *
   * There were none of these, so every walk-up and stinger was served as
   * application/octet-stream. Chrome usually sniffs its way past that; Safari
   * does not reliably, and an iPad is a machine somebody at this event will
   * point at /s/house. The failure mode is the worst kind: the clip uploads,
   * the library lists it, the desk fires it during an alliance introduction,
   * and the room gets silence.
   */
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.opus': 'audio/ogg',
};

/**
 * Every screen the desk serves, for the full list at the bottom of the front
 * page and the startup log.
 *
 * The notes are read by a volunteer who has never seen any of this, so they
 * say what each page is FOR in plain words. They used to say "OBS Browser
 * Source" on the first row of the page, which is jargon to anyone and wrong
 * for an event with no OBS: the AV coordinator opened that row in a browser,
 * got a transparent page, which a browser paints white, and gave up. OBS
 * wording now lives only in the front page's "If you use OBS" note.
 */
export const SURFACES = [
  { id: 'program', group: 'On air', name: 'Program overlay', note: 'The broadcast graphic, 1920x1080: every match screen, the final score, alliance selection, awards and slides, switching on their own or taken by hand from the desk. In a plain browser it draws on black, for a video switcher to key.' },
  { id: 'tele',    group: 'On air', name: 'Telestrator render', note: "The analyst's drawings, to lay over the replay." },
  { id: 'arcade',  group: 'On air', name: 'Arcade overlay',  note: 'Game sets and standings for the gaps between matches.' },
  { id: 'trivia',  group: 'On air', name: 'Trivia overlay',  note: 'Crowd trivia: question, countdown, answers, leaderboard. Draws its own background.' },
  { id: 'side',    group: 'On air', name: 'Side screen',     note: 'Who plays next and the rankings, rotating on its own. Draws its own background.' },
  { id: 'desk',    group: 'Run the show', name: 'Desk console', note: 'The main control panel. Runs everything, keyboard-first, even with no field connection.' },
  { id: 'talent',  group: 'Run the show', name: 'Talent view', note: "The announcer's tablet: teams, ranks, live ranking-point progress in words, and how to say each name." },
  { id: 'replay',  group: 'Run the show', name: 'Replay console', note: 'Cut replays off the match timeline. Interesting moments are already marked.' },
  { id: 'draw',    group: 'Run the show', name: 'Telestrator pad', note: "For the analyst's tablet. Draw on the picture the audience is seeing." },
  { id: 'arcadedesk', group: 'Run the show', name: 'Arcade console', note: 'Score the game sets by hand. 2 players versus, 3-4 free-for-all.' },
  { id: 'triviadesk', group: 'Run the show', name: 'Trivia host', note: "Open a question, reveal the answer, next. That's the whole job." },
  { id: 'house',   group: 'Run the show', name: 'House audio player', note: 'Open this ON THE MUSIC MACHINE, the one wired to the PA and to nothing else. It plays the walk-ups and stingers the desk fires. Never add it to OBS: it refuses to play there, because its music belongs to the room and never to the stream.' },
  { id: 'var',     group: 'Run the show', name: 'Head referee review', note: 'Step through the recording frame by frame. It can only look: it cannot cut, put anything on screen, publish or reach the field.' },
  { id: 'media',   group: 'Before the event', name: 'Team media', note: 'Upload robot photos for the pre-match overview. A team with no photo gets its number instead.' },
  { id: 'cards',   group: 'Before the event', name: 'Post-match cards', note: 'Square result graphics for social media. They make themselves when a score posts.' },
  { id: 'awards', group: 'Run the show', name: 'Judge Advisor: awards', note: "For the Judge Advisor only. Opens with the awards code, not the desk PIN: load each award's winner as judging wraps up, and hand the code to the desk right before the ceremony. Winners stay off every screen until the reveal." },
  { id: 'setup', group: 'Before the event', name: 'Event settings', note: 'For the content lead. Opens with the settings code, not the desk PIN: the codes, the field and switcher addresses, the event name, sponsors, run of show, scoring thresholds and accessibility services, changed live. No code or password is ever shown back.' },
  { id: 'testcard', group: 'Before the event', name: 'Screen test card', note: 'Full-screen this on any display being set up: the LED wall, a projector, a pit TV. Edges, safe areas, a circle that must look round, color and gray ramps, and a live clock so a frozen picture shows itself.' },
  { id: 'quiz',    group: 'For the audience', name: 'Trivia play', note: 'The phone page the crowd joins from. The trivia screen shows its address.' },
  // The shout-out form was missing from this list entirely, which made it the
  // one audience page nobody could find: no row here, no QR anywhere.
  { id: 'gp',      group: 'For the audience', name: 'Send a shout-out', note: 'Anyone in the building thanks a volunteer, a team, a mentor. Every one is read at the desk before it goes near a screen. The side screens show its QR whenever a slide is up.' },
  { id: 'poster',  group: 'Before the event', name: 'QR posters', note: 'Printable signs for the doors, stands and pits: send a shout-out, play trivia, when do we play. Print from the desk machine once it is on the event network, so the codes carry the right address.' },
  { id: 'watch',   group: 'On a pit monitor', name: 'Pick a screen', note: "Every full-screen picture below, in one place, with the desk's address on this network. Open it on the computer feeding a projector or TV." },
  // One row per screen a display can show, so the exact URL can be copied
  // rather than assembled. `path` carries the query string the index would
  // otherwise have no way to express. Word for word what the /s/watch chooser
  // says (its PIT_SCREENS), which front-page.test.ts holds them to.
  { id: 'watch', path: '/s/watch?screen=program', group: 'On a pit monitor', name: 'Program',
    note: 'The main show picture: who is playing, the live score, the final score. It changes on its own as the field runs.' },
  { id: 'watch', path: '/s/watch?screen=side', group: 'On a pit monitor', name: 'Side screen',
    note: 'Who is on deck and the current rankings, rotating. Built to be read from across the room.' },
  { id: 'watch', path: '/s/watch?screen=next', group: 'On a pit monitor', name: 'When do we play?',
    note: 'When each team plays next, with start times that follow the field running early or late. Also fine on a phone.' },
  { id: 'watch', path: '/s/watch?screen=trivia', group: 'On a pit monitor', name: 'Trivia',
    note: 'The crowd game. Shows the join code between questions.' },
  { id: 'watch', path: '/s/watch?screen=arcade', group: 'On a pit monitor', name: 'Arcade',
    note: 'Scores from the side tournament, for a TV beside the game consoles.' },
  { id: 'next',    group: 'For the audience', name: 'When do we play?', note: 'When each team plays next, on any phone, with start times that follow the field running early or late. Side screens show its QR.' },
  { id: 'remote',  group: 'Run the show', name: 'Phone remote', note: 'Run the show from a phone. Big targets, asks for the desk PIN.' },
] as const;

/** Where a surface actually lives. Most are /s/{id}; some carry a query. */
export const surfacePath = (s: { id: string; path?: string }): string => s.path ?? `/s/${s.id}`;

/** Text made safe for the front page, which prints the event's own words (a match name). */
const escHtml = (t: string): string => t.replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * How the full list on the front page is grouped, titled and ordered.
 *
 * The keys are SURFACES' own group names, which surfaces/watch/index.html
 * also names, so only the words a volunteer reads change here. The order puts
 * the full-screen pictures first and the see-through OBS layers last: the
 * layers were first, and a browser paints a page with no background white.
 */
export const SCREEN_GROUPS: readonly { group: string; title: string; intro: string }[] = [
  { group: 'On a pit monitor', title: 'On a projector or TV',
    intro: 'Full-screen pictures with their own background. Open one on the computer whose HDMI '
      + 'goes to that screen, then press F11. No PIN.' },
  { group: 'Run the show', title: 'Run the show',
    intro: 'Control pages for the crew. Each asks for the desk PIN, except the Judge Advisor page, '
      + 'which has its own code.' },
  { group: 'Before the event', title: 'Before the event',
    intro: 'Robot photos, social media cards, event settings, door signs, and a test picture for '
      + 'each display being set up.' },
  { group: 'For the audience', title: 'On phones in the stands',
    intro: 'Open to anyone, no PIN. The side screens and the posters show QR codes for these.' },
  // Not "layers" for the whole group: trivia and the side screen paint their
  // own background in every mode, OBS included, so they are pictures to cut
  // to. Their rows say so, and the intro points at those words rather than
  // naming pages a later edit could move.
  //
  // In a plain browser these draw on black (C8): a switcher's luma key drops
  // the black out, and a projector shows graphics on black, so the one
  // address is safe in either place. Only OBS gets them see-through.
  { group: 'On air', title: 'Graphics for a video switcher or OBS',
    intro: 'Made to sit over a camera picture. In a plain browser they draw on black, which a video '
      + "switcher's key drops out; in OBS they are see-through by themselves. The ones that say "
      + '"Draws its own background" are full pictures to cut to. For a projector or TV, use the '
      + 'first list instead: it puts the same pictures on a full-screen background.' },
];

/**
 * The few big choices at the top of the front page: what a first-timer is
 * most likely here to do, in their words rather than the desk's. Everything
 * else is in the full list further down, folded away.
 */
export const FRONT_CHOICES: readonly { href: string; title: string; text: string }[] = [
  { href: '/s/desk', title: 'This laptop runs the show',
    text: 'The desk console: matches, screens, replays and walk-up music, all in one place. '
      + 'Asks for the desk PIN.' },
  // The AV kit's case: a computer's HDMI goes through a converter into the
  // switcher, which keys it over the cameras. That computer used to show
  // Cheesy Arena's own score overlay, and it still can: the program page
  // keeps Cheesy's loaded behind it and hands over by itself whenever the
  // desk stops answering (C7), so opening this costs the stream nothing.
  { href: '/s/program', title: 'Put the graphics into the video switcher',
    text: "On the computer that feeds the switcher's overlay input (the one that shows Cheesy Arena's "
      + 'score overlay today), open this and press F11 for full screen. While the desk is working, its '
      + "graphics replace Cheesy's overlay, and Cheesy's comes back by itself if the desk stops, as long as "
      + 'that computer is on the field network. No PIN.' },
  { href: '/s/watch', title: 'Put the show on a projector or TV',
    text: 'Open this on the computer whose HDMI cable goes to that screen, pick what to show, '
      + 'then press F11 for full screen. No PIN.' },
  { href: '/s/talent', title: 'Announcer tablet',
    text: 'Who is playing, their ranks, and how to say each name, live. Asks for the desk PIN.' },
  { href: '/s/awards', title: 'Judge Advisor',
    text: 'Load the award winners. Opens with the awards code, not the desk PIN, and keeps every '
      + 'winner off the screens until the reveal.' },
];

/**
 * "Something not working?" on the front page: what a volunteer actually runs
 * into, as what they see and then what to do, in a line or two each.
 *
 * It replaces "see the handbook, chapter 11" as the only help. The handbook is
 * a 43-page PDF, and the AV crew who met a white screen on a test night gave
 * up trying to troubleshoot through it. Each answer here was checked against
 * the code it describes; change the code, change the answer. Every id is an
 * anchor (/#help-white), so another page can link straight to one.
 *
 * Shown to everyone on the venue Wi-Fi, so nothing here may name a code.
 *
 * `deskLabels` lists the desk console's own words an answer quotes, so a test
 * can hold the two together: an answer that names a button the console no
 * longer has sends a volunteer looking for something that is not there.
 */
export const FRONT_HELP: readonly {
  id: string; see: string; fix: string; deskLabels?: readonly string[];
}[] = [
  { id: 'white', see: 'A white page instead of the show',
    fix: 'That is a see-through graphic made for OBS, opened in a plain browser: the address has '
      + '<code>?key=alpha</code> on it, which is only for OBS. Take that off, and the graphics draw on '
      + 'black, ready for a video switcher. For a projector or TV, use '
      + '<a href="/s/watch">Put the show on a projector or TV</a> instead.' },
  { id: 'empty', see: 'The screen is dark, or shows only the backdrop',
    fix: 'It is working and waiting for a match. The field has not loaded one yet (its Test Match '
      + 'does not count): ask the scorekeeper. With no field, open the desk console, then '
      + '<b>Field down? Run matches by hand</b>, then <b>Load a match by hand</b>. To check a screen '
      + 'now, <a href="/s/desk#sec-sample">fill the screens with sample data</a>.',
    deskLabels: ['Field down? Run matches by hand', 'Load a match by hand', 'id="sec-sample"'] },
  { id: 'stuck', see: 'The screen stays on one picture and does not follow the match',
    fix: 'Somebody picked a screen by hand, which holds it there. In the desk console, next to '
      + '<b>Main screen</b>, press <b>Auto</b>.',
    deskLabels: ['Main screen'] },
  { id: 'reach', see: 'A TV, phone or other laptop cannot open the address',
    fix: 'Type the address from the Start here box, never localhost: localhost only works on the desk '
      + 'laptop itself. On the desk laptop, when Windows asks about Node.js, press <b>Allow access</b>. '
      + 'If that box was missed, search Start for <b>Allow an app through Windows Firewall</b>, press '
      + '<b>Change settings</b>, and tick <b>Node.js JavaScript Runtime</b>. Guest Wi-Fi often keeps '
      + "devices apart: use the event's own network or a cable." },
  // No command prompt and no flag any more: the desk looks for the field by
  // itself while it runs (the finder), and the address, when the search
  // cannot find it, is typed on the settings page.
  { id: 'field', see: 'Field: searching, not connected, or not answering (the status at the top of this page)',
    fix: 'Searching: the desk looks for the field by itself and connects as soon as the field is up; '
      + 'nothing needs restarting. Still searching once the field is running: ask the FTA for the '
      + "field's address and type it on <a href=\"/s/setup#connections\">Event settings</a> (the settings code "
      + 'opens it). Not connected and not searching: end the desk in Task Manager (Ctrl+Shift+Esc, '
      + '<b>CalGames 2026 Content Desk</b>, <b>End task</b>) and double-click the exe again; nothing is '
      + 'lost. Not answering: check the field network cable. Meanwhile, use '
      + '<b>Field down? Run matches by hand</b> in the desk console.',
    deskLabels: ['Field down? Run matches by hand'] },
  { id: 'pin', see: 'A page asks for a PIN',
    fix: 'The desk PIN is in the Start here box on the desk laptop, and only there. The Judge Advisor '
      + 'page takes the awards code and Event settings the settings code instead. After too many wrong '
      + 'tries, wait a minute, then type it once, carefully. After a desk restart every console asks '
      + 'once more: that is normal.' },
  { id: 'stopped', see: 'Screens stop updating, a console says reconnecting, or this page will not load',
    fix: 'The desk stopped: the laptop slept, restarted or was closed. Double-click the exe again '
      + '(<code>START-DESK.cmd</code> in the CalGames2026-ContentDesk folder in Downloads works too); '
      + 'it never stops a desk that is '
      + 'still running. The day comes back by itself, and every screen reconnects on its own.' },
  { id: 'outline', see: 'A score with an UNOFFICIAL tag over it',
    fix: 'On purpose: that number was typed at the desk (or is sample data), not sent by the field, '
      + 'and a guess must never look official. The tag goes when the field posts the real score.' },
];

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
  /**
   * Whether the desk has a field bridge, read at the moment of asking (C3).
   * The finder attaches one whenever it finds the field, which can be long
   * after the server started, so nothing here may keep the adapter it saw
   * first.
   */
  field?: FieldView | null;
  /**
   * A bridge fixed at start, for a test or tool with no FieldLink. Read only
   * when `field` is absent, as a field link that was attached from the start.
   */
  cheesy?: CheesyAdapter | null;
  /** Every open page's own report of where it is showing (C2). One is made when absent. */
  screens?: ScreenRegistry | null;
  /**
   * The codes and connections from the settings page (C4). Absent (a test, a
   * tool), the server loads its own from `root`, so the codes resolve exactly
   * as before: environment, then config.json, then the shipped defaults.
   */
  settings?: Settings | null;
  /** The read-only switcher watcher, for the settings page and the front page. */
  atem?: AtemView | null;
  /**
   * How the restart route ends the process, after answering. Defaults to
   * process.exit; only a test passes its own, which cannot let the suite die.
   */
  exit?: (code: number) => void;
  /**
   * Whether something will start the desk again after it exits with 75: the
   * launcher does (C9), and it starts the desk with --exit-with-parent, which
   * is the default's test. A desk started by hand has nobody to bring it back,
   * so the restart route refuses rather than switch the show off.
   */
  restartable?: boolean;
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
  /** The awards ceremony: titles, definitions, and the spoiler-safe reveal. */
  awards?: Awards | null;
  /** Recognition and info slides, plus the moderated shout-out queue. */
  slides?: Slides | null;
  /**
   * LAN-reachable base URL, e.g. "http://172.22.0.23:8720", for QR codes.
   * Pass a function (see lan.ts) to have it resolved per request: a string is
   * fixed at boot, and a laptop that gets a new address, or is plugged in
   * after the desk started, would keep handing out a dead one.
   */
  lanBase?: string | null | (() => string | null);
  /** Desk-editable event content, overlaid on config.json. */
  content?: EventContent | null;
  /**
   * Fill every surface with sample data, once. See seedSampleState.
   *
   * Passed in rather than imported so the server has no opinion about where
   * the data comes from, and so a desk built without it simply answers 503.
   */
  seedSample?: (() => void) | null;
  /** Undo seedSample. Returns false when there was no sample to clear. */
  clearSample?: (() => boolean) | null;
  /**
   * Today's chapter landmarks from before this process started, oldest first,
   * as index.ts's boot-time log rebuild found them (sample events already
   * left out). Without it a midday restart dropped the morning from the day
   * VOD's chapter list, and 0:00 defaulted to the restart.
   */
  chapterSeed?: readonly DeskEvent[] | null;
  /**
   * How long the first brute-force lockout lasts, in milliseconds.
   *
   * Injected rather than read from the environment on purpose: a security
   * constant that an env var can weaken is one somebody can weaken at the
   * venue. Nothing in the running desk passes this; only the test that proves
   * a served lockout releases, which cannot wait the real minute.
   */
  lockoutBaseMs?: number;
  /**
   * The clock the brute-force lockout reads, in milliseconds. Defaults to
   * Date.now; nothing in the running desk passes this, for the same reason as
   * lockoutBaseMs above.
   *
   * Injected so the test that proves a lockout holds, and then releases, can
   * move time itself. Against the real clock it had a 450 ms window to land
   * its "still locked out" requests in (the lockout is 700 ms and the failed
   * guess that starts it answers 250 ms later), and any stall of the process
   * longer than that, a busy machine running the whole suite in parallel for
   * one, turned a 429 into a 401 and failed a test of a control that worked.
   */
  lockoutClock?: () => number;
  /**
   * The practice session this desk is, or null for the show. Defaults to the
   * launch flags, which is what the running desk wants (see launchMode); a
   * test says instead.
   */
  mode?: LaunchMode | null;
  /** How config.json loaded. Defaults to what loadConfig found; a test says instead. */
  configFile?: () => ConfigFileReport;
  /**
   * How long after the start the front page's status strip still reads a
   * missing field or OBS connection as "connecting". Nothing in the running
   * desk passes this (see SETTLING_MS); only the test that checks the "not
   * answering" wording, which cannot wait out the real twenty seconds.
   */
  statusSettleMs?: number;
}

export function startServer(opts: ServerOpts) {
  const { bus, media, root, port, host, recorder = null, clips = null,
          publish = null, config = null, cues = null, obs = null,
          arcade = null, trivia = null, audio = null, audioClips = null,
          profiles = null, coverage = null, vitals = null, cardLedger = null,
          rundown = null, sponsors = null, awards = null, slides = null,
          lanBase = null, content = null, seedSample = null, clearSample = null,
          chapterSeed = null, lockoutBaseMs, lockoutClock,
          configFile = configFileReport, statusSettleMs } = opts;
  const mode = opts.mode === undefined ? launchMode() : opts.mode;

  /*
   * The field, read at the moment of asking (C3). A desk with no FieldLink (a
   * test, a tool) gets one that holds its fixed adapter, so every reader below
   * goes through the same three getters and nothing keeps a stale copy.
   */
  const fixedCheesy = opts.cheesy ?? null;
  const field: FieldView = opts.field
    ?? { adapter: fixedCheesy, host: null, searching: false };
  /** The bridge now, or null. A getter that throws reads as no bridge. */
  const bridge = (): CheesyAdapter | null => {
    try { return field.adapter; } catch { return null; }
  };
  /** Whether the field is connected now: a bridge, and it says so. */
  const fieldUp = (): boolean => !!bridge() && !!bus.state.connected.cheesy;
  const fieldHost = (): string | null => {
    try { return field.host ?? null; } catch { return null; }
  };
  const fieldSearching = (): boolean => {
    try { return !!field.searching; } catch { return false; }
  };
  const screens = opts.screens ?? new ScreenRegistry();
  const settings = opts.settings ?? Settings.load(root, config ?? structuredClone(DEFAULTS));
  const atem = opts.atem ?? null;
  /** The switcher's status, or null when there is no watcher or it cannot be read. */
  const atemStatus = () => {
    try { return atem ? atem.status : null; } catch { return null; }
  };
  const exitProcess = opts.exit ?? ((code: number) => process.exit(code));
  const restartable = opts.restartable ?? process.argv.includes('--exit-with-parent');

  // Crash policy lives in index.ts, in the ONE uncaughtException handler for
  // the whole process: fatal during boot, log-and-continue once the show is
  // up. A second handler here could never run: Node calls listeners in
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
  /** Drop any user:pass@ from a URL before it goes to an open surface. */
  function stripUserinfo(raw: string): string {
    if (!raw) return raw;
    try {
      const u = new URL(raw);
      if (!u.username && !u.password) return raw;
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      // Not a parseable absolute URL (a bare path, a relative ref): a regex
      // strip of an authority's userinfo, leaving the rest untouched.
      return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
    }
  }

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
          // Reject with the route's ACTUAL limit: this text reaches the
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
   * What a parsed JSON value is, in words, when it is NOT a plain object; null
   * when it is one. JSON.parse also hands back null, arrays, numbers, strings
   * and booleans, and `as T` on any of them is a lie the next property read
   * finds out.
   */
  const notAnObject = (v: unknown): string | null =>
    v === null ? 'null'
      : Array.isArray(v) ? 'an array'
        : typeof v === 'object' ? null
          : `a ${typeof v}`;

  /**
   * Read a request body that has to be a JSON OBJECT.
   *
   * Every POST route used to `JSON.parse(...) as { ... }` and read fields off
   * the result. A body of literal `null` made that first read a TypeError, and
   * a number, string or array quietly read as an object with nothing in it.
   * Where the route's own catch took the TypeError it answered 422 with
   * "Cannot read properties of null (reading 'team')", a sentence meant for
   * the person who wrote the code, in front of an operator who pressed a
   * button; where it did not, the generic handler answered 500 and logged a
   * stack. Both bury what this is: a malformed request, the caller's to fix,
   * not a fault in the desk. The sign-in doors learned this first (see
   * parsePinBody) because theirs also leaked a guessing slot.
   *
   * Answers 400 itself and returns undefined, so a route reads
   *
   *     const body = await readJsonObject<{ team?: number }>(req, res, 4096);
   *     if (!body) return;
   *
   * and carries on with a real object. `allowEmpty` is for routes whose body
   * is optional: zero bytes means {}, as those routes always read it.
   *
   * Text that is not JSON at all still throws the parser's SyntaxError, and a
   * body over the limit still rejects, exactly as before: every caller maps a
   * throw to its own 422 and this changes neither.
   */
  const readJsonObject = async <T extends object = Record<string, unknown>>(
    req: IncomingMessage, res: ServerResponse, limit: number, allowEmpty = false,
  ): Promise<T | undefined> => {
    const raw = await readBody(req, limit);
    if (allowEmpty && raw.length === 0) return {} as T;
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    const wrong = notAnObject(parsed);
    if (wrong) {
      json(res, 400, { error: `The request body must be a JSON object, not ${wrong}.` });
      return undefined;
    }
    return parsed as T;
  };

  /**
   * Chapter landmarks, kept for the whole day.
   *
   * bus.recent is a 5000-event ring, and realtime score traffic alone
   * overflows it by mid-afternoon, which silently dropped the morning's
   * matches from /api/chapters. The moments a chapter can point at number a
   * few hundred a day, so every one of them is kept here instead. A restart
   * starts from chapterSeed: today's landmarks from before it, out of the log.
   *
   * Sample events are never landmarks: the Sample data button would have put
   * a "Qualification 42" chapter in Friday's VOD that nobody played.
   */
  const CHAPTER_EVENTS = new Set<DeskEventType>(
    ['match.loaded', 'match.start', 'award.presented', 'alliance_selection.update']);
  const isLandmark = (ev: DeskEvent): boolean =>
    CHAPTER_EVENTS.has(ev.type) && ev.source !== 'demo';
  const seeded = (chapterSeed ?? []).filter(isLandmark);
  const chapterLog: DeskEvent[] = [...seeded, ...bus.recent.filter(isLandmark)];
  // Fallback for "when did the recording begin": the oldest event known at
  // boot, the seed's first if a restart brought one, captured once. The
  // oldest event still in the ring drifts all day.
  const firstSeenTs = seeded[0]?.ts ?? bus.recent[0]?.ts ?? Date.now();
  const unsubChapters = bus.subscribe(ev => {
    if (isLandmark(ev)) chapterLog.push(ev);
  });

  /**
   * The shared event PIN, live.
   *
   * Resolved by settings.ts: a change on the settings page, then REMOTE_PIN
   * (the launcher reads desk-pin.txt and passes it there), then desk-pin.txt,
   * then the shipped default. Unset falls back to the default, so a desk that
   * forgets it is gated rather than wide open. An explicit REMOTE_PIN=""
   * still turns the gate off: that is the escape hatch for a laptop on a
   * kitchen table with no network, and settings.ts keeps the empty string.
   *
   * A `let`, never a const: the settings page changes it while the show runs
   * (POST /api/settings/code), and every check below reads this binding at
   * the moment it checks. See applyCodes for what a change also does.
   */
  let REMOTE_PIN = settings.resolved.codes.desk;

  /**
   * Trivia joins per source address, for the mint-loop guard on
   * /api/trivia/join. Timestamps rather than a counter: a counter never
   * decayed, so under venue NAT (many phones, one address) it hardened into a
   * 50-player-per-address cap for the entire three-day event. A sliding
   * one-hour window keeps the guard's point (nobody mints 50 players in an
   * hour by accident) without ever locking out a section of the gym for good.
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
  const LOCKOUT_BASE_MS = lockoutBaseMs ?? 60_000;
  const LOCKOUT_MAX_MS = 15 * 60_000;
  const lockoutNow = lockoutClock ?? Date.now;
  // Below the limit, every miss still waits this long for its verdict, so
  // even a spread-out attack is capped at a few guesses a second.
  const FAIL_DELAY_MS = 250;
  /*
   * The brute-force lockout, keyed by DOOR and address.
   *
   * Two properties this has to hold, both learned from a security review:
   *
   * Per DOOR, not shared. The desk PIN, the awards code and the settings
   * code each get their own counter. A correct PIN on one door clears only
   * that door: a shared counter (cleared on any success) let a desk-PIN
   * holder walk the four-digit awards code four guesses at a time, resetting
   * the count with their own PIN between rounds, and the whole point of the
   * awards tier is that the desk crew cannot reach a winner.
   *
   * In-flight attempts count toward the limit. The async doors read the
   * request body with `await` between the block check and the failure
   * record, so a burst of concurrent requests all cleared the check while
   * the counter was still zero and every four-digit code fell in a single
   * round trip. Reserving a slot synchronously, before any await, makes
   * concurrent attempts see one another: FAIL_LIMIT of them can be in
   * flight at once, and no more.
   */
  const authFails = new Map<string, {
    count: number; blockedUntil: number; inflight: number; rounds: number;
  }>();
  const failKey = (door: string, addr: string): string => `${door}\u0000${addr}`;

  /**
   * Is this address currently shut out of this door?
   *
   * Sweeps a served lockout before answering, which is the whole reason this
   * is not a pure predicate. Without the sweep the block was PERMANENT: the
   * second clause stayed true forever, because `count` is only ever cleared by
   * noteAuthPass, and noteAuthPass can never run, because every door calls
   * this function BEFORE comparing the code. Five wrong guesses meant the
   * right code was never compared again for the life of the process.
   *
   * On the awards door that bricks the Judge Advisor's tablet for the weekend:
   * no winner can be staged and none can be revealed, and the only recovery is
   * a desk restart, which rotates every session token and signs every console
   * out mid-show. Under venue NAT every phone shares one source address, so a
   * spectator idly guessing the remote's PIN could take the desk crew's own
   * remote down with them.
   *
   * Serving the lockout hands back a fresh budget of guesses. The escalation
   * moves to `rounds`, which survives the reset, so each successive lockout
   * for the same address is still twice as long as the one before it.
   */
  const authBlocked = (addr: string, door = 'desk'): boolean => {
    const rec = authFails.get(failKey(door, addr));
    if (!rec) return false;
    const now = lockoutNow();
    if (rec.blockedUntil && rec.blockedUntil <= now) {
      rec.count = 0;
      rec.blockedUntil = 0;
    }
    if (rec.blockedUntil > now) return true;
    return rec.count + rec.inflight >= FAIL_LIMIT;
  };

  /** Reserve a guessing slot, SYNCHRONOUSLY, before any await. Every reserve
   *  is resolved by exactly one of noteAuthFail / noteAuthPass / authRelease. */
  const authReserve = (addr: string, door = 'desk'): void => {
    const k = failKey(door, addr);
    const rec = authFails.get(k) ?? { count: 0, blockedUntil: 0, inflight: 0, rounds: 0 };
    rec.inflight += 1;
    authFails.set(k, rec);
  };

  /** Drop a reservation without counting it: a malformed body is the caller's
   *  mistake, not a wrong code, so it must not burn a guess. */
  const authRelease = (addr: string, door = 'desk'): void => {
    const rec = authFails.get(failKey(door, addr));
    if (rec) rec.inflight = Math.max(0, rec.inflight - 1);
  };

  /**
   * Parse a sign-in body: JSON, and an OBJECT.
   *
   * JSON.parse is happy to return null, a number or an array, and the doors
   * read `body.pin` straight afterwards. On the literal `null` that is a
   * TypeError thrown AFTER authReserve, out of the try that releases the slot,
   * into the generic 500 handler. The reservation was never resolved, and five
   * such requests left `inflight` at the limit forever: the address was locked
   * out of that door for the life of the process, correct code and all. Under
   * venue NAT that is every phone in the gym, the Judge Advisor's tablet
   * included. A non-object body is the same mistake as malformed JSON, so it is
   * reported the same way (a SyntaxError, which each door already releases for
   * and answers 400).
   */
  const parsePinBody = (raw: Buffer): { pin?: unknown } => {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    const wrong = notAnObject(parsed);
    if (wrong) throw new SyntaxError(`Body must be a JSON object, not ${wrong}.`);
    return parsed as { pin?: unknown };
  };

  /** A correct code: clear THIS door's failures. Never a cross-door reset. */
  const noteAuthPass = (addr: string, door = 'desk'): void => {
    authFails.delete(failKey(door, addr));
  };

  /**
   * Constant-time PIN comparison.
   *
   * The lengths are compared first and that leak is fine (a PIN's length is
   * not the secret), but the digits are compared with timingSafeEqual so the
   * number of correct leading characters is not readable off the clock.
   */
  function pinMatches(sent: string): boolean {
    const a = Buffer.from(sent, 'utf8');
    const b = Buffer.from(REMOTE_PIN, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function noteAuthFail(addr: string, door = 'desk'): void {
    const k = failKey(door, addr);
    const rec = authFails.get(k) ?? { count: 0, blockedUntil: 0, inflight: 0, rounds: 0 };
    // Drop the reservation the async doors took; the sync paths (header PIN,
    // WS) never reserved, so the clamp keeps this safe for them too.
    rec.inflight = Math.max(0, rec.inflight - 1);
    rec.count += 1;
    if (rec.count >= FAIL_LIMIT) {
      // Counted in ROUNDS, not in total failures. The old form read
      // `2 ** (count - FAIL_LIMIT)`, which is always 2**0: count can never get
      // past the limit, because every door refuses at it. The doubling this
      // line documents had never once happened.
      rec.rounds += 1;
      const ms = Math.min(LOCKOUT_BASE_MS * 2 ** (rec.rounds - 1), LOCKOUT_MAX_MS);
      rec.blockedUntil = lockoutNow() + ms;
      console.warn(`[auth] ${door} door: ${addr} locked out for ${Math.round(ms / 1000)}s ` +
        `after ${rec.count} failed attempts (round ${rec.rounds})`);
    }
    authFails.set(k, rec);
  }

  /**
   * One session token per process, handed out on a correct PIN.
   *
   * Regenerated on restart, which signs everyone out. That is the right
   * trade: the alternative is persisting a secret to disk on a machine that
   * gets passed between volunteers all weekend.
   */
  let SESSION = randomUUID();
  const AUTH_COOKIE = 'desk_auth';
  /** The desk cookie's browser lifetime: the whole event weekend. See /api/auth. */
  const DESK_COOKIE_MAX_AGE_S = 4 * 24 * 60 * 60;

  /**
   * The hardware door, and why there are two.
   *
   * The cookie is a browser mechanism: a per-process UUID handed out by
   * /api/auth, HttpOnly, never printed. A Stream Deck cannot use it. Bitfocus
   * Companion's stock generic-HTTP module sends a request; it does not run a
   * sign-in flow or keep a cookie jar, and the session rotates on every
   * restart. So with a PIN set, which is what docs/06 tells the crew to do,
   * every physical button 422'd, and the only workaround an on-site volunteer
   * would find is REMOTE_PIN="", which opens the whole desk to a gym full of
   * phones. The control map's entire reason for existing was unreachable
   * behind the gate it shipped with.
   *
   * So a header is accepted too, carrying the SAME event PIN the operators
   * type. Not a second secret to distribute: the PIN is already written on the
   * whiteboard, and a device that can be told a URL can be told a header.
   *
   * Deliberately not a query parameter. That would put the PIN in every access
   * log, in the browser history of anyone who pasted the URL, and in the
   * Referer of anything the page later loaded.
   */
  const PIN_HEADER = 'x-desk-pin';

  /**
   * The crowd trivia player id, carried the same way and for the same reason.
   * It is not the desk PIN and it opens nothing on the desk, but trivia's own
   * model calls it "the only credential answer() checks", so it earns the same
   * treatment: out of the request line, out of the access logs.
   */
  const PLAYER_HEADER = 'x-trivia-player';

  /**
   * The Judge Advisor tier.
   *
   * A second code, held by the JA and nobody on the desk crew, gating the
   * spoiler-bearing half of the awards system: winner entry, the award
   * editor, and the reveal itself. The committee's worry is premature
   * reveals; the mechanic is that the desk PIN alone cannot reach a winner:
   * not to type one, not to read one, not to put one on screen. The JA
   * stages winners from their own page (/s/awards) as judging concludes, and
   * hands the code to the desk right before the ceremony, which is the
   * moment the desk becomes able to run Show and Reveal.
   *
   * Unset (the default) collapses the tier: awards run on the desk PIN as
   * before, which is right for a small event where the producer IS the JA.
   * An explicitly empty JA_PIN env var also disables it, which is what the
   * preview renderer uses.
   */
  // Resolved by settings.ts: the settings page's change, then JA_PIN, then
  // data/settings.json, then config.json, then the default. settings.ts
  // coerces with String() because config.json is hand-edited and "pin": 2468
  // (no quotes) is the natural way to write a four-digit code: a number has no
  // .trim(), and this line runs at boot. Live, like REMOTE_PIN above.
  let JA_PIN = settings.resolved.codes.awards;
  let JA_SESSION = randomUUID();
  const JA_COOKIE = 'ja_auth';

  /**
   * The event-settings tier: a third code, held by the content lead, gating
   * the Event settings page (/s/setup) where the content half of config is
   * edited: event name, sponsors, run of show, thresholds, accessibility.
   * Separate from the desk PIN because sixty desk controls need many hands
   * and the sponsor list needs one; separate from the JA code because the
   * content lead and the Judge Advisor are different people with different
   * secrets. Explicitly empty collapses it onto the desk PIN.
   */
  // Resolved and coerced the same way as JA_PIN above, and live like it.
  let SETUP_PIN = settings.resolved.codes.settings;
  let SETUP_SESSION = randomUUID();
  const SETUP_COOKIE = 'setup_auth';

  /*
   * A code changed: take the new one at once, and sign out everybody who got
   * in with the old one.
   *
   * Changing a code is what a lead does when it has leaked (a PIN read off the
   * whiteboard by the wrong person, a Judge Advisor's tablet left open), so a
   * session made with the old code must not outlive it. A new session token
   * per changed tier is that: every cookie issued before reads as signed out,
   * and the desk's sockets, which authenticated once and would otherwise keep
   * their write access for as long as they stay open, are closed. Each
   * reconnects by itself, finds its cookie stale, and its page goes to the
   * sign-in screen (desk-client.js, checkSignIn).
   *
   * Driven by the settings' own 'change' event, so a change made anywhere
   * (the routes below, or index.ts) lands here the same way.
   */
  function applyCodes(): void {
    const c = settings.resolved.codes;
    if (c.desk !== REMOTE_PIN) {
      REMOTE_PIN = c.desk;
      SESSION = randomUUID();
      signOutDeskSockets();
    }
    if (c.awards !== JA_PIN) { JA_PIN = c.awards; JA_SESSION = randomUUID(); }
    if (c.settings !== SETUP_PIN) { SETUP_PIN = c.settings; SETUP_SESSION = randomUUID(); }
  }
  const onSettingsChange = (keys: string[]): void => {
    if (!keys.some(k => k.startsWith('codes.'))) return;
    try { applyCodes(); } catch (err) {
      console.warn(`[auth] a code change could not be applied (${(err as Error)?.name ?? 'error'})`);
    }
  };
  settings.on('change', onSettingsChange);

  const hasSetupSession = (req: IncomingMessage): boolean =>
    !!SETUP_PIN && cookie(req.headers.cookie, SETUP_COOKIE) === SETUP_SESSION;

  /** May this request edit event settings? Falls back to the desk session
   *  when the tier is collapsed. */
  const isSetup = (req: IncomingMessage): boolean =>
    SETUP_PIN ? hasSetupSession(req) : isAuthed(req);

  /** A real JA session: only ever true when a JA code is configured. */
  const hasJaSession = (req: IncomingMessage): boolean =>
    !!JA_PIN && cookie(req.headers.cookie, JA_COOKIE) === JA_SESSION;

  /** May this request do award WRITES? Falls back to the desk session when no
   *  separate JA code exists, which is the single-code small-event mode. */
  const isJa = (req: IncomingMessage): boolean =>
    JA_PIN ? hasJaSession(req) : isAuthed(req);

  /**
   * Is this request from a browser on the desk laptop itself, naming the desk
   * by a local name?
   *
   * Both halves, always. The local address alone is not enough: a web page
   * open on the desk machine could point its own domain at 127.0.0.1 (DNS
   * rebinding) and read whatever this guards; the connection is local, but the
   * Host it names is the attacker's. This is the Start here box's rule, and it
   * also guards changing the desk PIN and restarting the desk.
   */
  const isDeskMachine = (req: IncomingMessage): boolean => {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return (ip === '127.0.0.1' || ip === '::1')
      && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  };

  const isAuthed = (req: IncomingMessage): boolean => {
    if (!REMOTE_PIN) return true;
    if (cookie(req.headers.cookie, AUTH_COOKIE) === SESSION) return true;

    const sent = req.headers[PIN_HEADER];
    if (typeof sent !== 'string') return false;
    const addr = req.socket.remoteAddress ?? 'unknown';
    // The same lockout /api/auth uses. A door with no counter is a door that
    // can be brute-forced at line rate, and a four-digit PIN does not survive
    // that for long.
    if (authBlocked(addr)) return false;
    if (pinMatches(sent)) return true;
    noteAuthFail(addr);
    return false;
  };

  // ---- the settings page's codes, connections and restart (C5) ------------

  /** Which lockout counter guards each code: the same doors its sign-in uses. */
  const CODE_DOOR: Record<CodeName, string> = { desk: 'desk', awards: 'ja', settings: 'setup' };
  const CODE_WORDS: Record<CodeName, string> = {
    desk: 'desk PIN', awards: 'awards code', settings: 'settings code',
  };
  const liveCode = (which: CodeName): string =>
    which === 'desk' ? REMOTE_PIN : which === 'awards' ? JA_PIN : SETUP_PIN;
  const SETTINGS_LOCKED = 'This is behind the settings code, which the content lead holds. '
    + 'Unlock Event settings (/s/setup) first.';

  /**
   * Change one code: the current one must be right, the new one 4 to 8 digits
   * and not one of the other two codes. Shared by the settings page (desk PIN,
   * settings code) and the Judge Advisor page (awards code).
   *
   * Every guess goes through the PIN damper, on the door of the code it is a
   * guess at, with the same lockout and the same delay as signing in, so this
   * is never a cheaper way to guess a code than the sign-in it guards.
   *
   * That includes the new code. "Not one of the other two" is a question
   * about codes the caller may not hold: a settings-code holder who could ask
   * it freely could walk 0000 to 9999 and learn the awards code from which
   * answer differed, and the awards code is the one that opens the staged
   * winners. So a new code that matches another code is counted as a wrong
   * guess at THAT code's door, and the answer never says which one it hit.
   *
   * A slot is reserved on all three doors before the body is read (see
   * authReserve: concurrent requests must see one another), and each is
   * resolved exactly once: failed, passed, or released.
   */
  async function changeCode(req: IncomingMessage, res: ServerResponse, fixed: 'awards' | null): Promise<void> {
    const addr = req.socket.remoteAddress ?? 'unknown';
    const doors = ['desk', 'ja', 'setup'];
    if (doors.some(d => authBlocked(addr, d))) {
      return json(res, 429, { error: 'Too many wrong codes. Wait a minute, then try again.' });
    }
    const pending = new Set(doors);
    for (const d of doors) authReserve(addr, d);
    const failed = (door: string): void => { noteAuthFail(addr, door); pending.delete(door); };
    const passed = (door: string): void => { noteAuthPass(addr, door); pending.delete(door); };
    const slow = (): Promise<void> => new Promise(r => setTimeout(r, FAIL_DELAY_MS));
    try {
      let body: Record<string, unknown>;
      try {
        body = parsePinBody(await readBody(req, 4 * 1024)) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'Body must be JSON, like {"which":"settings","current":"1234","next":"5678"}.' });
      }
      const asked = fixed ?? body['which'];
      if (fixed === null && asked === 'awards') {
        return json(res, 400, { error: 'The awards code is changed on the Judge Advisor page (/s/awards), '
          + 'by whoever holds it.' });
      }
      if (asked !== 'desk' && asked !== 'settings' && asked !== 'awards') {
        return json(res, 400, { error: 'Which code? "desk" or "settings".' });
      }
      const which: CodeName = asked;
      // The desk PIN opens every control in the building, so it is changed
      // only by someone standing at the desk laptop, by the same rule that
      // keeps the PIN itself on that laptop's screen alone.
      if (which === 'desk' && !isDeskMachine(req)) {
        return json(res, 403, { error: 'The desk PIN can only be changed on the desk laptop itself: open '
          + 'Event settings there, at localhost.' });
      }
      const now = liveCode(which);
      if (which !== 'desk' && !now) {
        return json(res, 404, { error: `This desk has no separate ${CODE_WORDS[which]}: the desk PIN covers it.` });
      }
      const current = typeof body['current'] === 'string' || typeof body['current'] === 'number'
        ? String(body['current']).trim() : '';
      const next = typeof body['next'] === 'string' || typeof body['next'] === 'number'
        ? String(body['next']).trim() : '';
      if (!safeEqual(current, now)) {
        failed(CODE_DOOR[which]);
        console.warn(`[auth] a wrong current ${CODE_WORDS[which]} was given to change it, from ${addr}`);
        await slow();
        return json(res, 401, { error: `That is not the current ${CODE_WORDS[which]}, so nothing was changed.` });
      }
      passed(CODE_DOOR[which]);
      if (!/^\d{4,8}$/.test(next)) {
        return json(res, 400, { error: 'A new code is 4 to 8 digits.' });
      }
      const clash = (['desk', 'awards', 'settings'] as const)
        .find(o => o !== which && liveCode(o) !== '' && safeEqual(next, liveCode(o)));
      if (clash) {
        failed(CODE_DOOR[clash]);
        await slow();
        return json(res, 409, { error: 'That code cannot be used here: pick a different one.' });
      }
      try {
        settings.setCode(which, next);
      } catch (err) {
        if (err instanceof SettingsError) {
          return json(res, err.name === 'SettingsSaveError' ? 503 : 400, { error: err.message });
        }
        throw err;
      }
      // applyCodes has run (the settings' change event): the new code is live
      // and every session made with the old one is gone. The person who made
      // the change proved both codes, so their own browser gets a fresh
      // session for the tier they are on rather than a sign-in screen.
      if (which === 'settings' && SETUP_PIN) {
        res.setHeader('Set-Cookie',
          `${SETUP_COOKIE}=${SETUP_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
      } else if (which === 'awards' && JA_PIN) {
        res.setHeader('Set-Cookie',
          `${JA_COOKIE}=${JA_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
      } else if (which === 'desk' && !SETUP_PIN) {
        // No separate settings code: this page is on the desk session itself,
        // which the change just ended. Without a fresh one the page that made
        // the change would sign itself out mid-sentence. With a settings code
        // the caller's tier was not touched, so nothing is issued: every
        // desk session goes with the old PIN, as the change means.
        res.setHeader('Set-Cookie',
          `${AUTH_COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DESK_COOKIE_MAX_AGE_S}`);
      }
      // The code's name only, never the code: this line is desk-log.txt.
      console.log(`[auth] the ${CODE_WORDS[which]} was changed; everyone signed in with the old one `
        + 'is signed out');
      return json(res, 200, { ok: true });
    } finally {
      for (const d of pending) authRelease(addr, d);
    }
  }

  /**
   * What the settings page shows (GET /api/settings). Never a code and never a
   * whole key: whether each code is still the shipped default, whether a Nexus
   * key is set, and at most its last four characters so the lead can tell
   * which key it is.
   *
   * "Still the default" is a default-code warning, and those go only to the
   * desk laptop (isDeskMachine), for the same reason the Start here box keeps
   * them there: a shipped default is a public code, so telling a settings-code
   * holder on another computer that the awards code is still the default is
   * telling them the awards code. Elsewhere those two read null ("not said
   * here"); the settings code's own is always said, since the caller holds it.
   */
  function settingsView(req: IncomingMessage) {
    const desk = isDeskMachine(req);
    const r = settings.resolved;
    const key = r.connections.nexusKey;
    const st = atemStatus();
    return {
      codes: {
        desk: { isDefault: desk ? REMOTE_PIN === DEFAULT_CODES.desk : null },
        awards: { isDefault: desk ? JA_PIN === DEFAULT_CODES.awards : null },
        settings: { isDefault: SETUP_PIN === DEFAULT_CODES.settings },
      },
      connections: {
        fieldHost: r.connections.fieldHost,
        atemHost: r.connections.atemHost,
        // Four characters of a key under eight is half the key: no hint then.
        nexusKey: { set: !!key, hint: key.length >= 8 ? key.slice(-4) : null },
      },
      graphicsInput: r.graphicsInput,
      deskMachine: desk,
      field: { host: fieldHost(), connected: fieldUp(), searching: fieldSearching() },
      atem: st
        ? {
          state: st.state, host: st.host, model: st.model, videoMode: st.videoMode,
          inputs: st.inputs.map(i => ({ id: i.id, longName: i.longName })),
        }
        : { state: 'off', host: null, model: null, videoMode: null, inputs: [] },
    };
  }

  let restarting = false;
  /**
   * End the process so the launcher starts it again (exit code 75, C9).
   *
   * The ordinary shutdown's flushes first, capped like it: the event log's
   * tail is what the next start rebuilds the day from, and the recorder's last
   * segment is unplayable if ffmpeg is killed mid-file. Whatever happens, the
   * process exits: a restart that hangs is a desk that is neither up nor down.
   */
  async function restartNow(): Promise<void> {
    try {
      console.log('[core] restarting the desk, as asked on the Event settings page');
      const flushes: Promise<unknown>[] = [bus.closeLog()];
      if (recorder) flushes.push(recorder.stop());
      await Promise.race([Promise.allSettled(flushes), new Promise(r => setTimeout(r, 5000))]);
    } catch { /* exit regardless */ }
    exitProcess(75);
  }

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
        // Reserve the slot HERE, synchronously, before the body await: a
        // concurrent flood must not all pass the block check above.
        authReserve(addr);
        // Malformed JSON is the caller's mistake, not a server error: answer
        // 400 instead of letting the parse throw into the generic 500 handler.
        let body: { pin?: unknown };
        try {
          body = parsePinBody(await readBody(req, 4 * 1024));
        } catch (err) {
          authRelease(addr);
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
        noteAuthPass(addr);
        // Four days: Thursday load-in to Sunday teardown. It was 16 hours, so
        // a tablet signed in for Friday's 6 PM practice lost its session at
        // 10 AM Saturday, as qualifications started, with the socket still
        // reading "linked" while every gated read quietly failed. The session
        // still dies with the process, so a cookie never outlives the desk
        // run that issued it; a restart is caught by desk-client.js instead.
        res.setHeader('Set-Cookie',
          `${AUTH_COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DESK_COOKIE_MAX_AGE_S}`);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/auth/status') {
        return json(res, 200, { required: !!REMOTE_PIN, authed: isAuthed(req) });
      }

      // A Judge Advisor session opens the awards routes and NOTHING else:
      // the JA code is award-scoped, not a second desk PIN.
      const jaException = path.startsWith('/api/awards') && hasJaSession(req);
      // Same shape for the settings session: it opens /api/setup* and the
      // settings page's own codes-and-connections routes (/api/settings*),
      // and nothing else on the desk.
      const setupException = (path.startsWith('/api/setup') || path === '/api/settings'
        || path.startsWith('/api/settings/')) && hasSetupSession(req);
      if (needsAuth({ method: req.method ?? 'GET', path }) && !isAuthed(req)
          && !jaException && !setupException) {
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
      // Which kind of session this desk is, for the launcher: a double-click
      // on a desk that is already up only reopens it, and one left in
      // rehearsal on Friday night would otherwise run the show that way with
      // nothing said. Open, because the launcher holds no PIN, and harmless:
      // the mode is on the Start here box for anyone who opens the page.
      //
      // It also says where the field is (C6), for the program page on the
      // switcher feed: when the desk cannot be reached, that page swaps to
      // Cheesy Arena's own score overlay, loaded straight from the field, and
      // it can only do that if it learned the field's address while the desk
      // was up. The address is not a secret (it is the FRC convention, and
      // every field display already loads from it); nothing else is added.
      if (path === '/api/info') {
        return json(res, 200, { mode: mode ?? 'normal', field: { host: fieldHost() } });
      }
      // Every open page, as each last described itself (C2). Desk PIN, like
      // the other desk reads: the addresses are the AV table's computers.
      if (path === '/api/screens') return json(res, 200, { screens: screens.list() });
      // What the switcher has on air, as the read-only watcher last heard it,
      // with the graphics input from the settings page, for the desk
      // console's kit strip. Desk PIN, like /api/screens. With no watcher it
      // is the same shape, switched off, so the console has one thing to read.
      if (path === '/api/atem') {
        const st = atemStatus();
        let graphicsInput: number | null = null;
        try { graphicsInput = settings.resolved.graphicsInput; } catch { graphicsInput = null; }
        return json(res, 200, {
          ...(st ?? {
            state: 'off', host: null, model: null, protocol: null, videoMode: null, program: null,
            preview: null, inputs: [], keyers: [], since: null, lastHeard: null, error: null,
          }),
          graphicsInput,
        });
      }
      // The LAN-reachable base URL: what phone-facing QR codes must encode
      // (a surface's own location.host may be localhost on the desk box).
      // Open, because every QR code and every pit monitor needs it, and it
      // discloses only what the network already shows.
      if (path === '/api/urls') {
        // The field feed URL is served on this OPEN route (the pit-monitor
        // kiosk cannot type a PIN), so any credential embedded in it, like an
        // IP camera's rtsp://user:pass@host, would reach every phone in the
        // gym. Strip the userinfo before echoing: a credential-free stream
        // (a YouTube live URL, a plain MJPEG) is unchanged, and a credentialed
        // camera should be reached through a credential-free proxy rather
        // than by broadcasting its password.
        //
        // `base` is resolved now, not at boot, and is null (never a guessed
        // localhost) when this machine has no address a phone could reach.
        // Every reader already treats null as "no QR": the poster refuses to
        // print, the side screen hides its code, the watch page falls back to
        // its own origin. A localhost code on a printed sign is the one answer
        // that looks right and sends the whole gym to a dead page.
        return json(res, 200, {
          base: currentLanBase(),
          fieldStream: stripUserinfo(config?.kiosk?.fieldStreamUrl ?? ''),
        });
      }

      // , not : this endpoint is open, every overlay reads
      // it, and a team that asked to come off the screen must come off the
      // screen. The full manifest, consent included, is on the gated route
      // below for the media console.
      if (path === '/api/media/manifest') return json(res, 200, media.airable);

      if (path === '/api/media/consent' && req.method === 'POST') {
        try {
          const body = await readJsonObject<{ team?: number; consent?: string }>(req, res, 4 * 1024);
          if (!body) return;
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
          const body = await readJsonObject<{
            sourceId?: string; fromMs?: number; toMs?: number;
            ranges?: Range[]; label?: string; speed?: number;
          }>(req, res, 64 * 1024);
          if (!body) return;
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
          const body = await readJsonObject<{ sourceId?: string }>(req, res, 8 * 1024);
          if (!body) return;
          const st = bus.state;
          const startedAt = st.matchStartedAt ?? bus.lastMatchStartedAt;
          if (startedAt == null) return json(res, 409, { error: 'No match has started yet.' });

          const ranges = matchCut({
            startedAt,
            endedAt: st.matchEndedAt,
            scorePostedAt: st.scorePostedAt,
          });

          const clip = await clips.extract({
            sourceId: body.sourceId ?? 'program',
            ranges,
            // Its own label, never the bare match name. The publish queue
            // cuts the same match under the same name from the same ranges,
            // and the file names come from label plus start time, so the two
            // cuts shared every scratch file and the output: one cut failed
            // on a locked file, and ffmpeg -y could rewrite the very .mp4 the
            // queue was uploading.
            label: `${st.match?.displayName ?? 'match'} review`,
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
          const body = await readJsonObject(req, res, 32 * 1024, true);
          if (!body) return;

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
          const body = await readJsonObject<
            { message?: string; detail?: string; kind?: string; clear?: boolean }>(req, res, 4 * 1024);
          if (!body) return;
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
          const body = await readJsonObject<{ scene?: string }>(req, res, 4 * 1024);
          if (!body) return;
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

      // ---- the control map, and the one route it needs ----------------------
      // Every action the desk can be driven by, as data. A Stream Deck button
      // is worth more than a browser tab to somebody who is also cutting
      // cameras, and every version of Companion can already send an HTTP
      // request with no module installed. See control-map.ts.
      if (path === '/api/control-map') {
        return json(res, 200, {
          actions: CONTROL_ACTIONS,
          groups: controlGroups(),
          // How a device that cannot hold a cookie gets in. Published with the
          // actions because a button configured without it just 401s, and the
          // volunteer's next move would be to turn the PIN off entirely.
          auth: REMOTE_PIN
            ? { header: PIN_HEADER, note: 'Send the event PIN in this header on every request.' }
            : { header: null, note: 'No PIN is set on this desk, so no header is needed.' },
        });
      }

      /**
       * Fire one button, by action id.
       *
       * The consoles use the WebSocket; hardware cannot. This deliberately
       * takes an ACTION ID rather than an event type and payload, and emits
       * exactly what the control map declares for it.
       *
       * That distinction is the whole security of the route. An earlier
       * version took {type, payload} and allowlisted the type, which looked
       * equivalent and was not: "Post score" is a legitimate button, so
       * `match.score_posted` was on the allowlist, so anything that could
       * reach this route could post a match result with a fabricated score of
       * its choosing. Caught by trying it. A button can now only send what the
       * map says that button sends.
       */
      if (path === '/api/emit' && req.method === 'POST') {
        try {
          const body = await readJsonObject<{ id?: string }>(req, res, 8 * 1024);
          if (!body) return;
          const action = CONTROL_ACTIONS.find(a => a.id === String(body.id ?? ''));
          if (!action || action.path !== '/api/emit') {
            return json(res, 422, {
              error: `"${body.id}" is not a button. See GET /api/control-map.`,
            });
          }
          // `emits`, not `body`: body is what the CALLER sends ({id}), emits
            // is what the desk does about it. They were the same field once,
            // which made the map publish a request shape this route rejects.
          const mapped = action.emits;
          bus.emit({
            type: mapped?.type as DeskEventType,
            source: 'manual',
            // Same clamp as the socket path: a button press is an operator's
            // hand, and bus.emit's default of 'authoritative' is reserved for
            // the field. Only the score-family reducers read confidence, and
            // for those the hand-pressed answer must render outlined.
            confidence: 'estimated',
            payload: (mapped?.payload ?? {}) as Record<string, unknown>,
          });
          return json(res, 200, { ok: true, id: action.id, type: mapped?.type });
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
          const body = await readJsonObject<{ action?: string; id?: string }>(req, res, 4 * 1024);
          if (!body) return;
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

      // ---- awards -----------------------------------------------------------
      // The Judge Advisor's door. Mirrors /api/auth exactly: POST body only,
      // same lockout counters (shared with the desk door on purpose: an
      // attacker does not get a fresh budget per door), same failure delay.
      if (path === '/api/awards/auth' && req.method === 'POST') {
        const addr = req.socket.remoteAddress ?? 'unknown';
        if (authBlocked(addr, 'ja')) {
          return json(res, 429, { error: 'Too many wrong codes. Wait a minute, then try again.' });
        }
        if (!JA_PIN) {
          return json(res, 404, {
            error: 'No separate awards code is set on this desk. The ordinary PIN covers awards.',
          });
        }
        authReserve(addr, 'ja');
        let body: { pin?: unknown };
        try {
          body = parsePinBody(await readBody(req, 4 * 1024));
        } catch {
          authRelease(addr, 'ja');
          return json(res, 400, { error: 'Body must be JSON, like {"pin":"1234"}.' });
        }
        if (!safeEqual(String(body.pin ?? ''), JA_PIN)) {
          noteAuthFail(addr, 'ja');
          console.warn(`[awards] rejected JA code attempt from ${addr}`);
          await new Promise<void>(r => setTimeout(r, FAIL_DELAY_MS));
          return json(res, 401, { error: 'That code was not accepted.' });
        }
        noteAuthPass(addr, 'ja');
        res.setHeader('Set-Cookie',
          `${JA_COOKIE}=${JA_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
        return json(res, 200, { ok: true });
      }

      /*
       * Lock the awards page again.
       *
       * The session lives sixteen hours, so a Judge Advisor who unlocked the
       * page after lunch and put the laptop down left every winner one reload
       * away from anyone who picked it up. Max-Age=0 expires this browser's
       * cookie; the process-wide token is untouched, so other people holding
       * the code stay signed in. Answers ok even when there was no session to
       * close, because the page's Lock button must not report a failure for
       * having succeeded.
       */
      if (path === '/api/awards/signout' && req.method === 'POST') {
        res.setHeader('Set-Cookie',
          `${JA_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return json(res, 200, { ok: true });
      }

      // The settings door: same lockout, same delay, same cookie mechanics
      // as the JA door above.
      if (path === '/api/setup/auth' && req.method === 'POST') {
        const addr = req.socket.remoteAddress ?? 'unknown';
        if (authBlocked(addr, 'setup')) {
          return json(res, 429, { error: 'Too many wrong codes. Wait a minute, then try again.' });
        }
        if (!SETUP_PIN) {
          return json(res, 404, {
            error: 'No separate settings code is set on this desk. The ordinary PIN covers settings.',
          });
        }
        authReserve(addr, 'setup');
        let body: { pin?: unknown };
        try {
          body = parsePinBody(await readBody(req, 4 * 1024));
        } catch {
          authRelease(addr, 'setup');
          return json(res, 400, { error: 'Body must be JSON, like {"pin":"1234"}.' });
        }
        if (!safeEqual(String(body.pin ?? ''), SETUP_PIN)) {
          noteAuthFail(addr, 'setup');
          console.warn(`[setup] rejected settings code attempt from ${addr}`);
          await new Promise<void>(r => setTimeout(r, FAIL_DELAY_MS));
          return json(res, 401, { error: 'That code was not accepted.' });
        }
        noteAuthPass(addr, 'setup');
        res.setHeader('Set-Cookie',
          `${SETUP_COOKIE}=${SETUP_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=57600`);
        return json(res, 200, { ok: true });
      }

      // Same shape as the awards door above: close your own session.
      if (path === '/api/setup/signout' && req.method === 'POST') {
        res.setHeader('Set-Cookie',
          `${SETUP_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return json(res, 200, { ok: true });
      }

      // ---- the settings page: codes, connections, restart (C5) -------------
      // Behind the settings session (or the desk session when that tier is
      // collapsed), exactly like /api/setup. Every body is a JSON POST, so no
      // code or key ever rides in a query string, an access log or a history.
      if (path === '/api/settings' && req.method !== 'POST') {
        if (!isSetup(req)) {
          return json(res, 403, { error: SETTINGS_LOCKED, locked: true, separate: !!SETUP_PIN });
        }
        return json(res, 200, settingsView(req));
      }

      if (path === '/api/settings/connections' && req.method === 'POST') {
        if (!isSetup(req)) return json(res, 403, { error: SETTINGS_LOCKED });
        let body: Record<string, unknown> | undefined;
        try {
          body = await readJsonObject(req, res, 8 * 1024);
        } catch {
          return json(res, 400, { error: 'Body must be JSON, like {"atemHost":"10.0.100.40"}.' });
        }
        if (!body) return;
        const KNOWN = ['fieldHost', 'atemHost', 'nexusKey', 'graphicsInput'];
        // Refused by name rather than ignored: a code sent here by mistake
        // must not read as saved.
        const unknown = Object.keys(body).filter(k => !KNOWN.includes(k));
        if (unknown.length) {
          const names = unknown.slice(0, 3).map(k => `"${k.replace(/[^\w.-]/g, '').slice(0, 32)}"`).join(', ');
          return json(res, 400, { error: `Not something this page sets: ${names}.` });
        }
        const patch: Record<string, unknown> = {};
        for (const k of KNOWN) if (Object.hasOwn(body, k)) patch[k] = body[k] === '' ? null : body[k];
        try {
          const restartNeeded = settings.setConnections(patch as ConnectionsPatch,
            { fieldAttached: bridge() ? fieldHost() : null });
          return json(res, 200, { ok: true, restartNeeded });
        } catch (err) {
          if (err instanceof SettingsError) {
            return json(res, err.name === 'SettingsSaveError' ? 503 : 400, { error: err.message });
          }
          throw err;
        }
      }

      if (path === '/api/settings/code' && req.method === 'POST') {
        if (!isSetup(req)) return json(res, 403, { error: SETTINGS_LOCKED });
        return await changeCode(req, res, null);
      }

      // Under /api/awards on purpose: the awards code opens /api/awards* and
      // nothing else, so the Judge Advisor can change their own code without
      // the desk PIN, and nobody else can.
      if (path === '/api/awards/code' && req.method === 'POST') {
        if (!isJa(req)) {
          return json(res, 403, { error: 'Only the Judge Advisor page, unlocked with the awards code, '
            + 'changes the awards code.' });
        }
        return await changeCode(req, res, 'awards');
      }

      if (path === '/api/settings/restart' && req.method === 'POST') {
        if (!isSetup(req)) return json(res, 403, { error: SETTINGS_LOCKED });
        if (!isDeskMachine(req)) {
          return json(res, 403, { error: 'The desk can only be restarted from the desk laptop itself.' });
        }
        if (!restartable) {
          return json(res, 409, { error: 'This desk was not started by the CalGames exe, so nothing would '
            + 'start it again. Close it and start it the way you started it.' });
        }
        // Answered first, then the exit, so the page can say "restarting"
        // rather than "the desk did not answer".
        json(res, 200, { ok: true });
        if (!restarting) {
          restarting = true;
          setTimeout(() => { void restartNow(); }, 200);
        }
        return;
      }

      // The ceremony: title and definition up while the GA reads it, winner
      // revealed on a button. The winner is held OUT of the bus until the
      // reveal: every open surface reads the fan-out, and a spoiler in a
      // JSON field would beat the GA to the moment. See awards.ts.
      if (path === '/api/awards' && req.method !== 'POST') {
        if (!awards) return json(res, 200, null);
        const unlocked = isJa(req);
        return json(res, 200, {
          ...awards.snapshot(unlocked),
          // What the panel should render: locked shows the unlock form, and
          // `separate` says whether a JA code exists at all, so a small event
          // with no code never sees a lock it cannot open.
          locked: !unlocked,
          separate: !!JA_PIN,
        });
      }

      if (path === '/api/awards' && req.method === 'POST') {
        // Every write (staging, the editor, show, reveal, clear) sits
        // behind the JA tier, and the tier answers FIRST: a locked door
        // reports locked, never its interior. The desk session alone gets a
        // plain sentence about who to find, not a mystery 403.
        if (!isJa(req)) {
          return json(res, 403, {
            error: 'Awards are locked behind the Judge Advisor code. '
              + 'The JA unlocks this panel before the ceremony.',
          });
        }
        if (!awards) return json(res, 503, { error: 'Awards are not available.' });
        try {
          const body = await readJsonObject<
            { action?: string; id?: string; title?: string; description?: string;
              blurb?: string; day?: string; delta?: number;
              winner?: string; team?: number }>(req, res, 8 * 1024);
          if (!body) return;
          switch (body.action) {
            case 'show':
              awards.show(body);
              return json(res, 200, { ok: true });
            case 'reveal':
              awards.reveal(body);
              return json(res, 200, { ok: true });
            case 'clear':
              awards.clear();
              return json(res, 200, { ok: true });
            case 'stage':
              await awards.stage(String(body.id ?? ''), body);
              return json(res, 200, { ok: true });
            case 'unstage':
              return json(res, 200, { removed: await awards.unstage(String(body.id ?? '')) });
            // The list itself is the JA's too: adding an award, fixing a
            // description, retiring one. No config.json required.
            case 'define':
              return json(res, 200, { award: awards.define(body) });
            case 'remove':
              await awards.remove(String(body.id ?? ''));
              return json(res, 200, { ok: true });
            case 'reorder':
              return json(res, 200, {
                list: awards.reorder(String(body.id ?? ''), Number(body.delta) || 0),
              });
            default: return json(res, 404, { error: 'Unknown award action.' });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- slides -----------------------------------------------------------
      // The deck is OPEN because the side screens rotate it and cannot type a
      // PIN. It never contains the moderation queue: nothing in that queue has
      // been approved, and this response goes to every phone in the gym.
      if (path === '/api/slides' && req.method !== 'POST') {
        return json(res, 200, slides
          ? { deck: slides.deck, live: slides.liveId }
          : { deck: [], live: null });
      }

      if (path === '/api/slides/queue') {
        return json(res, 200, { queue: slides?.queue ?? [] });
      }

      if (path === '/api/slides' && req.method === 'POST') {
        if (!slides) return json(res, 503, { error: 'Slides are not available.' });
        try {
          const body = await readJsonObject<
            { action?: string; id?: string; kind?: string; title?: string; lines?: string[] }>(
            req, res, 8 * 1024);
          if (!body) return;
          switch (body.action) {
            case 'show': return json(res, 200, slides.show(String(body.id ?? '')));
            case 'next': return json(res, 200, slides.next());
            case 'hide': slides.hide(); return json(res, 200, { ok: true });
            case 'add': return json(res, 200, await slides.add(body));
            case 'remove':
              return json(res, 200, { removed: await slides.remove(String(body.id ?? '')) });
            case 'approve': return json(res, 200, await slides.approve(String(body.id ?? '')));
            case 'reject':
              return json(res, 200, { rejected: await slides.reject(String(body.id ?? '')) });
            default: return json(res, 404, { error: 'Unknown slide action.' });
          }
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // A Gracious Professionalism shout-out from a phone in the stands. Open
      // on purpose (the whole point is that anyone can send one) and safe on
      // purpose: screened, rate-limited per address, capped, and above all
      // MODERATED. Nothing from here reaches a screen until a human at the
      // desk approves it into the deck.
      if (path === '/api/gp' && req.method === 'POST') {
        if (!slides) return json(res, 503, { error: 'Shout-outs are not on right now.' });
        try {
          const body = await readJsonObject<
            { name?: string; team?: number; to?: string; message?: string }>(req, res, 4 * 1024);
          if (!body) return;
          const sub = await slides.submit(body, req.socket.remoteAddress ?? 'unknown');
          return json(res, 200, { ok: true, id: sub.id });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      // ---- the event timer --------------------------------------------------
      // "Provide a viewable (from the field) timer during robot field setup"
      // is on the planning committee's list with the content desk named as the
      // remediation. The timer renders huge on the side screens; turn one to
      // face the field. It clears itself when a match starts.
      if (path === '/api/timer' && req.method === 'POST') {
        try {
          const body = await readJsonObject<
            { label?: string; seconds?: number; clear?: boolean }>(req, res, 2 * 1024);
          if (!body) return;
          if (body.clear) {
            bus.emit({ type: 'timer.cleared', source: 'manual', payload: {} });
            return json(res, 200, { ok: true });
          }
          const seconds = Number(body.seconds);
          if (!Number.isFinite(seconds) || seconds < 10 || seconds > 7200) {
            return json(res, 400, { error: 'Seconds must be between 10 and 7200.' });
          }
          const endsAt = Date.now() + seconds * 1000;
          bus.emit({
            type: 'timer.started',
            source: 'manual',
            payload: { label: String(body.label ?? '').trim().slice(0, 60), endsAt },
          });
          return json(res, 200, { ok: true, endsAt });
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
          const body = await readJsonObject<
            { team?: number; color?: string; alliance?: string; reason?: string; clear?: boolean }>(
            req, res, 4 * 1024);
          if (!body) return;

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
          // Refused rather than coerced. `alliance === 'blue' ? 'blue' :
          // 'red'` meant an omitted field, a typo, or a capitalised "Blue" put
          // the card on the RED alliance, on the program, in front of the gym,
          // with a 200 back and nothing saying it had gone wrong. The team and
          // the colour beside it are both refused when malformed; this was the
          // one enum that guessed.
          if (body.alliance !== 'red' && body.alliance !== 'blue') {
            return json(res, 400, { error: 'Which alliance: red or blue?' });
          }
          bus.emit({
            type: 'card.call',
            source: 'manual',
            payload: {
              team,
              color: body.color,
              alliance: body.alliance,
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
          const body = await readJsonObject<{ action?: string; id?: string }>(req, res, 4 * 1024);
          if (!body) return;
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

      // ---- event setup: the content half of config, editable at the desk ----
      // Both verbs are desk-gated (needsAuth allowlists nothing under
      // /api/setup). The allowlist of editable sections lives in content.ts;
      // credentials and machine wiring are not in it and 422 out by name.
      if (path === '/api/setup' && req.method !== 'POST') {
        // The tier gate answers FIRST: a locked door reports locked, never
        // its interior.
        if (!isSetup(req)) {
          return json(res, 403, {
            error: 'Event settings are behind the settings code, which the '
              + 'content lead holds. Unlock at /s/setup.',
            locked: true, separate: !!SETUP_PIN,
          });
        }
        if (!config || !content) return json(res, 503, { error: 'Setup is not available.' });
        return json(res, 200, {
          event: config.event,
          game: config.game,
          // The same strip /api/urls does, one tier further in. The field feed
          // URL can carry an IP camera's rtsp://user:pass@host, and two places
          // promise it never surfaces here: this page's own header ("Credentials
          // stay in the file") and the catalogue entry above ("credentials never
          // appear here"). The settings code belongs to the content lead, who is
          // a narrower trust tier than whoever wired the cameras, so the promise
          // has to be true rather than nearly true.
          //
          // Nothing is lost by stripping. /api/urls is the ONLY reader of this
          // value anywhere in the system and already strips it, so the
          // credentialed form has never reached a single consumer. The field
          // therefore round-trips credential-free when the content lead saves,
          // which is exactly what the /api/urls comment argues for: reach a
          // credentialed camera through a credential-free proxy, never by
          // handing its password to another tier.
          kiosk: {
            ...config.kiosk,
            fieldStreamUrl: stripUserinfo(config.kiosk?.fieldStreamUrl ?? ''),
          },
          stream: config.stream,
          sponsors: config.sponsors,
          rundown: config.rundown,
          accessibility: config.accessibility,
          overridden: content.overridden,
        });
      }

      if (path === '/api/setup' && req.method === 'POST') {
        if (!isSetup(req)) {
          return json(res, 403, {
            error: 'Event settings are behind the settings code, which the '
              + 'content lead holds. Unlock at /s/setup.',
          });
        }
        if (!config || !content) return json(res, 503, { error: 'Setup is not available.' });
        try {
          const body = await readJsonObject<{ section?: string; value?: unknown }>(
            req, res, 64 * 1024);
          if (!body) return;
          const section = String(body.section ?? '');
          // The settings page writes event content. It does not write the
          // ceremony: `awards` has a sanitizer only so the Judge Advisor's own
          // edits can persist through this store, and leaving it reachable
          // here let the settings code erase the whole award list out of
          // data/event-content.json. See DESK_EDITABLE_SECTIONS.
          if (!DESK_EDITABLE_SECTIONS.includes(section)) {
            return json(res, 422, {
              error: `"${section}" is not editable from the Event settings page. `
                + (section === 'awards'
                  ? 'The Judge Advisor edits the ceremony on /s/awards.'
                  : 'Credentials and machine wiring live in config.json on the '
                    + 'desk machine.'),
            });
          }
          const stored = await content.set(section, body.value, config);
          // The store changed the config object; now the live modules and the
          // bus have to hear about it, per section.
          switch (section) {
            case 'sponsors':
              sponsors?.setPlan(config.sponsors.list);
              break;
            case 'rundown':
              rundown?.setPlan(config.rundown.segments);
              break;
            case 'game':
              // Same event the boot path emits, so the reducer, the badges and
              // the talent view move together and a replayed log carries the
              // thresholds the matches were actually scored against.
              bus.emit({
                type: 'game.thresholds', source: 'manual',
                payload: {
                  energizedFuel: config.game.rpEnergizedFuel,
                  superchargedFuel: config.game.rpSuperchargedFuel,
                  traversalTower: config.game.rpTraversalTower,
                },
              });
              break;
            case 'accessibility':
              bus.emit({ type: 'event.accessibility', source: 'manual', payload: config.accessibility });
              break;
            // event, kiosk and stream are read from config at the moment of
            // use, so the in-place overlay already took care of them.
          }
          return json(res, 200, { ok: true, section, value: stored });
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
        // Default-code warnings only to the desk laptop: see forAnotherComputer.
        const report = await vitals.report();
        return json(res, 200, isDeskMachine(req) ? report : forAnotherComputer(report));
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
        // The PUBLIC projection: a watch link once a video is published, and
        // nothing about the pipeline. The full row carries the videoId of
        // UNLISTED uploads, which are watchable by anyone holding the id, and
        // raw error strings containing local filesystem paths.
        return json(res, 200, { team, rows: coverage.forTeamPublic(team) });
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
          const body = await readJsonObject(req, res, 8 * 1024);
          if (!body) return;
          return json(res, 200, await profiles.upsert(body as unknown as ProfileInput));
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      if (path === '/api/profiles/delete' && req.method === 'POST') {
        if (!profiles) return json(res, 503, { error: 'Profiles are not available.' });
        try {
          const body = await readJsonObject<{ id?: string }>(req, res, 4 * 1024);
          if (!body) return;
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
          const body = await readJsonObject<{ title?: string; people?: ProfileInput[] }>(
            req, res, 16 * 1024);
          if (!body) return;
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
                // `display`, not `name`. This payload goes on the graphic AND
                // into the append-only event log, which is the artifact that
                // outlives the weekend and gets replayed and archived. A
                // student's full surname must not enter it at all: shortening
                // only at render time would put the thing being avoided into
                // the permanent record and leave it there.
                people: people.map(p => ({ name: p.display, role: p.role, team: p.team })),
              },
            });
          }
          /**
           * The adult-present reminder.
           *
           * [YouTube removes or chat-disables live streams showing minors
           * under 16 who are not visibly accompanied by an
           * adult](https://support.google.com/youtube/answer/2801999), and a
           * repeat costs the channel its ability to stream at all. The failure
           * mode is not one clip, it is the event's stream dying mid-Saturday.
           *
           * Deliberately a REMINDER and not a refusal. A desk that blocks the
           * shot gets routed around within an hour and then the desk knows
           * nothing at all; a line of text at the moment the operator presses
           * the button is the version that survives the weekend. It is also
           * only ever advice: whether an adult is in frame is a fact about the
           * room, and no field in a JSON body can know it.
           */
          const students = people.filter(p => p.student).length;
          const adults = people.length - students;
          const warning = students > 0 && adults === 0
            ? 'Students on camera with no adult on the panel. YouTube needs an adult ' +
              'visibly in frame. Check the shot before you cut to it.'
            : undefined;
          return json(res, 200, { on: people.length, people, warning });
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /*
       * Fill the surfaces with sample data, for somebody testing this thing.
       *
       * A desk with no field attached and no match loaded draws nothing at
       * all, which reads as broken rather than as idle, so "do the overlays
       * even work" is the first question anyone evaluating this asks and the
       * honest answer was "start it again with --demo". That means a restart,
       * and a continuous match loop when all they wanted was to look at the
       * graphic.
       *
       * Refused outright while the field bridge is up. That is the one signal
       * that says this is a real event rather than somebody's desk, and
       * putting invented teams on a projector in a gym is not a mistake worth
       * leaving available. The events are tagged as demo either way, so the
       * score renders outlined and the event log names the source.
       */
      /*
       * A stand-in robot cutout for the sample data, drawn rather than stored.
       *
       * The alliance overview needs SOMETHING in the photo slot to prove that
       * path works end to end, and the alternative was writing invented files
       * into media/teams for real team numbers. That is precisely the shape of
       * mistake this project has already made once: test images for teams 1678
       * and 846 sat in the library for weeks looking like somebody's upload.
       *
       * So it is generated per request, obviously a placeholder, and says so
       * on its face. Nothing is written anywhere.
       */
      if (path.startsWith('/sample/robot/')) {
        const team = Number(path.slice('/sample/robot/'.length).replace(/\.svg$/, ''));
        if (!Number.isInteger(team) || team <= 0) return json(res, 400, { error: 'bad team' });
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 900" `
          + `width="1200" height="900" role="img" aria-label="Sample placeholder">`
          + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
          + `<stop offset="0" stop-color="#7A2E93"/><stop offset="1" stop-color="#3D0B4D"/>`
          + `</linearGradient></defs>`
          // A chassis, a bumper and a lifted arm: enough silhouette to read as
          // a robot at a glance, and plainly not a photograph of one.
          + `<rect x="250" y="360" width="700" height="360" rx="28" fill="url(#g)" `
          + `stroke="#F0AF00" stroke-width="8"/>`
          + `<rect x="250" y="600" width="700" height="90" fill="#ED1C24"/>`
          + `<rect x="560" y="170" width="80" height="210" rx="18" fill="url(#g)" `
          + `stroke="#F0AF00" stroke-width="8"/>`
          + `<circle cx="380" cy="740" r="72" fill="#1B0322" stroke="#F0AF00" stroke-width="8"/>`
          + `<circle cx="820" cy="740" r="72" fill="#1B0322" stroke="#F0AF00" stroke-width="8"/>`
          + `<text x="600" y="540" text-anchor="middle" font-family="sans-serif" `
          + `font-weight="700" font-size="150" fill="#F0AF00">${team}</text>`
          + `<text x="600" y="855" text-anchor="middle" font-family="sans-serif" `
          + `font-weight="700" font-size="42" fill="#FFFFFF" opacity="0.75">SAMPLE</text>`
          + `</svg>`;
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'no-store',
        });
        res.end(svg);
        return;
      }

      if (path === '/api/sample/clear' && req.method === 'POST') {
        const cleared = clearSample ? clearSample() : false;
        // The overlays hold the media map from their last snapshot, and no
        // event carries it: without a push, an open program overlay kept
        // drawing the SAMPLE robot for a real team all weekend.
        if (cleared) broadcastMedia();
        return json(res, 200, {
          ok: true, cleared,
          note: cleared ? 'Sample data cleared from every screen.'
            : 'There was no sample data to clear.',
        });
      }

      if (path === '/api/sample' && req.method === 'POST') {
        if (!seedSample) {
          return json(res, 503, { error: 'Sample data is not available on this desk.' });
        }
        // The bridge NOW, not at start: a field the finder attached at noon is
        // just as much an event as one the launcher found at eight.
        if (bridge()) {
          return json(res, 409, {
            error: 'The field bridge is running, so this desk is at an event. '
              + 'Sample data would put invented teams on every screen. Stop the '
              + 'bridge first if you really are only testing.',
          });
        }
        console.warn('[sample] sample data requested from the desk');
        seedSample();
        // Same reason as the clear: screens already open would otherwise
        // never see the sample photos the overview exists to prove.
        broadcastMedia();
        return json(res, 200, {
          ok: true,
          note: 'Every screen now has sample data. It is tagged as demo, so '
            + 'scores draw outlined and nothing here can be published. It clears '
            + 'itself when a real match loads, or press Clear sample data.',
        });
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
          const body = await readJsonObject(req, res, 32 * 1024, true);
          if (!body) return;

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

      // A player's own view. The player id is the only credential answer()
      // checks, so it travels in a HEADER, the same shape and for the same
      // reason as PIN_HEADER above: a query parameter writes the credential
      // into every access log a request line passes through, and whoever holds
      // another player's id can burn their single answer with a wrong choice.
      //
      // The query parameter is still read, and only for as long as the phone
      // page sends it: surfaces/quiz/index.html polls
      // `/api/trivia/play?player=...`, and dropping the fallback before that
      // line moves to the header would leave a gym full of phones unable to
      // see their own answer state. When quiz switches to the header, delete
      // the searchParams branch with it; nothing else calls this route.
      if (path === '/api/trivia/play') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        const sent = req.headers[PLAYER_HEADER];
        const player = (typeof sent === 'string' ? sent : '')
          || url.searchParams.get('player') || undefined;
        return json(res, 200, trivia.playView(player));
      }

      if (path.startsWith('/api/trivia/') && req.method === 'POST') {
        if (!trivia) return json(res, 503, { error: 'Trivia is not available.' });
        const action = path.slice('/api/trivia/'.length);
        try {
          const body = await readJsonObject(req, res, 16 * 1024, true);
          if (!body) return;
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
            'set "obs": { "enabled": true } in config.json (with the OBS password if it has one) ' +
            'and restart the desk (the OBS steps in docs/handbook-reference.md).' });
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
          const body = await readJsonObject<{ day?: number }>(req, res, 4 * 1024, true);
          if (!body) return;
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
        const cheesy = bridge();
        return json(res, 200, {
          bridged: !!cheesy,
          connected: cheesy?.client.connected ?? false,
          allowedSockets: ALLOWED_SOCKETS,
          allowedPaths: ALLOWED_PATHS,
          requests: cheesy?.client.audit.length ?? 0,
        });
      }

      if (path === '/api/cheesy/audit') {
        const rows = bridge()?.client.audit ?? [];
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
            const body = await readJsonObject<{
              segment?: string; fromMs?: number; toMs?: number; note?: string; sourceId?: string;
            }>(req, res, 8 * 1024);
            if (!body) return;
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
          // Everything that failed, in one press. The realistic failure is not
          // one bad item: it is a quota refusal or a dropped uplink taking out
          // the whole evening's batch at once, and retrying thirty videos one
          // id at a time at 11pm is how they end up not retried at all.
          if (action === 'retry-failed') {
            return json(res, 200, { retried: await publish.retryFailed() });
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
        // Cut at the LOAD of the current match, not a minute before its
        // start: the old minus-60s window reached back into the previous
        // match's final minute, and both consumers painted those markers on
        // the new match's timeline: a head referee reviewing last match's
        // "red takes the lead" against this match's recording, the wrong
        // robot presented as evidence.
        const since = Number(url.searchParams.get('since') || 0)
          || bus.state.matchLoadedAt
          || (bus.lastMatchStartedAt ?? Date.now() - 20 * 60_000) - 60_000;
        return json(res, 200, markersSince(bus, since));
      }

      // Grab a frame and hand it to the telestrator as its backdrop.
      if (path === '/api/frame' && req.method === 'POST') {
        if (!clips) return json(res, 503, { error: 'Recording is not available: ffmpeg not found.' });
        try {
          const body = await readJsonObject<
            { sourceId?: string; atMs?: number; analyst?: string; send?: boolean }>(
            req, res, 8 * 1024);
          if (!body) return;
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
          const saved = await media.ingest(team, await readBody(req));
          // Photos arrive all weekend, after OBS is up. The overlay only
          // learns the media map from a snapshot, so without this push the
          // photographer saw "saved" while the stream kept the gold-number
          // plinth until somebody reloaded a Browser Source.
          broadcastMedia();
          return json(res, 200, saved);
        } catch (err) {
          return json(res, 422, { error: (err as Error).message });
        }
      }

      /*
       * What is already on disk.
       *
       * The cards console kept its "Recent cards" list in a page variable, so
       * a reload, a crash or a second operator on another laptop saw an empty
       * panel while the files sat in rec/cards. The page's own copy said the
       * cards "land here", and the only way back to one was knowing the URL
       * scheme and typing it. Newest first, which is the order somebody
       * posting them wants.
       */
      if (path === '/api/cards' && req.method !== 'POST') {
        const dir = join(root, 'rec', 'cards');
        try {
          const names = (await readdir(dir)).filter(n => n.toLowerCase().endsWith('.png'));
          const rows = await Promise.all(names.map(async name => {
            let savedAt = 0;
            try { savedAt = (await stat(join(dir, name))).mtimeMs; } catch { /* raced */ }
            return { name: name.replace(/\.png$/i, ''), url: `/cards/${name}`, savedAt };
          }));
          rows.sort((a, b) => b.savedAt - a.savedAt);
          return json(res, 200, rows.slice(0, 50));
        } catch {
          // No directory yet just means nothing has been saved.
          return json(res, 200, []);
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

      /*
       * The tab icon, drawn rather than stored.
       *
       * Two things wanted this. Every browser asks for /favicon.ico whether a
       * page links one or not, so every surface was logging a 404 on load,
       * including the OBS Browser Sources and the pit-TV kiosks that reload
       * themselves all weekend. And a desk manager runs six consoles at once:
       * desk, replay, talent, trivia host, house audio, cards. Chrome gives a
       * background tab about fifteen pixels of title and an icon, and the
       * titles all begin the same way, so the icon is the only thing that
       * tells them apart at a glance mid-show.
       *
       * Generated as an SVG so it costs no binary asset and can carry the
       * surface's own letter: /favicon.svg?l=R for the replay console. Gold on
       * the brand purple, chamfered like everything else.
       */
      if (path === '/favicon.svg' || path === '/favicon.ico') {
        const raw = (url.searchParams.get('l') ?? '').trim().slice(0, 2);
        // Letters only, and drawn as a path-free <text>: anything else that
        // reached this would be echoed into markup the browser parses.
        const letter = /^[A-Za-z0-9]{1,2}$/.test(raw) ? raw.toUpperCase() : '';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
          + `<path d="M0 0 H52 L64 12 V64 H12 L0 52 Z" fill="#560f6b"/>`
          + `<path d="M0 0 H52 L64 12 V64 H12 L0 52 Z" fill="none" `
          + `stroke="#f0af00" stroke-width="6"/>`
          + (letter
            ? `<text x="32" y="33" fill="#f0af00" font-family="Arial Narrow,`
              + ` Helvetica, sans-serif" font-weight="700" `
              + `font-size="${letter.length > 1 ? 30 : 42}" text-anchor="middle" `
              + `dominant-baseline="central">${letter}</text>`
            : '')
          + `</svg>`;
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          // A whole event on one icon; it never changes within a session.
          'cache-control': 'public, max-age=86400',
        });
        res.end(svg);
        return;
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
        const rel = path.slice(prefix.length);
        /*
         * A declined team's photo is not served, even though the file is
         * still on disk.
         *
         * `airable` correctly keeps them off every overlay, but the file sat
         * at /media/teams/<team>/robot.v1.png (an open prefix, and a URL
         * guessable from the team number alone), so anyone on the venue
         * network, the same network the trivia QR code advertises to the
         * whole gym, could still fetch it. The page that takes the request
         * promises the team it "comes off every screen immediately", and
         * "unless you type the URL" is not what that means.
         *
         * The file stays on disk: this is a consent decision, not a deletion,
         * and it has to be reversible from the media console.
         */
        const file = safeJoin(base, rel);
        if (prefix === '/media/' && file) {
          // The consent decision keys off the RESOLVED path safeJoin is about
          // to open, never off the URL's surface form. A regex on the raw rel
          // was defeated four separate ways, each resolving to the same real
          // bytes: percent-encoded digits (%32%35%34), a doubled slash
          // (//teams/...), %5C backslashes (a separator to win32 paths), and
          // case variants (Teams/, real to a case-insensitive filesystem).
          // Matching what the filesystem will actually see closes the class,
          // not the instance. Trailing dots and spaces are stripped per
          // segment because Win32 strips them at open ("teams./254" opens
          // teams\254).
          const inside = file.slice(base.length)
            .replace(/\\/g, '/').replace(/^\/+/, '')
            .split('/').map(seg => seg.replace(/[. ]+$/, '')).join('/');
          const team = Number(/^teams\/(\d+)\//i.exec(inside)?.[1]);
          if (Number.isInteger(team) && media.manifest[team]?.consent === 'declined') {
            res.writeHead(404).end('Not found');
            return;
          }
        }
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

      if (path === '/') return sendIndex(res, req);

      res.writeHead(404).end('Not found');
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  });

  /**
   * The LAN base URL as of this request, or null with no usable address.
   * `lanBase` is a function in the running desk (so a new IP, or a cable
   * plugged in after boot, shows up without a restart) and a plain string in
   * the tests that predate that.
   */
  function currentLanBase(): string | null {
    return typeof lanBase === 'function' ? lanBase() : lanBase;
  }

  /*
   * The first thing a first-time operator sees, so it carries the two facts
   * the old startup window used to: the address every other screen needs, and
   * the desk PIN.
   *
   * The launcher stopped opening a window (a window somebody closes takes the
   * broadcast down), and opens the browser on this page instead. But this page
   * listed screens and nothing else, so the handbook's "write the address and
   * the PIN on the whiteboard" pointed at a window that no longer exists, and a
   * volunteer seeing the program for the first time had no way to find either
   * without opening a log file.
   *
   * The ADDRESS is shown to everyone: whoever is reading it already reached
   * the desk, so it tells them nothing new. The PIN and the default-code
   * warnings are shown ONLY to a browser on the desk machine itself. This page
   * is open to the whole venue Wi-Fi, and the trivia QR puts the desk's
   * address on a projector.
   */
  function startPanel(req: IncomingMessage): string {
    // And only to a browser that asked for the desk BY a local name: see
    // isDeskMachine, which is this box's rule and also guards changing the
    // desk PIN.
    const local = isDeskMachine(req);
    const esc = escHtml;
    // Asked for on every load, so the address written on the whiteboard is the
    // one the desk has NOW. No restart: plug in, wait a few seconds, reload.
    const base = currentLanBase();
    const addr = base
      ? `<p class="addr">This desk on the event network: <b>${esc(base)}/</b></p>`
      : `<p class="addr warn">This desk has no address on a network yet. Plug it into
         the event network and reload this page; no restart is needed. Until it has
         one, no other screen can reach it.</p>`;
    // Practice says so to everyone who opens this page, at the top, before
    // anything else: it decides whether today is being kept at all, and
    // nothing else anywhere showed it. Not a secret, so not desk-only.
    const practice = mode ? modeVital(mode) : null;
    const modeLine = practice
      ? `<p class="mode"><b>${esc(practice.detail)}</b> ${esc(practice.fix ?? '')}</p>` : '';
    // Which computer this is, said first. The AV table runs several Windows
    // computers side by side (the switcher's software, the mixer, the field,
    // the graphics output), and nothing else on any of them said which one
    // IS the desk. A display line only, never a gate: the codes below still
    // need the strict local check above.
    const ownAddrs = new Set<string>(['127.0.0.1', '::1']);
    try {
      for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) ownAddrs.add(a.address);
      }
    } catch { /* the line falls back to "another computer" wording */ }
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const sameMachine = local || ownAddrs.has(ip);
    const who = sameMachine
      ? `<p class="who"><b>This computer runs the Content Desk.</b> Keep it on, plugged in
          and on the event network. Closing this browser does not stop the show.</p>`
      : `<p class="who"><b>This computer does not run the Content Desk.</b> The desk runs on
          the computer at ${base ? esc(base) : 'the address on the whiteboard'}; this one only
          shows or controls screens.</p>`;
    if (!local) return `<div class="start">${who}${modeLine}${addr}</div>`;
    // The commonest reason the address works here and nowhere else, said
    // where the address is: the desk cannot see the firewall's answer, and
    // the volunteer at a blank pit TV has no other clue to go on. The link
    // goes to the steps on this same page, not to a handbook chapter.
    const reach = base
      ? `<p class="hint">If other screens cannot open this address, it is the Windows
          Firewall on this laptop or a Wi-Fi that keeps devices apart:
          <a href="#help-reach">what to do</a>.</p>` : '';
    // Desk-only like the codes beside it, because it is about the file that
    // holds them. A broken file is why every code below reads as a default.
    // A report that cannot be read leaves the line out rather than the page:
    // this box is how a first-timer finds the address at all.
    let file: ReturnType<typeof configFileVital> = null;
    try { file = configFileVital(configFile()); } catch { file = null; }
    const fileBad = !!file && (file.level === 'fail' || file.level === 'warn');
    const fileLine = file && fileBad
      ? `<p class="${file.level === 'fail' ? 'bad' : 'warn'}"><b>${esc(file.detail)}</b>
          ${esc(file.fix ?? '')}</p>` : '';
    const defaults = [
      REMOTE_PIN === DEFAULT_CODES.desk ? 'desk PIN' : '',
      JA_PIN === DEFAULT_CODES.awards ? 'awards code' : '',
      SETUP_PIN === DEFAULT_CODES.settings ? 'settings code' : '',
    ].filter(Boolean);
    // Where to change them is a link to a page, never a file to edit or a
    // flag to type: the desk PIN and the settings code on Event settings
    // (the PIN only from this laptop, which is where this box shows), and
    // the awards code by the Judge Advisor on their own page.
    const change = `<a href="/s/setup#codes">Change the codes</a> on Event settings (the settings code opens it)`
      + (defaults.includes('awards code')
        ? '; the Judge Advisor changes the awards code on <a href="/s/awards">their own page</a>.' : '.');
    return `<div class="start">
      <h2 style="margin-top:0">Start here</h2>
      ${who}
      ${modeLine}
      ${fileLine}
      ${addr}
      ${reach}
      <p>Desk PIN: <b>${REMOTE_PIN ? esc(REMOTE_PIN) : 'none set'}</b>. Write the address
        and the PIN on the whiteboard: every screen in the building needs the
        address, and the crew running the consoles need the PIN.</p>
      ${defaults.length ? `<p class="warn">Still on the shipped default: ${defaults.join(', ')}.
        ${file?.level === 'fail'
          ? 'config.json is not in use (see above), so no code set in it applies. '
          : 'Fine for practice; change them before doors. '}${change}</p>` : ''}
      <p>New to this? <a href="/s/desk#sec-sample">Fill the screens with sample data</a>,
        then open the choices above to see them working.
        Signs for the doors: <a href="/s/poster">print the QR posters</a>.</p>
      <p class="hint">Only this computer sees the PIN on this page. Other devices on
        the network see the address alone.</p>
    </div>`;
  }

  /** When this server started, so a status line can tell "still connecting" from "not answering". */
  const startedAt = Date.now();
  /**
   * How long after the start a missing connection still reads as "connecting".
   * The launcher opens the browser on this page the moment the desk answers,
   * which is before the field bridge or OBS has had time to finish its own
   * handshake, so the first load would otherwise say "not answering" about a
   * connection that is a second away from working.
   */
  const SETTLING_MS = statusSettleMs ?? 20_000;

  /**
   * The status strip at the top of the front page: the field and OBS, in
   * plain words, as they stand when the page loads.
   *
   * Built only from what this process already holds in memory (the bridge,
   * the OBS client, the bus state): no probe and no await. This page is the
   * first thing a first-timer sees, and a status line that waited on a field
   * that is not there would be a blank page all over again. Each row is built
   * on its own and reads "could not be checked" if it throws, so the page
   * renders when every check fails.
   *
   * Shown to everyone: the field's connection is already on the open
   * /api/state, and nothing here names a code or a password. Addresses (the
   * switcher's, the AV table's computers') and the switcher's own words go
   * only to the desk laptop (isDeskMachine); everyone else gets the same rows
   * without them.
   *
   * The switcher and the screens rows say the same words as the doors check
   * (switcherVital, screensVital in vitals.ts), so the two never disagree.
   */
  function frontStatus(req: IncomingMessage): string {
    const local = isDeskMachine(req);
    type Level = 'ok' | 'warn' | 'off' | 'unknown';
    const row = (label: string, build: () => { level: Level; text: string }): string => {
      let r: { level: Level; text: string };
      try { r = build(); } catch {
        r = { level: 'unknown', text: 'could not be checked just now. Reload this page to try again.' };
      }
      return `<li class="st-${r.level}"><span class="dot" aria-hidden="true"></span>`
        + `<span><b>${label}:</b> ${r.text}</span></li>`;
    };
    const settling = Date.now() - startedAt < SETTLING_MS;
    const field = row('Field', () => {
      if (mode === 'demo') return { level: 'off', text: 'not used: practice mode plays a pretend match.' };
      if (mode === 'replay') return { level: 'off', text: 'not used: this desk is playing back a saved event log.' };
      // No bridge yet. The desk looks for the field by itself while it runs
      // (the finder, C3), so the usual answer is "wait": the field connects
      // the moment it is up. Not looking at all is a start with /no-cheesy,
      // or a launcher from before the finder.
      if (!bridge()) {
        return fieldSearching()
          ? { level: 'unknown', text: 'searching for the field by itself. It connects as soon as the '
            + 'field is up; until then, matches are run by hand: <a href="#help-field">more</a>.' }
          : { level: 'warn', text: 'not connected, and this desk is not looking for it, so matches are '
            + 'run by hand: <a href="#help-field">what to do</a>.' };
      }
      if (!bus.state.connected.cheesy) {
        return settling
          ? { level: 'unknown', text: 'connecting now. Reload this page in a few seconds.' }
          : { level: 'warn', text: 'not answering right now, so matches are run by hand until it does. '
            + 'The desk keeps trying by itself: <a href="#help-field">what to check</a>.' };
      }
      // The field parked on its Test Match loads nothing the desk shows (the
      // bridge ignores it on purpose, and holds the last real match on the
      // screens), so the match screens wait for a real one. Said here because
      // a waiting screen is easy to take for a broken one.
      const match = bus.state.match;
      return match
        ? { level: 'ok', text: `connected. Match on the screens: ${escHtml(String(match.displayName || match.id))}.` }
        : { level: 'ok', text: 'connected, with no match loaded yet, so the match screens wait for one. '
          + "The field's Test Match does not count: the scorekeeper loads the first real match." };
    });
    // A vital's level as a dot: a failure is as loud as this strip gets.
    const dot = (l: string): Level => (l === 'ok' || l === 'off' || l === 'unknown' ? l : 'warn');
    const switcher = row('Switcher', () => {
      const st = atemStatus();
      // Elsewhere, the same row with the switcher's address left out.
      const v = switcherVital(st && !local ? { ...st, host: null } : st,
        { graphicsInput: settings.resolved.graphicsInput, matchRunning: matchUnderway(bus.state) });
      return { level: dot(v.level),
        text: escHtml(local && v.fix ? `${v.detail} ${v.fix}` : v.detail) };
    });
    const screensRow = row('Screens', () => {
      const list = screens.list();
      const program = list.filter(isProgramPage);
      // Every page reconnects by itself after a start, a few seconds apart;
      // "none open" in that window would send somebody to fix nothing.
      if (!program.length && settling) {
        return { level: 'unknown', text: 'waiting for the screens to reconnect. Reload this page in a '
          + 'few seconds.' };
      }
      const v = screensVital(list, { atem: atemStatus(), fieldConnected: fieldUp(), obs: !!obs });
      if (local) return { level: dot(v.level), text: escHtml(v.fix ? `${v.detail} ${v.fix}` : v.detail) };
      if (!program.length) {
        return { level: 'warn', text: 'no program page is open anywhere yet: see <b>Put the graphics into '
          + 'the video switcher</b>, below.' };
      }
      const places = new Set(program.map(p => whereIs(p.addr))).size;
      return { level: dot(v.level), text: `the program graphics are open on ${places} `
        + `${places === 1 ? 'computer' : 'computers'}.`
        + (v.level === 'ok' ? '' : ' One of them needs a look: the desk laptop says which.') };
    });
    const obsRow = row('OBS', () => {
      // Gray and short: most venues have no OBS now, and that is not a fault.
      if (!obs) return { level: 'off', text: 'not used on this setup.' };
      if (obs.connected) return { level: 'ok', text: 'connected.' };
      return settling
        ? { level: 'unknown', text: 'connecting now. Reload this page in a few seconds.' }
        // Never "edit config.json": whoever switched OBS on did it in that
        // file and knows it, and a first-time volunteer at a venue with no
        // OBS needs to hear that the show does not wait for it.
        : { level: 'warn', text: 'switched on for this desk, but not answering. Using OBS: open it, then '
          + 'Tools, WebSocket Server Settings, and check the server is on and uses the password this '
          + 'desk was set up with. No OBS here: nothing to do, the show runs without it, and whoever set '
          + 'this desk up for OBS can switch that off.' };
    });
    return `<ul class="status" aria-label="How things stood when this page loaded">${field}${switcher}`
      + `${screensRow}${obsRow}</ul>
<p class="again">As of when this page loaded. Reload to check again.</p>`;
  }

  /**
   * The front page, which the exe opens: the only instructions a first-timer
   * should need.
   *
   * It opened with "Core is running. Open a surface below, or point an OBS
   * Browser Source at it." over thirty links, the first of them the program
   * overlay, a transparent page that a browser paints white. With no OBS at
   * the venue, that was the white page the AV coordinator got stuck on. Now:
   * a few plain choices, the Start here box, what to do when something is
   * wrong, and the full list folded away underneath.
   *
   * Every part is built on its own and a part that throws is left out (the
   * Start here box falls back to a line saying so), so the page always goes
   * out. Nothing here is secret except what startPanel guards.
   *
   * The OBS note keeps the see-through graphics (obs-over) apart from the
   * full pictures (obs-full). It once said trivia stayed see-through in OBS;
   * trivia paints its own background in every mode, so an operator who laid
   * it over a camera covered the camera. front-page.test.ts checks each list
   * against the page's own markup.
   */
  function sendIndex(res: ServerResponse, req: IncomingMessage): void {
    const part = (what: string, build: () => string, fallback = ''): string => {
      try { return build(); } catch {
        // The part's name only: an error message is not something this page
        // should copy into desk-log.txt without knowing what it carries.
        console.warn(`[front] the ${what} could not be built; the rest of the page went out`);
        return fallback;
      }
    };
    const status = part('status strip', () => frontStatus(req));
    const start = part('Start here box', () => startPanel(req),
      `<div class="start"><p class="addr warn">This desk's address could not be read just now.
        Reload this page in a few seconds.</p></div>`);
    const base = part('address', () => currentLanBase() ?? '');
    const choices = FRONT_CHOICES.map(c => `<a class="choice" href="${c.href}"><b>${escHtml(c.title)}</b>`
      + `<span>${escHtml(c.text)}</span>`
      // The projector and the switcher feed are usually other computers,
      // which need the whole address typed in: give it whole, rather than
      // "the address, then /s/watch".
      + ((c.href === '/s/watch' || c.href === '/s/program') && base
        ? `<span class="from">From another computer, open <code>${escHtml(base)}${c.href}</code></span>` : '')
      + '</a>').join('');
    const help = FRONT_HELP.map(h => `<div class="q" id="help-${h.id}"><dt>${escHtml(h.see)}</dt>`
      + `<dd>${h.fix}</dd></div>`).join('');
    // Groups in SCREEN_GROUPS order, then any group nobody gave a title, so a
    // row added to SURFACES is never silently left off the list.
    const titled = new Set(SCREEN_GROUPS.map(g => g.group));
    const groups = [...SCREEN_GROUPS, ...[...new Set(SURFACES.map(s => s.group))]
      .filter(g => !titled.has(g)).map(g => ({ group: g, title: g, intro: '' }))];
    const sections = groups.map(g => `<h3>${escHtml(g.title)}</h3>`
      + (g.intro ? `<p class="intro">${escHtml(g.intro)}</p>` : '')
      + '<div class="rows">' + SURFACES.filter(s => s.group === g.group).map(s =>
        `<a class="row" href="${surfacePath(s)}"><b>${escHtml(s.name)}</b><code>${surfacePath(s)}</code>`
        + `<i>${escHtml(s.note)}</i></a>`).join('') + '</div>').join('');
    const html = `<!doctype html><html lang="en" data-surface="console"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CalGames 2026 Content Desk</title>
<link rel="stylesheet" href="/theme/tokens.css">
<link rel="stylesheet" href="/shared/fonts.css">
<style>
body{margin:0;padding:36px clamp(16px,4vw,64px) 80px;font-size:var(--font-ui-body)}
main{max-width:1180px;margin:0 auto}
h1{font-size:clamp(28px,4vw,38px);font-variation-settings:"wdth" 118;margin:0 0 4px}
p.sub{color:var(--text-dim);margin:0 0 16px;font-size:17px}
h2,h3{font-family:var(--font-cond);font-weight:700;font-size:13px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--accent);margin:30px 0 10px}
.status{list-style:none;margin:0;padding:0;display:grid;gap:6px;line-height:1.5}
.status li{display:flex;gap:10px;align-items:baseline}
.status .dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--text-dim)}
.status .st-ok .dot{background:var(--st-ok-text)}
.status .st-warn .dot{background:var(--st-warn)}
.status .st-unknown .dot{background:transparent;box-shadow:inset 0 0 0 2px var(--text-dim)}
.status .st-warn b{color:var(--st-warn)}
.status a{color:var(--accent)}
p.again{color:var(--text-dim);font-size:13px;margin:4px 0 22px}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr));
  gap:14px;margin:0 0 22px}
.choice{display:flex;flex-direction:column;gap:8px;padding:22px 24px;background:var(--surface-raised);
  color:var(--text);text-decoration:none;border-top:4px solid var(--accent);
  clip-path:var(--chamfer);--ch:14px;transition:background var(--dur-tap) linear}
.choice:hover{background:var(--btn-hover)}
.choice:focus-visible{outline:3px solid var(--focus-ring);outline-offset:-6px}
.choice b{font-size:21px;line-height:1.25}
.choice span{color:var(--text-dim);font-size:15px;line-height:1.5}
.choice .from{font-size:13px}
.choice .from code{display:block;margin-top:2px}
.choice code,.fold code{font-family:var(--font-mono);color:var(--accent);font-size:13px;
  overflow-wrap:anywhere}
.rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(540px,100%),1fr));gap:10px 14px}
.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:16px 20px;
  background:var(--surface-raised);text-decoration:none;color:var(--text);
  clip-path:var(--chamfer);--ch:12px;transition:background var(--dur-tap) linear}
.row:hover{background:var(--btn-hover)}
.row:focus-visible{outline:3px solid var(--focus-ring);outline-offset:-6px}
.row b{font-size:19px}
.row code{font-family:var(--font-mono);color:var(--accent);font-size:13px;overflow-wrap:anywhere}
.row i{grid-column:1/-1;color:var(--text-dim);font-style:normal;font-size:13px}
.start{padding:18px 22px;margin:0 0 8px;background:var(--surface-raised);
  clip-path:var(--chamfer);--ch:12px;border-left:6px solid var(--accent)}
.start p{margin:6px 0}
.start .addr b{font-family:var(--font-mono);color:var(--accent);font-size:22px;overflow-wrap:anywhere}
.start .warn{color:var(--st-warn-text,var(--st-warn))}
.start .bad{color:var(--st-bad-text)}
.start .mode{margin:0 0 12px;padding:12px 16px;background:var(--st-warn);color:#000;
  clip-path:var(--chamfer);--ch:8px}
.start .hint{color:var(--text-dim);font-size:13px}
.start .who{font-size:18px;margin:0 0 10px}
.start .who b{color:var(--accent)}
.start a{color:var(--accent)}
.help{margin-top:22px;background:var(--surface)}
.help h2{margin-top:0}
.help dl{margin:0;display:grid;gap:14px}
.help dt{font-weight:700;font-size:16px}
.help dd{margin:4px 0 0;color:var(--text-dim);line-height:1.55}
.help a{color:var(--accent)}
.help dd b{color:var(--text);font-weight:600}
.help code{font-family:var(--font-mono);color:var(--accent);font-size:13px;overflow-wrap:anywhere}
.help .q:target dt{color:var(--accent)}
p.intro{color:var(--text-dim);margin:0 0 12px;line-height:1.5}
.fold{margin:16px 0 0;background:var(--surface);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}
.fold>summary{cursor:pointer;padding:16px 22px;font-weight:700;font-size:16px}
.fold>summary:focus-visible{outline:3px solid var(--focus-ring);outline-offset:-4px}
.fold-in{padding:0 22px 20px}
.fold-in h3:first-child{margin-top:4px}
.fold-in p{line-height:1.55}
</style></head><body><main>
<h1>CalGames 2026 Content Desk</h1>
<p class="sub">The desk is running. Pick what this computer is for.</p>
${status}
<nav class="choices" aria-label="What this computer is for">${choices}</nav>
${start}
<section class="help" id="help" aria-labelledby="help-title">
<h2 id="help-title">Something not working?</h2>
<p class="intro">What you see, then what to do.</p>
<dl>${help}</dl>
</section>
<details class="fold" id="all"><summary>Every screen, with its address (${SURFACES.length})</summary>
<div class="fold-in">${sections}</div></details>
<details class="fold" id="obs"><summary>If you use OBS</summary><div class="fold-in">
<p>OBS is optional. Most venues now put the graphics into a video switcher or onto a projector
  straight from a browser, with the choices at the top of this page.</p>
<p>With OBS, add each graphic as a Browser Source, 1920x1080, at this desk's address.</p>
<p class="obs-over">These stay see-through and sit over your cameras: <code>/s/program</code> for
  the match graphics, <code>/s/tele</code> over the replay, and <code>/s/arcade</code> between
  matches.</p>
<p class="obs-full">These are full pictures with their own background, to cut to rather than lay
  over a camera: <code>/s/trivia</code> and <code>/s/side</code>.</p>
<p>To let the desk switch OBS scenes and watch the stream, set <code>"enabled": true</code> under
  <code>"obs"</code> in config.json, then restart the desk.</p>
<p>In a plain browser, outside OBS, the same graphics draw on black, which a video switcher's
  luma key drops out: that is <b>Put the graphics into the video switcher</b>, above.</p>
<p>Never add the House audio player to OBS: its music is for the room and must stay off the stream.</p>
</div></details>
</main></body></html>`;
    res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ---- WebSocket fan-out -------------------------------------------------
  // maxPayload: the biggest legitimate inbound frame is a telestrator stroke
  // batch, a few KB. Without a cap, ws accepts frames up to its 100MiB default
  // and every one is String()+JSON.parse'd on the show-critical event loop,
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
  let authed = new WeakSet<WebSocket>();
  /** The shortest gap between two hello frames from one socket that is taken. */
  const HELLO_FLOOR_MS = 200;
  const mayWrite = (ws: WebSocket): boolean => !REMOTE_PIN || authed.has(ws);

  /**
   * The desk PIN changed: close every socket that got in with the old one.
   * Each page reconnects by itself, its cookie no longer matches the new
   * session, and desk-client.js sends it to sign in. A socket that is not
   * signed in (an overlay, a pit TV) is left alone: it never had the PIN.
   */
  function signOutDeskSockets(): void {
    const was = authed;
    authed = new WeakSet<WebSocket>();
    for (const ws of wss.clients) {
      if (!was.has(ws)) continue;
      try { ws.close(4001, 'signed out: the desk PIN changed'); } catch { ws.terminate(); }
    }
  }

  // App-level heartbeat. Between matches the bus can go quiet for minutes,
  // and a silently dropped path (a Wi-Fi roam, an unplugged switch port)
  // leaves a surface's socket looking open with nothing to disprove it. A
  // tiny frame every 10s turns that silence into a close event the client's
  // reconnect logic can act on. Clients ignore unknown frame types.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // Carries the server's clock. The surfaces derive the match clock
      // locally from matchStartedAt, so they need to know how far their own
      // Date.now() is from this machine's. The only thing they had to measure
      // that with was state.updatedAt, which is the timestamp of the last
      // EVENT and can be a minute old between matches.
      if (ws.readyState !== ws.OPEN) continue;
      // The stalled-reader check rides the heartbeat too, so a wedged client
      // gets cut even across a quiet stretch when no events are flowing to
      // trip the fan-out's own cap.
      if (ws.bufferedAmount > 16 * 1024 * 1024) { ws.terminate(); continue; }
      ws.send(JSON.stringify({ t: 'hb', now: Date.now() }));
    }
  }, 10_000);

  /**
   * Re-send the media set to every surface.
   *
   * Surfaces get media only in a snapshot, and no event carries it, so every
   * change to the map has to be pushed or an open Browser Source never sees
   * it: a consent change (a team asking to come off the screen must not wait
   * for a reload nobody will do), an upload, and the sample's seed and clear.
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
    // Where this page is, for the doors check and /api/screens (C2). The
    // registry's own id, never one the page chose; the handshake's tag is its
    // name until the page's hello says more.
    const screenId = randomUUID();
    try { screens.add(screenId, { surface: who, addr: plainAddr(addr) }); } catch { /* never block a socket */ }
    ws.on('close', () => { try { screens.remove(screenId); } catch { /* already gone */ } });
    let lastHello = 0;
    // The server's clock first, then the snapshot. A surface that has never
    // heard a beat derives its clock skew from state.updatedAt, the last
    // EVENT's time, and after a restart that can be a state restored from
    // this morning's log: a freshly loaded venue screen then counted down
    // against a clock hours out until the first beat, up to 10 s later.
    send(ws, { t: 'hb', now: Date.now() });
    send(ws, { t: 'snapshot', state: bus.state, media: media.airable, needsPin: !!REMOTE_PIN });

    // Guesses on this one socket. The per-address damper already counts them;
    // this closes the socket too, so a guessing loop cannot even keep its
    // connection.
    let pinFails = 0;

    ws.on('message', raw => {
      let msg: { t?: string; init?: EmitInit; channel?: string; data?: unknown; pin?: string };
      try { msg = JSON.parse(String(raw)) as typeof msg; } catch { return; }
      // A frame of literal `null` parses fine and the next line reads `.t`
      // off it. That throw happens inside an EventEmitter listener, so it is
      // not a 400 to answer but an uncaught exception, which index.ts's one
      // handler logs and carries on from once the show is up. A frame that is
      // not an object is as meaningless as one that is not JSON: ignore it.
      if (notAnObject(msg) !== null) return;

      // A page describing itself (C1): size, full screen, refresh rate, and
      // whose graphics it is showing. No PIN, because an overlay cannot type
      // one, and harmless, because it changes nothing: checked field by field
      // in screens.ts, kept against this one socket, never put on the bus and
      // never sent to another socket. No answer either; no client waits for one.
      if (msg.t === 'hello') {
        // A page says hello on open and then at most about once a second
        // (desk-client.js debounces it). Anything faster is not the desk's
        // client, and each hello wakes the registry's listeners, so a flood
        // is dropped here rather than paid for there.
        const now = Date.now();
        if (now - lastHello < HELLO_FLOOR_MS) return;
        lastHello = now;
        try { screens.hello(screenId, msg); } catch { /* a page's report is never worth a socket */ }
        return;
      }

      if (msg.t === 'auth') {
        if (authBlocked(addr)) {
          send(ws, { t: 'auth', ok: false });
          return;
        }
        // Constant-time-ish: compare full strings, and never echo the PIN back.
        const ok = !!REMOTE_PIN && safeEqual(String(msg.pin ?? ''), REMOTE_PIN);
        if (ok) {
          authed.add(ws);
          noteAuthPass(addr);
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
        // An event type is text, and everything downstream (the reducer, the
        // cue engine, the fan-out's own check for replay paths) reads it as
        // text. A number or an object got past the truthy test above and into
        // the log, and the first subscriber to call a string method on it
        // threw, skipping that event's fan-out and putting a stack trace in
        // desk-log.txt for every such frame. Refused before it is recorded.
        if (typeof msg.init.type !== 'string') {
          send(ws, { t: 'denied', reason: 'An event type has to be text.' });
          return;
        }
        // The award family is refused here BY TYPE: every award write is
        // supposed to sit behind the Judge Advisor tier on /api/awards, and
        // this socket authenticates with the desk PIN alone. Without this
        // check, any desk-PIN session could fire a fabricated
        // award.presented and put a fake winner on the projector
        // mid-ceremony; the JA gate held the secret but not the stage.
        if (String(msg.init.type).startsWith('award.')) {
          send(ws, { t: 'denied', reason: 'Awards run through /api/awards and the JA code.' });
          return;
        }
        // Confidence is clamped, not trusted: bus.emit defaults it to
        // 'authoritative', which is the tier reserved for the field itself.
        // The desk's shadow scoring already sends 'estimated' (typed scores
        // render OUTLINED on air, never solid); without the clamp, any
        // surface holding the desk PIN could omit the field and publish a
        // fabricated score the graphics would present as official.
        bus.emit({ ...msg.init, source: 'manual', confidence: 'estimated' });
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

  /**
   * An event as the open socket may carry it.
   *
   * A replay clip names its file by absolute path on this laptop
   * (C:\Users\<name>\Downloads\...\rec\clips\...), and every clip_ready and
   * every Take carried it to each socket, signed in or not: any phone on the
   * venue Wi-Fi read the desk's Windows account name and folder layout off
   * the fan-out all weekend. The cue engine needs the path, and gets it, from
   * the bus in this process; no surface reads it off the socket, and the
   * event log on disk keeps it for a post-mortem. Only the copy sent out
   * loses it.
   */
  function onTheWire(ev: DeskEvent): DeskEvent {
    const p = ev.payload as unknown;
    // The socket refuses a type that is not text, but an emitter in this
    // process is not checked, and a throw here skips the fan-out of that
    // event to every screen.
    const type: unknown = ev.type;
    if (typeof type !== 'string' || !type.startsWith('replay.')) return ev;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.hasOwn(p, 'path')) return ev;
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) if (k !== 'path') payload[k] = v;
    return { ...ev, payload };
  }

  /*
   * Fan-out, with backpressure. Two rules, both learned the expensive way in
   * other stacks:
   *
   * Stringify ONCE. Every frame carries the full state, and serializing it
   * per client made the cost O(clients x state size) on the show-critical
   * loop for every score tick.
   *
   * Never queue for a stalled reader. A backgrounded phone tab or a wedged
   * kiosk renderer stops reading while its TCP peer keeps ACKing, so
   * readyState stays OPEN forever and every frame appends to that socket's
   * userland buffer: hundreds of MB by mid-afternoon, ending in an OOM that
   * kills every overlay at once. Skipping is safe BECAUSE frames carry the
   * complete state: the next frame under the cap catches the client up in
   * one message. Past the hard cap the client is not coming back; terminate
   * and let its own reconnect logic try again when it wakes.
   */
  const SOFT_BUFFER = 1 * 1024 * 1024;
  const HARD_BUFFER = 16 * 1024 * 1024;
  const unsubscribe = bus.subscribe((ev, state) => {
    const frame = JSON.stringify({ t: 'event', ev: onTheWire(ev), state });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > HARD_BUFFER) { ws.terminate(); continue; }
      if (ws.bufferedAmount > SOFT_BUFFER) continue;
      ws.send(frame);
    }
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

  /**
   * Resolves with the port actually bound, once the server is accepting.
   *
   * Passing port 0 asks the operating system for a free one, which is how a
   * test avoids the fixed port that two runs of the same suite (or a desk left
   * running on the same machine) would fight over: the loser's EADDRINUSE
   * exits the whole process. The running desk always passes a real port and
   * never reads this.
   */
  const listening = new Promise<number>(ok => {
    http.once('listening', () => ok((http.address() as AddressInfo).port));
  });

  http.listen(port, host, () => {
    const bound = (http.address() as AddressInfo).port;
    console.log(`[core] http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}`);
    for (const s of SURFACES) console.log(`         ${surfacePath(s).padEnd(24)} ${s.name}`);

    // Said at startup rather than left to be discovered. At a venue the desk
    // is reachable by every phone in the building, and the trivia QR code
    // puts its address on a projector in front of the whole gym.
    if (!REMOTE_PIN) {
      console.warn('[auth] REMOTE_PIN is empty: the gate is OFF, and anyone who can reach ' +
        'this desk can run the show.');
      console.warn('[auth] Only run this way on a machine nobody else can reach.');
    } else {
      // The same words whatever the codes are. This output is desk-log.txt
      // (the launcher relays every line into it), the file a radio call asks
      // for and a crew chat gets pasted, and "the shipped default (1357)"
      // there handed whoever read it the awards code, which opens the staged
      // winners before the reveal, and the desk PIN with it. The Start here
      // box on this laptop and the PIN-gated doors check say which codes are
      // still the default; nothing in a log may.
      console.log('[auth] control surfaces are PIN-gated; audience surfaces are open. Whether '
        + 'any code is still a shipped default is on the Start here box on this laptop and in '
        + 'the doors check.');
    }
  });

  return {
    close: () => {
      clearInterval(heartbeat); unsubscribe(); unsubChapters();
      settings.off('change', onSettingsChange);
      wss.close(); http.close();
    },
    broadcastCount: () => wss.clients.size,
    /** For index.ts, whose automatic sample clear (a real match loading)
     *  changes the media map with no route of this server involved. */
    broadcastMedia,
    listening,
  };
}
