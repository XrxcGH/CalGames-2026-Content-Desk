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
  /**
   * Major fouls the OPPONENT committed. The first playoff tiebreak criterion,
   * ahead of auto fuel and tower points, and the desk had no field for it.
   */
  NumOpponentMajorFouls?: number;
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
   * Only three robots ever take the field, so these slots stay at three. The
   * rest of a playoff alliance, the backup included, comes from matchLoad's
   * RedOffFieldTeams / BlueOffFieldTeams, which the arena resolves for us.
   * This comment used to say the fourth member was knowable only by joining
   * these seeds against the rosters from alliance selection; that is not true
   * against this build, and believing it left a desk that restarted through
   * selection unable to name the backup at all.
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
  /**
   * What the break that is starting is called, and what follows it. Set by
   * the arena when a scheduled break or an ad-hoc timeout begins, alongside
   * the state flip to TimeoutActive.
   */
  BreakDescription?: string;
  BreakNextMatchName?: string;
  /**
   * The alliance members NOT on the field this playoff match, resolved by
   * the arena from GetOffFieldTeamIds and sent as whole team records.
   *
   * This is how a playoff alliance's fourth robot is actually knowable. The
   * desk's types asserted it could only be found by joining playoff seeds
   * against the rosters from alliance selection, which is not true against
   * this build and left a desk that restarted through selection unable to
   * name the backup at all. On the day an alliance subs its backup in, the
   * graphic named three robots and left out the one about to play.
   *
   * Do not assume exactly one: model.Alliance.TeamIds is not capped at four.
   */
  RedOffFieldTeams?: (CheesyTeam | null)[];
  BlueOffFieldTeams?: (CheesyTeam | null)[];
}

/**
 * One driver station's slot on the field. field.AllianceStation.
 *
 * The connection field is DsConn, not Ds, and the stop flags are AStop and
 * EStop, not Astop and Estop. Go emits struct field names verbatim when there
 * are no json tags, and there are none on AllianceStation. The arena's own
 * field monitor reads stationStatus.DsConn.RobotLinked, which is the same
 * shape by a different name.
 *
 * Reading the wrong name meant every station looked like it had no DS data at
 * all: `linked` stayed 0 and `down` stayed empty on every frame, all weekend.
 * Three things depended on that and none of them could ever have fired. The
 * dropped-robot replay marker, so "what happened to 846?" is never caught.
 * The station-health strip, which showed six healthy robots with three dead.
 * And match.armed, gated on `linked === fielded`, so the desk would never have
 * cut to the score bar before a countdown for any match of the event.
 */
export interface AllianceStationStatus {
  Team?: CheesyTeam | null;
  DsConn?: {
    RobotLinked?: boolean;
    DsLinked?: boolean;
    RadioLinked?: boolean;
    RioLinked?: boolean;
    /** The team plugged into the wrong station. Worth saying out loud. */
    WrongStation?: string;
    SecondsSinceLastRobotLink?: number;
    BatteryVoltage?: number;
  } | null;
  AStop?: boolean;
  EStop?: boolean;
  Bypass?: boolean;
  Ethernet?: boolean;
}

export interface ArenaStatusMessage {
  MatchId?: number;
  AllianceStations?: Record<string, AllianceStationStatus | null>;
  /**
   * Embedded anonymously in the arena's message struct. Go names a key after
   * an embedded non-struct type, so this arrives as "MatchState".
   */
  MatchState?: MatchState;
  PlcIsHealthy?: boolean;
  FieldEStop?: boolean;
  IsFtaReady?: boolean;
  CanStartMatch?: boolean;
  /** Why the field is not ready, in the arena's own words. */
  StartMatchConditions?: string[];
}

/**
 * game.MatchTiming, sent whole on the `matchTiming` notifier and once to every
 * socket on connect.
 *
 * Every field here is editable on the scorekeeper's /setup/settings page, and
 * shortening practice or filler matches is a normal thing to do at an
 * offseason. The desk compiles REBUILT's periods in, so if the field's numbers
 * move and nothing notices, every phase label, the endgame chip, the motion
 * lockdown, the replay markers and the on-air countdown are wrong for the rest
 * of the day with nothing to correct them.
 */
export interface MatchTimingMessage {
  AutoDurationSec?: number;
  PauseDurationSec?: number;
  TransitionShiftDurationSec?: number;
  ShiftDurationSec?: number;
  EndgameDurationSec?: number;
  TimeoutDurationSec?: number;
}

export interface ScorePostedMessage {
  Match?: CheesyMatch;
  RedScoreSummary?: ScoreSummary;
  BlueScoreSummary?: ScoreSummary;
  RedRankingPoints?: number;
  BlueRankingPoints?: number;
  /**
   * THE ARENA'S VERDICT, which the desk used to work out for itself by
   * comparing the two totals.
   *
   * Comparing totals is wrong twice over in a playoff. Every double
   * elimination match is created with useTiebreakCriteria, so a level score
   * is resolved on major fouls, then auto fuel, then tower points, and the
   * bracket advances the winner. And CorrectPlayoffScore sets PlayoffDq from
   * a red card WITHOUT touching Score, so a disqualified alliance can hold
   * the higher number.
   *
   * Either way the desk printed "TIE" on the audience screen, or "WINNER"
   * under the alliance that was just disqualified, while the announcer and
   * the bracket said otherwise. These two booleans are the answer, and they
   * have been on the wire the whole time.
   */
  RedWon?: boolean;
  BlueWon?: boolean;
  /**
   * Why, in the arena's own words: "TIEBREAK: MAJOR FOULS", "TIEBREAK: AUTO
   * FUEL", "TIEBREAK: TOWER POINTS", or "TRUE TIE". Empty when the match was
   * decided on points. Exactly what the hall wants to know.
   */
  TiebreakReason?: string;
  /** Whether the event has the traversal bonus switched on at all. */
  TraversalBonusEnabled?: boolean;
  /** Series standing for a playoff matchup. */
  RedWins?: number;
  BlueWins?: number;
  /** Where each alliance goes next, in the arena's bracket wording. */
  RedDestination?: string;
  BlueDestination?: string;
  RedOffFieldTeamIds?: number[];
  BlueOffFieldTeamIds?: number[];
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
