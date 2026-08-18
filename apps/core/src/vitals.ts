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

import { statfs } from 'node:fs/promises';
import type { EventBus } from './bus.ts';
import type { CoverageLedger } from './coverage.ts';
import type { HouseAudio } from './audio/store.ts';
import type { ObsClient } from './cue/obs.ts';
import type { PublishQueue } from './publish/queue.ts';
import type { Recorder } from './recorder.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { publishReadiness, type Config } from './config.ts';

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
  cheesy?: CheesyAdapter | null;
  audio?: HouseAudio | null;
  coverage?: CoverageLedger | null;
  /** Bytes per second the recorder is expected to write, for hours-remaining. */
  recordBytesPerSec?: number;
}

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

export class Vitals {
  #d: VitalsDeps;

  constructor(deps: VitalsDeps) { this.#d = deps; }

  async report(): Promise<VitalsReport> {
    const checks: Vital[] = [];
    // Run them together: a check that has to talk to OBS should not make the
    // disk check wait, and the whole report is polled from a browser.
    const results = await Promise.allSettled([
      this.#disk(), this.#recorder(), this.#obs(), this.#audioInputs(),
      this.#field(), this.#publish(), this.#house(), this.#coverage(),
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
   * Disk, expressed in HOURS OF RECORDING rather than gigabytes.
   *
   * "38GB free" means nothing to the person who has to decide whether to start
   * the day. "About 3 hours" is the same number in the unit the decision is
   * actually made in, and four cameras at 12Mbps eat a disk faster than
   * anybody's intuition expects.
   */
  async #disk(): Promise<Vital[]> {
    try {
      const fs = await statfs(this.#d.root);
      const freeBytes = fs.bavail * fs.bsize;
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
        ...(level === 'ok' ? {} : {
          fix: 'Clear old segments from rec/, or point --record at a bigger drive. ' +
            'A full disk during playoffs loses the matches people most want.',
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
      return [{
        id: 'recorder', label: 'Recording', level: 'off',
        detail: 'not running (started without --record, or ffmpeg is missing)',
      }];
    }
    const sources = rec.status;
    const dead = sources.filter(s => !s.running);
    return [{
      id: 'recorder',
      label: 'Recording',
      level: dead.length ? 'fail' : 'ok',
      blocking: true,
      detail: dead.length
        ? `${dead.length} of ${sources.length} source(s) stopped: ${dead.map(s => s.id).join(', ')}`
        : `${sources.length} source(s) rolling`,
      ...(dead.length ? { fix: 'Check the capture device is still plugged in, then restart the desk.' } : {}),
    }];
  }

  async #obs(): Promise<Vital[]> {
    const obs = this.#d.obs;
    if (!obs) {
      return [{ id: 'obs', label: 'OBS', level: 'off', detail: 'not connected (no --obs)' }];
    }
    if (!obs.connected) {
      return [{
        id: 'obs', label: 'OBS', level: 'fail', blocking: true,
        detail: 'not answering',
        fix: 'Open OBS, then Tools > obs-websocket Settings and check the server is enabled.',
      }];
    }
    try {
      const status = await obs.streamStatus();
      const live = status.outputActive === true;
      const dropped = Number(status.outputSkippedFrames ?? 0);
      const total = Math.max(1, Number(status.outputTotalFrames ?? 0));
      const pct = (dropped / total) * 100;
      return [{
        id: 'obs', label: 'OBS', level: 'ok',
        detail: live ? `streaming, ${pct.toFixed(1)}% frames dropped` : 'connected, not streaming',
      }, {
        id: 'stream-health',
        label: 'Stream health',
        level: !live ? 'off' : pct > 5 ? 'fail' : pct > 1 ? 'warn' : 'ok',
        detail: live ? `${dropped} dropped of ${total}` : 'not streaming',
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

  async #field(): Promise<Vital[]> {
    if (!this.#d.cheesy) {
      return [{
        id: 'field', label: 'Field bridge', level: 'off',
        detail: 'not connected (started without --cheesy)',
      }];
    }
    const up = this.#d.bus.state.connected.cheesy;
    return [{
      id: 'field', label: 'Field bridge', level: up ? 'ok' : 'warn',
      detail: up ? 'connected to Cheesy Arena' : 'not answering',
      ...(up ? {} : {
        fix: 'The desk still runs on operator input. Check the cable and the ' +
          'field host, and remember scores go on air estimated until it returns.',
      }),
    }];
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
    if (!audio) return [{ id: 'house', label: 'House audio', level: 'off', detail: 'disabled' }];
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
