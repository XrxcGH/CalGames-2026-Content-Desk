import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { Slides } from './slides.ts';

const CONFIG = [
  { id: 'syscore', kind: 'info', title: 'SystemCore session',
    lines: ['Saturday 12:30, Room 201'] },
  { id: 'setup-crew', kind: 'recognition', title: 'Thank you, setup crew',
    lines: ['Ana, Ben, Cy, Dee'] },
];

const scratch = () => mkdtemp(join(tmpdir(), 'cg-slides-'));

test('the deck rotates and the show takes the program screen', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const slides = new Slides(dir, bus, CONFIG);
    const seen: string[] = [];
    bus.subscribe(ev => { if (ev.type === 'slide.show') seen.push((ev.payload as { id: string }).id); });

    slides.next();
    slides.next();
    slides.next();                      // wraps
    assert.deepEqual(seen, ['syscore', 'setup-crew', 'syscore']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('slides typed at the event survive a restart', async () => {
  // Names get typed on Saturday. A desk restart at lunch must not eat them;
  // that is the entire reason data/slides.json exists.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), []);
    await slides.load();
    await slides.add({ kind: 'recognition', title: 'Thank you, Friday crew',
      lines: ['Load-in and field build'] });

    const reopened = new Slides(dir, new EventBus(), []);
    await reopened.load();
    assert.equal(reopened.deck[0]?.title, 'Thank you, Friday crew');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a shout-out is queued, not aired: the human is the gate', async () => {
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const emitted: string[] = [];
    bus.subscribe(ev => emitted.push(ev.type));
    const slides = new Slides(dir, bus, []);

    await slides.submit({ name: 'Ana', team: 846,
      message: 'Team 1868 lent us their spare radio five minutes before our match' });

    assert.equal(slides.deck.length, 0, 'NOT in the deck the side screens read');
    assert.equal(emitted.length, 0, 'and nothing was emitted anywhere');
    assert.equal(slides.queue.length, 1, 'it is waiting for a person');

    const slide = await slides.approve(slides.queue[0]!.id);
    assert.equal(slide.kind, 'shoutout');
    assert.equal(slides.deck.length, 1, 'approval is what puts it in the deck');
    assert.match(slide.lines[1]!, /Ana, Team 846/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pending queue survives a restart too', async () => {
  // Submissions arrive while the moderator is busy running a match. A restart
  // that dropped the queue would silently eat the crowd's contributions.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), []);
    await slides.load();
    await slides.submit({ name: 'Ana', message: 'Somebody did a genuinely kind thing today' });

    const reopened = new Slides(dir, new EventBus(), []);
    await reopened.load();
    assert.equal(reopened.queue.length, 1);
    await reopened.reject(reopened.queue[0]!.id);
    assert.equal(reopened.queue.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the screeners and the rate limit hold the door', async () => {
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), []);

    await assert.rejects(() => slides.submit({ name: 'fuck', message: 'a perfectly fine message here' }),
      /different name/);
    await assert.rejects(() => slides.submit({ name: 'Ana', message: 'fuck this event honestly' }),
      /big-screen friendly/);
    await assert.rejects(() => slides.submit({ name: 'Ana', message: 'too short' }),
      /a little more/);

    // Five from one address is plenty; the sixth waits.
    for (let i = 0; i < 5; i++) {
      await slides.submit({ name: 'Ana', message: `A genuinely gracious thing number ${i} happened` },
        '10.0.100.9');
    }
    await assert.rejects(
      () => slides.submit({ name: 'Ana', message: 'A sixth gracious thing happened just now' },
        '10.0.100.9'),
      /plenty for now/);
    // A different phone is not punished for the first one's enthusiasm.
    await slides.submit({ name: 'Ben', message: 'A different phone saw something gracious too' },
      '10.0.100.10');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the saved file never contains a live slide marker, only content', async () => {
  // What persists is the deck and the queue. Which slide is on screen is show
  // state, and resurrecting it after a restart would put a slide on program
  // that nobody standing at the desk chose to put there.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), CONFIG);
    await slides.load();
    await slides.add({ title: 'Typed one', kind: 'info' });
    slides.next();
    const raw = JSON.parse(await readFile(join(dir, 'data', 'slides.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['added', 'queue']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('simultaneous submissions cannot tear the saved file', async () => {
  // submit() is the crowd-writable path: two phones in the same instant used
  // to share one .tmp path, interleave their writes, and publish torn JSON
  // that the next boot silently dropped, taking the whole pending queue and
  // every typed name with it. Saves are serialised now; hammer them
  // concurrently and the file on disk must hold every submission, parseable.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), []);
    await Promise.all([
      slides.add({ title: 'Typed during the rush', kind: 'recognition' }),
      ...Array.from({ length: 8 }, (_, i) =>
        slides.submit({ name: 'Ana', message: `A genuinely gracious thing number ${i} happened` },
          `10.0.0.${i}`)),
    ]);

    const raw = JSON.parse(await readFile(join(dir, 'data', 'slides.json'), 'utf8'));
    assert.equal(raw.queue.length, 8, 'every submission reached the disk intact');
    assert.equal(raw.added.length, 1, 'and so did the slide typed mid-rush');

    const reopened = new Slides(dir, new EventBus(), []);
    await reopened.load();
    assert.equal(reopened.queue.length, 8);
    assert.equal(reopened.deck.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an approved shout-out survives a restart at full length', async () => {
  // submit() allows 200 characters and approve() airs the message whole. The
  // reload path used to re-import it through the 90-character desk cap, so a
  // restart quietly cut an approved message mid-word and the projector showed
  // something the moderator never approved.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), []);
    const message = 'Team 1868 spent forty minutes of their own lunch break rewiring a '
      + 'rookie team\'s entire electrical board so they could play their first ever '
      + 'elimination match of the season';
    assert.ok(message.length > 90 && message.length <= 200, 'long enough to catch the old cap');
    await slides.submit({ name: 'Ana', team: 846, message });
    await slides.approve(slides.queue[0]!.id);

    const reopened = new Slides(dir, new EventBus(), []);
    await reopened.load();
    assert.equal(reopened.deck[0]?.lines[0], message,
      'what the moderator approved is what airs, before and after a reboot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a duplicate config id cannot wedge the rotation', async () => {
  // config.json is hand-edited, which is exactly where a copy-paste duplicate
  // happens. show() snaps the cursor to the FIRST slide matching an id, so a
  // duplicate used to pin next() to the first copy forever: the operator saw
  // the same card repaint with no error, and everything after it never aired.
  const dir = await scratch();
  try {
    const bus = new EventBus();
    const slides = new Slides(dir, bus, [
      { id: 'thanks', kind: 'info', title: 'Thanks A', lines: [] },
      { id: 'thanks', kind: 'info', title: 'Thanks B (the copy-paste)', lines: [] },
      { id: 'food', kind: 'info', title: 'Food trucks', lines: [] },
    ]);
    const seen: string[] = [];
    bus.subscribe(ev => {
      if (ev.type === 'slide.show') seen.push((ev.payload as { title: string }).title);
    });

    assert.equal(slides.deck.length, 2, 'the duplicate is dropped, first one wins');
    slides.next();
    slides.next();
    slides.next();                      // wraps: every surviving slide airs
    assert.deepEqual(seen, ['Thanks A', 'Food trucks', 'Thanks A']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config slides cannot be removed from the console', async () => {
  // config.json is a file a human owns. The console edits the runtime list;
  // removing a config slide silently would have it resurrect on next boot,
  // which reads as a bug at the worst possible time.
  const dir = await scratch();
  try {
    const slides = new Slides(dir, new EventBus(), CONFIG);
    assert.equal(await slides.remove('syscore'), false);
    assert.equal(slides.deck.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
