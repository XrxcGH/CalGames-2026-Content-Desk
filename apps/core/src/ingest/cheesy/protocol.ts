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

/** GET /api/matches/{type} (MatchWithResult[]) */
export interface MatchWithResult {
  Match?: CheesyMatch & {
    Time?: string;
    NameDetail?: string;
    ScoreCommittedAt?: string;
    Status?: number;
  };
  Result?: {
    RedSummary?: ScoreSummary;
    BlueSummary?: ScoreSummary;
  } | null;
}

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
