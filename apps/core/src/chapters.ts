/**
 * Day-VOD chapters.
 *
 * The community asks for the full uncut day recording, and then asks how to
 * find match 42 in seven hours of it. The event log already knows: every
 * `match.start` is a timestamp, and `match.loaded` right before it carries the
 * name. Give the operator the wall-clock moment the stream recording began and
 * this turns the log into text that pastes straight into a YouTube description.
 *
 * YouTube's rules are strict and silent about failure, so they are enforced
 * here rather than discovered later on a live VOD:
 *
 *   - the first chapter must be at 0:00
 *   - there must be at least three chapters
 *   - every chapter must run at least ten seconds
 *   - they must be listed in ascending order
 *
 * Break any one of them and YouTube shows no chapters at all, with no error.
 */

import type { DeskEvent, MatchInfo } from './types.ts';

export interface Chapter {
  /** Seconds from the start of the video. */
  atSec: number;
  title: string;
}

/** YouTube refuses the whole list if any chapter is shorter than this. */
export const MIN_CHAPTER_SEC = 10;

/** YouTube ignores a list shorter than this. */
export const MIN_CHAPTERS = 3;

/**
 * Back up from the green light so the chapter opens on the announcer's
 * countdown rather than mid-auto. Fifteen seconds is about one "3, 2, 1".
 */
export const LEAD_IN_SEC = 15;

export interface ChapterOpts {
  /** Title of the mandatory 0:00 chapter. */
  openingTitle?: string;
  leadInSec?: number;
}

/** `M:SS` under an hour, `H:MM:SS` over it. Both are valid to YouTube. */
export function timecode(totalSec: number): string {
  const whole = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

const titleOf = (payload: unknown, fallback: string): string => {
  const p = (payload ?? {}) as Record<string, unknown>;
  const name = p.name ?? p.award ?? p.title ?? p.description;
  return typeof name === 'string' && name.trim() ? name.trim() : fallback;
};

/**
 * Walk a recorded log and pick out the moments worth jumping to.
 *
 * Events before the recording started are skipped rather than clamped to zero:
 * a match that happened before the stream went live is not in the video, and a
 * pile of chapters all sitting at 0:00 is exactly what YouTube rejects.
 */
export function chaptersFrom(
  events: readonly DeskEvent[],
  streamStartAt: number,
  opts: ChapterOpts = {},
): Chapter[] {
  const leadIn = opts.leadInSec ?? LEAD_IN_SEC;
  const found: Chapter[] = [];
  let pendingMatch = 'Match';
  let sawSelection = false;

  for (const ev of events) {
    if (ev.type === 'match.loaded') {
      const m = ev.payload as MatchInfo | null;
      if (m?.displayName) pendingMatch = m.displayName;
      continue;
    }

    const at = Math.round((ev.ts - streamStartAt) / 1000);

    if (ev.type === 'match.start') {
      // The lead-in must not drag a chapter back before the video began.
      if (at >= 0) found.push({ atSec: Math.max(0, at - leadIn), title: pendingMatch });
      continue;
    }

    if (ev.type === 'award.presented' && at >= 0) {
      found.push({ atSec: at, title: titleOf(ev.payload, 'Award') });
      continue;
    }

    /*
     * Selection republishes on every pick; only the first one is a landmark.
     *
     * "First" has to mean the first one with a PICK IN IT. Cheesy bootstraps
     * every notifier the moment a socket connects, so the desk sees an
     * alliance_selection.update on its first connection of the day and on
     * every reconnect after it, with a list already sized to the event and
     * every roster empty. Taking that as the landmark stamped "Alliance
     * selection" at whatever moment the desk or the socket last came up,
     * typically mid-qualification on Saturday morning, and YouTube published
     * it without complaint. Fixing it afterwards means editing the
     * description of a video the community has already linked.
     */
    if (ev.type === 'alliance_selection.update' && at >= 0 && !sawSelection) {
      const p = ev.payload as { alliances?: { teams?: number[] }[] } | undefined;
      const picked = (p?.alliances ?? []).some(a => (a.teams ?? []).some(t => t > 0));
      if (!picked) continue;
      sawSelection = true;
      found.push({ atSec: at, title: 'Alliance selection' });
    }
  }

  found.sort((a, b) => a.atSec - b.atSec);

  const out: Chapter[] = [{ atSec: 0, title: opts.openingTitle ?? 'Stream start' }];
  for (const c of found) {
    const previous = out[out.length - 1]!;
    // Too close to the one before it, so it would invalidate the whole list.
    // A repeated title on its own is not a reason to drop it: a match that
    // gets aborted and replayed keeps its displayName for the re-run, and
    // that re-run is exactly the moment worth a chapter, not the aborted
    // attempt before it.
    if (c.atSec - previous.atSec < MIN_CHAPTER_SEC) continue;
    out.push(c);
  }
  return out;
}

/**
 * The paste-ready block. Returns an empty string when there are too few
 * chapters to work, because half a list is worse than none: YouTube would
 * silently drop it and the operator would think the feature was broken.
 */
export function chapterText(chapters: readonly Chapter[]): string {
  if (chapters.length < MIN_CHAPTERS) return '';
  return chapters.map(c => `${timecode(c.atSec)} ${c.title}`).join('\n');
}
