/**
 * CalGames 2026 Content Desk, core.
 *
 *   npm run dev                       start, watch, demo driver off
 *   npm start -- --demo               simulated match, for building graphics
 *   npm run replay -- data/x.ndjson 4 replay a recorded event log at 4x
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import { EventBus, logPathFor } from './bus.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';
import { startDemo } from './demo.ts';
import { attachMarkers } from './markers.ts';
import { attachPace } from './pace.ts';
import { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { StartggAdapter } from './ingest/startgg/adapter.ts';
import { NexusAdapter } from './ingest/nexus/adapter.ts';
import { CueEngine } from './cue/engine.ts';
import { ObsClient } from './cue/obs.ts';
import { ArcadeStore } from './arcade/store.ts';
import { HouseAudio } from './audio/store.ts';
import { ClipLibrary } from './audio/library.ts';
import { ProfileBook } from './profiles.ts';
import { createSpotify } from './audio/spotify.ts';
import { loadRefreshToken, saveRefreshToken } from './audio/token-store.ts';
import { TriviaStore } from './trivia/store.ts';
import { DEFAULT_QUESTIONS } from './trivia/questions.ts';
import { loadConfig, publishReadiness } from './config.ts';
import { EventContent } from './content.ts';
import { arcadeLabel } from './publish/naming.ts';
import { PublishQueue } from './publish/queue.ts';
import { chooseEncoder, findFfmpeg } from './ffmpeg.ts';
import { Recorder, type SourceConfig } from './recorder.ts';
import { ClipStore } from './clips.ts';
import { CoverageLedger } from './coverage.ts';
import { CardLedger } from './cards.ts';
import { Rundown } from './rundown.ts';
import { Sponsors } from './sponsors.ts';
import { rebuildFromLog } from './rebuild.ts';
import { Awards } from './awards.ts';
import { Slides } from './slides.ts';
import { Vitals } from './vitals.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}
const has = (name: string): boolean => arg(name) !== undefined;

// A value-carrying flag typed bare used to fail silently: `--port` with
// nothing after it fell through to the default without complaint, and a bare
// `--replay` booted a normal desk with no replay and no message at all.
// Refuse at the door: a mistyped launch line must never half-work.
for (const name of ['port', 'host', 'ffmpeg-dir', 'encoder', 'segment',
  'bitrate', 'cheesy-host', 'display-id', 'obs-host', 'replay']) {
  if (arg(name) === '') {
    console.error(`[core] --${name} needs a value after it, and none was given.`);
    process.exit(1);
  }
}

const port = Number(arg('port') || process.env['PORT'] || 8720);
const host = arg('host') || process.env['HOST'] || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[core] the port must be a whole number between 1 and 65535, ` +
    `got "${arg('port') ?? process.env['PORT']}". Try --port 8720.`);
  process.exit(1);
}

// A stray rejected promise must not take the desk down mid-show. Every
// subsystem here already degrades on its own; log loudly and keep going,
// because the overlay dying is always the worse outcome.
process.on('unhandledRejection', reason => {
  console.error('[core] unhandled rejection:', reason);
});

// A synchronous crash during BOOT is fatal. A half-initialized desk is worse
// than none, and the commonest boot failure deserves words instead of a stack:
// the port already being held by a copy of the desk forgotten in another
// window. Once the show is up, the policy flips: a throw nobody anticipated
// (a socket callback, a bad payload) must log and keep the show running,
// because every overlay dying at once is always the worse outcome. This is the
// ONLY uncaughtException handler in the process: a second one registered
// later could never run, since this one would exit first.
let bootComplete = false;
process.on('uncaughtException', err => {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`[core] port ${port} is already in use, probably by another copy of the desk. ` +
      'Close it, or start this one with --port <n>.');
    process.exit(1);
  }
  if (!bootComplete) {
    console.error('[core] fatal during startup:', err);
    process.exit(1);
  }
  console.error('[core] uncaught exception, continuing (the show stays up):', err);
});

const bus = new EventBus();
const media = new MediaLibrary(join(ROOT, 'media'));

try { await media.scan(); } catch (err) {
  console.warn('[media] scan failed, robot cutouts unavailable:', (err as Error).message);
}
try {
  await bus.openLog(logPathFor(join(ROOT, 'data', 'events')));
} catch (err) {
  console.warn('[bus] event log disabled, this session cannot be replayed later:',
    (err as Error).message);
}

// Automatic replay markers: bursts, lead changes, climbs, phase boundaries.
// The replay operator should never hunt.
attachMarkers(bus);

// Schedule pace: actual cycle time + behind-schedule estimate, so the side
// screens can print an honest "est. start" instead of the printed fiction.
attachPace(bus);

// Loaded here rather than with the publish section it mostly serves, because
// the recorder's camera list lives in config.json too.
const config = await loadConfig(ROOT);

// Event content edited at the desk overlays config.json before anything reads
// it: the award list, sponsors, the run of show and friends are editable from
// the desk now, and data/event-content.json is where those edits live.
// config.json still seeds the first run and keeps the credentials.
const content = new EventContent(ROOT);
await content.load();
content.apply(config);

// ---- recording ------------------------------------------------------------
// Optional. Everything else runs without ffmpeg; only recording and replay
// need it.
const REC_ROOT = join(ROOT, 'rec');
let recorder: Recorder | null = null;
let clips: ClipStore | null = null;

const tools = await findFfmpeg(arg('ffmpeg-dir') || undefined);
if (!tools) {
  console.warn('[core] ffmpeg not found, recording and replay disabled. ' +
    '`winget install Gyan.FFmpeg`, then restart this shell.');
} else {
  const encoder = await chooseEncoder(tools.ffmpeg, arg('encoder') || undefined);
  clips = new ClipStore(tools, encoder, REC_ROOT);

  // Recording turns itself on when cameras are configured.
  //
  // The documented deployment is "hand out the exe and double-click", and the
  // launcher has no --record flag to pass, so requiring one meant a desk
  // deployed exactly as the docs prescribe recorded nothing at all: no
  // replay, no clips, no match videos, and a publish pipeline with nothing
  // to publish. Somebody who listed their cameras in config.json has said
  // what they want. --record still forces it on, which is what
  // --test-sources needs, and --no-record turns it off for a laptop.
  const wantRecording = !has('no-record')
    && (has('record') || validRecordingSources(config.recording.sources).length > 0);
  if (wantRecording) {
    // `--test-sources` records synthetic color bars so the whole pipeline can
    // be exercised without cameras plugged in.
    const sources: SourceConfig[] = has('test-sources')
      ? [
          { id: 'program', label: 'Program (test)', role: 'program',
            input: ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'] },
          { id: 'cam1', label: 'Field wide (test)', role: 'iso',
            input: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'] },
        ]
      : validRecordingSources(config.recording.sources);

    if (!sources.length) {
      console.warn('[core] recording asked for but no usable sources. Pass --test-sources, ' +
        'or configure recording.sources in config.json.');
    } else {
      recorder = new Recorder(tools, encoder, {
        root: REC_ROOT,
        segmentSeconds: Number(arg('segment') || 6),
        bitrate: arg('bitrate') || '12M',
        sources,
      });
      try {
        await recorder.start();
        console.log(`[core] recording ${sources.length} source(s) to ${REC_ROOT}`);
      } catch (err) {
        // Usually an unwritable rec directory. The show must still run; only
        // recording and replay are lost.
        recorder = null;
        console.warn('[rec] recorder failed to start, continuing without recording:',
          (err as Error).message);
      }
    }
  }
}

/**
 * config.json is edited by volunteers, so the camera list is checked entry by
 * entry rather than trusted: a typo'd role or a string where the input array
 * belongs skips that source with a warning naming the field. It must never
 * take the desk down at boot, because the show runs without recording.
 */
function validRecordingSources(raw: unknown): SourceConfig[] {
  if (!Array.isArray(raw)) {
    if (raw != null) console.warn('[core] recording.sources in config.json must be an array; ignoring it.');
    return [];
  }
  const out: SourceConfig[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, i) => {
    const skip = (field: string, want: string): void =>
      console.warn(`[core] recording.sources[${i}] skipped: "${field}" ${want}.`);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      console.warn(`[core] recording.sources[${i}] skipped: each source must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const id = e['id'], label = e['label'], role = e['role'], input = e['input'];
    if (typeof id !== 'string' || !id.trim()) return skip('id', 'must be a non-empty string');
    // ClipStore refuses anything but a bare [A-Za-z0-9_-] id (ids become
    // filesystem paths). Accepting a looser id here would record all day and
    // then fail every replay cut and frame grab from that camera.
    if (!/^[\w-]+$/.test(id)) {
      return skip('id', 'may only use letters, digits, "_" and "-" (it becomes a folder name)');
    }
    // Recorder keys its ffmpeg processes by id: a duplicate would spawn two
    // encoders clobbering one segment directory, with the first process
    // orphaned at shutdown: never stopped, never finalized.
    if (seenIds.has(id)) return skip('id', `"${id}" is already used by an earlier source`);
    if (typeof label !== 'string' || !label.trim()) return skip('label', 'must be a non-empty string');
    if (role !== 'program' && role !== 'iso') return skip('role', 'must be "program" or "iso"');
    if (!Array.isArray(input) || !input.length || input.some(a => typeof a !== 'string')) {
      return skip('input', 'must be a non-empty array of ffmpeg argument strings');
    }
    seenIds.add(id);
    out.push({
      id, label, role, input: input as string[],
      ...(typeof e['enabled'] === 'boolean' ? { enabled: e['enabled'] } : {}),
    });
  });
  return out;
}

// ---- Cheesy Arena field bridge ---------------------------------------------
// Deliberately a launch flag rather than a config setting: the bridge needs FTA
// sign-off, and turning it on should be an explicit act at the point of use,
// not something inherited from a file that got copied between machines.
//
//   --cheesy [--cheesy-host 10.0.100.5:8080] [--display-id contentdesk1]
//
// See docs/10-field-bridge.md. Only HandleNotifiers-only sockets are reachable.
let cheesy: CheesyAdapter | null = null;
if (has('cheesy')) {
  cheesy = new CheesyAdapter({
    bus,
    host: arg('cheesy-host') || '10.0.100.5:8080',
    displayId: arg('display-id') || 'contentdesk1',
  });
  cheesy.start();
  console.log(`[cheesy] bridging ${arg('cheesy-host') || '10.0.100.5:8080'} ` +
    `as display "${arg('display-id') || 'contentdesk1'}"`);
} else {
  console.log('[cheesy] bridge off, pass --cheesy to connect to the field');
}

// Side-tournament state for the gaps between matches. Always on: it costs
// nothing when unused and there is no sensible reason to make it a flag.
const arcade = new ArcadeStore(bus);

// Crowd trivia, the other gap-filler, played from the audience's phones.
// A per-event bank in data/trivia.json replaces the default questions.
const trivia = new TriviaStore(bus, await loadTriviaBank(join(ROOT, 'data', 'trivia.json')));

const lan = lanAddress();
if (!lan) {
  console.warn('[core] no LAN address found: QR codes will say localhost and only work on this machine.');
} else if (!process.env['LAN_IP']) {
  const others = lanCandidates().filter(a => a !== lan);
  if (others.length) {
    console.log(`[core] QR codes will use ${lan} (also saw ${others.join(', ')}). ` +
      'If phones cannot reach it, set LAN_IP to the right address.');
  }
}
const lanBase = `http://${lan ?? 'localhost'}:${port}`;
trivia.setJoinUrl(`${lanBase}/s/quiz`);

/**
 * The per-event question bank, checked on the way in.
 *
 * The HTTP path validates every question; this one did not, and the store
 * assumes ids are present and unique. A hand-written or hand-merged file with
 * a missing id makes `askedIds.add(undefined)` mark EVERY id-less question
 * asked the moment the first one is revealed: each round shows finished after
 * one question and resuming skips the rest. Duplicate ids conflate progress
 * the same way, and an out-of-range answer airs a question nobody can get
 * right. All three are quiet: nothing on screen looks broken.
 *
 * A bad question is dropped rather than failing the boot. The host is standing
 * in front of a gym, and thirty good questions with one missing beats a desk
 * that refuses to start.
 */
async function loadTriviaBank(path: string) {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(raw) || !raw.length) return DEFAULT_QUESTIONS;

    const seen = new Set<string>();
    const bad: string[] = [];
    const bank = raw.filter((q, i) => {
      const item = q as Record<string, unknown> | null;
      const id = typeof item?.['id'] === 'string' ? item['id'] as string : '';
      const options = item?.['options'];
      const answer = item?.['answer'];
      const why =
        !id ? 'no id'
          : seen.has(id) ? `duplicate id "${id}"`
            : typeof item?.['text'] !== 'string' || !item['text'] ? 'no text'
              : !Array.isArray(options) || options.length < 2 ? 'needs at least two options'
                : typeof answer !== 'number' || !Number.isInteger(answer)
                  || answer < 0 || answer >= options.length
                  ? 'the answer does not point at one of the options'
                  : null;
      if (why) { bad.push(`#${i + 1} (${why})`); return false; }
      seen.add(id);
      return true;
    });

    if (bad.length) {
      console.warn(`[trivia] skipped ${bad.length} unusable question(s) in ${path}: `
        + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ', ...' : ''));
    }
    if (!bank.length) {
      console.warn('[trivia] none of the questions in that file were usable, '
        + 'falling back to the built-in bank');
      return DEFAULT_QUESTIONS;
    }
    console.log(`[trivia] ${bank.length} questions from data/trivia.json`);
    return bank;
  } catch { /* no per-event bank, use the built-in one */ }
  return DEFAULT_QUESTIONS;
}

/** Every plausible IPv4, real adapters ranked ahead of virtual ones. */
function lanCandidates(): string[] {
  // WSL, Hyper-V, VPN and container adapters all report internal:false, and
  // os.networkInterfaces() is not ordered by route priority, so "first match"
  // used to hand the projector QR codes an address no phone could reach.
  // The regex lives in here rather than at module scope: this function runs
  // before this point in the module, and a module-scope const would still be
  // in its temporal dead zone then.
  const virtualAdapter = /vethernet|wsl|hyper-v|vmware|virtualbox|docker|tailscale|zerotier|loopback/i;
  const real: string[] = [];
  const virtual: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // 169.254.x.x means DHCP never answered; nothing else can reach it.
      if (net.address.startsWith('169.254.')) continue;
      (virtualAdapter.test(name) ? virtual : real).push(net.address);
    }
  }
  return [...real, ...virtual];
}

/** What a phone on the venue wifi can reach. LAN_IP overrides the guess. */
function lanAddress(): string | null {
  return process.env['LAN_IP'] || lanCandidates()[0] || null;
}

// ---- show automation --------------------------------------------------------
// OBS password comes from the environment, never a CLI arg: argv is visible
// in `ps` and in the shell history of whoever launched it.
//
//   --obs [--obs-host 127.0.0.1:4455]   OBS_PASSWORD=...
//   --autopilot                          arm every cue at boot (default: off)
let obs: ObsClient | null = null;
if (has('obs')) {
  const client: ObsClient = new ObsClient({
    host: arg('obs-host') || '127.0.0.1:4455',
    ...(process.env['OBS_PASSWORD'] ? { password: process.env['OBS_PASSWORD'] } : {}),
    onStatus: (up, detail) => {
      console.log(`[obs] ${up ? 'connected' : 'down'}: ${detail}`);
      if (up) void suppressCheesy(client);
    },
  });
  obs = client;
  obs.connect();

  // One overlay system on air: ours. Any OBS source named for a Cheesy Arena
  // page gets switched off, at connect, and on a slow patrol in case someone
  // re-enables one mid-show. See ObsClient.suppressCheesySources.
  const suppressCheesy = async (c: ObsClient): Promise<void> => {
    try {
      const disabled = await c.suppressCheesySources();
      if (disabled.length) {
        console.warn(`[obs] disabled Cheesy overlay source(s) so the scorebugs can't double up: ` +
          disabled.join(', '));
      }
    } catch (err) {
      console.warn('[obs] cheesy-overlay sweep failed:', (err as Error).message);
    }
  };
  setInterval(() => { if (client.connected) void suppressCheesy(client); }, 60_000);
}

// Cues start disarmed. Nobody should discover automation by having it happen
// to them mid-match: the producer arms each cue after watching it be right.
const cues = new CueEngine(bus, obs, { autopilot: has('autopilot') });
cues.attach();
console.log(`[cue] ${cues.status.length} cues loaded, autopilot ` +
  `${has('autopilot') ? 'ARMED' : 'off'}, arm per-cue from the desk`);

// ---- publishing -----------------------------------------------------------
// What each bonus RP costs, straight from config. On the bus rather than read
// directly by the reducer, so the reducer stays pure and a replayed event log
// carries the thresholds the match was actually scored against.
bus.emit({
  type: 'game.thresholds',
  source: 'manual',
  payload: {
    energizedFuel: config.game.rpEnergizedFuel,
    superchargedFuel: config.game.rpSuperchargedFuel,
    traversalTower: config.game.rpTraversalTower,
  },
});

// ---- who is on camera -----------------------------------------------------
// Remembers everyone who has been named on the analysis panel, so the second
// segment of the weekend is a checklist rather than typing.
const profiles = new ProfileBook(ROOT);
await profiles.load();

// ---- house audio ----------------------------------------------------------
// The room's PA, and nothing else. The clip library needs no configuration and
// no internet, so walk-ups work on a laptop at a kitchen table; the music
// service is optional on top of it. See docs/06 for why this can only ever
// reach the house bus.
let audio: HouseAudio | null = null;
const audioClips = new ClipLibrary(join(ROOT, 'media'));
if (config.audio.enabled) {
  try { await audioClips.scan(); } catch (err) {
    console.warn('[audio] clip scan failed:', (err as Error).message);
  }
  // A rotation from a previous session beats the cold-start token in config.
  const refreshToken = await loadRefreshToken(ROOT, config.audio.spotify.refreshToken);
  const music = createSpotify({ ...config.audio.spotify, refreshToken }, {
    // The config token is passed along so the store can record which one this
    // rotation chain started from: pasting a fresh token into config.json is
    // the documented way out of a dead one, and it has to win.
    onTokenRotated: token => {
      void saveRefreshToken(ROOT, token, config.audio.spotify.refreshToken);
    },
  });
  audio = new HouseAudio(bus, {
    controller: music,
    library: audioClips,
    defaultPlaylistUri: config.audio.spotify.playlistUri,
  });
  audio.start();
  // The cue engine is built before house audio (line ordering it cannot
  // change without reordering both), which is exactly why attachAudio
  // exists. It had no caller anywhere, so ctx.audio stayed null and all
  // three house-audio cues were silent no-ops while the cue panel reported
  // them armed and firing.
  cues.attachAudio(audio);
  console.log(music
    ? `[audio] house audio on, ${music.name} configured` +
      (config.audio.spotify.deviceName ? ` for "${config.audio.spotify.deviceName}"` : '')
    : '[audio] house audio on, clips only (no music service configured)');
} else {
  console.log('[audio] off, set audio.enabled in config.json');
}

// What the event offers and where. On the bus like the thresholds, so a
// replayed log carries what was on the screens that day.
bus.emit({
  type: 'event.accessibility',
  source: 'manual',
  payload: config.accessibility,
});
if (config.accessibility.services.length) {
  console.log(`[event] ${config.accessibility.services.length} accessibility service(s) listed`);
} else {
  console.log('[event] no accessibility services listed, set accessibility.services in config.json');
}

// ---- FRC Nexus: the queue ---------------------------------------------------
// What the queuers are doing, which the field does not know yet. Read-only and
// over the internet, so there is no field-safety concern and config alone
// switches it on.
let nexus: NexusAdapter | null = null;
if (config.nexus.apiKey && config.nexus.eventKey) {
  nexus = new NexusAdapter({
    bus, apiKey: config.nexus.apiKey, eventKey: config.nexus.eventKey,
  });
  nexus.start();
  console.log(`[nexus] polling queue status for ${config.nexus.eventKey}`);
} else {
  console.log('[nexus] off, set nexus.apiKey and nexus.eventKey in config.json');
}

// ---- start.gg side-tournament bracket --------------------------------------
// Metadata only: round labels and entrants for the arcade console's pre-fill.
// The live score stays operator-authoritative (docs/05-arcade.md). Unlike the
// field bridge there is no safety concern, so config alone switches it on.
let startgg: StartggAdapter | null = null;
if (config.startgg.token && config.startgg.eventSlug) {
  startgg = new StartggAdapter({ arcade, token: config.startgg.token, eventSlug: config.startgg.eventSlug });
  startgg.start();
  console.log(`[startgg] polling bracket metadata for ${config.startgg.eventSlug}`);
} else {
  console.log('[startgg] off, set startgg.token and startgg.eventSlug in config.json');
}
const publish = new PublishQueue(ROOT, config, bus, clips);
await publish.load();

// Who paid for this, and proof of what they got. Counting is the half nobody
// builds, and it is the half that makes asking again easy.
const sponsors = new Sponsors(bus, config.sponsors.list);
sponsors.attach();

// The day as a list, with a clock derived from measured pace rather than the
// printed schedule nobody believes by 11am.
const rundown = new Rundown(bus, config.rundown.segments);
rundown.attach();
if (config.rundown.segments.length) {
  console.log(`[rundown] ${config.rundown.segments.length} segment(s) planned`);
} else {
  console.log('[rundown] no run of show planned, set rundown.segments in config.json');
}

// The awards ceremony: titles and definitions from config, the reveal from a
// button, and the winner held out of the bus until the moment it happens on
// stage. See awards.ts for why that last part is load-bearing.
const awards = new Awards(ROOT, bus, config.awards.list);
awards.attach();
await awards.load();
// The JA edits the award list from their own page; every change lands in
// data/event-content.json so it survives a restart without touching config.
awards.onListChanged = list => {
  void content.set('awards', { list }, config)
    .catch(err => console.warn('[awards] list could not be saved:', (err as Error).message));
};

// Recognition and info slides, plus the moderated shout-out queue. Additions
// typed at the event persist to data/slides.json.
const slides = new Slides(ROOT, bus, config.slides.list);
await slides.load();

// Cards are a STATE a team carries, not a one-shot event: a yellow follows a
// team all weekend and a second one is a red. Nothing remembered them before.
const cardLedger = new CardLedger();
cardLedger.attach(bus);

// The coverage ledger: one row per match, joined against the queue, so the
// question "did every match that was played end up as a video" has an answer
// on the day rather than in an email three weeks later.
const coverage = new CoverageLedger(publish);
coverage.attach(bus);

/*
 * All four of the above are derived, in-memory, and empty at boot. And a desk
 * DOES restart at an event: a laptop sleeps, a power strip gets kicked,
 * somebody closes the window. The consequences are not cosmetic. A forgotten
 * yellow means the announcer is told a carded team is clean. A forgotten
 * morning means the coverage report raises no gap for a match with no video,
 * which is its one job in exactly the situation it exists for. The sponsor
 * counts under-report airings in a document that goes to the people who paid.
 *
 * So they are rebuilt from today's log, straight into observe() and never
 * through the bus: re-emitting the morning would re-fire cues, re-cut clips
 * and take the program screen to whatever was up at 9am. Nothing here reaches
 * air. See rebuild.ts.
 */
{
  const rebuilt = await rebuildFromLog(join(ROOT, 'data', 'events'),
    [cardLedger, coverage, rundown, sponsors, awards]);
  if (rebuilt.events) {
    console.log(`[rebuild] ${rebuilt.events} event(s) from ${rebuilt.files} log(s) today: ` +
      'cards, coverage, run of show and sponsor counts carried over'
      + (rebuilt.skipped ? ` (${rebuilt.skipped} torn line(s) skipped)` : ''));
  }
}

// One place to ask "is this thing ready", and one place to find out which
// single subsystem broke. See vitals.ts: the failures worth catching are the
// ones nothing else complains about.
const vitals = new Vitals({
  bus, config, root: ROOT, recorder, publish, obs, cheesy, audio, coverage,
  recordBytesPerSec: undefined,
});

{
  const missing = publishReadiness(config);
  if (!config.publish.enabled) {
    console.log('[publish] disabled, set publish.enabled in config.json to turn it on');
  } else if (missing.youtube.length || missing.tba.length) {
    console.warn('[publish] enabled but incomplete: missing ' +
      [...missing.youtube, ...missing.tba].join(', '));
  } else {
    console.log(`[publish] ready · mode=${config.publish.mode} · event=${config.event.key}`);

    // Register the stream on TBA GameDay once per boot. Idempotent on the TBA
    // side (the list replaces itself), and a failure is a warning, not a
    // crash: the show runs fine without GameDay.
    if (config.stream.webcastUrl) {
      publish.registerWebcasts([config.stream.webcastUrl])
        .then(r => { if (r !== null) console.log('[publish] webcast registered on TBA GameDay'); })
        .catch(err => console.warn('[publish] webcast registration failed:', (err as Error).message));
    }
  }
}

// A match video is queued when the score is posted, not at the buzzer: the
// cut needs the score-reveal timestamp to know where its second part starts.
// Not in demo mode OR replay mode: simulated and replayed matches look exactly
// like field data here, and autoQueueMatches defaults on, so either would
// otherwise queue bogus "Qualification N" uploads. A replayed log restamps
// event times to now, so the cut bounds even look plausible.
if (config.publish.autoQueueMatches && !has('demo') && !has('replay')) {
  bus.subscribe(ev => {
    if (ev.type !== 'match.score_posted') return;
    void publish.queueMatch().then(item => {
      if (item) console.log(`[publish] queued ${item.label} (${item.ranges.length} part(s))`);
    }).catch(err => console.warn('[publish] auto-queue failed:', (err as Error).message));
  });
}

// Arcade sets queue themselves the same way: set_end closes the video's
// bounds, and the set has carried its own startedAt since it began. A set
// shorter than the segment QC floor queues held, which is the right answer
// for a 20-second bracket mistake. The replay guard matters more here than for
// matches: a replayed set_end carries its original-day startedAt in the
// payload (payloads are not restamped), so the cut range would span from the
// recording day to now.
if (config.publish.autoQueueArcade && !has('demo') && !has('replay')) {
  bus.subscribe(ev => {
    if (ev.type !== 'arcade.set_end') return;
    const set = (ev.payload as {
      set?: { round?: string; game?: string; startedAt?: number } | null;
    } | null)?.set;
    // A set with no startedAt predates the field (a replayed old log): there
    // is no honest in-point to cut from, so leave it to a manual segment.
    if (!set?.startedAt) return;
    void publish.queueSegment({
      segment: arcadeLabel(set.round ?? '', set.game ?? ''),
      fromMs: set.startedAt,
      toMs: Date.now(),
    }).then(item => console.log(`[publish] queued ${item.label}`))
      .catch(err => console.warn('[publish] arcade auto-queue failed:', (err as Error).message));
  });
}

const server = startServer({
  bus, media, root: ROOT, port, host, recorder, clips, publish, config, cheesy, cues, obs,
  arcade, trivia, audio, audioClips, profiles, coverage, vitals, cardLedger,
  rundown, sponsors, awards, slides, lanBase, content,
});
// From here on, an uncaught throw logs and continues instead of killing every
// overlay at once (see the handler at the top of this file).
bootComplete = true;

// Phase boundaries are time-driven, not event-driven: endgame lockdown and
// the auto-end marker have to land even if nothing else is happening.
const ticker = setInterval(() => bus.advance(), 100);

const replayFile = arg('replay');
if (replayFile) {
  const speed = Number(process.argv[process.argv.indexOf('--replay') + 2] || 1);
  // A mistyped path used to surface as an unhandled rejection stack. One
  // readable line, and the desk stays up.
  void bus.replay(resolve(ROOT, replayFile), Number.isFinite(speed) ? speed : 1)
    .catch(err => console.error(`[bus] replay of ${replayFile} failed: ${(err as Error).message}`));
} else if (has('demo')) {
  if (cheesy) {
    // Demo events are indistinguishable from field data downstream. Mixing
    // them would corrupt the event log and every surface at once.
    console.error('[demo] not started: --cheesy is active, and simulated matches ' +
      'must never mix with real field data. Drop one of the two flags.');
  } else {
    // The demo also seeds dummy standings, schedule, arcade, and trivia so
    // every surface can be judged aesthetically without a field.
    startDemo(bus, { arcade, trivia });
  }
}

let shuttingDown = false;
const shutdown = (): void => {
  // A second Ctrl-C means "now"; never make the operator ask twice.
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log('\n[core] shutting down');
  clearInterval(ticker);
  cheesy?.stop();
  startgg?.stop();
  nexus?.stop();
  audio?.stop();
  cues.detach();
  obs?.close();
  server.close();
  // Flush the event log before exiting: a WriteStream holds its tail in
  // memory, and exiting without end() loses the last events of the session:
  // exactly the ones a post-mortem replay would want. Capped alongside the
  // recorder wait, because shutdown must never hang on a dead stream either.
  setTimeout(() => process.exit(0), 5000);
  const flushes: Promise<unknown>[] = [bus.closeLog()];
  if (recorder) {
    // Give ffmpeg a moment to finalize the segment it's mid-way through:
    // SIGKILL would leave the most recent file unplayable, which is exactly
    // the one you'd want after a crash.
    flushes.push(recorder.stop());
  }
  void Promise.allSettled(flushes).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Die with the launcher window.
 *
 * Windows has no SIGTERM and gives a closing console window no signal we can
 * catch here, so closing the launcher used to leave this process running
 * headless, still holding the port. The next double-click then failed with
 * "port already in use" and nothing on screen explained it.
 *
 * The launcher passes --exit-with-parent and holds the write end of our stdin.
 * Whenever that process goes away, for any reason including being killed
 * outright, the pipe closes and we read EOF here. That runs the ordinary
 * shutdown: the event log gets flushed and the port is released properly,
 * rather than being reclaimed by a kill.
 *
 * Only under the flag. A desk started by hand has a terminal on stdin, and a
 * desk started with stdin closed (a service wrapper, a scheduled task) would
 * see EOF immediately and exit on boot.
 */
if (has('exit-with-parent')) {
  // 'end' and 'close' BOTH fire when the launcher's pipe goes away, and an
  // 'error' can follow. Every extra call reached shutdown()'s "a second
  // Ctrl-C means now" escalation, which exits before closeLog() has flushed
  // the tail of the day. That tail is exactly what rebuildFromLog needs after
  // a restart, so the graceful path was quietly the destructive one. Latch it:
  // the news only arrives once however many times it is announced.
  let parentAlreadyGone = false;
  const parentGone = (): void => {
    if (parentAlreadyGone) return;
    parentAlreadyGone = true;
    if (!shuttingDown) console.log('[core] the launcher window closed');
    shutdown();
  };
  process.stdin.on('end', parentGone);
  process.stdin.on('close', parentGone);
  // A broken pipe is the same news arriving as an error.
  process.stdin.on('error', parentGone);
  process.stdin.resume();
}
