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
  // the reveal — because that is the moment it stops being a secret.
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
  // that cannot be re-run — so it persists, and the reveal picks it up with
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
  // check goes on the projector at the reveal. No spoiler risk — the JA is
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
