/**
 * Cheesy Arena wire shapes, transcribed from the 2026 source.
 *
 * Field names are Go struct fields serialized with default JSON marshaling,
 * so they are PascalCase. Everything here is `Partial`-ish and read
 * defensively: an off-season FMS build may differ slightly, and a missing
 * field must degrade rather than crash the broadcast.
 */

/**
 * field/arena.go, serialized as an integer.
 *
 * A const object rather than an `enum`: enums emit runtime code, and this
 * project runs TypeScript through Node's type stripping, which requires every
 * construct to be erasable.
 */
export const MatchState = {
  PreMatch: 0,
  StartMatch: 1,
  AutoPeriod: 2,
  PausePeriod: 3,
  TeleopPeriod: 4,
  PostMatch: 5,
  TimeoutActive: 6,
  PostTimeout: 7,
} as const;

export type MatchState = typeof MatchState[keyof typeof MatchState];

/** game/score_summary.go */
export interface ScoreSummary {
  AutoFuelPoints?: number;
  AutoTowerPoints?: number;
  TeleopFuelPoints?: number;
  TeleopTowerPoints?: number;
  NumFuel?: number;
  MatchPoints?: number;
  FoulPoints?: number;
  Score?: number;
  EnergizedBonusRankingPoint?: boolean;
  SuperchargedBonusRankingPoint?: boolean;
  TraversalBonusRankingPoint?: boolean;
  BonusRankingPoints?: number;
  PlayoffDq?: boolean;
}

/** field/arena_notifiers.go (audienceAllianceScoreFields) */
export interface AllianceScoreFields {
  Score?: unknown;
  ScoreSummary?: ScoreSummary;
  /** Drives the hub shift countdown. */
  ActiveRemainingSec?: number;
  ActiveDurationSec?: number;
}

export interface RealtimeScoreMessage {
  Red?: AllianceScoreFields;
  Blue?: AllianceScoreFields;
  RedCards?: Record<string, string>;
  BlueCards?: Record<string, string>;
  MatchState?: MatchState;
}

export interface MatchTimeMessage {
  MatchState?: MatchState;
  MatchTimeSec?: number;
}

export interface CheesyTeam {
  Id?: number;
  Nickname?: string;
  Name?: string;
}

export interface CheesyMatch {
  Id?: number;
  Type?: number | string;
  TypeOrder?: number;
  LongName?: string;
  ShortName?: string;
  Red1?: number; Red2?: number; Red3?: number;
  Blue1?: number; Blue2?: number; Blue3?: number;
  /**
   * Surrogate flags, one per station. Cheesy's Match model carries these and
   * this file did not model them, so the desk's whole surrogate feature (the
   * "S" mark on the bar, the "does not count" line on the talent view) had no
   * producer and could never fire at a real event. The tests were the only
   * thing that ever set it.
   *
   * A surrogate is a team playing an extra qualification match to fill a
   * schedule; it does not count for their record. Saying nothing means the
   * audience watches a team "lose" a match that was never theirs to lose, and
   * then finds the ranking table disagrees with what they just saw.
   */
  Red1IsSurrogate?: boolean; Red2IsSurrogate?: boolean; Red3IsSurrogate?: boolean;
  Blue1IsSurrogate?: boolean; Blue2IsSurrogate?: boolean; Blue3IsSurrogate?: boolean;
  /**
   * Seed numbers, playoffs only, 0 during qualification.
   *
   * Only three robots ever take the field, so these slots stay at three. A
   * playoff alliance of four carries a backup, and the fourth member is only
   * knowable by joining these seeds against the alliance rosters from
   * selection. That join is what lets a playoff graphic name the whole
   * alliance rather than just whoever is on the field this match.
   */
  PlayoffRedAlliance?: number;
  PlayoffBlueAlliance?: number;
}

export interface MatchLoadMessage {
  Match?: CheesyMatch;
  /** Keyed "R1".."R3", "B1".."B3". */
  Teams?: Record<string, CheesyTeam | null>;
  Rankings?: Record<string, number>;
  IsReplay?: boolean;
  BreakDescription?: string;
  BreakNextMatchName?: string;
}

export interface ArenaStatusMessage {
  MatchId?: number;
  AllianceStations?: Record<string, {
    Team?: CheesyTeam | null;
    Ds?: { RobotLinked?: boolean; DsLinked?: boolean } | null;
    Astop?: boolean;
    Estop?: boolean;
    Bypass?: boolean;
  } | null>;
  MatchState?: MatchState;
  PlcIsHealthy?: boolean;
  FieldEStop?: boolean;
  IsFtaReady?: boolean;
}

export interface ScorePostedMessage {
  MatchType?: string;
  Match?: CheesyMatch;
  RedScoreSummary?: ScoreSummary;
  BlueScoreSummary?: ScoreSummary;
  RedRankingPoints?: number;
  BlueRankingPoints?: number;
}

/**
 * field/arena_notifiers.go, generateAllianceSelectionMessage.
 *
 * Read-only, and it arrives on the audience display socket we already
 * subscribe to. The alliance selection websocket itself accepts picks and a
 * finalize command, which is why it sits on the forbidden list in
 * docs/10-field-bridge.md: the scorekeeper runs selection, we only draw it.
 */
export interface AllianceSelectionMessage {
  /** model.Alliance. `TeamIds` fills pick by pick as the segment runs. */
  Alliances?: {
    Id?: number;
    TeamIds?: number[];
    /** Set on finalize: captain in the middle, first pick left. */
    Lineup?: number[];
  }[];
  ShowTimer?: boolean;
  /** Counts down once a second while the pick clock runs. */
  TimeRemainingSec?: number;
  RankedTeams?: { Rank?: number; TeamId?: number; Picked?: boolean }[];
}

// ---------------------------------------------------------------------------
// REST shapes. Transcribed from web/api.go, model/match.go and
// game/ranking_fields.go in the 2026 source.
// ---------------------------------------------------------------------------

/** game.Ranking, flattened, plus the nickname the API joins on. */
export interface CheesyRanking {
  TeamId?: number;
  Rank?: number;
  PreviousRank?: number;
  RankingPoints?: number;
  MatchPoints?: number;
  AutoFuelPoints?: number;
  TowerPoints?: number;
  Wins?: number;
  Losses?: number;
  Ties?: number;
  Disqualifications?: number;
  Played?: number;
  Nickname?: string;
}

/** GET /api/rankings */
export interface RankingsResponse {
  Rankings?: CheesyRanking[];
  /** ShortName of the last committed match, e.g. "Q42". */
  HighestPlayedMatch?: string;
}

/**
 * GET /api/matches/{type} (MatchWithResult[]).
 *
 * FLAT, not nested, and this file had it nested. web/api.go declares
 *
 *     type MatchWithResult struct {
 *         model.Match
 *         Result *MatchResultWithSummary
 *     }
 *
 * with model.Match EMBEDDED and carrying no json tag, and nothing in the arena
 * defines MarshalJSON. Go's encoding/json promotes an embedded struct's fields
 * into the outer object, so each row is
 *
 *     {"Id":42,"Type":1,"TypeOrder":42,"LongName":"Qualification 42",
 *      "Red1":254,...,"Status":2,"Result":null}
 *
 * with no "Match" key anywhere. Reading `row.Match.Status` got undefined for
 * every row, which the Scheduled default then turned into "nothing has been
 * played", so the on-deck queue was the first eight matches of the schedule
 * for the whole weekend and every name and team number came out blank.
 *
 * Result IS a named field, so it stays where it is.
 *
 * The websocket matchLoad message is the opposite case and genuinely nested:
 * generateMatchLoadMessage returns an anonymous struct with a NAMED
 * `Match *model.Match` field. MatchLoadMessage above is correct as written.
 * The giveaway that this was a transcription slip rather than a guess is
 * CheesyRanking two types up: RankingWithNickname embeds game.Ranking exactly
 * the same way, and that one is modelled flat, with a comment saying so.
 */
export interface MatchWithResult extends CheesyMatch {
  Time?: string;
  NameDetail?: string;
  ScoreCommittedAt?: string;
  Status?: number;
  Result?: {
    RedSummary?: ScoreSummary;
    BlueSummary?: ScoreSummary;
  } | null;
}

/**
 * model.MatchType. A plain Go int, and `stringer` only adds a String() method,
 * which encoding/json ignores, so this arrives on the wire as a NUMBER.
 */
export const MatchType = {
  Test: 0, Practice: 1, Qualification: 2, Playoff: 3,
} as const;

/**
 * game.MatchStatus. 0 scheduled, 1 hidden, 2 red won, 3 blue won, 4 tie.
 * A match is played once its status leaves "scheduled".
 */
export const MatchStatus = {
  Scheduled: 0, Hidden: 1, RedWon: 2, BlueWon: 3, Tie: 4,
} as const;

/** Points, not counts: REBUILT fuel is 1 point each into an active hub. */
export const fuelPoints = (s: ScoreSummary | undefined): number =>
  (s?.AutoFuelPoints ?? 0) + (s?.TeleopFuelPoints ?? 0);

export const towerPoints = (s: ScoreSummary | undefined): number =>
  (s?.AutoTowerPoints ?? 0) + (s?.TeleopTowerPoints ?? 0);
