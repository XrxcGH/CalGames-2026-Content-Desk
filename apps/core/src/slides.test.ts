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
  // Names get typed on Saturday. A desk restart at lunch must not eat them —
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
