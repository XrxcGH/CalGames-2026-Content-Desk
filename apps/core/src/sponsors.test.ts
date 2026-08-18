import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { Sponsors, type SponsorPlan } from './sponsors.ts';
import type { DeskEvent } from './types.ts';

const PLAN: SponsorPlan[] = [
  { id: 'acme', name: 'Acme Robotics', tier: 'title', line: 'Proud title sponsor' },
  { id: 'bolt', name: 'Bolt Fasteners', tier: 'major' },
  { id: 'cog', name: 'Cog Machining', tier: 'supporting' },
];

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

test('tier decides how often, not how big', () => {
  // A title sponsor comes round three times as often as a supporting one.
  // That is what the money bought; being drawn three times larger is not.
  const s = new Sponsors(new EventBus(), PLAN);
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(s.next().live!.id);
  assert.equal(seen.filter(x => x === 'acme').length, 3);
  assert.equal(seen.filter(x => x === 'bolt').length, 2);
  assert.equal(seen.filter(x => x === 'cog').length, 1);
});

test('a title sponsor never appears three times in a row', () => {
  // Three in a row reads as a stuck graphic, which is worse for that sponsor
  // than appearing once.
  const s = new Sponsors(new EventBus(), PLAN);
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(s.next().live!.id);
  for (let i = 2; i < seen.length; i++) {
    assert.ok(!(seen[i] === seen[i - 1] && seen[i] === seen[i - 2]),
      `three in a row at ${i}: ${seen.join(',')}`);
  }
});

test('a sponsor card gets out of the way when the field arms', async () => {
  // The desk manager has enough to do. A sponsor card must never be up when a
  // match starts.
  const bus = new EventBus();
  const s = new Sponsors(bus, PLAN);
  s.attach();
  s.show('acme');
  assert.ok(s.snapshot.live);

  await sleep(1100);
  bus.emit({ type: 'match.armed', source: 'cheesy' });
  assert.equal(s.snapshot.live, null);
});

test('seconds are counted on the way DOWN, because that is when they are known', async () => {
  const s = new Sponsors(new EventBus(), PLAN);
  s.show('acme');
  assert.equal(s.snapshot.rows.find(r => r.id === 'acme')!.airings, 0,
    'nothing is counted while it is still up');

  await sleep(1100);
  s.hide();
  const row = s.snapshot.rows.find(r => r.id === 'acme')!;
  assert.equal(row.airings, 1);
  assert.ok(row.seconds >= 1, `expected at least a second, got ${row.seconds}`);
});

test('a mis-tap is not an airing', async () => {
  // Counting a card that was up for a fifth of a second would inflate the
  // report, and the report is only worth anything if a sponsor could audit it.
  const s = new Sponsors(new EventBus(), PLAN);
  s.show('acme');
  s.hide();
  assert.equal(s.snapshot.totalAirings, 0);
});

test('showing one closes out the last, so time is never double counted', async () => {
  const s = new Sponsors(new EventBus(), PLAN);
  s.show('acme');
  await sleep(1100);
  s.show('bolt');
  assert.equal(s.snapshot.rows.find(r => r.id === 'acme')!.airings, 1);
  assert.equal(s.snapshot.live!.id, 'bolt');
});

test('the report is pasteable text, sorted by time on screen', async () => {
  const s = new Sponsors(new EventBus(), PLAN);
  s.show('bolt');
  await sleep(1100);
  s.hide();

  const text = s.report('CalGames 2026');
  assert.match(text, /CalGames 2026: sponsor recognition/);
  assert.match(text, /Bolt Fasteners: 1 appearance/);
  // Every sponsor appears, including the ones that got nothing: an absence is
  // the most important line in this report.
  assert.match(text, /Acme Robotics: 0 appearances/);
});

test('an empty sponsor list refuses rather than showing an empty card', () => {
  const s = new Sponsors(new EventBus(), []);
  assert.throws(() => s.next(), /No sponsors are configured/);
  assert.deepEqual(s.snapshot.rows, []);
});

test('an unknown sponsor is refused by name', () => {
  const s = new Sponsors(new EventBus(), PLAN);
  assert.throws(() => s.show('nope'), /no sponsor "nope"/);
});

test('no sponsor appears three times running, across the cycle wrap', () => {
  // The existing test drew exactly one cycle, so it never crossed the wrap —
  // which is where the old round-robin-until-empty order broke. A title (3)
  // plus a supporting (1) built [t, s, t, t], and cycling that gives
  // t, s, t, t, t, s: the title three cards running, the exact "stuck graphic"
  // the docstring says the interleave prevents.
  //
  // With one other sponsor a weight of 3 CANNOT be spaced — three of four
  // slots go to the same name however you order them — so the weight is
  // capped at what the plan can carry. Every shape a real event might have:
  const plans = [
    [{ id: 't', name: 'T', tier: 'title' }, { id: 's', name: 'S', tier: 'supporting' }],
    [{ id: 't', name: 'T', tier: 'title' },
      { id: 's1', name: 'S1', tier: 'supporting' }, { id: 's2', name: 'S2', tier: 'supporting' }],
    [{ id: 't', name: 'T', tier: 'title' },
      { id: 'p', name: 'P', tier: 'presenting' }, { id: 's', name: 'S', tier: 'supporting' }],
  ] as SponsorPlan[][];

  for (const plan of plans) {
    const s = new Sponsors(new EventBus(), plan);
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) seen.push(s.next().live!.id);
    for (let i = 2; i < seen.length; i++) {
      assert.ok(!(seen[i] === seen[i - 1] && seen[i] === seen[i - 2]),
        `three in a row at ${i}: ${seen.join(',')}`);
    }
    // And the title still gets the most airtime, which is the other half.
    const titles = seen.filter(x => x === 't').length;
    assert.ok(titles > seen.length / plan.length, 'the title still leads');
  }
});

test('a lone sponsor is the one case that repeats, and that is arithmetic', () => {
  const s = new Sponsors(new EventBus(), [{ id: 'a', name: 'A' }] as SponsorPlan[]);
  assert.equal(s.next().live!.id, 'a');
  assert.equal(s.next().live!.id, 'a');
});

test('airing counts survive a restart, and do not double on the live desk', async () => {
  // The report is the proof of performance a sponsor is shown afterwards, and
  // it lived only in memory: a restart reset every count to zero, so the
  // organisation that paid most was the one under-reported.
  const bus = new EventBus();
  const live = new Sponsors(bus, PLAN);
  live.attach();
  const logged: DeskEvent[] = [];
  bus.subscribe(ev => { if (ev.type.startsWith('sponsor.')) logged.push(ev); });

  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  live.show(PLAN[0]!.id);
  await wait(1100);
  live.hide();

  // observe() now watches the same events hide() emits, so the obvious
  // mistake is counting each airing twice. hide() clears the open card
  // before it emits, which is what keeps that from happening.
  assert.equal(live.snapshot.totalAirings, 1, 'the live desk counts it once');

  const rebuilt = new Sponsors(new EventBus(), PLAN);
  for (const ev of logged) rebuilt.observe(ev);
  assert.equal(rebuilt.snapshot.totalAirings, 1, 'a restart restores it');
  assert.deepEqual(
    rebuilt.snapshot.rows.map(r => r.airings),
    live.snapshot.rows.map(r => r.airings),
    'and restores it per sponsor, not just in total');
});
