/**
 * Arcade store. Holds the current set / grand prix and republishes it on the
 * bus so the overlay is just another subscriber.
 *
 * Operator-authoritative by design. start.gg (when it's wired) supplies names,
 * seeds and round labels; it does NOT supply the live score, because start.gg
 * reflects what a TO has typed in and lags reality by anywhere from thirty
 * seconds to a full round. See docs/05-arcade.md.
 */

import type { EventBus } from '../bus.ts';
import type { DeskEvent } from '../types.ts';
import {
  standings, setWinner,
  type ArcadeGame, type ArcadePlayer, type ArcadeSet, type BracketSet,
  type GrandPrix, type Standing,
} from './model.ts';

/**
 * Which boxes the operator is allowing on screen.
 *
 * Separate from whether a box has anything to say. A box shows when it has
 * content AND is switched on here, so switching one off is a deliberate "get
 * out of the way" during a game moment worth actually watching, and switching
 * it back on does not require re-entering anything.
 *
 * Server-side rather than in the overlay because the overlay is a Browser
 * Source nobody can click, and because a reload must not resurrect a box the
 * operator hid thirty seconds ago.
 */
export interface ArcadeBoxes {
  /** The versus strip: two players, scores, round. */
  card: boolean;
  /** The 3-4 player free-for-all strip and its round tab. */
  ffa: boolean;
  /** The grand prix standings panel on the right. */
  gp: boolean;
  /** The "up next" chip on the left. */
  upNext: boolean;
}

export type ArcadeBox = keyof ArcadeBoxes;

const ALL_ON = (): ArcadeBoxes => ({ card: true, ffa: true, gp: true, upNext: true });

export interface ArcadeSnapshot {
  set: ArcadeSet | null;
  gp: GrandPrix | null;
  standings: Standing[];
  /** Drives the "up next" line during a break. */
  upNext: string;
  /** The up-next line is the sample's, so a restart does not restore it. */
  upNextSample?: true;
  /** Bracket metadata from start.gg: round labels and entrants, never scores. */
  bracket: BracketSet[];
  boxes: ArcadeBoxes;
}

export class ArcadeStore {
  #bus: EventBus;
  #set: ArcadeSet | null = null;
  #gp: GrandPrix | null = null;
  #upNext = '';
  #bracket: BracketSet[] = [];
  #boxes: ArcadeBoxes = ALL_ON();
  /**
   * Set by the first OPERATOR publish, after which observe() refuses to
   * restore: a logged snapshot arriving once a set is being scored would
   * overwrite it. Not set by a start.gg publish, because the adapter's first
   * poll is in flight while the boot-time rebuild runs and can land in the
   * middle of it; bracket metadata says nothing about what the operator has
   * done, so it must not end the restore.
   */
  #live = false;
  /**
   * The desk's sample data. While a sample seed runs, publishes go out tagged
   * 'demo', which the boot-time rebuild skips, so a restart never restores
   * the sample's set or grand prix. What it put up is marked, so
   * clearSample() takes down exactly that and leaves anything real alone.
   */
  #sample = false;
  #sampleUpNext = '';

  constructor(bus: EventBus) { this.#bus = bus; }

  /** Run a sample seed. Everything it publishes is tagged as sample. */
  asSample(seed: () => void): void {
    this.#sample = true;
    try { seed(); } finally {
      this.#sample = false;
      if (this.#set) this.#set.sample = true;
      if (this.#gp) this.#gp.sample = true;
      this.#sampleUpNext = this.#upNext;
    }
  }

  /** Take down whatever the sample put up and is still showing. */
  clearSample(): void {
    let changed = false;
    if (this.#set?.sample) { this.#set = null; changed = true; }
    if (this.#gp?.sample) { this.#gp = null; changed = true; }
    if (this.#upNext && this.#upNext === this.#sampleUpNext) { this.#upNext = ''; changed = true; }
    this.#sampleUpNext = '';
    if (changed) this.#publish('arcade.bracket_updated');
  }

  /**
   * Rebuild from a logged `arcade.*` event. Boot-time only, fed by
   * rebuildFromLog; never subscribed to the bus.
   *
   * The grand prix lived only in memory: three races into a four-race Pit
   * Crew Cup, a restart put an empty standings panel on the projector and
   * the operator re-typing finishing orders from memory. Every arcade event
   * carries the whole snapshot, so each one overwrites the last and the day's
   * final event wins. Nothing here publishes: the overlay reads the restored
   * state on its next snapshot, and re-emitting set_end would re-queue the
   * set's video.
   *
   * The bracket is NOT restored. It is start.gg's data, re-fetched within a
   * minute of boot, and a poll that landed before the rebuild would be
   * overwritten with an older copy from the log.
   */
  observe(ev: DeskEvent): void {
    if (this.#live || !ev.type.startsWith('arcade.')) return;
    const snap = ev.payload as Partial<ArcadeSnapshot> | null;
    if (!snap || typeof snap !== 'object') return;

    // Checked the way startGrandPrix and recordRace check their inputs:
    // standings() runs on every snapshot, so a malformed grand prix out of a
    // hand-edited log would take the whole /api/arcade surface down at boot.
    const gp = snap.gp;
    const gpOk = !!gp && typeof gp === 'object'
      && Array.isArray(gp.racers)
      && gp.racers.every(r => !!r && typeof r.id === 'string' && typeof r.name === 'string')
      && Array.isArray(gp.races)
      && gp.races.every(race => Array.isArray(race) && race.every(id => typeof id === 'string'));
    this.#gp = gpOk && !gp.sample ? gp : null;

    const set = snap.set;
    this.#set = !!set && typeof set === 'object'
      && Array.isArray(set.players) && Array.isArray(set.scores) && !set.sample
      ? set : null;

    this.#upNext = typeof snap.upNext === 'string' && !snap.upNextSample ? snap.upNext : '';

    const boxes = snap.boxes;
    const boxesOk = !!boxes && typeof boxes === 'object'
      && (Object.keys(ALL_ON()) as ArcadeBox[]).every(k => typeof boxes[k] === 'boolean');
    this.#boxes = boxesOk ? { ...boxes } : ALL_ON();
  }

  get snapshot(): ArcadeSnapshot {
    return {
      set: this.#set,
      gp: this.#gp,
      standings: this.#gp ? standings(this.#gp) : [],
      upNext: this.#upNext,
      ...(this.#upNext && this.#upNext === this.#sampleUpNext ? { upNextSample: true as const } : {}),
      bracket: this.#bracket,
      boxes: { ...this.#boxes },
    };
  }

  /**
   * Show or hide one box. Returns the boxes so the console can paint from the
   * answer rather than assuming its click landed.
   */
  setBox(name: ArcadeBox, on: boolean): ArcadeBoxes {
    if (!(name in this.#boxes)) {
      throw new Error(`There is no "${name}" box. Try: ${Object.keys(this.#boxes).join(', ')}.`);
    }
    this.#boxes[name] = on;
    this.#publish('arcade.bracket_updated');
    return { ...this.#boxes };
  }

  /** Panic button: put everything back. Hiding four boxes one at a time
   *  during a break and then hunting for the one still off is not a thing
   *  anybody should have to do mid-show. */
  showAllBoxes(): ArcadeBoxes {
    this.#boxes = ALL_ON();
    this.#publish('arcade.bracket_updated');
    return { ...this.#boxes };
  }

  /**
   * Replace the bracket metadata (from the start.gg adapter). External data,
   * not operator state; `clear()` leaves it alone, and it never touches the
   * live set or its scores.
   */
  setBracket(sets: BracketSet[]): void {
    this.#bracket = sets;
    this.#publish('arcade.bracket_updated', 'startgg');
  }

  #publish(
    type: 'arcade.set_start' | 'arcade.score' | 'arcade.set_end' | 'arcade.bracket_updated',
    source: 'manual' | 'startgg' = 'manual',
  ): void {
    if (source === 'manual') this.#live = true;
    this.#bus.emit({ type, source: this.#sample ? 'demo' : source, payload: this.snapshot });
  }

  startSet(init: {
    game: ArcadeGame; round: string; players: ArcadePlayer[]; bestOf?: number;
  }): ArcadeSet {
    if (!Array.isArray(init.players) || init.players.length < 2 || init.players.length > 4) {
      throw new Error('A set takes 2 to 4 players.');
    }
    // The route casts the body through unchecked, so validate here.
    const bestOf = Number(init.bestOf ?? 3);
    if (bestOf !== 3 && bestOf !== 5) throw new Error('A set is best of 3 or best of 5.');
    // A live set being replaced must close out first: subscribers key on
    // set_end (the publish auto-queue cuts each set's video from it), and
    // silently swapping the set meant the interrupted one's video was never
    // queued. The operator starting the next set IS the end of the last one.
    if (this.#set && this.#set.state === 'live') {
      this.#set.state = 'complete';
      this.#publish('arcade.set_end');
    }
    this.#set = {
      id: `s${Date.now().toString(36)}`,
      game: init.game,
      round: init.round,
      // Wall clock, so the publish auto-queue can cut the set's video from
      // start to set_end without anyone marking bounds by hand.
      startedAt: Date.now(),
      players: init.players,
      scores: init.players.map(() => 0),
      bestOf,
      state: 'live',
      scoreConfidence: 'estimated',
    };
    this.#publish('arcade.set_start');
    return this.#set;
  }

  /** Operator adjusts a score. Clamped at zero (negatives are always a typo). */
  score(playerIndex: number, delta: number): ArcadeSet | null {
    if (!this.#set) return null;
    // A stray click after the set is already decided must not reopen it or
    // shuffle who won: `setWinner` picks the first index at the max score, so
    // a post-completion edit can silently hand the win to the wrong player.
    if (this.#set.state === 'complete') return this.#set;
    // The route forwards the body's delta through Number() unchecked, and
    // Math.max(0, current + NaN) is NaN, which no later delta can ever heal,
    // so one malformed POST used to poison the on-air score for the rest of
    // the set (and stamp it 'authoritative' below, to boot).
    if (!Number.isFinite(delta)) {
      throw new Error('The score change must be a number.');
    }
    const current = this.#set.scores[playerIndex];
    if (current === undefined) return this.#set;

    this.#set.scores[playerIndex] = Math.max(0, current + delta);
    this.#set.scoreConfidence = 'authoritative';   // a human just confirmed it

    const winner = setWinner(this.#set, this.#set.bestOf);
    if (winner) {
      this.#set.state = 'complete';
      this.#publish('arcade.set_end');
    } else {
      this.#publish('arcade.score');
    }
    return this.#set;
  }

  endSet(): void {
    if (!this.#set) return;
    // A versus set that already auto-completed at the win threshold has
    // announced its set_end; the operator's confirming tap must not announce
    // it again, or every set_end subscriber (the publish auto-queue) doubles.
    if (this.#set.state === 'complete') return;
    this.#set.state = 'complete';
    this.#publish('arcade.set_end');
  }

  startGrandPrix(name: string, racers: ArcadePlayer[], raceCount = 4): GrandPrix {
    // The route casts the request body straight through, so the shape has to
    // be checked at runtime: a malformed grand prix makes standings() throw
    // on every later snapshot, taking the whole /api/arcade surface with it.
    if (!Array.isArray(racers)
        || racers.some(r => typeof r?.id !== 'string' || typeof r?.name !== 'string')) {
      throw new Error('Racers must be objects with an id and a name.');
    }
    // And the ids have to be distinct. standings() keys by id, so two racers
    // registered under the same one silently collapsed into a single row
    // accruing both their points: the same wrong-leaderboard-with-no-error
    // failure the duplicate guard in recordRace was added to stop.
    const ids = new Set(racers.map(r => r.id));
    if (ids.size !== racers.length) {
      throw new Error('Two racers share an id, so their scores would be added together.');
    }
    this.#gp = { game: 'mariokart', name, racers, races: [], raceCount };
    this.#publish('arcade.bracket_updated');
    return this.#gp;
  }

  /** Record a race result as racer ids in finishing order. */
  recordRace(order: string[]): GrandPrix | null {
    if (!this.#gp) return null;
    // Validate before the push. A bad entry used to go into `races` first and
    // then blow up inside standings(), poisoning every snapshot, publish and
    // bracket update until the entry itself was popped.
    if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
      throw new Error('A race result is racer ids in finishing order.');
    }
    // A duplicated id is the same class of poison, just quieter: standings()
    // pays every occurrence, so "a, a, c, d" hands one racer 15+12 points from
    // a single race and the wrong leaderboard goes on air with no error.
    if (new Set(order).size !== order.length) {
      throw new Error('A racer appears twice in that finishing order.');
    }
    this.#gp.races.push(order);
    this.#publish('arcade.score');
    return this.#gp;
  }

  undoRace(): GrandPrix | null {
    if (!this.#gp?.races.length) return this.#gp;
    this.#gp.races.pop();
    this.#publish('arcade.score');
    return this.#gp;
  }

  setUpNext(text: string): void {
    this.#upNext = text;
    this.#publish('arcade.bracket_updated');
  }

  clear(): void {
    this.#set = null;
    this.#gp = null;
    this.#upNext = '';
    // Boxes come back on too: "clear" means the segment is over, and leaving a
    // box switched off would silently swallow the next segment's graphic.
    this.#boxes = ALL_ON();
    this.#publish('arcade.bracket_updated');
  }
}
