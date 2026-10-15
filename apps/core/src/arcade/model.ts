/**
 * Arcade: side-tournament state for the gaps between matches.
 * See docs/05-arcade.md.
 *
 * CalGames 2025's schedule had a one-hour lunch on both competition days, a
 * ~30-minute alliance selection window, plus the gaps around awards, roughly
 * three hours of dead air across the weekend. A stream that goes to a slate for
 * three hours loses its audience and doesn't get it back.
 *
 * The architectural point: an arcade overlay is just another surface bound to
 * another source. Same bus, same theme tokens, same components. If this were
 * expensive to build, the architecture would be wrong.
 */

import type { Alliance } from '../types.ts';

/**
 * The lineup: head-to-head Smash, split-screen Mario Kart (4-up), and the
 * classic multiplayer shelf: Pac-Man (4-player party rules) and Tetris
 * (battle royale style, scored by placement or lines). 'other' covers
 * whatever a team brings on Saturday.
 */
export type ArcadeGame = 'smash' | 'mariokart' | 'pacman' | 'tetris' | 'other';

export interface ArcadePlayer {
  id: string;
  name: string;
  /**
   * Entrants can register by FRC team, which is the whole crossover: the card
   * reads "846 The Funky Monkeys" with the team's avatar rather than a gamertag.
   */
  team?: number;
  teamName?: string;
  seed?: number;
  /** Only set for the Alliance GP format during alliance selection. */
  alliance?: Alliance;
}

export interface ArcadeSet {
  id: string;
  /** Put up by the desk's sample data; never restored after a restart. */
  sample?: true;
  game: ArcadeGame;
  /** "Winners Semifinal", "Grand Final", "Race 3 of 4". */
  round: string;
  /**
   * Wall clock of startSet, epoch ms. The publish auto-queue cuts the set's
   * video from here to set_end. Optional because sets recorded before the
   * field existed (replayed event logs) lack it; overlays never read it.
   */
  startedAt?: number;
  /** 2 for a versus set; 3-4 for split-screen free-for-alls (MK runs 4-up). */
  players: ArcadePlayer[];
  /** Index-aligned with `players`. */
  scores: number[];
  /**
   * Win threshold for a versus set: best of 3 unless the bracket calls for 5
   * (grand finals, usually). Without this, `setWinner`'s bestOf argument was
   * unreachable and every Bo5 auto-completed and locked at two wins.
   */
  bestOf?: number;
  state: 'upcoming' | 'live' | 'complete';
  /**
   * start.gg reflects what a TO has typed in, which lags reality by anywhere
   * from thirty seconds to a full round. Bracket metadata is authoritative;
   * the live score is not, unless an operator has confirmed it.
   */
  scoreConfidence: 'authoritative' | 'estimated';
}

/**
 * One set's worth of bracket METADATA from start.gg (round label, entrants,
 * coarse state). Deliberately scoreless: start.gg reflects what a TO has typed
 * in, which lags reality by up to a full round, so the live score never comes
 * from here. See docs/05-arcade.md.
 */
export interface BracketSet {
  id: string;
  round: string;
  state: 'upcoming' | 'live' | 'complete';
  players: ArcadePlayer[];
}

/**
 * Mario Kart 8 Deluxe grand-prix points. There is no external data source for
 * MK8D, so the model is the product: an operator types the finishing order and
 * standings fall out.
 */
export const MK_POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const;

export interface GrandPrix {
  game: 'mariokart';
  /** Put up by the desk's sample data; never restored after a restart. */
  sample?: true;
  name: string;
  racers: ArcadePlayer[];
  /** One entry per race: racer ids in finishing order. */
  races: string[][];
  raceCount: number;
}

export interface Standing {
  player: ArcadePlayer;
  points: number;
  /** Finishing positions so far, for the "3rd, 1st, 5th" detail line. */
  positions: number[];
}

/**
 * Cumulative standings across the races run so far. Ties break on best single
 * finish, which is how Mario Kart itself resolves them and what the room will
 * expect.
 */
export function standings(gp: GrandPrix): Standing[] {
  const byId = new Map(gp.racers.map(r => [r.id, r]));
  const table = new Map<string, Standing>();
  for (const racer of gp.racers) {
    table.set(racer.id, { player: racer, points: 0, positions: [] });
  }

  for (const race of gp.races) {
    race.forEach((id, index) => {
      const row = table.get(id) ?? (byId.has(id)
        ? { player: byId.get(id)!, points: 0, positions: [] }
        : null);
      if (!row) return;                    // unknown racer id, ignore rather than crash
      row.points += MK_POINTS[index] ?? 0;
      row.positions.push(index + 1);
      table.set(id, row);
    });
  }

  return [...table.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const bestA = Math.min(...(a.positions.length ? a.positions : [99]));
    const bestB = Math.min(...(b.positions.length ? b.positions : [99]));
    return bestA - bestB;
  });
}

/**
 * A VERSUS set is decided when someone reaches the win threshold (best of N).
 * Free-for-alls (3+ players) never auto-complete: a Pac-Man party or a
 * 4-up Kart lobby ends when the operator says it does, and the leader at
 * that moment is the winner.
 */
export function setWinner(set: ArcadeSet, bestOf = 3): ArcadePlayer | null {
  if (set.players.length > 2) return null;
  const needed = Math.floor(bestOf / 2) + 1;
  const top = set.scores.indexOf(Math.max(...set.scores));
  return set.scores[top] !== undefined && set.scores[top]! >= needed
    ? set.players[top] ?? null
    : null;
}
