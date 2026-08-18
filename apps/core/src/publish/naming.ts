/**
 * Video and stream naming, matching the conventions the official FIRST channel
 * uses so CalGames content sits alongside it without looking homemade.
 *
 *   Qualification 1 - CalGames
 *   Match 1 (R1) - CalGames          <- playoff, double elimination
 *   Final 1 - CalGames
 *   Final Tiebreaker - CalGames
 *
 *   2026 CalGames - Day 1            <- livestream
 *
 * Attribution note: FIRST's own descriptions end "(c) 2026 FIRST Robotics
 * Competition", which is theirs to claim. CalGames is a WRRF off-season event,
 * so copying that line verbatim would be inaccurate. Both the credit and the
 * copyright lines are configurable and default to WRRF.
 */

export interface MatchIdentity {
  /** Official-style title fragment, without the event suffix. */
  name: string;
  /** The Blue Alliance match key, or null if it isn't a real match. */
  key: string | null;
}

const ORDINAL: Record<string, number> = { one: 1, two: 2, three: 3 };

/**
 * Normalize whatever the field management system calls a match into the
 * official naming, plus its TBA key.
 *
 * Playoff matches use the modern double-elimination scheme: FIRST shows
 * "Match 7 (R2)" and TBA keys them `sf7m1`. Finals are `f1m1`, `f1m2`, and the
 * tiebreaker is `f1m3`.
 */
/**
 * Practice matches run during load-in and pit walkthroughs. They publish like
 * any other match ("Practice 3 - CalGames"), but TBA has no keys for them, so
 * they never link to a match. The automatic queue path is gated separately by
 * publish.autoQueuePractice; a manual queue always goes through.
 *
 * Bare "P3" counts: that is FMS's own practice short name. It used to fall
 * through to the playoff regex's `p` alias, titling a scrimmage
 * "Match 3 (R1)" and linking its video to the REAL playoff key sf3m1 on TBA.
 */
export const isPractice = (displayName: string): boolean =>
  /^p(?:ractice)?\s*#?\s*\d*$/i.test(displayName.trim());

export function identify(displayName: string): MatchIdentity {
  const s = displayName.trim();

  // Qualification 42 / Qual 42 / Q42 / qm42
  const qual = /^(?:qualification|qual|q|qm)\s*#?\s*(\d+)$/i.exec(s);
  if (qual) return { name: `Qualification ${Number(qual[1])}`, key: `qm${Number(qual[1])}` };

  // Practice matches publish under their own name; the null key tells the
  // queue there is no TBA match to link. "P3" normalizes to "Practice 3" so
  // the FMS short name doesn't become a title.
  if (isPractice(s)) {
    const n = /(\d+)/.exec(s)?.[1];
    return { name: n ? `Practice ${Number(n)}` : s, key: null };
  }

  // Final Tiebreaker / Finals Tiebreaker / Final 3
  if (/^finals?\s*(tiebreaker|tie-breaker|tie breaker)$/i.test(s)) {
    return { name: 'Final Tiebreaker', key: 'f1m3' };
  }

  // Final 1 / Finals 2 / F1
  const final = /^(?:finals?|f)\s*#?\s*(\d+)$/i.exec(s);
  if (final) {
    const n = Number(final[1]);
    return n >= 3
      ? { name: 'Final Tiebreaker', key: 'f1m3' }
      : { name: `Final ${n}`, key: `f1m${n}` };
  }

  // Match 7 (R3), already in official form
  const withRound = /^match\s*#?\s*(\d+)\s*\(\s*r\s*(\d+)\s*\)$/i.exec(s);
  if (withRound) {
    return { name: `Match ${Number(withRound[1])} (R${Number(withRound[2])})`, key: `sf${Number(withRound[1])}m1` };
  }

  // Playoff 7 / Match 7 / M7: derive the round from the match number. No bare
  // `p` alias here. "P3" is FMS's PRACTICE short name and is handled above;
  // claiming it minted a playoff title and a real TBA key for a scrimmage.
  const playoff = /^(?:playoff|elimination|elim|match|m)\s*#?\s*(\d+)$/i.exec(s);
  if (playoff) {
    const n = Number(playoff[1]);
    return { name: `Match ${n} (R${roundOf(n)})`, key: `sf${n}m1` };
  }

  // Legacy bracket naming, still emitted by some tools.
  const legacy = /^(quarterfinal|quarter-final|qf|semifinal|semi-final|sf)\s*#?\s*(\d+)(?:\s*(?:match|m)\s*(\d+))?$/i.exec(s);
  if (legacy) {
    const level = /^q/i.test(legacy[1]!) ? 'qf' : 'sf';
    return { name: s, key: `${level}${Number(legacy[2])}m${Number(legacy[3] ?? 1)}` };
  }

  // Spelled-out finals, e.g. "Final Two".
  const spelled = /^finals?\s+(one|two|three)$/i.exec(s);
  if (spelled) {
    const n = ORDINAL[spelled[1]!.toLowerCase()]!;
    return n >= 3 ? { name: 'Final Tiebreaker', key: 'f1m3' } : { name: `Final ${n}`, key: `f1m${n}` };
  }

  return { name: s, key: null };
}

/**
 * Round number for the 13-match double-elimination bracket, matching the (Rn)
 * suffix FIRST puts on playoff titles.
 *
 * The official bracket has five rounds: matches 1-4, 5-8, 9-10, 11-12, 13.
 * An earlier version invented seven rounds and mislabeled everything past
 * match 6, which the test pins down because a wrong title is not fixable
 * once it is on uploaded videos.
 */
export function roundOf(matchNumber: number): number {
  if (matchNumber <= 4) return 1;
  if (matchNumber <= 8) return 2;
  if (matchNumber <= 10) return 3;
  if (matchNumber <= 12) return 4;
  return 5;
}

/**
 * "2026 CalGames": the event as titled, with the year exactly once. The year
 * has to appear somewhere: WRRF's channel hosts every season, and yearless
 * titles collide ("Qualification 1 - CalGames" every October). The
 * contains-check keeps the obvious config (name: "2026 CalGames") from
 * doubling into "2026 2026 CalGames".
 */
export const eventTitle = (year: number, eventName: string): string =>
  eventName.includes(String(year)) ? eventName : `${year} ${eventName}`;

/** `Qualification 42 - 2026 CalGames` (year omitted only if none is given). */
export const videoTitle = (matchName: string, eventName: string, year?: number): string =>
  `${matchName} - ${year != null ? eventTitle(year, eventName) : eventName}`;

/** `2026 CalGames - Day 1` */
export const streamTitle = (year: number, eventName: string, day: number): string =>
  `${eventTitle(year, eventName)} - Day ${day}`;

export interface DescriptionInput {
  title: string;
  red: { teams: number[]; score: number };
  blue: { teams: number[]; score: number };
  resultsUrl?: string;
  credit: string;
  copyright: string;
}

/**
 * Matches the official description layout:
 *
 *   Final Tiebreaker - CalGames
 *   Red (Teams 6238, 1323, 254) - 552
 *   Blue (Teams 6665, 1678, 9470) - 527
 *   https://...
 *
 *   Uploaded by ...
 *   (c) 2026 ...
 */
export function description(d: DescriptionInput): string {
  const side = (label: string, s: { teams: number[]; score: number }): string =>
    `${label} (Teams ${s.teams.join(', ')}) - ${s.score}`;

  return [
    d.title,
    side('Red', d.red),
    side('Blue', d.blue),
    ...(d.resultsUrl ? [d.resultsUrl] : []),
    '',
    d.credit,
    d.copyright,
  ].join('\n');
}

/**
 * The parts of the day that are not matches.
 *
 * Teams ask for these specifically. Alliance selection decides the afternoon
 * and is never rewatchable; families who leave before the ceremony never see
 * their team's award. They are all one video each, cut from the program
 * recording, and none of them is a match, so none of them gets a TBA match key.
 *
 * These ids are the one-tap set on the desk console; any other string passed
 * as a segment becomes a literal title, which is how a single award gets its
 * own video ("FIRST Impact Award - CalGames").
 */
export const SEGMENTS = {
  selection: 'Alliance Selection',
  awards: 'Awards Ceremony',
  opening: 'Opening Ceremony',
  closing: 'Closing Ceremony',
  analysis: 'Analysis Desk',
  interview: 'Team Interview',
  exhibition: 'Exhibition Match',
  mentors: 'Mentor Match',
  arcade: 'Arcade Tournament',
} as const;

export type SegmentId = keyof typeof SEGMENTS;

/**
 * Title an event segment. A known id gets the standard name; anything else is
 * taken as a literal, which is how a single award gets its own video
 * ("FIRST Impact Award - CalGames").
 */
export const segmentName = (idOrName: string): string =>
  SEGMENTS[idOrName as SegmentId] ?? idOrName.trim();

export interface SegmentDescriptionInput {
  title: string;
  /** Optional line under the title, e.g. the winning team. */
  note?: string;
  resultsUrl?: string;
  credit: string;
  copyright: string;
}

/**
 * Display names for the arcade game ids in arcade/model.ts. 'other' is
 * deliberately absent: whatever a team brings on Saturday has no name we can
 * predict, so those sets are labeled by round alone.
 */
const ARCADE_GAMES: Record<string, string> = {
  smash: 'Smash',
  mariokart: 'Mario Kart',
  pacman: 'Pac-Man',
  tetris: 'Tetris',
};

/**
 * Title an auto-queued arcade set: "Arcade Winners Semifinal (Smash)".
 *
 * The round carries the bracket context ("Winners Semifinal", "Grand Final")
 * and the game disambiguates across the lineup, so the video is findable
 * without anyone typing a title mid-show.
 */
export function arcadeLabel(round: string, game: string): string {
  const r = round.trim() || 'Set';
  const g = ARCADE_GAMES[game];
  return g ? `Arcade ${r} (${g})` : `Arcade ${r}`;
}

/** Same layout as a match description, minus the alliances and the score. */
export function segmentDescription(d: SegmentDescriptionInput): string {
  return [
    d.title,
    ...(d.note ? [d.note] : []),
    ...(d.resultsUrl ? [d.resultsUrl] : []),
    '',
    d.credit,
    d.copyright,
  ].join('\n');
}
