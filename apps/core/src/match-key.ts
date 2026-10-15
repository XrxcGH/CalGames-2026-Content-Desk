/**
 * Which match is which, across the field and the queue.
 *
 * The field (Cheesy Arena) and the queue (FRC Nexus) name the same match
 * differently, and the on-deck view has to know when they mean the same one.
 * Plain string comparison got every playoff wrong: Cheesy's LongName for a
 * double elimination match is a bare "Match 7" (the round lives in a separate
 * field), while Nexus labels it "Playoff 7". A replay is worse: Cheesy loads it
 * under the ORIGINAL name with a higher run number, while the queuers add a
 * separate "Qualification 24 Replay" row to Nexus.
 *
 * So both sides are folded into one small key: kind, number, replay. Anything
 * that does not fit the grammar gets no key at all, and a caller holding a
 * null key must fall back to whatever it did before rather than guess. Being
 * unsure is fine; being confidently one match off on every screen is not.
 */

export type MatchKind = 'practice' | 'qualification' | 'playoff' | 'final';

export interface MatchKey {
  kind: MatchKind;
  number: number;
  replay: boolean;
}

const KIND: Record<string, MatchKind> = {
  practice: 'practice', p: 'practice',
  qualification: 'qualification', qual: 'qualification', q: 'qualification',
  // Cheesy's "Match 7", its ShortName "M7", and Nexus's "Playoff 7".
  playoff: 'playoff', match: 'playoff', m: 'playoff',
  final: 'final', f: 'final',
};

/*
 * Every documented Nexus form ("Practice 1", "Qualification 24",
 * "Qualification 24 Replay", "Playoff 8", "Final 1"), Cheesy's LongNames and
 * ShortNames ("Qualification 12", "Q12", "Match 7", "M7", "Final 1", "F1"),
 * the FIRST title form "Match 7 (R2)", and Nexus's own short form "Q24R".
 *
 * Deliberately NOT matched, so they fall back: "Overtime 1" (Nexus documents
 * no label for it), "Test Match", legacy bracket names like "SF2-3", and
 * anything a queuer typed by hand.
 */
const GRAMMAR = /^(practice|qualification|qual|playoff|match|final|p|q|m|f)\s*#?\s*(\d{1,3})(?:\s*\(\s*r\s*\d+\s*\))?(?:\s+(replay)|(r))?$/i;

export function matchKey(name: string | null | undefined): MatchKey | null {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const m = GRAMMAR.exec(text);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  // A bare trailing R only means "replay" after a one-letter prefix ("Q24R").
  // "Qualification 24R" is nobody's spelling, so it is not guessed at.
  if (m[4] && word.length > 1) return null;
  const number = Number(m[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { kind: KIND[word]!, number, replay: Boolean(m[3] || m[4]) };
}

/**
 * The key for the match the field has loaded.
 *
 * The field's own kind (from Cheesy's numeric match type) vetoes a name that
 * says otherwise; absent, it vetoes nothing, because the fake arena and some
 * fixtures send no numeric type. Cheesy's finals are type Playoff, so a field
 * kind of playoff allows a final.
 *
 * A replay arrives under the original name with run 2, which is what the
 * queuers list as "... Replay". Run 3 and up is a replay too: the count is
 * not trustworthy (a reconnect echo of a replay's load bumps it again, see
 * the Cheesy adapter), but "this is a replay" is, and several replays of one
 * match share a single Nexus label anyway. Two Replay rows for one match make
 * the deck fall back on its own.
 */
export function fieldMatchKey(
  match: { displayName: string; kind?: 'test' | 'practice' | 'qualification' | 'playoff' } | null | undefined,
  run: number,
): MatchKey | null {
  if (!match || match.kind === 'test') return null;
  const key = matchKey(match.displayName);
  if (!key) return null;
  if (match.kind === 'qualification' && key.kind !== 'qualification') return null;
  if (match.kind === 'practice' && key.kind !== 'practice') return null;
  if (match.kind === 'playoff' && key.kind !== 'playoff' && key.kind !== 'final') return null;
  return run >= 2 ? { ...key, replay: true } : key;
}

export const sameMatch = (a: MatchKey | null, b: MatchKey | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.number === b.number && a.replay === b.replay;

const LETTER: Record<MatchKind, string> = {
  practice: 'P', qualification: 'Q', playoff: 'M', final: 'F',
};

/** "Q43", "M7", "Q24R": the same short form Nexus rows and Cheesy rows carry. */
export const shortFor = (k: MatchKey): string => `${LETTER[k.kind]}${k.number}${k.replay ? 'R' : ''}`;
