/**
 * Core data contract. See docs/02-architecture.md.
 *
 * One envelope for everything. Sources never talk to surfaces; they emit
 * DeskEvents and surfaces subscribe. Swapping an ingest adapter changes one
 * file and nothing else.
 */

export type Source =
  | 'cheesy'    // Cheesy Arena field bridge
  | 'frcapi'
  | 'tba'
  | 'statbotics'
  | 'startgg'
  | 'nexus'     // FRC Nexus: what the queuers are doing, not what the field is
  | 'manual'    // desk console, always authoritative override
  | 'cue'       // show automation
  // The 10Hz ticker's time-driven phase boundaries. Not 'cue': the cue
  // engine drops cue-sourced events to break feedback loops, and stamping
  // the ticker's events 'cue' made every clock-driven boundary invisible
  // to cues.
  | 'clock'
  | 'demo'      // simulated match driver, never a real show
  | 'replay';

/**
 * Matters more than it looks. Cheesy Arena gives `authoritative` numbers; a
 * state inferred from a scene change is `derived`; an operator's guess is
 * `estimated`. Graphics use this to decide whether to show a number at all:
 * an estimated score renders outlined, never solid, so we never present a
 * guess as official.
 */
export type Confidence = 'authoritative' | 'derived' | 'estimated';

export type Alliance = 'red' | 'blue';

/**
 * The envelope's own version.
 *
 * Recorded logs are replayed months later and are the project's regression
 * fixtures, so the shape they were written in has to be knowable from the file
 * rather than guessed from the date on it. Bump this only when the ENVELOPE
 * changes; adding a new `type` or changing a payload does not.
 *
 *   1  id, ts, matchClock, source, confidence, type, payload
 *   2  adds schemaVersion and seq
 *
 * A log with no `schemaVersion` field is version 1 by definition, which is
 * what makes this addable without invalidating anything already recorded.
 */
export const EVENT_SCHEMA_VERSION = 2;

export interface DeskEvent<T = unknown> {
  id: string;
  /**
   * Envelope version. Absent on anything logged before this existed; readers
   * treat a missing value as 1.
   */
  schemaVersion?: number;
  /**
   * Monotonic per-process counter, from 1.
   *
   * `id` is sortable and `ts` is orderable, but neither answers "did I miss
   * anything": a client reconnecting after a network blip can ask for events
   * after N and know whether the answer is complete. The 5,000-event ring in
   * bus.ts can already serve that; this is the number it needs. Resets when
   * the desk restarts, which is why it is a gap detector and not an identity.
   */
  seq: number;
  /** Wall clock, epoch ms, from the desk's clock. */
  ts: number;
  /** Signed seconds relative to match start. Null outside a match. */
  matchClock: number | null;
  source: Source;
  confidence: Confidence;
  type: DeskEventType;
  payload: T;
}

/** Deliberately a superset of Cheesy Arena's notifiers. */
export type DeskEventType =
  // match lifecycle
  | 'match.loaded' | 'match.prestart' | 'match.preview' | 'match.armed'
  | 'match.start' | 'match.auto_end' | 'match.teleop_start'
  | 'match.shift_change' | 'match.endgame'
  | 'match.end' | 'match.aborted' | 'match.score_posted'
  // live state
  | 'score.realtime' | 'score.delta' | 'hub.state' | 'arena.status'
  | 'card.issued' | 'foul.called'
  // The card call screen: what the card was for, and who it went to.
  | 'card.call' | 'card.call_clear'
  // event flow
  | 'rankings.updated' | 'alliance_selection.update'
  // The awards ceremony. `award.show` carries title and description ONLY: the
  // bus fans out to every open surface, so the winner first appears in
  // `award.presented`, at the moment it stops being a secret.
  | 'award.show' | 'award.presented' | 'award.clear'
  // A full-screen slide: volunteer recognition, a session announcement, a
  // moderated shout-out. See slides.ts.
  | 'slide.show' | 'slide.hide'
  // The visible-from-the-field countdown: robot setup, meeting starts.
  | 'timer.started' | 'timer.cleared'
  | 'break.started' | 'queue.updated'
  // Queuers called a match: the four minutes before the field knows anything.
  | 'queue.called'
  // Mirrored from the event's own announcement channel.
  | 'announcement.posted'
  // production
  | 'graphic.show' | 'graphic.hide' | 'lower_third.show' | 'lower_third.hide'
  // Who is on camera for an analysis segment or an interview.
  | 'panel.show' | 'panel.hide'
  // House audio: one event type, the payload is the whole snapshot. The music
  // machine's player page is a subscriber like any other surface, which is what
  // keeps this on the HOUSE bus and only the HOUSE bus (docs/06).
  | 'audio.updated'
  // `screen.change` is our overlay switching pages; `scene.change` is the
  // switcher cutting cameras. Different layers, deliberately different events.
  | 'screen.change' | 'scene.change' | 'sound.play'
  | 'replay.marker' | 'replay.clip_ready' | 'replay.play'
  | 'telestrator.stroke' | 'telestrator.undo' | 'telestrator.clear'
  | 'telestrator.frame' | 'telestrator.hide'
  // arcade
  | 'arcade.set_start' | 'arcade.score' | 'arcade.set_end' | 'arcade.bracket_updated'
  // crowd trivia: one event type, the payload is the whole snapshot
  | 'trivia.updated'
  // schedule pace (cycle time + behind-schedule estimate)
  | 'pace.updated'
  // audience-facing status card: delays, score review, arena faults
  | 'status.show' | 'status.hide'
  // Safety. Latches until explicitly cleared, and outranks every other graphic.
  | 'emergency.raise' | 'emergency.clear'
  // game configuration pushed from config.json at boot
  | 'game.thresholds'
  // What the event offers and where, pushed from config at boot.
  | 'event.accessibility'
  // The day as a list: which segment is live and when the next one starts.
  | 'rundown.updated'
  // Sponsor recognition, and the count behind the post-event report.
  | 'sponsor.show' | 'sponsor.hide';

// ---------------------------------------------------------------------------
// 2026 REBUILT
// ---------------------------------------------------------------------------

export const REBUILT = {
  /** Match clock axis, in seconds. Auto runs negative so 0 is teleop start. */
  AUTO_START: -20,
  TELEOP_START: 0,
  TRANSITION_END: 10,
  SHIFT_SECONDS: 25,
  SHIFT_COUNT: 4,
  ENDGAME_START: 110,
  MATCH_END: 140,

  /** Points. Fuel into an INACTIVE hub scores nothing. */
  FUEL_ACTIVE: 1,
  TOWER_AUTO_L1: 15,
  TOWER_TELEOP: { 1: 10, 2: 20, 3: 30 } as Record<1 | 2 | 3, number>,

  /**
   * Default bonus RP thresholds.
   *
   * Defaults, not constants. An off-season event can and does move these, and
   * REBUILT's own numbers were still being argued over as this was written, so
   * they live in config and travel on the state snapshot. Nothing derives a
   * ranking point from these literals: `DeskState.thresholds` is the value
   * every surface and the reducer actually read.
   */
  RP_ENERGIZED_FUEL: 100,
  RP_SUPERCHARGED_FUEL: 360,
  RP_TRAVERSAL_TOWER: 50,

  RP_WIN: 3,
  RP_TIE: 1,
} as const;

export type Phase =
  | 'pre' | 'auto' | 'transition' | 'shift1' | 'shift2' | 'shift3' | 'shift4'
  | 'endgame' | 'post';

export interface Team {
  number: number;
  name: string;
  /** Present only if a robot cutout has been uploaded. */
  media?: { src: string; w: number; h: number };
  rank?: number;
  record?: string;
}

export interface AllianceScore {
  /** The period breakdown: what the final-score screen itemizes. */
  autoFuel: number;
  teleopFuel: number;
  autoTower: number;
  teleopTower: number;
  /** Derived sums, kept because every surface reads them. */
  fuel: number;
  tower: number;
  /** Foul points this alliance CONCEDED (credited to the opponent's total). */
  fouls: number;
  /** fuel + tower + opponent foul points */
  total: number;
  rp: { energized: boolean; supercharged: boolean; traversal: boolean };
}

export const emptyAllianceScore = (): AllianceScore => ({
  autoFuel: 0, teleopFuel: 0, autoTower: 0, teleopTower: 0,
  fuel: 0, tower: 0, fouls: 0, total: 0,
  rp: { energized: false, supercharged: false, traversal: false },
});

export interface MatchInfo {
  id: string;
  /** "Qualification 42", "Playoff 3": what goes on the intro card. */
  displayName: string;
  /**
   * The robots on the field. Three in qualification, and three in a playoff
   * match too: a four-team playoff alliance is carrying a backup, and which
   * three play can change between matches. Every surface sizes itself off the
   * length of this array rather than assuming three, so a fuller roster
   * renders correctly wherever one is supplied.
   */
  red: Team[];
  blue: Team[];
  /** Playoff seed, 1-8. Absent in qualification. */
  redAlliance?: number;
  blueAlliance?: number;
  /**
   * Teams playing this one as a surrogate: it fills a schedule and does not
   * count for their record.
   *
   * Declared here rather than read out of the payload with a cast, which is
   * how it was consumed before. The cast worked and hid the real problem:
   * nothing PRODUCED the field, because the Cheesy protocol type did not model
   * the station flags either, so the desk's surrogate mark could not appear at
   * a real event no matter what.
   */
  surrogates?: number[];
}

/**
 * What each bonus ranking point costs, live on the state snapshot.
 *
 * These are the numbers the reducer scores against and every surface labels
 * its badges with, so changing them in config changes the whole system at
 * once. Nothing recomputes an RP from a hard-coded literal.
 */
export interface RpThresholds {
  energizedFuel: number;
  superchargedFuel: number;
  traversalTower: number;
}

export const defaultThresholds = (): RpThresholds => ({
  energizedFuel: REBUILT.RP_ENERGIZED_FUEL,
  superchargedFuel: REBUILT.RP_SUPERCHARGED_FUEL,
  traversalTower: REBUILT.RP_TRAVERSAL_TOWER,
});

/**
 * One person on camera during an analysis segment or an interview.
 *
 * Kept to three fields on purpose. The desk manager is typing these while a
 * guest is already sitting down, so anything that takes longer than a name and
 * a role will not get filled in.
 */
export interface PanelPerson {
  name: string;
  /** "Analyst", "Play-by-play", "Drive coach", "Pit reporter". */
  role: string;
  /** Shown as a gold numeral when the guest belongs to a team. */
  team?: number | null;
}

/**
 * Who is on camera right now.
 *
 * The analysis screen used to carry a single fixed strap, which was true
 * exactly when one person was talking. A strategy segment before a playoff
 * match is three or four people, and an interview is at least two, so the
 * screen takes a LIST and lays it out to fit rather than naming one of them
 * and leaving the rest anonymous.
 */
export interface PanelState {
  /** Segment name: "Analysis desk", "Pit interview", "Match preview". */
  title: string;
  people: PanelPerson[];
}

export interface LowerThird {
  line1: string;
  line2: string;
  /** Unpinned graphics auto-retire after --dwell. */
  pinned: boolean;
}

export interface RankingRow {
  rank: number;
  previousRank: number;
  team: number;
  name: string;
  rankingPoints: number;
  /** "8-2-1" */
  record: string;
  played: number;
}

export interface UpcomingMatch {
  name: string;
  shortName: string;
  time: string | null;
  red: number[];
  blue: number[];
}

/** How the event is actually running vs. the published schedule. */
export interface PaceInfo {
  cycleSec: number | null;
  nextStartAt: number | null;
  behindMin: number | null;
  lastStartAt: number | null;
}

/**
 * Audience-facing status card. Unexplained stoppages read as dead air; a
 * card that says WHY ("score under review") reads as process.
 */
/**
 * A safety message, on every screen at once.
 *
 * Deliberately NOT a StatusCard. A status card explains a delay, auto-retires,
 * and shares the screen. This does none of those things: it latches until a
 * human clears it, it covers the frame, and it outranks the match graphic,
 * because the one time it is used is the one time nobody should be reading a
 * scorebug.
 */
export interface Emergency {
  kind: 'evacuate' | 'shelter' | 'medical' | 'hold' | 'allclear' | 'custom';
  /** The words that go on the wall. Written by whoever raised it. */
  message: string;
  /** Where to go, when that is the point of the message. */
  detail: string;
  raisedAt: number;
}

export type CardColor = 'yellow' | 'red';

/**
 * Cards, as the OVERLAY needs them.
 *
 * Deliberately on the state snapshot rather than read from the ledger in
 * cards.ts: the program overlay is an open surface with no credential, and
 * /api/discipline is gated. Both derive from the same card.issued events and
 * dedupe the same way; this carries what a graphic needs, and the ledger
 * carries the audit trail the announcer reads.
 */
export interface CardState {
  /** Running totals per team, across the whole event. Yellows carry. */
  byTeam: Record<number, { yellows: number; reds: number }>;
  /** Issued in the match currently loaded, for the post-match graphic. */
  thisMatch: { team: number; color: CardColor; alliance: Alliance }[];
}

/**
 * The card call: the screen the GA talks over between the buzzer and the score.
 *
 * A card gets announced out loud, and until now the audience had nothing to
 * look at while it happened, so the words landed over an unchanged scorebug.
 */
export interface CardCall {
  team: number;
  color: CardColor;
  alliance: Alliance;
  /** Why. Typed at the desk, because no field system supplies a reason. */
  reason: string;
  at: number;
}

export interface StatusCard {
  kind: 'delay' | 'review' | 'fault' | 'replay' | 'custom';
  message: string;
  /** Optional "back at" estimate, wall clock ms. */
  backAt: number | null;
}

/**
 * Sunday's alliance selection, mirrored from the field.
 *
 * Selection is a long segment where the audience watches students walk across
 * a floor, and at most events there is no graphic at all: no board, no clock,
 * no way to know who is still available. Cheesy Arena already tracks every bit
 * of this and publishes it to audience displays, so the desk draws it rather
 * than tracking a second copy that could disagree with the field.
 */
export interface AllianceSelection {
  /** In seed order. `teams[0]` is the captain; the rest are picks so far. */
  alliances: { id: number; teams: number[] }[];
  /** The pool, in rank order, with the ones already taken marked. */
  ranked: { rank: number; team: number; picked: boolean }[];
  /** The field's own pick clock. We render it, we never run it. */
  showTimer: boolean;
  timeRemainingSec: number;
  /** When this snapshot arrived, so the clock can tick between messages. */
  updatedAt: number;
}

export interface TelestratorState {
  /** Named on the ANALYSIS chip, so the audience knows it's opinion. */
  analyst: string;
  /**
   * Frozen frame the analyst is drawing on, as a URL. The single biggest
   * usability win: without it they're marking up a blank sheet while squinting
   * at a screen across the room, and every circle lands slightly wrong.
   */
  frame: string | null;
  /** Instant kill for program without clearing the analyst's pad. */
  hidden: boolean;
}

/** The snapshot every surface renders from. */
export interface DeskState {
  match: MatchInfo | null;
  phase: Phase;
  /**
   * Wall clock of match start. Surfaces derive their own matchClock from this
   * every frame rather than being pushed the clock at 10Hz. The overlay
   * countdown stays smooth through a network hiccup, and we don't spend
   * bandwidth on a number the client can compute.
   */
  matchStartedAt: number | null;
  /**
   * Survives the buzzer. `matchStartedAt` is cleared at match end so the clock
   * stops, but cutting a match video happens after that (often minutes after,
   * once the score is finally posted), and the replay timeline still needs to
   * map match clock onto wall clock.
   */
  lastMatchStartedAt: number | null;
  /**
   * When the CURRENT match was loaded. The marker feed cuts on this: markers
   * from before it belong to the previous match, and serving them once put
   * the last match's "red takes the lead" in front of a head referee
   * reviewing the current one: the wrong robot, presented as evidence.
   */
  matchLoadedAt: number | null;
  /** Wall clock of the buzzer, and of the score actually being posted. The gap
   *  between them is unbounded (referees deliberating fouls and cards can run
   *  minutes), which is why match videos cut rather than run straight through. */
  matchEndedAt: number | null;
  scorePostedAt: number | null;
  matchClock: number | null;
  /** Countdown as the audience sees it: "0:20" in auto, "2:20" in teleop. */
  clockDisplay: string;
  hubActive: Alliance | 'both' | 'none';
  /**
   * Hub state straight from the field, when the Cheesy bridge is up. Preferred
   * over inference: the field knows which hub is live and we would only be
   * guessing from the auto result. Null when running desk-only.
   */
  hubAuthoritative: Alliance | 'both' | 'none' | null;
  autoWinner: Alliance | null;
  /**
   * True once the field has told us who won auto. Needed because `null` is a
   * legitimate answer (a tied auto) and is otherwise indistinguishable from
   * "nobody has said yet": without this the time-driven heuristic overwrites
   * the field's correct answer a moment after it arrives.
   */
  autoWinnerKnown: boolean;
  score: Record<Alliance, AllianceScore>;
  /**
   * How the score BREAKDOWN was arrived at: the per-period fuel and tower
   * splits the final screen itemizes.
   *
   * Separate from totalConfidence because the two are genuinely different
   * claims and the desk regularly holds one of each. When the field posts a
   * result the TOTAL is official; the breakdown beside it may still be what
   * an operator typed while the bridge was down. One flag for both meant the
   * arrival of an official total silently promoted every shadow-scored
   * period split to solid, official-looking numerals on the one screen
   * everybody screenshots.
   */
  confidence: Confidence;
  /** How the alliance TOTALS were arrived at. See confidence above. */
  totalConfidence: Confidence;
  /** Which surface screen is live: overview, match, score, blank... */
  screen: string;
  /**
   * Which OBS scene (camera) is live, as far as the desk knows.
   *
   * Separate from `screen` on purpose: the graphic and the shot are different
   * layers, and keeping them separate is what lets the graphics stay correct
   * when a three-person crew is late on a cut.
   */
  scene: string | null;
  /**
   * True once an operator has taken a screen by hand.
   *
   * Match lifecycle events move the screen on their own, which is what makes
   * the show run unattended. It also means a manual take used to be undone by
   * the next thing the field did: pick the arcade bumper during a gap and
   * `match.loaded` would yank it back to the overview a moment later. While
   * this is set, automatic changes are ignored and the operator's choice
   * stands until they hand it back with the Auto button.
   */
  screenHold: boolean;
  lowerThird: LowerThird | null;
  /** Who is on camera on the analysis screen. Null falls back to the strap. */
  panel: PanelState | null;
  telestrator: TelestratorState;
  /** Drives the venue side screens. Polled from Cheesy, empty when desk-only. */
  rankings: RankingRow[];
  highestPlayedMatch: string;
  upcoming: UpcomingMatch[];
  /** Actual cycle time + behind-schedule estimate. See pace.ts. */
  pace: PaceInfo;
  /**
   * Which match the QUEUERS are calling right now, from Nexus.
   *
   * Deliberately separate from `match`, which is what the field has loaded.
   * These are different facts minutes apart, and conflating them is how a
   * side screen ends up telling six teams to walk to a field that is still
   * playing the previous match.
   */
  nowQueuing: string | null;
  /** The most recent event announcement, mirrored from Nexus. */
  announcement: { text: string; postedAt: number; from: string } | null;
  /** Live status card, or null. Operator-fired from the desk console. */
  status: StatusCard | null;
  /** Safety message. Latches; outranks everything else on every surface. */
  emergency: Emergency | null;
  /** Cards, for the icons on the bar and the post-match graphic. */
  cards: CardState;
  /** The card call currently on air, or null. */
  cardCall: CardCall | null;
  /**
   * The award on the program screen. `winner` stays null until the reveal:
   * this state is served openly, and a spoiler in it would be readable on any
   * phone in the gym while the GA is still building suspense.
   */
  award: {
    id: string; title: string; description: string;
    winner: string | null; team: number | null; revealed: boolean; at: number;
  } | null;
  /** The slide on the program screen, when the screen is 'slide'. */
  slide: { id: string; kind: string; title: string; lines: string[] } | null;
  /**
   * The event countdown: field setup, a meeting, doors. Rendered big on the
   * side screens, which face the hall (and the field, when one is turned).
   */
  timer: { label: string; endsAt: number; startedAt: number } | null;
  /** The sponsor on air, or null. */
  sponsor: { id: string; name: string; line: string; logo: string | null } | null;
  /** Teams playing this match as a surrogate: it does not count for them. */
  surrogates: number[];
  /** Accessibility services this event actually offers. Empty means none listed. */
  accessibility: { services: { label: string; detail: string }[]; ask: string };
  /** Alliance selection, mirrored from the field. Null until it starts. */
  selection: AllianceSelection | null;
  /** What each bonus RP costs. From config, not a constant. */
  thresholds: RpThresholds;
  /** Endgame: suppress decorative motion, keep score/clock animating. */
  lockdown: boolean;
  connected: { cheesy: boolean };
  updatedAt: number;
}

export const initialState = (): DeskState => ({
  match: null,
  phase: 'pre',
  matchStartedAt: null,
  lastMatchStartedAt: null,
  matchLoadedAt: null,
  matchEndedAt: null,
  scorePostedAt: null,
  matchClock: null,
  clockDisplay: '0:20',
  hubActive: 'none',
  hubAuthoritative: null,
  autoWinner: null,
  autoWinnerKnown: false,
  score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
  confidence: 'estimated',
  totalConfidence: 'estimated',
  screen: 'blank',
  scene: null,
  screenHold: false,
  lowerThird: null,
  panel: null,
  telestrator: { analyst: '', frame: null, hidden: false },
  rankings: [],
  highestPlayedMatch: '',
  upcoming: [],
  pace: { cycleSec: null, nextStartAt: null, behindMin: null, lastStartAt: null },
  nowQueuing: null,
  announcement: null,
  status: null,
  emergency: null,
  cards: { byTeam: {}, thisMatch: [] },
  cardCall: null,
  award: null,
  slide: null,
  timer: null,
  sponsor: null,
  surrogates: [],
  accessibility: { services: [], ask: '' },
  selection: null,
  thresholds: defaultThresholds(),
  lockdown: false,
  connected: { cheesy: false },
  updatedAt: Date.now(),
});

/** Sortable, collision-resistant id. Small ULID-ish: time + randomness. */
let lastMs = 0;
let seq = 0;
export function eventId(): string {
  const now = Date.now();
  if (now === lastMs) seq++;
  else { lastMs = now; seq = 0; }
  return `${now.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}` +
    Math.random().toString(36).slice(2, 8);
}
