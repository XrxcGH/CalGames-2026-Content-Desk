import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../bus.ts';
import { HouseAudio, type MusicController, type MusicStatus } from './store.ts';
import { ClipLibrary, looksLikeAudio, parseWalkupName } from './library.ts';

/** A music service that records what it was told, and can start failing. */
class FakeMusic implements MusicController {
  readonly name = 'Fake';
  linked = true;
  calls: string[] = [];
  volume = 70;
  playing = false;
  dead = false;

  #guard(what: string): void {
    this.calls.push(what);
    if (this.dead) throw new Error('the venue uplink is down');
  }
  async status(): Promise<MusicStatus> {
    this.#guard('status');
    return {
      playing: this.playing, device: 'Music Mac', volume: this.volume,
      now: { title: 'A Song', artist: 'Somebody', art: null, durationMs: 1000, progressMs: 0, sampledAt: Date.now() },
      context: null,
    };
  }
  async play(): Promise<void> { this.#guard('play'); this.playing = true; }
  async pause(): Promise<void> { this.#guard('pause'); this.playing = false; }
  async next(): Promise<void> { this.#guard('next'); }
  async previous(): Promise<void> { this.#guard('previous'); }
  async setVolume(p: number): Promise<void> { this.#guard('volume'); this.volume = p; }
  async playlists(): Promise<{ uri: string; name: string }[]> {
    this.#guard('playlists');
    return [{ uri: 'spotify:playlist:1', name: 'Event' }];
  }
}

/** A clip library backed by real files, since that is what the store reads. */
async function libraryWith(files: string[]): Promise<{ lib: ClipLibrary; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cg-audio-'));
  await mkdir(join(dir, 'audio', 'walkups'), { recursive: true });
  for (const f of files) {
    // A real ten-byte ID3v2 header. Written as an escaped byte array rather
    // than literal control characters in a string: the previous version put
    // the raw bytes in the source, which made git store this entire test
    // file as BINARY and stop diffing it.
    //
    // scan() does NOT sniff. It filters by extension; ingest() is the path
    // that checks the magic, and the fixture comment used to claim
    // otherwise. The header is here so one fixture feeds both.
    await writeFile(join(dir, 'audio', 'walkups', f),
      Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  }
  const lib = new ClipLibrary(dir);
  await lib.scan();
  return { lib, dir };
}

test('a walk-up file name gives up its team and its title', () => {
  assert.deepEqual(parseWalkupName('254'), { team: 254, label: '' },
    'a bare number has no title to show beside it');
  assert.deepEqual(parseWalkupName('254 - Chariots of Fire'),
    { team: 254, label: 'Chariots of Fire' });
  assert.deepEqual(parseWalkupName('1678_Citrus'), { team: 1678, label: 'Citrus' });
  // No leading number is a stinger, because guessing a team wrong is worse
  // than showing one fewer button.
  assert.deepEqual(parseWalkupName('airhorn'), { team: null, label: 'airhorn' });
});

test('the sniff test refuses a renamed file', () => {
  // Real headers run past the 12-byte floor; anything shorter than that is
  // not a playable file whatever its extension claims.
  assert.ok(looksLikeAudio(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12)])));
  assert.ok(looksLikeAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(4)])));
  assert.ok(looksLikeAudio(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])));
  assert.ok(!looksLikeAudio(Buffer.from('<!doctype html><html>hello</html>')));
  assert.ok(!looksLikeAudio(Buffer.alloc(4)));
});

test('walk-ups are found by team and sorted for an introduction', async () => {
  const { lib, dir } = await libraryWith(['254.mp3', '846 - Funky.mp3', 'airhorn.mp3']);
  try {
    assert.equal(lib.clips.length, 3);
    assert.equal(lib.forTeam(846)?.label, 'Funky');
    assert.equal(lib.forTeam(9999), null);
    // Teams in number order first, stingers last: an introduction runs in
    // seed order under time pressure.
    assert.deepEqual(lib.clips.map(c => c.team), [254, 846, null]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a walk-up ducks the music and hands the room back when it ends', async () => {
  const { lib, dir } = await libraryWith(['254.mp3']);
  try {
    const music = new FakeMusic();
    const house = new HouseAudio(new EventBus(), { controller: music, library: lib });

    await house.play();
    assert.equal(house.snapshot.source, 'playlist');

    const withClip = await house.playClip(254);
    assert.equal(withClip.source, 'clip');
    assert.equal(withClip.clip?.team, 254);
    assert.ok(withClip.music.ducked, 'the bed drops under a walk-up rather than cutting');

    const done = await house.clipEnded(withClip.clip!.token);
    assert.equal(done.source, 'playlist', 'the room goes back to what it had');
    assert.equal(done.clip, null);
    assert.ok(!done.music.ducked);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale clip-ended report cannot cancel the walk-up that replaced it', async () => {
  const { lib, dir } = await libraryWith(['254.mp3', '846.mp3']);
  try {
    const house = new HouseAudio(new EventBus(), { controller: new FakeMusic(), library: lib });
    const first = await house.playClip(254);
    const second = await house.playClip(846);
    assert.notEqual(first.clip!.token, second.clip!.token);

    const after = await house.clipEnded(first.clip!.token);
    assert.equal(after.source, 'clip', 'the second walk-up is still playing');
    assert.equal(after.clip?.team, 846);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('game audio and silence pause the music; the playlist resumes it', async () => {
  const { lib, dir } = await libraryWith([]);
  try {
    const music = new FakeMusic();
    const house = new HouseAudio(new EventBus(), { controller: music, library: lib });

    await house.setSource('console', 'Arcade is on the program');
    assert.equal(music.playing, false, 'the console needs the room, not a bed under it');
    await house.setSource('silent', 'Field is ready');
    assert.equal(music.playing, false);
    await house.setSource('playlist', 'Score posted');
    assert.equal(music.playing, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dead music service never breaks the desk, and says so', async () => {
  const { lib, dir } = await libraryWith(['254.mp3']);
  try {
    const music = new FakeMusic();
    const house = new HouseAudio(new EventBus(), { controller: music, library: lib });
    await house.play();
    music.dead = true;

    // The uplink dying mid-show must not throw into a route handler or a cue.
    const after = await house.pause();
    assert.equal(after.music.reachable, false);
    assert.ok(after.music.error, 'the desk is told why');

    // And the clips, which are local files, still work.
    const clip = await house.playClip(254);
    assert.equal(clip.clip?.team, 254);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing walk-up is refused by name rather than failing silently', async () => {
  const { lib, dir } = await libraryWith([]);
  try {
    const house = new HouseAudio(new EventBus(), { controller: null, library: lib });
    await assert.rejects(() => house.playClip(254), /No walk-up loaded for team 254/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('house players are counted, and a stale one stops counting', async () => {
  const { lib, dir } = await libraryWith([]);
  try {
    const house = new HouseAudio(new EventBus(), { controller: null, library: lib });
    assert.deepEqual(house.snapshot.players, { alive: 0, armed: 0 });

    house.notePlayer('a', true);
    house.notePlayer('b', false);
    assert.deepEqual(house.snapshot.players, { alive: 2, armed: 1 },
      'an unarmed page cannot make a sound and must not be counted as ready');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every change publishes one audio.updated snapshot on the bus', async () => {
  const { lib, dir } = await libraryWith(['254.mp3']);
  try {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe(ev => { if (ev.type === 'audio.updated') seen.push(ev.payload); });
    const house = new HouseAudio(bus, { controller: new FakeMusic(), library: lib });

    await house.play();
    await house.playClip(254);
    await house.pause();
    assert.ok(seen.length >= 3, `expected a publish per change, saw ${seen.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a walk-up does not permanently turn the room down', async () => {
  // The device reports DUCK_VOLUME while a clip is over the bed. Adopting that
  // as the operator's intended volume meant unducking "restored" the music to
  // 22%, and every walk-up outlives the five-second poll, so after the first
  // alliance introduction the room stayed quiet for the rest of the day.
  const { lib, dir } = await libraryWith(['846 - Funky.mp3']);
  try {
    const music = new FakeMusic();
    const audio = new HouseAudio(new EventBus(), { controller: music, library: lib });
    await audio.setSource('playlist', 'test');   // so there is a bed to come back to
    await audio.setVolume(70);

    await audio.playClip(846);
    assert.equal(music.volume, 22, 'ducked under the walk-up');
    await audio.refresh();                      // the poll, mid-clip
    await audio.clipEnded();
    assert.equal(music.volume, 70, 'the bed comes back where the operator left it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('switching playlists over a clip does not leave it to fire again', async () => {
  // The house player nulls its own token when the audio ends, so a clip still
  // sitting in the snapshot reads to it as one it has not seen. It replayed
  // the walk-up from the top over the new playlist.
  const { lib, dir } = await libraryWith(['846 - Funky.mp3']);
  try {
    const music = new FakeMusic();
    const audio = new HouseAudio(new EventBus(), { controller: music, library: lib });
    await audio.playClip(846);
    assert.ok(audio.snapshot.clip, 'the clip is live');

    await audio.playPlaylist('spotify:playlist:2');
    assert.equal(audio.snapshot.clip, null, 'gone the moment the source moves on');

    // And the late "it finished" report must not resurrect it either.
    await audio.clipEnded();
    assert.equal(audio.snapshot.clip, null);
    assert.equal(audio.snapshot.source, 'playlist');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a walk-up named with a plain space still binds to its team', async () => {
  // "846 Funky Town.mp3" scanned as a STINGER, so the file looked loaded and
  // then playClip(846) threw during alliance introductions.
  assert.deepEqual(parseWalkupName('846 Funky Town'), { team: 846, label: 'Funky Town' });
  assert.deepEqual(parseWalkupName('254 - Chariots of Fire'),
    { team: 254, label: 'Chariots of Fire' });
  assert.deepEqual(parseWalkupName('254'), { team: 254, label: '' });
  assert.deepEqual(parseWalkupName('Air horn'), { team: null, label: 'Air horn' });
});

test('ingest refuses a file that is not audio, and stores one that is', async () => {
  // ingest() is the path that sniffs; scan() only filters by extension. This
  // had no coverage at all, which is how the fixture comment claiming
  // otherwise survived.
  const dir = await mkdtemp(join(tmpdir(), 'cg-audio-'));
  try {
    const lib = new ClipLibrary(dir);
    await lib.scan();
    await assert.rejects(
      () => lib.ingest('walkup', '846 - Nope.mp3', Buffer.from('this is a text file, really')),
      /audio/i);

    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);
    const clip = await lib.ingest('walkup', '846 - Yes.ogg', ogg);
    assert.equal(clip.team, 846);
    assert.ok(lib.clips.some(c => c.team === 846), 'and it is immediately playable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the poll publishes only when something on a screen would change", async () => {
  // It published every five seconds regardless: the whole snapshot, logged
  // and sent to every socket, about 64 MB of event log over a day.
  const { lib, dir } = await libraryWith(['254.mp3']);
  try {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe(ev => { if (ev.type === 'audio.updated') seen.push(ev.payload); });
    const fake = new FakeMusic();
    const house = new HouseAudio(bus, { controller: fake, library: lib });
    await house.refresh();
    const first = seen.length;
    await house.refresh();
    await house.refresh();
    assert.equal(seen.length, first, 'an idle poll is not news');
    fake.playing = true;
    await house.refresh();
    assert.equal(seen.length, first + 1, 'starting to play is');
    await house.refresh();
    assert.equal(seen.length, first + 1, 'playing on is not: the bar runs by itself');
    fake.volume = 40;
    await house.refresh();
    assert.equal(seen.length, first + 2, 'a volume change is');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
