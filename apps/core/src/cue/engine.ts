/**
 * Show automation. See the show flow table in docs/06-hardware-and-network.md.
 *
 * Two rules govern everything here:
 *
 *   1. Manual always wins. Every cue has its own autopilot toggle, so the
 *      producer can trust the parts that work and drive the parts that don't.
 *      A global on/off would be useless: on day one you trust nothing, and by
 *      Sunday you trust most of it.
 *
 *   2. A disabled cue still reports that it WOULD have fired. That is what
 *      makes a producer comfortable turning it on: they watch it be right for
 *      a session first.
 */

import type { EventBus } from '../bus.ts';
import type { DeskEvent, DeskState } from '../types.ts';
import type { ObsClient } from './obs.ts';
import type { HouseAudio } from '../audio/store.ts';

export interface CueContext {
  bus: EventBus;
  obs: ObsClient | null;
  event: DeskEvent;
  state: DeskState;
  scene: (name: keyof typeof DEFAULT_SCENES) => Promise<void>;
  /**
   * The room's PA. Null when house audio is off, and a cue that touches it must
   * tolerate that: the music is a nice-to-have and the show is not.
   */
  audio: HouseAudio | null;
}

export interface Cue {
  id: string;
  name: string;
  /** What the producer sees when deciding whether to trust it. */
  does: string;
  /**
   * True when `run` calls `ctx.scene`, so the cue cannot do its job with OBS
   * away. The desk greys out "Run now" for these and only these: it used to
   * grey out ALL of them whenever OBS was disconnected, including the three
   * music cues and the end game chip, which never touch OBS at all. A desk
   * running the show on the venue projectors with no stream had show
   * automation it could not run by hand, under a notice that said why in
   * terms that were not true of the button it was greying out.
   *
   * Declared rather than sniffed, and kept honest by a test that reads each
   * `run` back and fails if the two disagree.
   */
  needsObs?: boolean;
  when: (ev: DeskEvent, state: DeskState) => boolean;
  run: (ctx: CueContext) => void | Promise<void>;
}

export interface CueStatus {
  id: string;
  name: string;
  does: string;
  /** See Cue.needsObs: whether "Run now" can work with OBS disconnected. */
  needsObs: boolean;
  autopilot: boolean;
  firedAt: number | null;
  /** Times it matched while switched off ("it would have been right N times"). */
  wouldHaveFired: number;
  lastError: string | null;
}

/** Scene names to create in OBS. Overridable at construction. */
export const DEFAULT_SCENES = {
  intro: 'CG_INTRO',
  match: 'CG_MATCH',
  score: 'CG_SCORE',
  replay: 'CG_REPLAY',
  desk: 'CG_DESK',
  arcade: 'CG_ARCADE',
} as const;

export type SceneMap = Record<keyof typeof DEFAULT_SCENES, string>;

/** Gap after which we assume there's no match imminent and fill. */
const GAP_MS = 3 * 60_000;

export function defaultCues(): Cue[] {
  // The gap-filler's condition is a level, not an edge: once a gap is three
  // minutes old it stays true on every bus event until the next match. The
  // latch makes it fire once per gap; without it the cue re-cut to the arcade
  // on every trivia join and schedule poll, stomping any manual OBS take.
  let gapFilledAt: number | null = null;
  return [
    {
      id: 'on-deck',
      needsObs: true,
      name: 'On deck',
      does: 'Show the alliance overview when a match is loaded.',
      when: ev => ev.type === 'match.loaded',
      run: async ctx => {
        // Source 'cue' is load-bearing: the reducer lets cue-sourced screen
        // changes ride under an operator's hold instead of engaging one.
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'overview' } });
        await ctx.scene('intro');
      },
    },
    {
      id: 'armed',
      needsObs: true,
      name: 'Armed',
      does: 'Cut to the field and bring the score bar in when the field goes ready, before the countdown.',
      when: ev => ev.type === 'match.armed',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'match' } });
        await ctx.scene('match');
      },
    },
    {
      id: 'live',
      needsObs: true,
      name: 'Live',
      does: 'Score bar live, hub indicator on, replay markers armed.',
      when: ev => ev.type === 'match.start',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'match' } });
        await ctx.scene('match');
      },
    },
    {
      id: 'endgame',
      name: 'End game',
      does: 'End game chip as the towers come into play. The camera stays manual: the wide-shot lock holds mid-match.',
      // The clock owns this boundary: bus.advance() emits match.endgame in
      // every mode, so it fires exactly once. A score.delta fallback used to
      // sit alongside it; it re-fired on every delta for the whole endgame
      // window, so it is gone.
      when: ev => ev.type === 'match.endgame',
      run: ctx => {
        ctx.bus.emit({ type: 'graphic.show', source: 'cue', payload: { graphic: 'endgame' } });
      },
    },
    // ---- house audio ----------------------------------------------------
    // These drive the room's PA and nothing else. They are ordinary cues, so
    // they start disarmed and the operator can take any of them back instantly
    // from the desk or a phone. The music is never worth fighting over.
    {
      id: 'music-down',
      name: 'Music down',
      does: 'Drop the event playlist when the field goes ready, so the announcer has the room for the countdown.',
      // Same trigger as the Armed cue: every robot linked, BEFORE the
      // announcer starts counting. Music running under "3, 2, 1" is the
      // complaint; by match.start it is already too late to fix it.
      when: (ev, _state) => ev.type === 'match.armed',
      run: async ctx => {
        if (!ctx.audio?.automation.pauseForMatch) return;
        await ctx.audio.setSource('silent', 'Field is ready');
      },
    },
    {
      id: 'music-up',
      name: 'Music up',
      does: 'Bring the playlist back once the score is posted and the result has landed.',
      // Not at the buzzer: the celebration and the score reveal are the loudest
      // thirty seconds of the match and the last thing they need is a pop song
      // underneath them.
      when: ev => ev.type === 'match.score_posted',
      run: async ctx => {
        if (!ctx.audio?.automation.resumeAfterScore) return;
        await ctx.audio.setSource('playlist', 'Score posted');
      },
    },
    {
      id: 'music-yield',
      name: 'Give the room to the game',
      does: 'Go quiet when the arcade takes the program, so the console audio is not fighting the playlist.',
      when: ev => ev.type === 'screen.change'
        && (ev.payload as { screen?: string }).screen === 'arcade',
      run: async ctx => {
        if (!ctx.audio?.automation.yieldToConsole) return;
        await ctx.audio.setSource('console', 'Arcade is on the program');
      },
    },
    {
      id: 'hold-celebration',
      needsObs: true,
      name: 'Hold on the buzzer',
      does: 'Re-take the field wide at the buzzer so the celebration stays on air until the score reveal cues.',
      when: ev => ev.type === 'match.end',
      run: async ctx => { await ctx.scene('match'); },
    },
    {
      id: 'result',
      needsObs: true,
      name: 'Score reveal',
      does: 'Reveal the final score, RP badges, and ranking movement.',
      when: ev => ev.type === 'match.score_posted',
      run: async ctx => {
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'score' } });
        await ctx.scene('score');
      },
    },
    {
      id: 'replay',
      needsObs: true,
      name: 'Take replay',
      does: 'Cut to the replay scene when the operator takes a clip.',
      when: ev => ev.type === 'replay.play',
      run: async ctx => { await ctx.scene('replay'); },
    },
    {
      id: 'gap-filler',
      needsObs: true,
      name: 'Fill the gap',
      does: 'Cut to the arcade when there is no match for three minutes.',
      // Deliberately not keyed to a specific event type: the moment that
      // crosses the three-minute mark is a clock, not a bus event, so this
      // has to be re-checked on whatever comes through next (the schedule and
      // rankings poll every 60s even when nothing changed) rather than on
      // `match.score_posted` alone, which fires exactly when scorePostedAt is
      // set to "now" and so could never itself be three minutes stale.
      when: (_ev, state) => {
        const inGap = state.matchStartedAt === null
          // A score has to have been posted at all. Treating "never" as an
          // infinitely long gap made this true from boot, so the arcade bumper
          // fired on the first event of the day, over the pre-match overview.
          && state.scorePostedAt !== null
          && Date.now() - state.scorePostedAt > GAP_MS;
        if (!inGap) { gapFilledAt = null; return false; }
        if (gapFilledAt === state.scorePostedAt) return false;
        // Latched here rather than in run(), so a disarmed cue counts one
        // would-have-fired per gap instead of one per event for the whole gap.
        gapFilledAt = state.scorePostedAt;
        return true;
      },
      run: async ctx => { await ctx.scene('arcade'); },
    },
  ];
}

export class CueEngine {
  #bus: EventBus;
  #obs: ObsClient | null;
  #audio: HouseAudio | null = null;
  #scenes: SceneMap;
  #cues: Cue[];
  #autopilot = new Map<string, boolean>();
  #firedAt = new Map<string, number>();
  #would = new Map<string, number>();
  #errors = new Map<string, string | null>();
  #unsubscribe: (() => void) | null = null;

  constructor(bus: EventBus, obs: ObsClient | null,
              opts: { cues?: Cue[]; scenes?: Partial<SceneMap>; autopilot?: boolean } = {}) {
    this.#bus = bus;
    this.#obs = obs;
    this.#scenes = { ...DEFAULT_SCENES, ...opts.scenes };
    this.#cues = opts.cues ?? defaultCues();
    // Off by default. Nobody should discover automation by having it happen to
    // them mid-match; the producer switches cues on once they've watched them
    // be right.
    for (const cue of this.#cues) this.#autopilot.set(cue.id, opts.autopilot ?? false);
  }

  /** Set after construction: house audio is built later in boot than the cue
   *  engine, and threading it through the constructor would reorder both. */
  attachAudio(audio: HouseAudio | null): void { this.#audio = audio; }

  /** The scene names this show uses, so a console can offer the real ones
   *  rather than a hardcoded copy that drifts from the OBS collection. */
  get scenes(): SceneMap { return { ...this.#scenes }; }

  get status(): CueStatus[] {
    return this.#cues.map(c => ({
      id: c.id, name: c.name, does: c.does, needsObs: !!c.needsObs,
      autopilot: this.#autopilot.get(c.id) ?? false,
      firedAt: this.#firedAt.get(c.id) ?? null,
      wouldHaveFired: this.#would.get(c.id) ?? 0,
      lastError: this.#errors.get(c.id) ?? null,
    }));
  }

  setAutopilot(id: string, on: boolean): boolean {
    if (!this.#cues.some(c => c.id === id)) return false;
    this.#autopilot.set(id, on);
    return true;
  }

  setAll(on: boolean): void {
    for (const cue of this.#cues) this.#autopilot.set(cue.id, on);
  }

  /** Run a cue by hand, ignoring its autopilot setting. */
  async fire(id: string): Promise<boolean> {
    const cue = this.#cues.find(c => c.id === id);
    if (!cue) return false;
    await this.#run(cue, {
      id: 'manual', seq: 0, ts: Date.now(), matchClock: this.#bus.state.matchClock,
      source: 'manual', confidence: 'authoritative', type: 'graphic.show', payload: {},
    });
    return true;
  }

  attach(): () => void {
    this.#unsubscribe = this.#bus.subscribe((ev, state) => {
      // Cue-sourced events must never re-trigger cues.
      if (ev.source === 'cue') return;

      for (const cue of this.#cues) {
        let matches = false;
        try { matches = cue.when(ev, state); }
        catch (err) { this.#errors.set(cue.id, (err as Error).message); continue; }
        if (!matches) continue;

        if (!this.#autopilot.get(cue.id)) {
          this.#would.set(cue.id, (this.#would.get(cue.id) ?? 0) + 1);
          continue;
        }
        void this.#run(cue, ev);
      }
    });
    return this.#unsubscribe;
  }

  detach(): void { this.#unsubscribe?.(); this.#unsubscribe = null; }

  async #run(cue: Cue, event: DeskEvent): Promise<void> {
    const ctx: CueContext = {
      bus: this.#bus,
      obs: this.#obs,
      audio: this.#audio,
      event,
      state: this.#bus.state,
      scene: async name => {
        const sceneName = this.#scenes[name];
        // The community's #1 production rule: program never cuts away from
        // the full-field shot while a match is LIVE. "Every close-up action
        // stream ever missed the cool stuff." Autopilot honors the lock;
        // operator-driven events (manual fire, the replay console) still win.
        const live = this.#bus.state.matchStartedAt !== null;
        const operatorDriven = event.source === 'manual' || event.source === 'replay';
        if (live && !operatorDriven && name !== 'match') {
          console.log(`[cue] held scene "${sceneName}": match live, wide-shot lock`);
          return;
        }
        this.#bus.emit({ type: 'scene.change', source: 'cue', payload: { scene: sceneName } });
        // A missing OBS is not a failure. The graphics still switch; only the
        // camera cut is lost, and the switcher operator covers that.
        if (this.#obs?.connected) await this.#obs.setScene(sceneName);
      },
    };

    try {
      await cue.run(ctx);
      this.#firedAt.set(cue.id, Date.now());
      this.#errors.set(cue.id, null);
    } catch (err) {
      this.#errors.set(cue.id, (err as Error).message);
      console.warn(`[cue] ${cue.id} failed: ${(err as Error).message}`);
    }
  }
}
