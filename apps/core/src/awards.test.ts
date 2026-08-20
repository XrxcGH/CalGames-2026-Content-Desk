import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { Awards } from './awards.ts';
import type { DeskEvent } from './types.ts';

const LIST = [
  { id: 'directors', title: "Directors' Award", description: 'The one that matters most.' },
  { id: 'spirit', title: 'Team Spirit', description: 'Loudest section, best signs.' },
];

const collect = (bus: EventBus): DeskEvent[] => {
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  return seen;
};

test('the winner NEVER rides the bus before the reveal', () => {
  // The single most important property in this module. Every open surface
  // reads the websocket fan-out, so a winner in the award.show payload would
  // be readable on any phone in the gym while the GA is still building the
  // moment. Typed at show time, held in process memory, first on the bus at
  // the reveal — because that is the moment it stops being a secret.
  const bus = new EventBus();
  const seen = collect(bus);
  const awards = new Awards(bus, LIST);

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
});

test('the reveal can carry a winner typed at the last second', () => {
  // The other real flow: the desk shows the plate with nothing loaded, the
  // envelope gets opened backstage, the winner is typed and revealed in one go.
  const bus = new EventBus();
  const seen = collect(bus);
  const awards = new Awards(bus, LIST);

  awards.show({ id: 'spirit' });
  assert.throws(() => awards.reveal(), /Type the winner/);
  awards.reveal({ winner: 'Space Cookies', team: 1868 });
  const revealed = seen.find(e => e.type === 'award.presented')!;
  assert.equal((revealed.payload as { winner: string }).winner, 'Space Cookies');
});

test('a custom award typed on the day works without config', () => {
  // A judges' special award invented on Sunday morning is a thing that
  // actually happens, and "come back after you edit a JSON file" is not an
  // answer anyone can use during a ceremony.
  const bus = new EventBus();
  const seen = collect(bus);
  const awards = new Awards(bus, []);

  awards.show({ title: 'Judges Special Award', description: 'For the unplanned brilliance.',
    winner: 'Team 254' });
  awards.reveal();
  const revealed = seen.find(e => e.type === 'award.presented')!;
  assert.equal((revealed.payload as { award: string }).award, 'Judges Special Award');
});

test('presented awards tick off the checklist, and a restart keeps the ticks', () => {
  const bus = new EventBus();
  const awards = new Awards(bus, LIST);
  awards.attach();

  awards.show({ id: 'directors', winner: 'The Funky Monkeys' });
  awards.reveal();

  assert.equal(awards.snapshot.list.find(a => a.id === 'directors')?.presented?.winner,
    'The Funky Monkeys');
  assert.equal(awards.snapshot.list.find(a => a.id === 'spirit')?.presented, null);

  // The restart: a fresh instance fed the same log (rebuild.ts's contract).
  const again = new Awards(new EventBus(), LIST);
  again.observe({
    type: 'award.presented', ts: 1, seq: 1, source: 'manual', confidence: 'authoritative',
    payload: { id: 'directors', award: "Directors' Award", winner: 'The Funky Monkeys', team: null },
  } as DeskEvent);
  assert.ok(again.snapshot.list.find(a => a.id === 'directors')?.presented,
    'the ceremony checklist survives a mid-ceremony desk restart');
});

test('the snapshot says a reveal is armed without saying what it is', () => {
  // The console is behind the PIN, but a snapshot is the kind of thing that
  // ends up in a screen share.
  const bus = new EventBus();
  const awards = new Awards(bus, LIST);
  awards.show({ id: 'directors', winner: 'The Funky Monkeys' });
  const snap = JSON.stringify(awards.snapshot);
  assert.equal(snap.includes('Funky'), false, 'the snapshot leaks the winner');
  assert.equal(awards.snapshot.pendingWinner, true);
});

test('an unknown id is refused by name', () => {
  const awards = new Awards(new EventBus(), LIST);
  assert.throws(() => awards.show({ id: 'nope' }), /no award "nope"/);
  assert.throws(() => awards.reveal({ winner: 'X' }), /No award is up/);
});
