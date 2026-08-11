/**
 * Snapshot reducer. Pure: (state, event) -> state.
 *
 * Pure matters here: it's what lets us replay an NDJSON log from Friday's
 * practice matches and get byte-identical state, which is how graphics get
 * built and tested in March with no field.
 */

import { clockDisplay, clockFrom, hubActiveAt, isLockdown, phaseAt } from './clock.ts';
import {
  emptyAllianceScore, REBUILT,
  type Alliance, type AllianceScore, type CardCall, type Confidence,
  type DeskEvent, type DeskState,
  type PanelState,
  type RpThresholds,
} from './types.ts';

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
    total: fuel + tower + opponentFouls,
    // Scored against the live thresholds, never the defaults in REBUILT: an
    // off-season event can move these, and a badge that lights at a number
    // nobody is playing to is worse than no badge.
    rp: {
      energized: fuel >= t.energizedFuel,
      supercharged: fuel >= t.superchargedFuel,
      traversal: tower >= t.traversalTower,
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
        return {
          ...state,
          match: p,
          matchStartedAt: null,
          lastMatchStartedAt: null,
          matchEndedAt: null,
          scorePostedAt: null,
          autoWinner: null,
          autoWinnerKnown: false,
          hubAuthoritative: null,
          score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
          confidence: ev.confidence,
          totalConfidence: ev.confidence,
          // Per-match card state resets; the running per-team totals do not,
          // because a yellow from match 12 is still live in match 40.
          cards: { ...state.cards, thisMatch: [] },
          cardCall: null,
          surrogates: (() => {
            const raw = (p as unknown as { surrogates?: unknown }).surrogates;
            return (Array.isArray(raw) ? raw : [])
              .map(Number).filter(n => Number.isInteger(n) && n > 0);
          })(),
          screen: auto(state, 'overview'),
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
        return { ...state, matchStartedAt: ev.ts, lastMatchStartedAt: ev.ts, screen: auto(state, 'match') };

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
       * The reveal, and — from the field — the official totals.
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
        const p = (ev.payload ?? {}) as Partial<Record<Alliance, { score?: unknown }>>;
        let s: DeskState = { ...state, scorePostedAt: ev.ts, screen: auto(state, 'score') };
        let official = false;
        for (const side of ['red', 'blue'] as Alliance[]) {
          const total = Number(p[side]?.score);
          if (!Number.isFinite(total)) continue;
          official = true;
          s = { ...s, score: { ...s.score, [side]: { ...s.score[side], total } } };
        }
        return official ? { ...s, totalConfidence: ev.confidence } : s;
      }

      /**
       * A COMPLETE snapshot restores authority. A partial one cannot.
       *
       * The old comment here asserted "it replaces every number" and the code
       * took ev.confidence unconditionally — but the payload type is Partial
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
       * Deduped by team and colour WITHIN the loaded match: the field re-sends
       * its whole card map on every arena update, and counting one yellow
       * twice would silently promote it to a red on the graphic.
       */
      case 'card.issued': {
        const p = ev.payload as { team?: unknown; card?: unknown; alliance?: unknown };
        const team = Number(p.team);
        if (!Number.isInteger(team) || team <= 0) return state;
        if (p.card !== 'yellow' && p.card !== 'red') return state;
        const color = p.card;
        if (state.cards.thisMatch.some(c => c.team === team && c.color === color)) return state;

        const prior = state.cards.byTeam[team] ?? { yellows: 0, reds: 0 };
        return {
          ...state,
          cards: {
            byTeam: {
              ...state.cards.byTeam,
              [team]: {
                yellows: prior.yellows + (color === 'yellow' ? 1 : 0),
                reds: prior.reds + (color === 'red' ? 1 : 0),
              },
            },
            thisMatch: [...state.cards.thisMatch,
              { team, color, alliance: p.alliance === 'blue' ? 'blue' : 'red' }],
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

      case 'status.show':
        return { ...state, status: ev.payload as DeskState['status'] };

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
