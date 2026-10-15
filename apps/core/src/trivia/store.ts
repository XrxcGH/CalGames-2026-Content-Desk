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
import type { DeskEvent } from '../types.ts';
import {
  award, pickQuestion, publicStandings, resolvePick, standings, PICK_BLUE, PICK_RED, PICK_TIE,
  type PublicStanding, type TriviaAnswer, type TriviaPhase, type TriviaPlayer, type TriviaQuestion,
} from './model.ts';
import { DEFAULT_QUESTIONS } from './questions.ts';
import { screenName, stripInvisible } from './names.ts';

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
  /**
   * The sample is still up: its rounds are inside these counts and cannot be
   * told apart from real ones, so a restart restores no progress from this.
   */
  sampleUp?: true;
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
  /**
   * Set the first time anything happens live, after which observe() refuses
   * to restore. The boot-time rebuild runs before the first join or Open;
   * a logged snapshot arriving later would overwrite a room that is playing.
   */
  #live = false;
  /**
   * The desk's sample data (Test with sample data). While a sample seed runs,
   * publishes go out tagged 'demo', which the boot-time rebuild skips, so a
   * restart can never bring the sample's players back as if they had played.
   * Its players are marked, so clearSample() removes exactly those.
   */
  #sample = false;
  #beforeSample: { index: number; asked: number; askedIds: Set<string> } | null = null;
  #askedAfterSample = 0;
  /**
   * The winning pick option of every match this store has seen posted, by
   * match id.
   *
   * reveal() used to read the result off the live state, which only holds
   * the LOADED match's. The field loads the next match 20 to 60 seconds after
   * a post, and that load clears it, so a host who revealed after the next
   * match came up was told "The score is not posted yet", which was false
   * and sent them looking for a scorekeeper problem. Memory only, like the
   * picks themselves: neither survives a restart.
   */
  #results = new Map<string, 0 | 1 | 2>();
  /** The match each pick was made on, by question id, for the host's messages. */
  #pickNames = new Map<string, string>();

  constructor(bus: EventBus, questions: TriviaQuestion[] = DEFAULT_QUESTIONS) {
    this.#bus = bus;
    bus.subscribe(ev => this.#watchField(ev));
    // Pick-the-winner rounds are session-scoped and must not arrive from
    // disk. Every bank edit persists the whole array, picks included, so a
    // pick queued in the morning rode data/trivia.json into the next boot:
    // it came back as a question whose match was scored hours ago, reveal()
    // rightly refused it ("the field has moved on"), the host's only exit
    // discarded the round unscored in front of a room that had just answered
    // it, and its id blocked that match name from ever being picked again.
    // A prediction only means anything in the session that made it, so it is
    // dropped at the door rather than trusted from a file.
    this.#questions = questions.filter(q => q.kind !== 'match');
  }

  /**
   * The link the big screen's QR code and the phone page's invitation carry.
   *
   * Stored, and PUSHED when it actually changes. The desk's LAN address moves
   * mid-event (a cable swapped, a router that hands out a new lease, a laptop
   * that got its first address after the desk started), and index.ts calls
   * this from the address watcher. Storing alone left the snapshot's joinUrl
   * stale on every surface until the next trivia action happened to publish,
   * so the QR on the projector kept sending phones to a dead address while
   * the host stood there with nothing in the room to prompt a publish.
   *
   * Three conditions on publishing, each for its own reason:
   *
   * - Only when the value CHANGED. The watcher re-reports the same address
   *   every probe, and a repeat must not put an event in the log per probe.
   * - Only once the store is LIVE. The boot-time rebuild feeds the morning's
   *   snapshots through observe(), which refuses once #live is set, and the
   *   first publish is what sets it. This is called twice during boot (the
   *   localhost placeholder, then the first real address), before that
   *   restore has run: publishing here would end the restore before it began
   *   and the leaderboard the gym spent the morning on would come back empty.
   *   A store nobody has touched has put nothing on any screen, so there is
   *   no stale link to correct either.
   * - Never WHILE a sample seed is running, because #publish would tag the
   *   event as sample, and the real address change is not sample data. The
   *   seed is synchronous so this cannot really interleave; it is refused
   *   rather than trusted, since a mid-seed snapshot carries sample players
   *   that are not yet marked as sample and would be logged as real ones.
   */
  setJoinUrl(url: string): void {
    if (url === this.#joinUrl) return;
    this.#joinUrl = url;
    if (this.#live && !this.#sample) this.#publish();
  }

  #publish(): void {
    this.#live = true;
    this.#bus.emit({
      type: 'trivia.updated', source: this.#sample ? 'demo' : 'manual', payload: this.snapshot(),
    });
  }

  /** Run a sample seed. Everything it publishes is tagged as sample. */
  asSample(seed: () => void): void {
    const players = new Set(this.#players.keys());
    this.#beforeSample = { index: this.#index, asked: this.#asked, askedIds: new Set(this.#askedIds) };
    this.#sample = true;
    try { seed(); } finally {
      this.#sample = false;
      this.#askedAfterSample = this.#asked;
      for (const [id, p] of this.#players) if (!players.has(id)) p.sample = true;
    }
  }

  /**
   * Take the sample back out, and only the sample. Its players always go.
   * The rounds it counted as asked go too, unless a real question has been
   * played since, in which case the progress is real and stays.
   */
  clearSample(): void {
    const before = this.#beforeSample;
    const players = [...this.#players].filter(([, p]) => p.sample).map(([id]) => id);
    if (!before && !players.length) return;
    for (const id of players) {
      this.#players.delete(id);
      this.#answers.delete(id);
    }
    if (before && this.#asked === this.#askedAfterSample && this.#phase === 'idle') {
      this.#index = before.index;
      this.#asked = before.asked;
      this.#askedIds = before.askedIds;
      this.#phase = 'idle';
      this.#answers.clear();
      if (this.#closeTimer) { clearTimeout(this.#closeTimer); this.#closeTimer = null; }
    }
    this.#beforeSample = null;
    this.#publish();
  }

  // ---- restore ----------------------------------------------------------------

  /**
   * Rebuild from a logged `trivia.updated` snapshot. Boot-time only, fed by
   * rebuildFromLog; never subscribed to the bus.
   *
   * Scores, played rounds and the cursor lived only in memory, so the
   * handbook's "scores carry across the day" held right up to the first
   * restart, when the leaderboard a gym had spent the morning building came
   * back empty and every round read as unplayed. Each snapshot is the whole
   * state, so each one overwrites the last and the day's final event wins.
   *
   * Nothing here publishes (the first publish is what ends restoring, see
   * #live) and nothing here starts a timer: a close timer for a window that
   * shut hours ago would publish a stale snapshot into the live show.
   *
   * What comes back, and what cannot:
   *
   * - Standings: the top ten rows, by name, with score and correct count. The
   *   snapshot is public and deliberately carries no player ids (model.ts,
   *   PublicStanding), so restored players get fresh ids that no phone holds.
   *   A phone whose id died with the process is shown the join screen again
   *   (quiz/index.html drops its id when /play has no `me`).
   * - Progress: `asked`, the cursor, and which questions count as played, the
   *   last reconstructed per round from the per-round asked counts. Within a
   *   round questions air in order, so the first N of each round are its
   *   played ones.
   * - Phase: always idle. A question that was OPEN when the desk died was
   *   never scored, so it stays at the cursor to be opened again. One that
   *   was REVEALED was paid, so the cursor moves past it exactly as Next
   *   would have: left at the cursor, the next Open would re-air it and the
   *   next Reveal would pay everyone a second time.
   */
  observe(ev: DeskEvent): void {
    if (ev.type !== 'trivia.updated' || this.#live) return;
    const snap = ev.payload as Partial<TriviaSnapshot> | null;
    if (!snap || typeof snap !== 'object') return;

    // Played questions, per round, against the bank as it is NOW. The bank
    // is persisted on every edit so it is the same bank the snapshot saw,
    // minus picks (dropped at construction, see the constructor). Runs are
    // matched by name in order, so a round split in two still lines up.
    const runs = this.#sessionRuns();
    const claimed = new Set<number>();
    const askedIds = new Set<string>();
    for (const s of Array.isArray(snap.sessions) ? snap.sessions : []) {
      if (!s || typeof s.name !== 'string' || !Number.isInteger(s.asked)) continue;
      const i = runs.findIndex((r, idx) => !claimed.has(idx) && r.name === s.name);
      if (i === -1) continue;
      claimed.add(i);
      const run = runs[i]!;
      const played = this.#questions.slice(run.start, run.start + Math.min(s.asked, run.size));
      for (const q of played) askedIds.add(q.id);
    }

    const players = new Map<string, TriviaPlayer>();
    const restoredAt = Date.now();
    for (const row of Array.isArray(snap.standings) ? snap.standings : []) {
      if (!row || typeof row.name !== 'string' || !Number.isFinite(row.score)) continue;
      if (row.sample) continue;
      const id = `r${(++this.#seq).toString(36)}`;
      const correct = Number.isFinite(row.correct) ? row.correct : 0;
      players.set(id, {
        id,
        name: row.name,
        ...(row.team ? { team: row.team } : {}),
        score: row.score,
        correct,
        // At least this many answers were locked. Eviction spares anyone
        // with points or a correct answer anyway; this only matters for a
        // restored row with neither, and under-counting errs towards the
        // slot being reclaimable, which is the safe direction.
        answered: correct,
        // Rank order survives the tie-break: standings() breaks a level score
        // on correct count, then on who joined first.
        joinedAt: restoredAt + (Number.isFinite(row.rank) ? row.rank : 0),
        restored: true,
      });
    }

    let index = Number.isInteger(snap.questionIndex) ? snap.questionIndex! : 0;
    index = Math.max(0, Math.min(index, this.#questions.length));
    if (snap.phase === 'revealed') index = Math.min(index + 1, this.#questions.length);

    this.#players = players;
    if (snap.sampleUp === true) {
      // Taken while the sample was up. Its players were skipped above; its
      // rounds cannot be separated from real ones, so progress starts clean.
      askedIds.clear();
      index = 0;
    }
    this.#askedIds = askedIds;
    this.#asked = snap.sampleUp !== true && Number.isInteger(snap.asked) && snap.asked! >= 0
      ? snap.asked! : askedIds.size;
    this.#index = index;
    this.#phase = 'idle';
    this.#answers.clear();
    this.#opensAt = 0;
    this.#closesAt = 0;
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
   * "answered nothing all game", not "scored nothing": a player who answered
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
    //
    // Invisible format characters (zero-width, soft hyphen, bidi overrides) are
    // stripped HERE, before the screen and before the name is kept. Screening a
    // clean copy while storing the raw one would put something other than what
    // was checked on the projector, and a right-to-left override in a stored
    // name reorders the rest of its leaderboard row. Stripped before the clip
    // too, so a name padded with them cannot spend its length on nothing.
    const name = stripInvisible(String(rawName ?? '')).trim().slice(0, MAX_NAME);
    if (!name) throw new Error('A name is required.');
    // This name goes on a projector in front of a room full of children and
    // the school that lent us the building. Screened BEFORE eviction, with
    // every other validation, so a phone posting names it knows will be
    // refused cannot cost real players their slots.
    const verdict = screenName(name);
    if (!verdict.ok) throw new Error(verdict.reason ?? 'Pick a different name.');
    const t = team && Number.isInteger(team) && team > 0 && team < 100000 ? team : undefined;
    // After a restart the leaderboard comes back from the log under fresh ids
    // that no phone holds, so every phone is shown the join screen again. The
    // first join under a restored row's name and team takes that row back,
    // score and all, instead of starting a second row at zero beside it.
    const wanted = name.toLowerCase();
    for (const p of this.#players.values()) {
      if (!p.restored || p.team !== t || p.name.toLowerCase() !== wanted) continue;
      delete p.restored;
      this.#publish();
      return { playerId: p.id, name: p.name };
    }
    if (this.#players.size >= MAX_PLAYERS) this.#evictOneIdle();
    if (this.#players.size >= MAX_PLAYERS) throw new Error('Trivia is full: 500 players.');
    const id = `p${(++this.#seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const player: TriviaPlayer = {
      id, name,
      ...(t ? { team: t } : {}),
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
    // on the big screen, and a second reveal would pay everyone again. The
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
    player.answered++;   // participation, right or wrong: eviction runs on this
    this.#publish();
    return { locked: true };
  }

  // ---- the field's results ------------------------------------------------

  /**
   * Remember each posted result as it happens. Subscribers run after the
   * reducer, so the state read here is the one the post produced, with the
   * winner the reducer adopted from the field.
   */
  #watchField(ev: DeskEvent): void {
    if (ev.type === 'match.loaded') {
      // A match loaded again after its post is the arena REPLAYING it, and
      // the first run's result is void. Dropped, so a pick on it waits for
      // the re-run's post instead of paying on a score the field threw away.
      const id = (ev.payload as { id?: unknown } | null)?.id;
      if (typeof id === 'string') this.#results.delete(id);
      return;
    }
    if (ev.type !== 'match.score_posted') return;
    const id = this.#bus.state.match?.id;
    if (id) this.#results.set(id, this.#liveResult());
  }

  /**
   * The loaded match's result as a pick option. The field's own verdict
   * first: a playoff level on points is decided on tiebreakers, and a
   * disqualified alliance can hold the higher score, so the totals alone
   * would pay "Tie" or the losing side. The totals decide only when the
   * field gave no verdict.
   */
  #liveResult(): 0 | 1 | 2 {
    const s = this.#bus.state;
    if (s.officialWinner === 'red') return PICK_RED;
    if (s.officialWinner === 'blue') return PICK_BLUE;
    if (s.officialWinner === 'tie') return PICK_TIE;
    return resolvePick(s.score.red.total, s.score.blue.total);
  }

  /** The result a pick resolves against, or null when its match has none. */
  #resultFor(q: TriviaQuestion): 0 | 1 | 2 | null {
    if (q.matchId != null) return this.#results.get(q.matchId) ?? null;
    // A pick made on a match the field gave no id can only be judged live.
    return this.#bus.state.scorePostedAt !== null ? this.#liveResult() : null;
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
    // The loaded match stays loaded for up to a minute after its post, with
    // the result on every screen in the room. A prediction opened then pays
    // whoever reads the scoreboard fastest.
    if (this.#bus.state.scorePostedAt !== null) {
      throw new Error(`${name} has already been scored, so there is nothing left to predict. `
        + 'Pick again once the next match loads.');
    }

    const q = pickQuestion(name, match?.id ?? null);
    if (this.#questions.some(existing => existing.id === q.id)) {
      throw new Error(`${name} has already been picked.`);
    }
    this.#pickNames.set(q.id, name);
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
  /**
   * `preserve` carries the fields an edit must not silently drop.
   *
   * `session` is in here because leaving it out corrupted the bank. The host
   * fixes a typo in question 9 of "Round 2", the console posts text, options,
   * answer and category, and the round label was rebuilt from those alone: the
   * question fell out of its round. The bank then reads Round 1 (6), Round 2
   * (2), Trivia (1), Round 2 (3), so the picker grows a second Round 2 button
   * and a phantom "Trivia" one, startSession jumps to whichever run still has
   * questions in it, and saveBank writes the damage to disk. pick() already
   * inherits a neighbour's session for exactly this reason.
   */
  #validate(
    draft: QuestionDraft,
    preserve?: Pick<TriviaQuestion, 'kind' | 'matchId' | 'session'>,
  ): TriviaQuestion {
    const text = String(draft.text ?? '').trim();
    if (!text) throw new Error('The question needs text.');
    // Caps sized to the overlay's fit steps: past these, even the smallest
    // step overflows the pane, and the failure would be on the projector.
    if (text.length > 200) {
      throw new Error('Keep the question under 200 characters: it has to fit on the screen.');
    }

    const options = (Array.isArray(draft.options) ? draft.options : [])
      .map(o => String(o ?? '').trim());
    if (options.length !== 4 || options.some(o => !o)) {
      throw new Error('Four answer options are required, and none can be blank.');
    }
    if (options.some(o => o.length > 90)) {
      throw new Error('Keep each answer under 90 characters: it has to fit in its box on the screen.');
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
      ...(preserve?.session !== undefined ? { session: preserve.session } : {}),
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
    // Joins the round it lands next to, rather than starting a nameless one of
    // its own at the end of the bank. Same reasoning as pick(): a question with
    // no session shows up in the picker as a round called "Trivia" that means
    // nothing to the host.
    const last = this.#questions[this.#questions.length - 1];
    this.#questions.push(this.#validate(draft, last ? { session: last.session } : undefined));
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
      { kind: existing.kind, matchId: existing.matchId, session: existing.session },
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
    // The cursor is the asked/unasked boundary, and a move that crosses it
    // cannot be represented: it either drags an unasked question into the
    // asked region (silently never aired) or pushes an asked one back under
    // the cursor (re-aired, and re-paid at reveal). Moves within either region
    // leave the boundary untouched, so they are fine as-is.
    //
    // Checked in EVERY phase. It used to be idle-only, which left the hole
    // wide open in exactly the state the host is in most of the time: with a
    // question on screen they could drag an already-asked one below the cursor
    // and have it air and pay out a second time. The live question itself is
    // covered by the assertions above.
    if ((index < this.#index) !== (to < this.#index)) {
      throw new Error('That would move a question across the already-asked line. '
        + 'Reorder within the un-asked part of the bank, or Reset to start over.');
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
    //
    // Read from the results kept per match id, never from whatever the live
    // state holds now: the field loads the next match within a minute of a
    // post, and the host may sit on the prediction past that, or past the
    // next match's own post, which must never be taken for this one's.
    if (q.kind === 'match') {
      const result = this.#resultFor(q);
      if (result === null) throw new Error(this.#noResult(q));
      q.answer = result;
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

  /**
   * Why a pick cannot be revealed, saying exactly what is missing, so the
   * host is not sent to the scorekeeper over a score that was never coming.
   */
  #noResult(q: TriviaQuestion): string {
    if (q.matchId == null || q.matchId === this.#bus.state.match?.id) {
      return 'The score is not posted yet, so there is no winner to reveal.';
    }
    const name = this.#pickNames.get(q.id) ?? 'The match this prediction is about';
    return `${name} is no longer loaded and this desk never saw its score posted, so there `
      + 'is no winner to reveal. Next discards this round unscored.';
  }

  /** Advance to the next question and drop back to idle (leaderboard beat). */
  next(): TriviaSnapshot {
    if (this.#phase === 'open') {
      // A prediction whose match has gone without a posted score can never
      // be revealed, and that once trapped the host: every action threw and
      // the only exit was a reset that wiped the room's scores. Next is the
      // release: it is discarded unscored, and nobody pays for it. One whose
      // match WAS posted is revealed like any other question, even after the
      // field has moved on.
      const q = this.#current();
      const stale = q?.kind === 'match' && q.matchId != null
        && this.#bus.state.match?.id !== q.matchId && !this.#results.has(q.matchId);
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
      ...(this.#beforeSample ? { sampleUp: true as const } : {}),
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
