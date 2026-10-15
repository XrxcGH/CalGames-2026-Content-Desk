import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CueEngine, defaultCues, REPLAY_INPUT } from './engine.ts';
import { isLocalHost, ObsClient, sign } from './obs.ts';
import { EventBus } from '../bus.ts';
import type { DeskEvent } from '../types.ts';

const loadMatch = (bus: EventBus): void => {
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
};

/** Let every cue run that is waiting on a promise finish. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 20));

/**
 * An OBS that records what it is asked to do. Only the members the engine
 * touches; the real client's socket is exercised separately below. `program`
 * is what it answers when asked which scene is on program (a question, so
 * not recorded with the calls), and it follows every cut like OBS would.
 * `handCut` is the switcher clicking a scene in OBS's own Scenes panel: the
 * program changes and the desk is told nothing, exactly as at the venue.
 */
function fakeObs(opts: {
  connected?: boolean; local?: boolean; mediaError?: string; program?: string | null;
} = {}) {
  const calls: string[][] = [];
  let program = opts.program ?? null;
  const obs = {
    connected: opts.connected ?? true,
    local: opts.local ?? true,
    async programScene() { return program; },
    async playMedia(input: string, file: string) {
      calls.push(['playMedia', input, file]);
      if (opts.mediaError) throw new Error(opts.mediaError);
    },
    async setScene(name: string) { calls.push(['setScene', name]); program = name; },
  };
  const handCut = (name: string): void => { program = name; };
  return { obs: obs as unknown as ObsClient, raw: obs, calls, handCut };
}

/** A clip the clip store could have written, and the payload a Take sends. */
async function clipOnDisk(seconds = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-take-'));
  const path = join(dir, 'Qualification_42-0145-190001.mp4');
  await writeFile(path, 'not really video');
  const clip = {
    path, url: '/clips/Qualification_42-0145-190001.mp4', sourceId: 'program',
    ranges: [{ fromMs: 1, toMs: 1 + seconds * 1000 }], seconds, speed: 1,
    label: 'Qualification 42-0145', takeId: 'take-1',
  };
  return { dir, clip };
}

/** Every scene.change from here on, by name. */
function sceneLog(bus: EventBus): string[] {
  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });
  return scenes;
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * The replay cue's answer to a take: on air, or failed and why. Bounded, so a
 * take that is never answered fails the test instead of hanging the suite,
 * which is the same silence the console now refuses to treat as success.
 */
function nextAnswer(bus: EventBus, ms = 5_000): Promise<DeskEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('the replay cue never answered the take'));
    }, ms);
    const off = bus.subscribe(ev => {
      if (ev.type === 'replay.on_air' || ev.type === 'replay.failed') {
        clearTimeout(timer); off(); resolve(ev);
      }
    });
  });
}

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
  //
  // The match scene, where the Overlay lives. This used to cut to CG_INTRO,
  // which the handbook builds as the opening title with no Overlay in it, so
  // the overview this cue puts up never reached the stream.
  assert.deepEqual(scenes, ['CG_MATCH']);
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
  // A real take needs a clip on disk and an OBS to play it: the replay cue
  // refuses to cut to its scene with nothing in it (see the take tests).
  // A short one, so it has run before the buzzer below.
  const { dir, clip } = await clipOnDisk(0.05);
  const { obs } = fakeObs();
  const engine = new CueEngine(bus, obs, {
    clipsDir: dir,
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
  await settle();
  scenes.length = 0;

  // Autopilot tries to leave the field while the match is live: held.
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, [], 'wide-shot lock holds autopilot cuts');

  // The replay console (operator-driven) still wins mid-match.
  const answer = nextAnswer(bus);
  bus.emit({ type: 'replay.play', source: 'replay', payload: clip });
  assert.equal((await answer).type, 'replay.on_air');
  assert.deepEqual(scenes, ['CG_REPLAY'], 'operator-driven events bypass the lock');
  await wait(150);
  assert.deepEqual(scenes, ['CG_REPLAY', 'CG_MATCH'], 'and the take hands back to the field when it ends');
  await rm(dir, { recursive: true, force: true });

  // After the buzzer the lock releases.
  bus.emit({ type: 'match.end', source: 'cheesy' });
  await settle();
  scenes.length = 0;
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, ['CG_ARCADE'], 'lock lifts once the match ends');
  engine.detach();
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
   * `needsObs` means "this cue also cuts a camera", not "this cue needs OBS":
   * ctx.scene emits scene.change regardless and only reaches the switcher
   * when OBS is connected, so nothing here fails with OBS away. The desk uses
   * the flag to SAY that the camera cut will be missed, never to disable a
   * button.
   *
   * The flag is declared per cue, so it can drift from the code beside it.
   * Read each `run` back and let the two argue here rather than at the event.
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
  assert.ok(cues.some(c => !c.needsObs), 'and some never touch it');
});

// ---- Take to program ------------------------------------------------------------

test('a Take plays the clip in OBS and then cuts, armed or not', async () => {
  /*
   * "Take to program" used to put nothing on air. Its only listener was this
   * cue, disarmed by default, so a Take did nothing at all while the console
   * printed "Sent to program."; armed, it cut OBS to CG_REPLAY, which is the
   * overlay over an empty scene. The press IS the operator's take, so it runs
   * disarmed, and it loads the clip before it cuts.
   */
  const { dir, clip } = await clipOnDisk();
  try {
    const bus = new EventBus();
    const { obs, calls } = fakeObs();
    const engine = new CueEngine(bus, obs, { clipsDir: dir });
    engine.attach();
    assert.equal(engine.status.find(c => c.id === 'replay')!.autopilot, false, 'shipped disarmed');

    loadMatch(bus);
    bus.emit({ type: 'match.end', source: 'cheesy' });
    await settle();
    calls.length = 0;

    const answer = nextAnswer(bus);
    // Source 'manual' is what the server stamps on every socket emit.
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    const ev = await answer;

    assert.deepEqual(calls, [
      ['playMedia', REPLAY_INPUT, clip.path],
      ['setScene', 'CG_REPLAY'],
    ], 'the clip is loaded first, so the cut never lands on an empty source');
    assert.equal(ev.type, 'replay.on_air');
    assert.equal(ev.source, 'cue');
    assert.deepEqual(ev.payload, {
      takeId: 'take-1', label: 'Qualification 42-0145', seconds: 10, scene: 'CG_REPLAY',
    }, 'the console that pressed Take hears its own answer');
    assert.equal(bus.state.replayOnAir?.seconds, 10, 'and the overlay stands aside for the clip');
    assert.equal(bus.state.scene, 'CG_REPLAY');

    // Nothing automatic rides a disarmed replay cue: only an operator's press.
    calls.length = 0;
    bus.emit({ type: 'replay.play', source: 'demo', payload: clip });
    await settle();
    assert.deepEqual(calls, [], 'a non-operator replay.play leaves a disarmed cue alone');
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Take that cannot air says why, and never cuts to the empty scene', async () => {
  const { dir, clip } = await clipOnDisk();
  const outside = await mkdtemp(join(tmpdir(), 'cg-music-'));
  try {
    await writeFile(join(outside, 'licensed-track.mp4'), 'music');
    await writeFile(join(dir, 'playlist.mp3'), 'music');
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'deeper-190001.mp4'), 'not the store\'s');

    const cases: { name: string; obs: ReturnType<typeof fakeObs> | null;
      payload: Record<string, unknown>; why: RegExp }[] = [
      // With the desk unable to play it, the file's name is how the operator
      // airs it by hand, so the answer carries it.
      { name: 'no OBS at all', obs: null, payload: clip,
        why: /OBS is not connected.*Qualification_42-0145-190001\.mp4.*CG_REPLAY/ },
      { name: 'OBS down', obs: fakeObs({ connected: false }), payload: clip, why: /OBS is not connected/ },
      { name: 'OBS on another machine', obs: fakeObs({ local: false }), payload: clip,
        why: /another machine.*Qualification_42-0145-190001\.mp4/ },
      { name: 'no media source', payload: clip, why: /CG Replay Clip/,
        obs: fakeObs({ mediaError: 'No source was found by the name of `CG Replay Clip`.' }) },
      { name: 'a clip since deleted', obs: fakeObs(),
        payload: { ...clip, path: join(dir, 'gone-190001.mp4') }, why: /no longer on the desk/ },
      // Any PIN holder can emit a take. OBS plays what it is handed straight
      // onto the stream, so only the clip store's own files are ever passed on.
      { name: 'a file outside rec/clips', obs: fakeObs(),
        payload: { ...clip, path: join(outside, 'licensed-track.mp4') }, why: /rec\/clips/ },
      { name: 'a climb out of rec/clips', obs: fakeObs(),
        payload: { ...clip, path: join(dir, '..', 'media', 'audio', 'track.mp4') }, why: /rec\/clips/ },
      { name: 'a folder inside it', obs: fakeObs(),
        payload: { ...clip, path: join(dir, 'nested', 'deeper-190001.mp4') }, why: /rec\/clips/ },
      { name: 'not a video', obs: fakeObs(),
        payload: { ...clip, path: join(dir, 'playlist.mp3') }, why: /rec\/clips/ },
      { name: 'no clip length', obs: fakeObs(),
        payload: { ...clip, seconds: 'x' }, why: /clip length/ },
      { name: 'Run now on the desk, with no clip', obs: fakeObs(), payload: {}, why: /no clip/ },
    ];

    for (const c of cases) {
      const bus = new EventBus();
      const engine = new CueEngine(bus, c.obs?.obs ?? null, { clipsDir: dir });
      engine.attach();
      const scenes: string[] = [];
      bus.subscribe(ev => {
        if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
      });

      const answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: c.payload });
      const ev = await answer;

      assert.equal(ev.type, 'replay.failed', c.name);
      assert.match((ev.payload as { error: string }).error, c.why, c.name);
      assert.deepEqual(scenes, [], `${c.name}: the stream is never cut to an empty scene`);
      assert.equal(c.obs?.calls.some(x => x[0] === 'setScene') ?? false, false, c.name);
      if (/rec\/clips|no clip/.test(c.why.source)) {
        assert.deepEqual(c.obs?.calls, [], `${c.name}: OBS never hears of a file it must not play`);
      }
      assert.equal(bus.state.replayOnAir, null, `${c.name}: the overlay stays put`);
      await settle();
      assert.match(engine.status.find(x => x.id === 'replay')!.lastError ?? '', c.why,
        `${c.name}: and the desk's cue list says so too`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('playMedia loads the file into the named source and restarts it', async () => {
  // A stand-in obs-websocket v5 server, no password: Hello, Identify,
  // Identified, then one RequestResponse per Request, all recorded.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const seen: { requestType: string; requestData: unknown }[] = [];
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (msg.op === 1) { ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return; }
      if (msg.op !== 6) return;
      seen.push({ requestType: String(msg.d['requestType']), requestData: msg.d['requestData'] });
      ws.send(JSON.stringify({ op: 7, d: {
        requestType: msg.d['requestType'], requestId: msg.d['requestId'],
        requestStatus: { result: true, code: 100 },
        ...(msg.d['requestType'] === 'GetCurrentProgramScene'
          ? { responseData: { currentProgramSceneName: 'CG_DESK', sceneName: 'CG_DESK' } } : {}),
      } }));
    });
  });

  const client = new ObsClient({ host: `127.0.0.1:${port}` });
  try {
    client.connect();
    for (let i = 0; i < 100 && !client.connected; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(client.connected, true);
    assert.equal(client.local, true, 'a loopback OBS can open the desk\'s files');

    await client.playMedia(REPLAY_INPUT, 'C:/desk/rec/clips/Q42-190001.mp4');
    assert.deepEqual(seen, [
      { requestType: 'SetInputSettings', requestData: {
        inputName: REPLAY_INPUT,
        inputSettings: {
          is_local_file: true, local_file: 'C:/desk/rec/clips/Q42-190001.mp4',
          restart_on_activate: true, close_when_inactive: true,
        },
        // Merged, so the operator's own settings on the source survive.
        overlay: true,
      } },
      { requestType: 'TriggerMediaInputAction', requestData: {
        inputName: REPLAY_INPUT, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      } },
    ]);

    // Where a take comes back to is asked of OBS itself.
    assert.equal(await client.programScene(), 'CG_DESK');
    assert.equal(seen.at(-1)?.requestType, 'GetCurrentProgramScene');
  } finally {
    client.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r));
  }
});

test('only an OBS on this machine is trusted to open the desk\'s clip files', () => {
  for (const h of ['127.0.0.1:4455', 'localhost:4455', 'LOCALHOST', '[::1]:4455', '::1', '127.0.0.2']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['172.22.0.99:4455', 'obs-box:4455', '[fe80::1234]:4455', '', ':4455']) {
    assert.equal(isLocalHost(h), false, h);
  }
});

// ---- the gap-filler and a held desk ---------------------------------------------

test('the gap-filler never cuts to the arcade while an award, a slide or a held screen is up', () => {
  /*
   * After the day's last match Cheesy loads its test match, which the desk
   * ignores, so scorePostedAt stays set and the gap clock keeps running.
   * Three minutes later the next schedule poll cut OBS to the arcade capture
   * in the middle of the awards ceremony: the screen hold only ever guarded
   * the overlay, never the camera.
   */
  const run = (hold: (bus: EventBus) => void): string[] => {
    const bus = new EventBus();
    const engine = new CueEngine(bus, null);
    engine.attach();
    // Only this one: the score reveal would cut on the re-posted score.
    engine.setAutopilot('gap-filler', true);
    const scenes: string[] = [];
    bus.subscribe(ev => {
      if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
    });
    bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 90_000 });
    hold(bus);
    scenes.length = 0;
    // Well past three minutes: the poll that used to make the cut.
    bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 4 * 60_000 });
    bus.emit({ type: 'rankings.updated', source: 'cheesy' });
    return scenes;
  };

  assert.deepEqual(run(bus => bus.emit({ type: 'award.show', source: 'manual',
    payload: { id: 'ei', title: 'Engineering Inspiration' } })), [], 'an award on screen');
  assert.deepEqual(run(bus => bus.emit({ type: 'slide.show', source: 'manual',
    payload: { id: 'v', title: 'Thank you, volunteers' } })), [], 'a slide on screen');
  assert.deepEqual(run(bus => bus.emit({ type: 'screen.change', source: 'manual',
    payload: { screen: 'explain' } })), [], 'any screen an operator is holding');
  assert.deepEqual(run(() => {}), ['CG_ARCADE'], 'and a desk holding nothing still fills the gap');
});

test('a gap the desk filled itself stays filled when the ceremony ends', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('gap-filler', true);
  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  bus.emit({ type: 'award.show', source: 'manual', payload: { id: 'ei', title: 'Engineering Inspiration' } });
  bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 4 * 60_000 });
  bus.emit({ type: 'rankings.updated', source: 'cheesy' });
  bus.emit({ type: 'award.clear', source: 'manual' });
  bus.emit({ type: 'rankings.updated', source: 'cheesy' });
  assert.deepEqual(scenes, [], 'no jump to the arcade the instant the last plate comes down');
  assert.equal(engine.status.find(c => c.id === 'gap-filler')!.wouldHaveFired, 0);

  // The next gap is a new gap.
  loadMatch(bus);
  bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 4 * 60_000 });
  assert.deepEqual(scenes, ['CG_ARCADE']);
});

test('between ordinary matches the next load ends the gap; only a session\'s end is filled', t => {
  /*
   * On a real field the next match reaches the desk 20 to 60 seconds after a
   * post, and the load clears scorePostedAt. That is the line this cue keys
   * on, deliberately: a cut to the arcade three minutes after every post
   * would take the next match's overview off the stream a minute or two
   * before every match.
   */
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('gap-filler', true);
  const scenes = sceneLog(bus);

  bus.emit({ type: 'match.score_posted', source: 'cheesy' });
  t.mock.timers.tick(30_000);
  bus.emit({ type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q43', displayName: 'Qualification 43', red: [], blue: [] } });
  t.mock.timers.tick(4 * 60_000);
  bus.emit({ type: 'rankings.updated', source: 'cheesy' });
  bus.emit({ type: 'queue.updated', source: 'cheesy' });
  assert.deepEqual(scenes, [], 'the next match is on deck: no arcade');

  // The same four minutes with nothing loaded after the post: the end of a
  // session, where the arena's test match never reaches the desk.
  loadMatch(bus);
  bus.emit({ type: 'match.score_posted', source: 'cheesy' });
  t.mock.timers.tick(4 * 60_000);
  bus.emit({ type: 'rankings.updated', source: 'cheesy' });
  assert.deepEqual(scenes, ['CG_ARCADE'], 'nothing on deck: the arcade fills it');
  engine.detach();
});

// ---- the end of a take, and autopilot around it ---------------------------------

test('a Take cuts back to what was on program when the clip has run', async () => {
  /*
   * Left on the replay scene after the clip, the stream showed the overlay
   * over a finished media source: the score bar over black. Back to where
   * OBS was before the take, asked of OBS itself, since the switcher is
   * often cut by hand there and the desk's own last cut is stale.
   */
  const cases: { name: string; program: string | null; failAsk?: boolean; deskScene?: string;
    back: string }[] = [
    { name: 'the desk camera, cut by hand in OBS', program: 'CG_DESK', back: 'CG_DESK' },
    { name: 'OBS cannot say: the desk\'s own last cut', program: null, failAsk: true,
      deskScene: 'CG_SCORE', back: 'CG_SCORE' },
    { name: 'nothing known at all: the field', program: null, back: 'CG_MATCH' },
    // OBS already on the replay scene with no take of the desk's behind it
    // (cut there by hand, or a desk restarted mid-clip). Back-to-back takes,
    // where the desk does know, have their own test below.
    { name: 'the replay scene, with no take known: the field, never the replay scene',
      program: 'CG_REPLAY', back: 'CG_MATCH' },
    { name: 'a scene that is not one of ours: the field', program: 'Starting Soon', back: 'CG_MATCH' },
  ];
  for (const c of cases) {
    const { dir, clip } = await clipOnDisk(0.05);
    try {
      const bus = new EventBus();
      const fake = fakeObs({ program: c.program });
      if (c.failAsk) fake.raw.programScene = async () => { throw new Error('OBS GetCurrentProgramScene timed out'); };
      const engine = new CueEngine(bus, fake.obs, { clipsDir: dir });
      engine.attach();
      if (c.deskScene) bus.emit({ type: 'scene.change', source: 'manual', payload: { scene: c.deskScene } });
      const scenes = sceneLog(bus);

      const answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
      assert.equal((await answer).type, 'replay.on_air', c.name);
      await wait(150);
      assert.deepEqual(scenes, ['CG_REPLAY', c.back], c.name);
      assert.equal(fake.calls.at(-1)?.[1], c.back, `${c.name}: OBS was told too`);
      assert.equal(bus.state.replayOnAir, null, `${c.name}: and the overlay has its screen back`);
      engine.detach();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('a take somebody has already moved on from is never cut back', async () => {
  const { dir, clip } = await clipOnDisk(0.1);
  try {
    // The switcher cuts elsewhere during the clip: that is the decision.
    {
      const bus = new EventBus();
      const engine = new CueEngine(bus, fakeObs({ program: 'CG_MATCH' }).obs, { clipsDir: dir });
      engine.attach();
      const scenes = sceneLog(bus);
      const answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
      await answer;
      bus.emit({ type: 'scene.change', source: 'manual', payload: { scene: 'CG_DESK' } });
      await wait(200);
      assert.deepEqual(scenes, ['CG_REPLAY', 'CG_DESK'], 'no cut back over the switcher');
      engine.detach();
    }
    // The field arms during the clip: the overlay goes back to the score bar
    // at once, and the take does not cut anywhere afterwards.
    {
      const bus = new EventBus();
      const engine = new CueEngine(bus, fakeObs({ program: 'CG_SCORE' }).obs, { clipsDir: dir });
      engine.attach();
      const scenes = sceneLog(bus);
      const answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
      await answer;
      bus.emit({ type: 'match.armed', source: 'cheesy' });
      assert.equal(bus.state.replayOnAir, null);
      await wait(200);
      assert.deepEqual(scenes, ['CG_REPLAY'], 'the Armed cue (here off) owns that cut');
      engine.detach();
    }
    // A newer take replaces it: only the newer one cuts back, when it ends.
    {
      const bus = new EventBus();
      const engine = new CueEngine(bus, fakeObs({ program: 'CG_SCORE' }).obs, { clipsDir: dir });
      engine.attach();
      const scenes = sceneLog(bus);
      let answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
      await answer;
      answer = nextAnswer(bus);
      bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, seconds: 0.4, takeId: 'take-2' } });
      await answer;
      await wait(200);
      assert.deepEqual(scenes, ['CG_REPLAY', 'CG_REPLAY'], 'the first take\'s end is not the second\'s');
      await wait(400);
      // This used to expect CG_MATCH: OBS answers "the replay scene" while
      // the first clip plays, and the second take threw away the first's
      // answer. The show was on the score, so that is where it comes back.
      assert.deepEqual(scenes, ['CG_REPLAY', 'CG_REPLAY', 'CG_SCORE'],
        'and the second, taken over the first, hands back to where the first came from');
      engine.detach();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a take the switcher has already cut away from in OBS is never cut back', async () => {
  /*
   * The desk hears nothing of a cut made in OBS's own Scenes panel (it
   * subscribes to no OBS events), so its own state still says the clip is
   * the picture. A long slow-motion replay, the switcher cuts to the field
   * as play resumes, and the clip's end pulled the stream off the live field
   * to the score scene with nobody having pressed anything. OBS is asked
   * before the cut back, as it is asked before the take.
   */
  const { dir, clip } = await clipOnDisk(0.2);
  try {
    const bus = new EventBus();
    const fake = fakeObs({ program: 'CG_SCORE' });
    const engine = new CueEngine(bus, fake.obs, { clipsDir: dir });
    engine.attach();
    const scenes = sceneLog(bus);
    const answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    assert.equal((await answer).type, 'replay.on_air');
    fake.handCut('CG_MATCH');
    await wait(400);
    assert.deepEqual(fake.calls, [
      ['playMedia', REPLAY_INPUT, clip.path],
      ['setScene', 'CG_REPLAY'],
    ], 'OBS is never told to leave the field the switcher cut to');
    assert.deepEqual(scenes, ['CG_REPLAY'], 'nor does the desk claim a cut it did not make');
    assert.equal(bus.state.scene, 'CG_REPLAY');
    assert.equal(engine.status.find(c => c.id === 'replay')!.lastError, null);
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // A question OBS cannot answer at the end loses only the precision: the
  // desk's own record says the clip is still the picture, so it cuts back.
  const again = await clipOnDisk(0.05);
  try {
    const bus = new EventBus();
    const fake = fakeObs({ program: 'CG_SCORE' });
    const engine = new CueEngine(bus, fake.obs, { clipsDir: again.dir });
    engine.attach();
    const scenes = sceneLog(bus);
    const answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: again.clip });
    await answer;
    fake.raw.programScene = async () => { throw new Error('OBS GetCurrentProgramScene timed out'); };
    await wait(150);
    assert.deepEqual(scenes, ['CG_REPLAY', 'CG_SCORE']);
    assert.equal(fake.calls.at(-1)?.[1], 'CG_SCORE');
    engine.detach();
  } finally {
    await rm(again.dir, { recursive: true, force: true });
  }
});

test('back-to-back takes come back to where the first one came from', async () => {
  /*
   * Analysts on the desk camera between matches, two replays in a row. OBS
   * answers "the replay scene" while the first clip plays, so the second
   * take fell back to the field, and the show landed on CG_MATCH (the
   * full-frame Final, with a score up) instead of the desk it was on.
   */
  const { dir, clip } = await clipOnDisk(0.5);
  try {
    const bus = new EventBus();
    const engine = new CueEngine(bus, fakeObs({ program: 'CG_DESK' }).obs, { clipsDir: dir });
    engine.attach();
    const scenes = sceneLog(bus);
    let answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    await answer;
    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, seconds: 0.3, takeId: 'take-2' } });
    await answer;
    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, seconds: 0.1, takeId: 'take-3' } });
    await answer;
    await wait(600);
    assert.deepEqual(scenes, ['CG_REPLAY', 'CG_REPLAY', 'CG_REPLAY', 'CG_DESK'],
      'three in a row, and back on the desk camera');
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // A cut autopilot held during the first clip still wins at the end of the
  // chain: the next match loading is what the show would have done.
  const again = await clipOnDisk(0.5);
  try {
    const bus = new EventBus();
    const engine = new CueEngine(bus, fakeObs({ program: 'CG_DESK' }).obs, { clipsDir: again.dir });
    engine.attach();
    engine.setAutopilot('on-deck', true);
    const scenes = sceneLog(bus);
    let answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: again.clip });
    await answer;
    loadMatch(bus);
    await settle();
    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...again.clip, seconds: 0.3, takeId: 'take-2' } });
    await answer;
    await wait(600);
    assert.deepEqual(scenes, ['CG_REPLAY', 'CG_REPLAY', 'CG_MATCH'], 'the held On deck cut, late');
    engine.detach();
  } finally {
    await rm(again.dir, { recursive: true, force: true });
  }
});

test('a take pressed while the last clip is asking OBS where to cut back is never cut over', async () => {
  /*
   * The cut back asks OBS first, and that question takes a moment. A new
   * take landing in that moment is the picture now; the answer arriving for
   * the old clip must not cut away from it (seen: a one-frame cut to the desk
   * camera between two back-to-back replays).
   */
  const { dir, clip } = await clipOnDisk(0.05);
  try {
    const bus = new EventBus();
    const fake = fakeObs({ program: 'CG_SCORE' });
    const engine = new CueEngine(bus, fake.obs, { clipsDir: dir });
    engine.attach();
    let answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    assert.equal((await answer).type, 'replay.on_air');

    // The first clip's end asks OBS, and that one answer is held back.
    const ask = fake.raw.programScene.bind(fake.raw);
    let held: ((scene: string) => void) | null = null;
    let asked = 0;
    fake.raw.programScene = () => {
      asked++;
      return asked === 1 ? new Promise<string>(r => { held = r; }) : ask();
    };
    for (let i = 0; i < 50 && asked === 0; i++) await wait(10);
    assert.equal(asked, 1, 'the cut back is asking OBS');

    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, seconds: 0.2, takeId: 'take-2' } });
    assert.equal((await answer).type, 'replay.on_air');
    held!('CG_REPLAY');
    await wait(60);
    assert.deepEqual(fake.calls.map(c => c[1] ?? c[0]).slice(-1), ['CG_REPLAY'],
      'the old answer arriving mid-clip cuts nothing: the second replay stays on');
    assert.equal(bus.state.scene, 'CG_REPLAY');
    await wait(400);
    assert.deepEqual(fake.calls.map(c => c.join(' ')), [
      `playMedia ${REPLAY_INPUT} ${clip.path}`, 'setScene CG_REPLAY',
      `playMedia ${REPLAY_INPUT} ${clip.path}`, 'setScene CG_REPLAY',
      'setScene CG_SCORE',
    ], 'nothing between the two replays, and one cut back, after the second');
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stopped engine never cuts a camera later', async () => {
  const { dir, clip } = await clipOnDisk(0.05);
  try {
    const bus = new EventBus();
    const engine = new CueEngine(bus, fakeObs().obs, { clipsDir: dir });
    engine.attach();
    const scenes = sceneLog(bus);
    const answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    await answer;
    engine.detach();
    await wait(150);
    assert.deepEqual(scenes, ['CG_REPLAY']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('autopilot never cuts away from a replay while it runs; the field arming still does', async () => {
  /*
   * The field loads the next match 20 to 60 seconds after a post, exactly
   * when a replay is likely to be up, and the On deck cue cut the stream to
   * the field camera halfway through the clip, with the full-frame overview
   * over it. Manual wins: the cut is held, the overview waits for the clip,
   * and the take hands back when it ends.
   */
  const { dir, clip } = await clipOnDisk(0.3);
  try {
    const bus = new EventBus();
    const engine = new CueEngine(bus, fakeObs().obs, { clipsDir: dir });
    engine.attach();
    engine.setAll(true);
    loadMatch(bus);
    bus.emit({ type: 'match.start', source: 'cheesy' });
    bus.emit({ type: 'match.end', source: 'cheesy' });
    bus.emit({ type: 'match.score_posted', source: 'cheesy' });
    await settle();
    const scenes = sceneLog(bus);

    let answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    await answer;
    bus.emit({ type: 'match.loaded', source: 'cheesy',
      payload: { id: 'q43', displayName: 'Qualification 43', red: [], blue: [] } });
    await settle();
    assert.deepEqual(scenes, ['CG_REPLAY'], 'On deck does not cut the replay off');
    assert.equal(bus.state.screen, 'overview', 'the overview is next, for when the clip ends');
    assert.ok(bus.state.replayOnAir, 'and the overlay still stands aside for the clip');

    await wait(400);
    assert.deepEqual(scenes, ['CG_REPLAY', 'CG_MATCH'],
      'the clip ends where the held On deck cut wanted to go, not back on the score');

    // With nothing held, back where the program was before the take.
    await engine.fire('result');
    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, takeId: 'take-2' } });
    await answer;
    await wait(400);
    assert.deepEqual(scenes.slice(2), ['CG_SCORE', 'CG_REPLAY', 'CG_SCORE']);

    // The field arming is never held: the countdown needs the score bar.
    answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: { ...clip, seconds: 5, takeId: 'take-3' } });
    await answer;
    bus.emit({ type: 'match.armed', source: 'cheesy' });
    await settle();
    assert.deepEqual(scenes.slice(5), ['CG_REPLAY', 'CG_MATCH']);
    assert.equal(bus.state.screen, 'match');
    assert.equal(bus.state.replayOnAir, null);
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the gap-filler leaves a running replay alone, and that gap stays filled', async () => {
  const { dir, clip } = await clipOnDisk(0.6);
  try {
    const bus = new EventBus();
    const engine = new CueEngine(bus, fakeObs().obs, { clipsDir: dir });
    engine.attach();
    engine.setAutopilot('gap-filler', true);
    // Three minutes, less a breath: the take goes up just before the gap.
    bus.emit({ type: 'match.score_posted', source: 'cheesy', ts: Date.now() - 3 * 60_000 + 150 });
    const scenes = sceneLog(bus);
    const answer = nextAnswer(bus);
    bus.emit({ type: 'replay.play', source: 'manual', payload: clip });
    await answer;
    await wait(300);
    bus.emit({ type: 'rankings.updated', source: 'cheesy' });
    assert.deepEqual(scenes, ['CG_REPLAY'], 'no arcade over the replay');
    await wait(600);
    bus.emit({ type: 'rankings.updated', source: 'cheesy' });
    assert.deepEqual(scenes, ['CG_REPLAY', 'CG_MATCH'], 'nor the moment it ends');
    engine.detach();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
