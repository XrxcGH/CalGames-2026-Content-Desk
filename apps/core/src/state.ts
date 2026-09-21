/**
 * Snapshot reducer. Pure: (state, event) -> state.
 *
 * Pure matters here: it's what lets us replay an NDJSON log from Friday's
 * practice matches and get byte-identical state, which is how graphics get
 * built and tested in March with no field.
 */

import { clockDisplay, clockFrom, hubActiveAt, isLockdown, phaseAt } from './clock.ts';
import { phaseOf } from './types.ts';
import {
  emptyAllianceScore, REBUILT,
  type Alliance, type AllianceScore, type CardCall, type Confidence,
  type DeskEvent, type DeskState,
  type PanelState,
  type RpThresholds,
  type StatusCard,
} from './types.ts';

/** The card kinds every surface has a colour scheme and a label for. */
const STATUS_KINDS: readonly StatusCard['kind'][] =
  ['delay', 'review', 'fault', 'replay', 'custom'];

/** Sums, totals, and bonus RPs are always derived, never trusted from the
 *  wire. The auto/teleop parts are the source of truth; fuel and tower are
 *  their sums. */
function settle(s: AllianceScore, opponentFouls: number, t: RpThresholds): AllianceScore {
  const fuel = s.autoFuel + s.teleopFuel;
  const tower = s.autoTower + s.teleopTower;
  return {
    ...s,
    fuel,
    tower,
    // The field's figure wins when there is one. Everything else here is
    // derived and may be recomputed freely; this one was adopted.
    total: s.officialTotal ?? fuel + tower + opponentFouls,
    // The field's answer when there is one. Cheesy scores the fuel bonuses on
    // a COUNT of fuel and applies a G206 strip and a disable-at-zero rule the
    // desk cannot see, so its booleans are not a second opinion, they are the
    // question the desk is trying to approximate. See officialRp.
    //
    // Otherwise derived, against the LIVE thresholds rather than the defaults
    // in REBUILT: an off-season event can move these, and a badge that lights
    // at a number nobody is playing to is worse than no badge. A traversal
    // threshold of zero means the bonus is off, not that everyone has it.
    rp: s.officialRp ?? {
      energized: fuel >= t.energizedFuel,
      supercharged: fuel >= t.superchargedFuel,
      traversal: t.traversalTower > 0 && tower >= t.traversalTower,
    },
  };
}

function withScore(state: DeskState, side: Alliance, patch: Partial<AllianceScore>): DeskState {
  const other: Alliance = side === 'red' ? 'blue' : 'red';
  const merged = { ...state.score[side], ...patch };
  return {
    ...state,
    score: {
      [side]: settle(merged, state.score[other].fouls, state.thresholds),
      [other]: settle(state.score[other], merged.fouls, state.thresholds),
    } as Record<Alliance, AllianceScore>,
  };
}

/** Re-score both alliances, for when the thresholds themselves change. */
function rescore(state: DeskState): DeskState {
  /*
   * A committed match is history, not a live score.
   *
   * Thresholds arrive from config at boot and can be corrected at /s/setup
   * mid-event. Re-scoring the live match immediately is right: a badge that
   * lights at a number nobody is playing to is worse than no badge. Doing it
   * to a match the field has already posted is not: those RPs were earned
   * against the numbers in force when it was played, and the correction would
   * relight or extinguish badges on the Final screen while the score review
   * is still up.
   */
  if (state.scorePostedAt !== null) return state;
  return {
    ...state,
    score: {
      red: settle(state.score.red, state.score.blue.fouls, state.thresholds),
      blue: settle(state.score.blue, state.score.red.fouls, state.thresholds),
    },
  };
}

/** Recompute everything that follows from the clock. */
function retime(state: DeskState, now: number): DeskState {
  const c = clockFrom(state.matchStartedAt, now);
  // A null clock is ambiguous: before the first match it means pre-match, but
  // after the buzzer (match.end clears matchStartedAt to stop the clock) it
  // means the match is OVER. Showing "Pre-match 0:20" over a finished match
  // confused everyone; matchEndedAt is the tiebreaker, and match.loaded
  // clears it for the next cycle.
  const ended = c === null && state.matchEndedAt !== null;
  return {
    ...state,
    matchClock: c,
    phase: ended ? 'post' : phaseAt(c),
    clockDisplay: ended ? '0:00' : clockDisplay(c),
    // The field's own answer wins; inference is the desk-only fallback.
    hubActive: state.hubAuthoritative ?? (ended ? 'none' : hubActiveAt(c, state.autoWinner)),
    lockdown: isLockdown(c),
  };
}

/**
 * Apply an automatic screen change, unless an operator is holding the screen.
 * Every other part of the event still lands; only the screen is left alone.
 */
const auto = (state: DeskState, screen: string): string =>
  state.screenHold ? state.screen : screen;

/** The five numbers that make up a breakdown. A snapshot missing any of them
 *  is a patch, not a replacement, and cannot restore authority. */
const BREAKDOWN = ['autoFuel', 'teleopFuel', 'autoTower', 'teleopTower', 'fouls'] as const;

const RANK: Record<Confidence, number> = { estimated: 0, derived: 1, authoritative: 2 };

/** The less confident of two, so a partial update can lower but never raise. */
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

export function reduce(state: DeskState, ev: DeskEvent): DeskState {
  const next = ((): DeskState => {
    switch (ev.type) {
      case 'match.loaded': {
        const p = ev.payload as DeskState['match'];
        /*
         * A hold on the Final screen is a hold on a RESULT, and the result has
         * just been replaced by a match nobody has played.
         *
         * Every other screen a producer holds still means something when the
         * next match loads: the arcade bumper, a sponsor, the explainer. The
         * Final screen does not. The score resets to zero in this same case,
         * so the held screen repainted itself as a 0-0 tie, with both
         * alliances' new team numbers under it, and sat there on program and
         * every venue TV looking like a played match that ended level.
         *
         * Released rather than repainted, the same way clearing an award or a
         * slide releases a hold on those screens a few cases below: the thing
         * being held no longer exists, so the hold cannot.
         */
        const heldOnAResult = state.screenHold && state.screen === 'score';
        return {
          ...state,
          match: p,
          // Which run of this match is about to be played. The arena replays a
          // committed match under the same id, and the publish queue has to
          // tell that run from the one it threw away.
          matchRun: Math.max(1, Number((ev.payload as { run?: number })?.run ?? 1)),
          matchStartedAt: null,
          lastMatchStartedAt: null,
          matchLoadedAt: ev.ts,
          matchEndedAt: null,
          scorePostedAt: null,
          autoWinner: null,
          autoWinnerKnown: false,
          hubAuthoritative: null,
          score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
          confidence: ev.confidence,
          totalConfidence: ev.confidence,
          // Per-match card state resets; the per-team totals survive WITHIN
          // the phase (a yellow from Q12 is still live in Q40) and drop at a
          // phase boundary (that same yellow must not mark the team's
          // playoff graphic; manual S6.6, same rule the ledger applies).
          cards: {
            byTeam: Object.fromEntries(Object.entries(state.cards.byTeam)
              .filter(([, c]) => c.phase === phaseOf(p?.displayName ?? ''))),
            thisMatch: [],
            // Survives the load, because the field re-sends a standing card
            // after a replay and it must not be counted again. Dropped at a
            // phase boundary with byTeam, since no card crosses one.
            seen: state.cards.seen.filter(k =>
              phaseOf(k.slice(0, k.indexOf('|'))) === phaseOf(p?.displayName ?? '')),
          },
          cardCall: null,
          // Still validated rather than trusted: the payload arrives off a
          // socket, and a bad entry here puts an "S" on the wrong team.
          surrogates: (p?.surrogates ?? [])
            .map(Number).filter(n => Number.isInteger(n) && n > 0),
          screen: heldOnAResult ? 'overview' : auto(state, 'overview'),
          ...(heldOnAResult ? { screenHold: false } : {}),
        };
      }

      case 'match.preview':
        return { ...state, screen: auto(state, 'overview') };

      // Field reset between matches. Deliberately no screen change: the next
      // match's `match.loaded` owns the transition back to the overview.
      // Prestart is also how a timeout visibly ends (TimeoutActive returns
      // through PreMatch), so it retires the automatic timeout card. Only
      // that one: an operator card carries the producer's wording and stays
      // until they clear it themselves.
      case 'match.prestart':
        return state.status?.message === 'Field timeout'
          ? { ...state, status: null }
          : state;

      // The field is armed and ready: every robot linked, scorekeeper about to
      // hand it to the announcer. Flip to the score bar NOW, so the graphic is
      // already in place when the countdown starts, never mid-"3, 2, 1".
      case 'match.armed':
        return { ...state, screen: auto(state, 'match') };

      case 'match.start':
        return {
          ...state, matchStartedAt: ev.ts, lastMatchStartedAt: ev.ts,
          // A running field-setup countdown is over by definition: the match
          // it was counting down to just started, whoever forgot to clear it.
          timer: null,
          screen: auto(state, 'match'),
        };

      case 'match.auto_end': {
        // HEURISTIC, and only used when running desk-only. Cheesy Arena decides
        // the auto winner on AUTO FUEL ALONE (`redWonAuto = redAutoFuel >
        // blueAutoFuel`), tower climbs do not count, so an alliance can score
        // 15 auto points from a climb and still lose auto. We don't track auto
        // fuel separately here, so this compares totals and can disagree.
        //
        // When the Cheesy bridge is up the adapter emits the real answer via
        // `hub.state`, and `hubAuthoritative` overrides all of this anyway.
        if (state.autoWinnerKnown) return state;        // never override the field
        const { red, blue } = state.score;
        const winner: Alliance | null =
          red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : null;
        return { ...state, autoWinner: winner };
      }

      // Cheesy Arena pauses between auto and teleop, and the pause length is
      // not fixed, so a clock anchored only at match.start ran ahead of the
      // field for the whole teleop: shifts, endgame, and the synthesized
      // buzzer all fired early by the pause length, and the field's real
      // match.end then landed as a duplicate. The field bridge emits this at
      // the teleop transition; re-anchoring puts matchClock at exactly 0
      // there, on the field's own axis. lastMatchStartedAt keeps the true
      // wall-clock start for clip cutting. Desk-only operation never sees
      // this event and the clock simply stays contiguous.
      case 'match.teleop_start':
        return state.matchStartedAt === null ? state
          : { ...state, matchStartedAt: ev.ts + REBUILT.AUTO_START * 1000 };

      case 'match.aborted':
        return { ...state, matchStartedAt: null, screen: auto(state, 'match') };

      // Clearing matchStartedAt is what stops the clock; matchEndedAt
      // disambiguates the post-match display. The clip cutter still maps the
      // match onto wall clock via lastMatchStartedAt, set at match.start.
      case 'match.end':
        return { ...state, matchEndedAt: ev.ts, matchStartedAt: null };

      /**
       * The reveal, and (from the field) the official totals.
       *
       * This case used to take ev.confidence and no numbers at all, which was
       * wrong twice over. It threw away the one authoritative figure in the
       * whole event (Cheesy sends RedScoreSummary.Score here), and it stamped
       * the state authoritative anyway, so a match the desk had shadow-scored
       * revealed its guesses as an official result on the screen everybody
       * screenshots.
       *
       * Now the totals are adopted when they are sent, and adopting them is
       * the only thing that promotes totalConfidence. The BREAKDOWN keeps
       * whatever confidence it earned: an official total does not make the
       * period splits under it any less typed-in.
       */
      case 'match.score_posted': {
        const p = (ev.payload ?? {}) as Partial<Record<Alliance, {
          score?: unknown; officialRp?: AllianceScore['officialRp'];
        }>>;
        let s: DeskState = { ...state, scorePostedAt: ev.ts, screen: auto(state, 'score') };
        let official = false;
        for (const side of ['red', 'blue'] as Alliance[]) {
          // The committed bonuses, which are not always the last realtime
          // frame's: a referee adjustment on the review page lands in the
          // commit only, and a G206 added there strips all three at once.
          const rp = p[side]?.officialRp;
          if (rp) {
            s = withScore(s, side, { officialRp: rp });
          }
          const total = Number(p[side]?.score);
          if (!Number.isFinite(total)) continue;
          official = true;
          // Recorded as adopted, not just written. See AllianceScore.officialTotal:
          // written onto `total` alone it survived only until the next settle().
          s = { ...s, score: { ...s.score,
            [side]: { ...s.score[side], total, officialTotal: total } } };
        }
        return official ? { ...s, totalConfidence: ev.confidence } : s;
      }

      /**
       * A COMPLETE snapshot restores authority. A partial one cannot.
       *
       * The old comment here asserted "it replaces every number" and the code
       * took ev.confidence unconditionally, but the payload type is Partial
       * twice over and withScore MERGES. A patch carrying one alliance's
       * teleopFuel therefore stamped the whole state authoritative while a
       * shadow-scored autoFuel sat untouched inside it, rendering solid.
       *
       * So completeness is checked rather than assumed: both alliances, every
       * breakdown field. Anything less can lower confidence but never raise
       * it, which is the same rule score.delta has always followed.
       */
      case 'score.realtime': {
        const p = ev.payload as Partial<Record<Alliance, Partial<AllianceScore>>>;
        let s = state;
        if (p.red) s = withScore(s, 'red', p.red);
        if (p.blue) s = withScore(s, 'blue', p.blue);
        const complete = (['red', 'blue'] as Alliance[]).every(side => {
          const patch = p[side];
          return !!patch && BREAKDOWN.every(f => typeof patch[f] === 'number');
        });
        return {
          ...s,
          confidence: complete ? ev.confidence : weaker(state.confidence, ev.confidence),
          totalConfidence: complete
            ? ev.confidence
            : weaker(state.totalConfidence, ev.confidence),
        };
      }

      // A delta cannot. Once a shadow-scored guess is folded into the total,
      // the total contains a guess, and it stays `estimated` until an
      // authoritative snapshot overwrites the whole thing. This is what makes
      // the outlined-numeral treatment on air honest rather than decorative.
      case 'score.delta': {
        const p = ev.payload as { alliance: Alliance; field: 'fuel' | 'tower' | 'fouls'; amount: number };
        const cur = state.score[p.alliance];
        // Attribute the delta to a period by the clock AT THE EVENT'S OWN
        // TIME: state.matchClock is only retimed after each event lands, so
        // reading it here would use the previous event's clock. A shadow-scored
        // "+5 fuel" during auto is auto fuel; the breakdown stays honest even
        // when the whole match is typed by hand.
        const at = clockFrom(state.matchStartedAt, ev.ts);
        const inAuto = at !== null && at < 0;
        const part = p.field === 'fouls' ? 'fouls' as const
          : p.field === 'fuel' ? (inAuto ? 'autoFuel' as const : 'teleopFuel' as const)
          : (inAuto ? 'autoTower' as const : 'teleopTower' as const);
        const scored = withScore(state, p.alliance, { [part]: cur[part] + p.amount });
        // A delta lands in the breakdown AND is summed into the total, so an
        // estimated one taints both. Nothing here can raise either.
        return ev.confidence === 'estimated'
          ? { ...scored, confidence: 'estimated', totalConfidence: 'estimated' }
          : scored;
      }

      case 'hub.state': {
        const p = ev.payload as {
          autoWinner?: Alliance | null;
          active?: Alliance | 'both' | 'none' | null;
        };
        return {
          ...state,
          ...(p.autoWinner !== undefined
            ? { autoWinner: p.autoWinner, autoWinnerKnown: true }
            : {}),
          ...(p.active !== undefined ? { hubAuthoritative: p.active } : {}),
        };
      }

      case 'lower_third.show':
        return { ...state, lowerThird: ev.payload as DeskState['lowerThird'] };

      case 'lower_third.hide':
        return { ...state, lowerThird: null };

      // Who is on camera. The payload is the whole panel, so adding a fourth
      // guest mid-segment is one event and not a diff nobody can reason about.
      // An empty list is a hide: the desk clearing the last name means the
      // segment is over, and it should not leave an empty plate on air.
      case 'panel.show': {
        const p = ev.payload as Partial<PanelState> | null;
        const people = (p?.people ?? []).filter(x => !!x && !!String(x.name ?? '').trim());
        if (!people.length) return { ...state, panel: null };
        return {
          ...state,
          panel: {
            title: String(p?.title ?? '').trim() || 'Analysis desk',
            people: people.map(x => ({
              name: String(x.name).trim(),
              role: String(x.role ?? '').trim(),
              team: Number.isInteger(Number(x.team)) && Number(x.team) > 0 ? Number(x.team) : null,
            })),
          },
        };
      }

      case 'panel.hide':
        return { ...state, panel: null };

      // Strokes themselves never come through here. They're relayed off-bus
      // at pointer rate (see server.ts). What lands on the bus is the durable
      // part: who's drawing, what frame they're drawing on, and whether the
      // render surface is live.
      case 'telestrator.frame': {
        const p = ev.payload as Partial<DeskState['telestrator']>;
        return { ...state, telestrator: { ...state.telestrator, ...p, hidden: false } };
      }

      case 'telestrator.hide':
        return { ...state, telestrator: { ...state.telestrator, hidden: true } };

      /**
       * A take from an operator, or the release back to automatic.
       *
       * "auto" is not a screen: it hands control back and leaves whatever is
       * on air alone until the next lifecycle event moves it.
       */
      case 'screen.change': {
        const wanted = (ev.payload as { screen: string }).screen;
        // Automation rides the same event as the operator, so the source is
        // all that separates a cue from a take. A cue must respect a manual
        // hold and never set or release one: treating cue changes as takes
        // froze automatic screen switching the moment any screen cue armed.
        if (ev.source === 'cue') {
          return wanted === 'auto' ? state : { ...state, screen: auto(state, wanted) };
        }
        if (wanted === 'auto') return { ...state, screenHold: false };
        return { ...state, screen: wanted, screenHold: true };
      }

      case 'rankings.updated': {
        const p = ev.payload as { rankings?: DeskState['rankings']; highestPlayedMatch?: string };
        return {
          ...state,
          rankings: p.rankings ?? state.rankings,
          highestPlayedMatch: p.highestPlayedMatch ?? state.highestPlayedMatch,
        };
      }

      case 'queue.updated': {
        const p = ev.payload as {
          upcoming?: DeskState['upcoming']; nowQueuing?: string | null;
        };
        return {
          ...state,
          upcoming: p.upcoming ?? state.upcoming,
          // Which source the deck on screen came from. Nexus asks that
          // anything using their data link back to frc.nexus, and the surfaces
          // can only honour that if they know when they are showing it.
          queueFrom: p.upcoming ? (ev.source === 'nexus' ? 'nexus' : 'field')
            : state.queueFrom,
          // undefined means "this source has no opinion" (Cheesy does not),
          // and must not wipe what Nexus said. Explicit null does clear it.
          nowQueuing: p.nowQueuing === undefined ? state.nowQueuing : p.nowQueuing,
        };
      }

      // Latches. Nothing retires this but an explicit clear, which is the
      // whole difference between a safety message and a status card.
      case 'emergency.raise': {
        const p = ev.payload as Partial<import('./types.ts').Emergency>;
        const message = String(p.message ?? '').trim();
        if (!message) return state;
        return {
          ...state,
          emergency: {
            kind: (p.kind ?? 'custom') as import('./types.ts').Emergency['kind'],
            message: message.slice(0, 200),
            detail: String(p.detail ?? '').trim().slice(0, 200),
            raisedAt: ev.ts,
          },
        };
      }

      /**
       * A card is a state a team carries, so it accumulates here.
       *
       * Deduped by MATCH, team and colour, which is the key CardLedger uses.
       * The field re-sends its whole card map on every arena update, so a
       * repeat has to be recognised; deduping on `thisMatch` did that only
       * until something reset thisMatch, and match.loaded resets it. See
       * CardState.seen for the two ways that went wrong.
       */
      case 'card.issued': {
        const p = ev.payload as {
          team?: unknown; card?: unknown; alliance?: unknown; match?: unknown;
        };
        const team = Number(p.team);
        if (!Number.isInteger(team) || team <= 0) return state;
        if (p.card !== 'yellow' && p.card !== 'red') return state;
        const color = p.card;
        // The match the card belongs to: from the event when the emitter said
        // so, which is what lets a boot-time restore of card.issued alone
        // rebuild this, and otherwise the loaded match.
        const cardMatch = String(p.match ?? '') || (state.match?.displayName ?? '');
        const key = `${cardMatch}|${team}|${color}`;
        if (state.cards.seen.includes(key)) return state;

        // The phase comes from the event when the emitter said so (which is
        // what makes a boot-time restore of card.issued alone reconstruct
        // this correctly), falling back to the loaded match. A prior entry
        // from an OLDER phase starts over rather than accumulating: the
        // manual's rule is that no card crosses a phase boundary.
        const phase = phaseOf(cardMatch);
        const prior0 = state.cards.byTeam[team];
        const prior = prior0 && prior0.phase === phase ? prior0 : { yellows: 0, reds: 0, phase };
        return {
          ...state,
          cards: {
            byTeam: {
              ...state.cards.byTeam,
              [team]: {
                yellows: prior.yellows + (color === 'yellow' ? 1 : 0),
                reds: prior.reds + (color === 'red' ? 1 : 0),
                phase,
              },
            },
            /*
             * Only when the card belongs to the match that is loaded.
             *
             * thisMatch drives the post-match card chips, and the boot rebuild
             * replays the whole day's card.issued events with no match loaded
             * at all. Every card issued today used to land here, so a desk
             * restarted mid-afternoon put the day's entire discipline record
             * on the next final-score screen.
             */
            thisMatch: cardMatch === (state.match?.displayName ?? '')
              ? [...state.cards.thisMatch,
                { team, color, alliance: p.alliance === 'blue' ? 'blue' : 'red' }]
              : state.cards.thisMatch,
            seen: [...state.cards.seen, key],
          },
        };
      }

      case 'card.call': {
        const p = ev.payload as Partial<CardCall>;
        const team = Number(p.team);
        if (!Number.isInteger(team) || team <= 0) return state;
        if (p.color !== 'yellow' && p.color !== 'red') return state;
        return {
          ...state,
          cardCall: {
            team,
            color: p.color,
            alliance: p.alliance === 'blue' ? 'blue' : 'red',
            reason: String(p.reason ?? '').trim().slice(0, 160),
            at: ev.ts,
          },
          // Takes the screen itself. The whole point is that it is up while the
          // announcer explains it, and an operator who has to also remember to
          // change screens will forget during the one match it matters.
          screen: auto(state, 'cardcall'),
        };
      }

      // Takes the screen the same way the card call does, and gets out of the
      // way on its own when a match arms (see sponsors.ts).
      case 'sponsor.show': {
        const p = ev.payload as { id?: string; name?: string; line?: string; logo?: string | null };
        const name = String(p.name ?? '').trim();
        if (!name) return state;
        return {
          ...state,
          sponsor: { id: String(p.id ?? ''), name, line: String(p.line ?? '').trim(), logo: p.logo ?? null },
          screen: auto(state, 'sponsor'),
        };
      }

      case 'sponsor.hide':
        return { ...state, sponsor: null };

      case 'card.call_clear':
        return { ...state, cardCall: null };

      // The awards ceremony, two stages. Show carries no winner: the state is
      // served openly, and the reveal is the GA's moment, not a JSON field's.
      case 'award.show': {
        const p = ev.payload as {
          id?: unknown; title?: unknown; description?: unknown; blurb?: unknown;
        };
        const title = String(p.title ?? '').trim();
        if (!title) return state;
        return {
          ...state,
          award: {
            id: String(p.id ?? ''), title,
            description: String(p.description ?? '').trim(),
            blurb: String(p.blurb ?? '').trim(),
            winner: null, team: null, revealed: false, at: ev.ts,
          },
          // A manual TAKE, not an auto() suggestion. The operator pressing
          // "Show the award" is the same intent as taking a screen by hand,
          // and during a ceremony they have usually just held one; an award
          // that silently loses to that hold is a button that does nothing.
          // The hold also keeps a gap-filler cue from stomping the ceremony.
          screen: 'award',
          screenHold: true,
        };
      }

      case 'award.presented': {
        const p = ev.payload as { id?: unknown; award?: unknown; winner?: unknown; team?: unknown };
        const winner = String(p.winner ?? '').trim();
        if (!winner) return state;
        const team = Number(p.team);
        // The reveal can arrive with no show before it (a replayed log that
        // started mid-ceremony), so it builds the card it needs either way.
        const base = state.award ?? {
          id: String(p.id ?? ''), title: String(p.award ?? 'Award').trim(),
          description: '', blurb: '',
          winner: null, team: null, revealed: false, at: ev.ts,
        };
        return {
          ...state,
          award: {
            ...base,
            winner,
            team: Number.isInteger(team) && team > 0 ? team : null,
            revealed: true,
          },
          screen: 'award',
          screenHold: true,
        };
      }

      case 'award.clear':
        // The plate comes down and the screen goes with it: leaving 'award'
        // active with no award paints a stale plate, and leaving the hold set
        // makes the next lifecycle event mysteriously not work.
        return {
          ...state, award: null,
          ...(state.screen === 'award' ? { screen: 'blank', screenHold: false } : {}),
        };

      // A slide takes the screen the way a sponsor card does, and leaves the
      // same way. What rotates on the SIDE screens is the deck, not this: this
      // is only ever the one slide the desk deliberately put on program.
      case 'slide.show': {
        const p = ev.payload as {
          id?: unknown; kind?: unknown; title?: unknown; lines?: unknown;
        };
        const title = String(p.title ?? '').trim();
        if (!title) return state;
        return {
          ...state,
          slide: {
            id: String(p.id ?? ''),
            kind: String(p.kind ?? 'info'),
            title,
            lines: (Array.isArray(p.lines) ? p.lines : [])
              .map(l => String(l ?? '').trim()).filter(Boolean).slice(0, 6),
          },
          // Same manual-take semantics as the award, for the same reason.
          screen: 'slide',
          screenHold: true,
        };
      }

      case 'slide.hide':
        return {
          ...state, slide: null,
          ...(state.screen === 'slide' ? { screen: 'blank', screenHold: false } : {}),
        };

      // The event countdown. It does not touch the program screen: it lives on
      // the side screens, which are the ones a team on the field can see.
      case 'timer.started': {
        const p = ev.payload as { label?: unknown; endsAt?: unknown };
        const endsAt = Number(p.endsAt);
        if (!Number.isFinite(endsAt) || endsAt <= ev.ts) return state;
        return {
          ...state,
          timer: {
            label: String(p.label ?? '').trim().slice(0, 60) || 'Countdown',
            endsAt,
            startedAt: ev.ts,
          },
        };
      }

      case 'timer.cleared':
        return { ...state, timer: null };

      case 'event.accessibility': {
        const p = ev.payload as {
          services?: { label?: string; detail?: string }[]; ask?: string;
        };
        return {
          ...state,
          accessibility: {
            // Anything without a label is not a service anybody can act on.
            services: (p.services ?? [])
              .map(x => ({ label: String(x?.label ?? '').trim(), detail: String(x?.detail ?? '').trim() }))
              .filter(x => x.label),
            ask: String(p.ask ?? '').trim(),
          },
        };
      }

      case 'emergency.clear':
        return { ...state, emergency: null };

      case 'scene.change':
        return { ...state, scene: String((ev.payload as { scene?: string }).scene ?? '') || null };

      case 'queue.called':
        return { ...state, nowQueuing: String((ev.payload as { label?: string }).label ?? '') || null };

      case 'announcement.posted': {
        const p = ev.payload as { text?: string; postedAt?: number; from?: string };
        const text = String(p.text ?? '').trim();
        if (!text) return state;
        return {
          ...state,
          announcement: {
            text: text.slice(0, 280),
            postedAt: Number(p.postedAt) || ev.ts,
            from: String(p.from ?? 'Event'),
          },
        };
      }

      case 'arena.status':
        return { ...state, connected: { ...state.connected, ...(ev.payload as object) } };

      case 'pace.updated':
        return { ...state, pace: ev.payload as DeskState['pace'] };

      /*
       * Built field by field, like every other operator-typed string, rather
       * than cast wholesale onto the state. This one used to be the exception:
       * whatever arrived became the card. Three things came of that.
       *
       * A message had no cap while emergency has 200 and a card reason 160, so
       * the only thing standing between a pasted paragraph and the program
       * feed was a CSS clamp, which silently drops the overflow. 90 is what
       * the plate holds, measured rather than reasoned: three lines of 44px
       * display type in a 1100px box take 110 characters of ordinary prose but
       * only 95 of all-caps, and an operator shouting into the box is exactly
       * the case that would have clipped. The clamp stays as a backstop and
       * should now never be reached. surfaces/desk keeps the same number.
       *
       * `backAt` was whatever was sent. A string put "Invalid Date" on the
       * plate, in front of the hall, on the one line the room is reading.
       *
       * And an unknown `kind` printed the fallback "Update" over a card whose
       * colour scheme it never matched, so it now falls back to 'custom',
       * which every surface already styles.
       */
      case 'status.show': {
        const p = ev.payload as Partial<StatusCard>;
        const message = String(p.message ?? '').trim();
        if (!message) return state;
        const backAt = Number(p.backAt);
        return {
          ...state,
          status: {
            kind: STATUS_KINDS.includes(p.kind as StatusCard['kind'])
              ? p.kind as StatusCard['kind'] : 'custom',
            message: message.slice(0, 90),
            backAt: Number.isFinite(backAt) && backAt > 0 ? backAt : null,
          },
        };
      }

      case 'status.hide':
        return { ...state, status: null };

      // A field timeout raises the delay card on its own, so the stoppage is
      // explained even if nobody at the desk reacts. Never over an
      // operator-set card: the producer's wording wins. It clears itself when
      // the field moves on, via the match lifecycle cases below clearing
      // status only when it was this automatic card (marked by its message).
      case 'break.started':
        return state.status !== null ? state
          : { ...state, status: { kind: 'delay', message: 'Field timeout', backAt: null } };

      // Thresholds arrive from config at boot. Re-scoring immediately means a
      // mid-event correction repaints every badge instead of waiting for the
      // next score packet to happen along.
      case 'game.thresholds': {
        const p = ev.payload as Partial<RpThresholds> | null;
        if (!p) return state;
        return rescore({
          ...state,
          thresholds: { ...state.thresholds, ...p },
        });
      }

      /**
       * Selection republishes the whole board on every pick and once a second
       * while the clock runs, so this replaces rather than merges. The field
       * is the only writer; nothing here ever edits an alliance.
       */
      case 'alliance_selection.update': {
        const p = ev.payload as DeskState['selection'];
        return p ? { ...state, selection: { ...p, updatedAt: ev.ts } } : state;
      }

      default:
        return state;
    }
  })();

  return { ...retime(next, ev.ts), updatedAt: ev.ts };
}

/** Called by the server ticker so phase transitions land without an event. */
export const tick = (state: DeskState, now = Date.now()): DeskState => retime(state, now);
