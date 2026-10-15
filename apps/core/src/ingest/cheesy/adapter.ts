/**
 * Cheesy Arena -> DeskEvent adapter.
 *
 * Close to a rename of fields, with one genuinely interesting piece: neither
 * Cheesy Arena nor FMS emits "team X just scored". `score.delta` is synthesized
 * here by diffing consecutive realtime-score snapshots, and it is what drives
 * automatic replay markers, scoring-rate graphics, and the post-match timeline.
 * It is the highest-value derived signal in the system and it costs about forty
 * lines.
 */

import type { EmitInit, EventBus } from '../../bus.ts';
import { REBUILT } from '../../types.ts';
import type {
  Alliance, AllianceSelection, MatchInfo, RankingRow, Team, UpcomingMatch,
} from '../../types.ts';
import { CheesyClient, type CheesyClientOpts } from './client.ts';
import { teamName } from '../../teams.ts';
import {
  MatchState, MatchStatus, MatchType,
  type AllianceSelectionMessage, type AudienceDisplayModeMessage,
  type ArenaStatusMessage, type MatchLoadMessage, type MatchTimeMessage,
  type EventStatusMessage,
  type MatchTimingMessage, type MatchWithResult, type RankingsResponse,
  type RealtimeScoreMessage, type ScorePostedMessage, type ScoreSummary,
} from './protocol.ts';

const ALLIANCES: Alliance[] = ['red', 'blue'];

/**
 * REST mappings, pure so they can be tested against realistic fixtures. The
 * live request path is exercised against a real arena; these cover what the
 * responses turn into once populated.
 */
export function mapRankings(res: RankingsResponse): {
  highestPlayedMatch: string; rankings: RankingRow[];
} {
  return {
    highestPlayedMatch: res.HighestPlayedMatch ?? '',
    rankings: (res.Rankings ?? []).map(r => ({
      rank: r.Rank ?? 0,
      previousRank: r.PreviousRank ?? 0,
      team: r.TeamId ?? 0,
      name: teamName(r.TeamId ?? 0, r.Nickname),
      rankingPoints: r.RankingPoints ?? 0,
      // What the ORDERING is on. Cheesy sorts by RP per match played, so a
      // table printing the raw total puts a rank-4 team above a rank-3 team
      // on the number beside its own rank.
      avgRp: (r.Played ?? 0) > 0
        ? Math.round(((r.RankingPoints ?? 0) / (r.Played ?? 1)) * 10) / 10
        : 0,
      record: `${r.Wins ?? 0}-${r.Losses ?? 0}-${r.Ties ?? 0}`,
      played: r.Played ?? 0,
    })),
  };
}

/**
 * The arena stops listing matches once the gap to the next one passes this,
 * on the grounds that what is on the far side of lunch is not "up next".
 * field.MaxMatchGapMin in the 2026 source.
 */
export const MAX_MATCH_GAP_MIN = 20;

export interface UpcomingOpts {
  /**
   * TypeOrder of the match the field currently has loaded, when it is of the
   * same type as this list. Matches below it are behind the field and are
   * dropped even if they were never played.
   */
  fromTypeOrder?: number;
  limit?: number;
}

/**
 * Schedule rows -> the on-deck queue, mirroring web/queueing_display.go.
 *
 * The arena's own rule is `match.IsComplete() || match.TypeOrder <
 * CurrentMatch.TypeOrder` -> skip, then stop at a gap over MaxMatchGapMin.
 * Filtering on completion ALONE is not the same thing, because a skipped
 * match is never completed and never hidden: a no-show or a bit of schedule
 * compression, both routine at an offseason, leaves a qual that will never be
 * played sitting at the head of the queue for the rest of the weekend. The
 * TypeOrder floor is what retires it, and it is why this takes the loaded
 * match rather than just the list.
 *
 * 8, not the arena's 5: the venue side screens show four, but the phone-facing
 * per-team schedule view needs a longer horizon to answer "when do WE play
 * next". Playoffs are capped tighter by the caller, as they are in the arena,
 * because further out than the next few is genuinely unknowable.
 */
export function mapUpcoming(
  matches: MatchWithResult[], opts: UpcomingOpts = {},
): UpcomingMatch[] {
  const limit = opts.limit ?? 8;
  const floor = opts.fromTypeOrder ?? -Infinity;
  const out: UpcomingMatch[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    // Anything past "scheduled" has been played, so it isn't on deck. Hidden
    // is the arena's own "pretend this row does not exist".
    if ((m.Status ?? MatchStatus.Scheduled) !== MatchStatus.Scheduled) continue;
    if ((m.TypeOrder ?? 0) < floor) continue;

    const red = [m.Red1, m.Red2, m.Red3].filter((n): n is number => !!n);
    const blue = [m.Blue1, m.Blue2, m.Blue3].filter((n): n is number => !!n);
    // Playoff matches whose feeding matchups have not resolved come back with
    // all six stations zeroed (playoff_tournament.go, UpdateMatches positions
    // an empty Alliance). They are Scheduled, not Hidden, so they reach here.
    // A row with no teams and no seeds names nobody and is not worth a line on
    // a pit monitor; one with seeds can at least say which alliances meet.
    const redSeed = m.PlayoffRedAlliance ?? 0;
    const blueSeed = m.PlayoffBlueAlliance ?? 0;
    if (!red.length && !blue.length && !(redSeed > 0 || blueSeed > 0)) continue;

    out.push({
      name: m.LongName ?? m.ShortName ?? '',
      shortName: m.ShortName ?? '',
      time: m.Time ?? null,
      red, blue,
      ...(redSeed > 0 ? { redAlliance: redSeed } : {}),
      ...(blueSeed > 0 ? { blueAlliance: blueSeed } : {}),
    });
    if (out.length >= limit) break;

    // Don't carry the list across a break. The next row's scheduled time is
    // the arena's own test for one.
    const next = matches[i + 1];
    const gapMs = next?.Time && m.Time
      ? Date.parse(next.Time) - Date.parse(m.Time) : 0;
    if (Number.isFinite(gapMs) && gapMs > MAX_MATCH_GAP_MIN * 60_000) break;
  }
  return out;
}

/**
 * Alliance selection, straight across.
 *
 * Defensive about empties because this notifier fires before selection starts,
 * with an alliance list already sized to the event and every `TeamIds` still
 * empty. A captain slot that has not been filled yet is a hole in the board,
 * not a team zero.
 */
export function mapSelection(msg: AllianceSelectionMessage): AllianceSelection {
  return {
    alliances: (msg.Alliances ?? []).map((a, i) => ({
      id: a.Id ?? i + 1,
      /*
       * POSITIONAL. The zeros are holes, not absences.
       *
       * The arena pre-allocates every alliance's TeamIds to full length and
       * fills slots positionally, writing 0 back into a slot the scorekeeper
       * clears. Filtering the zeros out COMPACTED the array, which is
       * harmless while picks arrive left to right, and wrong in the one case
       * that matters: correcting a mis-entered first-round pick by blanking
       * it while the second-round pick is already in slid the second-round
       * pick into the first-round column, on the projector, during the
       * segment the whole hall is watching.
       *
       * Trailing zeros still go, because a slot nobody has reached yet is
       * genuinely not there and the board draws its own empty slots.
       */
      teams: trimTrailing((a.TeamIds ?? []).map(n => (typeof n === 'number' && n > 0 ? n : 0))),
    })),
    ranked: (msg.RankedTeams ?? [])
      .filter(r => (r.TeamId ?? 0) > 0)
      .map(r => ({ rank: r.Rank ?? 0, team: r.TeamId!, picked: r.Picked === true })),
    showTimer: msg.ShowTimer === true,
    timeRemainingSec: Math.max(0, msg.TimeRemainingSec ?? 0),
    updatedAt: Date.now(),
  };
}

/**
 * The three bonus ranking points, as the FIELD awarded them.
 *
 * Worth taking rather than recomputing, because the arena knows three things
 * the desk cannot see. It scores the fuel bonuses on NumFuel, a count of
 * fuel, where the desk only has fuel POINTS and fuel into an inactive hub
 * scores nothing. A G206 call strips all three at once, and the desk never
 * learns which rule a foul was for. And a traversal threshold of zero
 * disables the tower bonus entirely, which is a setting, not a score.
 *
 * Null when the summary carries no opinion, which keeps the desk's own
 * derivation alive for an operator-driven show with no field attached.
 */
function bonusRp(s: ScoreSummary | undefined):
{ energized: boolean; supercharged: boolean; traversal: boolean } | null {
  if (!s) return null;
  const has = s.EnergizedBonusRankingPoint !== undefined
    || s.SuperchargedBonusRankingPoint !== undefined
    || s.TraversalBonusRankingPoint !== undefined;
  if (!has) return null;
  return {
    energized: s.EnergizedBonusRankingPoint === true,
    supercharged: s.SuperchargedBonusRankingPoint === true,
    traversal: s.TraversalBonusRankingPoint === true,
  };
}

/**
 * model.MatchType -> what the desk calls that part of the tournament.
 *
 * Test matters most. Cheesy skips the database work for a test match but
 * fires the score-posted notifier anyway, outside that guard, so the FTA's
 * Friday field checkout reaches the desk looking like any other committed
 * result. Nothing downstream could tell: "Test Match" has no TBA key and is
 * not a practice match either, so neither gate caught it.
 */
function matchKind(type: number | string | undefined): MatchInfo['kind'] | null {
  switch (type) {
    case MatchType.Test: return 'test';
    case MatchType.Practice: return 'practice';
    case MatchType.Qualification: return 'qualification';
    case MatchType.Playoff: return 'playoff';
    default: return null;
  }
}

/** Drop empty slots off the END only: a hole in the middle is information. */
function trimTrailing(list: number[]): number[] {
  let end = list.length;
  while (end > 0 && !list[end - 1]) end--;
  return list.slice(0, end);
}

/**
 * A real matchLoad as the desk's MatchInfo. Pure, so a load the adapter has
 * held back (see CheesyAdapter #held) maps the same when it is finally let in.
 */
export function mapMatchLoad(msg: MatchLoadMessage): MatchInfo {
  const m = msg.Match ?? {};
  const teamAt = (key: string, fallback: number | undefined): Team | null => {
    const t = msg.Teams?.[key];
    const number = t?.Id ?? fallback;
    if (!number) return null;
    return {
      number,
      // TBA's placeholder for a second robot is replaced with the team's
      // own name; everyone else keeps what the field says. See teams.ts.
      name: teamName(number, t?.Nickname ?? t?.Name),
      ...(msg.Rankings?.[String(number)] ? { rank: msg.Rankings[String(number)] } : {}),
    };
  };

  const red = [teamAt('R1', m.Red1), teamAt('R2', m.Red2), teamAt('R3', m.Red3)].filter(Boolean) as Team[];
  const blue = [teamAt('B1', m.Blue1), teamAt('B2', m.Blue2), teamAt('B3', m.Blue3)].filter(Boolean) as Team[];

  // Surrogates, straight off the station flags. Without this the desk's
  // surrogate mark had no producer and never appeared at a real event: the
  // audience watched a team "lose" a match that was never theirs to lose,
  // and then found the ranking table disagreed with what they had just seen.
  const surrogates = ([
    [m.Red1, m.Red1IsSurrogate], [m.Red2, m.Red2IsSurrogate], [m.Red3, m.Red3IsSurrogate],
    [m.Blue1, m.Blue1IsSurrogate], [m.Blue2, m.Blue2IsSurrogate], [m.Blue3, m.Blue3IsSurrogate],
  ] as const)
    .filter(([team, flag]) => flag === true && typeof team === 'number' && team > 0)
    .map(([team]) => team as number);

  // Seeds are 0 through qualification, so they are carried only when real.
  // A graphic that says "Alliance 0" is worse than one that says nothing.
  const match: MatchInfo = {
    id: String(m.Id ?? `${m.Type ?? 'm'}${m.TypeOrder ?? 0}`),
    displayName: m.LongName ?? m.ShortName ?? 'Match',
    red, blue,
    surrogates,
    ...((m.PlayoffRedAlliance ?? 0) > 0 ? { redAlliance: m.PlayoffRedAlliance } : {}),
    ...((m.PlayoffBlueAlliance ?? 0) > 0 ? { blueAlliance: m.PlayoffBlueAlliance } : {}),
    ...(matchKind(m.Type) ? { kind: matchKind(m.Type)! } : {}),
  };

  /*
   * The rest of each playoff alliance: the members not on the field this
   * match, which is where the backup robot lives.
   *
   * The arena resolves these for us on every playoff matchLoad. The desk
   * used to believe the fourth member could only be found by joining
   * playoff seeds against the rosters observed during alliance selection,
   * so a desk that restarted through selection could not name the backup at
   * all, and on the day an alliance subbed one in the graphic named three
   * robots and left out the one about to play.
   *
   * Not capped at one: model.Alliance.TeamIds is not capped at four.
   *
   * Named through teamName like the robots on the field. The second robot
   * sitting a match out is exactly the one the arena calls "Off-Season Demo
   * Team 9999", because the arena takes its nicknames from TBA, and the
   * result card printed that under 100B.
   */
  const offField = (list: MatchLoadMessage['RedOffFieldTeams']): Team[] =>
    (list ?? [])
      .filter((t): t is NonNullable<typeof t> => !!t?.Id)
      .map(t => ({ number: t.Id!, name: teamName(t.Id!, t.Nickname ?? t.Name) }));
  const redOff = offField(msg.RedOffFieldTeams);
  const blueOff = offField(msg.BlueOffFieldTeams);
  if (redOff.length) match.redOffField = redOff;
  if (blueOff.length) match.blueOffField = blueOff;
  return match;
}

interface Totals {
  autoFuel: number; teleopFuel: number; autoTower: number; teleopTower: number;
  foulsAgainst: number;
}
const zero = (): Totals => ({
  autoFuel: 0, teleopFuel: 0, autoTower: 0, teleopTower: 0, foulsAgainst: 0,
});
const fuelOf = (t: Totals): number => t.autoFuel + t.teleopFuel;
const towerOf = (t: Totals): number => t.autoTower + t.teleopTower;

/**
 * The longest the desk keeps a posted result up over the match the arena
 * loaded behind it, counted from the post, when nothing else releases it.
 *
 * The arena's own automation leaves its score up for 20 s, 30 s before a
 * playoff bracket and 60 s when nothing is left to play. That automation is
 * a checkbox on /setup/settings, and it is OFF until somebody ticks it, so
 * an arena left at its defaults keeps the score up until the scorekeeper
 * changes the display by hand, or the next match starts. This is the net
 * under all of that, and under a desk that never hears the display move (an
 * arena build without the notifier, or the audience socket down): long
 * enough for the reveal, short enough that the next match's overview still
 * gets its minutes on air.
 */
export const POSTED_HOLD_MS = 60_000;

/**
 * How long a load that arrives after the buzzer but BEFORE the score waits
 * for that score. The two ride different sockets (scorePosted only ever comes
 * on the audience display's, matchLoad usually on the arena API's) and are
 * sent a few milliseconds apart, so a reordering is milliseconds. Anything
 * longer is a scorekeeper who discarded the result and loaded a different
 * match, and nothing is coming.
 */
export const POST_RACE_MS = 5_000;

/** The field is running a match: the moment a held next match must be loaded. */
const running = (state: unknown): boolean =>
  state === MatchState.StartMatch || state === MatchState.AutoPeriod
  || state === MatchState.PausePeriod || state === MatchState.TeleopPeriod;

export interface CheesyAdapterOpts extends Omit<CheesyClientOpts, 'onEvent' | 'onStatus'> {
  bus: EventBus;
}

export class CheesyAdapter {
  #bus: EventBus;
  #client: CheesyClient;
  #last: Record<Alliance, Totals> = { red: zero(), blue: zero() };
  #matchState: MatchState = MatchState.PreMatch;
  #started = false;
  /** Teams the previous arenaStatus frame saw linked, for the drop edge. */
  #prevLinked = new Set<number>();
  /** Auto fuel per alliance: the only thing that decides the auto winner. */
  #autoFuel: Record<Alliance, number> = { red: 0, blue: 0 };
  #autoWinnerSent = false;
  #matchLoaded = false;
  /**
   * The arena has its Test Match loaded, whatever the desk is still showing.
   *
   * The test load itself is suppressed (see #onMatchLoad), so the desk keeps
   * the last real match on screen. That alone was half a fix: the test
   * match's start, buzzer, realtime scores and arming all still flowed, and
   * the desk filed every one of them against the real match it was holding.
   * An FTA checking a robot on the Test Match while Q43 waited started Q43's
   * clock, cut program to the score bar, put the test's fuel on Q43's score,
   * minted replay markers, gave the pace model a cycle that never happened
   * and told the on-deck list Q43 was on the field. At the end of quals the
   * test load's own all-zero score frame landed on the posted final and
   * blanked its breakdown and bonus badges on the Final screen.
   *
   * So while this is set, nothing per-match is emitted. The next real load
   * clears it, because that is the arena saying the test is over.
   */
  #testLoaded = false;
  /** arenaStatus has reported the test match (id 0) since it loaded. See #checkTestStillLoaded. */
  #testSeenOnStatus = false;
  /** Whether any matchTime frame has arrived yet, in this desk's lifetime. */
  #sawMatchTime = false;
  /**
   * The desk's FIRST matchTime frame said PostMatch: it started (or was
   * restarted) after the buzzer, during the referees' review or with the score
   * already up. No match.start was ever seen for the loaded match, so to the
   * desk it looked unplayed, and the on-deck list put the match that had just
   * been played back on top as the next to start. Used once, for the match
   * loaded at that moment, then cleared; any other state clears it too.
   */
  #joinedAfterBuzzer = false;
  /** The last list of played matches sent, so a poll that changes nothing sends nothing. */
  #playedKey = '';
  /** Latched per match: armed fires once, when the field first goes ready. */
  #armedSent = false;
  /** Id of the last loaded match, to tell a reconnect replay from a fresh load. */
  #loadedMatchId: string | null = null;
  /**
   * The NEXT match, which the arena has already loaded and the desk is not
   * showing yet.
   *
   * Cheesy commits a score, sets its audience display to "score", resets the
   * field and loads the next match, all in the one commitAndPost handler, so
   * matchLoad for Q43 lands a millisecond behind scorePosted for Q42. The
   * arena's own audience screen keeps Q42's score up from a saved copy. The
   * desk has no saved copy: everything downstream (the Final screen, the
   * reveal footage, the gap cue, a prediction round's reveal, the publish
   * queue) reads the result off the loaded match, and match.loaded resets it.
   * Passed straight through, the result was wiped the instant it posted, on
   * every match of the event.
   *
   * So the load is held here, and the finished match stays loaded, until the
   * arena itself moves on: its audience display leaving the score, the field
   * starting a match, or POSTED_HOLD_MS. The test match loaded over it drops
   * it unloaded, since the arena no longer has it loaded either.
   * Only the newest load is kept, and while the result is up a newer one
   * does not release it: the same match re-sent (a scheduled break's
   * description, a Nexus substitution, a reconnect) and a different match
   * loaded by hand both replace the held copy, because neither moves the
   * arena's display off the result. A re-run of the finished match itself
   * voids the result and is loaded at once.
   */
  #held: MatchLoadMessage | null = null;
  #heldId: string | null = null;
  #holdTimer: NodeJS.Timeout | null = null;
  /**
   * The loaded match whose posted score the desk has accepted, and when. Set
   * only by a post, cleared by every load, so "the score is up" is a fact
   * about the match on screen rather than about whatever was posted last.
   */
  #postedId: string | null = null;
  #postedAt = 0;
  /**
   * The loaded match has reached the buzzer (or been aborted) and no score has
   * been posted for it yet: the window in which the next load can beat the
   * score onto the desk. See POST_RACE_MS.
   */
  #endedUnposted = false;
  /**
   * Every member of each alliance in the loaded match, the ones sitting this
   * match out included. A playoff card is the alliance's, and the arena says
   * so without naming a team.
   */
  #allianceTeams: Record<Alliance, number[]> = { red: [], blue: [] };
  /**
   * Cards already announced. The realtime score message carries the whole
   * card map on every frame, so without this one yellow card would re-emit
   * (and re-mark for replay) on every score change for the rest of the match.
   * Keyed alliance:team:card so an upgrade to red still gets announced, and
   * alliance:"alliance":card for a playoff card, which names no team.
   */
  #cardsSeen = new Set<string>();
  #pollTimer: NodeJS.Timeout | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  /** True while a REST round-trip is in flight, to hold the one-request budget. */
  #polling = false;
  /** Last aggregate bridge state reported, so arena.status fires on edges. */
  #lastAggUp: boolean | null = null;
  /** Display name of the loaded match, riding on card.issued for phasing. */
  #loadedMatchName = '';
  /**
   * When Nexus last delivered a queue LIST, so the schedule poll can defer to
   * it. Only a payload carrying `upcoming` counts: see the subscription in the
   * constructor.
   */
  #nexusQueueAt = 0;
  /**
   * Where the field is in the schedule: the loaded match's type and its order
   * within that type. The arena's queueing display drops anything below this,
   * which is the only thing that retires a match the scorekeeper skipped.
   * Null until the first matchLoad, where no floor is the honest answer.
   */
  #loadedType: number | string | null = null;
  #loadedTypeOrder: number | null = null;
  /**
   * Committed score per match, as last seen on the schedule poll.
   *
   * Cheesy guards its score-posted notifier with `if !isMatchReviewEdit`, so
   * a correction made on /match_review republishes to TBA and tells the desk
   * NOTHING. The video description was baked at queue time, and in deferred
   * mode it is not written to YouTube until hours later, long after the
   * correction: the desk would upload a score line it already knew was wrong,
   * sitting under a TBA match page that disagreed with it.
   *
   * The poll already carries the committed result, so the correction is
   * visible without asking the arena for anything new.
   */
  #committed = new Map<string, string>();
  /** Non-null while the field's period lengths disagree with REBUILT. */
  #timingMismatch: string[] | null = null;
  #timingWarned = false;
  /**
   * Which run of each match has been loaded. Cheesy re-runs a committed match
   * under the SAME Match.Id, and both commits fire the score-posted notifier,
   * so without a run number the publish queue treated the second as a
   * duplicate label and put the abandoned first run on the channel.
   */
  #runs = new Map<string, number>();
  /**
   * Which socket each notifier is being taken from. First to deliver wins.
   *
   * Most of the arena's notifiers are published on several sockets at once:
   * matchLoad on five of our six, matchTime on four, realtimeScore on two.
   * Each is an independent TCP connection carrying the identical stream, the
   * messages carry no sequence number or timestamp, and each listener is a
   * five-deep channel with a NON-BLOCKING send that silently drops when full,
   * so one socket running a few seconds behind the others is an ordinary
   * outcome when this process is busy cutting a clip.
   *
   * Identical duplicates were harmless, because the second diff is zero. The
   * REORDERINGS were not, and all three of these are event-visible:
   *
   *   PostMatch, then a stale TeleopPeriod, then PostMatch, and match.end
   *   fires TWICE: the post-match sequence and the automatic cut both run
   *   again.
   *
   *   TeleopPeriod, stale PausePeriod, TeleopPeriod, and match.teleop_start
   *   fires twice, which re-anchors the clock and jumps the on-air countdown
   *   backwards to 2:20 in the middle of teleop.
   *
   *   realtimeScore 50, a stale 45, then 55, and the desk emits a +10 delta
   *   for 5 points of real scoring. score.delta drives the replay markers,
   *   the scoring-rate graphic and the post-match timeline, so they overstate
   *   the rest of the match. The stale frame also lands wholesale on
   *   score.realtime, so the audience sees the score drop and jump back.
   *
   * First-to-deliver rather than a hard-coded socket per notifier, because an
   * offseason arena build missing an endpoint should still work: whichever
   * socket brings a notifier first owns it, and ownership is released the
   * moment that socket drops so another can take over. Redundancy kept,
   * duplicates gone.
   */
  #owner = new Map<string, string>();
  /** What the arena calls the break that is about to start, from matchLoad. */
  #breakDescription = '';
  #breakNextMatch = '';
  /** The break's length, from matchTiming. Zero when the arena has not said. */
  #timeoutSec = 0;

  constructor(opts: CheesyAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = new CheesyClient({
      host: opts.host,
      displayId: opts.displayId,
      onEvent: (notifier, data, path) => this.ingest(notifier, data, path),
      onDown: (path) => this.socketDown(path),
      onStatus: (_up, detail) => {
        // The AGGREGATE, not the single socket: six sockets feed this
        // callback, and reporting each one's state last-writer-wins made one
        // missing endpoint (an offseason arena build lacking a display
        // route) flap the whole bridge "down" once a minute while field data
        // flowed on the other five. The client already keeps the honest
        // answer; only its edges are worth an event.
        const agg = this.#client.connected;
        if (agg === this.#lastAggUp) return;
        this.#lastAggUp = agg;
        this.#bus.emit({
          type: 'arena.status', source: 'cheesy', confidence: 'authoritative',
          payload: { cheesy: agg, detail },
        });
      },
    });

    /*
     * Watch the queuers' source so the schedule poll knows when to yield.
     *
     * Only a LIST is proof that Nexus is alive. The Nexus adapter also sends
     * {nowQueuing: null} on its own, after three failed polls, to take a stale
     * "now queuing" banner down; counting that as a delivery meant the one
     * message that says "Nexus has stopped answering" restarted the 90s
     * deferral instead. A bad or revoked key then kept the field's queue off
     * the screens for another minute and a half or more, with a played match
     * sitting as next up after its score had been committed.
     *
     * Here rather than in start() so the arbitration holds from construction
     * and can be exercised without opening sockets to an arena.
     */
    this.#bus.subscribe(ev => {
      if (ev.type !== 'queue.updated' || ev.source !== 'nexus') return;
      const list = (ev.payload as { upcoming?: unknown } | null)?.upcoming;
      if (Array.isArray(list)) this.#nexusQueueAt = ev.ts;
    });
  }

  get client(): CheesyClient { return this.#client; }

  start(): void {
    this.#client.connect();
    // Schedule and rankings are REST-only. 60s is deliberate: they change on
    // the order of once a match, and the field network is not ours to load up.
    void this.#poll();
    this.#pollTimer = setInterval(() => void this.#poll(), 60_000);
  }

  stop(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#clearHold();
    this.#client.close();
  }

  /**
   * Rankings change at exactly one moment: when a score is committed. Waiting
   * out the 60s poll means the side screens can show last match's standings
   * for a full minute while the room is looking at the new ones, so a posted
   * score pulls them immediately.
   *
   * The delay is for Cheesy, not for us: `scorePosted` goes out to displays as
   * part of committing, and the rankings table is written in the same handler.
   * A moment's grace avoids reading the table mid-write and getting the old
   * numbers, which would be worse than waiting.
   */
  #refreshSoon(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#poll();
    }, 1500);
  }

  /**
   * Pull the schedule and rankings. Failures are logged once and retried on the
   * next tick. A missing schedule degrades the side screens, it does not stop
   * the broadcast, so there is nothing here worth throwing over.
   *
   * Guarded against overlap: docs/10's connection budget is one concurrent
   * HTTP request. The 60s timer and the post-score refresh can otherwise land
   * close enough together to both be in flight at once, especially if the
   * field network is already slow, which is exactly when you don't want a
   * second request stacked on the first.
   */
  /** Run one poll now. Exposed for tests; the event loop uses the timer. */
  pollNow(): Promise<void> { return this.#poll(); }

  async #poll(): Promise<void> {
    if (this.#polling) { this.#refreshSoon(); return; }

    /*
     * NOT WHILE A MATCH IS RUNNING.
     *
     * GET /api/matches/{type} is O(N-squared) over the arena's database.
     * matchesApiHandler calls GetMatchResultForMatch once per match, and that
     * function has no index: it calls getAll() every time, which walks the
     * whole bucket doing a json.Unmarshal on every record, each carrying two
     * full score structs, and then summarizes twice per match. For an 80
     * match qualification schedule with results that is thousands of
     * unmarshals for ONE request, and the desk was issuing two of them every
     * sixty seconds on a bare timer with no check on match state.
     *
     * It runs in the same process as the arena's Run loop, which warns above
     * 5ms per iteration and above 550ms between driver station packets. The
     * expected symptom is "Arena loop iteration took a long time" in the
     * FTA's log at a steady one a minute, correlated with us, and the FTA
     * reasonably blaming the new box on their network.
     *
     * Nothing is lost by waiting. The schedule does not change during a
     * match, and the moment it DOES change, a score commit, is already
     * covered by #refreshSoon. Rankings are cheap by comparison and are
     * genuinely wanted the moment they move, so they are not gated.
     */
    const live = this.#matchState === MatchState.StartMatch
      || this.#matchState === MatchState.AutoPeriod
      || this.#matchState === MatchState.PausePeriod
      || this.#matchState === MatchState.TeleopPeriod;

    this.#polling = true;
    try {
      try {
        const res = await this.#client.get<RankingsResponse>('/api/rankings');
        this.#emit({ type: 'rankings.updated', payload: mapRankings(res) });
      } catch (err) {
        console.warn('[cheesy] rankings poll failed:', (err as Error).message);
      }

      if (live) return;

      try {
        // The arena's rule, applied per list because TypeOrder only orders
        // within a type: a qual floor means nothing to a playoff row.
        const floor = (t: number): number | undefined =>
          this.#loadedType === t && this.#loadedTypeOrder !== null
            ? this.#loadedTypeOrder : undefined;

        /*
         * FRIDAY IS PRACTICE.
         *
         * This used to read qualification and playoff only, so through the
         * whole of Friday's practice session the on-deck list on every venue
         * screen and pit monitor was Saturday's qualification schedule, with
         * times the desk projected from practice cycles, and the practice
         * match actually on the field never had a row at all.
         *
         * The arena's own queueing display shows the loaded match's type, so
         * this does the same: practice loaded, practice listed, with the same
         * TypeOrder floor. Instead of quals, not as well as, which keeps the
         * request count where it was.
         *
         * Back to quals once practice has nothing left at or above the floor.
         * Friday night the field sits on its test match with the last
         * practice match still the last one loaded, and the next thing
         * anyone will play is Qualification 1, which is what the screens
         * should say until the scorekeeper loads it on Saturday.
         */
        let practice: MatchWithResult[] = [];
        let upcoming: UpcomingMatch[] = [];
        if (this.#loadedType === MatchType.Practice) {
          practice = await this.#client.get<MatchWithResult[]>('/api/matches/practice');
          upcoming = mapUpcoming(practice, { fromTypeOrder: floor(MatchType.Practice) });
        }

        let qual: MatchWithResult[] = [];
        // Playoff matches live under their own type. Polling qualification
        // alone emptied the Sunday on-deck queue: once the last qual match is
        // played, nothing in that list is Scheduled any more. Sequential, to
        // hold the one-concurrent-request budget.
        let playoff: MatchWithResult[] = [];
        if (!upcoming.length) {
          qual = await this.#client.get<MatchWithResult[]>('/api/matches/qualification');
          // Not before there is a bracket. Asking costs the same full table
          // walk as a real answer, and the answer is an empty array until
          // alliance selection has finalized. The alliance board is the desk's
          // own witness to that, and the loaded match type is the other: once
          // the field is playing playoffs there is certainly a bracket.
          const bracketExists = this.#loadedType === MatchType.Playoff
            || (this.#bus.state.selection?.alliances ?? []).some(a => a.teams.some(t => t > 0));
          if (bracketExists) {
            try {
              playoff = await this.#client.get<MatchWithResult[]>('/api/matches/playoff');
            } catch {
              // Quals alone is still a correct queue.
            }
          }
          upcoming = [
            ...mapUpcoming(qual, { fromTypeOrder: floor(MatchType.Qualification) }),
            // Four, as in the arena's numPlayoffMatchesToShow: past the next
            // few, which alliance plays which is genuinely not known yet.
            ...mapUpcoming(playoff, {
              fromTypeOrder: floor(MatchType.Playoff), limit: 4,
            }),
          ].slice(0, 8);
        }

        // Nexus arbitration: when the queuers' live estimates are flowing,
        // this poll stays quiet. Both sources write state.upcoming wholesale,
        // and alternating them put the printed schedule and the live estimate
        // on the side screens in turns, disagreeing with themselves once a
        // minute. Two sources disagreeing on air is worse than one being
        // absent; Cheesy is the fallback, and 90s (four missed Nexus polls)
        // is how long it waits before deciding the fallback is needed.
        //
        // Unless Nexus has nothing to say. It publishes an empty list at the
        // end of the day and at an event that is not using it for queuing,
        // and deferring to an empty list is deferring to no list at all.
        const nexusFresh = Date.now() - this.#nexusQueueAt <= 90_000;
        if (!nexusFresh || this.#bus.state.upcoming.length === 0) {
          this.#emit({ type: 'queue.updated', payload: { upcoming } });
        }

        // Which matches have a result, sent whatever the queue source: the
        // deck uses it to keep a played match from being listed as next when
        // Nexus cannot tell played from on-the-field. Only on change. Practice
        // included: the queuers run Friday from Nexus too, and a played
        // practice match is exactly as capable of sitting at the top of it.
        const rows = [...practice, ...qual, ...playoff];
        const played = rows
          .filter(m => m.Status === MatchStatus.RedWon || m.Status === MatchStatus.BlueWon
            || m.Status === MatchStatus.Tie)
          .map(m => m.LongName ?? m.ShortName ?? '')
          .filter(Boolean);
        const playedKey = played.join('|');
        if (playedKey !== this.#playedKey) {
          this.#playedKey = playedKey;
          this.#emit({ type: 'schedule.played', payload: { names: played } });
        }

        // Practice too: practice matches go to the channel as well, and a
        // corrected practice score is just as wrong in a video description.
        this.#noticeCorrections(rows);
      } catch (err) {
        console.warn('[cheesy] schedule poll failed:', (err as Error).message);
      }
    } finally {
      this.#polling = false;
    }
  }

  /**
   * A committed score that has CHANGED since the desk last looked.
   *
   * Only fires on a change, and only for a match that already had a score, so
   * the first sight of a played match is not a correction. Silent on the
   * first poll of the day by construction: every match is new then, and
   * nothing is a change from a value we never had.
   */
  #noticeCorrections(rows: MatchWithResult[]): void {
    for (const row of rows) {
      const name = (row.LongName ?? row.ShortName ?? '').trim();
      const red = row.Result?.RedSummary?.Score;
      const blue = row.Result?.BlueSummary?.Score;
      if (!name || typeof red !== 'number' || typeof blue !== 'number') continue;

      const key = `${red}:${blue}`;
      const was = this.#committed.get(name);
      this.#committed.set(name, key);
      if (was === undefined || was === key) continue;

      console.warn(`[cheesy] ${name} was corrected after it was committed: ` +
        `${was.replace(':', '-')} is now ${key.replace(':', '-')}. ` +
        'Anything already uploaded for it carries the old line.');
      this.#emit({
        type: 'match.score_corrected',
        payload: { label: name, red, blue },
      });
    }
  }

  #emit(init: EmitInit): void {
    this.#bus.emit({ confidence: 'authoritative', source: 'cheesy', ...init });
  }

  /**
   * Feed one Cheesy Arena notifier in. Public because the websocket is not the
   * only thing that drives it: a recorded capture can be replayed through the
   * same path to rehearse the whole pipeline without a field.
   *
   * `path` is the socket it arrived on. Omitted by a replay or a test, which
   * is the whole point: those have exactly one source, so there is nothing to
   * arbitrate and the ownership check is skipped.
   */
  /**
   * A socket has gone: release whatever it owned so the next frame from any
   * other socket takes that notifier over.
   *
   * Without this, losing /displays/audience would silently stop scorePosted
   * for the rest of the event, while three other sockets went on carrying
   * matchLoad and matchTime perfectly well.
   */
  socketDown(path: string): void {
    for (const [notifier, owner] of this.#owner) {
      if (owner === path) this.#owner.delete(notifier);
    }
  }

  ingest(notifier: string, data: unknown, path?: string): void {
    // One socket per notifier. See #owner: matchLoad is published on five of
    // our six sockets and matchTime on four, and a lagging duplicate is worse
    // than no duplicate at all.
    if (path !== undefined) {
      const owner = this.#owner.get(notifier);
      if (owner === undefined) this.#owner.set(notifier, path);
      else if (owner !== path) return;
    }
    switch (notifier) {
      case 'matchLoad': return this.#onMatchLoad(data as MatchLoadMessage);
      case 'matchTime': return this.#onMatchTime(data as MatchTimeMessage);
      case 'realtimeScore': return this.#onRealtimeScore(data as RealtimeScoreMessage);
      case 'scorePosted': return this.#onScorePosted(data as ScorePostedMessage);
      case 'arenaStatus': return this.#onArenaStatus(data as ArenaStatusMessage);
      case 'allianceSelection':
        return this.#onAllianceSelection(data as AllianceSelectionMessage);
      case 'matchTiming': return this.#onMatchTiming(data as MatchTimingMessage);
      case 'eventStatus': return this.#onEventStatus(data as EventStatusMessage);
      case 'audienceDisplayMode':
        return this.#onAudienceDisplayMode(data as AudienceDisplayModeMessage);
      default: return;   // lowerThird, playSound, etc.; the desk owns those
    }
  }

  // ---- field configuration ------------------------------------------------

  /**
   * The field's own period lengths, against the ones the desk is built for.
   *
   * The desk does not adopt these, and deliberately. REBUILT's timings are
   * compiled into the clock, the phase labels, the replay markers, the motion
   * lockdown and seven surfaces; quietly reinterpreting all of that from a
   * websocket frame mid-event would turn one wrong number into a different
   * wrong number in more places. What was missing was anybody NOTICING.
   *
   * So this compares and says so, once, loudly, with a vital the desk console
   * shows. A scorekeeper shortening practice matches is a normal thing to do,
   * and the difference between "the endgame chip is early all afternoon" and
   * "the endgame chip is early all afternoon, and the desk said why at 9:14am"
   * is the whole value here.
   */
  #onMatchTiming(msg: MatchTimingMessage): void {
    const expected = {
      AutoDurationSec: -REBUILT.AUTO_START,
      TransitionShiftDurationSec: REBUILT.TRANSITION_END,
      ShiftDurationSec: REBUILT.SHIFT_SECONDS,
      EndgameDurationSec: REBUILT.MATCH_END - REBUILT.ENDGAME_START,
    } as const;

    const off: string[] = [];
    for (const [key, want] of Object.entries(expected)) {
      const got = msg[key as keyof MatchTimingMessage];
      if (typeof got === 'number' && got !== want) {
        off.push(`${key} is ${got}s, the desk is built for ${want}s`);
      }
    }
    // PauseDurationSec has no REBUILT counterpart: the desk's clock treats
    // teleop start as zero and never models the pause, so a change there
    // moves nothing on air.
    // Not a mismatch, a fact: the arena sets this when a timeout begins, and
    // it is the countdown the break card needs.
    this.#timeoutSec = Math.max(0, msg.TimeoutDurationSec ?? 0);

    this.#timingMismatch = off.length ? off : null;
    if (off.length && !this.#timingWarned) {
      this.#timingWarned = true;
      console.warn('[cheesy] the field\'s match timing does not match this desk: ' +
        `${off.join('; ')}. Phase labels, the endgame chip, the lockdown and the ` +
        'countdown will be wrong until they agree.');
    }
  }

  /** Non-null while the field's periods disagree with REBUILT. For vitals. */
  get timingMismatch(): string[] | null { return this.#timingMismatch; }

  /**
   * How late the event is running, in the arena's own words.
   *
   * The arena derives this from the adjacent matches' scheduled versus actual
   * start times and puts it on its queueing display, its rankings display and
   * the field monitor. The desk derives its own figure from a median of
   * recent cycle times, and had no case for this notifier, so two screens in
   * the same gym were going to show different minute figures all weekend with
   * nothing to reconcile them. The field's number is the one the scoring
   * table will be asked about, so it wins; the desk's stays as the fallback
   * for a desk running without a bridge.
   *
   * Same arbitration shape as Nexus versus Cheesy on the queue.
   */
  #onEventStatus(msg: EventStatusMessage): void {
    const message = (msg.EarlyLateMessage ?? '').trim();
    // Empty is the arena declining to guess: a test match, or a replay, where
    // it says so explicitly rather than publishing a wrong number. Declining
    // is not the same as saying "on schedule", so it clears rather than
    // overwrites.
    this.#emit({
      type: 'pace.updated',
      confidence: 'authoritative',
      payload: { officialLate: message || null },
    });
  }

  /**
   * Alliance rosters.
   *
   * Cheesy writes every notifier's current value to a socket the moment it
   * connects. allianceSelection comes from arena.AllianceSelectionAlliances,
   * an IN-MEMORY field that is empty after any arena restart and is only
   * repopulated when a human opens /alliance_selection in a browser, which
   * does not fire the notifier.
   *
   * So an arena restart on Sunday, or any socket blip after one, delivered an
   * empty alliance list, the reducer replaced the rosters wholesale, and the
   * fourth alliance member disappeared from the selection board, the result
   * card and the awards graphic for the rest of the playoffs, with nothing
   * short of a desk restart able to bring it back.
   *
   * An empty list when a filled one is already held is therefore not news. It
   * is the arena saying it has forgotten, and forgetting is not a fact about
   * the alliances.
   */
  #onAllianceSelection(msg: AllianceSelectionMessage): void {
    const next = mapSelection(msg);
    const hasTeams = next.alliances.some(a => a.teams.some(t => t > 0));
    const held = this.#bus.state.selection;
    if (!hasTeams && held?.alliances.some(a => a.teams.some(t => t > 0))) {
      console.warn('[cheesy] ignoring an empty alliance list: the arena has been ' +
        'restarted and has not reloaded selection. Keeping the rosters we hold.');
      return;
    }
    this.#emit({ type: 'alliance_selection.update', payload: next });
  }

  // ---- match lifecycle ----------------------------------------------------

  #onMatchLoad(msg: MatchLoadMessage): void {
    const m = msg.Match ?? {};
    // Held BEFORE the reconnect guards below, which return early. The arena
    // sends these on the load that accompanies a timeout, and that load
    // usually carries the same match id the desk already has, so anything
    // read after the guards would never see a break at all.
    this.#breakDescription = (msg.BreakDescription ?? '').trim();
    this.#breakNextMatch = (msg.BreakNextMatchName ?? '').trim();

    /*
     * A TEST match is the arena saying there is nothing loaded.
     *
     * When the last match of a type is committed, LoadNextMatch finds nothing
     * and calls LoadTestMatch, which loads {Type: Test, Id: 0, LongName:
     * "Test Match"} with no teams at all. That happens at the end of
     * qualifications and again after the last final, so without this the
     * program feed and the lower third read "Test Match" with two empty
     * alliances for the whole alliance-selection window and again through the
     * awards, while the arena's own automation had already moved its audience
     * display to the logo for exactly that reason.
     *
     * It also poisoned the coverage ledger, which created a row named "Test
     * Match" and pointed #lastLoaded at it, so any stray match.end or posted
     * score in that window was filed against a match that does not exist.
     *
     * Suppressed rather than rendered: the desk keeps the last real match on
     * screen, which is what the room is still talking about, and the operator
     * moves it on. The publish queue refuses a test match separately, because
     * a scorekeeper can commit one deliberately during Friday checkout.
     *
     * And REMEMBERED, because the FTA can also load it on purpose, mid
     * schedule, to check a robot while a real match waits, and then run it.
     * Everything that match does (start, buzzer, scores, cards, arming) is
     * the test's and not the waiting match's; see #testLoaded for what it
     * did before. The field-level notices still flow while it is loaded: a
     * timeout started for alliance selection has the test match loaded, and
     * its break card and its end are exactly what the room needs.
     */
    if (matchKind(m.Type) === 'test') {
      if (this.#loadedMatchId !== null && !this.#testLoaded) {
        console.log('[cheesy] the field has loaded its test match: holding the ' +
          'last real match on screen, and nothing the test match does is ' +
          'filed against it until a real match is loaded.');
      }
      this.#testLoaded = true;
      this.#testSeenOnStatus = false;
      // The newest load wins, and this is it: a next match held behind a
      // posted result is no longer what the arena has loaded. The result
      // stays on screen, as it does whenever the test match follows a post.
      this.#clearHold();
      // If the desk joined after a buzzer, the match that buzzer belonged to
      // is this one, and a test match ending is nothing to report. Leaving
      // it set handed "ended before join" to the next REAL match loaded,
      // which then read as already over before it had started.
      this.#joinedAfterBuzzer = false;
      /*
       * The one start that can slip through. A desk that restarts while a
       * test match is running can hear matchTime on one socket before
       * matchLoad on another, and a running first frame is announced as a
       * late join before anything says what is loaded. Left alone, the clock
       * it started runs out the timeline and the desk's own ticker fires a
       * buzzer for it, filed against whatever the coverage ledger last saw
       * loaded. Unloading is the honest correction, and only when the desk
       * has nothing loaded at all, which is exactly the restart case: it
       * touches no real match.
       */
      if (this.#started && this.#loadedMatchId === null && this.#bus.state.match === null) {
        this.#started = false;
        this.#emit({ type: 'match.unloaded' });
      }
      return;
    }
    // Any real load ends a test, including one the echo guards below would
    // otherwise swallow: after a test, the same id coming back is the field
    // genuinely loading it again, not a socket replaying it.
    const afterTest = this.#testLoaded;
    this.#testLoaded = false;
    const match = mapMatchLoad(msg);

    // Cheesy replays its matchLoad snapshot whenever a display (re)subscribes,
    // so a mid-match websocket reconnect delivers the SAME load again. Treating
    // that as a fresh load wiped the live score, killed the clock, and flipped
    // program back to the overview mid-match. PostMatch counts as in progress
    // here: the buzzer-to-score-posted window runs minutes while referees
    // deliberate, and a socket blip in it used to wipe the just-finished score
    // off air, yank program to the overview, and diff the replayed score
    // snapshot against zero, minting phantom burst/climb replay markers for a
    // match that was already over. A genuine scorekeeper replay of the same
    // match arrives after the field has returned to PreMatch, so it still
    // resets.
    //
    // Neither guard applies straight after a test match. #matchState is then
    // the TEST's state (a frame race can leave it reading PostMatch when the
    // waiting match is reloaded), and the waiting match's own state has to
    // be rebuilt from scratch anyway, including re-arming it.
    //
    // Nor does this one while a next match is held (see #held). The arena
    // has moved off the loaded match by then, so its current load, the one a
    // reconnecting display is sent, is the held one: an echo of the loaded
    // match cannot exist. What does arrive is the scorekeeper re-running the
    // match just committed, and the commit's ResetMatch announces PreMatch in
    // a single matchTime frame that a full listener channel drops. With that
    // frame lost #matchState still read PostMatch, the re-run's load was
    // swallowed here, and its start released the held match instead: the
    // re-run was filed against the next match and its result dropped.
    const inProgress = this.#matchState === MatchState.StartMatch
      || this.#matchState === MatchState.AutoPeriod
      || this.#matchState === MatchState.PausePeriod
      || this.#matchState === MatchState.TeleopPeriod
      || this.#matchState === MatchState.PostMatch;
    if (!afterTest && !this.#held && inProgress && match.id === this.#loadedMatchId) return;
    // The same match again, with its score posted and no replay flag. A real
    // Cheesy never sends this: a commit loads the NEXT match in the same
    // handler (see #held), and a load of a committed match always carries
    // IsReplay. It stays for an arena build that posts without moving on,
    // where a reconnect echo of the finished match would otherwise wipe the
    // posted score, flip program to the dead match's overview, and null the
    // timestamps the gap cue and the publish cut key off. A GENUINE re-run
    // arrives with IsReplay set and still resets.
    if (!afterTest && match.id === this.#loadedMatchId && !msg.IsReplay
        && this.#bus.state.scorePostedAt !== null) {
      return;
    }

    // The loaded match's result is up, on the arena's screen as on ours.
    const resultUp = this.#postedId !== null && this.#postedId === this.#loadedMatchId;

    // Already sitting on the arena's next match: keep only the newest. The
    // same match re-sent is the arena describing it again (a scheduled
    // break's text 5 s after the commit, a Nexus substitution, a reconnect),
    // and it keeps the hold.
    //
    // So does a DIFFERENT match while the result is up. That is the
    // scorekeeper loading by hand (Q44 ahead of the auto-loaded Q43), which
    // is ResetMatch and LoadMatch: neither touches the arena's audience
    // display, so the hall is still looking at the result. Applied at once,
    // that load cut the desk to Q44's empty overview under the arena's own
    // score screen, recorded that overview as the reveal footage and let go
    // of a producer's hold on the Final screen. The timer keeps running
    // rather than starting over, and the same releases apply.
    //
    // Not the loaded match itself, though. Past the echo guards above, that is
    // the scorekeeper loading it again (a committed match comes back with
    // IsReplay), so any result it had is void and nothing waits behind it:
    // it is the match the field plays next. Nor a second load while the desk
    // was only waiting out POST_RACE_MS: nothing was posted, the arena's
    // screen has no result on it, and the newest load is the match.
    if (this.#held) {
      if (match.id === this.#heldId) { this.#held = msg; return; }
      if (resultUp && match.id !== this.#loadedMatchId) {
        this.#held = msg;
        this.#heldId = match.id;
        return;
      }
      this.#clearHold();
      this.#applyLoad(msg, match);
      return;
    }

    // The next match, loaded in the same breath as the score it follows. See
    // #held. Counted from the post, so a load that turns up long after one
    // (an arena build that does not load on commit) is not held at all. A
    // re-run of the finished match is not a next match, and is never held.
    if (!afterTest && resultUp && match.id !== this.#loadedMatchId) {
      const left = POSTED_HOLD_MS - (Date.now() - this.#postedAt);
      if (left > 0) { this.#hold(msg, match.id, left); return; }
    }
    // The next match ahead of the score it follows, which rides another
    // socket. Waits a moment for it, so the score is not dropped as a replay
    // of a match that is no longer loaded. See POST_RACE_MS.
    if (!afterTest && this.#endedUnposted && this.#loadedMatchId !== null
        && match.id !== this.#loadedMatchId) {
      this.#hold(msg, match.id, POST_RACE_MS);
      return;
    }

    this.#applyLoad(msg, match);
  }

  /** Sit on a load. See #held. */
  #hold(msg: MatchLoadMessage, id: string, ms: number): void {
    this.#held = msg;
    this.#heldId = id;
    this.#holdFor(ms);
  }

  #holdFor(ms: number): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      this.#releaseHeld();
    }, Math.max(0, ms));
    // A held load is not a reason to keep the process alive at shutdown.
    this.#holdTimer.unref();
  }

  #clearHold(): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    this.#held = null;
    this.#heldId = null;
  }

  /**
   * The arena has moved on: load what it loaded. Straight to #applyLoad,
   * past the echo guards, because they were applied when the load arrived
   * and the state they read has moved since (the posted score they key off
   * is exactly what is being replaced).
   */
  #releaseHeld(): void {
    const msg = this.#held;
    if (!msg) return;
    this.#clearHold();
    this.#applyLoad(msg, mapMatchLoad(msg));
  }

  /**
   * The arena's own audience display. Only its moves matter here: it leaving
   * "score" is the arena saying the result has had its time, which is when
   * the desk lets the next match in. A reconnect replays the current mode,
   * which is either "score" (nothing to do) or already past it (and then the
   * arena really has moved on).
   *
   * Only once the score is in. Before that the display is still on the
   * "blank" the arena drops to three seconds after the buzzer, and a load
   * waiting on its score must not be released by it.
   */
  #onAudienceDisplayMode(mode: AudienceDisplayModeMessage): void {
    // Checked anyway: it is off a socket, and anything else is not a move.
    if (typeof mode !== 'string' || mode === 'score') return;
    if (this.#held && this.#postedId !== null && this.#postedId === this.#loadedMatchId) {
      this.#releaseHeld();
    }
  }

  /** Make a (real) load the loaded match. Everything per-match starts over. */
  #applyLoad(msg: MatchLoadMessage, match: MatchInfo): void {
    const m = msg.Match ?? {};
    this.#last = { red: zero(), blue: zero() };
    this.#started = false;
    this.#autoFuel = { red: 0, blue: 0 };
    this.#autoWinnerSent = false;
    this.#matchLoaded = true;
    this.#armedSent = false;
    this.#postedId = null;
    this.#endedUnposted = false;
    // IsReplay is the arena saying a result already exists for this match, so
    // whatever is about to be played is at least its second run.
    const run = msg.IsReplay === true ? (this.#runs.get(match.id) ?? 1) + 1 : 1;
    this.#runs.set(match.id, run);

    this.#loadedMatchId = match.id;
    this.#loadedMatchName = match.displayName ?? '';
    // Where the field is in the schedule, for the on-deck queue's floor.
    // Set here rather than in #poll because the poll only sees lists, and a
    // list cannot tell you which of its rows the scorekeeper has moved past.
    this.#loadedType = m.Type ?? null;
    this.#loadedTypeOrder = typeof m.TypeOrder === 'number' ? m.TypeOrder : null;
    this.#allianceTeams = {
      red: [...match.red, ...(match.redOffField ?? [])].map(t => t.number),
      blue: [...match.blue, ...(match.blueOffField ?? [])].map(t => t.number),
    };
    this.#cardsSeen.clear();
    this.#emit({ type: 'match.loaded', payload: { ...match, run } });
    if (this.#joinedAfterBuzzer) this.#endedBeforeJoin();
  }

  /** See #joinedAfterBuzzer. Its own event: a real match.end fires cues. */
  #endedBeforeJoin(): void {
    this.#joinedAfterBuzzer = false;
    this.#endedUnposted = true;
    this.#emit({ type: 'match.ended_before_join' });
  }

  /**
   * Cheesy sends matchTime continuously. We only care about the transitions:
   * the desk derives its own clock from match.start, so a dropped frame or a
   * network hiccup can't make the countdown stutter.
   */
  #onMatchTime(msg: MatchTimeMessage): void {
    const state = msg.MatchState ?? MatchState.PreMatch;
    // Either socket can win the race after a (re)start, so this works in both
    // orders: frame first (the load then picks it up), or load first.
    if (!this.#sawMatchTime) {
      this.#sawMatchTime = true;
      // A test match that has buzzed is not a real match that ended.
      this.#joinedAfterBuzzer = state === MatchState.PostMatch && !this.#testLoaded;
      if (this.#joinedAfterBuzzer && this.#matchLoaded) this.#endedBeforeJoin();
    } else if (state !== MatchState.PostMatch) {
      this.#joinedAfterBuzzer = false;
    }
    // The field is starting a match, so the one the arena loaded behind the
    // last result is on now, whatever its display is doing. Loaded FIRST, so
    // the start, the arming and everything after them belong to it rather
    // than to the match that already finished. See #held.
    if (this.#held && running(state)) this.#releaseHeld();
    if (state === this.#matchState) return;
    const previous = this.#matchState;
    // Tracked through a test match too: the schedule poll must still hold off
    // while one runs (it costs the arena's loop the same), and the load
    // guards need to know where the field really is.
    this.#matchState = state;
    /*
     * Everything below that belongs to a match is skipped while the arena has
     * its test match loaded: start, late join, the teleop re-anchor, the
     * buzzer and the abort. Each would land on the real match the desk is
     * holding. Prestart and the break card are about the FIELD, not the
     * match, so they still go: a timeout started at the end of quals has the
     * test match loaded, and the room needs that card and its end.
     */
    const test = this.#testLoaded;

    /*
     * Joining a match already in progress.
     *
     * #matchState starts at PreMatch, so a desk that connects mid-match sees
     * its first frame as a transition INTO whatever is running. The auto and
     * start arms below only fire for AutoPeriod and StartMatch, and the
     * teleop arm only re-anchors when it follows auto or the pause, so a desk
     * restarted during teleop never emitted match.start at all: #started
     * stayed false, the reducer never got a matchStartedAt, the clock sat
     * dead at 0:00 and program held the alliance overview for the rest of the
     * match. That is a restart during the one part of the day nobody can
     * pause, which is exactly when a restart happens.
     *
     * Back-dated by the field's own MatchTimeSec so the clock picks up where
     * the match actually is rather than restarting it at zero in front of the
     * hall. Without a usable time the event still fires: a clock that is a
     * few seconds out beats a screen frozen on the wrong graphic.
     */
    const joinedLate = !test && !this.#started
      && (state === MatchState.AutoPeriod
        || state === MatchState.PausePeriod
        || state === MatchState.TeleopPeriod)
      && previous !== MatchState.StartMatch;
    if (joinedLate) {
      const elapsed = Number(msg.MatchTimeSec);
      const ts = Number.isFinite(elapsed) && elapsed > 0
        ? Date.now() - elapsed * 1000
        : Date.now();
      this.#started = true;
      this.#emit({ type: 'match.start', ts });
      console.log('[cheesy] joined a match already running '
        + `(${Number.isFinite(elapsed) ? Math.round(elapsed) : '?'}s in); clock re-anchored`);
      /*
       * Deliberately no match.teleop_start here, even when joining during
       * teleop. That event exists to re-anchor the clock after a pause whose
       * length the desk could not know, by treating "now" as the start of
       * teleop. On a late join we have something better: MatchTimeSec is the
       * field's own match time, so the anchor above is already correct and
       * firing the re-anchor would throw it away and restart the clock at the
       * top of teleop. Measured: it turned a 42-second join into 20.
       */
    }

    switch (state) {
      case MatchState.StartMatch:
      case MatchState.AutoPeriod:
        if (!test && !this.#started) { this.#started = true; this.#emit({ type: 'match.start' }); }
        break;
      case MatchState.PostMatch:
        // Only a real match end (coming back from a timeout isn't one).
        if (!test && (previous === MatchState.TeleopPeriod || previous === MatchState.AutoPeriod
            || previous === MatchState.PausePeriod)) {
          /*
           * An ABORT looks exactly like a buzzer from here: AbortMatch sets
           * the arena's state straight to PostMatch, so the desk emitted
           * match.end either way and the coverage ledger marked the match
           * played. An abort that is never replayed, because of a card, a
           * schedule change or a field fault late on Sunday, then sat in the
           * gap list reporting no-score AND never-queued, advising somebody
           * to hand-queue a match that was correctly never recorded. A gap
           * report full of those stops being read.
           *
           * The clock tells them apart. A real match reaches the end of the
           * timeline; an abort stops short of it. The arena's own match time
           * is on this message, so this is its number rather than ours, and
           * the grace is generous because the only cost of guessing "ended"
           * is the behaviour that was there before.
           */
          const at = Number(msg.MatchTimeSec);
          const full = REBUILT.MATCH_END - REBUILT.AUTO_START;   // 160s
          const aborted = Number.isFinite(at) && at > 0 && at < full - 5;
          if (aborted) {
            console.log(`[cheesy] the field stopped at ${Math.round(at)}s of ${full}: ` +
              'treating this as an abort rather than a result.');
          }
          this.#emit({ type: aborted ? 'match.aborted' : 'match.end' });
          // Aborted too: the scorekeeper can still commit one.
          this.#endedUnposted = true;
        }
        this.#started = false;
        break;
      case MatchState.PreMatch:
        this.#started = false;
        this.#emit({ type: 'match.prestart' });
        break;
      case MatchState.TeleopPeriod:
        // The auto-to-teleop pause has no fixed length on a real field, so a
        // clock anchored at match.start runs ahead of the field by however
        // long the pause ran. This marks the moment teleop actually began, for
        // the reducer's match.teleop_start case to re-anchor on. Its own event
        // type, not a shift_change: the ticker owns shift1..4, and a foreign
        // phase value in that stream would reach every surface that renders
        // shift labels.
        if (!test && (previous === MatchState.PausePeriod || previous === MatchState.AutoPeriod)) {
          this.#emit({ type: 'match.teleop_start' });
        }
        break;
      case MatchState.TimeoutActive:
        /*
         * The arena knows what this break IS, and says so.
         *
         * Starting a scheduled break or an ad-hoc timeout sets
         * breakDescription and breakNextMatchName and fires matchLoad with
         * both, along with the new TimeoutDurationSec on matchTiming, all
         * before the state flips here. The desk read none of it and emitted a
         * bare {kind:'timeout'}, so through lunch, the awards break and every
         * field repair the arena's own audience display showed the break's
         * name, the next match and a live countdown while the venue screens
         * and the stream showed an undescribed "timeout" with no clock.
         * Those are exactly the moments the room most needs telling.
         */
        this.#emit({
          type: 'break.started',
          payload: {
            kind: 'timeout',
            ...(this.#breakDescription ? { label: this.#breakDescription } : {}),
            ...(this.#breakNextMatch ? { nextMatch: this.#breakNextMatch } : {}),
            ...(this.#timeoutSec > 0 ? { seconds: this.#timeoutSec } : {}),
          },
        });
        break;
    }
  }

  // ---- scoring ------------------------------------------------------------

  #totals(summary: ScoreSummary | undefined, opponent: ScoreSummary | undefined): Totals {
    return {
      autoFuel: summary?.AutoFuelPoints ?? 0,
      teleopFuel: summary?.TeleopFuelPoints ?? 0,
      autoTower: summary?.AutoTowerPoints ?? 0,
      teleopTower: summary?.TeleopTowerPoints ?? 0,
      // Our AllianceScore.fouls means "points this alliance conceded", because
      // the reducer computes total = fuel + tower + opponent.fouls. Cheesy's
      // FoulPoints are credited TO an alliance, so they belong on the other
      // side of the ledger. Covered by a test: this is easy to get backwards.
      foulsAgainst: opponent?.FoulPoints ?? 0,
    };
  }

  #onRealtimeScore(msg: RealtimeScoreMessage): void {
    /*
     * A test match's scores are nobody's. All of it goes: the score bar
     * (score.realtime), the replay markers and timeline (score.delta), the
     * hub indicator and auto winner (hub.state) and card marks (card.issued).
     *
     * Including the very first frame, which the arena sends as part of
     * loading the test match: all zeros, with every bonus false. At the end
     * of quals that frame landed on the last qual's posted result, still up
     * on the Final screen, and zeroed its breakdown and switched its bonus
     * badges off. The total survived only because it had been adopted.
     *
     * #last is left alone rather than zeroed: the next real load resets it,
     * and that load is the only way out of a test.
     */
    if (this.#testLoaded) return;
    /*
     * And while the next match is held behind a posted result, its frames
     * are not the result's. The first is the all-zero frame the arena sends
     * as it loads that match, and landing it zeroed the final's breakdown and
     * switched its bonus badges off. Frames are whole snapshots, so nothing
     * dropped here is lost: the next one carries the same numbers.
     *
     * Except a frame from a RUNNING field. That is the next match under way
     * on a socket that beat the clock's, and it is loaded first, then scored.
     */
    if (this.#held) {
      if (!running(msg.MatchState)) return;
      this.#releaseHeld();
    }
    const summaries: Record<Alliance, ScoreSummary | undefined> = {
      red: msg.Red?.ScoreSummary,
      blue: msg.Blue?.ScoreSummary,
    };

    const next: Record<Alliance, Totals> = {
      red: this.#totals(summaries.red, summaries.blue),
      blue: this.#totals(summaries.blue, summaries.red),
    };

    /*
     * The same zero frame, when it beats its own load onto the desk.
     *
     * matchLoad and realtimeScore can each be taken from a different socket
     * (see #owner), and the arena sends them back to back, so either can land
     * first. When the test match's load is second, #testLoaded is not set
     * yet and the guard above cannot see it. A pre-match frame with nothing
     * on the board, arriving while the loaded match's result is posted, is
     * the arena resetting for whatever it loads next, never a fact about the
     * result on screen, and the next load starts this match's ledger from
     * zero regardless.
     */
    const blank = ALLIANCES.every(side =>
      fuelOf(next[side]) + towerOf(next[side]) + next[side].foulsAgainst === 0);
    if (blank && msg.MatchState === MatchState.PreMatch && this.#bus.state.scorePostedAt !== null) {
      return;
    }

    // Synthesize the deltas Cheesy never sends.
    for (const side of ALLIANCES) {
      for (const [field, of] of [['fuel', fuelOf], ['tower', towerOf]] as const) {
        const amount = of(next[side]) - of(this.#last[side]);
        // Only positive deltas: a score correction downward is not a highlight,
        // and emitting it would drop a bogus replay marker.
        if (amount > 0) {
          this.#emit({ type: 'score.delta', payload: { alliance: side, field, amount } });
        }
      }
    }
    this.#last = next;

    const parts = (t: Totals, summary: ScoreSummary | undefined) => ({
      autoFuel: t.autoFuel, teleopFuel: t.teleopFuel,
      autoTower: t.autoTower, teleopTower: t.teleopTower,
      fouls: t.foulsAgainst,
      officialRp: bonusRp(summary),
    });
    this.#emit({
      type: 'score.realtime',
      payload: {
        red: parts(next.red, summaries.red),
        blue: parts(next.blue, summaries.blue),
      },
    });

    // Hub state, taken from the field rather than inferred. Cheesy reports a
    // per-alliance ActiveRemainingSec that is only non-zero while that
    // alliance's hub is live (Hub.GetActiveShiftTiming returns 0 when the
    // shift is inactive), so this is the authoritative answer and beats
    // guessing from the auto result.
    const redSec = msg.Red?.ActiveRemainingSec ?? 0;
    const blueSec = msg.Blue?.ActiveRemainingSec ?? 0;
    const state = msg.MatchState;
    const live = state === MatchState.AutoPeriod || state === MatchState.TeleopPeriod
      || state === MatchState.PausePeriod;

    // Track auto fuel while auto is running. Cheesy decides the auto winner on
    // AUTO FUEL ALONE (`redWonAuto = redAutoFuel > blueAutoFuel`), so a climb
    // worth 15 auto points does not win auto. Reporting the winner from total
    // score puts the wrong alliance on the hub indicator for the whole match.
    if (state === MatchState.AutoPeriod) {
      this.#autoFuel = {
        red: summaries.red?.AutoFuelPoints ?? 0,
        blue: summaries.blue?.AutoFuelPoints ?? 0,
      };
    } else if (!this.#autoWinnerSent && this.#started
               && (state === MatchState.PausePeriod || state === MatchState.TeleopPeriod)) {
      this.#autoWinnerSent = true;
      // Prefer the deciding frame's own numbers over the cache: a ball counted
      // after Cheesy's own period transition arrives stamped PausePeriod, so
      // the last frame stamped AutoPeriod can be missing the final auto fuel.
      // AutoFuelPoints is frozen after auto, so this is never older data.
      const red = summaries.red?.AutoFuelPoints ?? this.#autoFuel.red;
      const blue = summaries.blue?.AutoFuelPoints ?? this.#autoFuel.blue;
      // On a TIE Cheesy flips a coin (`redWonAuto = rand.Intn(2) == 1`), so
      // there is no answer to derive: report null and let the authoritative
      // per-alliance active state carry the hub indicator. This is why the
      // field's answer is mandatory rather than merely preferable: a local
      // guess is wrong half the time whenever auto ends level.
      this.#emit({
        type: 'hub.state',
        payload: { autoWinner: red > blue ? 'red' : blue > red ? 'blue' : null },
      });
    }

    if (live) {
      const active = redSec > 0 && blueSec > 0 ? 'both'
        : redSec > 0 ? 'red'
        : blueSec > 0 ? 'blue'
        : 'none';
      this.#emit({
        type: 'hub.state',
        payload: { active, activeRemainingSec: Math.max(redSec, blueSec) },
      });
    } else if (state !== undefined) {
      // Between matches there is no live hub; drop back to inference.
      this.#emit({ type: 'hub.state', payload: { active: null } });
    }

    for (const [side, cards] of [['red', msg.RedCards], ['blue', msg.BlueCards]] as const) {
      for (const [team, card] of Object.entries(cards ?? {})) {
        if (!card) continue;
        const key = `${side}:${team}:${card}`;
        if (this.#cardsSeen.has(key)) continue;
        this.#cardsSeen.add(key);
        this.#emit({ type: 'card.issued', payload: {
          alliance: side, team: Number(team), card,
          // The match name rides along so the reducer can phase the card
          // without needing a loaded match, which is what makes a boot-time
          // restore of card.issued events alone reconstruct byTeam.
          match: this.#loadedMatchName,
        } });
      }
    }

    /*
     * A PLAYOFF card is the alliance's. The referee panel records it as
     * PlayoffAllianceCard and empties the per-team map in the same breath
     * (web/referee_panel.go), so reading the map alone meant no playoff card
     * ever reached the desk: no mark on the bar, no chip on the Final screen,
     * nothing in the ledger the announcer reads, and a disqualified alliance
     * showing a zero with nothing beside it.
     *
     * Every member gets it, the ones sitting the match out included, because
     * the card follows the alliance. Deduped like the per-team cards, keyed
     * on the colour, so an upgrade to red is still announced once.
     */
    for (const [side, card] of [
      ['red', msg.PlayoffRedAllianceCard], ['blue', msg.PlayoffBlueAllianceCard],
    ] as const) {
      if (card !== 'yellow' && card !== 'red') continue;
      const key = `${side}:alliance:${card}`;
      if (this.#cardsSeen.has(key)) continue;
      this.#cardsSeen.add(key);
      for (const team of this.#allianceTeams[side]) {
        this.#emit({ type: 'card.issued', payload: {
          alliance: side, team, card, match: this.#loadedMatchName,
        } });
      }
    }
  }

  #onScorePosted(msg: ScorePostedMessage): void {
    // Cheesy replays every notifier to a display the moment it (re)subscribes,
    // which is how its own audience screen survives a refresh mid-reveal. Every
    // other handler here already accounts for that: matchLoad checks the id,
    // realtimeScore diffs, cards dedupe. This one did not, so a socket blip
    // during match 43 re-delivered match 42's posted score, cut the program to
    // the score screen mid-match, and let the auto-queue claim 43's label with
    // a clip that ended mid-match, after which the real post-match queue was
    // dropped as a duplicate and that match was never uploaded at all.
    //
    // Gate on identity, not on content: a desk restarted mid-event has nothing
    // to compare content against, so the first replay would pass anyway. A
    // genuine re-commit for the loaded match still gets through, which is what
    // a scorekeeper correction needs. When either id is unknown (an older arena
    // build, or a boot where scorePosted lands before matchLoad) behaviour is
    // unchanged.
    //
    // A committed TEST match is never a result. The arena fires this notifier
    // for one regardless, and the identity check below cannot catch it when
    // nothing real has been loaded yet: Friday's field checkout, before the
    // first practice match, would have revealed a test score on program and
    // queued it for upload. Judged on the posted match's own type rather
    // than on #testLoaded, because the last qual's genuine result is posted
    // a moment BEFORE the arena loads its test match, and a socket running a
    // little behind could otherwise deliver the two the other way round and
    // lose the end of quals.
    if (matchKind(msg.Match?.Type) === 'test') {
      console.log('[cheesy] ignoring a posted score for the test match: it is not a result.');
      return;
    }
    //
    // A desk that boots while the arena sits on its test match has no real
    // id to compare with, but it does know what is loaded: nothing that can
    // have been committed. Whatever scorePosted the arena replays then is an
    // older result (last night's final practice match, on a Saturday
    // morning), and revealing it cut program to a score screen for a match
    // the desk had never seen.
    const posted = msg.Match?.Id === undefined ? null : String(msg.Match.Id);
    const stale = posted !== null && (this.#loadedMatchId !== null
      ? posted !== this.#loadedMatchId
      : this.#testLoaded);
    if (stale) {
      console.warn(`[cheesy] ignoring a posted score for match ${posted} while ` +
        `${this.#loadedMatchId ?? 'the test match'} is loaded: this is the arena ` +
        'replaying its last result to a reconnecting display, not a new result.');
      return;
    }
    /*
     * The same result again, once the arena has moved OFF the match it
     * belongs to: its test match after the last qual or the last final, or
     * the next match the desk is holding back. The identity check above
     * passes it, because the desk still shows that match. But the arena can
     * only commit the match it has loaded, so this is not a correction: it is
     * the replay every reconnecting display is sent. Let through, it put the
     * last qual's Final screen over the alliance selection board, cut the
     * stream to the score scene, brought the playlist back and restarted the
     * gap cue's clock.
     *
     * The first post for the match still passes, in either order with the
     * test load: the last qual's genuine result can trail the test match onto
     * the desk by a socket.
     */
    if (posted !== null && posted === this.#postedId && posted === this.#loadedMatchId
        && (this.#testLoaded || this.#held !== null)) {
      console.log(`[cheesy] ignoring a repeat of match ${posted}'s posted score: the arena ` +
        'has moved on from it, so this is a reconnecting display being sent it again.');
      return;
    }
    this.#emit({
      type: 'match.score_posted',
      payload: {
        red: {
          score: msg.RedScoreSummary?.Score ?? 0,
          rp: msg.RedRankingPoints ?? 0,
          // The committed bonuses, which can differ from the last realtime
          // frame: a referee adjustment on the review page lands in the
          // commit and never in a realtime snapshot, and a G206 added there
          // strips all three.
          officialRp: bonusRp(msg.RedScoreSummary),
        },
        blue: {
          score: msg.BlueScoreSummary?.Score ?? 0,
          rp: msg.BlueRankingPoints ?? 0,
          officialRp: bonusRp(msg.BlueScoreSummary),
        },
        /*
         * The arena's own verdict, which the desk used to work out by
         * comparing the two totals. In a playoff that is wrong twice over.
         *
         * Every double elimination match is created with useTiebreakCriteria,
         * so a level score is resolved on major fouls, then auto fuel, then
         * tower points, and the bracket advances the winner. And
         * CorrectPlayoffScore sets PlayoffDq from a red card WITHOUT touching
         * Score, so a disqualified alliance can hold the higher number.
         *
         * Either way the desk printed TIE on the audience screen, or WINNER
         * under the alliance that had just been disqualified, while the
         * announcer and the bracket said otherwise.
         */
        winner: msg.RedWon === true ? 'red'
          : msg.BlueWon === true ? 'blue'
            : (msg.RedWon === false && msg.BlueWon === false) ? 'tie' : null,
        // "TIEBREAK: AUTO FUEL", "TRUE TIE". Exactly what the hall wants to
        // know, and the arena writes it for us.
        tiebreak: (msg.TiebreakReason ?? '').trim() || null,
      },
    });
    // The result is up for the loaded match. The arena has already loaded
    // (or is about to load) the next one; see #held.
    this.#postedId = this.#loadedMatchId;
    this.#postedAt = Date.now();
    this.#endedUnposted = false;
    // A next match that beat this score onto the desk was only waiting
    // POST_RACE_MS for it. Now it waits behind the result, counted from here.
    if (this.#held) this.#holdFor(POSTED_HOLD_MS);

    /*
     * What the field committed, as the schedule poll will next see it.
     *
     * #noticeCorrections reports a committed score that changed since the
     * last poll, which is how a /match_review edit (it fires no notifier) is
     * caught. A scorekeeper REPLAY changes the committed score too, and does
     * fire this one, so without recording it here the next poll called the
     * replay a post-commit correction, and the publish queue told the
     * operator to hand-edit the description of the run it had just told
     * them to pull.
     */
    const name = (msg.Match?.LongName ?? '').trim() || this.#loadedMatchName.trim();
    const red = msg.RedScoreSummary?.Score;
    const blue = msg.BlueScoreSummary?.Score;
    if (name && typeof red === 'number' && typeof blue === 'number') {
      this.#committed.set(name, `${red}:${blue}`);
    }

    // Standings and the remaining schedule both just changed. Pull them now
    // instead of showing stale rankings until the next 60s tick.
    this.#refreshSoon();
  }

  // ---- field health -------------------------------------------------------

  /**
   * The safety net under #testLoaded: a real match must never be silenced
   * because the desk missed the load that ended a test.
   *
   * A real matchLoad is what ends a test, and a matchLoad CAN be missed: each
   * arena-side listener is a five-deep channel with a non-blocking send, and
   * the owning socket's copy is the only one taken. Missing a load has
   * always meant the desk showing the previous match; after a test it would
   * have meant much worse, the whole of the waiting match going unannounced,
   * its clock dead and its posted score never reaching the publish queue.
   *
   * arenaStatus carries the loaded match's id twice a second, and the test
   * match is id 0. A real id while a test is believed loaded is the arena
   * saying it has moved on. But only once this socket has itself reported
   * id 0 since the test load: arenaStatus travels on a different socket
   * from matchLoad, so a frame generated just BEFORE the test was loaded can
   * arrive just after, and must not end the test it predates. Frames on one
   * socket stay in order, so after a 0 any real id is genuinely newer.
   *
   * Only ever clears. An arena build that sends no MatchId, or always 0,
   * leaves this inert rather than suppressing real matches.
   */
  #checkTestStillLoaded(matchId: number | undefined): void {
    if (!this.#testLoaded || typeof matchId !== 'number') return;
    if (matchId === 0) { this.#testSeenOnStatus = true; return; }
    if (matchId > 0 && this.#testSeenOnStatus) {
      console.warn(`[cheesy] the field has match ${matchId} loaded but the desk never ` +
        'saw it load after the test match: resuming match events against the match on screen.');
      this.#testLoaded = false;
    }
  }

  #onArenaStatus(msg: ArenaStatusMessage): void {
    this.#checkTestStillLoaded(msg.MatchId);
    // A running field with the next match still held: load it now, on
    // whichever socket said so first. See #held.
    if (this.#held && running(msg.MatchState)) this.#releaseHeld();
    // "What happened to 846?" is the replay marker nobody thinks to hit,
    // because it happens while everyone is watching the other end of the field.
    const down: number[] = [];
    const linkedNow = new Set<number>();
    let fielded = 0;
    let linked = 0;
    for (const station of Object.values(msg.AllianceStations ?? {})) {
      const team = station?.Team?.Id;
      if (!team || station?.Bypass) continue;
      fielded++;
      // Readiness needs a positive link: a station with no DS data yet is
      // not linked, it is unknown. "Down" stays explicit-false only, so the
      // dropped-robot marker never fires off missing data.
      if (station?.DsConn?.RobotLinked === true) { linked++; linkedNow.add(team); }
      if (station?.DsConn && station.DsConn.RobotLinked === false) down.push(team);
    }

    // `down` is level state for the station-health strip and repeats on every
    // frame. The replay marker needs the EDGE: Cheesy re-sends arenaStatus
    // continuously, so marking every frame flooded the timeline with
    // duplicates for one dropped robot, and the pre-match link-up (robots
    // connecting one by one) minted a bogus "lost comms" for every robot
    // before every match. A team is newly down only if the previous frame saw
    // it linked, and only while the match is actually running: a DS
    // disconnecting during post-match teardown is normal, not a highlight.
    const newlyDown = this.#started
      ? down.filter(team => this.#prevLinked.has(team))
      : [];
    this.#prevLinked = linkedNow;

    this.#emit({
      type: 'arena.status',
      payload: {
        cheesy: true,
        down,
        newlyDown,
        plcHealthy: msg.PlcIsHealthy ?? null,
        fieldEStop: msg.FieldEStop ?? false,
        ftaReady: msg.IsFtaReady ?? null,
      },
    });

    // The field going ready IS the pre-countdown moment: every non-bypassed
    // robot linked, scorekeeper about to hand it to the announcer. Emitting
    // `match.armed` here flips program to the score bar BEFORE anyone says
    // "3, 2, 1". The graphic must never change mid-countdown. Latched so a
    // robot dropping and relinking doesn't re-fire it.
    //
    // Never for a test match: every robot linking for the FTA's checkout
    // would flip program to the score bar of the real match still waiting,
    // long before anybody counts that match down.
    //
    // Nor while the next match is held behind a posted result: the robots
    // linking then are the NEXT match's, and the match the desk would arm is
    // the one that just finished, its score bar over its own result. Robots
    // can stay linked straight through a commit (a final's alliances play
    // again from the same stations), so linking is not the arena moving on;
    // the release is, and the next frame after it arms the right match.
    const state = msg.MatchState ?? this.#matchState;
    if (this.#matchLoaded && !this.#testLoaded && !this.#held && !this.#armedSent && !this.#started
        && state === MatchState.PreMatch
        && fielded > 0 && linked === fielded
        && !(msg.FieldEStop ?? false)) {
      this.#armedSent = true;
      this.#emit({ type: 'match.armed' });
    }
  }
}
