/**
 * Desk vitals and the doors check.
 *
 * Two related problems, one module.
 *
 * The first is that this desk has eight subsystems and each one reports its
 * own health somewhere different. A producer at 8am wants one answer to "is
 * this thing ready", and at 2pm wants to know which single thing broke,
 * without opening four panels.
 *
 * The second is worse and quieter: the failures that actually ruin an event
 * are the ones nothing complains about. Nobody unmuted the announcer mic. The
 * disk filled at 3pm and the recorder has been writing nothing since. OBS is
 * connected and streaming, to a scene that is a black screen. None of those
 * raise an error anywhere, and all of them are checkable.
 *
 * Every check is best-effort and independent: one that throws reports itself
 * as unknown rather than taking the report down, because a health report that
 * cannot be read when things are going wrong is worse than none.
 */

import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import type { CoverageLedger } from './coverage.ts';
import type { HouseAudio } from './audio/store.ts';
import type { ObsClient } from './cue/obs.ts';
import type { PublishQueue } from './publish/queue.ts';
import type { Recorder } from './recorder.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import type { FieldLink } from './ingest/cheesy/field-link.ts';
import type { AtemStatus } from './atem/watcher.ts';
import { isProgramPage, type ScreenInfo } from './screens.ts';
import { DEFAULT_CODES, type Settings } from './settings.ts';
import {
  configFileReport, launchMode, publishReadiness,
  type Config, type ConfigFileReport, type LaunchMode,
} from './config.ts';
import { findFfmpeg } from './ffmpeg.ts';
import { matchUnderway } from './publish/queue.ts';

export type VitalLevel = 'ok' | 'warn' | 'fail' | 'unknown' | 'off';

export interface Vital {
  id: string;
  /** What a volunteer calls this thing. */
  label: string;
  level: VitalLevel;
  /** One line, in the words the desk would say out loud. */
  detail: string;
  /** Only on warn/fail: what to do about it. */
  fix?: string;
  /** True for checks that must pass before doors open. */
  blocking?: boolean;
}

export interface VitalsReport {
  checks: Vital[];
  /** Worst level present, so a dot can be one colour. */
  worst: VitalLevel;
  /** Blocking checks that are not ok. Empty means good to open doors. */
  blockers: Vital[];
  updatedAt: number;
}

export interface VitalsDeps {
  bus: EventBus;
  config: Config;
  root: string;
  recorder?: Recorder | null;
  publish?: PublishQueue | null;
  obs?: ObsClient | null;
  /**
   * Whether the desk has a field bridge, read at the moment of each report
   * (C3): the finder can attach one long after the desk started.
   */
  field?: FieldView | null;
  /**
   * A bridge fixed at start, for a desk or test with no FieldLink. Read only
   * when `field` is absent.
   */
  cheesy?: CheesyAdapter | null;
  /** The read-only switcher watcher, for the Switcher row and the screens' format check. */
  atem?: AtemView | null;
  /** Every open page's own report of where it is showing, for the Screens row. */
  screens?: ScreensView | null;
  /** The codes and connections from the settings page. */
  settings?: Pick<Settings, 'resolved'> | null;
  audio?: HouseAudio | null;
  coverage?: CoverageLedger | null;
  /** Bytes per second the recorder is expected to write, for hours-remaining. */
  recordBytesPerSec?: number;
  /**
   * Bytes free on the drive that holds `root`. Defaults to asking the
   * operating system, which is what the running desk does and nothing passes.
   *
   * Injectable so a test can say how full the disk is instead of inheriting
   * the answer from whichever machine runs it. The disk check is a BLOCKING
   * one, so a test that reads the real drive passes on a roomy laptop and
   * fails on a nearly full one, for a reason that has nothing to do with the
   * code under test.
   */
  freeBytes?: (root: string) => Promise<number>;
  /**
   * The address the server listens on (HOST, or --host). Unset means the
   * server's own default, 0.0.0.0: reachable from every network it is on.
   */
  host?: string;
  /**
   * How config.json loaded. Defaults to what loadConfig found, which is what
   * the running desk wants and passes nothing for; a test says instead.
   */
  configFile?: () => ConfigFileReport;
  /** The practice session this is, or null for the show. Defaults to the launch flags. */
  mode?: LaunchMode | null;
  /**
   * Whether ffmpeg is where the desk looks for it. Defaults to looking, so the
   * Recording row can say which half of its setup is missing; injectable so a
   * test does not inherit the answer from the machine running it.
   */
  ffmpegFound?: () => Promise<boolean>;
}

/**
 * The Settings file row: whether config.json is actually in use.
 *
 * Exported because the Start here box says the same thing in the same words,
 * on the screen a first-timer reads before any other. Null before loadConfig
 * has run, which is only ever a test or a tool. Never quotes the file: a line
 * number and the desk's own section names, nothing typed into it.
 */
export function configFileVital(r: ConfigFileReport): Vital | null {
  const base = { id: 'config-file', label: 'Settings file' };
  if (r.state === 'unread') return null;
  if (r.state === 'missing') {
    // Fine, and said as fine: the codes and connections are set on the
    // settings page now, and nobody needs to make this file to run a show.
    return { ...base, level: 'off',
      detail: 'no config.json in the desk folder, which is fine: the codes and connections are set on '
        + 'the Event settings page, and everything else uses the shipped defaults' };
  }
  const lost = 'so none of it is in use: the awards and settings codes are back to the shipped '
    + 'defaults, OBS is off, and every other setting in it is ignored';
  if (r.state === 'unusable') {
    const near = r.line ? ` near line ${r.line}` : '';
    const around = r.line ? ` around line ${r.line}` : '';
    return { ...base, level: 'fail', blocking: true,
      detail: r.reason === 'not-an-object'
        ? `config.json is not a group of settings (it has to start with { and end with }), ${lost}.`
        : r.reason === 'unreadable'
          ? `config.json is there but could not be read, ${lost}.`
          : `config.json has a typo${near}, ${lost}.`,
      fix: r.reason === 'unreadable'
        ? 'Close any program that has config.json open, check this Windows account can read '
          + 'the desk folder, then restart the desk.'
        : `Open config.json in Notepad and check the quotes and commas${around}: text needs `
          + 'straight "double quotes", and every setting in a group except the last ends with '
          + 'a comma. Save, then restart the desk.',
    };
  }
  // Warnings, not blockers: the file is in use, and only a section or two of
  // it is not what somebody wrote. Usually that section is OBS.
  const said: string[] = [];
  const todo: string[] = [];
  if (r.duplicates.length) {
    const where = r.duplicates.map(d => `"${d.section}" on lines ${
      d.lines.length === 2 ? d.lines.join(' and ') : d.lines.join(', ')}`).join('; ');
    said.push(`config.json has the same section more than once: ${where}. The desk uses only `
      + 'the last of each, so anything in the earlier ones is ignored.');
    todo.push('merge each repeated section into one with the settings you want');
  }
  const ignored = r.ignored ?? [];
  if (ignored.length) {
    // The names only: what was written there ("obs": true, a pasted
    // password) is never repeated back.
    const names = ignored.map(p => `"${p}"`);
    const list = names.length === 1 ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const one = names.length === 1;
    said.push(`config.json gives ${list} something other than a group of settings in { }, so `
      + `the desk ignores ${one ? 'it' : 'them'} and uses the shipped defaults there`
      + `${ignored.includes('obs') ? ' (so OBS is off)' : ''}.`);
    todo.push(`write ${one ? 'it' : 'each'} as a group in { } (copy the block from `
      + 'config.example.json and change the values)');
  }
  if (said.length) {
    return { ...base, level: 'warn', detail: said.join(' '),
      fix: `Open config.json in Notepad, ${todo.join(', and ')}, save, and restart the desk.` };
  }
  return { ...base, level: 'ok', detail: 'config.json read and in use' };
}

/**
 * The Desk mode row. Practice is a warning that holds the doors, not a
 * failure: nothing is broken, but a show run in practice keeps none of the
 * day (no rebuild after a restart, no match videos, and the Judge Advisor's
 * staged winners in a practice file). Exported for the Start here box.
 */
export function modeVital(mode: LaunchMode | null): Vital {
  const base = { id: 'mode', label: 'Desk mode' };
  if (!mode) {
    return { ...base, level: 'ok', detail: "the real show: everything done now is the day's history" };
  }
  const what = mode === 'demo'
    ? 'PRACTICE: started in practice mode (START-PRACTICE.cmd or /demo), running a pretend '
      + 'match on a loop.'
    : mode === 'replay'
      ? 'REPLAY: playing back a saved event log.'
      : 'PRACTICE: started with /rehearsal.';
  return { ...base, level: 'warn', blocking: true,
    detail: `${what} Nothing done now becomes the day's history, no match video is queued, `
      + "and the Judge Advisor's staged winners go to a practice file.",
    fix: 'Before doors, end the desk in Task Manager (Ctrl+Shift+Esc, CalGames 2026 Content Desk, '
      + 'End task), then double-click the exe. A double-click while it is still running only '
      + 'reopens this practice desk.' };
}

/**
 * Whether a listen address only takes connections from this machine.
 *
 * An empty desk PIN is an open door only if somebody else can reach it. The
 * preview renderer runs a desk with no PIN on 127.0.0.1 on purpose, and the
 * doors check painted its console red over a door that leads nowhere.
 */
export function loopbackOnly(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The field as the doors check reads it (C3): a FieldLink, or anything shaped like one. */
export type FieldView = Pick<FieldLink, 'adapter' | 'host' | 'searching'>;

/** The switcher watcher, as far as a report needs it. */
export interface AtemView { readonly status: AtemStatus }

/** The registry of open pages, as far as a report needs it. */
export interface ScreensView { list(): ScreenInfo[] }

/** The words for no switcher, the same on every screen that says it. */
export const NO_SWITCHER = 'No video switcher found on the network. Fine if this setup has none.';

/** The name the AV crew gave an input on the switcher, or its number. */
export function atemInputName(status: AtemStatus, id: number | null): string {
  if (id === null) return 'nothing';
  const input = status.inputs.find(i => i.id === id);
  return input?.longName || input?.shortName || `input ${id}`;
}

/** "DSK1", "M/E 1 key 2": what the switcher's own panel calls a keyer. */
const keyerName = (k: AtemStatus['keyers'][number]): string =>
  k.kind === 'downstream' ? `DSK${k.index}` : `M/E ${k.me ?? 1} key ${k.index}`;

/**
 * The Switcher row: what the vision switcher has on air, read without
 * touching it (the watcher is read-only by construction).
 *
 * Absent hardware is gray, never red: most desks in the world have no
 * switcher, and the AV crew's own panel is the authority on what is on air.
 * The warnings are the two mistakes that ruin a stream quietly: two overlays
 * keyed at once (Cheesy's and the desk's, one over the other), and a match
 * running with the graphics input keyed off, so the stream has no score.
 * Pure, so the front page and the doors check say the same words.
 */
export function switcherVital(status: AtemStatus | null,
  o: { graphicsInput?: number | null; matchRunning?: boolean } = {}): Vital {
  const base = { id: 'switcher', label: 'Switcher' };
  if (!status || status.state === 'off' || status.state === 'searching') {
    // Two errors mean a switcher is plainly meant to be there: one that
    // turned the desk down (no free connection slot), and an address on the
    // settings page the watcher cannot use. Neither is "no switcher", so each
    // is amber in the watcher's own words, which say what to do. Matched on
    // those words, so anything else stays the gray "none found".
    const err = status?.error ?? '';
    if (/turned the desk down/i.test(err)) {
      return { ...base, level: 'warn', detail: 'there is a switcher, but it would not let the desk connect.',
        fix: err };
    }
    if (/not a switcher address|names port/i.test(err)) {
      return { ...base, level: 'warn', detail: 'the switcher address on the Event settings page cannot be used.',
        fix: `${err} Change it on the Event settings page (/s/setup), under Connections.` };
    }
    return { ...base, level: 'off', detail: NO_SWITCHER };
  }
  const at = status.host ? ` at ${status.host}` : '';
  if (status.state === 'connecting') {
    // A typed address that does not answer is somebody's mistake to fix; one
    // the desk found a moment ago is only a handshake under way.
    return status.error
      ? { ...base, level: 'warn', detail: `not answering${at}.`,
        fix: `${status.error} The desk keeps trying by itself.` }
      : { ...base, level: 'unknown', detail: `connecting to the switcher${at}.` };
  }
  if (status.state === 'lost') {
    return { ...base, level: 'warn',
      detail: `lost the switcher${at}, so what is on air is unknown.`,
      fix: 'Check the switcher is on and its network cable is in. The desk reconnects by itself, '
        + 'and the switcher keeps running the show either way.' };
  }
  const name = (id: number | null): string => atemInputName(status, id);
  const onAir = status.keyers.filter(k => k.onAir);
  const keys = onAir.map(k => `${keyerName(k)} (${name(k.fillSource)})`);
  const what = [
    status.model ?? 'switcher',
    status.host ? `at ${status.host}` : '',
    status.videoMode ? `running ${status.videoMode.label}` : '',
  ].filter(Boolean).join(' ');
  const detail = `${what}. Program: ${name(status.program)}. `
    + (keys.length ? `Keyed on air: ${keys.join(', ')}.` : 'No keys on air.');
  // A picture-in-picture box is an upstream DVE key, not an overlay, so two
  // of those, or one with the score, is a normal show.
  const overlays = onAir.filter(k => k.type !== 'dve');
  if (overlays.length >= 2) {
    return { ...base, level: 'warn',
      detail: `${detail} That is ${overlays.length} overlays on air at once, one over the other.`,
      fix: 'On the switcher, take all but one of those keys off air (press its ON AIR button). The '
        + "desk's graphics and Cheesy Arena's overlay come through the same input, so one key is enough." };
  }
  const gfx = o.graphicsInput ?? null;
  if (gfx !== null && o.matchRunning && !onAir.some(k => k.fillSource === gfx)) {
    return { ...base, level: 'warn',
      detail: `${detail} A match is running and the graphics input (${name(gfx)}) is not keyed on air, `
        + 'so the stream shows no score.',
      fix: `On the switcher, put the key that carries ${name(gfx)} on air (on this kit, DSK 1: press its `
        + 'ON AIR button). If the graphics reach the stream another way, clear the graphics input on '
        + 'the Event settings page.' };
  }
  return { ...base, level: 'ok', detail };
}

/** The address of a page's computer as a person reads it. */
export const whereIs = (addr: string): string =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' ? 'this laptop' : addr;

/** Within two frames a second, the way a switcher's frame sync forgives it. */
const HZ_SLACK = 2;

/**
 * The Screens row: where the program graphics are showing, as the pages
 * themselves report it (hello frames, see screens.ts).
 *
 * The checks are the ones that put a broken picture on the stream with
 * nothing complaining: no program page open anywhere; the switcher's feed in
 * a window instead of full screen (the taskbar is keyed onto the stream);
 * that computer's output at another resolution or frame rate than the
 * switcher runs (scaled, juddering, or dropped by the converter); and the
 * handoff to Cheesy Arena's own overlay, which is right when the desk cannot
 * be trusted but means the desk's graphics are not on air. Each says which
 * computer and what to do there.
 *
 * The size and rate checks apply only to a top-level page on black (the
 * switcher feed): a projector page and an OBS source run at their own sizes.
 */
export function screensVital(list: readonly ScreenInfo[], o: {
  atem?: AtemStatus | null;
  /** The field bridge exists and is connected now. */
  fieldConnected?: boolean;
  /**
   * Whether this desk has OBS set up. False means no OBS anywhere, so a
   * see-through page in a plain browser is the white page; unset says nothing.
   */
  obs?: boolean;
} = {}): Vital {
  const base = { id: 'screens', label: 'Screens' };
  const program = list.filter(isProgramPage);
  if (!program.length) {
    return { ...base, level: 'warn',
      detail: 'no program page is open anywhere, so no switcher, projector or TV shows the desk\'s graphics.',
      fix: "On the computer that feeds the switcher's overlay input, open this desk's address with "
        + '/s/program on the end, and press F11. For a projector or TV, open /s/watch on that computer instead.' };
  }
  const places = [...new Set(program.map(s => whereIs(s.addr)))];
  const detail = `the program graphics are open on ${program.length} `
    + `${program.length === 1 ? 'page' : 'pages'}: ${places.join(', ')}.`;
  const said: string[] = [];
  const todo: string[] = [];
  const mode = o.atem?.state === 'connected' ? o.atem.videoMode : null;
  for (const s of program) {
    const where = whereIs(s.addr);
    const on = where === 'this laptop' ? 'on this laptop' : `on ${where}`;
    if (s.showing === 'cheesy') {
      said.push(`The program page ${on} is showing Cheesy Arena's own score overlay instead of the desk's, `
        + (o.fieldConnected
          ? 'because the desk or its field connection was down a moment ago. It switches back by itself in a few seconds.'
          : 'because the desk\'s field connection is down, and Cheesy\'s overlay has the real score meanwhile.'));
      todo.push(`nothing to do ${on}: it switches back to the desk's graphics by itself once the desk and `
        + 'the field are both answering (see the Field bridge row)');
    }
    if (s.embedded !== false) continue;
    // The failure the AV crew met on a test night: ?key=alpha in a plain
    // browser, on a desk with no OBS. A browser paints a see-through page
    // white, and a switcher keying that input puts white over the stream.
    if (o.obs === false && s.key === 'alpha') {
      said.push(`The program page ${on} is the see-through version made for OBS, so a plain browser shows `
        + 'it on white, and on a switcher that white covers the whole stream.');
      todo.push(`${on}, open this desk's address with /s/program on the end and nothing after it, `
        + 'then press F11');
      continue;
    }
    // The handoff (C7) is armed only when that computer can reach Cheesy
    // Arena's own display. While the desk is working nothing on the input
    // shows it, so it is said here, before the first desk hiccup freezes the
    // score on the stream. Only while the field is connected: when it is not,
    // the Field bridge row already says so, and this would repeat it.
    if (s.key === 'luma' && s.backup === 'bad' && o.fieldConnected) {
      said.push(`The program page ${on} cannot reach Cheesy Arena's own score display, so if the desk `
        + "stops, that input keeps its last picture instead of showing the field's score.");
      todo.push(`put ${where} on the field network (the same switch as Cheesy Arena)`);
    }
    if (s.full === false) {
      said.push(`The program page ${on} is in a window, not full screen.`);
      todo.push(`${on}, click the page and press F11`);
    }
    if (!mode || s.key !== 'luma' || mode.width <= 0) continue;
    if (s.sw !== null && s.sh !== null && s.dpr !== null) {
      const pw = Math.round(s.sw * s.dpr);
      const ph = Math.round(s.sh * s.dpr);
      if (pw !== mode.width || ph !== mode.height) {
        said.push(`The program page ${on} is on a ${pw}x${ph} screen, but the switcher runs `
          + `${mode.label} (${mode.width}x${mode.height}).`);
        todo.push(`${on}, open Settings, System, Display, pick the screen that goes to the switcher, and set `
          + `Display resolution to ${mode.width} x ${mode.height}`);
      }
    }
    if (s.hz !== null && mode.fps > 0) {
      // An interlaced format's label is the field rate (1080i59.94 is 29.97
      // frames), and the computer feeding it runs at the field rate.
      const interlaced = /\d+i/.test(mode.label);
      const target = interlaced ? mode.fps * 2 : mode.fps;
      if (Math.abs(s.hz - target) > HZ_SLACK) {
        said.push(`The program page ${on} is refreshing at ${s.hz} Hz, but the switcher runs ${mode.label}.`);
        todo.push(`${on}, open Settings, System, Display, Advanced display, and set the refresh rate to `
          + `${Math.round(target)} Hz`);
      }
    }
  }
  if (!said.length) return { ...base, level: 'ok', detail };
  const fix = todo.join('; ');
  return { ...base, level: 'warn', detail: `${detail} ${said.join(' ')}`,
    fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}.` };
}

/** What the operating system says is free for an ordinary process on `root`'s drive. */
const driveFreeBytes = async (root: string): Promise<number> => {
  const fs = await statfs(root);
  return fs.bavail * fs.bsize;
};

/** Whether ffmpeg is where the desk's own boot would look for it. */
const hasFfmpeg = async (): Promise<boolean> => (await findFfmpeg()) !== null;

/** 12Mbps video plus audio, per source, which is the launcher's default. */
const DEFAULT_BYTES_PER_SEC = (12_000_000 / 8) * 1.05;

const GB = 1024 ** 3;

/** Names that look like a live microphone rather than a media source. */
const MIC_LIKE = /mic|announce|host|talent|commentary|desk|aux/i;

const worstOf = (levels: VitalLevel[]): VitalLevel => {
  if (levels.includes('fail')) return 'fail';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('unknown')) return 'unknown';
  return 'ok';
};

/**
 * The report as any computer but the desk laptop may see it.
 *
 * "Still on the shipped default: awards code" is a default-code warning, and
 * those go only to the desk laptop (the server's isDeskMachine), as the Start
 * here box and GET /api/settings keep them: a shipped default is a public
 * code, so that line on a console at the AV table tells whoever reads it the
 * code that opens the staged winners. So the warning row is left out there,
 * not grayed (the desk console shows any Access codes row it is given), and
 * the worst level is worked out again without it. An empty desk PIN stays: it
 * is a blocker, and it names no code anyone could not already use.
 */
export function forAnotherComputer(report: VitalsReport): VitalsReport {
  const checks = report.checks.filter(c => !(c.id === 'codes' && c.level === 'warn'));
  return {
    ...report,
    checks,
    worst: worstOf(checks.filter(c => c.level !== 'off').map(c => c.level)),
  };
}

export class Vitals {
  #d: VitalsDeps;

  constructor(deps: VitalsDeps) { this.#d = deps; }

  async report(): Promise<VitalsReport> {
    const checks: Vital[] = [];
    // Run them together: a check that has to talk to OBS should not make the
    // disk check wait, and the whole report is polled from a browser.
    const results = await Promise.allSettled([
      this.#settings(), this.#disk(), this.#eventLog(), this.#recorder(), this.#obs(), this.#audioInputs(),
      this.#field(), this.#switcher(), this.#screens(), this.#publish(), this.#house(), this.#coverage(),
      this.#codes(),
    ]);
    for (const r of results) {
      if (r.status === 'fulfilled') checks.push(...r.value);
      else {
        checks.push({
          id: 'check-failed', label: 'A check failed to run',
          level: 'unknown', detail: String(r.reason),
        });
      }
    }
    return {
      checks,
      worst: worstOf(checks.filter(c => c.level !== 'off').map(c => c.level)),
      blockers: checks.filter(c => c.blocking && c.level !== 'ok' && c.level !== 'off'),
      updatedAt: Date.now(),
    };
  }

  /**
   * The practice mode, and whether config.json is in use. First in the list,
   * because each one changes what every row after it means.
   */
  async #settings(): Promise<Vital[]> {
    const file = configFileVital((this.#d.configFile ?? configFileReport)());
    return file ? [modeVital(this.#mode()), file] : [modeVital(this.#mode())];
  }

  #mode(): LaunchMode | null {
    return this.#d.mode === undefined ? launchMode() : this.#d.mode;
  }

  /**
   * The event log, which is what a restart rebuilds the day from: cards,
   * coverage, trivia scores, the run of show, the safety message.
   *
   * A write error (the disk the recorder filled, an antivirus or sync client
   * holding the file) stops it, and the bus now tries a fresh file by itself
   * every LOG_RETRY_MS. Until one works the day is going unwritten, and the
   * only sign was a line in desk-log.txt. Blocking, because a restart in that
   * state quietly loses everything since the failure. No row at all when
   * logging was never asked for (a test, a tool).
   */
  async #eventLog(): Promise<Vital[]> {
    const base = { id: 'event-log', label: 'Event log' };
    const { bus } = this.#d;
    const problem = bus.logProblem;
    if (problem) {
      // The error's own words up to its first comma: "ENOSPC: no space left
      // on device". After the comma Node names the call and the file's full
      // path, which says nothing an operator can use.
      const why = problem.split(', ')[0]!.trim() || 'an unknown error';
      return [{ ...base, level: 'fail', blocking: true,
        detail: `not being written (${why}). Until it is, a restart would rebuild the day only `
          + 'up to the moment it stopped.',
        fix: `The desk tries again by itself every ${Math.round(EventBus.LOG_RETRY_MS / 1000)} `
          + 'seconds, and this row clears once it works. Usually the disk is full: free space now '
          + '(see the Disk row). Otherwise close whatever has the data folder open (a sync '
          + 'program, an antivirus scan). Do not restart the desk until this row is green.' }];
    }
    if (bus.logPath) {
      // A practice or replay desk writes a practice file that the next boot
      // leaves out, so the show's promise would contradict the Desk mode row
      // directly above it.
      return [{ ...base, level: 'ok', detail: this.#mode() === null
        ? 'being written, so a restart rebuilds the day from it'
        : 'being written to a practice file that the next start of the desk ignores (see Desk mode)' }];
    }
    return [];
  }

  /**
   * Disk, expressed in HOURS OF RECORDING rather than gigabytes.
   *
   * "38GB free" means nothing to the person who has to decide whether to start
   * the day. "About 3 hours" is the same number in the unit the decision is
   * actually made in, and four cameras at 12Mbps eat a disk faster than
   * anybody's intuition expects.
   */
  async #disk(): Promise<Vital[]> {
    try {
      const freeBytes = await (this.#d.freeBytes ?? driveFreeBytes)(this.#d.root);
      // A drive that answers with nonsense is an unreadable drive, not a
      // healthy one: NaN fails every comparison below and would have read as
      // "ok" with "NaN hours" on a check people trust to stop them opening doors.
      if (!Number.isFinite(freeBytes) || freeBytes < 0) {
        throw new Error(`the drive reported ${freeBytes} bytes free`);
      }
      // The sources the recorder will actually open, not every source in the
      // file. It skips `enabled: false` ones, so four configured with three
      // disabled reported a QUARTER of the true hours, enough to trip the
      // blocking "under two hours" fail on a disk that comfortably holds the
      // day, on a check whose entire premise is giving an honest number.
      const live = this.#d.config.recording.sources.filter(src => src.enabled !== false);
      const perSec = (this.#d.recordBytesPerSec ?? DEFAULT_BYTES_PER_SEC)
        * Math.max(1, live.length);
      const hours = freeBytes / perSec / 3600;
      const gb = Math.round(freeBytes / GB);

      const level: VitalLevel = hours < 2 ? 'fail' : hours < 5 ? 'warn' : 'ok';
      return [{
        id: 'disk',
        label: 'Disk',
        level,
        blocking: true,
        detail: `${gb}GB free, about ${hours.toFixed(1)} hours of recording`,
        // In the words of the exe, which cannot take a flag: "point --record
        // at a bigger drive" named one, and nothing a first-time crew can do.
        // Nothing prunes rec, so its oldest camera files are where the room
        // is; its clips folder is the cut match videos, which must stay.
        ...(level === 'ok' ? {} : {
          fix: 'Free space on this drive now: empty the Recycle Bin and move anything that is '
            + 'not the desk to another drive. If that is still not enough, move the oldest camera '
            + 'files (named by date and time, practice first) out of the camera folders in the '
            + 'rec folder inside the desk folder, and leave its clips folder alone: that holds '
            + 'the cut match videos. A full disk during playoffs loses the matches people most want.',
        }),
      }];
    } catch (err) {
      return [{
        id: 'disk', label: 'Disk', level: 'unknown',
        detail: `could not be read: ${(err as Error).message}`,
      }];
    }
  }

  async #recorder(): Promise<Vital[]> {
    const rec = this.#d.recorder;
    if (!rec) {
      /*
       * Which half is missing, in the words of the exe. "Started without
       * --record" named a flag the exe has no way to pass (recording turns on
       * by itself once cameras are listed), so a replay operator with neither
       * ffmpeg nor a camera list had nothing to act on. Still 'off', never a
       * blocker: the show runs without recording.
       */
      const sources = this.#d.config.recording?.sources;
      const listed = Array.isArray(sources) && sources.some(s => s && s.enabled !== false);
      let ffmpeg = false;
      try { ffmpeg = await (this.#d.ffmpegFound ?? hasFfmpeg)(); } catch { /* unknown: say missing */ }
      // Neither half is the normal state of a kit that records on its own
      // hardware (a Web Presenter, the switcher's own recorder): gray, in
      // plain words, with no chapter of a manual to go and read. A setup
      // half done says which half, because somebody started on it.
      return [{
        id: 'recorder', label: 'Recording', level: 'off',
        detail: !ffmpeg && !listed
          ? 'not used on this setup: this desk records no cameras, so its replay and match video '
            + 'tools have nothing to cut (ffmpeg is not installed, and no cameras are listed under '
            + '"recording" in config.json)'
          : !ffmpeg
            ? 'not running: ffmpeg is not installed on this laptop, so there are no replays or match videos'
            : !listed
              ? 'not running: no cameras are listed under "recording" in config.json, so there are '
                + 'no replays or match videos'
              : 'not running, though ffmpeg is installed and config.json lists cameras: desk-log.txt '
                + 'says why (a camera entry it could not use, a recorder that failed to start, or '
                + 'ffmpeg installed after the desk started). Fix that, then restart the desk.',
      }];
    }
    const sources = rec.status;
    const dead = sources.filter(s => !s.running);

    // A live ffmpeg process is not a recording. Capture boxes stall without
    // exiting (dshow blocks on an input that stopped delivering), and this
    // is exactly the header's "writing nothing since" failure: the process
    // table says rolling while the disk gains nothing. Segments are named
    // %Y%m%d-%H%M%S, so the newest is the lexicographic max: one readdir
    // and one stat per source, no scan of the day's thousands of files.
    const stallMs = Math.max(30_000, rec.segmentSeconds * 10_000);
    const stalled: string[] = [];
    if (process.uptime() * 1000 > stallMs) {
      for (const src of sources) {
        if (!src.running) continue;
        try {
          const dir = rec.dirFor(src.id);
          const newest = (await readdir(dir)).filter(f => f.endsWith('.mp4')).sort().pop();
          if (!newest) { stalled.push(src.id); continue; }
          const st = await stat(join(dir, newest));
          if (Date.now() - st.mtimeMs > stallMs) stalled.push(src.id);
        } catch { stalled.push(src.id); }
      }
    }

    const bad = dead.length
      ? `${dead.length} of ${sources.length} source(s) stopped: ${dead.map(s => s.id).join(', ')}`
      : stalled.length
        ? `${stalled.length} of ${sources.length} source(s) stalled (running but writing ` +
          `nothing): ${stalled.join(', ')}`
        : '';
    return [{
      id: 'recorder',
      label: 'Recording',
      level: bad ? 'fail' : 'ok',
      blocking: true,
      detail: bad || `${sources.length} source(s) rolling`,
      ...(bad ? { fix: 'Check the capture device is still plugged in, then restart the desk.' } : {}),
    }];
  }

  /**
   * The access codes, and whether any still ships as its factory default.
   *
   * The doors check is the forcing function: the codes ship with working
   * defaults so a practice run works out of the box, but a default awards
   * code is a public one (it is in the repo and the handbook), and the
   * awards tier exists to keep winners secret until the ceremony. A default
   * left in place at a real event is a spoiler leak, and this is the one
   * place someone looks before doors and asks "is this ready".
   *
   * Resolved exactly as the server resolves them (env var, then config, then
   * the shipped default), so this reports what is actually live.
   */
  #codes(): Vital[] {
    const cfg = this.#d.config;
    // The settings page's codes when there is a Settings, which is what the
    // server runs on (they change live, so this row must read them live).
    const live = this.#d.settings?.resolved.codes;
    const desk = live ? live.desk : process.env['REMOTE_PIN'] ?? DEFAULT_CODES.desk;
    // String() for the same reason the server does it: "pin": 2468 unquoted in
    // config.json is a number, and a thrown .trim() here is raised while the
    // list of checks is still being built, so it would take the whole health
    // report down rather than just this row.
    const ja = live ? live.awards : String(process.env['JA_PIN'] ?? cfg.awards?.pin ?? DEFAULT_CODES.awards).trim();
    const setup = live ? live.settings
      : String(process.env['SETUP_PIN'] ?? cfg.setup?.pin ?? DEFAULT_CODES.settings).trim();
    // An explicitly EMPTY desk PIN is not a "changed" code: it is the gate
    // switched off (the server lets every request through), the kitchen-table
    // escape hatch. It used to read as changed, so with the other two codes
    // set the row said OK while every control surface was open to the gym's
    // Wi-Fi. Unlike a default code this is a blocker: the doors check is the
    // one place a from-source start that kept the override gets caught.
    if (desk === '') {
      // Off, not ok and not a blocker: nothing on the venue Wi-Fi can reach
      // a desk that only listens on this machine, so there is no door to hold
      // shut. Said plainly anyway, because the same setting on any other
      // address is the worst row on this report.
      if (loopbackOnly(this.#d.host)) {
        return [{
          id: 'codes', label: 'Access codes', level: 'off',
          detail: `The desk PIN is empty, but the desk only answers on this machine (${this.#d.host}), `
            + 'so nobody on the venue Wi-Fi can reach it.',
        }];
      }
      return [{
        id: 'codes', label: 'Access codes', level: 'fail', blocking: true,
        detail: 'The desk PIN is empty, so every control surface is open to anyone '
          + 'on the venue Wi-Fi.',
        fix: 'Set a desk PIN on the Event settings page (/s/setup, on the desk laptop), or drop the '
          + 'empty REMOTE_PIN override and restart the desk.',
      }];
    }
    const onDefault: string[] = [];
    if (desk === DEFAULT_CODES.desk) onDefault.push('desk PIN');
    if (ja === DEFAULT_CODES.awards) onDefault.push('awards code');
    if (setup === DEFAULT_CODES.settings) onDefault.push('settings code');
    if (!onDefault.length) {
      return [{ id: 'codes', label: 'Access codes', level: 'ok',
        detail: 'all three changed from the shipped defaults' }];
    }
    // A WARNING, not a blocker: a kitchen-table practice run is on defaults by
    // design and must not read as a broken event, but a real operator running
    // the doors check sees the amber and the reason. The awards code is called
    // out by name because it is the one whose default leaks spoilers.
    const leaksSpoilers = onDefault.includes('awards code');
    return [{
      id: 'codes', label: 'Access codes', level: 'warn',
      detail: `still on the shipped default: ${onDefault.join(', ')}. `
        + (leaksSpoilers
          ? 'Anyone with a copy of this software knows the awards code, so it '
            + 'leaks winners before the ceremony. Change it for a real event.'
          : 'Anyone with a copy of this software knows these. Change them for a real event.'),
      // Where each one is changed, on a page, at once: no file and no flag.
      fix: 'On the desk laptop, change the desk PIN and the settings code on the Event settings page '
        + '(/s/setup). The Judge Advisor changes the awards code on their own page (/s/awards).',
    }];
  }

  async #obs(): Promise<Vital[]> {
    const obs = this.#d.obs;
    if (!obs) {
      // Named by the switch the exe actually has: the launcher passes no
      // --obs, so pointing at the flag sent a first-time crew to a command
      // line they never see.
      // Gray and short. Most venues no longer run OBS (NorCal's kit is a
      // hardware switcher), and a row telling a first-timer to edit a file to
      // turn on something they do not have read as a fault to fix. The front
      // page's "If you use OBS" note says how, for whoever does.
      return [{
        id: 'obs', label: 'OBS', level: 'off',
        detail: 'not used on this setup',
      }];
    }
    if (!obs.connected) {
      return [{
        id: 'obs', label: 'OBS', level: 'fail', blocking: true,
        detail: 'not answering',
        // The password by what it is, not by where it is stored: whoever
        // switched OBS on put it there, and the volunteer reading this never
        // has a file to open.
        fix: 'Open OBS, then Tools > WebSocket Server Settings: check the server is '
          + 'enabled, and that it uses the password this desk was set up with.',
      }];
    }
    try {
      const status = await obs.streamStatus();
      const live = status.outputActive === true;
      /*
       * OBS trying to get its RTMP connection back. Declared on StreamStatus
       * and read by nobody: if the stream dropped mid-match, OBS reported
       * "connected, not streaming" and stream health reported "not
       * streaming", and NEITHER is a failure. Both are exactly what the
       * normal between-days state looks like, so the desk's health page
       * stayed green through a stream outage in the finals.
       */
      const reconnecting = status.outputReconnecting === true;
      // Whether anybody is watching right now. "Not streaming" is fine on
      // Friday morning and is an emergency during a match, and until now the
      // desk could not tell those apart.
      const onAir = matchUnderway(this.#d.bus.state);
      const dropped = Number(status.outputSkippedFrames ?? 0);
      const total = Math.max(1, Number(status.outputTotalFrames ?? 0));
      const pct = (dropped / total) * 100;

      const obsLevel: VitalLevel = reconnecting ? 'fail' : 'ok';
      const streamLevel: VitalLevel = reconnecting ? 'fail'
        : !live ? (onAir ? 'fail' : 'off')
          : pct > 5 ? 'fail' : pct > 1 ? 'warn' : 'ok';

      return [{
        id: 'obs', label: 'OBS', level: obsLevel,
        ...(reconnecting ? { blocking: true } : {}),
        detail: reconnecting ? 'RECONNECTING: the stream has dropped'
          : live ? `streaming, ${pct.toFixed(1)}% frames dropped`
            : 'connected, not streaming',
        ...(reconnecting ? {
          fix: 'OBS has lost the RTMP connection and is retrying. Check the ' +
            'uplink. If it does not come back, stop and restart the stream ' +
            'rather than leaving it retrying.',
        } : {}),
      }, {
        id: 'stream-health',
        label: 'Stream health',
        level: streamLevel,
        detail: reconnecting ? 'dropped, reconnecting'
          : live ? `${dropped} dropped of ${total}`
            : onAir ? 'NOT STREAMING, and a match is underway' : 'not streaming',
        ...(streamLevel === 'fail' && !live && !reconnecting ? {
          fix: 'A match is on the field and nothing is going out. Start the ' +
            'stream in OBS.',
        } : {}),
        ...(live && pct > 1 ? {
          fix: 'The uplink is struggling. Drop the bitrate, or shed the second ' +
            'program feed (docs/11 degraded-uplink runbook).',
        } : {}),
      }];
    } catch (err) {
      return [{
        id: 'obs', label: 'OBS', level: 'unknown',
        detail: `connected, but status failed: ${(err as Error).message}`,
      }];
    }
  }

  /**
   * The muted microphone.
   *
   * The single most common broadcast failure at any event, and one nothing
   * complains about: the show runs, the graphics are right, and forty minutes
   * of it have no commentary. obs-websocket can be asked directly, so ask.
   */
  async #audioInputs(): Promise<Vital[]> {
    const obs = this.#d.obs;
    if (!obs?.connected) return [];
    try {
      const list = await obs.request<{ inputs?: { inputName?: string; inputKind?: string }[] }>(
        'GetInputList');
      const mics = (list.inputs ?? [])
        .filter(i => MIC_LIKE.test(i.inputName ?? '') || /wasapi_input|coreaudio_input/.test(i.inputKind ?? ''));
      if (!mics.length) {
        return [{
          id: 'mics', label: 'Microphones', level: 'unknown',
          detail: 'no inputs in OBS look like a microphone',
        }];
      }

      const muted: string[] = [];
      for (const mic of mics) {
        const name = mic.inputName ?? '';
        try {
          const state = await obs.request<{ inputMuted?: boolean }>(
            'GetInputMute', { inputName: name });
          if (state.inputMuted) muted.push(name);
        } catch { /* one unreadable input must not hide the others */ }
      }

      return [{
        id: 'mics',
        label: 'Microphones',
        level: muted.length ? 'warn' : 'ok',
        detail: muted.length
          ? `muted in OBS: ${muted.join(', ')}`
          : `${mics.length} live`,
        ...(muted.length ? {
          fix: 'If that is deliberate, ignore this. If it is not, the show is ' +
            'about to have no commentary and nothing else will tell you.',
        } : {}),
      }];
    } catch (err) {
      return [{
        id: 'mics', label: 'Microphones', level: 'unknown',
        detail: (err as Error).message,
      }];
    }
  }

  /**
   * The bridge as it stands at this moment (C3): the FieldLink's, which the
   * finder can attach long after the start, or the fixed one a desk without
   * a FieldLink was given. A getter that throws reads as no bridge.
   */
  #adapter(): CheesyAdapter | null {
    try { return this.#d.field ? this.#d.field.adapter : this.#d.cheesy ?? null; } catch { return null; }
  }

  async #field(): Promise<Vital[]> {
    const adapter = this.#adapter();
    if (!adapter) {
      // In plain words, with nothing to type. The desk looks for the field by
      // itself now (the finder), so the old advice, restart with
      // /cheesy-host:ADDRESS from a command prompt, is gone from the row.
      const mode = this.#mode();
      const searching = (() => { try { return !!this.#d.field?.searching; } catch { return false; } })();
      return [{
        id: 'field', label: 'Field bridge', level: 'off',
        detail: mode === 'demo'
          ? 'not connected: practice mode runs without the field'
          : mode === 'replay'
            ? 'not connected: this desk is playing back a saved event log'
            : searching
              ? 'searching for the field by itself. It connects as soon as the field is up; until then, '
                + 'matches are run by hand (Field down? Run matches by hand, in the desk console).'
              : 'not connected, and this desk is not looking for the field, so matches are run by hand. '
                + 'Once the field is up, restart the desk (Task Manager, End task, double-click the exe) '
                + 'and it finds the field by itself.',
      }];
    }
    const up = this.#d.bus.state.connected.cheesy;
    const host = (() => { try { return this.#d.field?.host ?? null; } catch { return null; } })();
    const out: Vital[] = [{
      id: 'field', label: 'Field bridge', level: up ? 'ok' : 'warn',
      detail: up ? `connected to Cheesy Arena${host ? ` at ${host}` : ''}` : 'not answering',
      ...(up ? {} : {
        fix: 'The desk still runs on operator input. Check the cable and the ' +
          'field host, and remember scores go on air estimated until it returns.',
      }),
    }];

    /*
     * The field's period lengths against the ones this desk is built for.
     *
     * Every one of them is editable on the scorekeeper's settings page, and
     * shortening practice or filler matches is a normal thing to do at an
     * offseason. The desk compiles its timings in, so if they diverge then
     * the phase labels, the endgame chip, the motion lockdown, the replay
     * markers and the on-air countdown are all quietly wrong for the rest of
     * the day. Nothing anywhere would have said so; the arena has been
     * sending its own numbers on every connect the whole time.
     */
    const off = adapter.timingMismatch;
    if (off?.length) {
      out.push({
        id: 'field-timing', label: 'Match timing', level: 'warn',
        detail: `the field disagrees with this desk: ${off.join('; ')}`,
        fix: 'Either put the field back to the standard periods on its own ' +
          'settings page, or expect the endgame chip, the lockdown and the ' +
          'countdown to be off by that much for the rest of the day.',
      });
    }
    return out;
  }

  /** The Switcher row; see switcherVital. Gray when there is no watcher at all. */
  async #switcher(): Promise<Vital[]> {
    // A watcher that cannot be read is no switcher to report, never a broken
    // report: the switcher keeps running the show whatever the desk knows.
    let status: AtemStatus | null = null;
    try { status = this.#d.atem ? this.#d.atem.status : null; } catch { status = null; }
    let graphicsInput: number | null = null;
    try { graphicsInput = this.#d.settings?.resolved.graphicsInput ?? null; } catch { graphicsInput = null; }
    return [switcherVital(status, { graphicsInput, matchRunning: matchUnderway(this.#d.bus.state) })];
  }

  /**
   * The Screens row; see screensVital. No row at all for a desk with no
   * registry (a test, a tool), because "no program page open" would then be
   * a guess rather than a report.
   */
  async #screens(): Promise<Vital[]> {
    const screens = this.#d.screens;
    if (!screens) return [];
    let atem: AtemStatus | null = null;
    try { atem = this.#d.atem ? this.#d.atem.status : null; } catch { atem = null; }
    return [screensVital(screens.list(), {
      atem, fieldConnected: !!this.#adapter() && this.#d.bus.state.connected.cheesy,
      obs: !!this.#d.obs,
    })];
  }

  async #publish(): Promise<Vital[]> {
    const cfg = this.#d.config;
    if (!cfg.publish.enabled) {
      return [{ id: 'publish', label: 'Publishing', level: 'off', detail: 'disabled in config' }];
    }
    const ready = publishReadiness(cfg);
    const failed = (this.#d.publish?.items ?? []).filter(i => i.state === 'failed').length;

    // YouTube blocks; TBA does not. They were merged into one list, so an
    // offseason desk with working YouTube credentials and no TBA write keys
    // (an entirely normal configuration) showed a blocking doors failure
    // saying "Nothing will upload", which was untrue and already satisfied.
    // The queue treats TBA as optional and drives items to done without it.
    if (ready.youtube.length) {
      return [{
        id: 'publish', label: 'Publishing', level: 'fail', blocking: true,
        detail: `not configured: ${ready.youtube.join(', ')}`,
        fix: 'Nothing will upload. Run npm run auth:youtube, and fill in config.json.',
      }];
    }
    if (ready.tba.length) {
      return [{
        id: 'publish', label: 'Publishing', level: 'warn',
        detail: `videos will upload, but nothing will be linked on TBA: ${ready.tba.join(', ')}`,
        fix: 'Fill in the TBA write keys in config.json, or ignore this if the '
          + 'event is not on The Blue Alliance.',
      }];
    }
    return [{
      id: 'publish', label: 'Publishing', level: failed ? 'warn' : 'ok',
      detail: failed ? `${failed} item(s) failed` : 'configured',
      ...(failed ? { fix: 'Retry them from the publish panel before the day ends.' } : {}),
    }];
  }

  async #house(): Promise<Vital[]> {
    const audio = this.#d.audio;
    if (!audio) return [{ id: 'house', label: 'House audio', level: 'off', detail: 'not used on this setup' }];
    const { armed } = audio.snapshot.players;
    return [{
      id: 'house', label: 'House audio', level: armed === 1 ? 'ok' : armed === 0 ? 'warn' : 'fail',
      detail: armed === 1 ? 'one player armed'
        : armed === 0 ? 'no player armed'
          : `${armed} players armed`,
      ...(armed === 1 ? {} : {
        fix: armed === 0
          ? 'Open /s/house on the music machine and press the button once, or ' +
            'walk-ups will fire into a void.'
          : 'Two machines are armed. If one of them is the OBS machine, the ' +
            'music is going to the stream. Close the other one.',
      }),
    }];
  }

  async #coverage(): Promise<Vital[]> {
    const cov = this.#d.coverage;
    if (!cov) return [];
    const r = cov.report();
    if (!r.played) return [{ id: 'coverage', label: 'Coverage', level: 'ok', detail: 'no matches yet' }];
    const missing = r.gaps.filter(g => g.problem === 'never-queued').length;
    return [{
      id: 'coverage', label: 'Coverage', level: missing ? 'warn' : 'ok',
      detail: `${r.uploaded}/${r.played} matches published`,
      ...(missing ? {
        fix: `${missing} played match(es) have no video queued at all. Queue them ` +
          'before the recording rolls off.',
      } : {}),
    }];
  }
}
