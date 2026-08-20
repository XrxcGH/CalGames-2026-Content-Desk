import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import { TriviaStore } from './store.ts';
import { award, standings, BASE_POINTS, PICK_BLUE, PICK_TIE, SPEED_POINTS } from './model.ts';
import type { TriviaQuestion } from './model.ts';
import { DEFAULT_QUESTIONS, SESSIONS } from './questions.ts';

const BANK: TriviaQuestion[] = [
  { id: 'q1', text: '2 + 2?', options: ['3', '4', '5', '22'], answer: 1 },
  { id: 'q2', text: 'Capital of fuel?', options: ['Hub', 'Tower', 'Pit', 'Queue'], answer: 0 },
];

test('speed scoring: faster is more, never less than base, never negative time', () => {
  const t0 = 1000, t1 = 21_000;   // 20s window
  assert.equal(award(t0, t1, t0), BASE_POINTS + SPEED_POINTS, 'instant answer maxes out');
  assert.equal(award(t0, t1, t1), BASE_POINTS, 'buzzer beater still gets base');
  assert.equal(award(t0, t1, t1 + 5000), BASE_POINTS, 'late clamps to base, not negative');
  const early = award(t0, t1, t0 + 2000);
  const late = award(t0, t1, t0 + 15_000);
  assert.ok(early > late, 'earlier beats later');
});

test('the answer never leaves the server before reveal', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const { playerId } = store.join('Ana', 846);
  store.open(20);

  // Host/overlay snapshot: no answer while open.
  assert.equal(store.snapshot().question?.answer, null);
  // Phone view: no answer field, and the question shape carries none.
  const play = store.playView(playerId);
  assert.equal(play.answer, null);
  assert.ok(!('answer' in (play.question ?? {})), 'question object itself is scrubbed');

  store.answer(playerId, 1);
  store.reveal();
  assert.equal(store.snapshot().question?.answer, 1, 'revealed at reveal');
  assert.equal(store.playView(playerId).answer, 1);
});

test('one answer per player, scored server-side on reveal', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const ana = store.join('Ana', 846).playerId;
  const ben = store.join('Ben').playerId;
  store.open(20);

  store.answer(ana, 1);           // right
  store.answer(ana, 0);           // attempted change, first answer stands
  store.answer(ben, 3);           // wrong

  store.reveal();
  const play = store.playView(ana);
  assert.equal(play.me?.correct, true);
  assert.ok(play.me!.score >= BASE_POINTS);
  assert.equal(store.playView(ben).me?.correct, false);
  assert.equal(store.playView(ben).me?.score, 0);
});

test('distribution counts answers without leaking which is right', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const ids = ['Ana', 'Ben', 'Cy'].map(n => store.join(n).playerId);
  store.open(20);
  store.answer(ids[0]!, 1);
  store.answer(ids[1]!, 1);
  store.answer(ids[2]!, 3);
  const q = store.snapshot().question!;
  assert.deepEqual(q.distribution, [0, 2, 0, 1]);
  assert.equal(q.answers, 3);
  assert.equal(q.answer, null);
});

test('lifecycle: idle -> open -> revealed -> next; reveal required first', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  assert.equal(store.snapshot().phase, 'idle');
  store.open(20);
  assert.throws(() => store.open(20), /already open/);
  assert.throws(() => store.next(), /Reveal before/);
  store.reveal();
  store.next();
  const s = store.snapshot();
  assert.equal(s.phase, 'idle');
  assert.equal(s.questionIndex, 1);
  assert.equal(s.asked, 1);

  // Exhaust the bank: opening past the end refuses rather than wrapping.
  store.open(20); store.reveal(); store.next();
  assert.throws(() => store.open(20), /No more questions/);
});

test('standings rank by score, then correct count, then commitment', () => {
  const rows = standings([
    { id: 'a', name: 'A', score: 900, correct: 1, answered: 2, joinedAt: 5 },
    { id: 'b', name: 'B', score: 1500, correct: 2, answered: 2, joinedAt: 9 },
    { id: 'c', name: 'C', score: 900, correct: 1, answered: 2, joinedAt: 1 },
  ]);
  assert.deepEqual(rows.map(r => r.player.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3]);
});

test('published standings never carry the player id', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  store.join('Ana', 846);
  store.join('Ben');
  const rows = store.snapshot().standings;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    // The id is the only credential answer() checks, and /api/trivia is open:
    // leaking it lets a stranger burn someone's one answer.
    assert.ok(!('player' in row) && !('id' in row), 'no id, no player object');
  }
  assert.deepEqual(rows[0], { rank: 1, name: 'Ana', team: 846, score: 0, correct: 0 });
});

test('a full room evicts the longest-idle zero-score player, never a scorer', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const ana = store.join('Ana', 846).playerId;
  store.open(20);
  store.answer(ana, 1);
  store.reveal();
  store.next();

  const squatter = store.join('Squatter 0').playerId;
  for (let i = 1; i < 499; i++) store.join(`Squatter ${i}`);
  assert.equal(store.snapshot().players, 500);

  const late = store.join('Late Arrival');
  assert.ok(late.playerId, 'the crowd is not locked out for the day');
  assert.equal(store.snapshot().players, 500, 'the ceiling holds');
  assert.ok(store.playView(ana).me, 'a player with points keeps their slot');
  assert.equal(store.playView(squatter).me, null, 'the oldest idle slot is reclaimed');
});

test('join validation: names required and clipped, junk teams dropped', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  assert.throws(() => store.join('   '), /name is required/i);
  const long = store.join('x'.repeat(60), -4);
  assert.equal(long.name.length, 24);
  store.open(20);
  assert.throws(() => store.answer('nobody', 0), /Join first/);
});

test('soft reset keeps the room, wipes the scores', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const ana = store.join('Ana').playerId;
  store.open(20);
  store.answer(ana, 1);
  store.reveal();
  assert.ok(store.playView(ana).me!.score > 0);

  store.reset();
  const s = store.snapshot();
  assert.equal(s.players, 1, 'players survive a soft reset');
  assert.equal(store.playView(ana).me?.score, 0);
  assert.equal(s.questionIndex, 0);
  assert.equal(s.phase, 'idle');

  store.reset(true);
  assert.equal(store.snapshot().players, 0, 'hard reset clears the room');
});

test('every update publishes a trivia.updated snapshot on the bus', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => { if (ev.type === 'trivia.updated') seen.push(ev.type); });
  const store = new TriviaStore(bus, BANK);
  const ana = store.join('Ana').playerId;
  store.open(20);
  store.answer(ana, 1);
  store.reveal();
  store.next();
  assert.ok(seen.length >= 5, `expected a publish per step, saw ${seen.length}`);
});

test('pick the winner: the answer does not exist until the field produces it', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, []);
  const alice = store.join('Alice').playerId;

  store.pick();
  store.open(20);
  store.answer(alice, PICK_BLUE);

  // Open, answered, and there is genuinely nothing to leak: the match has not
  // been played, so no answer exists on the server either.
  assert.equal(store.snapshot().question?.answer, null);
  assert.equal(store.playView(alice).answer, null);
  assert.throws(() => store.reveal(), /not posted yet/);

  bus.emit({ type: 'score.realtime', source: 'cheesy', payload: {
    red: { teleopFuel: 40 }, blue: { teleopFuel: 90 },
  } });
  bus.emit({ type: 'match.score_posted', source: 'cheesy' });

  store.reveal();
  assert.equal(store.snapshot().question?.answer, PICK_BLUE);
  assert.ok(store.playView(alice).me!.score > 0, 'Alice called it and got paid');
  assert.equal(store.playView(alice).me!.correct, true);
});

test('a tie pays the people who said tie, and never the undecided', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q43', displayName: 'Qualification 43', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, []);
  const brave = store.join('Brave').playerId;
  const hedger = store.join('Hedger').playerId;

  store.pick();
  store.open(20);
  store.answer(brave, PICK_TIE);
  store.answer(hedger, 3);            // "Too close to call"

  bus.emit({ type: 'match.score_posted', source: 'cheesy' });
  store.reveal();

  assert.equal(store.snapshot().question?.answer, PICK_TIE);
  assert.ok(store.playView(brave).me!.score > 0);
  assert.equal(store.playView(hedger).me!.score, 0, 'not committing pays nothing');
});

test('next() discards a prediction the field has abandoned, scoring nobody', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, []);
  const ana = store.join('Ana').playerId;
  store.pick();
  store.open(20);
  store.answer(ana, PICK_BLUE);
  assert.throws(() => store.next(), /Reveal before/, 'no skipping a live prediction');

  // The host sits on it and the field moves on. match.loaded resets
  // scorePostedAt, so reveal refuses both before and after the next score,
  // and Next has to be the way out.
  bus.emit({ type: 'match.score_posted', source: 'cheesy' });
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q43', displayName: 'Qualification 43', red: [], blue: [] },
  });
  assert.throws(() => store.reveal(), /not posted yet/);
  bus.emit({ type: 'match.score_posted', source: 'cheesy' });
  assert.throws(() => store.reveal(), /moved on/);

  const s = store.next();
  assert.equal(s.phase, 'idle');
  assert.equal(store.playView(ana).me?.score, 0, 'an abandoned prediction pays nobody');
  assert.ok(!store.bank().some(q => q.id === 'pick-qualification-42'),
    'the dead question leaves the bank');
  store.pick();   // and the new match can be picked straight away
});

test('a pick cannot cut in front of the question still on screen', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q45', displayName: 'Qualification 45', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, [BANK[0]!]);
  store.open(20);
  assert.throws(() => store.pick(), /Next first/);
  store.reveal();
  // Splicing here would re-queue the revealed question behind the pick, and
  // it would be asked and paid a second time.
  assert.throws(() => store.pick(), /Next first/);
  store.next();
  store.pick();
  assert.deepEqual(store.bank().map(q => q.id), ['q1', 'pick-qualification-45']);
  assert.equal(store.snapshot().questionIndex, 1, 'the pick is up next, not the used question');
});

test('the same match cannot be picked twice', () => {
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q44', displayName: 'Qualification 44', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, []);
  store.pick();
  assert.throws(() => store.pick(), /already been picked/);
});

test('no match loaded means no prediction round', () => {
  const store = new TriviaStore(new EventBus(), []);
  assert.throws(() => store.pick(), /No match is loaded/);
});

test('a pick does not survive into the next boot', () => {
  // Every bank edit persists the whole array, picks included, so a pick
  // queued in the morning used to ride data/trivia.json into the next boot:
  // it came back as a question whose match was scored hours ago, reveal()
  // refused it, next() discarded the round unscored in front of a room that
  // had just answered it, and its id blocked that match name from ever being
  // picked again. Predictions are session-scoped: the store drops them at
  // construction, whatever a file claims.
  const bus = new EventBus();
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q13', displayName: 'Qualification 13', red: [], blue: [] },
  });
  const store = new TriviaStore(bus, [...BANK]);
  store.pick();
  assert.ok(store.bank().some(q => q.id === 'pick-qualification-13'),
    'live in its own session, exactly as before');

  // The reboot: a fresh store fed what saveBank persisted, which is the whole
  // bank minus the transient live flag.
  const persisted = store.bank().map(({ live, ...q }) => q);
  const bus2 = new EventBus();
  bus2.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q13', displayName: 'Qualification 13', red: [], blue: [] },
  });
  const reopened = new TriviaStore(bus2, persisted);
  assert.ok(!reopened.bank().some(q => q.id === 'pick-qualification-13'),
    'the prediction stays behind with the session that made it');
  assert.equal(reopened.bank().length, BANK.length, 'the real questions all arrive');
  reopened.pick();   // and the same match name is free to be picked again
});

test('the bank rejects questions that would break the overlay', () => {
  const store = new TriviaStore(new EventBus(), []);
  const ok = { text: 'What?', options: ['a', 'b', 'c', 'd'], answer: 2 };

  assert.throws(() => store.addQuestion({ ...ok, text: '  ' }), /needs text/);
  assert.throws(() => store.addQuestion({ ...ok, options: ['a', 'b', 'c'] }), /Four answer options/);
  assert.throws(() => store.addQuestion({ ...ok, options: ['a', '', 'c', 'd'] }), /blank/);
  assert.throws(() => store.addQuestion({ ...ok, answer: 9 }), /which option is correct/);
  assert.throws(() => store.addQuestion({ ...ok, answer: undefined }), /which option is correct/);

  store.addQuestion(ok);
  assert.equal(store.bank().length, 1);
  assert.equal(store.bank()[0]!.answer, 2);
});

test('a question on the screen cannot be edited or removed underneath the room', () => {
  const store = new TriviaStore(new EventBus(), []);
  store.addQuestion({ text: 'One', options: ['a', 'b', 'c', 'd'], answer: 0 });
  store.addQuestion({ text: 'Two', options: ['a', 'b', 'c', 'd'], answer: 1 });
  store.open(20);

  assert.throws(() => store.editQuestion(0, { text: 'Changed', options: ['a', 'b', 'c', 'd'], answer: 3 }),
    /on the screen right now/);
  assert.throws(() => store.removeQuestion(0), /on the screen right now/);

  // The one nobody is looking at is still fair game.
  store.editQuestion(1, { text: 'Two edited', options: ['a', 'b', 'c', 'd'], answer: 1 });
  assert.equal(store.bank()[1]!.text, 'Two edited');

  // Revealed is still on screen, answer and all. Only moving on frees it.
  store.reveal();
  assert.throws(() => store.removeQuestion(0), /on the screen right now/);
  store.next();
  store.editQuestion(0, { text: 'Now allowed', options: ['a', 'b', 'c', 'd'], answer: 0 });
  assert.equal(store.bank()[0]!.text, 'Now allowed');
});

test('editing keeps the id, and removing an asked question keeps the cursor honest', () => {
  const store = new TriviaStore(new EventBus(), []);
  store.addQuestion({ text: 'One', options: ['a', 'b', 'c', 'd'], answer: 0 });
  store.addQuestion({ text: 'Two', options: ['a', 'b', 'c', 'd'], answer: 0 });
  store.addQuestion({ text: 'Three', options: ['a', 'b', 'c', 'd'], answer: 0 });

  const id = store.bank()[1]!.id;
  store.editQuestion(1, { text: 'Two again', options: ['a', 'b', 'c', 'd'], answer: 0 });
  assert.equal(store.bank()[1]!.id, id, 'an edit must not fork a duplicate question');

  store.open(20); store.reveal(); store.next();      // cursor now on index 1
  assert.equal(store.snapshot().questionIndex, 1);

  store.removeQuestion(0);                            // delete one already asked
  assert.equal(store.snapshot().questionIndex, 0,
    'the cursor follows its question rather than sliding onto one already seen');
  assert.equal(store.bank()[0]!.text, 'Two again');
});

test('reordering moves a question without disturbing the rest', () => {
  const store = new TriviaStore(new EventBus(), []);
  for (const text of ['One', 'Two', 'Three']) {
    store.addQuestion({ text, options: ['a', 'b', 'c', 'd'], answer: 0 });
  }
  store.moveQuestion(2, -1);
  assert.deepEqual(store.bank().map(q => q.text), ['One', 'Three', 'Two']);

  store.moveQuestion(0, -1);   // off the top: a no-op, not a crash
  assert.deepEqual(store.bank().map(q => q.text), ['One', 'Three', 'Two']);
});

test('a move across the asked line is refused while a question is live too', () => {
  // This test used to assert that D could be dragged to the front while C was
  // on screen, and that the cursor followed C. The cursor part was right and
  // the move was not: index 0 is BEHIND the cursor, so D would then never have
  // aired at all. That is the exact failure the idle-mode guard exists to
  // stop, left wide open in the state the host is actually in most of the
  // time. The same hole let an already-asked question be dragged below the
  // cursor and air, and pay out, a second time.
  const store = new TriviaStore(new EventBus(), []);
  for (const text of ['A', 'B', 'C', 'D']) {
    store.addQuestion({ text, options: ['a', 'b', 'c', 'd'], answer: 0 });
  }
  store.open(20); store.reveal(); store.next();
  store.open(20); store.reveal(); store.next();
  store.open(20);                                   // C is live at index 2
  assert.equal(store.snapshot().question?.text, 'C');

  assert.throws(() => store.moveQuestion(3, -3), /already-asked line/);
  assert.deepEqual(store.bank().map(q => q.text), ['A', 'B', 'C', 'D'],
    'and nothing moved');
});

test('a legal move keeps the cursor on the live question', () => {
  // Reordering WITHIN the un-asked part is fine in any phase, and the cursor
  // has to follow its question rather than its number.
  const store = new TriviaStore(new EventBus(), []);
  for (const text of ['A', 'B', 'C', 'D', 'E']) {
    store.addQuestion({ text, options: ['a', 'b', 'c', 'd'], answer: 0 });
  }
  store.open(20); store.reveal(); store.next();
  store.open(20); store.reveal(); store.next();
  store.open(20);                                   // C is live at index 2

  store.moveQuestion(4, -1);                        // E ahead of D, both unasked
  assert.deepEqual(store.bank().map(q => q.text), ['A', 'B', 'C', 'E', 'D']);
  assert.equal(store.snapshot().question?.text, 'C', 'the room still answers C');
  assert.equal(store.bank().findIndex(q => q.live), 2, 'and the cursor stayed with it');
});

test('open() from revealed is refused: the answer is still on the big screen', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  const ana = store.join('Ana').playerId;
  store.open(20);
  store.answer(ana, 1);
  store.reveal();
  // The host forgot Next. Obeying this used to re-air the just-answered
  // question and pay every correct answer a second time at the next reveal.
  assert.throws(() => store.open(20), /Hit Next first/);
  assert.equal(store.playView(ana).me?.correct, true);
  store.next();
  store.open(20);   // now it is the NEXT question
  assert.equal(store.snapshot().question?.text, 'Capital of fuel?');
});

test('an idle reorder cannot cross the already-asked line', () => {
  const opts: [string, string, string, string] = ['w', 'x', 'y', 'z'];
  const store = new TriviaStore(new EventBus(), [
    { id: 'a', text: 'A?', options: opts, answer: 0 },
    { id: 'b', text: 'B?', options: opts, answer: 0 },
    { id: 'c', text: 'C?', options: opts, answer: 0 },
    { id: 'd', text: 'D?', options: opts, answer: 0 },
  ]);
  store.open(20); store.reveal(); store.next();   // 'a' asked, cursor on 'b'

  // Moving an unasked question above the boundary would park it in the asked
  // region, never to air; the mirror image re-airs an asked one. Both refuse.
  assert.throws(() => store.moveQuestion(1, -1), /already-asked line/);
  assert.throws(() => store.moveQuestion(0, 1), /already-asked line/);

  // Reordering entirely within the un-asked region is fine, and the next
  // question to air is whatever now sits at the cursor.
  store.moveQuestion(3, -1);                       // [a, b, d, c]
  store.moveQuestion(2, -1);                       // [a, d, b, c]
  store.open(20);
  assert.equal(store.snapshot().question?.text, 'D?');
});

test('eviction spares players who answered (even wrongly) over silent joiners', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  // The wrong-answerer joins FIRST, so under the old score-based idleness they
  // were the longest-idle candidate and the first out the door.
  const wrongAnswerer = store.join('Keeps Trying').playerId;
  for (let i = 0; i < 499; i++) store.join(`Squatter ${i}`);
  assert.equal(store.snapshot().players, 500, 'room is at the cap');

  store.open(5);
  store.answer(wrongAnswerer, 0);   // wrong: scores nothing, but they PLAYED
  store.reveal();
  store.next();

  // The 501st join must land by evicting a silent squatter, never the player
  // who has been answering all game and just happens to be bad at trivia.
  const fresh = store.join('Late Arrival').playerId;
  assert.equal(store.snapshot().players, 500);
  assert.ok(store.playView(wrongAnswerer).me, 'the participant keeps the slot');
  assert.ok(store.playView(fresh).me, 'the newcomer got in');
});

test('a join that cannot succeed never costs a real player their slot', () => {
  const store = new TriviaStore(new EventBus(), BANK);
  store.join('Ana');
  // Blank names must be rejected BEFORE any eviction runs.
  assert.throws(() => store.join('   '), /name is required/);
  assert.equal(store.snapshot().players, 1, 'Ana was not evicted by a failed join');
});

// ---------------------------------------------------------------------------
// Sessions: one round per gap between matches, scores carrying across the day
// ---------------------------------------------------------------------------

test('the shipped bank is playable with nobody preparing anything', () => {
  assert.ok(DEFAULT_QUESTIONS.length >= 30,
    `the bank must carry a full day of trivia, found ${DEFAULT_QUESTIONS.length}`);
  assert.ok(SESSIONS.length >= 5, 'a day has more gaps than one round');

  for (const q of DEFAULT_QUESTIONS) {
    assert.equal(q.options.length, 4, `${q.id} must have exactly four options`);
    assert.ok(q.answer >= 0 && q.answer <= 3, `${q.id} has an answer outside its options`);
    assert.ok(q.session, `${q.id} belongs to no round`);
    // A duplicated option makes two plates correct and the reveal a lie.
    assert.equal(new Set(q.options).size, 4, `${q.id} repeats an option`);
  }
  assert.equal(new Set(DEFAULT_QUESTIONS.map(q => q.id)).size, DEFAULT_QUESTIONS.length,
    'two questions share an id');
});

test('rounds are contiguous, so the run order matches the printed order', () => {
  const seen = new Set();
  let last = null;
  for (const q of DEFAULT_QUESTIONS) {
    if (q.session === last) continue;
    assert.ok(!seen.has(q.session), `round "${q.session}" is split into two runs`);
    seen.add(q.session);
    last = q.session ?? null;
  }
});

test('a round resumes where it was left rather than replaying', () => {
  const store = new TriviaStore(new EventBus());
  const first = SESSIONS[0]!;
  store.startSession(first!);
  store.open(20);
  store.reveal();
  store.next();

  // Wander off to another round the way a host does when the field calls.
  store.startSession(SESSIONS[1]!);
  store.open(20);
  store.reveal();
  store.next();

  // Coming back must land on question two of the first round, not question one.
  const snap = store.startSession(first!);
  assert.equal(snap.session?.name, first);
  assert.equal(snap.session?.position, 2, 'the answered question must not be asked again');
  assert.equal(snap.sessions.find(s => s.name === first)?.asked, 1);
});

test('scores carry across rounds: the leaderboard is the whole day', () => {
  const store = new TriviaStore(new EventBus());
  const { playerId } = store.join('Ana', 846);
  store.startSession(SESSIONS[0]!);
  store.open(20);
  assert.ok(store.snapshot().question);
  // Answer correctly by reading the bank, since the snapshot hides the answer.
  const idx = store.snapshot().questionIndex;
  store.answer(playerId, DEFAULT_QUESTIONS[idx]!.answer);
  store.reveal();
  const afterRound1 = store.snapshot().standings[0]!.score;
  assert.ok(afterRound1 > 0, 'a correct answer must score');
  store.next();

  store.startSession(SESSIONS[1]!);
  assert.equal(store.snapshot().standings[0]!.score, afterRound1,
    'changing rounds must not reset the day');
});

test('a round cannot be changed out from under an open question', () => {
  const store = new TriviaStore(new EventBus());
  store.startSession(SESSIONS[0]!);
  store.open(20);
  assert.throws(() => store.startSession(SESSIONS[1]!), /Reveal it before changing rounds/);
});

test('an unknown round is refused rather than silently doing nothing', () => {
  const store = new TriviaStore(new EventBus());
  assert.throws(() => store.startSession('Round 9 · Nope'), /no round called/);
});

test('a round that has been played through refuses to replay', () => {
  // After lunch the host mis-taps the finished "Round 1" instead of "Round 4".
  // It used to rewind silently to question one, re-air it, and pay every
  // correct answer a second time: a day-long leaderboard quietly wrong with
  // nothing on screen having looked unusual.
  const t = new TriviaStore(new EventBus(), [
    { id: 'a1', session: 'Round 1', text: 'Q1?', options: ['w', 'x', 'y', 'z'], answer: 0 },
    { id: 'a2', session: 'Round 1', text: 'Q2?', options: ['w', 'x', 'y', 'z'], answer: 0 },
    { id: 'b1', session: 'Round 2', text: 'Q3?', options: ['w', 'x', 'y', 'z'], answer: 0 },
  ]);

  t.startSession('Round 1');
  t.open(); t.reveal(); t.next();
  t.open(); t.reveal(); t.next();
  assert.throws(() => t.startSession('Round 1'), /already been played/);

  // The unplayed one is still fine.
  t.startSession('Round 2');
  t.open();
  assert.equal(t.snapshot().question?.text, 'Q3?');
});

test('a match pick joins its round instead of splitting it', () => {
  // A differently-named question spliced at the cursor broke the round in two:
  // the picker listed it twice and resuming jumped back into the played half.
  const t = new TriviaStore(new EventBus(), [
    { id: 'a1', session: 'Round 1', text: 'Q1?', options: ['w', 'x', 'y', 'z'], answer: 0 },
    { id: 'a2', session: 'Round 1', text: 'Q2?', options: ['w', 'x', 'y', 'z'], answer: 0 },
    { id: 'a3', session: 'Round 1', text: 'Q3?', options: ['w', 'x', 'y', 'z'], answer: 0 },
  ]);
  t.startSession('Round 1');
  t.open(); t.reveal(); t.next();          // a1 played, cursor on a2

  const names = t.sessions.map(s => s.name);
  assert.deepEqual(names, ['Round 1'], 'one round, not two fragments');
});
