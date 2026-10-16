/**
 * The program overlay, driven for real: surfaces/program/program.js, fed by
 * the real shared client (desk-client.js) over a stand-in socket, with frames
 * built by the real reducer.
 *
 * program.js is DOM code whose imports are server paths ('/shared/...'), so
 * it cannot be imported as it stands. The test copies it to a temp file with
 * those paths pointed at the same files on disk, and nothing else changed,
 * and gives it the handful of browser globals it touches: a document whose
 * elements only remember what was done to them, a socket, and a frame clock
 * the test turns by hand. Its pure decisions live in decide.js, run directly
 * below as well (the same arrangement as surfaces/replay/timeline.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventBus, type EmitInit } from './bus.ts';
import type { DeskState } from './types.ts';

const SURFACES = fileURLToPath(new URL('../../../surfaces/', import.meta.url));

interface Keys { cards: string; photos: string }
interface Decide {
  overviewKeys: (match: unknown, label: (n: number) => string,
    photoOf: (n: number) => string | null) => Keys | null;
  overviewChange: (was: Keys | null, now: Keys | null) => 'build' | 'photos' | null;
  backLine: (backAt: number | null | undefined, now: number, clock: (ms: number) => string) => string;
}
// @ts-expect-error untyped browser module, cast on the same line
const decide = (await import('../../../surfaces/program/decide.js')) as Decide;

const team = (number: number) => ({ number, name: `Team ${number}` });
const match = (id: string, red: number[], blue: number[]) =>
  ({ id, displayName: `Qualification ${id.slice(1)}`, red: red.map(team), blue: blue.map(team) });
const plain = (n: number): string => String(n);

// ---- the decisions, on their own ----------------------------------------------

test('the overview rebuilds for a new lineup, swaps for a photo, and otherwise holds still', () => {
  const q42 = match('q42', [254, 1678, 971], [604, 3256, 8]);
  const none = (): null => null;
  const k0 = decide.overviewKeys(q42, plain, none);
  assert.equal(decide.overviewChange(null, k0), 'build', 'the first match draws its cards');

  // A photo for a team that is not in this match: a pit photo uploaded on
  // Saturday morning for a team playing later.
  const elsewhere = decide.overviewKeys(q42, plain, n => (n === 9999 ? '/media/teams/9999/robot.v1.png' : null));
  assert.equal(decide.overviewChange(k0, elsewhere), null, 'nothing on screen changed');

  const photo = (n: number): string | null => (n === 254 ? '/media/teams/254/robot.v1.png' : null);
  const k1 = decide.overviewKeys(q42, plain, photo);
  assert.equal(decide.overviewChange(k0, k1), 'photos', 'a team on the field got a photo');
  // A re-upload is a new version, so a new URL.
  const k2 = decide.overviewKeys(q42, plain, n => (n === 254 ? '/media/teams/254/robot.v2.png' : null));
  assert.equal(decide.overviewChange(k1, k2), 'photos');

  assert.equal(decide.overviewChange(k1, decide.overviewKeys(q42, plain, photo)), null,
    'the same match and photos, as every snapshot after a reconnect sends');

  // A substitution: the arena re-sends the same match id with a team swapped.
  const sub = decide.overviewKeys(match('q42', [254, 1678, 5940], [604, 3256, 8]), plain, photo);
  assert.equal(decide.overviewChange(k1, sub), 'build');
  // A second robot's label arriving later is what the card prints.
  const labelled = decide.overviewKeys(q42, n => (n === 9999 ? '100B' : String(n)), photo);
  assert.equal(decide.overviewChange(k1, labelled), null, 'a label for a team not in the match');
  const relabelled = decide.overviewKeys(q42, n => (n === 254 ? '254B' : String(n)), photo);
  assert.equal(decide.overviewChange(k1, relabelled), 'build', 'a label a card prints');
  assert.equal(decide.overviewChange(k1, decide.overviewKeys(match('q43', [254, 1678, 971], [604, 3256, 8]),
    plain, photo)), 'build', 'the next match, even with the same six teams');

  assert.equal(decide.overviewKeys(null, plain, none), null);
  assert.equal(decide.overviewChange(k1, null), null, 'no match: the cards are left as they are');
});

test('a status card stops promising a time once it has passed', () => {
  const backAt = Date.UTC(2026, 9, 17, 21, 37);
  const clock = (ms: number): string => `T${ms === backAt ? 'back' : ms}`;
  assert.equal(decide.backLine(backAt, backAt - 60_000, clock), 'Back ~Tback');
  assert.equal(decide.backLine(backAt, backAt - 1, clock), 'Back ~Tback');
  assert.equal(decide.backLine(backAt, backAt, clock), 'Back soon');
  assert.equal(decide.backLine(backAt, backAt + 13 * 60_000, clock), 'Back soon',
    'an Awards Break running long reads as still on, not as a time in the past');
  assert.equal(decide.backLine(null, backAt, clock), '');
  assert.equal(decide.backLine(undefined, backAt, clock), '');
});

// ---- program.js itself ----------------------------------------------------------

interface FakeEl {
  id: string;
  dataset: Record<string, string>;
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  children: FakeEl[];
  querySelector: (sel: string) => FakeEl | null;
  [rest: string]: unknown;
}

interface Page {
  el: (id: string) => FakeEl;
  /** Every time a robots column had its cards replaced, by column id. */
  builds: string[];
  /** Every picture swapped inside a card that was already there. */
  swaps: { team: number; html: string }[];
  send: (msg: unknown) => Promise<void>;
  /** Run the frames the page has asked for, as a browser would on its next paint. */
  paint: () => void;
}

const ROBOT_COLUMNS = new Set(['redRobots', 'blueRobots']);

/**
 * program.js, loaded fresh, on a stand-in browser. The globals stay in place
 * afterwards on purpose: the page's own timers (its screen sweep, a card's
 * fade) can still fire after a test ends, and this file runs in a process of
 * its own.
 */
async function openProgram(): Promise<Page> {
  const g = globalThis as unknown as Record<string, unknown>;
  const builds: string[] = [];
  const swaps: { team: number; html: string }[] = [];
  const els = new Map<string, FakeEl>();

  const make = (id: string, onHtml?: (html: string, self: FakeEl) => void): FakeEl => {
    const attrs = new Set<string>();
    let html = '';
    const node: FakeEl = {
      id, dataset: {}, hidden: false, textContent: '', children: [],
      style: { setProperty() {} }, className: '', offsetWidth: 0, scrollWidth: 0, clientWidth: 0,
      classList: { add() {}, remove() {}, toggle() {} },
      toggleAttribute(n: string, on?: boolean) { if (on ?? !attrs.has(n)) attrs.add(n); else attrs.delete(n); },
      setAttribute(n: string) { attrs.add(n); },
      removeAttribute(n: string) { attrs.delete(n); },
      hasAttribute(n: string) { return attrs.has(n); },
      addEventListener() {}, removeEventListener() {}, replaceChildren() {}, append() {},
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      querySelector: () => null,
      get firstElementChild() { return node; },
      get lastElementChild() { return node; },
      get innerHTML() { return html; },
      set innerHTML(v: string) { html = v; onHtml?.(v, node); },
    };
    return node;
  };

  /** The cards a column's markup describes, each with a plate whose picture can be swapped. */
  const cardsOf = (markup: string): FakeEl[] => markup.split('<div class="robot ').slice(1).map(chunk => {
    const card = make('');
    const attr = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(chunk)?.[1] ?? '';
    card.dataset['team'] = attr('data-team');
    card.dataset['src'] = attr('data-src');
    card.dataset['photo'] = attr('data-photo');
    const teamNo = Number(card.dataset['team']);
    // Counted from after the card was drawn: only a later write is a swap.
    let drawn = false;
    const plate = make('', v => { if (drawn) swaps.push({ team: teamNo, html: v }); });
    plate.innerHTML = /<div class="robot-art">([\s\S]*?)<\/div>\s*<div class="robot-id">/.exec(chunk)?.[1] ?? '';
    drawn = true;
    card.querySelector = sel => (sel === '.robot-art' ? plate : null);
    return card;
  });

  const el = (id: string): FakeEl => {
    let node = els.get(id);
    if (!node) {
      node = make(id, ROBOT_COLUMNS.has(id) ? (v, self) => { builds.push(id); self.children = cardsOf(v); } : undefined);
      els.set(id, node);
    }
    return node;
  };

  const frames: ((now: number) => void)[] = [];
  const sockets: { onmessage: ((e: { data: string }) => void) | null }[] = [];
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: unknown = null; onclose: unknown = null; onerror: unknown = null;
    constructor() { sockets.push(this); }
    send(): void {}
    close(): void {}
  }

  g['location'] = { pathname: '/s/program', search: '', host: 'desk.test', protocol: 'http:' };
  g['WebSocket'] = FakeWS;
  // The REST head start answers nothing, so the socket is the only path in.
  g['fetch'] = async () => ({ ok: false });
  g['document'] = {
    hidden: false, documentElement: make('html'),
    getElementById: el, createElement: () => make(''),
    addEventListener() {}, removeEventListener() {},
  };
  g['requestAnimationFrame'] = (fn: (now: number) => void) => { frames.push(fn); return frames.length; };
  g['cancelAnimationFrame'] = () => {};
  g['addEventListener'] = () => {};
  g['innerWidth'] = 1920;
  g['innerHeight'] = 1080;
  g['getComputedStyle'] = () => ({ getPropertyValue: () => '' });
  // Reduced motion: the score roll lands at once instead of over frames.
  g['matchMedia'] = () => ({ matches: true });

  // The page as served, with its server paths pointed at the files behind them.
  const source = await readFile(join(SURFACES, 'program', 'program.js'), 'utf8');
  const local = source.replace(/from '\/(shared|s\/program)\/([\w.-]+)'/g, (_m, dir: string, file: string) =>
    `from '${pathToFileURL(join(SURFACES, dir === 'shared' ? '_shared' : 'program', file)).href}'`);
  assert.doesNotMatch(local, /from '\//, 'every server path in program.js was pointed at a file');
  const dir = await mkdtemp(join(tmpdir(), 'cg-program-'));
  const file = join(dir, 'program.mjs');
  await writeFile(file, local);

  // The client's liveness watchdog and the ticker's backstop are intervals
  // that would keep this process alive; neither is what is under test.
  const realInterval = g['setInterval'];
  g['setInterval'] = () => 0;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    g['setInterval'] = realInterval;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(sockets.length, 1, 'the page opened its socket');

  return {
    el, builds, swaps,
    send: async msg => {
      sockets[0]!.onmessage!({ data: JSON.stringify(msg) });
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    },
    paint: () => { for (const fn of frames.splice(0)) fn(performance.now()); },
  };
}

/** A desk state the real reducer built from these events. */
function deskAfter(...events: EmitInit[]): DeskState {
  const bus = new EventBus();
  for (const ev of events) bus.emit(ev);
  return bus.state;
}

const loaded = (m: ReturnType<typeof match>) =>
  ({ type: 'match.loaded' as const, source: 'cheesy' as const, payload: m });
const snapshot = (state: DeskState, media: Record<number, { src: string }> = {}) =>
  ({ t: 'snapshot', state, media, needsPin: false });
const photo = (n: number, v = 1) => ({ src: `/media/teams/${n}/robot.v${v}.png` });
const column = (p: Page, id: string): number[] => p.el(id).children.map(c => Number(c.dataset['team']));

test('a photo upload never replays the overview\'s entrance on air', async () => {
  /*
   * The desk sends every page a whole snapshot after each photo upload,
   * sample seed and clear, and the overlay rebuilt the overview on every
   * one. A rebuild re-inserts the robot cards, whose entrance starts from
   * nothing, so all six robots blinked out and slid back in on air once
   * per photo, for most of every gap between matches.
   */
  const page = await openProgram();
  const q42 = match('q42', [254, 1678, 971], [604, 3256, 8]);
  const state = deskAfter(loaded(q42));

  await page.send(snapshot(state));
  assert.deepEqual(page.builds, ['redRobots', 'blueRobots'], 'the match draws its cards once');
  assert.deepEqual(column(page, 'redRobots'), [254, 1678, 971]);
  assert.equal(page.el('ovLabel').textContent, 'Qualification 42');

  // A pit photo for a team playing later in the day.
  await page.send(snapshot(state, { 9999: photo(9999) }));
  assert.deepEqual(page.builds, ['redRobots', 'blueRobots'], 'a photo for a team not on screen changes nothing');
  assert.equal(page.swaps.length, 0);

  // A photo for a robot on the overview: into its card, in place.
  await page.send(snapshot(state, { 9999: photo(9999), 254: photo(254) }));
  assert.deepEqual(page.builds, ['redRobots', 'blueRobots'], 'the cards are not rebuilt');
  assert.equal(page.swaps.length, 1, 'only the card whose photo changed is touched');
  assert.equal(page.swaps[0]!.team, 254);
  assert.match(page.swaps[0]!.html, /<img src="\/media\/teams\/254\/robot\.v1\.png"/);
  const card254 = page.el('redRobots').children[0]!;
  assert.equal(card254.dataset['photo'], 'true', 'and the card lays itself out for a photo');

  // The same again (a reconnect, or a sample clear that left these alone),
  // then an ordinary event frame: nothing moves.
  await page.send(snapshot(state, { 9999: photo(9999), 254: photo(254) }));
  await page.send({ t: 'event', ev: { type: 'rankings.updated' }, state });
  assert.deepEqual(page.builds, ['redRobots', 'blueRobots']);
  assert.equal(page.swaps.length, 1);

  // A re-upload is a new version: swapped again. A deleted photo goes back
  // to the printed number.
  await page.send(snapshot(state, { 254: photo(254, 2) }));
  assert.match(page.swaps.at(-1)!.html, /robot\.v2\.png/);
  await page.send(snapshot(state, {}));
  assert.match(page.swaps.at(-1)!.html, /robot-art--fallback.*>254</s);
  assert.equal(card254.dataset['photo'], 'false');
  assert.deepEqual(page.builds, ['redRobots', 'blueRobots'], 'and still no rebuild');

  // The next match, and a substitution under the same id, are new cards.
  const q43 = deskAfter(loaded(q42), loaded(match('q43', [5940, 1678, 971], [604, 3256, 8])));
  await page.send({ t: 'event', ev: { type: 'match.loaded' }, state: q43 });
  assert.equal(page.builds.length, 4, 'a new match plays its entrance');
  assert.deepEqual(column(page, 'redRobots'), [5940, 1678, 971]);
  const sub = deskAfter(loaded(match('q43', [5940, 1678, 973], [604, 3256, 8])));
  await page.send({ t: 'event', ev: { type: 'match.loaded' }, state: sub });
  assert.equal(page.builds.length, 6, 'so does a substitution');
});

test('the break card on the stream says "Back soon" once its time has gone', async () => {
  /*
   * The field's Awards Break card carries the arena's scheduled end, the
   * ceremony overruns, and the card stays until the field comes back: the
   * stream read "Back ~2:37 PM" at ten to three. Nothing arrives on the bus
   * at the moment the time passes, so the page has to notice on its clock.
   */
  const page = await openProgram();
  const state = deskAfter(
    loaded(match('q42', [254, 1678, 971], [604, 3256, 8])),
    { type: 'break.started', source: 'cheesy', payload: { label: 'Awards Break *', seconds: 900 } },
  );
  const backAt = state.status?.backAt;
  assert.ok(backAt, 'the reducer stamped the break with its end');

  await page.send({ t: 'hb', now: backAt - 5 * 60_000 });
  await page.send(snapshot(state));
  assert.equal(page.el('statusMsg').textContent, 'Awards Break');
  assert.equal(page.el('statusBack').hidden, false);
  assert.match(page.el('statusBack').textContent, /^Back ~\d{1,2}:\d{2}/, 'a time while it is still ahead');

  // The desk's clock passes the time, with the bus quiet.
  await page.send({ t: 'hb', now: backAt + 13 * 60_000 });
  page.paint();
  assert.equal(page.el('statusBack').textContent, 'Back soon');
  assert.equal(page.el('statusBack').hidden, false);
  assert.equal(page.el('statusMsg').textContent, 'Awards Break', 'the card still says what is happening');

  // And a fresh frame in the overrun paints it the same way.
  await page.send({ t: 'event', ev: { type: 'rankings.updated' }, state });
  assert.equal(page.el('statusBack').textContent, 'Back soon');

  // A card with no time never grows one.
  const noTime = deskAfter({ type: 'status.show', source: 'manual',
    payload: { kind: 'review', message: 'Under review' } });
  await page.send({ t: 'event', ev: { type: 'status.show' }, state: noTime });
  page.paint();
  assert.equal(page.el('statusBack').hidden, true);
});

test('a lower third whose dwell ran out long ago stays off when the overlay reloads', async () => {
  /*
   * The reducer keeps an unpinned third until somebody hides it; only the
   * overlay retires it, on its dwell (8 s unless the theme says otherwise).
   * OBS restarting, its Browser Source refreshing or a pit kiosk reloading
   * put the morning's name strip back over the afternoon for a full dwell.
   */
  const shownAt = (el: FakeEl): boolean =>
    (el as unknown as { hasAttribute: (n: string) => boolean }).hasAttribute('data-show');
  const strip = { line1: 'Morning Interview Guest', line2: 'Team 254 mentor' };
  /** A page loading now onto a desk that showed this third `ago` ms before. */
  const reload = async (pinned: boolean, ago: number): Promise<{ page: Page; state: DeskState }> => {
    const page = await openProgram();
    const now = Date.now();
    const state = deskAfter(
      { type: 'lower_third.show', source: 'manual', ts: now - ago, payload: { ...strip, pinned } },
      // The desk has carried on since: the schedule and rankings polls.
      { type: 'rankings.updated', source: 'cheesy', ts: now },
    );
    // In the order the server sends them to a new socket.
    await page.send({ t: 'hb', now });
    await page.send(snapshot(state));
    return { page, state };
  };

  const hoursAgo = 3 * 3_600_000;
  const old = await reload(false, hoursAgo);
  assert.equal(shownAt(old.page.el('third')), false, 'the morning\'s strip stays retired');
  assert.equal(old.page.el('thirdT1').textContent, '');
  // And stays that way through the frames that follow.
  await old.page.send({ t: 'event', ev: { type: 'rankings.updated' }, state: old.state });
  assert.equal(shownAt(old.page.el('third')), false);
  // A fresh show of the same words is a fresh third.
  const again = deskAfter({ type: 'lower_third.show', source: 'manual', payload: { ...strip, pinned: false } });
  await old.page.send({ t: 'event', ev: { type: 'lower_third.show' }, state: again });
  assert.equal(shownAt(old.page.el('third')), true, 'shown again on purpose, it airs');

  // A pinned one is up until somebody hides it, however long ago it went up.
  const pinned = await reload(true, hoursAgo);
  assert.equal(shownAt(pinned.page.el('third')), true, 'a pinned third is still on');
  assert.equal(pinned.page.el('thirdT1').textContent, strip.line1);

  // One still inside its dwell gets what is left of it, not a whole dwell.
  const recent = await reload(false, 7_400);
  assert.equal(shownAt(recent.page.el('third')), true, 'a third the page loaded into is on');
  // The rest of its dwell, then the exit (260 ms unless the theme says).
  await new Promise(r => setTimeout(r, 1_400));
  assert.equal(shownAt(recent.page.el('third')), false, 'and leaves when its own dwell ends');
});
