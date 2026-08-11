import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { CardLedger, phaseOf } from './cards.ts';

const load = (bus: EventBus, name: string, surrogates: number[] = []): void => {
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: name, displayName: name, red: [], blue: [], surrogates },
  });
};

const card = (bus: EventBus, team: number, color: string, alliance = 'red'): void => {
  bus.emit({ type: 'card.issued', source: 'cheesy', payload: { team, card: color, alliance } });
};

test('a yellow carries forward all event, which is the whole point', () => {
  // Cards arrive as one-shot events and nothing remembered them. A team that
  // picked one up in match 12 is still carrying it in match 40.
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 846, 'yellow');
  load(bus, 'Qualification 40');

  const t = ledger.forTeam(846)!;
  assert.equal(t.yellows, 1);
  assert.equal(t.carrying, true, 'still carrying it 28 matches later');
  assert.equal(t.cards[0]!.match, 'Qualification 12', 'and we know where it came from');
});

test('a red leaves a team carrying, same as a yellow', () => {
  // This test used to assert the opposite, on the reasoning that "a red
  // supersedes rather than adds". That is a defensible thing to say about
  // severity and it is not what the rule says: manual S6.6 displays the
  // indicator once a team has received a yellow OR a red. Asserting `false`
  // here told the announcer a red-carded team had a clean slate.
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 254, 'red');

  const t = ledger.forTeam(254)!;
  assert.equal(t.reds, 1);
  assert.equal(t.carrying, true, 'still carrying, and one more yellow is another red');
});

test('cards do not carry across a tournament phase', () => {
  // S6.6 clears the indicator at the end of Practice, Qualification and
  // Playoff. A yellow from Q12 is spent by Sunday, and telling the announcer
  // a playoff team is one card from a red is telling them something untrue.
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 254, 'yellow');
  assert.equal(ledger.forTeam(254)!.carrying, true, 'live through quals');

  load(bus, 'Match 7');           // what Cheesy actually calls a playoff match
  const t = ledger.forTeam(254)!;
  assert.equal(t.carrying, false, 'a new phase starts clean');
  assert.equal(t.yellows, 1, 'but the weekend total is still sayable on air');
});

test('an unrecognised match name is treated as a playoff', () => {
  // Cheesy sends bare "Match 7" for playoffs and puts the round elsewhere, so
  // playoff names are the ones that do not say what they are. Guessing
  // "qualification" for an unknown name would carry a spent card into Sunday,
  // which is the failure this whole rule exists to stop.
  assert.equal(phaseOf('Qualification 12'), 'qualification');
  assert.equal(phaseOf('Q12'), 'qualification');
  assert.equal(phaseOf('Practice 3'), 'practice');
  assert.equal(phaseOf('Match 7'), 'playoff');
  assert.equal(phaseOf('Final 2'), 'playoff');
  assert.equal(phaseOf(''), 'playoff');
});

test('the same card re-announced on a reconnect is not a second card', () => {
  // The field re-sends its whole card map on every arena update. Counting one
  // yellow twice would turn it into a red, on air, wrongly.
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 846, 'yellow');
  card(bus, 846, 'yellow');
  card(bus, 846, 'yellow');

  assert.equal(ledger.forTeam(846)!.yellows, 1);
});

test('the same team can be carded again in a later match', () => {
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 846, 'yellow');
  load(bus, 'Qualification 30');
  card(bus, 846, 'yellow');

  assert.equal(ledger.forTeam(846)!.yellows, 2, 'two matches, two cards');
});

test('surrogates belong to the match, not the team', () => {
  // The same team is a surrogate in one match and a real entrant in the next,
  // so this is replaced wholesale rather than accumulated.
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12', [1678, 254]);
  assert.deepEqual(ledger.snapshot.surrogates, [254, 1678]);

  load(bus, 'Qualification 13');
  assert.deepEqual(ledger.snapshot.surrogates, [],
    'a team is not a surrogate forever because they were once');
});

test('the snapshot sorts reds first, and is stable between polls', () => {
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 1');
  card(bus, 900, 'yellow');
  card(bus, 100, 'red');
  card(bus, 500, 'yellow');

  assert.deepEqual(ledger.snapshot.teams.map(t => t.team), [100, 500, 900],
    'reds first, then yellows by team number so it does not reshuffle');
});

test('this match carries only this match, for the post-match graphic', () => {
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);

  load(bus, 'Qualification 12');
  card(bus, 846, 'yellow');
  load(bus, 'Qualification 13');
  card(bus, 254, 'red');

  assert.deepEqual(ledger.snapshot.thisMatch.map(c => c.team), [254]);
});

test('junk from the wire is ignored rather than shown', () => {
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);
  load(bus, 'Qualification 12');

  bus.emit({ type: 'card.issued', source: 'cheesy', payload: { team: 0, card: 'yellow' } });
  bus.emit({ type: 'card.issued', source: 'cheesy', payload: { team: 846, card: 'orange' } });
  bus.emit({ type: 'card.issued', source: 'cheesy', payload: {} });

  assert.deepEqual(ledger.snapshot.teams, []);
});

test('a team with nothing against them has no record at all', () => {
  const bus = new EventBus();
  const ledger = new CardLedger();
  ledger.attach(bus);
  load(bus, 'Qualification 12');
  assert.equal(ledger.forTeam(846), null, 'null, not an empty standing to render');
});
