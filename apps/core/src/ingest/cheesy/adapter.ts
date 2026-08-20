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
import type {
  Alliance, AllianceSelection, MatchInfo, RankingRow, Team, UpcomingMatch,
} from '../../types.ts';
import { CheesyClient, type CheesyClientOpts } from './client.ts';
import {
  MatchState, MatchStatus,
  type AllianceSelectionMessage,
  type ArenaStatusMessage, type MatchLoadMessage, type MatchTimeMessage,
  type MatchWithResult, type RankingsResponse,
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
      name: r.Nickname ?? '',
      rankingPoints: r.RankingPoints ?? 0,
      record: `${r.Wins ?? 0}-${r.Losses ?? 0}-${r.Ties ?? 0}`,
      played: r.Played ?? 0,
    })),
  };
}

// 8, not 4: the venue side screens show four, but the phone-facing per-team
// schedule view needs a longer horizon to answer "when do WE play next".
export function mapUpcoming(matches: MatchWithResult[], limit = 8): UpcomingMatch[] {
  return matches
    // Anything past "scheduled" has been played, so it isn't on deck.
    .filter(m => (m.Match?.Status ?? MatchStatus.Scheduled) === MatchStatus.Scheduled)
    .slice(0, limit)
    .map(m => ({
      name: m.Match?.LongName ?? m.Match?.ShortName ?? '',
      shortName: m.Match?.ShortName ?? '',
      time: m.Match?.Time ?? null,
      red: [m.Match?.Red1, m.Match?.Red2, m.Match?.Red3].filter((n): n is number => !!n),
      blue: [m.Match?.Blue1, m.Match?.Blue2, m.Match?.Blue3].filter((n): n is number => !!n),
    }));
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
      teams: (a.TeamIds ?? []).filter((n): n is number => typeof n === 'number' && n > 0),
    })),
    ranked: (msg.RankedTeams ?? [])
      .filter(r => (r.TeamId ?? 0) > 0)
      .map(r => ({ rank: r.Rank ?? 0, team: r.TeamId!, picked: r.Picked === true })),
    showTimer: msg.ShowTimer === true,
    timeRemainingSec: Math.max(0, msg.TimeRemainingSec ?? 0),
    updatedAt: Date.now(),
  };
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
  /** Latched per match: armed fires once, when the field first goes ready. */
  #armedSent = false;
  /** Id of the last loaded match, to tell a reconnect replay from a fresh load. */
  #loadedMatchId: string | null = null;
  /**
   * Cards already announced. The realtime score message carries the whole
   * card map on every frame, so without this one yellow card would re-emit
   * (and re-mark for replay) on every score change for the rest of the match.
   * Keyed alliance:team:card so an upgrade to red still gets announced.
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
  /** When Nexus last delivered a queue, so the schedule poll can defer to it. */
  #nexusQueueAt = 0;

  constructor(opts: CheesyAdapterOpts) {
    this.#bus = opts.bus;
    this.#client = new CheesyClient({
      host: opts.host,
      displayId: opts.displayId,
      onEvent: (notifier, data) => this.ingest(notifier, data),
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
  }

  get client(): CheesyClient { return this.#client; }

  start(): void {
    // Watch for the queuers' source so the schedule poll knows when to yield.
    this.#bus.subscribe(ev => {
      if (ev.type === 'queue.updated' && ev.source === 'nexus') this.#nexusQueueAt = ev.ts;
    });
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
  async #poll(): Promise<void> {
    if (this.#polling) { this.#refreshSoon(); return; }
    this.#polling = true;
    try {
      try {
        const res = await this.#client.get<RankingsResponse>('/api/rankings');
        this.#emit({ type: 'rankings.updated', payload: mapRankings(res) });
      } catch (err) {
        console.warn('[cheesy] rankings poll failed:', (err as Error).message);
      }

      try {
        const qual = await this.#client.get<MatchWithResult[]>('/api/matches/qualification');
        // Playoff matches live under their own type. Polling qualification
        // alone emptied the Sunday on-deck queue: once the last qual match is
        // played, nothing in that list is Scheduled any more. Sequential, to
        // hold the one-concurrent-request budget.
        let playoff: MatchWithResult[] = [];
        try {
          playoff = await this.#client.get<MatchWithResult[]>('/api/matches/playoff');
        } catch {
          // No bracket yet. Quals alone is still a correct queue.
        }
        // Nexus arbitration: when the queuers' live estimates are flowing,
        // this poll stays quiet. Both sources write state.upcoming wholesale,
        // and alternating them put the printed schedule and the live estimate
        // on the side screens in turns, disagreeing with themselves once a
        // minute. Two sources disagreeing on air is worse than one being
        // absent; Cheesy is the fallback, and 90s (four missed Nexus polls)
        // is how long it waits before deciding the fallback is needed.
        if (Date.now() - this.#nexusQueueAt > 90_000) {
          this.#emit({ type: 'queue.updated', payload: { upcoming: mapUpcoming([...qual, ...playoff]) } });
        }
      } catch (err) {
        console.warn('[cheesy] schedule poll failed:', (err as Error).message);
      }
    } finally {
      this.#polling = false;
    }
  }

  #emit(init: EmitInit): void {
    this.#bus.emit({ confidence: 'authoritative', source: 'cheesy', ...init });
  }

  /**
   * Feed one Cheesy Arena notifier in. Public because the websocket is not the
   * only thing that drives it: a recorded capture can be replayed through the
   * same path to rehearse the whole pipeline without a field.
   */
  ingest(notifier: string, data: unknown): void {
    switch (notifier) {
      case 'matchLoad': return this.#onMatchLoad(data as MatchLoadMessage);
      case 'matchTime': return this.#onMatchTime(data as MatchTimeMessage);
      case 'realtimeScore': return this.#onRealtimeScore(data as RealtimeScoreMessage);
      case 'scorePosted': return this.#onScorePosted(data as ScorePostedMessage);
      case 'arenaStatus': return this.#onArenaStatus(data as ArenaStatusMessage);
      case 'allianceSelection':
        return this.#emit({
          type: 'alliance_selection.update',
          payload: mapSelection(data as AllianceSelectionMessage),
        });
      default: return;   // lowerThird, playSound, etc.; the desk owns those
    }
  }

  // ---- match lifecycle ----------------------------------------------------

  #onMatchLoad(msg: MatchLoadMessage): void {
    const m = msg.Match ?? {};
    const teamAt = (key: string, fallback: number | undefined): Team | null => {
      const t = msg.Teams?.[key];
      const number = t?.Id ?? fallback;
      if (!number) return null;
      return {
        number,
        name: t?.Nickname ?? t?.Name ?? '',
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
    };

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
    const inProgress = this.#matchState === MatchState.StartMatch
      || this.#matchState === MatchState.AutoPeriod
      || this.#matchState === MatchState.PausePeriod
      || this.#matchState === MatchState.TeleopPeriod
      || this.#matchState === MatchState.PostMatch;
    if (inProgress && match.id === this.#loadedMatchId) return;
    // The OTHER reconnect window: the field sits in PreMatch for minutes
    // after a score posts, and a socket blip there replays the finished
    // match's matchLoad. Running the reset wiped the just-posted score off
    // air, flipped program back to the dead match's overview, and nulled the
    // timestamps the gap cue and the publish cut key off. Same match id, no
    // replay flag, score still on the board: that is a reconnect echo, not a
    // scorekeeper re-run. A GENUINE re-run of the same match arrives with
    // IsReplay set (or after the score has been cleared) and still resets.
    if (match.id === this.#loadedMatchId && !msg.IsReplay
        && this.#bus.state.scorePostedAt !== null) {
      return;
    }

    this.#last = { red: zero(), blue: zero() };
    this.#started = false;
    this.#autoFuel = { red: 0, blue: 0 };
    this.#autoWinnerSent = false;
    this.#matchLoaded = true;
    this.#armedSent = false;
    this.#loadedMatchId = match.id;
    this.#loadedMatchName = match.displayName ?? '';
    this.#cardsSeen.clear();
    this.#emit({ type: 'match.loaded', payload: match });
  }

  /**
   * Cheesy sends matchTime continuously. We only care about the transitions:
   * the desk derives its own clock from match.start, so a dropped frame or a
   * network hiccup can't make the countdown stutter.
   */
  #onMatchTime(msg: MatchTimeMessage): void {
    const state = msg.MatchState ?? MatchState.PreMatch;
    if (state === this.#matchState) return;
    const previous = this.#matchState;
    this.#matchState = state;

    switch (state) {
      case MatchState.StartMatch:
      case MatchState.AutoPeriod:
        if (!this.#started) { this.#started = true; this.#emit({ type: 'match.start' }); }
        break;
      case MatchState.PostMatch:
        // Only a real match end (coming back from a timeout isn't one).
        if (previous === MatchState.TeleopPeriod || previous === MatchState.AutoPeriod
            || previous === MatchState.PausePeriod) {
          this.#emit({ type: 'match.end' });
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
        if (previous === MatchState.PausePeriod || previous === MatchState.AutoPeriod) {
          this.#emit({ type: 'match.teleop_start' });
        }
        break;
      case MatchState.TimeoutActive:
        this.#emit({ type: 'break.started', payload: { kind: 'timeout' } });
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
    const summaries: Record<Alliance, ScoreSummary | undefined> = {
      red: msg.Red?.ScoreSummary,
      blue: msg.Blue?.ScoreSummary,
    };

    const next: Record<Alliance, Totals> = {
      red: this.#totals(summaries.red, summaries.blue),
      blue: this.#totals(summaries.blue, summaries.red),
    };

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

    const parts = (t: Totals) => ({
      autoFuel: t.autoFuel, teleopFuel: t.teleopFuel,
      autoTower: t.autoTower, teleopTower: t.teleopTower,
      fouls: t.foulsAgainst,
    });
    this.#emit({
      type: 'score.realtime',
      payload: { red: parts(next.red), blue: parts(next.blue) },
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
    const posted = msg.Match?.Id === undefined ? null : String(msg.Match.Id);
    if (posted !== null && this.#loadedMatchId !== null && posted !== this.#loadedMatchId) {
      console.warn(`[cheesy] ignoring a posted score for match ${posted} while ` +
        `${this.#loadedMatchId} is loaded: this is the arena replaying its last ` +
        'result to a reconnecting display, not a new result.');
      return;
    }
    this.#emit({
      type: 'match.score_posted',
      payload: {
        red: { score: msg.RedScoreSummary?.Score ?? 0, rp: msg.RedRankingPoints ?? 0 },
        blue: { score: msg.BlueScoreSummary?.Score ?? 0, rp: msg.BlueRankingPoints ?? 0 },
      },
    });
    // Standings and the remaining schedule both just changed. Pull them now
    // instead of showing stale rankings until the next 60s tick.
    this.#refreshSoon();
  }

  // ---- field health -------------------------------------------------------

  #onArenaStatus(msg: ArenaStatusMessage): void {
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
      if (station?.Ds?.RobotLinked === true) { linked++; linkedNow.add(team); }
      if (station?.Ds && station.Ds.RobotLinked === false) down.push(team);
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
    const state = msg.MatchState ?? this.#matchState;
    if (this.#matchLoaded && !this.#armedSent && !this.#started
        && state === MatchState.PreMatch
        && fielded > 0 && linked === fielded
        && !(msg.FieldEStop ?? false)) {
      this.#armedSent = true;
      this.#emit({ type: 'match.armed' });
    }
  }
}
