/**
 * Trivia store. Host-authoritative lifecycle, server-authoritative answers.
 *
 * The one security property that matters: THE CORRECT ANSWER NEVER LEAVES THE
 * SERVER BEFORE REVEAL. This is a gym full of teenagers who build robots for
 * fun. Assume someone opens dev tools. `snapshot()` and `playView()` only
 * carry `answer` once the question is revealed, and scoring happens here, not
 * on the phone.
 */

import type { EventBus } from '../bus.ts';
import {
  award, pickQuestion, publicStandings, resolvePick, standings,
  type PublicStanding, type TriviaAnswer, type TriviaPhase, type TriviaPlayer, type TriviaQuestion,
} from './model.ts';
import { DEFAULT_QUESTIONS } from './questions.ts';
import { screenName } from './names.ts';

const MAX_PLAYERS = 500;
const MAX_NAME = 24;

export interface TriviaSnapshot {
  phase: TriviaPhase;
  players: number;
  questionIndex: number;
  questionCount: number;
  /** Null while idle. `answer` is null until revealed: that is the contract. */
  question: {
    text: string;
    options: string[];
    category: string | null;
    answer: number | null;
    opensAt: number;
    closesAt: number;
    /** Live answer counts per option. Counts don't leak which one is right. */
    distribution: number[];
    answers: number;
  } | null;
  standings: PublicStanding[];
  asked: number;
  joinUrl: string | null;
  /** Rounds and their progress, so the host can pick one per gap and the
   *  audience can be told there is more coming after the next match. */
  sessions: { name: string; size: number; asked: number; done: boolean }[];
  /** Where the cursor is: "Round 2, question 3 of 6". Null on an empty bank. */
  session: { name: string; position: number; size: number } | null;
}

/**
 * An untrusted question, straight off a form or an HTTP body.
 *
 * Deliberately looser than `TriviaQuestion`. The whole job of `#validate` is to
 * turn one of these into the strict shape, so typing the input as the output
 * would mean the caller had already done the validating.
 */
export interface QuestionDraft {
  id?: unknown;
  text?: unknown;
  options?: unknown;
  answer?: unknown;
  category?: unknown;
}

export interface PlayView {
  phase: TriviaPhase;
  players: number;
  questionIndex: number;
  questionCount: number;
  question: {
    text: string; options: string[]; category: string | null;
    opensAt: number; closesAt: number;
  } | null;
  /** Post-reveal only. */
  answer: number | null;
  me: {
    name: string;
    score: number;
    rank: number | null;
    choice: number | null;
    /** Post-reveal only: whether the locked choice was right. */
    correct: boolean | null;
  } | null;
}

export class TriviaStore {
  #bus: EventBus;
  #questions: TriviaQuestion[];
  #players = new Map<string, TriviaPlayer>();
  #phase: TriviaPhase = 'idle';
  #index = 0;
  #asked = 0;
  /** Which questions have been revealed, by id. Drives per-session progress. */
  #askedIds = new Set<string>();
  #opensAt = 0;
  #closesAt = 0;
  #answers = new Map<string, TriviaAnswer>();
  #closeTimer: NodeJS.Timeout | null = null;
  #joinUrl: string | null = null;
  #seq = 0;

  constructor(bus: EventBus, questions: TriviaQuestion[] = DEFAULT_QUESTIONS) {
    this.#bus = bus;
    this.#questions = questions;
  }

  setJoinUrl(url: string): void { this.#joinUrl = url; }

  #publish(): void {
    this.#bus.emit({ type: 'trivia.updated', source: 'manual', payload: this.snapshot() });
  }

  #current(): TriviaQuestion | null { return this.#questions[this.#index] ?? null; }

  // ---- sessions -------------------------------------------------------------
  //
  // A session is one round the gym plays in one gap between matches. The day is
  // a series of them and scores carry across, which is the only shape that
  // survives contact with a real event: a host who opens question one at 10am
  // gets interrupted by the field two questions in, and without rounds the
  // game is simply never picked up again.
  //
  // Derived from the bank rather than stored separately, so editing questions
  // on the host console cannot leave a session list pointing at nothing.

  /** Contiguous runs of questions sharing a session name, in playing order. */
  #sessionRuns(): { name: string; start: number; size: number }[] {
    const runs: { name: string; start: number; size: number }[] = [];
    this.#questions.forEach((q, i) => {
      // A bank with no sessions at all is one long round, which is exactly how
      // every bank behaved before sessions existed.
      const name = q.session ?? 'Trivia';
      const last = runs[runs.length - 1];
      if (last && last.name === name && last.start + last.size === i) last.size++;
      else runs.push({ name, start: i, size: 1 });
    });
    return runs;
  }

  /** Rounds with their progress, for the host's picker and the overlay. */
  get sessions(): { name: string; size: number; asked: number; done: boolean }[] {
    return this.#sessionRuns().map(run => {
      const asked = this.#questions
        .slice(run.start, run.start + run.size)
        .filter(q => this.#askedIds.has(q.id)).length;
      return { name: run.name, size: run.size, asked, done: asked >= run.size };
    });
  }

  /**
   * Jump to a round and wait there.
   *
   * Lands on the first question of that round nobody has answered yet, so
   * picking a half-finished round after a match resumes it rather than
   * replaying it. Refuses while a question is open: the host would be
   * abandoning a question the whole gym is currently answering.
   *
   * And refuses a round that is already finished, which used to rewind
   * silently to its first question. After lunch the host mis-taps the played
   * "Round 1" instead of "Round 4"; question one re-airs, reveal pays every
   * correct answer a second time, and the day-long leaderboard is quietly
   * wrong with nothing on screen having looked unusual.
   */
  startSession(name: string): TriviaSnapshot {
    if (this.#phase === 'open') {
      throw new Error('A question is open. Reveal it before changing rounds.');
    }
    // The first run with anything left in it, not simply the first run with
    // this name: a question added mid-round splits the round in two, and
    // find() always handed back the played half.
    const runs = this.#sessionRuns().filter(r => r.name === name);
    if (!runs.length) throw new Error(`There is no round called "${name}".`);
    const run = runs.find(r => this.#questions
      .slice(r.start, r.start + r.size)
      .some(q => !this.#askedIds.has(q.id)));
    if (!run) {
      throw new Error(`"${name}" has already been played all the way through. ` +
        'Pick a round with questions left, or reset the scores to start over.');
    }

    const slice = this.#questions.slice(run.start, run.start + run.size);
    const fresh = slice.findIndex(q => !this.#askedIds.has(q.id));
    this.#index = run.start + (fresh === -1 ? 0 : fresh);
    this.#phase = 'idle';
    this.#answers.clear();
    if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
    this.#publish();
    return this.snapshot();
  }

  // ---- players --------------------------------------------------------------

  /**
   * The ceiling alone made the open join a denial of service: 500 scripted
   * joins filled the room for the day, and the only way to free a slot was a
   * hard reset that also dropped every real player. Under pressure, the
   * longest-idle player who has never locked a SINGLE answer gives up their
   * slot; a rejoin restores everything they had, which is nothing. Idle means
   * "answered nothing all game", not "scored nothing" — a player who answered
   * five questions wrong has been playing, and evicting them mid-question in
   * favor of a joined-and-left squatter would be exactly backwards.
   */
  #evictOneIdle(): void {
    let idle: TriviaPlayer | null = null;
    for (const p of this.#players.values()) {
      if (p.answered > 0 || p.score > 0 || p.correct > 0 || this.#answers.has(p.id)) continue;
      if (!idle || p.joinedAt < idle.joinedAt) idle = p;
    }
    if (idle) this.#players.delete(idle.id);
  }

  join(rawName: string, team?: number): { playerId: string; name: string } {
    // Validate BEFORE any eviction: a join that cannot succeed (blank name)
    // must never cost a real player their slot. Evict-then-throw meant one
    // phone posting empty names could knock idle audience members out of a
    // full room without ever joining.
    const name = String(rawName ?? '').trim().slice(0, MAX_NAME);
    if (!name) throw new Error('A name is required.');
    // This name goes on a projector in front of a room full of children and
    // the school that lent us the building. Screened BEFORE eviction, with
    // every other validation, so a phone posting names it knows will be
    // refused cannot cost real players their slots.
    const verdict = screenName(name);
    if (!verdict.ok) throw new Error(verdict.reason ?? 'Pick a different name.');
    if (this.#players.size >= MAX_PLAYERS) this.#evictOneIdle();
    if (this.#players.size >= MAX_PLAYERS) throw new Error('Trivia is full: 500 players.');
    const id = `p${(++this.#seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const player: TriviaPlayer = {
      id, name,
      ...(team && Number.isInteger(team) && team > 0 && team < 100000 ? { team } : {}),
      score: 0, correct: 0, answered: 0, joinedAt: Date.now(),
    };
    this.#players.set(id, player);
    this.#publish();
    return { playerId: id, name };
  }

  // ---- host lifecycle -------------------------------------------------------

  /** Open the current question for `seconds`. */
  open(seconds = 20): TriviaSnapshot {
    const q = this.#current();
    if (!q) throw new Error('No more questions. Reset to run the bank again.');
    if (this.#phase === 'open') throw new Error('A question is already open.');
    // 'revealed' blocks too: reveal() does not advance the cursor, so opening
    // from here would re-air the question whose correct answer is currently
    // on the big screen — and a second reveal would pay everyone again. The
    // host who forgot Next gets told, not obeyed.
    if (this.#phase === 'revealed') {
      throw new Error('The answer is still on the screen. Hit Next first.');
    }
    this.#phase = 'open';
    this.#answers.clear();
    this.#opensAt = Date.now();
    this.#closesAt = this.#opensAt + Math.max(5, Math.min(120, seconds)) * 1000;
    // Publish once when the window shuts so overlays flip to "locked" together.
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = setTimeout(() => this.#publish(), this.#closesAt - this.#opensAt);
    this.#publish();
    return this.snapshot();
  }

  /** Lock in one answer per player. Scored server-side at reveal. */
  answer(playerId: string, choice: number): { locked: boolean } {
    if (this.#phase !== 'open') throw new Error('No question is open.');
    if (Date.now() > this.#closesAt) throw new Error('Time is up.');
    const player = this.#players.get(playerId);
    if (!player) throw new Error('Join first.');
    const q = this.#current()!;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) {
      throw new Error('Bad choice.');
    }
    if (this.#answers.has(playerId)) return { locked: true };   // first answer stands
    this.#answers.set(playerId, { choice, at: Date.now() });
    player.answered++;   // participation, right or wrong — eviction runs on this
    this.#publish();
    return { locked: true };
  }

  /**
   * Queue a pick-the-winner round on the match that is loaded.
   *
   * It goes in front of the bank rather than into it, because the question is
   * only meaningful until that match is scored. Opening it is the host's call:
   * it wants the pre-match gap, not the middle of auto.
   */
  pick(): TriviaSnapshot {
    // Idle only, not just not-open: splicing at the cursor while a revealed
    // question is still on screen re-queued that question behind the pick,
    // so it was asked and paid a second time.
    if (this.#phase !== 'idle') {
      throw new Error('A question is on the screen. Move on with Next first.');
    }
    const match = this.#bus.state.match;
    const name = match?.displayName;
    if (!name) throw new Error('No match is loaded, so there is nothing to pick.');

    const q = pickQuestion(name, match?.id ?? null);
    if (this.#questions.some(existing => existing.id === q.id)) {
      throw new Error(`${name} has already been picked.`);
    }
    // It joins the round it lands in rather than carrying its own name.
    // Splicing a differently-named question into the middle of a round SPLIT
    // that round in two: the picker listed it twice, and resuming it after the
    // next match jumped back into the half already played.
    this.#questions.splice(this.#index, 0,
      { ...q, session: this.#questions[this.#index]?.session ?? q.session });
    this.#publish();
    return this.snapshot();
  }

  // ---- editing the bank -----------------------------------------------------

  /**
   * The bank as the host sees it, answers included.
   *
   * Safe because this is a desk-only endpoint: the phone view goes through
   * `playView()`, which never carries an unrevealed answer. The host has to
   * see answers to edit them.
   */
  bank(): (TriviaQuestion & { live: boolean })[] {
    return this.#questions.map((q, i) => ({
      ...q,
      live: i === this.#index && this.#phase !== 'idle',
    }));
  }

  /**
   * Reject anything that would put a broken question on the big screen.
   *
   * `preserve` carries fields the generic edit form never shows: `kind` and
   * `matchId` mark a pick-the-winner round and, without this, editing one
   * through the same form as an ordinary question would silently strip both
   * and leave it scored as a fact whose "correct" answer is just the
   * placeholder it was created with.
   */
  #validate(draft: QuestionDraft, preserve?: Pick<TriviaQuestion, 'kind' | 'matchId'>): TriviaQuestion {
    const text = String(draft.text ?? '').trim();
    if (!text) throw new Error('The question needs text.');

    const options = (Array.isArray(draft.options) ? draft.options : [])
      .map(o => String(o ?? '').trim());
    if (options.length !== 4 || options.some(o => !o)) {
      throw new Error('Four answer options are required, and none can be blank.');
    }

    const answer = Number(draft.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
      throw new Error('Mark which option is correct.');
    }

    return {
      id: String(draft.id ?? `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`),
      text,
      options: options as [string, string, string, string],
      answer: answer as 0 | 1 | 2 | 3,
      ...(draft.category ? { category: String(draft.category).trim() } : {}),
      ...(preserve?.kind ? { kind: preserve.kind } : {}),
      ...(preserve?.matchId !== undefined ? { matchId: preserve.matchId } : {}),
    };
  }

  /**
   * The question at `index` is the one the room is looking at, from the moment
   * it opens until the host moves on. Revealed still counts: the answer is on
   * the big screen. Editing it there would change the answer under people who
   * have already locked one in, so it is refused rather than allowed to
   * corrupt a round.
   */
  #assertNotLive(index: number): void {
    if (this.#phase !== 'idle' && index === this.#index) {
      throw new Error('That question is on the screen right now. Move on with Next first.');
    }
  }

  addQuestion(draft: QuestionDraft): TriviaSnapshot {
    this.#questions.push(this.#validate(draft));
    this.#publish();
    return this.snapshot();
  }

  editQuestion(index: number, draft: QuestionDraft): TriviaSnapshot {
    const existing = this.#questions[index];
    if (!existing) throw new Error('No such question.');
    this.#assertNotLive(index);
    // Keep the id so a half-finished edit cannot silently fork a duplicate.
    this.#questions[index] = this.#validate(
      { ...draft, id: existing.id },
      { kind: existing.kind, matchId: existing.matchId },
    );
    this.#publish();
    return this.snapshot();
  }

  removeQuestion(index: number): TriviaSnapshot {
    if (!this.#questions[index]) throw new Error('No such question.');
    this.#assertNotLive(index);
    this.#questions.splice(index, 1);
    // Removing something already asked would otherwise shift the cursor onto a
    // question the room has just seen.
    if (index < this.#index) this.#index--;
    this.#index = Math.max(0, Math.min(this.#index, this.#questions.length));
    this.#publish();
    return this.snapshot();
  }

  /** Move one question up or down the running order. */
  moveQuestion(index: number, delta: number): TriviaSnapshot {
    const to = index + delta;
    if (!this.#questions[index] || !this.#questions[to]) return this.snapshot();
    this.#assertNotLive(index);
    this.#assertNotLive(to);
    // While idle, the cursor is the asked/unasked boundary, and a move that
    // crosses it cannot be represented: it either drags an unasked question
    // into the asked region (silently never aired) or pushes an asked one
    // back under the cursor (re-aired, and re-paid at reveal). Moves within
    // either region leave the boundary untouched, so they are fine as-is.
    if (this.#phase === 'idle') {
      const crosses = (index < this.#index) !== (to < this.#index);
      if (crosses) {
        throw new Error('That would move a question across the already-asked line. '
          + 'Reorder within the un-asked part of the bank, or Reset to start over.');
      }
    }
    const live = this.#phase !== 'idle' ? this.#current() : null;
    const [q] = this.#questions.splice(index, 1);
    this.#questions.splice(to, 0, q!);
    // A move that crosses the cursor shifts everything between its endpoints
    // by one, which once swapped the on-screen question mid-round. The cursor
    // follows its question, not its number.
    if (live) this.#index = this.#questions.indexOf(live);
    this.#publish();
    return this.snapshot();
  }

  reveal(): TriviaSnapshot {
    if (this.#phase !== 'open') throw new Error('Nothing to reveal.');
    const q = this.#current()!;

    // A prediction round has no answer until the field produces one. Reading
    // it here, at reveal, is also what makes it unleakable: there is nothing
    // to leak while the question is open.
    if (q.kind === 'match') {
      if (this.#bus.state.scorePostedAt === null) {
        throw new Error('The score is not posted yet, so there is no winner to reveal.');
      }
      // The host can sit on an open prediction while the field moves on to a
      // later match, whose own score_posted would otherwise look like a valid
      // answer. Refuse rather than resolve a match's prediction against a
      // different match's score; next() is the way out, and discards the
      // round unscored.
      if (q.matchId != null && this.#bus.state.match?.id !== q.matchId) {
        throw new Error(
          'The field has moved on to a different match, so this prediction cannot be '
          + 'revealed against it.',
        );
      }
      const { red, blue } = this.#bus.state.score;
      q.answer = resolvePick(red.total, blue.total);
    }
    for (const [playerId, a] of this.#answers) {
      if (a.choice !== q.answer) continue;
      const player = this.#players.get(playerId);
      if (!player) continue;
      player.score += award(this.#opensAt, this.#closesAt, a.at);
      player.correct++;
    }
    this.#phase = 'revealed';
    this.#asked++;
    // By id, not by index: the host can reorder or delete questions mid-show,
    // and a per-session "3 of 6 done" counted off indices would drift the
    // moment they did.
    this.#askedIds.add(q.id);
    if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
    this.#publish();
    return this.snapshot();
  }

  /** Advance to the next question and drop back to idle (leaderboard beat). */
  next(): TriviaSnapshot {
    if (this.#phase === 'open') {
      // reveal() rightly refuses to resolve a prediction against a different
      // match's score, but that once trapped the host: with the field moved
      // on, every action threw and the only exit was a reset that wiped the
      // room's scores. Next is the release: a prediction whose match the
      // field has abandoned is discarded unscored, and nobody pays for it.
      const q = this.#current();
      const stale = q?.kind === 'match' && q.matchId != null
        && this.#bus.state.match?.id !== q.matchId;
      if (!stale) throw new Error('Reveal before moving on.');
      this.#questions.splice(this.#index, 1);
      this.#answers.clear();
      if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
      this.#index = Math.min(this.#index, this.#questions.length);
      this.#phase = 'idle';
      this.#publish();
      return this.snapshot();
    }
    if (this.#index < this.#questions.length - 1) this.#index++;
    else this.#index = this.#questions.length;      // bank exhausted
    this.#phase = 'idle';
    this.#publish();
    return this.snapshot();
  }

  /**
   * Remove one player, by name, from the host console.
   *
   * The filter is a doorstop and not a guarantee, so the host needs a way to
   * take something off the big screen in one action while it is up there. By
   * name rather than id: the host is reading the leaderboard, not a database,
   * and the id is deliberately never published.
   */
  kick(name: string): { removed: number } {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) throw new Error('Name the player to remove.');
    let removed = 0;
    for (const [id, p] of this.#players) {
      if (p.name.trim().toLowerCase() !== wanted) continue;
      this.#players.delete(id);
      this.#answers.delete(id);
      removed++;
    }
    if (removed) this.#publish();
    return { removed };
  }

  /** Reset scores and progress. Players stay unless `hard`. */
  reset(hard = false): TriviaSnapshot {
    this.#phase = 'idle';
    this.#index = 0;
    this.#asked = 0;
    this.#askedIds.clear();
    this.#answers.clear();
    if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
    if (hard) this.#players.clear();
    else for (const p of this.#players.values()) { p.score = 0; p.correct = 0; }
    this.#publish();
    return this.snapshot();
  }

  // ---- views ----------------------------------------------------------------

  snapshot(): TriviaSnapshot {
    const q = this.#current();
    const revealed = this.#phase === 'revealed';
    const distribution = q ? q.options.map((_, i) =>
      [...this.#answers.values()].filter(a => a.choice === i).length) : [];
    return {
      phase: this.#phase,
      players: this.#players.size,
      questionIndex: this.#index,
      questionCount: this.#questions.length,
      question: q && this.#phase !== 'idle' ? {
        text: q.text,
        options: [...q.options],
        category: q.category ?? null,
        answer: revealed ? q.answer : null,     // the contract
        opensAt: this.#opensAt,
        closesAt: this.#closesAt,
        distribution,
        answers: this.#answers.size,
      } : null,
      standings: publicStandings(this.#players.values()).slice(0, 10),
      asked: this.#asked,
      joinUrl: this.#joinUrl,
      sessions: this.sessions,
      session: this.#sessionOf(this.#index),
    };
  }

  /** Where the cursor sits inside its round, for "question 3 of 6". */
  #sessionOf(index: number): { name: string; position: number; size: number } | null {
    const run = this.#sessionRuns().find(r => index >= r.start && index < r.start + r.size);
    if (!run) return null;
    return { name: run.name, position: index - run.start + 1, size: run.size };
  }

  playView(playerId?: string): PlayView {
    const snap = this.snapshot();
    const player = playerId ? this.#players.get(playerId) : undefined;
    const mine = playerId ? this.#answers.get(playerId) : undefined;
    const q = this.#current();
    const revealed = this.#phase === 'revealed';
    let rank: number | null = null;
    if (player) {
      rank = standings(this.#players.values())
        .find(s => s.player.id === player.id)?.rank ?? null;
    }
    return {
      phase: snap.phase,
      players: snap.players,
      questionIndex: snap.questionIndex,
      questionCount: snap.questionCount,
      question: snap.question ? {
        text: snap.question.text,
        options: snap.question.options,
        category: snap.question.category,
        opensAt: snap.question.opensAt,
        closesAt: snap.question.closesAt,
      } : null,
      answer: revealed && q ? q.answer : null,
      me: player ? {
        name: player.name,
        score: player.score,
        rank,
        choice: mine?.choice ?? null,
        correct: revealed && q && mine ? mine.choice === q.answer : null,
      } : null,
    };
  }
}
