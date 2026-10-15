/**
 * The automatic replay markers, driven through the real bus and the real
 * marker feed the replay console reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { attachMarkers, markersSince } from './markers.ts';

function loadedBus(): EventBus {
  const bus = new EventBus();
  attachMarkers(bus);
  bus.emit({ type: 'match.loaded', source: 'cheesy',
    payload: { id: 'sf4', displayName: 'Playoff 4', red: [], blue: [] } });
  bus.emit({ type: 'match.start', source: 'cheesy' });
  return bus;
}

test('one playoff alliance card is one Card marker, not one per member', () => {
  /*
   * A playoff card is the alliance's, and the field bridge reports it once
   * per member so every member's card count is right. The marker feed made a
   * Card marker per report: three or four on one spot of the replay
   * timeline for one yellow, which reads as four incidents.
   */
  const bus = loadedBus();
  const at = Date.now();
  for (const [i, team] of [254, 1678, 846, 971].entries()) {
    bus.emit({ type: 'card.issued', source: 'cheesy', ts: at + i,
      payload: { alliance: 'red', team, card: 'yellow', match: 'Playoff 4' } });
  }
  const cards = markersSince(bus, 0).filter(m => m.label === 'Card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.ts, at, 'framed on the first report');

  // Reports can reach the bus out of stamp order; still the same moment.
  bus.emit({ type: 'card.issued', source: 'cheesy', ts: at - 1,
    payload: { alliance: 'red', team: 9999, card: 'yellow', match: 'Playoff 4' } });
  assert.equal(markersSince(bus, 0).filter(m => m.label === 'Card').length, 1);
});

test('a later card is its own moment, and so is the next match\'s', () => {
  const bus = loadedBus();
  const at = Date.now();
  bus.emit({ type: 'card.issued', source: 'cheesy', ts: at,
    payload: { alliance: 'red', team: 254, card: 'yellow' } });
  // The same alliance's upgrade to red, a minute on: a new incident.
  bus.emit({ type: 'card.issued', source: 'cheesy', ts: at + 60_000,
    payload: { alliance: 'red', team: 254, card: 'red' } });
  assert.equal(markersSince(bus, 0).filter(m => m.label === 'Card').length, 2);

  // Fouls were never batched and are not now: each is its own call.
  bus.emit({ type: 'foul.called', source: 'cheesy', ts: at + 60_100, payload: { alliance: 'blue' } });
  bus.emit({ type: 'foul.called', source: 'cheesy', ts: at + 60_200, payload: { alliance: 'blue' } });
  assert.equal(markersSince(bus, 0).filter(m => m.label === 'Foul').length, 2);

  // A new match starts the window over, even for a stamp within two seconds
  // of the last match's card.
  bus.emit({ type: 'match.loaded', source: 'cheesy',
    payload: { id: 'sf5', displayName: 'Playoff 5', red: [], blue: [] } });
  bus.emit({ type: 'card.issued', source: 'cheesy', ts: at + 60_500,
    payload: { alliance: 'blue', team: 846, card: 'yellow' } });
  assert.equal(markersSince(bus, 0).filter(m => m.label === 'Card').length, 3);
});
