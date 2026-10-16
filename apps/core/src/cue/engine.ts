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

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../bus.ts';
import type { DeskEvent, DeskState } from '../types.ts';
import type { ObsClient } from './obs.ts';
import type { HouseAudio } from '../audio/store.ts';

export interface CueContext {
  bus: EventBus;
  obs: ObsClient | null;
  event: DeskEvent;
  state: DeskState;
  /**
   * Run now: a person pressed this cue's own button. Not the same as the
   * event being operator-driven. A level cue (Fill the gap) runs on whatever
   * event arrives first after its moment, and that is often a press of
   * something else or a 'manual' event no person made, such as the house
   * audio poll's track change.
   */
  byHand: boolean;
  /**
   * Cut to one of the show's scenes. Resolves to the scene name it cut to,
   * or null when a lock held the cut (the wide shot during a live match, a
   * replay an operator has on air, or a screen the desk is holding), so a
   * cue whose whole point is the cut can tell "done" from "refused".
   */
  scene: (name: keyof typeof DEFAULT_SCENES) => Promise<string | null>;
  /** The OBS scene names this show uses, resolved, to map a name back to its key. */
  scenes: Readonly<SceneMap>;
  /**
   * The latest autopilot cut the replay lock held back while this replay
   * (a state.replayOnAir entry) was running, or null. What the show would
   * have cut to, had the operator's clip not been on air.
   */
  heldDuring: (replay: DeskState['replayOnAir']) => keyof SceneMap | null;
  /**
   * Run something later on this cue's behalf. Failures land on the cue's own
   * row like any other, and detach() cancels whatever is still waiting, so a
   * stopped engine never cuts a camera.
   */
  after: (ms: number, fn: () => void | Promise<void>) => void;
  /** Where the clip store writes, the only place a replay take may play from. */
  clipsDir: string;
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
   * True when `run` calls `ctx.scene`, so this cue ALSO cuts a camera.
   *
   * Not "cannot run without OBS". `ctx.scene` degrades on purpose: it emits
   * `scene.change` on the bus whatever happens and only reaches the switcher
   * `if (this.#obs?.connected)`, under the comment "A missing OBS is not a
   * failure. The graphics still switch; only the camera cut is lost." Four of
   * these cues emit their `screen.change` (the graphic the projectors and
   * the overlay render) before they ever call `scene`.
   *
   * So no cue fails with OBS away, and the desk must not disable any of them.
   * It first disabled every cue, then, briefly, the ones that cut a camera;
   * both were the same mistake, which is taking "talks to OBS" for "needs
   * OBS". The flag is kept because the distinction is still worth SAYING:
   * with OBS down these cues will switch the graphics and not the camera,
   * and the person on the switcher has to cover that cut by hand.
   *
   * Take replay is the one exception, and it fails out loud rather than
   * degrading: its whole job is OBS playing a file, and with no OBS there is
   * no graphic to fall back to. Cutting the stream to the replay scene anyway
   * aired the overlay over an empty source, so it refuses and says why.
   *
   * Declared rather than sniffed, and kept honest by a test that reads each
   * `run` back and fails if the two disagree.
   */
  needsObs?: boolean;
  /**
   * This match runs whether or not the cue's autopilot is armed. Asked only
   * once `when` has matched, with the same event and state.
   *
   * Mostly because the trigger is itself an operator's press (the replay
   * console's Take): manual always wins, and a Take that silently did
   * nothing because a toggle on another console was off is a button that
   * lies. An automatic event only ever rides past a disarmed cue to undo
   * something automation itself just did (see the plate cue).
   */
  take?: (ev: DeskEvent, state: DeskState) => boolean;
  when: (ev: DeskEvent, state: DeskState) => boolean;
  run: (ctx: CueContext) => void | Promise<void>;
}

export interface CueStatus {
  id: string;
  name: string;
  does: string;
  /** See Cue.needsObs: this cue also cuts an OBS scene when OBS is connected. */
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

/**
 * The OBS Media Source a replay take loads its clip into. Like the scene
 * names, OBS is told it by name, so the handbook has the operator create it
 * with exactly this name inside the replay scene, under the Overlay.
 */
export const REPLAY_INPUT = 'CG Replay Clip';

/**
 * rec/clips under the repo root: where index.ts points the ClipStore
 * (ROOT/rec, then clips). Derived the same way index.ts derives ROOT, from
 * this file's own location, so the two agree without being wired together.
 */
export const DEFAULT_CLIPS_DIR =
  resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'rec', 'clips');

/** Gap after which we assume there's no match imminent and fill. */
const GAP_MS = 3 * 60_000;

/**
 * A person did this: the desk, a phone remote, or the replay console. The
 * server stamps every socket emit 'manual', and the replay routes stamp
 * theirs 'replay'.
 */
const operatorDriven = (ev: DeskEvent): boolean =>
  ev.source === 'manual' || ev.source === 'replay';

/**
 * A clip the replay cue put on air is still running. Judged on the clock,
 * like the overlay judges it, because nothing arrives on the bus when a clip
 * ends. The reducer drops replayOnAir the moment the switcher cuts elsewhere
 * or the field arms, so this is only ever true while the clip really is the
 * picture.
 */
export function replayRunning(state: DeskState, now = Date.now()): boolean {
  const r = state.replayOnAir;
  return r !== null && now < r.at + r.seconds * 1000;
}

/**
 * The desk is deliberately holding the program: an award or a slide on the
 * plate, or any screen an operator has taken by hand. The hold only ever
 * guarded the overlay's screen, so automation kept cutting the CAMERA under
 * it: the gap filler to the arcade mid-ceremony, and, once the field's next
 * load started arriving in the ceremony's first minute, the On deck cue to
 * the field camera in the middle of an award. A held screen holds the camera
 * too.
 *
 * Judged by what is on the screen, never by state.award or state.slide
 * merely being set. Those stay set until somebody presses Clear or Hide,
 * and the handbook's way off a plate is Auto, which hands the screen back
 * and leaves both behind: the next load moves the program to the overview,
 * but a test of those two fields went on holding every automatic cut (On
 * deck, the buzzer, the score reveal) for the rest of the day. The plate
 * holds the camera while it is up, and award.show and slide.show take a
 * hold of their own as well.
 */
export function deskHolding(state: DeskState): boolean {
  return state.screenHold || state.screen === 'award' || state.screen === 'slide';
}

/**
 * Program screens drawn only by the Overlay source, which the handbook builds
 * into the match, score and replay scenes and not into the arcade or the
 * intro. Put up while the stream is on one of those two, they never reach
 * the stream at all. A sponsor card counts, and costs the most: the sponsor
 * report counts it as aired whether or not the stream could show it.
 */
const PLATE_SCREENS = new Set(['award', 'slide', 'selection', 'sponsor']);

/** An operator putting one of PLATE_SCREENS up by hand. */
const platePress = (ev: DeskEvent): boolean => operatorDriven(ev)
  && (ev.type === 'award.show' || ev.type === 'award.presented'
    || ev.type === 'slide.show' || ev.type === 'sponsor.show'
    || (ev.type === 'screen.change'
      && PLATE_SCREENS.has(String((ev.payload as { screen?: unknown } | null)?.screen))));

/**
 * The clip a take names, as a file directly inside rec/clips, or a thrown
 * reason. The socket that carries a take accepts any PIN holder's event, and
 * OBS plays whatever file it is handed straight onto the stream: licensed
 * music under media/audio included. Only what the clip store wrote may air.
 *
 * The replay console names the clip by its file NAME. Every event is fanned
 * out to every open socket, phones on the venue Wi-Fi included, and a path
 * put the desk laptop's own folder tree (the Windows user's name in it) on
 * all of them; the server now strips one from replay events on the way out,
 * so nothing may depend on it arriving. A name is looked for in rec/clips
 * and nowhere else, and only one shaped like the clip store's own names
 * (letters, digits, dot, dash and underscore) is looked for at all, so a
 * drive letter, a stream suffix or a climb never reaches the path code. A
 * path is still taken from an in-process caller, under the same rule.
 */
function clipFile(clipsDir: string, clip: { name?: unknown; path?: unknown }): string {
  const named = typeof clip.name === 'string' && clip.name !== '';
  if (!named && (typeof clip.path !== 'string' || !clip.path)) {
    throw new Error('This take carried no clip. Cut one on the replay console, then take it.');
  }
  if (named && !/^[\w-][\w.-]*$/.test(clip.name as string)) {
    throw new Error('That take does not name a replay clip in rec/clips, so it was not played.');
  }
  const file = named ? join(resolve(clipsDir), clip.name as string) : resolve(clip.path as string);
  const rel = relative(resolve(clipsDir), file);
  if (!rel || rel === '..' || isAbsolute(rel) || /[\\/]/.test(rel)
      || extname(file).toLowerCase() !== '.mp4') {
    throw new Error('That take does not name a replay clip in rec/clips, so it was not played.');
  }
  return file;
}

export function defaultCues(): Cue[] {
  // The gap-filler's condition is a level, not an edge: once a gap is three
  // minutes old it stays true on every bus event until the next match. The
  // latch makes it fire once per gap; without it the cue re-cut to the arcade
  // on every trivia join and schedule poll, stomping any manual OBS take.
  let gapFilledAt: number | null = null;
  // The last take the replay cue put on air (its state.replayOnAir entry, by
  // identity) and where it was going to cut back to. A take pressed while
  // that one is still the picture asks OBS where the show is and hears "the
  // replay scene", which is the first clip, not where the show came from.
  let lastTake: { entry: NonNullable<DeskState['replayOnAir']>; back: keyof SceneMap } | null = null;
  // The program screen as of the last event the plate cue judged, so it can
  // tell the selection board going up from the board staying up.
  let boardSeen: string | null = null;
  // The gap (its scorePostedAt) in which the gap filler really cut the
  // stream to the arcade. The plate cue undoes that cut for the selection
  // board armed or not: see its take.
  let arcadeCutIn: number | null = null;
  return [
    {
      id: 'on-deck',
      needsObs: true,
      name: 'On deck',
      does: 'Show the alliance overview when a match is loaded, and cut to the field camera scene, whose overlay carries it.',
      when: ev => ev.type === 'match.loaded',
      run: async ctx => {
        // Source 'cue' is load-bearing: the reducer lets cue-sourced screen
        // changes ride under an operator's hold instead of engaging one.
        ctx.bus.emit({ type: 'screen.change', source: 'cue', payload: { screen: 'overview' } });
        // The match scene, not the intro: the overview exists only inside
        // the Overlay source, and the handbook builds the intro scene as the
        // opening title with no Overlay in it. Cutting there put the title
        // card on the stream for every load-to-armed window of the day. The
        // overview is full-frame, so the camera under it never shows, and
        // the Armed cue's later cut to the same scene is seamless.
        await ctx.scene('match');
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
      take: operatorDriven,
      name: 'Take replay',
      does: `Play the clip the replay console takes in OBS's "${REPLAY_INPUT}" media source, cut to the replay scene, and cut back when the clip ends, unless the switcher has already cut away. A Take always runs, armed or not.`,
      when: ev => ev.type === 'replay.play',
      run: async ctx => {
        const clip = (ctx.event.payload ?? {}) as {
          name?: unknown; path?: unknown; label?: unknown; seconds?: unknown; takeId?: unknown;
        };
        // The take this one replaces, if any is still the picture. Read
        // before anything awaits, so the first clip ending in the meantime
        // cannot hide where the chain started.
        const prev = ctx.state.replayOnAir;
        // Echoed back so the console that pressed Take can tell its own
        // answer from another console's.
        const takeId = typeof clip.takeId === 'string' ? clip.takeId.slice(0, 64) : null;
        const label = String(clip.label ?? '').trim().slice(0, 90) || 'Replay';
        const seconds = Number(clip.seconds);
        const replayScene = ctx.scenes.replay;
        let scene: string | null;
        let before: string | null = ctx.state.scene;
        try {
          const file = clipFile(ctx.clipsDir, clip);
          if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
            throw new Error('This take carried no usable clip length. Cut the clip again, then take it.');
          }
          // Checked before anything moves, because every one of these used
          // to end the same way: the stream cut to the replay scene, which
          // is the overlay over an empty source, and the console said "Sent".
          // The file name rides in the message: with the desk unable to play
          // it, loading it by hand is the operator's only way to air it. And
          // the program screen goes to Blank first, because the overlay only
          // stands aside for a clip the desk itself put on air, and after a
          // match it is showing the full-frame Final, which would cover it.
          const name = basename(file);
          if (!ctx.obs?.connected) {
            throw new Error('OBS is not connected to the desk, so the clip did NOT go to air. '
              + 'To air it by hand: put the program screen on Blank, load '
              + `${name} from the desk's rec\\clips folder into OBS's "${REPLAY_INPUT}" source, `
              + `then cut to ${replayScene}.`);
          }
          if (!ctx.obs.local) {
            throw new Error('OBS runs on another machine, which cannot open the desk\'s clip files, '
              + 'so the clip did NOT go to air. To air it by hand: put the program screen on Blank, '
              + `copy ${name} from the desk's rec\\clips folder to the OBS machine and play it there.`);
          }
          const st = await stat(file).catch(() => null);
          if (!st?.isFile()) {
            throw new Error('That clip is no longer on the desk\'s disk. Cut it again, then take it.');
          }
          // Where to come back to when the clip has run. Asked of OBS, not
          // taken from the desk's own last cut, because the handbook has the
          // switcher cut by hand in OBS too; a failed question only loses
          // the precision, never the take.
          before = await ctx.obs.programScene().catch(() => null) ?? before;
          try {
            await ctx.obs.playMedia(REPLAY_INPUT, file);
          } catch (err) {
            throw new Error(`OBS did not take the clip (${(err as Error).message}). The replay `
              + `scene needs a Media Source named exactly "${REPLAY_INPUT}" (handbook chapter 4).`);
          }
          scene = await ctx.scene('replay');
          if (scene === null) throw new Error('A lock held the cut to the replay scene.');
          // scene() skips the switcher when OBS went away in the moments
          // since the check above; that cut never reached the stream.
          if (!ctx.obs.connected) throw new Error('OBS dropped before the cut, so the clip did NOT go to air.');
        } catch (err) {
          ctx.bus.emit({
            type: 'replay.failed', source: 'cue',
            payload: { takeId, label, error: (err as Error).message },
          });
          throw err;
        }
        // Only now: the overlay stands aside on this, and it must never
        // stand aside for a clip that is not actually playing.
        ctx.bus.emit({
          type: 'replay.on_air', source: 'cue',
          payload: { takeId, label, seconds, scene },
        });
        // This take's own entry, by identity: the reducer makes a new one
        // for every take, and keeps it only while nobody has moved on.
        const mine = ctx.bus.state.replayOnAir;

        // And back when the clip has run. Left on the replay scene, the
        // stream showed the overlay over a finished media source: the score
        // bar over black, which is the failure a Take used to produce on its
        // own. Back to whatever was on program before the take, or the field
        // camera when that is unknown or not one of ours; unless autopilot
        // wanted a cut while the clip ran (the next match loading, say) and
        // was held for it, in which case that cut, late. Only while this
        // take is still the picture: a cut elsewhere (at the desk or in OBS
        // itself), the field arming or a newer take has already decided what
        // comes next, and nothing here undoes it.
        const ours = (Object.keys(ctx.scenes) as (keyof SceneMap)[])
          .find(k => k !== 'replay' && ctx.scenes[k] === before);
        // Taken over another take (two replays in a row): where that one
        // was going, or the cut autopilot held for it, so the chain ends
        // where the show was before its first clip.
        const chained = before === replayScene && prev !== null
          && lastTake !== null && lastTake.entry === prev
          ? ctx.heldDuring(prev) ?? lastTake.back : null;
        const back = ours ?? chained ?? 'match';
        if (mine !== null) lastTake = { entry: mine, back };
        const stillMine = (): boolean => {
          const now = ctx.bus.state;
          return mine !== null && now.replayOnAir === mine && now.scene === scene;
        };
        ctx.after(seconds * 1000, async () => {
          if (!stillMine()) return;
          // And OBS agrees. The desk hears nothing of a cut made in OBS's
          // own Scenes panel, so its record can still say the clip is up
          // after the switcher has cut to the field as play resumed, and
          // cutting back then pulled the stream off the live field. A
          // question OBS cannot answer loses only this check, never the cut.
          const live = await ctx.obs?.programScene().catch(() => null) ?? null;
          if (live !== null && live !== scene) return;
          // Asked over the wire: a newer take or a cut may have landed meanwhile.
          if (!stillMine()) return;
          await ctx.scene(ctx.heldDuring(mine) ?? back);
        });
      },
    },
    {
      id: 'gap-filler',
      needsObs: true,
      name: 'Fill the gap',
      does: 'Cut to the arcade when a score has been up three minutes and no next match is loaded: the end of a session, or a field stall. Never over an award, a slide, a held screen or a replay.',
      // Keyed on scorePostedAt, which the next match's load clears, and that
      // is deliberate. On a real field the next match now reaches the desk
      // 20 to 60 seconds after a post, so this never fires between ordinary
      // matches; it fills the gaps where nothing is on deck: after Friday's
      // practice, between the last qual and alliance selection, after the
      // last final (the arena's test match never reaches the desk), and any
      // stall where the arena loads nothing. Keying it on something that
      // survives the load would cut the stream away from the next match's
      // overview a minute or two before every match, and leave a match to
      // start on the arcade wherever the Armed cue is not armed.
      //
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
        // A desk that is deliberately holding something has filled the gap
        // itself: an award, a slide, any screen an operator has taken, or a
        // replay running. The hold only ever guarded the overlay's screen,
        // so three minutes after the day's last score this cut OBS to the
        // arcade capture in the middle of the awards ceremony. A held screen
        // holds the camera too. Latched rather than deferred, so the arcade
        // does not jump in the instant the ceremony's last plate comes down.
        // The selection board counts as well, held or not: the field puts it
        // up by itself when the arena starts alliance selection, which is
        // exactly the gap after the last qual, and the arcade carries no
        // overlay to show it on.
        if (deskHolding(state) || state.screen === 'selection' || replayRunning(state)) return false;
        return true;
      },
      run: async ctx => {
        const cut = await ctx.scene('arcade');
        // Only automation's own cut is the plate cue's to take back; a Run
        // now is a person's, and nothing automatic undoes one of those.
        // Judged by how the cue ran, not by the event's source: the event
        // that crosses the three-minute mark is often a press of something
        // else, or the house audio poll's 'manual' track change.
        if (cut !== null && !ctx.byHand) arcadeCutIn = ctx.state.scorePostedAt;
      },
    },
    {
      id: 'plate-back',
      needsObs: true,
      name: 'Plates on the stream',
      does: 'Cut back to the field camera scene when an award, a slide, a sponsor card or the selection board goes up while the stream is on the arcade or the intro, the two scenes with no overlay to carry it. Showing any of those by hand always runs it, armed or not, and so does the board going up after Fill the gap cut to the arcade.',
      // Armed or not for a press, which is the trigger itself. And for the
      // board the field puts up by itself in a gap where Fill the gap cut
      // the stream to the arcade: automation is only taking back its own
      // cut there. This cue ships disarmed and cannot earn a count to be
      // trusted on before Sunday's selection, so waiting for it to be armed
      // left the whole of selection on the arcade behind an armed Fill the
      // gap. Anywhere else the board's automatic cut waits for the producer
      // like any other automation.
      take: (ev, state) => platePress(ev)
        || (arcadeCutIn !== null && arcadeCutIn === state.scorePostedAt),
      // An edge, not a level: once a plate is up the producer may cut to any
      // camera they like for the presentation, and this must not fight them
      // on every event after. A press is its own edge. The board the field
      // puts up by itself arrives as a cue-sourced screen change, which this
      // engine never sees (cues must not trigger cues), so it is caught on
      // the next event that does arrive (the board republishes on every pick
      // and once a second while its clock runs) as the screen having become
      // the board since the last one.
      when: (ev, state) => {
        if (operatorDriven(ev)) {
          // Any other press leaves the edge for the next automatic event, so
          // an unrelated tap cannot swallow the board's automatic cut.
          if (!platePress(ev)) return false;
          boardSeen = state.screen;
          return PLATE_SCREENS.has(state.screen);
        }
        const rose = state.screen === 'selection' && boardSeen !== 'selection';
        boardSeen = state.screen;
        return rose;
      },
      run: async ctx => {
        // Asked of OBS, as the replay cue asks: the switcher cuts by hand in
        // OBS's own Scenes panel too, and the desk hears nothing of that. A
        // question OBS cannot answer falls back to the desk's own last cut.
        const live = await ctx.obs?.programScene().catch(() => null) ?? ctx.state.scene;
        if (live !== ctx.scenes.arcade && live !== ctx.scenes.intro) return;
        await ctx.scene('match');
      },
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
  #clipsDir: string;
  /** Work a cue left for later (see CueContext.after); detach() cancels it. */
  #later = new Set<NodeJS.Timeout>();
  /** See CueContext.heldDuring: the last cut the replay lock held, and for which replay. */
  #heldForReplay: { key: keyof SceneMap; replay: DeskState['replayOnAir'] } | null = null;

  /** See the constructor's armedFile. Null: nothing is kept. */
  #armedFile: string | null;
  /** The tail of the arm-switch writes. Never rejects; see #saveArmed. */
  #savingArmed: Promise<void> = Promise.resolve();

  constructor(bus: EventBus, obs: ObsClient | null,
              opts: {
                cues?: Cue[]; scenes?: Partial<SceneMap>; autopilot?: boolean;
                /** The ClipStore's output directory. See DEFAULT_CLIPS_DIR. */
                clipsDir?: string;
                /**
                 * Where the arm switches are kept across a restart
                 * (data/cues.json). Left out, nothing is kept: the tests, and
                 * the rehearsal and preview desks, which must leave no mark.
                 */
                armedFile?: string;
              } = {}) {
    this.#bus = bus;
    this.#obs = obs;
    this.#clipsDir = opts.clipsDir ?? DEFAULT_CLIPS_DIR;
    this.#scenes = { ...DEFAULT_SCENES, ...opts.scenes };
    this.#cues = opts.cues ?? defaultCues();
    this.#armedFile = opts.armedFile ?? null;
    // Off by default. Nobody should discover automation by having it happen to
    // them mid-match; the producer switches cues on once they've watched them
    // be right.
    for (const cue of this.#cues) this.#autopilot.set(cue.id, opts.autopilot ?? false);
  }

  /**
   * The arm switches as the crew left them, back after a restart.
   *
   * They lived only in memory, and the packaged desk has no --autopilot, so a
   * crew that armed every cue at doors (as the handbook says to) and then
   * restarted mid-day (a kicked cable, a crash, the handbook's own fix of
   * closing the desk and starting it again) came back with every cue
   * silently off: no On deck, no Armed, no score reveal, the music still
   * playing under the countdown, and a stream the gap filler had cut to the
   * arcade left there through the next match start. The switches are the
   * producer's decisions, the same as a staged winner, so they are kept the
   * same way.
   *
   * Only the cues this desk has, and only a true or false for each: a file
   * from an older desk, or a hand edit, cannot arm something by accident.
   * Anything it does not mention stays off. Returns the ids now armed.
   */
  async restoreArmed(): Promise<string[]> {
    if (!this.#armedFile) return [];
    let saved: unknown;
    try {
      saved = (JSON.parse(await readFile(this.#armedFile, 'utf8')) as { armed?: unknown })?.armed;
    } catch (err) {
      // No file is the first boot of the event, and nothing to say.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[cue] the saved cue switches could not be read, every cue starts off:',
          (err as Error).message);
      }
      return [];
    }
    if (!saved || typeof saved !== 'object') return [];
    for (const cue of this.#cues) {
      const on = (saved as Record<string, unknown>)[cue.id];
      if (typeof on === 'boolean') this.#autopilot.set(cue.id, on);
    }
    return this.#cues.filter(c => this.#autopilot.get(c.id)).map(c => c.id);
  }

  /** Settles once every arm switch changed so far is on disk, or has failed and said so. */
  get armedSaved(): Promise<void> { return this.#savingArmed; }

  /**
   * One writer at a time, through a fixed temp name renamed into place: the
   * rename is atomic against a reader, so a power cut mid-write leaves the
   * last good file rather than half of one, and the queue keeps two quick
   * presses from racing each other for the temp file (see Awards#save).
   * Each write carries the switches as they stood when it was asked for, so
   * the last one on disk is the last press.
   */
  #saveArmed(): void {
    const file = this.#armedFile;
    if (!file) return;
    const armed = Object.fromEntries(this.#cues.map(c => [c.id, this.#autopilot.get(c.id) ?? false]));
    const write = async (): Promise<void> => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify({ armed }, null, 2));
        await rename(tmp, file);
      } catch (err) {
        // The switches still hold for this session; only a restart loses them.
        console.warn('[cue] the cue switches could not be saved:', (err as Error).message);
      }
    };
    this.#savingArmed = this.#savingArmed.then(write, write);
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
    this.#saveArmed();
    return true;
  }

  setAll(on: boolean): void {
    for (const cue of this.#cues) this.#autopilot.set(cue.id, on);
    this.#saveArmed();
  }

  /** Run a cue by hand, ignoring its autopilot setting. */
  async fire(id: string): Promise<boolean> {
    const cue = this.#cues.find(c => c.id === id);
    if (!cue) return false;
    await this.#run(cue, {
      id: 'manual', seq: 0, ts: Date.now(), matchClock: this.#bus.state.matchClock,
      source: 'manual', confidence: 'authoritative', type: 'graphic.show', payload: {},
    }, true);
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

        // See Cue.take: a press that IS the trigger runs disarmed.
        let take = false;
        try { take = !!cue.take?.(ev, state); }
        catch (err) { this.#errors.set(cue.id, (err as Error).message); }
        if (!this.#autopilot.get(cue.id) && !take) {
          this.#would.set(cue.id, (this.#would.get(cue.id) ?? 0) + 1);
          continue;
        }
        void this.#run(cue, ev);
      }
    });
    return this.#unsubscribe;
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const t of this.#later) clearTimeout(t);
    this.#later.clear();
  }

  async #run(cue: Cue, event: DeskEvent, byHand = false): Promise<void> {
    const ctx: CueContext = {
      bus: this.#bus,
      obs: this.#obs,
      audio: this.#audio,
      event,
      byHand,
      state: this.#bus.state,
      clipsDir: this.#clipsDir,
      scenes: { ...this.#scenes },
      heldDuring: replay => (replay !== null && this.#heldForReplay?.replay === replay
        ? this.#heldForReplay.key : null),
      after: (ms, fn) => {
        const t = setTimeout(() => {
          this.#later.delete(t);
          Promise.resolve()
            .then(fn)
            .catch((err: unknown) => {
              this.#errors.set(cue.id, (err as Error).message);
              console.warn(`[cue] ${cue.id} failed later: ${(err as Error).message}`);
            });
        }, Math.max(0, ms));
        // Never what keeps the process up at shutdown.
        t.unref();
        this.#later.add(t);
      },
      scene: async name => {
        const sceneName = this.#scenes[name];
        // The community's #1 production rule: program never cuts away from
        // the full-field shot while a match is LIVE. "Every close-up action
        // stream ever missed the cool stuff." Autopilot honors the lock;
        // operator-driven events (manual fire, the replay console) still win.
        const live = this.#bus.state.matchStartedAt !== null;
        if (live && !operatorDriven(event) && name !== 'match') {
          console.log(`[cue] held scene "${sceneName}": match live, wide-shot lock`);
          return null;
        }
        // The same rule for a replay an operator put on air: autopilot does
        // not cut the stream away from it while the clip runs. The next
        // load's overview or a score posting mid-clip used to cut a replay
        // off halfway through the action. Held here and remembered, the
        // overlay brings that screen up the moment the clip ends and the
        // take's own cut back goes where this cut wanted to. The field
        // arming is not held: the reducer drops the replay the instant the
        // field goes ready.
        if (!operatorDriven(event) && replayRunning(this.#bus.state)) {
          console.log(`[cue] held scene "${sceneName}": replay on air`);
          this.#heldForReplay = { key: name, replay: this.#bus.state.replayOnAir };
          return null;
        }
        // And the same again for anything the desk is holding: an award, a
        // slide, a screen taken by hand. The score hold moved the next
        // match's load into the ceremony's first minute, and On deck cut the
        // stream from the presentation camera to the field mid-award. See
        // deskHolding.
        //
        // The field going ready or live gets through, which is the wide-shot
        // rule above: a plate an operator forgot to take down must not keep
        // the camera off a match being played, and this hold has no moment
        // of its own to hand the cut back at, the way a replay ending does.
        // Not remembered for that reason: the press that ends a hold is the
        // operator's, and they may be about to show the next award on the
        // same camera. (The plate cue needs no way through: its presses are
        // an operator's, and the board it brings back by itself is held only
        // when an operator took it by hand, a press that already ran it.)
        const fieldGoing = name === 'match'
          && (event.type === 'match.armed' || event.type === 'match.start');
        if (!operatorDriven(event) && !fieldGoing && deskHolding(this.#bus.state)) {
          console.log(`[cue] held scene "${sceneName}": the desk is holding the screen`);
          return null;
        }
        this.#bus.emit({ type: 'scene.change', source: 'cue', payload: { scene: sceneName } });
        // A missing OBS is not a failure. The graphics still switch; only the
        // camera cut is lost, and the switcher operator covers that.
        if (this.#obs?.connected) await this.#obs.setScene(sceneName);
        return sceneName;
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
