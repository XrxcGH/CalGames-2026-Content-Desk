import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { Awards } from './awards.ts';
import type { DeskEvent } from './types.ts';

const LIST = [
  { id: 'directors', title: "Directors' Award", description: 'The one that matters most.' },
  { id: 'spirit', title: 'Team Spirit', description: 'Loudest section, best signs.' },
];

const scratch = () => mkdtemp(join(tmpdir(), 'cg-awards-'));

const collect = (bus: EventBus): DeskEvent[] => {
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  return seen;
};

test('the winner NEVER rides the bus before the reveal', async () => {
  // The single most important property in this module. Every open surface
  // reads the websocket fan-out, so a winner in the award.show payload would
  // be readable on any phone in the gym while the GA is still building the
  // moment. Typed at show time, held in process memory, first on the bus at
  // the reveal, because that is the moment it stops being a secret.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, LIST);

    awards.show({ id: 'directors', winner: 'The Funky Monkeys', team: 846 });

    const show = seen.find(e => e.type === 'award.show')!;
    assert.equal(JSON.stringify(show.payload).includes('Funky'), false,
      'the winner is in the payload, which means it is on every phone');
    assert.equal(JSON.stringify(show.payload).includes('846'), false,
      'the team number is a spoiler too');

    awards.reveal();
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.deepEqual(revealed.payload, {
      id: 'directors', award: "Directors' Award", winner: 'The Funky Monkeys', team: 846,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a staged winner survives a desk restart and rides the reveal', async () => {
  // The Judge Advisor's flow: winners loaded in the early afternoon as
  // judging concludes, ceremony hours later, JA possibly unreachable in
  // between. A restart that lost the staging would wreck the one segment
  // that cannot be re-run, so it persists, and the reveal picks it up with
  // nobody re-typing anything.
  const dir = await scratch();
  try {
    const first = new Awards(dir, new EventBus(), LIST);
    await first.stage('directors', { winner: 'The Funky Monkeys', team: 846 });

    const bus = new EventBus();
    const seen = collect(bus);
    const reopened = new Awards(dir, bus, LIST);
    await reopened.load();

    reopened.show({ id: 'directors' });          // no winner typed at the desk
    reopened.reveal();
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { winner: string }).winner, 'The Funky Monkeys');
    assert.equal((revealed.payload as { team: number }).team, 846);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('presenting an award deletes its staged secret, file included', async () => {
  // The file of secrets shrinks as the ceremony runs and vanishes with the
  // last reveal: presented means public, and nothing should outlive that.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    await awards.stage('directors', { winner: 'The Funky Monkeys' });

    awards.show({ id: 'directors' });
    awards.reveal();
    await new Promise(r => setTimeout(r, 50));   // the post-reveal save is fire-and-forget

    assert.equal(awards.snapshot(true).list.find(a => a.id === 'directors')?.staged, null);
    await assert.rejects(() => access(join(dir, 'data', 'awards-staged.json')),
      'the last staged winner was presented, so the file itself should be gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the locked snapshot carries no winners and no staging flags', async () => {
  // What a desk session sees before the JA hands over the code. "There is a
  // winner loaded for Directors'" is itself timing information, so the locked
  // view says nothing at all about staging.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    await awards.stage('directors', { winner: 'The Funky Monkeys', team: 846 });
    awards.show({ id: 'directors', winner: 'The Funky Monkeys' });

    const locked = JSON.stringify(awards.snapshot(false));
    assert.equal(locked.includes('Funky'), false, 'the locked view leaks the winner');
    assert.equal(locked.includes('staged'), false, 'the locked view leaks the staging flag');
    assert.equal(locked.includes('pendingWinner'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the full snapshot shows the JA their own typing, for proof-reading', async () => {
  // The JA has to be able to re-read what they staged: a typo nobody can
  // check goes on the projector at the reveal. No spoiler risk: the JA is
  // the person the secret belongs to.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    await awards.stage('spirit', { winner: 'Space Cookies', team: 1868 });
    const full = awards.snapshot(true);
    assert.deepEqual(full.list.find(a => a.id === 'spirit')?.staged,
      { winner: 'Space Cookies', team: 1868 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-staging replaces, and unstage removes', async () => {
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    await awards.stage('spirit', { winner: 'Space Cokies', team: 1868 });
    await awards.stage('spirit', { winner: 'Space Cookies', team: 1868 });   // the typo fix
    assert.equal(awards.snapshot(true).list.find(a => a.id === 'spirit')?.staged?.winner,
      'Space Cookies');
    assert.equal(await awards.unstage('spirit'), true);
    assert.equal(awards.snapshot(true).list.find(a => a.id === 'spirit')?.staged, null);
    await assert.rejects(() => awards.stage('nope', { winner: 'X' }), /no award "nope"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a winner typed at the desk outranks the staged one', async () => {
  // The last-second correction path: the JA staged one name, the envelope on
  // stage says another. What the operator types NOW is the truth.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, LIST);
    await awards.stage('directors', { winner: 'Wrong Name' });
    awards.show({ id: 'directors', winner: 'The Funky Monkeys', team: 846 });
    awards.reveal();
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { winner: string }).winner, 'The Funky Monkeys');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a winner staged after Show is still found at the reveal', async () => {
  // The timing hole: the desk puts the description up while the GA reads it,
  // the JA finishes typing DURING that window, and reveal() used to consult
  // only the snapshot show() took, so it demanded a winner the desk cannot
  // even see (the locked view hides staging), on stage, mid-suspense.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, LIST);

    awards.show({ id: 'directors' });            // the JA is not done typing yet
    await awards.stage('directors', { winner: 'The Funky Monkeys', team: 846 });

    // The secrecy rule holds through the late staging: nothing on the bus.
    assert.equal(seen.some(e => JSON.stringify(e.payload).includes('Funky')), false,
      'the winner must not touch the bus before the reveal');

    awards.reveal();
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { winner: string }).winner, 'The Funky Monkeys');
    assert.equal((revealed.payload as { team: number }).team, 846);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a winner typed at the reveal outranks one staged after Show', async () => {
  // The envelope on stage is still the truth: the late-staging fallback must
  // never outrank what the operator types now.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, LIST);
    awards.show({ id: 'spirit' });
    await awards.stage('spirit', { winner: 'Wrong Name' });
    awards.reveal({ winner: 'Space Cookies', team: 1868 });
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { winner: string }).winner, 'Space Cookies');
    assert.equal((revealed.payload as { team: number }).team, 1868);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the reveal can carry a winner typed at the last second', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, LIST);

    awards.show({ id: 'spirit' });
    assert.throws(() => awards.reveal(), /Type the winner/);
    awards.reveal({ winner: 'Space Cookies', team: 1868 });
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { winner: string }).winner, 'Space Cookies');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a custom award typed on the day works without config', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, []);
    awards.show({ title: 'Judges Special Award', description: 'For the unplanned brilliance.',
      winner: 'Team 254' });
    awards.reveal();
    const revealed = seen.find(e => e.type === 'award.presented')!;
    assert.equal((revealed.payload as { award: string }).award, 'Judges Special Award');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('presented awards tick off the checklist, and a restart keeps the ticks', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const awards = new Awards(dir, bus, LIST);
    awards.attach();

    awards.show({ id: 'directors', winner: 'The Funky Monkeys' });
    awards.reveal();

    assert.equal(awards.snapshot(true).list.find(a => a.id === 'directors')?.presented?.winner,
      'The Funky Monkeys');
    assert.equal(awards.snapshot(true).list.find(a => a.id === 'spirit')?.presented, null);

    // The restart: a fresh instance fed the same log (rebuild.ts's contract).
    const again = new Awards(dir, new EventBus(), LIST);
    again.observe({
      type: 'award.presented', ts: 1, seq: 1, source: 'manual', confidence: 'authoritative',
      payload: { id: 'directors', award: "Directors' Award", winner: 'The Funky Monkeys', team: null },
    } as DeskEvent);
    assert.ok(again.snapshot(true).list.find(a => a.id === 'directors')?.presented,
      'the ceremony checklist survives a mid-ceremony desk restart');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown id is refused by name', async () => {
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    assert.throws(() => awards.show({ id: 'nope' }), /no award "nope"/);
    assert.throws(() => awards.reveal({ winner: 'X' }), /No award is up/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the JA can define, correct, and retire awards without config.json', async () => {
  // The list used to be config-only, which meant "add an award" required
  // finding the right laptop and editing JSON by hand mid-event. define() and
  // remove() are the JA page's editor; onListChanged is how the caller
  // persists the result.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), LIST);
    let saved: unknown = null;
    awards.onListChanged = list => { saved = list; };

    const made = awards.define({ title: "Judges' Special Award", description: 'Invented on Sunday.' });
    assert.equal(made.id, 'judges-special-award', 'ids are minted from the title');
    assert.equal(awards.definitions.length, 3);
    assert.ok(Array.isArray(saved) && (saved as unknown[]).length === 3,
      'every change hands the full list to the persistence hook');

    // A typo fix keeps the id (staged winners and the checklist key off it).
    awards.define({ id: 'judges-special-award', title: "Judges' Special Award",
      description: 'Decided by the judging panel on the day.' });
    assert.equal(awards.definitions.length, 3);
    assert.match(awards.definitions[2]!.description, /judging panel/);

    await awards.remove('judges-special-award');
    assert.equal(awards.definitions.length, 2);

    assert.throws(() => awards.define({ id: 'nope', title: 'X' }), /no award "nope"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a presented award cannot be removed, and removing one discards its staged winner', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const awards = new Awards(dir, bus, LIST);
    awards.attach();                      // the presented ledger fills off the bus
    awards.show({ id: 'directors', winner: 'The Funky Monkeys' });
    awards.reveal();
    await assert.rejects(() => awards.remove('directors'), /has been presented/);

    // Retiring an award with a winner already staged takes the secret with it.
    await awards.stage('spirit', { winner: 'The Quiet Ones' });
    await awards.remove('spirit');
    const reopened = new Awards(dir, new EventBus(), LIST);
    await reopened.load();
    assert.equal(reopened.snapshot(true).list.find(a => a.id === 'spirit')?.staged ?? null, null,
      'the staged winner must not survive the award it belonged to');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the committee\'s real definitions survive, and the plate gets a line instead', async () => {
  // Five of the twelve 2026 definitions are longer than the old 400 character
  // cap, so they were being cut off mid-sentence on air with nothing
  // reporting it. The longest (Founders') is 597. The full text is kept for
  // the GA and the slides; the BLURB is what the broadcast plate shows.
  const dir = await scratch();
  try {
    const long = 'A'.repeat(597);
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, [
      { id: 'founders', title: "Founders' Award", day: 'Sunday',
        blurb: 'The highest honor for impact beyond the field.', description: long },
    ]);

    assert.equal(awards.definitions[0]!.description.length, 597,
      'the full definition must not be truncated');
    assert.equal(awards.definitions[0]!.day, 'Sunday');

    awards.show({ id: 'founders' });
    const show = seen.find(e => e.type === 'award.show')!;
    const payload = show.payload as { blurb: string; description: string };
    assert.equal(payload.blurb, 'The highest honor for impact beyond the field.');
    assert.equal(payload.description.length, 597, 'the definition still rides along');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an award with no blurb still gets a readable line, not a paragraph', async () => {
  // The fallback: the definition's first sentence. A custom award typed at
  // the desk on the day has no blurb, and the plate must not become a wall.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, []);
    awards.show({
      title: 'Judges Special Award',
      description: 'For a team whose story fits no other award. '
        + 'The judges may encounter a team whose unique efforts merit recognition, '
        + 'and this is where that recognition lives.',
    });
    const payload = seen.find(e => e.type === 'award.show')!.payload as { blurb: string };
    assert.equal(payload.blurb, 'For a team whose story fits no other award.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the computed line does not stop at an abbreviation', async () => {
  /*
   * The fallback used to take everything up to the first period followed by a
   * space, which in prose that names a person is the period after their
   * title. "Dr. Woodie Flowers believed..." put the two characters "Dr." on
   * the plate, alone, in 38px type, under the award name, in front of the
   * hall, for the length of the reveal. The JA never typed that line and no
   * page showed it to them before it aired.
   */
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const seen = collect(bus);
    const awards = new Awards(dir, bus, []);
    const lineFor = (description: string) => {
      seen.length = 0;
      awards.show({ title: 'Test Award', description });
      return (seen.find(e => e.type === 'award.show')!.payload as { blurb: string }).blurb;
    };

    assert.equal(
      lineFor('Dr. Woodie Flowers believed in respect. The award carries his name.'),
      'Dr. Woodie Flowers believed in respect.');
    assert.equal(
      lineFor('Named for J. F. Kennedy, an early supporter. It is given once.'),
      'Named for J. F. Kennedy, an early supporter.');
    assert.equal(
      lineFor('For outreach, e.g. a school visit or a summer camp. Judged all weekend.'),
      'For outreach, e.g. a school visit or a summer camp.');
    assert.equal(
      lineFor('Presented by Mrs. Chen and Mr. Alvarez of the WRRF board. Every year.'),
      'Presented by Mrs. Chen and Mr. Alvarez of the WRRF board.');

    // An ordinary sentence still ends where it always did.
    assert.equal(
      lineFor('For a team whose story fits no other award. The judges decide.'),
      'For a team whose story fits no other award.');

    // And a definition that is nothing but abbreviations still yields a line
    // rather than an empty plate.
    assert.equal(lineFor('Dr. Mr. Mrs.'), 'Dr. Mr. Mrs.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editing one award does not strip the day and blurb off the rest', async () => {
  // The Judge Advisor fixing a typo routes through the content sanitizer,
  // which drops any field it does not name. Before this was fixed, one edit
  // silently wiped the ceremony day and the on-air line off all twelve.
  const { EventContent } = await import('./content.ts');
  const { DEFAULTS } = await import('./config.ts');
  const dir = await scratch();
  try {
    const config = structuredClone(DEFAULTS);
    const content = new EventContent(dir);
    const stored = await content.set('awards', {
      list: [
        { id: 'founders', title: "Founders' Award", day: 'Sunday',
          blurb: 'Impact beyond the field.', description: 'The long one.' },
        { id: 'judges', title: "Judges' Award", day: 'Sunday',
          blurb: 'Fits no other award.', description: 'Another.' },
      ],
    }, config) as { list: { id: string; day?: string; blurb?: string }[] };

    assert.equal(stored.list[0]!.day, 'Sunday');
    assert.equal(stored.list[0]!.blurb, 'Impact beyond the field.');
    assert.equal(stored.list[1]!.blurb, 'Fits no other award.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shipped ceremony list parses, in order, with nothing truncated', async () => {
  // config.example.json is what a fresh event copies. If the ceremony order or
  // a definition were wrong there, every event that starts from it is wrong.
  const { readFile } = await import('node:fs/promises');
  const cfg = JSON.parse(await readFile(
    new URL('../../../config.example.json', import.meta.url), 'utf8')) as {
      awards: { list: { id: string; day: string; title: string;
        blurb: string; description: string }[] };
    };
  const list = cfg.awards.list;
  assert.equal(list.length, 12);
  assert.deepEqual(list.slice(0, 3).map(a => a.id),
    ['directors', 'volunteer-of-the-year', 'mentor-of-the-year'],
    'Saturday runs first, in deck order');
  assert.equal(list[3]!.id, 'founders', 'Sunday opens with the Founders Award');
  assert.equal(list[11]!.id, 'judges', 'and closes with the Judges Award');
  for (const a of list) {
    assert.ok(a.day === 'Saturday' || a.day === 'Sunday', `${a.id} has a ceremony day`);
    assert.ok(a.description.length <= 900, `${a.id} description fits the cap`);
    assert.ok(a.blurb.length <= 150, `${a.id} blurb is one line`);
    assert.ok(!a.description.endsWith('...'), `${a.id} is not truncated`);
  }
});

test('the Judge Advisor can change the running order, within one ceremony', async () => {
  // The order is the thing most likely to move late, and it was the last
  // detail about an award that still meant editing config.json by hand.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), [
      { id: 'a', title: 'Alpha', day: 'Saturday' },
      { id: 'b', title: 'Bravo', day: 'Saturday' },
      { id: 'c', title: 'Charlie', day: 'Sunday' },
      { id: 'd', title: 'Delta', day: 'Sunday' },
    ]);
    let saved: string[] = [];
    awards.onListChanged = list => { saved = list.map(a => a.id); };

    awards.reorder('b', -1);
    assert.deepEqual(awards.definitions.map(a => a.id), ['b', 'a', 'c', 'd']);
    assert.deepEqual(saved, ['b', 'a', 'c', 'd'], 'the move is persisted');

    // A move that would cross into the other ceremony does nothing: Saturday
    // and Sunday are different evenings, not one long list.
    awards.reorder('a', 1);
    assert.deepEqual(awards.definitions.map(a => a.id), ['b', 'a', 'c', 'd'],
      'the last Saturday award cannot fall into Sunday');
    awards.reorder('c', -1);
    assert.deepEqual(awards.definitions.map(a => a.id), ['b', 'a', 'c', 'd'],
      'nor can the first Sunday award climb into Saturday');

    awards.reorder('c', 1);
    assert.deepEqual(awards.definitions.map(a => a.id), ['b', 'a', 'd', 'c']);
    assert.throws(() => awards.reorder('nope', 1), /no award "nope"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a newly added award can still be moved within its own ceremony', async () => {
  // The regression this pins: reorder used to swap PHYSICAL neighbours while
  // the Judge Advisor's page enabled its buttons from the award's position
  // inside its DAY GROUP. define() appends, so one award added for the first
  // of two ceremonies landed behind the whole second ceremony, its physical
  // neighbour belonged to the other day, and every press was refused with a
  // 200 and an identical repaint. The award could never be moved at all.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), [
      { id: 'a', title: 'Alpha', day: 'Saturday' },
      { id: 'b', title: 'Bravo', day: 'Saturday' },
      { id: 'c', title: 'Charlie', day: 'Sunday' },
      { id: 'd', title: 'Delta', day: 'Sunday' },
    ]);
    const added = awards.define({ title: 'Echo', day: 'Saturday' });
    const order = () => awards.definitions.map(a => a.id);
    const saturday = () => awards.definitions
      .filter(a => (a.day ?? '') === 'Saturday').map(a => a.id);

    assert.deepEqual(saturday(), ['a', 'b', added.id],
      'the new award joins the end of ITS OWN ceremony, not the end of the list');
    assert.deepEqual(order(), ['a', 'b', added.id, 'c', 'd'],
      'and the two ceremonies stay contiguous in the stored list');

    awards.reorder(added.id, -1);
    assert.deepEqual(saturday(), ['a', added.id, 'b'],
      'the new award moves up its own ceremony');
    awards.reorder(added.id, -1);
    assert.deepEqual(saturday(), [added.id, 'a', 'b']);

    // At the edges it stops, and never crosses into the other evening.
    awards.reorder(added.id, -1);
    assert.deepEqual(saturday(), [added.id, 'a', 'b'], 'first stays first');
    awards.reorder('b', 1);
    assert.deepEqual(order(), [added.id, 'a', 'b', 'c', 'd'],
      'the last Saturday award cannot fall into Sunday');
    assert.deepEqual(awards.definitions.filter(a => a.day === 'Sunday').map(a => a.id),
      ['c', 'd'], 'and Sunday is untouched throughout');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a peer that is not physically adjacent is still the one that moves', async () => {
  // The same bug from the other side: even with a list whose days interleave,
  // moving an award swaps it with its neighbour IN THAT CEREMONY.
  const dir = await scratch();
  try {
    const awards = new Awards(dir, new EventBus(), [
      { id: 's1', title: 'Sat one', day: 'Saturday' },
      { id: 'u1', title: 'Sun one', day: 'Sunday' },
      { id: 's2', title: 'Sat two', day: 'Saturday' },
      { id: 'u2', title: 'Sun two', day: 'Sunday' },
    ]);
    awards.reorder('s2', -1);
    assert.deepEqual(
      awards.definitions.filter(a => a.day === 'Saturday').map(a => a.id),
      ['s2', 's1'], 'the two Saturday awards swapped across the Sunday one between them');
    assert.deepEqual(
      awards.definitions.filter(a => a.day === 'Sunday').map(a => a.id),
      ['u1', 'u2'], 'Sunday order is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a practice ceremony cannot touch the real staged winners', async () => {
  /*
   * The handbook and README both promise that a rehearsal changes nothing but
   * the log: "everything behaves exactly as it does on the day; only the log
   * is set aside". The staged-winner book is NOT the log. It is a separate
   * file that no replay rebuilds, and reveal() deletes from it as each award
   * is presented, which is correct on the day and catastrophic in practice.
   *
   * So the desk manager rehearses Show, Reveal, Clear on Saturday afternoon,
   * exactly as the Friday checklist tells them to, and every winner the Judge
   * Advisor loaded that morning is gone. The JA may be unreachable by the
   * ceremony; that is the whole reason the file exists.
   */
  const dir = await scratch();
  try {
    const LIST = [
      { id: 'directors', title: "Directors' Award", description: 'x.', day: 'Saturday' },
      { id: 'spirit', title: 'Spirit Award', description: 'y.', day: 'Saturday' },
    ];

    // The JA loads winners on the real desk, as judging concludes.
    const real = new Awards(dir, new EventBus(), LIST);
    real.attach();
    await real.load();
    await real.stage('directors', { winner: 'The Funky Monkeys', team: 846 });
    await real.stage('spirit', { winner: 'Space Cookies', team: 1868 });

    // The desk manager practises the whole ceremony, in rehearsal mode.
    const practice = new Awards(dir, new EventBus(), LIST, { rehearsal: true });
    practice.attach();
    await practice.load();
    assert.equal(practice.snapshot(true).list.filter(a => a.staged).length, 0,
      'practice opens an empty book: rehearsing on the real screens must not '
      + 'put a real winner on the projector');
    await practice.stage('directors', { winner: 'Practice Team', team: 1 });
    await practice.stage('spirit', { winner: 'Another Practice Team', team: 2 });

    // The practice winners go in a book of their own, named so that nothing
    // and nobody confuses it with the real one.
    const { readdir } = await import('node:fs/promises');
    const during = await readdir(join(dir, 'data'));
    assert.ok(during.includes('awards-staged.json'),
      'the real book is untouched while practice runs');
    assert.ok(during.some(f => /rehearsal/.test(f) && f !== 'awards-staged.json'),
      'and the practice winners are somewhere else entirely');

    for (const id of ['directors', 'spirit']) {
      practice.show({ id });
      practice.reveal();
      practice.clear();
    }

    // Doors. The desk restarts normally.
    const afterDoors = new Awards(dir, new EventBus(), LIST);
    afterDoors.attach();
    await afterDoors.load();
    const staged = afterDoors.snapshot(true).list.filter(a => a.staged);
    assert.equal(staged.length, 2,
      'both winners survive the rehearsal');
    assert.equal(staged.find(a => a.id === 'directors')?.staged?.winner,
      'The Funky Monkeys', 'and they are the JA’s winners, not the practice one');
    assert.equal(staged.find(a => a.id === 'spirit')?.staged?.winner, 'Space Cookies');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
