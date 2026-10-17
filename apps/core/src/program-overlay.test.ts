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
  standbyLine: (o: { state: unknown; screen: string | null; link: string; address: string }) =>
    { text: string; warn: boolean } | null;
  feedNote: (host: unknown) => string;
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

test('the standby line says why the screen is empty, and only while it is', () => {
  /*
   * A fresh desk on a field parked on its Test Match (which the desk skips):
   * no match ever loads, and the projector showed nothing at all, for good.
   */
  const address = 'http://10.0.100.20:8720';
  const fresh = deskAfter();
  const load42 = { type: 'match.loaded' as const, source: 'cheesy' as const,
    payload: match('q42', [254, 1678, 971], [604, 3256, 8]) };
  const line = (state: unknown, link: string, screen: string | null = 'blank') =>
    decide.standbyLine({ state, screen, link, address });

  assert.deepEqual(line(null, 'connecting', null),
    { text: 'Connecting to the desk at http://10.0.100.20:8720.', warn: false }, 'before any frame');
  assert.deepEqual(line(fresh, 'up'),
    { text: 'No field connection. Matches can be run from the desk console.', warn: false });
  const fieldUp = deskAfter({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } });
  assert.deepEqual(line(fieldUp, 'up'), {
    text: 'Connected to the field. Waiting for it to load a match (its Test Match does not count).',
    warn: false,
  });
  // The desk going away outranks what the last frame said about the field.
  for (const state of [null, fresh, fieldUp]) {
    const down = line(state, 'down', state ? 'blank' : null);
    assert.equal(down?.warn, true);
    assert.match(down?.text ?? '', /^Cannot reach the desk at http:\/\/10\.0\.100\.20:8720\./);
  }

  // Something to show: no card, whatever the link is doing.
  const withMatch = deskAfter(load42);
  assert.equal(line(withMatch, 'up', 'overview'), null, 'a match is up');
  assert.equal(line(withMatch, 'down', 'overview'), null, 'a dropped link heals silently under a live screen');
  const blankAfterMatch = deskAfter(load42,
    { type: 'screen.change', source: 'cue', payload: { screen: 'blank' } });
  assert.equal(blankAfterMatch.screen, 'blank');
  assert.equal(line(blankAfterMatch, 'up'), null, 'once a match has loaded, a blank is just a blank');
  // An operator's Blank is a choice: the backdrop, and no words on it.
  const taken = deskAfter({ type: 'screen.change', source: 'manual', payload: { screen: 'blank' } });
  assert.equal(taken.screenHold, true, 'the premise: a take holds');
  assert.equal(line(taken, 'up'), null);
  assert.equal(line(taken, 'down'), null);
  // Handed back to Auto, the screen is empty for the old reason again.
  const handedBack = deskAfter({ type: 'screen.change', source: 'manual', payload: { screen: 'blank' } },
    { type: 'screen.change', source: 'manual', payload: { screen: 'auto' } });
  assert.match(line(handedBack, 'up')?.text ?? '', /^No field connection/);
  // A screen taken with no match (the explainer, a sponsor) has things to say.
  assert.equal(line(deskAfter({ type: 'screen.change', source: 'manual', payload: { screen: 'explain' } }),
    'up', 'explain'), null);
  assert.equal(line(fresh, 'up', 'replay'), null, 'a replay standing the overlay aside');
});

test('the kiosk can name a field feed that shows no picture, and nothing else', () => {
  assert.equal(decide.feedNote('10.0.100.9:8080'),
    'No picture from the field feed at 10.0.100.9:8080: check that the camera is on '
    + 'and its address is right. Until then the graphics show on this backdrop.');
  for (const host of ['10.0.100.9', 'cam.local', 'field-cam-2.calgames.test:554', '[fe80::1]:8080', ' cam.local ']) {
    assert.match(decide.feedNote(host), /^No picture from the field feed at /, host);
  }
  assert.match(decide.feedNote(' cam.local '), / at cam\.local: /, 'typed loosely, printed tidily');
  // Whatever is not a host stays off the projector: words, an address with
  // its path and password, markup, or nothing at all.
  for (const host of ['', null, undefined, 42, 'Free pizza at the snack bar', 'admin:hunter2@10.0.100.9',
    'http://10.0.100.9/video.mjpg', '<b>x</b>', 'a'.repeat(254)]) {
    assert.equal(decide.feedNote(host), '', String(host));
  }
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
  /** <html>, where applyDisplayMode writes data-key. */
  html: FakeEl;
  /** The socket opens, as the browser reports it. */
  open: () => Promise<void>;
  /** The socket dies (the desk went away), and the client dials again. */
  drop: () => Promise<void>;
  /** How many sockets the page has opened so far. */
  dials: () => number;
}

const ROBOT_COLUMNS = new Set(['redRobots', 'blueRobots']);

/** Where the page is opened: its address's query, and what it is running inside. */
interface Where { search?: string; obs?: boolean; framed?: boolean }

/**
 * program.js, loaded fresh, on a stand-in browser. The globals stay in place
 * afterwards on purpose: the page's own timers (its screen sweep, a card's
 * fade) can still fire after a test ends, and this file runs in a process of
 * its own.
 *
 * By default the page is a browser on its own (no OBS, not framed), which is
 * a switcher input: luma. ?key=fill in `search` is the projector. `obs` puts
 * the object OBS injects into a Browser
 * Source on the window; `framed` gives it a parent, as /s/watch does.
 */
async function openProgram(where: Where = {}): Promise<Page> {
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
  const sockets: { onmessage: ((e: { data: string }) => void) | null; onopen: unknown; onclose: unknown }[] = [];
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: unknown = null; onclose: unknown = null; onerror: unknown = null;
    constructor() { sockets.push(this); }
    send(): void {}
    close(): void {}
  }

  g['location'] = { pathname: '/s/program', search: where.search ?? '', host: 'desk.test', protocol: 'http:' };
  if (where.obs) g['obsstudio'] = { pluginVersion: '30.2.3' }; else delete g['obsstudio'];
  if (where.framed) { g['self'] = g; g['top'] = { parent: 'the kiosk' }; } else { delete g['self']; delete g['top']; }
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
  // A truthy id, because the client starts its watchdog only if it holds
  // none: a 0 here made the first redial (see drop) start a real one, and
  // the test process never exited.
  const realInterval = g['setInterval'];
  g['setInterval'] = () => -1;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    g['setInterval'] = realInterval;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(sockets.length, 1, 'the page opened its socket');

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };
  const html = (g['document'] as { documentElement: FakeEl }).documentElement;
  return {
    el, builds, swaps, html,
    // Always the newest socket: after a drop, the client has dialled again.
    send: async msg => {
      sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) });
      await settle();
    },
    paint: () => { for (const fn of frames.splice(0)) fn(performance.now()); },
    open: async () => { (sockets.at(-1)!.onopen as () => void)(); await settle(); },
    // Waits out the client's first redial (250 ms), so the new socket is this
    // page's own: the WebSocket global is whichever page opened last.
    drop: async () => {
      (sockets.at(-1)!.onclose as () => void)();
      await settle();
      await new Promise(r => setTimeout(r, 300));
    },
    dials: () => sockets.length,
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

// ---- standing on its own: the projector, not OBS -------------------------------

test('alone in a browser the program is graphics on black, for a keyer and a projector alike', async () => {
  /*
   * The AV coordinator's afternoon: no OBS, a browser full screen on a
   * computer whose HDMI goes into the switcher, through a converter. The
   * program was transparent there, which in a plain browser is a WHITE
   * page, and a white page on a luma key is a white box over the stream.
   * The plain address is luma now: black that the key cuts out, and
   * graphics on black on a projector. Never the standby words, which on a
   * keyer would go out on the stream.
   */
  const page = await openProgram();
  assert.equal(page.html.dataset['key'], 'luma', 'no OBS, no frame: black, for the luma key');
  assert.equal(page.el('standby').hidden, true, 'no words before the desk has answered');
  await page.open();
  await page.send(snapshot(deskAfter()));
  page.paint();
  assert.equal(page.el('standby').hidden, true, 'nor on an empty screen');
  await page.drop();
  assert.equal(page.el('standby').hidden, true, 'nor with the desk gone');
  assert.equal(page.html.dataset['showing'], 'desk', 'the desk\'s graphics, with no field to stand in');
});

test('on a projector asked for fill, the program draws the backdrop and its empty screen says why', async () => {
  /*
   * The same afternoon on the projector: a field parked on its Test Match,
   * and an empty screen for good. With ?key=fill (what the front page's
   * projector choice and /s/watch ask for) it draws the backdrop and says
   * why it is empty.
   */
  const page = await openProgram({ search: '?key=fill' });
  const card = page.el('standby');
  const said = (): string => page.el('standbyLine').textContent;
  assert.equal(page.html.dataset['key'], 'fill', 'asked for the backdrop: the screen is the picture');
  assert.equal(page.html.dataset['showing'], undefined, 'and no stand-in for the field: that is for a keyer');
  assert.equal(card.hidden, false, 'words on the screen before the desk has said anything');
  assert.equal(said(), 'Connecting to the desk at http://desk.test.');

  await page.open();
  await page.send(snapshot(deskAfter()));
  assert.equal(card.hidden, false);
  assert.equal(said(), 'No field connection. Matches can be run from the desk console.');

  const fieldUp = deskAfter({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } });
  await page.send({ t: 'event', ev: { type: 'arena.status' }, state: fieldUp });
  assert.equal(said(), 'Connected to the field. Waiting for it to load a match (its Test Match does not count).');

  // The desk goes away: the line says so, in the colour that asks for action.
  await page.drop();
  assert.equal(card.hidden, false);
  assert.match(said(), /^Cannot reach the desk at http:\/\/desk\.test\. Check that the desk computer/);
  assert.equal(page.el('standbyLine').dataset['tone'], 'warn');
  // And comes back: the client redials, the snapshot lands, the line heals.
  assert.equal(page.dials(), 2, 'the client dialled again');
  await page.open();
  await page.send(snapshot(fieldUp));
  assert.match(said(), /^Connected to the field/);
  assert.equal(page.el('standbyLine').dataset['tone'], undefined);

  // An operator's Blank is a choice: the backdrop, no words.
  const taken = deskAfter({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } },
    { type: 'screen.change', source: 'manual', payload: { screen: 'blank' } });
  await page.send({ t: 'event', ev: { type: 'screen.change' }, state: taken });
  assert.equal(card.hidden, true, 'a Blank somebody pressed stays blank');
  page.paint();
  assert.equal(card.hidden, true, 'and the frame clock does not bring the card back');

  // A real match: the card goes, and a blank after it is only a blank.
  const q42 = deskAfter(loaded(match('q42', [254, 1678, 971], [604, 3256, 8])));
  await page.send({ t: 'event', ev: { type: 'match.loaded' }, state: q42 });
  assert.equal(card.hidden, true, 'a match is something to show');
  const cueBlank = deskAfter(loaded(match('q42', [254, 1678, 971], [604, 3256, 8])),
    { type: 'screen.change', source: 'cue', payload: { screen: 'blank' } });
  await page.send({ t: 'event', ev: { type: 'screen.change' }, state: cueBlank });
  page.paint();
  assert.equal(card.hidden, true);
  // A desk restart under a loaded match heals silently, as it always did.
  await page.drop();
  assert.equal(card.hidden, true, 'no alarm over a live screen');
  assert.equal(page.el('standbyNote').hidden, true, 'and no feed note on a plain projector, ever');
});

test('framed by the kiosk over a feed that shows no picture, the card names the feed', async () => {
  /*
   * /s/watch frames the program on its own backdrop when the field feed it
   * was given shows no picture, and passes the feed's host. The card then
   * says which box to go and look at, under the usual status line, for as
   * long as the card is up and no longer.
   */
  const kiosk = await openProgram({ framed: true, search: '?key=fill&kiosk=1&feeddown=10.0.100.9%3A8080' });
  const note = kiosk.el('standbyNote');
  assert.equal(kiosk.el('standby').hidden, false);
  assert.equal(note.hidden, false, 'before the desk has said anything');
  assert.match(note.textContent, /^No picture from the field feed at 10\.0\.100\.9:8080: check that the camera/);
  await kiosk.open();
  await kiosk.send(snapshot(deskAfter()));
  assert.equal(kiosk.el('standbyLine').textContent, 'No field connection. Matches can be run from the desk console.',
    'the status still leads');
  assert.equal(note.hidden, false);
  await kiosk.send({ t: 'event', ev: { type: 'match.loaded' },
    state: deskAfter(loaded(match('q42', [254, 1678, 971], [604, 3256, 8]))) });
  assert.equal(kiosk.el('standby').hidden, true, 'a match on screen: the graphics, on the backdrop, no words');

  // Only the kiosk's own address is read, and only a host is printed.
  const typed = await openProgram({ search: '?key=fill&feeddown=10.0.100.9' });
  assert.equal(typed.el('standby').hidden, false, 'the premise: a projector card is up');
  assert.equal(typed.el('standbyNote').hidden, true, 'not the kiosk: no feed note');
  const junk = await openProgram({ framed: true, search: '?key=fill&kiosk=1&feeddown=Free%20pizza%20at%20the%20snack%20bar' });
  assert.equal(junk.el('standbyNote').hidden, true, 'not a host: nothing printed');
  assert.equal(junk.el('standbyNote').textContent, '');
  const plain = await openProgram({ framed: true, search: '?key=fill&kiosk=1' });
  assert.equal(plain.el('standbyNote').hidden, true, 'a kiosk with no feed: no note');
  // Over a camera, or in OBS, the card is never drawn at all.
  for (const where of [{ framed: true, search: '?key=alpha&kiosk=1&feeddown=10.0.100.9' },
    { obs: true, search: '?kiosk=1&feeddown=10.0.100.9' }] as Where[]) {
    const layer = await openProgram(where);
    assert.equal(layer.el('standby').hidden, true, JSON.stringify(where));
  }
});

test('in OBS, framed, or keyed, the program is the transparent layer it always was', async () => {
  /*
   * Every existing setup keeps its picture: an OBS Browser Source pointed at
   * /s/program, the kiosk framing it over a field feed, and an address that
   * names its key. None of them may ever show the standby words, because
   * over a camera they would go out on the stream.
   */
  const empty = deskAfter();
  const cases: [string, Where, string][] = [
    ['a plain browser on its own, which is a switcher input', {}, 'luma'],
    ['an OBS Browser Source', { obs: true }, 'alpha'],
    ['OBS, with the address naming alpha', { obs: true, search: '?key=alpha' }, 'alpha'],
    ['framed by /s/watch over a feed', { framed: true, search: '?key=alpha&kiosk=1' }, 'alpha'],
    ['framed by some other page', { framed: true }, 'alpha'],
    ['a plain browser told alpha', { search: '?key=alpha' }, 'alpha'],
    ['a hardware luma keyer', { search: '?key=luma' }, 'luma'],
    ['OBS told luma', { obs: true, search: '?key=luma' }, 'luma'],
  ];
  for (const [what, where, key] of cases) {
    const page = await openProgram(where);
    assert.equal(page.html.dataset['key'], key, what);
    await page.open();
    await page.send(snapshot(empty));
    page.paint();
    assert.equal(page.el('standby').hidden, true, `${what}: no words on the picture`);
    await page.drop();
    assert.equal(page.el('standby').hidden, true, `${what}: not even when the desk goes away`);
  }

  // The kiosk with no feed asks for fill, and then the card is its to show.
  const kiosk = await openProgram({ framed: true, search: '?key=fill&kiosk=1' });
  assert.equal(kiosk.html.dataset['key'], 'fill', 'an address that names fill wins over the frame');
  await kiosk.open();
  await kiosk.send(snapshot(empty));
  assert.equal(kiosk.el('standby').hidden, false);
  // The second stream (?mode=clean) is a score bar over a camera: never,
  // not even asked for the backdrop.
  const clean = await openProgram({ search: '?mode=clean&key=fill' });
  assert.equal(clean.html.dataset['key'], 'fill');
  assert.equal(clean.el('standby').hidden, true, 'not even before the desk has answered');
  await clean.open();
  await clean.send(snapshot(empty));
  assert.equal(clean.el('standby').hidden, true, 'clean mode never carries the card');
});

test('a projector keeps the Final score through a replay that is only on the stream', async () => {
  /*
   * The replay cue says OBS put a clip on the STREAM, under the overlay. The
   * OBS copy stands aside for it, as it always has; a projector running the
   * program on its own has nothing under it, and standing aside there swapped
   * the Final score for a chip on an empty backdrop.
   */
  const state = deskAfter(loaded(match('q42', [254, 1678, 971], [604, 3256, 8])),
    { type: 'screen.change', source: 'manual', payload: { screen: 'score' } },
    { type: 'replay.on_air', source: 'cue', payload: { label: 'Q42 replay', seconds: 20, scene: 'Replay' } });
  assert.ok(state.replayOnAir, 'the premise: a replay is on the stream');
  const on = (p: Page, id: string): boolean =>
    (p.el(id) as unknown as { hasAttribute: (n: string) => boolean }).hasAttribute('data-active');

  const obs = await openProgram({ obs: true });
  await obs.open();
  await obs.send({ t: 'hb', now: Date.now() });
  await obs.send(snapshot(state));
  assert.equal(on(obs, 'scr-replay'), true, 'OBS stands aside for the clip, exactly as before');
  assert.equal(on(obs, 'scr-score'), false);

  const projector = await openProgram({ search: '?key=fill' });
  await projector.open();
  await projector.send({ t: 'hb', now: Date.now() });
  await projector.send(snapshot(state));
  projector.paint();
  assert.equal(projector.html.dataset['key'], 'fill');
  assert.equal(on(projector, 'scr-score'), true, 'the Final score stays up on the projector');
  assert.equal(on(projector, 'scr-replay'), false);

  // A switcher input keys the graphics over whatever the switcher has, the
  // clip included, so it stands aside as the OBS copy does.
  const keyed = await openProgram();
  await keyed.open();
  await keyed.send({ t: 'hb', now: Date.now() });
  await keyed.send(snapshot(state));
  assert.equal(keyed.html.dataset['key'], 'luma');
  assert.equal(on(keyed, 'scr-replay'), true, 'a keyer stands aside for the clip under it');
});
