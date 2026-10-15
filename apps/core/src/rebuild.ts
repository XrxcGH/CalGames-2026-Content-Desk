/**
 * Rebuild the in-memory ledgers from today's event log, at boot.
 *
 * The discipline ledger, the coverage report, the run of show and the sponsor
 * airing counts are all derived state: they are built by watching the bus and
 * they live in memory. Every one of them opens empty and every one of them is
 * wrong after a restart, which is a thing that happens at events: a laptop
 * sleeps, a power strip gets kicked, somebody closes the window.
 *
 * The consequences are not cosmetic. The card ledger forgetting a yellow means
 * the announcer is told a carded team is clean, which is the same on-air harm
 * as getting the rule wrong. The coverage report forgetting the morning means
 * a match with no video raises no gap, which defeats the report's one purpose
 * in exactly the situation it exists for. The sponsor counts under-report
 * airings in a document that goes to the people who paid for the event.
 *
 * So they are rebuilt. The log is already there (`bus.openLog` has written
 * every event since Friday) and every one of these modules already exposes
 * `observe(ev)` for precisely this, because a replay has to reconstruct them.
 *
 * Two things this is careful about:
 *
 * 1. It feeds `observe()` DIRECTLY and never touches the bus. Re-emitting the
 *    morning would re-fire cues, re-cut clips, re-announce cards, and take the
 *    program screen to whatever was up at 9am. Nothing here reaches air.
 * 2. It feeds TODAY's events only, judged by each event's own timestamp. A
 *    three-day event is three days of separate tournament phases and separate
 *    rundowns; dragging Friday's practice cards into Sunday is the thing the
 *    phase rule in cards.ts exists to prevent. It opens yesterday's files as
 *    well as today's to find them, because a file is named for the moment it
 *    was opened and the desk does not restart at midnight: see rebuildFromLog.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDay } from './bus.ts';
import type { DeskEvent } from './types.ts';

/** Anything that can be fed a logged event to rebuild itself. */
export interface Observer {
  observe(ev: DeskEvent): void;
}

/**
 * Log file names are `2026-10-17-09-14-02.ndjson` (see logPathFor), so
 * today's are the ones whose first ten characters match today's date. Parsing
 * the name rather than stat()ing the file on purpose: a file copied off a
 * machine keeps its name and loses its mtime.
 */
export function isFromDay(name: string, day: string): boolean {
  if (!name.endsWith('.ndjson') || !name.startsWith(day)) return false;
  // `2026-10-17-09-14-02.rehearsal.ndjson` is a --demo or --replay session:
  // real-looking events that never happened at the event. Rebuilding from
  // one put rehearsal cards on the announcer's ledger and phantom matches in
  // the coverage report, so a tagged name is not part of the day.
  return !/\.[a-z]+\.ndjson$/i.test(name);
}

export interface RebuildResult {
  /** Log files opened: today's and yesterday's. */
  files: number;
  /** Events from today that reached the observers. */
  events: number;
  /** Torn lines and sample-data events, left out. */
  skipped: number;
  /** Events read from a file but stamped on a different day, left where they were. */
  otherDay: number;
}

/**
 * Feed today's logged events to each observer, oldest first.
 *
 * Which file an event sits in is not what decides whether it is today's: its
 * own `ts` is. A log file is named for the moment it was OPENED, and the desk
 * runs Friday to Sunday without restarting, so before the bus rotated its
 * log at midnight the whole of Saturday sat in a Friday-named file, and a
 * Saturday restart (which chose files by name) rebuilt from nothing. The bus
 * rotates now, but a file can still straddle midnight: the rotation happens
 * on the first event of the new day, a desk that was killed at 23:59 and
 * restarted at 00:10 never rotated at all, and a log copied in from another
 * machine is whatever it is. So yesterday's files are opened too, and every
 * event is placed on its own day. Yesterday's events in them are dropped;
 * today's are kept, whatever the name on the file says.
 *
 * Never throws. A missing log directory is the normal first-boot case, and a
 * torn last line is what a power cut leaves behind. Neither is a reason to
 * refuse to start a desk that somebody is standing in front of.
 */
export async function rebuildFromLog(
  dir: string, observers: Observer[], now = new Date(),
): Promise<RebuildResult> {
  // Local, via the same helper logPathFor names with. A UTC day here put the
  // boundary at 5pm local: an evening restart matched no files at all, and the
  // next morning matched the previous evening's.
  const day = localDay(now);
  // Yesterday by the local calendar, not by subtracting 24 hours: across the
  // autumn clock change 24 hours back lands on today's date again.
  const eve = new Date(now);
  eve.setDate(eve.getDate() - 1);
  const yesterday = localDay(eve);
  const result: RebuildResult = { files: 0, events: 0, skipped: 0, otherDay: 0 };

  let names: string[];
  try {
    names = (await readdir(dir))
      .filter(n => isFromDay(n, day) || isFromDay(n, yesterday))
      .sort();
  } catch {
    return result;                       // no logs yet: a fresh desk
  }

  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name), 'utf8');
    } catch (err) {
      console.warn(`[rebuild] could not read ${name}: ${(err as Error).message}`);
      continue;
    }
    result.files++;
    // The day on the file name, for an event with no usable stamp of its own.
    const fileDay = name.slice(0, 10);

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev: DeskEvent;
      try {
        ev = JSON.parse(line) as DeskEvent;
      } catch {
        // The last line of a log a power cut interrupted. Expected, not news.
        result.skipped++;
        continue;
      }
      // Sample data is never history. The Sample data button logs into the
      // real day's log like anything else on the bus, and this loop used to
      // fold it back in on every restart: press the button on event morning,
      // restart, and a real team carried the sample's yellow card through the
      // rest of qualifications, the sample sponsor sat in the sponsor report,
      // and a sample match sat in the coverage ledger. Everything the sample
      // emits is tagged demo, which is exactly what this checks.
      if (ev.source === 'demo') { result.skipped++; continue; }
      // Placed by its own stamp, in local time like the file names. The name
      // only says when the file was opened; a Saturday 00:03 match.end in a
      // file opened Friday 08:00 is Saturday's, and Friday's last card in the
      // same file is not. An event with no usable stamp (a hand-edited log)
      // is taken to belong to the file it is in rather than dropped.
      const evDay = typeof ev.ts === 'number' && Number.isFinite(ev.ts)
        ? localDay(new Date(ev.ts)) : fileDay;
      if (evDay !== day) { result.otherDay++; continue; }
      result.events++;
      for (const o of observers) {
        // One observer throwing must not cost the others their history.
        try { o.observe(ev); } catch (err) {
          console.warn(`[rebuild] ${(err as Error).message}`);
        }
      }
    }
  }

  return result;
}
