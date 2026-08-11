import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { Sponsors, type SponsorPlan } from './sponsors.ts';

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
