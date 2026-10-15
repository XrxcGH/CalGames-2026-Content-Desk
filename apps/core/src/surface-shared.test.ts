import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The rules the program overlay and the talent view share, driven for real.
 *
 * program.js and talent/index.html are DOM code and cannot be imported here,
 * so the decisions that went wrong on them live as pure functions in
 * surfaces/_shared/alliance.js (and the second-robot label on the social card
 * in card.js), and those are the real modules under test. Same arrangement as
 * roll.test.ts: the surfaces are untyped browser JS, imported with one cast.
 */

interface TeamRef { number: number; name?: string }
interface Frame {
  match?: { id?: string; red: TeamRef[]; blue: TeamRef[] } | null;
  teams?: Record<string, { name: string; label?: string }>;
  totalConfidence?: string;
  officialWinner?: 'red' | 'blue' | 'tie' | null;
  score?: Record<'red' | 'blue', { total: number; rp?: Record<string, boolean> }>;
}
interface RankRow { rank: number; team: number; picked: boolean }
interface Verdict {
  estimated: boolean;
  leader: 'red' | 'blue' | 'tie';
  won: { red: boolean; blue: boolean };
  verdict: { red: string; blue: string };
}
interface AllianceModule {
  lineupKey: (s: Frame) => string;
  availablePool: (sel: { ranked: RankRow[] } | null | undefined, limit?: number) => RankRow[];
  finalVerdict: (s: Frame) => Verdict;
}
interface CardModel {
  red: { teams: { number: number; name?: string; label?: string }[] };
  blue: { teams: { number: number; name?: string; label?: string }[] };
}
interface CardModule {
  cardFromState: (s: Frame) => CardModel;
  drawCard: (ctx: unknown, card: unknown) => void;
}

// @ts-expect-error untyped browser module, cast on the same line
const alliance = (await import('../../../surfaces/_shared/alliance.js')) as AllianceModule;
// @ts-expect-error untyped browser module, cast on the same line
const cardMod = (await import('../../../surfaces/_shared/card.js')) as CardModule;

const T = (number: number): TeamRef => ({ number, name: `Team ${number}` });

function frame(red: number[], blue: number[], extra: Partial<Frame> = {}): Frame {
  return {
    match: { id: 'P5', red: red.map(T), blue: blue.map(T) },
    teams: {},
    totalConfidence: 'authoritative',
    officialWinner: null,
    score: { red: { total: 0 }, blue: { total: 0 } },
    ...extra,
  };
}

function scored(red: number, blue: number, extra: Partial<Frame> = {}): Frame {
  return frame([100, 200, 300], [400, 500, 600], {
    score: { red: { total: red }, blue: { total: blue } },
    ...extra,
  });
}

// ---- lineup key ------------------------------------------------------------

test('a substitution re-sent under the SAME match id changes the lineup key', () => {
  // The bug: a playoff team substitution re-sends matchLoad with the same id
  // and new teams. The surfaces keyed their repaint on the id alone, so the
  // overview, the scorebug and the talent cards named the swapped-out team
  // for the whole match.
  const before = frame([100, 200, 300], [400, 500, 600]);
  const after = frame([100, 200, 777], [400, 500, 600]);
  assert.equal(before.match?.id, after.match?.id, 'the premise: same match id');
  assert.notEqual(alliance.lineupKey(before), alliance.lineupKey(after));

  const blueSwap = frame([100, 200, 300], [400, 500, 888]);
  assert.notEqual(alliance.lineupKey(before), alliance.lineupKey(blueSwap),
    'a blue substitution counts too');
});

test('the same lineup keeps the same key through score and card frames', () => {
  // A key that moved on every frame would restart the overview's entrance
  // animation ten times a second.
  const a = scored(10, 20);
  const b = scored(55, 12, { totalConfidence: 'estimated' });
  assert.equal(alliance.lineupKey(a), alliance.lineupKey(b));
});

test('a second robot\'s label arriving after the first paint changes the key', () => {
  const bare = frame([9999, 200, 300], [400, 500, 600]);
  const labelled = frame([9999, 200, 300], [400, 500, 600],
    { teams: { '9999': { name: 'The Wildhats B', label: '100B' } } });
  assert.notEqual(alliance.lineupKey(bare), alliance.lineupKey(labelled));
});

test('a frame with no match yields a stable key instead of throwing', () => {
  assert.equal(alliance.lineupKey({ match: null }), alliance.lineupKey({}));
});

// ---- selection pool --------------------------------------------------------

function ranking(total: number, pickedUpTo: number): RankRow[] {
  return Array.from({ length: total }, (_, i) => ({
    rank: i + 1, team: 1000 + i, picked: i < pickedUpTo,
  }));
}

test('the pool shows teams still available, not the struck top of the ranking', () => {
  // Round two or three: the first 26 ranks are on alliances. Slicing the top
  // 24 showed 24 struck rows under "Still available" and hid every team left.
  const pool = alliance.availablePool({ ranked: ranking(40, 26) });
  assert.equal(pool.length, 14);
  assert.equal(pool[0]?.rank, 27, 'starts at the best team left');
  assert.ok(pool.every(r => !r.picked), 'nothing taken is listed');
});

test('the pool is capped at 24 and stays in rank order', () => {
  const pool = alliance.availablePool({ ranked: ranking(60, 8) });
  assert.equal(pool.length, 24);
  assert.deepEqual(pool.map(r => r.rank), Array.from({ length: 24 }, (_, i) => i + 9));
});

test('a pick in the middle of the pool leaves a gap-free list', () => {
  const ranked = ranking(30, 0);
  const rank12 = ranked[11];
  assert.ok(rank12);
  rank12.picked = true;
  const pool = alliance.availablePool({ ranked });
  assert.ok(!pool.some(r => r.rank === 12));
  assert.equal(pool.length, 24);
  assert.equal(pool[11]?.rank, 13, 'rank 13 moves up into the freed row');
});

test('no selection means an empty pool', () => {
  assert.deepEqual(alliance.availablePool(null), []);
  assert.deepEqual(alliance.availablePool(undefined), []);
});

// ---- final screen verdict --------------------------------------------------

test('shadow-scored and ahead reads "Leading, unofficial" with NO gold cap', () => {
  // The branch was unreachable: winning was '!estimated && r > b', so while
  // shadow-scoring neither side was ever ahead and a decided match showed two
  // outlined totals and no words.
  const v = alliance.finalVerdict(scored(120, 95, { totalConfidence: 'estimated' }));
  assert.equal(v.leader, 'red');
  assert.equal(v.verdict.red, 'Leading, unofficial');
  assert.equal(v.verdict.blue, '');
  assert.deepEqual(v.won, { red: false, blue: false }, 'the cap is for results only');
  assert.equal(v.estimated, true);
});

test('shadow-scored blue lead is named too, not only red', () => {
  const v = alliance.finalVerdict(scored(80, 81, { totalConfidence: 'estimated' }));
  assert.equal(v.verdict.blue, 'Leading, unofficial');
  assert.equal(v.verdict.red, '');
});

test('shadow-scored and level reads "Level, unofficial" on both', () => {
  const v = alliance.finalVerdict(scored(70, 70, { totalConfidence: 'estimated' }));
  assert.equal(v.verdict.red, 'Level, unofficial');
  assert.equal(v.verdict.blue, 'Level, unofficial');
  assert.deepEqual(v.won, { red: false, blue: false });
});

test('an official total with no field verdict falls back to the arithmetic, with the cap', () => {
  const v = alliance.finalVerdict(scored(120, 95));
  assert.equal(v.verdict.red, 'Winner');
  assert.equal(v.verdict.blue, '');
  assert.deepEqual(v.won, { red: true, blue: false });
});

test('the field\'s verdict beats the totals: a disqualified high score is not the winner', () => {
  const v = alliance.finalVerdict(scored(150, 140, { officialWinner: 'blue' }));
  assert.equal(v.leader, 'blue');
  assert.equal(v.verdict.blue, 'Winner');
  assert.equal(v.verdict.red, '');
  assert.deepEqual(v.won, { red: false, blue: true });
});

test('a field-resolved tiebreak is a winner, not a tie', () => {
  // Level on points, resolved on a tiebreak criterion by the arena.
  const v = alliance.finalVerdict(scored(100, 100, { officialWinner: 'red' }));
  assert.equal(v.verdict.red, 'Winner');
  assert.equal(v.verdict.blue, '');
});

test('an official tie says Tie, with no cap on either side', () => {
  const v = alliance.finalVerdict(scored(100, 100, { officialWinner: 'tie' }));
  assert.equal(v.verdict.red, 'Tie');
  assert.equal(v.verdict.blue, 'Tie');
  assert.deepEqual(v.won, { red: false, blue: false });
});

test('while estimated the field verdict is ignored, as the screen always did', () => {
  // officialWinner can be set while the total is still a desk guess (a winner
  // posted without scores). The words must not borrow authority the numbers
  // beside them have not got.
  const v = alliance.finalVerdict(
    scored(90, 100, { totalConfidence: 'estimated', officialWinner: 'red' }));
  assert.equal(v.leader, 'blue');
  assert.equal(v.verdict.blue, 'Leading, unofficial');
});

// ---- second robots on the social card --------------------------------------

test('the social card model carries the label next to the number', () => {
  const s = scored(100, 90, {
    teams: { '9999': { name: 'The Wildhats B', label: '100B' } },
  });
  s.match = { id: 'Q1', red: [T(9999), T(200), T(300)], blue: [T(400), T(500), T(600)] };
  const model = cardMod.cardFromState(s);
  const first = model.red.teams[0];
  assert.equal(first?.number, 9999, 'the number stays the identity');
  assert.equal(first?.label, '100B');
  assert.equal(model.red.teams[1]?.label, '200', 'an ordinary team prints its own number');
});

test('drawCard prints 100B, never the 9999 it is registered under', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: g['document'], getComputedStyle: g['getComputedStyle'], Path2D: g['Path2D'],
  };
  g['document'] = { documentElement: {} };
  g['getComputedStyle'] = () => ({ getPropertyValue: () => '' });
  g['Path2D'] = class {};

  const printed: string[] = [];
  // A canvas that accepts every call and remembers what text was drawn.
  const ctx: unknown = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key === 'fillText' || key === 'strokeText') {
        return (text: string) => { printed.push(String(text)); };
      }
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key in target) return target[key as string];
      return () => {};
    },
    set(target, key, value) { target[key as string] = value; return true; },
  });

  try {
    const s = scored(100, 90, {
      teams: { '9999': { name: 'The Wildhats B', label: '100B' } },
    });
    s.match = { id: 'Q1', red: [T(9999), T(200), T(300)], blue: [T(400), T(500), T(600)] };
    cardMod.drawCard(ctx, cardMod.cardFromState(s));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  }

  assert.ok(printed.includes('100B'), `100B was drawn (drew: ${printed.join(' | ')})`);
  assert.ok(!printed.includes('9999'), 'the placeholder number never reaches the card');
  assert.ok(printed.includes('200'), 'other teams are untouched');
});
