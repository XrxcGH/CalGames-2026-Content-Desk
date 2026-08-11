/**
 * The card and surrogate ledger: who is carrying what, and who is not really
 * playing this one.
 *
 * Cards arrive from the field as one-shot events and then nothing remembers
 * them. That is fine for a replay marker and wrong for everything else,
 * because a card is not an event, it is a STATE a team carries:
 *
 *   - A yellow card carries forward. A team that picked one up in match 12 is
 *     still carrying it in match 40, and a second yellow makes it a red. It
 *     does NOT carry past the end of the tournament phase (manual S6.6), so
 *     that same team starts Sunday's playoffs clean.
 *   - A red card means that team's alliance scored zero for that match. The
 *     announcer will be asked why on air, and "I think somebody got a card"
 *     is the wrong answer in front of a gym.
 *   - A surrogate is playing a match that does not count for their record.
 *     Nothing on the graphics says so today, so the audience watches a team
 *     "lose" a match that was never theirs to lose, and the ranking table
 *     disagrees with what they just watched.
 *
 * None of that is derivable at the moment somebody asks. So it is kept.
 *
 * Deliberately NOT authoritative over scoring. Cheesy Arena decides what a red
 * card does to a score and this never touches a number; it exists so the
 * announcer and the graphics can SAY the right thing.
 */

import type { EventBus } from './bus.ts';
import type { Alliance, DeskEvent } from './types.ts';

export type CardColor = 'yellow' | 'red';

/**
 * The tournament phase a card was issued in.
 *
 * It matters because cards do not carry across one. Manual S6.6: the yellow
 * indicator shows "for the remainder of the tournament phase", and the phases
 * are Practice, Qualification and Playoff. A yellow from Q12 is spent by the
 * time that team plays a playoff match on Sunday, and telling the announcer
 * they are one card from a red is telling them something untrue.
 */
export type Phase = 'practice' | 'qualification' | 'playoff';

/**
 * Which phase a match name belongs to.
 *
 * Read off the display name because that is all the ledger is given. Cheesy
 * sends "Qualification 12", "Practice 3" and — for playoffs — bare "Match 7"
 * with the round in a separate field, so an unrecognised name is a PLAYOFF
 * rather than an error: that is the only phase whose names do not say what
 * they are, and guessing "qualification" for one would carry a spent card
 * into Sunday, which is the failure being fixed.
 */
export function phaseOf(match: string): Phase {
  const m = match.trim().toLowerCase();
  if (m.startsWith('practice') || /^p\d/.test(m)) return 'practice';
  if (m.startsWith('qual') || /^q\d/.test(m)) return 'qualification';
  return 'playoff';
}

export interface CardRecord {
  team: number;
  color: CardColor;
  /** The match it was issued in, as the desk knew it at the time. */
  match: string;
  /** Derived from the match name at issue time. Cards do not cross a phase. */
  phase: Phase;
  alliance: Alliance;
  at: number;
}

export interface TeamStanding {
  team: number;
  /** Yellows carry forward all event; this is the running count. */
  yellows: number;
  reds: number;
  /**
   * Carrying a yellow into the next match. True after one yellow, and the
   * thing the announcer actually needs: a second one is a red.
   */
  carrying: boolean;
  cards: CardRecord[];
}

export interface CardLedgerSnapshot {
  /** Teams with anything against them, worst first. */
  teams: TeamStanding[];
  /** Cards issued in the match currently loaded, for the post-match graphic. */
  thisMatch: CardRecord[];
  /** Team numbers playing as a surrogate in the loaded match. */
  surrogates: number[];
  updatedAt: number;
}

const isColor = (v: unknown): v is CardColor => v === 'yellow' || v === 'red';

export class CardLedger {
  #cards: CardRecord[] = [];
  #surrogates = new Set<number>();
  #match = '';
  /** The phase the event is in now, from the last match loaded. */
  #phase: Phase = 'qualification';
  #unsubscribe: (() => void) | null = null;

  attach(bus: EventBus): () => void {
    this.#unsubscribe = bus.subscribe(ev => this.observe(ev));
    return () => { this.#unsubscribe?.(); this.#unsubscribe = null; };
  }

  /** Exposed so a replayed log rebuilds the ledger exactly. */
  observe(ev: DeskEvent): void {
    if (ev.type === 'match.loaded') {
      const p = ev.payload as { displayName?: string; surrogates?: unknown };
      this.#match = String(p.displayName ?? '').trim();
      this.#phase = phaseOf(this.#match);
      // Surrogates belong to the match, not the team: the same team is a
      // surrogate in one match and a real entrant in the next, so this is
      // replaced wholesale on every load rather than accumulated.
      this.#surrogates = new Set(
        (Array.isArray(p.surrogates) ? p.surrogates : [])
          .map(Number).filter(n => Number.isInteger(n) && n > 0),
      );
      return;
    }

    if (ev.type !== 'card.issued') return;
    const p = ev.payload as { team?: unknown; card?: unknown; alliance?: unknown };
    const team = Number(p.team);
    if (!Number.isInteger(team) || team <= 0) return;
    if (!isColor(p.card)) return;

    // The field re-sends its whole card map on every arena update, and the
    // adapter already dedupes within a match. This dedupes across the day: a
    // desk restart mid-event replays nothing, but a reconnect can re-announce
    // the same card, and counting it twice turns one yellow into a red.
    const already = this.#cards.some(c =>
      c.team === team && c.color === p.card && c.match === this.#match);
    if (already) return;

    this.#cards.push({
      team,
      color: p.card,
      match: this.#match,
      phase: phaseOf(this.#match),
      alliance: p.alliance === 'blue' ? 'blue' : 'red',
      at: ev.ts,
    });
  }

  /** Everything against one team, for the talent view's team card. */
  forTeam(team: number): TeamStanding | null {
    const cards = this.#cards.filter(c => c.team === team);
    if (!cards.length) return null;
    return this.#standing(team, cards);
  }

  #standing(team: number, cards: CardRecord[]): TeamStanding {
    const yellows = cards.filter(c => c.color === 'yellow').length;
    const reds = cards.filter(c => c.color === 'red').length;
    // Only what is live RIGHT NOW counts toward carrying. Manual S6.6 clears
    // the indicator at the end of each tournament phase, so a yellow from
    // Qualification 12 is spent by Sunday's playoffs. The running totals above
    // are still the whole event, because "254 has two yellows this weekend" is
    // a thing the announcer says and it stays true across a phase.
    const live = cards.filter(c => c.phase === this.#phase);
    return {
      team, yellows, reds,
      /*
       * A red card leaves a team carrying, and the previous comment here had
       * this backwards. It read "a red supersedes rather than adds", which is
       * a defensible thing to say about severity and is not what the rule
       * says: the indicator is displayed once a team has received a yellow OR
       * a red. Reporting `carrying: false` after a red told the announcer that
       * a red-carded team had a clean slate for the rest of the day.
       */
      carrying: live.length > 0,
      cards,
    };
  }

  get snapshot(): CardLedgerSnapshot {
    const byTeam = new Map<number, CardRecord[]>();
    for (const c of this.#cards) {
      const list = byTeam.get(c.team) ?? [];
      list.push(c);
      byTeam.set(c.team, list);
    }
    const teams = [...byTeam.entries()]
      .map(([team, cards]) => this.#standing(team, cards))
      // Reds first, then yellows, then by team number so the list is stable
      // between polls rather than reshuffling under a reader's eye.
      .sort((a, b) => b.reds - a.reds || b.yellows - a.yellows || a.team - b.team);

    return {
      teams,
      thisMatch: this.#cards.filter(c => c.match === this.#match),
      surrogates: [...this.#surrogates].sort((a, b) => a - b),
      updatedAt: Date.now(),
    };
  }
}
