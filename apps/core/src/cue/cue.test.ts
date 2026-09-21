import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CueEngine, defaultCues } from './engine.ts';
import { sign } from './obs.ts';
import { EventBus } from '../bus.ts';
import type { DeskEvent } from '../types.ts';

const loadMatch = (bus: EventBus): void => {
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
};

test('cues do nothing until their autopilot is switched on', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();

  const scenes: DeskEvent[] = [];
  bus.subscribe(ev => { if (ev.type === 'scene.change') scenes.push(ev); });

  loadMatch(bus);

  assert.equal(scenes.length, 0, 'nothing should fire while off');
  const onDeck = engine.status.find(c => c.id === 'on-deck')!;
  // The producer needs to see it would have been right before trusting it.
  assert.equal(onDeck.wouldHaveFired, 1);
  assert.equal(onDeck.firedAt, null);
});

test('an armed cue fires and switches the scene', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('on-deck', true);

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);

  // Graphics switch synchronously; the scene cut is awaited, so `firedAt` is
  // only stamped once the cue's async run resolves.
  assert.deepEqual(scenes, ['CG_INTRO']);
  assert.equal(bus.state.screen, 'overview');

  await new Promise(r => setImmediate(r));
  assert.notEqual(engine.status.find(c => c.id === 'on-deck')!.firedAt, null);
});

test('autopilot is per-cue, not global', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('live', true);          // trust this one only

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);                              // on-deck: off
  bus.emit({ type: 'match.start', source: 'cheesy' });

  assert.deepEqual(scenes, ['CG_MATCH'], 'only the armed cue should have acted');
});

test('cue-emitted events never re-trigger cues', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAll(true);

  let sceneChanges = 0;
  bus.subscribe(ev => { if (ev.type === 'scene.change') sceneChanges++; });

  loadMatch(bus);

  // on-deck emits screen.change and scene.change with source 'cue'. If those
  // fed back in, this would loop until the stack blew.
  assert.equal(sceneChanges, 1);
});

test('autopilot never cuts away from a live match; operators still can', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null, {
    cues: [
      ...defaultCues(),
      // A hypothetical autopilot cue that would cut to the arcade mid-match.
      { id: 'rogue', name: 'Rogue', does: 'cuts away mid-match',
        when: ev => ev.type === 'graphic.show',
        run: async ctx => { await ctx.scene('arcade'); } },
    ],
  });
  engine.attach();
  engine.setAll(true);

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);
  bus.emit({ type: 'match.start', source: 'cheesy' });
  scenes.length = 0;

  // Autopilot tries to leave the field while the match is live: held.
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, [], 'wide-shot lock holds autopilot cuts');

  // The replay console (operator-driven) still wins mid-match.
  bus.emit({ type: 'replay.play', source: 'replay', payload: {} });
  assert.deepEqual(scenes, ['CG_REPLAY'], 'operator-driven events bypass the lock');

  // After the buzzer the lock releases.
  bus.emit({ type: 'match.end', source: 'cheesy' });
  scenes.length = 0;
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, ['CG_ARCADE'], 'lock lifts once the match ends');
});

test('the gap-filler fires once per gap, not once per event', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('gap-filler', true);

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  // A score posted four minutes ago: the gap condition is already true, and
  // stays true on every event that follows (trivia joins, schedule polls).
  bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 4 * 60_000 });
  bus.emit({ type: 'trivia.updated', source: 'manual' });
  bus.emit({ type: 'rankings.updated', source: 'cheesy' });

  assert.deepEqual(scenes, ['CG_ARCADE'], 'one cut per gap, never one per event');

  // The next gap re-arms it.
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q43', displayName: 'Qualification 43', red: [], blue: [] },
  });
  bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 4 * 60_000 });
  assert.deepEqual(scenes, ['CG_ARCADE', 'CG_ARCADE']);
});

test('clock-driven boundaries reach cues: desk-only still gets the buzzer', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('endgame', true);
  engine.setAutopilot('hold-celebration', true);

  const scenes: string[] = [];
  const graphics: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
    if (ev.type === 'graphic.show') graphics.push((ev.payload as { graphic: string }).graphic);
  });

  // Desk-only: no field bridge, so the 10Hz ticker is the only source of
  // match.endgame and match.end. Stamped 'cue' they never reached the engine.
  const t0 = Date.now();
  bus.emit({ type: 'match.start', source: 'manual', ts: t0 - 135_000 });
  bus.advance(t0);                       // matchClock 115: endgame
  assert.deepEqual(graphics, ['endgame'], 'the endgame trigger fires from the clock');

  bus.advance(t0 + 30_000);              // matchClock 145: post
  assert.deepEqual(scenes, ['CG_MATCH'], 'the buzzer hold fires from the clock');
});

test('a cue can be fired by hand while its autopilot is off', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  assert.equal(await engine.fire('result'), true);
  assert.deepEqual(scenes, ['CG_SCORE']);
  assert.equal(await engine.fire('nonexistent'), false);
});

test('missing OBS degrades rather than fails', async () => {
  const bus = new EventBus();
  // obs = null is the "switcher operator is driving manually" case. Graphics
  // must still switch; only the camera cut is lost.
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAll(true);

  bus.emit({ type: 'match.score_posted', source: 'cheesy' });

  assert.equal(bus.state.screen, 'score');
  assert.equal(engine.status.find(c => c.id === 'result')!.lastError, null);
});

test('a throwing cue is recorded and does not stop the others', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null, {
    cues: [
      { id: 'bad', name: 'Bad', does: 'throws',
        when: ev => ev.type === 'match.start',
        run: () => { throw new Error('boom'); } },
      ...defaultCues().filter(c => c.id === 'live'),
    ],
  });
  engine.attach();
  engine.setAll(true);

  bus.emit({ type: 'match.start', source: 'cheesy' });

  assert.equal(engine.status.find(c => c.id === 'bad')!.lastError, 'boom');
  assert.equal(bus.state.screen, 'match', 'the healthy cue still ran');
});

test('obs-websocket v5 auth follows the documented four steps', () => {
  // obs-websocket's protocol.md publishes the password, salt and challenge but
  // NOT the expected output; it defers to the client libraries. So rather
  // than assert a constant we cannot source, walk the four documented steps
  // independently and compare. This catches the failure modes that actually
  // happen: wrong digest, hex instead of base64, and reversed concatenation.
  const password = 'supersecretpassword';
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
  const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';

  const b64secret = createHash('sha256').update(password + salt).digest('base64');
  const expected = createHash('sha256').update(b64secret + challenge).digest('base64');

  assert.equal(sign(password, salt, challenge), expected);

  // Order matters and is easy to get backwards; prove the inputs aren't
  // interchangeable.
  assert.notEqual(sign(password, challenge, salt), expected);
  assert.match(sign(password, salt, challenge), /^[A-Za-z0-9+/]{43}=$/, 'base64 sha256');
});

test('needsObs agrees with what each cue actually does', () => {
  /*
   * The desk greys out "Run now" for cues that cannot work with OBS away, and
   * it used to grey out every cue instead, under a notice explaining why in
   * terms that were not true of most of the buttons it was disabling: the
   * three music cues and the end game chip never touch OBS. A desk running
   * the show on the venue projectors with no stream at all had show
   * automation it could not fire by hand.
   *
   * The flag is declared per cue, so it can drift from the code beside it.
   * Read each `run` back and let the two argue here rather than at the event,
   * where the symptom is a button that does nothing and a reason that is
   * false.
   */
  for (const cue of defaultCues()) {
    const callsScene = /\bctx\s*\.\s*scene\s*\(/.test(cue.run.toString());
    assert.equal(!!cue.needsObs, callsScene,
      `${cue.id}: needsObs is ${!!cue.needsObs} but run() ${callsScene ? 'does' : 'does not'} call ctx.scene`);
  }

  // And the split is real, so a future refactor that marks them all one way
  // fails here instead of quietly restoring the bug.
  const cues = defaultCues();
  assert.ok(cues.some(c => c.needsObs), 'some cues drive OBS');
  assert.ok(cues.some(c => !c.needsObs),
    'and some do not: those stay runnable by hand with OBS disconnected');
});
