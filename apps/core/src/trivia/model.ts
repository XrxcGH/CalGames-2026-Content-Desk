/**
 * Crowd trivia: the between-matches game the whole gym can play at once.
 *
 * Same reasoning as the arcade (dead air loses the audience), but this one
 * needs zero consoles, zero capture, zero licenses: the audience IS the
 * hardware. Phones join over the venue wifi, the question runs on the stream
 * and side screens, speed scoring keeps it tense, and the leaderboard reads
 * "846 Ana" so the team-pride flywheel does the promotion for us.
 *
 * Kahoot exists and is better at this; it is also a third-party service that
 * needs venue internet mid-show and can't render in WRRF purple on our
 * overlay. This is ~200 lines and runs on the desk box.
 */

export interface TriviaQuestion {
  id: string;
  text: string;
  /** Exactly four: the phone UI is four thumb-sized plates. */
  options: [string, string, string, string];
  /**
   * Index into options. Never serialized to clients before reveal.
   * On a `match` question this is a placeholder until the field posts a score.
   */
  answer: 0 | 1 | 2 | 3;
  category?: string;
  /**
   * Which round this belongs to.
   *
   * The gym plays one session in one gap between matches, and the day is a
   * series of them: scores carry, the leaderboard keeps building, and nobody
   * has to finish a thirty-question game in a four-minute window. Questions
   * sharing a session name must be contiguous in the bank; the store derives
   * the round list from that order.
   *
   * Optional, and a bank with none is simply one long session, which is what
   * every bank was before this existed.
   */
  session?: string;
  /**
   * A prediction rather than a fact. The audience picks before the match, and
   * the answer is whatever actually happens, so it cannot be leaked early:
   * at the moment the question opens, nobody knows it, including the server.
   */
  kind?: 'fact' | 'match';
  /**
   * For a `match`-kind question, the id of the match it predicts. `reveal()`
   * checks this against whatever match is currently loaded, so a prediction
   * left open too long can never be resolved against a later match's score.
   */
  matchId?: string | null;
}

/** Options for a pick-the-winner round, in the order the phone shows them. */
export const PICK_OPTIONS: [string, string, string, string] =
  ['Red alliance', 'Blue alliance', 'Tie', 'Too close to call'];

export const PICK_RED = 0;
export const PICK_BLUE = 1;
export const PICK_TIE = 2;

/**
 * Build the pre-match prediction question for a given match.
 *
 * `answer` starts on red purely as a placeholder; `resolvePick` overwrites it
 * from the posted score before anything is revealed or scored.
 */
export function pickQuestion(displayName: string, matchId: string | null = null): TriviaQuestion {
  return {
    id: `pick-${displayName.toLowerCase().replace(/\s+/g, '-')}`,
    text: `Who takes ${displayName}?`,
    options: [...PICK_OPTIONS] as [string, string, string, string],
    answer: PICK_RED,
    category: 'Pick the winner',
    kind: 'match',
    matchId,
  };
}

/**
 * Which option the field just proved right.
 *
 * "Too close to call" is never the answer. It exists so the plate grid stays
 * four wide and so the undecided have somewhere to go, and it pays nothing,
 * which is the honest price of not committing.
 */
export function resolvePick(redTotal: number, blueTotal: number): 0 | 1 | 2 {
  if (redTotal > blueTotal) return PICK_RED;
  if (blueTotal > redTotal) return PICK_BLUE;
  return PICK_TIE;
}

export interface TriviaPlayer {
  id: string;
  name: string;
  /** The crossover, same as the arcade: "846 Ana" beats a bare gamertag. */
  team?: number;
  score: number;
  /** Correct answers, for the tie-break detail line. */
  correct: number;
  /**
   * Every answer ever locked, right or wrong. Eviction fairness runs on this,
   * not on score: a player who answered five questions and got them all wrong
   * has been PLAYING, and must never lose their slot before a joined-and-
   * walked-away squatter who answered nothing.
   */
  answered: number;
  /**
   * Put there by the desk's sample data. Published, so a real snapshot taken
   * while the sample is still up does not hand the sample to the restart
   * restore as if it had been played.
   */
  sample?: true;
  /**
   * Came back from the log after a restart, under an id no phone holds. The
   * first join with the same name and team takes the row back. Never
   * published.
   */
  restored?: true;
  joinedAt: number;
}

export type TriviaPhase = 'idle' | 'open' | 'revealed';

export interface TriviaAnswer {
  choice: number;
  at: number;
}

/** Points: 500 for being right + up to 500 for being fast. Wrong pays 0. */
export const BASE_POINTS = 500;
export const SPEED_POINTS = 500;

export function award(openedAt: number, closesAt: number, answeredAt: number): number {
  const window = Math.max(1, closesAt - openedAt);
  const remaining = Math.max(0, Math.min(1, (closesAt - answeredAt) / window));
  return BASE_POINTS + Math.round(SPEED_POINTS * remaining);
}

export interface Standing {
  rank: number;
  player: TriviaPlayer;
}

/** Score desc; ties break on correct-count, then earliest join (they committed). */
export function standings(players: Iterable<TriviaPlayer>): Standing[] {
  const sorted = [...players].sort((a, b) =>
    b.score - a.score || b.correct - a.correct || a.joinedAt - b.joinedAt);
  return sorted.map((player, i) => ({ rank: i + 1, player }));
}

/**
 * A standings row as it may leave the server. `Standing` carries the whole
 * player, id included, and the id is the only credential `answer()` checks:
 * publishing it on the open /api/trivia snapshot once let anyone in the gym
 * read a leader's id and burn their single answer with a wrong choice.
 * Project before the snapshot is built, never in the surfaces.
 */
export interface PublicStanding {
  rank: number;
  name: string;
  team?: number;
  score: number;
  correct: number;
  sample?: true;
}

export function publicStandings(players: Iterable<TriviaPlayer>): PublicStanding[] {
  return standings(players).map(({ rank, player }) => ({
    rank,
    name: player.name,
    ...(player.team ? { team: player.team } : {}),
    score: player.score,
    correct: player.correct,
    ...(player.sample ? { sample: true as const } : {}),
  }));
}
