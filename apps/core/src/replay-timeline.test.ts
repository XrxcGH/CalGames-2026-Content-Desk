/**
 * Where the replay console's cuts land, driven through the real bus, the real
 * reducer and the real marker feed.
 *
 * surfaces/replay/timeline.js is the console's clock-to-wall mapping, kept
 * out of replay.js (DOM code) so it can be run here. The case that matters is
 * the minute after the buzzer, when the console is used hardest: the field
 * pauses between auto and teleop, the desk re-anchors its clock at teleop,
 * and the buzzer clears the live anchor. Mapping a teleop clock from the true
 * start then put every teleop moment early by the pause.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { attachMarkers, markersSince, MANUAL_LEAD_S, type Marker } from './markers.ts';
import { REBUILT, type DeskState } from './types.ts';

type Timeline = {
  wallAt: (state: DeskState, clock: number, t0: number) => number | null;
  clockAt: (state: DeskState, wallMs: number, t0: number) => number | null;
  markerWindow: (state: DeskState, m: Marker, t0: number) => [number, number] | null;
};
// @ts-expect-error untyped browser module, cast on the same line
const tl = (await import('../../../surfaces/replay/timeline.js')) as Timeline;
const T0 = REBUILT.AUTO_START;
const PAUSE_MS = 3_000;   // Cheesy's default PauseDurationSec

/** A match through to the buzzer, with the auto-to-teleop pause, and its marks. */
function playedMatch() {
  const bus = new EventBus();
  attachMarkers(bus);
  const S = Date.now() - 10 * 60_000;                       // auto starts
  const teleop = S + -T0 * 1000 + PAUSE_MS;                 // teleop starts
  bus.emit({ type: 'match.loaded', source: 'cheesy', ts: S - 60_000,
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] } });
  bus.emit({ type: 'match.start', source: 'cheesy', ts: S });
  // Five fuel in half a second, fifteen seconds into auto: a burst marker.
  bus.emit({ type: 'score.delta', source: 'cheesy', ts: S + 5_000,
    payload: { alliance: 'blue', field: 'fuel', amount: 5 } });
  bus.emit({ type: 'match.auto_end', source: 'clock', ts: S + -T0 * 1000 });
  bus.emit({ type: 'match.teleop_start', source: 'cheesy', ts: teleop });
  // A level 3 climb a minute into teleop.
  const climbAt = teleop + 60_000;
  bus.emit({ type: 'score.delta', source: 'cheesy', ts: climbAt,
    payload: { alliance: 'red', field: 'tower', amount: REBUILT.TOWER_TELEOP[3] } });
  const marks = (): Marker[] => markersSince(bus, S - 60_000);
  return { bus, S, teleop, climbAt, marks };
}

test('a teleop climb cut after the buzzer is framed around the climb, not before it', () => {
  const { bus, S, climbAt, marks } = playedMatch();
  bus.emit({ type: 'match.end', source: 'cheesy', ts: climbAt + 30_000 });
  const st = bus.state;
  assert.equal(st.matchStartedAt, null, 'the buzzer has cleared the live anchor');

  const climb = marks().find(m => m.kind === 'climb')!;
  assert.equal(climb.ts, climbAt);
  assert.equal(climb.matchClock, 60, 'stamped on the field\'s own teleop clock');

  // What the console used to do: the true start plus the teleop clock.
  assert.equal(S + (60 - T0) * 1000, climbAt - PAUSE_MS,
    'the old mapping put the climb three seconds early');

  // Clicking the marker: six seconds of build-up, four of the result.
  const w = tl.markerWindow(st, climb, T0)!;
  assert.equal(tl.wallAt(st, w[0], T0), climbAt - 6_000);
  assert.equal(tl.wallAt(st, w[1], T0), climbAt + 4_000);

  // Clicking the timeline at 1:00 into teleop lands on the same moment.
  assert.equal(tl.wallAt(st, 60, T0), climbAt);
  assert.equal(tl.clockAt(st, climbAt, T0), 60, 'and the two directions agree');
});

test('auto moments map from the true start, before and after the buzzer', () => {
  // During teleop the live anchor is the re-anchored one, so the old mapping
  // framed every AUTO marker late by the pause instead.
  const { bus, S, marks } = playedMatch();
  const burst = marks().find(m => m.kind === 'burst')!;
  assert.equal(burst.ts, S + 5_000);
  for (const when of ['mid-teleop', 'after the buzzer']) {
    if (when === 'after the buzzer') bus.emit({ type: 'match.end', source: 'cheesy' });
    const w = tl.markerWindow(bus.state, burst, T0)!;
    assert.equal(tl.wallAt(bus.state, w[0], T0), burst.ts - 6_000, when);
    assert.equal(tl.wallAt(bus.state, w[1], T0), burst.ts + 4_000, when);
  }
});

test('the end of auto, stamped inside the pause, keeps its moment in the window', () => {
  const { bus, S, teleop, marks } = playedMatch();
  bus.emit({ type: 'match.end', source: 'cheesy' });
  const end = marks().find(m => m.kind === 'auto_end')!;
  assert.equal(end.ts, S + -T0 * 1000);
  const w = tl.markerWindow(bus.state, end, T0)!;
  // No clock names a moment in the pause; the window straddles it instead
  // and runs a little long, never short.
  assert.equal(tl.wallAt(bus.state, w[0], T0), end.ts - 6_000, 'the build-up is all there');
  assert.ok(tl.wallAt(bus.state, w[1], T0)! >= teleop + 4_000, 'and teleop\'s first seconds');
});

test('a manual mark lands two seconds before the press, on the clock and in time', () => {
  const { bus, teleop } = playedMatch();
  // The desk console and the phone remote send the clock already back-dated.
  const press = teleop + 90_000;
  bus.emit({ type: 'score.delta', source: 'cheesy', ts: press, payload: { alliance: 'red', field: 'fuel', amount: 1 } });
  bus.emit({ type: 'replay.marker', source: 'manual', ts: press,
    payload: { kind: 'manual', matchClock: 90 - MANUAL_LEAD_S } });
  // The Stream Deck's Mark sends nothing but the kind.
  bus.emit({ type: 'replay.marker', source: 'manual', ts: press, payload: { kind: 'manual' } });
  bus.emit({ type: 'match.end', source: 'cheesy', ts: press + 30_000 });

  const manual = markersSince(bus, teleop).filter(m => m.kind === 'manual');
  assert.equal(manual.length, 2);
  for (const m of manual) {
    assert.equal(m.ts, press - MANUAL_LEAD_S * 1000, 'the moment, not the press');
    assert.equal(m.matchClock, 90 - MANUAL_LEAD_S, 'and the clock agrees with it');
    const w = tl.markerWindow(bus.state, m, T0)!;
    assert.equal(tl.wallAt(bus.state, w[0], T0), m.ts - 6_000);
  }
});

test('with nothing started there is nothing to map', () => {
  const bus = new EventBus();
  assert.equal(tl.wallAt(bus.state, 10, T0), null);
  assert.equal(tl.clockAt(bus.state, Date.now(), T0), null);
  assert.equal(tl.markerWindow(bus.state,
    { kind: 'manual', ts: Date.now(), matchClock: null, label: 'x', priority: 2 }, T0), null);
});
