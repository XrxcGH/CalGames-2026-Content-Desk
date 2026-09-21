import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventBus } from '../../bus.ts';
import { NexusAdapter, bestStartEstimate, shortLabel, pendingMatches } from './adapter.ts';
import { NexusClient, type NexusEventStatus } from './client.ts';
import type { DeskEvent } from '../../types.ts';

const collect = (bus: EventBus, types: string[]): DeskEvent[] => {
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => { if (types.includes(ev.type)) seen.push(ev); });
  return seen;
};

/**
 * Nexus's OWN published example payloads, lifted verbatim out of the v1.8.0
 * OpenAPI document at frc.nexus/api/v1/docs.
 *
 * They are here because the fixtures they replace were invented, and the two
 * tests written specifically to guarantee that a played match stops being "up
 * next" were the two that could not catch it failing: one used `status:
 * 'Completed'` and the other simulated the end of qualifications by sending an
 * empty `matches` array. Nexus does neither. There is no "Completed" in the
 * enum at all, and the array is always the whole schedule.
 */
const SPEC = JSON.parse(
  readFileSync(new URL('./fixtures/event-status.json', import.meta.url), 'utf8'),
) as Record<string, NexusEventStatus>;

const status = (over: Partial<NexusEventStatus> = {}): NexusEventStatus => ({
  eventKey: '2026cacg',
  dataAsOfTime: 1_000,
  nowQueuing: 'Qualification 12',
  matches: [
    // Played. Keeps "On field" forever, because Nexus has no terminal status.
    { label: 'Qualification 11', status: 'On field', redTeams: [], blueTeams: [] },
    {
      label: 'Qualification 12', status: 'Now queuing',
      redTeams: ['254', '846', '1678'], blueTeams: ['971', '1868', '100'],
      times: { estimatedStartTime: 1_700_000_000_000 },
    },
    {
      label: 'Qualification 13', status: 'Queuing soon',
      redTeams: ['8', '604', '199'], blueTeams: ['1', '2', '3'],
      times: { estimatedStartTime: 1_700_000_600_000 },
    },
  ],
  announcements: [],
  ...over,
});

const adapter = (bus: EventBus): NexusAdapter => new NexusAdapter({
  bus, apiKey: 'k', eventKey: '2026cacg',
  client: new NexusClient({ apiKey: 'k', eventKey: '2026cacg' }),
});

test('a played match never comes back as upcoming', () => {
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  adapter(bus).apply(status());

  const payload = seen[0]!.payload as { upcoming: { name: string }[] };
  assert.deepEqual(payload.upcoming.map(m => m.name),
    ['Qualification 12', 'Qualification 13']);
});

test('queue timings are derived, never authoritative', () => {
  // They are a queuer's estimate. The desk's whole confidence contract is that
  // an estimate is labelled as one.
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  adapter(bus).apply(status());
  assert.equal(seen[0]!.confidence, 'derived');
  assert.equal(seen[0]!.source, 'nexus');
});

test('a stale payload is ignored: Nexus can answer out of order', () => {
  const bus = new EventBus();
  const a = adapter(bus);
  a.apply(status({ dataAsOfTime: 5_000 }));
  const seen = collect(bus, ['queue.updated']);
  a.apply(status({ dataAsOfTime: 4_000, nowQueuing: 'Qualification 2' }));
  assert.equal(seen.length, 0, 'older data is not news');
});

test('the first poll does not replay the morning announcements at 2pm', () => {
  const bus = new EventBus();
  const seen = collect(bus, ['announcement.posted']);
  const a = adapter(bus);

  a.apply(status({
    announcements: [{ id: 'a1', announcement: 'Doors open', postedTime: 1 }],
  }));
  assert.equal(seen.length, 0, 'the backlog at startup is history, not news');

  a.apply(status({
    dataAsOfTime: 2_000,
    announcements: [
      { id: 'a1', announcement: 'Doors open', postedTime: 1 },
      { id: 'a2', announcement: 'Lunch at 12:15', postedTime: 2 },
    ],
  }));
  assert.equal(seen.length, 1);
  assert.equal((seen[0]!.payload as { text: string }).text, 'Lunch at 12:15');
});

test('the same announcement is mirrored once, however often it is polled', () => {
  const bus = new EventBus();
  const a = adapter(bus);
  a.apply(status());
  const seen = collect(bus, ['announcement.posted']);
  const withOne = status({
    dataAsOfTime: 2_000,
    announcements: [{ id: 'a9', announcement: 'Clear the pit aisle', postedTime: 9 }],
  });
  a.apply(withOne);
  a.apply({ ...withOne, dataAsOfTime: 3_000 });
  a.apply({ ...withOne, dataAsOfTime: 4_000 });
  assert.equal(seen.length, 1);
});

test('a change in who is being called fires once, and carries the teams', () => {
  const bus = new EventBus();
  const a = adapter(bus);
  a.apply(status());                       // first poll establishes the baseline
  const seen = collect(bus, ['queue.called']);

  a.apply(status({ dataAsOfTime: 2_000, nowQueuing: 'Qualification 13' }));
  a.apply(status({ dataAsOfTime: 3_000, nowQueuing: 'Qualification 13' }));
  assert.equal(seen.length, 1, 'polling the same value is not a new call');
  const p = seen[0]!.payload as { label: string; red: number[] };
  assert.equal(p.label, 'Qualification 13');
  assert.deepEqual(p.red, [8, 604, 199]);
});

test('nowQueuing lands on the state snapshot, separate from the loaded match', () => {
  const bus = new EventBus();
  adapter(bus).apply(status());
  assert.equal(bus.state.nowQueuing, 'Qualification 12');
  assert.equal(bus.state.match, null, 'the field has not loaded anything yet');
});

test('a source with no opinion about queuing does not wipe what Nexus said', () => {
  // Cheesy Arena emits queue.updated with an upcoming list and no nowQueuing.
  // Treating that as "nobody is being called" would blank the graphic every
  // sixty seconds.
  const bus = new EventBus();
  adapter(bus).apply(status());
  bus.emit({ type: 'queue.updated', source: 'cheesy', payload: { upcoming: [] } });
  assert.equal(bus.state.nowQueuing, 'Qualification 12');
});

test('short labels fit a side screen', () => {
  assert.equal(shortLabel('Qualification 12'), 'Q12');
  assert.equal(shortLabel('Practice 3'), 'P3');
  assert.equal(shortLabel('Final 2'), 'F2');
  assert.equal(shortLabel('Match 4 (R1)'), 'M4');
});

test('the best estimate prefers the latest stage the queuers have reached', () => {
  assert.equal(bestStartEstimate({ times: { estimatedStartTime: 5, estimatedQueueTime: 1 } }), 5);
  assert.equal(bestStartEstimate({ times: { estimatedQueueTime: 1 } }), 1);
  assert.equal(bestStartEstimate({}), null, 'no estimate is honest; a made-up one is not');
});

test('one bad item does not take the queue call down for the day', () => {
  // apply() was three bare statements with `#started = true` last. A malformed
  // announcement threw before that line, so #started stayed false forever;
  // queue.called is gated on it, so "teams to the field" never fired again
  // while queue.updated kept flowing and everything looked alive.
  const bus = new EventBus();
  const seen = collect(bus, ['queue.called', 'queue.updated']);
  const nexus = adapter(bus);

  nexus.apply(status({ announcements: [null] as never }));
  nexus.apply(status({ dataAsOfTime: 2_000, nowQueuing: 'Qualification 13' }));

  assert.ok(seen.some(e => e.type === 'queue.called'), 'the call still fires');
  assert.ok(seen.some(e => e.type === 'queue.updated'), 'and so does the list');
});

test('the last match played stops being "up next"', () => {
  // An empty pending list returned early, so once the schedule ran out the
  // side screens advertised a played match through alliance selection and
  // into the playoffs with no way to clear it but a restart.
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  const nexus = adapter(bus);

  nexus.apply(status());
  nexus.apply(status({ dataAsOfTime: 2_000, nowQueuing: null, matches: [] }));

  const last = seen[seen.length - 1]!;
  assert.deepEqual((last.payload as { upcoming: unknown[] }).upcoming, [],
    'an empty queue is news, not silence');
});

// ---------------------------------------------------------------------------
// Against Nexus's own published payloads. Everything above is hand-written and
// can only prove the desk agrees with itself.
// ---------------------------------------------------------------------------

const upcomingFrom = (payload: NexusEventStatus): string[] => {
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  adapter(bus).apply(payload);
  return (seen[0]!.payload as { upcoming: { name: string }[] }).upcoming.map(m => m.name);
};

test('mid-qualifications, the deck starts at the match after the one on the field', () => {
  // The spec's own example. Practice 1-6 and Qualification 1-4 are ALL still
  // "On field" because Nexus has no terminal status; nowQueuing is Q6. The
  // old filter matched all four enum values, so it kept the whole schedule
  // and showed Practice 1 through Practice 6 as the upcoming queue while the
  // banner above it correctly read Qualification 6.
  const names = upcomingFrom(SPEC.EventStatusMidQualifications!);
  assert.equal(names[0], 'Qualification 5', 'not Practice 1');
  assert.deepEqual(names, [
    'Qualification 5', 'Qualification 6', 'Qualification 2 Replay',
    'Qualification 7', 'Qualification 8', 'Qualification 9',
  ]);
});

test('mid-playoffs, the deck is playoff matches and not Friday practice', () => {
  const names = upcomingFrom(SPEC.EventStatusMidPlayoffs!);
  assert.deepEqual(names, [
    'Playoff 5', 'Playoff 6', 'Playoff 7', 'Playoff 8', 'Playoff 9', 'Playoff 10',
  ]);
});

test('the deck differs between mid-quals and mid-playoffs at all', () => {
  // The sharpest form of the bug: these two payloads produced byte-identical
  // upcoming lists, six practice matches, hours apart on the same Saturday.
  assert.notDeepEqual(
    upcomingFrom(SPEC.EventStatusMidQualifications!),
    upcomingFrom(SPEC.EventStatusMidPlayoffs!),
  );
});

test('before anything has been played the whole schedule is still upcoming', () => {
  const names = upcomingFrom(SPEC.EventStatusPrePractice!);
  assert.equal(names[0], 'Practice 1', 'nothing is on the field yet');
});

test('an event with no schedule yet produces an empty deck, not a crash', () => {
  assert.deepEqual(upcomingFrom(SPEC.EventStatusEmpty!), []);
});

test('the break the room plans its day around survives the trip', () => {
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  adapter(bus).apply(SPEC.EventStatusMidQualifications!);
  const upcoming = (seen[0]!.payload as {
    upcoming: { name: string; breakAfter?: string; replayOf?: string }[];
  }).upcoming;

  assert.equal(upcoming.find(m => m.name === 'Qualification 6')?.breakAfter, 'Lunch');
  assert.equal(upcoming.find(m => m.name === 'Qualification 5')?.breakAfter, undefined);
  assert.equal(upcoming.find(m => m.name === 'Qualification 2 Replay')?.replayOf,
    'Qualification 2');
});

test('a replay does not show up as a second row with the original\'s number', () => {
  // Both rows shortened to "Q2", so the deck carried two lines reading Q2
  // with different teams in them.
  const m = SPEC.EventStatusMidQualifications!.matches!;
  const replay = m.find(x => x.label === 'Qualification 2 Replay')!;
  const original = m.find(x => x.label === 'Qualification 2')!;
  assert.notEqual(shortLabel(replay.label!), shortLabel(original.label!));
  assert.equal(shortLabel(replay.label!), 'Q2R');
});

test('"On field" is not a pending status, whatever the rest of the row says', () => {
  // The whole enum, in the order the spec lists it. Only the last one means
  // the match is on the field now or already played.
  const all = [
    { label: 'A', status: 'Queuing soon' },
    { label: 'B', status: 'Now queuing' },
    { label: 'C', status: 'On deck' },
    { label: 'D', status: 'On field' },
  ];
  assert.deepEqual(pendingMatches(all).map(x => x.label), [],
    'the last On field row is the field, and there is nothing after it');
  assert.deepEqual(
    pendingMatches([...all, { label: 'E', status: 'Queuing soon' }]).map(x => x.label),
    ['E'],
  );
});

test('a dead uplink stops calling a team to the field', async () => {
  // Nothing else can clear this banner: the reducer keeps nowQueuing until an
  // explicit null arrives, and the Cheesy adapter's queue.updated carries no
  // opinion on queueing. So a failed poll used to leave every side screen and
  // pit monitor calling a team that was called an hour ago.
  const bus = new EventBus();
  const seen = collect(bus, ['queue.updated']);
  const failing = new NexusClient({ apiKey: 'k', eventKey: '2026cacg' });
  failing.status = async () => { throw new Error('uplink down'); };
  const a = new NexusAdapter({ bus, apiKey: 'k', eventKey: '2026cacg', client: failing });

  a.apply(status());
  assert.equal(bus.state.nowQueuing, 'Qualification 12', 'the banner is up to begin with');

  await a.poll();
  await a.poll();
  assert.equal(bus.state.nowQueuing, 'Qualification 12', 'one flaky response is ridden out');

  await a.poll();
  assert.equal(bus.state.nowQueuing, null, 'three failures in a row retires it');

  // Once, not on every later failure.
  const clears = seen.filter(e => (e.payload as { nowQueuing?: unknown }).nowQueuing === null).length;
  await a.poll();
  await a.poll();
  assert.equal(seen.filter(e => (e.payload as { nowQueuing?: unknown }).nowQueuing === null).length,
    clears, 'it does not re-announce the clear every twenty seconds');
});
