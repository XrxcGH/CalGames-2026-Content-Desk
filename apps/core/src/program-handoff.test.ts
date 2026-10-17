/**
 * The program standing in for the field, driven for real, with no field.
 *
 * On a video switcher the program page is the keyed graphics input, and it
 * replaces the keyer Cheesy Arena's own score display used to have: with
 * both keyed, the stream carried two score bars. So while the desk is
 * working the stream shows the desk's graphics and never the field's, and
 * while it is not, the same input shows Cheesy's own audience display, which
 * the page keeps loaded underneath, unseen.
 *
 * Nothing here needs a real Cheesy or a real desk: the page's socket, its
 * clock, and what answers at the field's address are all the test's. The
 * decision itself (handoffStep in decide.js) is run directly first; then
 * program.js runs on a stand-in browser, the same arrangement as
 * program-overlay.test.ts, with the real shared client underneath.
 *
 * What must never happen, and is checked throughout: the page reloading or
 * navigating (with the desk gone that is the browser's error page, which is
 * light, on the stream), the field's frame shown before a load of it is
 * known good (it may be that error page), or the frame made at all on a
 * page that is not a luma keyer, or that the desk has named no field for.
 * And the desk is told whether the stand-in is there at all, since nothing
 * on a keyed page may say so.
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

interface Hand { showing: string; deskBadSince: number | null; fieldBadSince: number | null; goodSince: number | null }
interface Now {
  now: number; open: boolean; heardAt: number | null; synced: boolean;
  fieldConfigured: boolean; fieldUp: boolean; backupReady: boolean;
}
interface Decide {
  fieldDisplayUrl: (host: unknown) => string | null;
  handoffStep: (was: Hand, now: Now) => Hand;
  HANDOFF_START: Hand;
  HANDOFF_MS: { silent: number; desk: number; field: number; back: number };
  FIELD_DISPLAY_ID: string;
}
// @ts-expect-error untyped browser module, cast on the same line
const decide = (await import('../../../surfaces/program/decide.js')) as Decide;

const FIELD = '10.0.100.5:8080';
const BACKUP_URL = 'http://10.0.100.5:8080/displays/audience?displayId=contentdesk-backup&background=%23000000';
const OTHER_FIELD = '10.0.100.6:8080';
const OTHER_URL = 'http://10.0.100.6:8080/displays/audience?displayId=contentdesk-backup&background=%23000000';

// ---- the decision, on its own ----------------------------------------------------

test('the field display address is built only from a host and port', () => {
  assert.equal(decide.fieldDisplayUrl(FIELD), BACKUP_URL);
  assert.equal(decide.FIELD_DISPLAY_ID, 'contentdesk-backup');
  assert.equal(decide.fieldDisplayUrl(' 10.0.100.5:8080 '), BACKUP_URL, 'typed loosely, still read');
  assert.equal(decide.fieldDisplayUrl('cheesy.local'),
    'http://cheesy.local/displays/audience?displayId=contentdesk-backup&background=%23000000');
  assert.match(decide.fieldDisplayUrl('[fe80::1]:8080') ?? '', /^http:\/\/\[fe80::1\]:8080\/displays\/audience\?/);
  // Anything else, and the page frames nothing: it must not be talked into
  // framing some other site by a malformed answer.
  for (const host of [null, undefined, '', 42, 'http://10.0.100.5:8080', '10.0.100.5:8080/x',
    'evil.example/displays', 'a b', '10.0.100.5:8080?x=1', 'user:pw@10.0.100.5', '<b>x</b>', 'a'.repeat(254)]) {
    assert.equal(decide.fieldDisplayUrl(host), null, String(host));
  }
});

/** Walk the decision through moments, carrying it along as the page does. */
function walk(steps: [number, Partial<Now>][], base: Partial<Now> = {}): string[] {
  let hand = decide.HANDOFF_START;
  const seen: string[] = [];
  for (const [now, over] of steps) {
    hand = decide.handoffStep(hand, {
      now, open: true, heardAt: now, synced: true, fieldConfigured: true, fieldUp: true, backupReady: true,
      ...base, ...over,
    });
    seen.push(hand.showing);
  }
  return seen;
}

test('the handoff waits out a blip, and comes back only once the desk has been well for a while', () => {
  const { desk, field, back, silent } = decide.HANDOFF_MS;
  assert.deepEqual({ desk, field, back, silent }, { desk: 3000, field: 10_000, back: 5000, silent: 25_000 });

  // The socket closes at 1000: three seconds of patience, then the field.
  const closed = { open: false, heardAt: 1000 };
  assert.deepEqual(walk([[0, {}], [1000, closed], [3999, closed], [4000, closed], [4001, closed]]),
    ['desk', 'desk', 'desk', 'desk', 'cheesy'], 'more than 3 s, not 3 s');

  // Open again, but the snapshot is still owed: not yet. Then caught up for 5 s.
  const outage: [number, Partial<Now>][] = [[0, {}], [1000, closed], [4001, closed]];
  assert.deepEqual(walk([...outage, [5000, { synced: false }], [6000, {}], [10_999, {}], [11_000, {}]]),
    ['desk', 'desk', 'cheesy', 'cheesy', 'cheesy', 'cheesy', 'desk']);
  // A desk that answers once and drops again starts its five seconds over.
  assert.deepEqual(walk([...outage, [6000, {}], [9000, closed], [10_000, {}], [14_999, {}], [15_000, {}]]),
    ['desk', 'desk', 'cheesy', 'cheesy', 'cheesy', 'cheesy', 'cheesy', 'desk']);

  // A socket that looks open but has said nothing for 25 s is a dead one.
  const quiet = (now: number): [number, Partial<Now>] => [now, { heardAt: 0 }];
  assert.deepEqual(walk([[0, {}], quiet(25_000), quiet(25_001), quiet(28_001), quiet(28_002)]),
    ['desk', 'desk', 'desk', 'desk', 'cheesy'], '25 s of silence, then 3 s more');

  // The desk up but its field link down: ten seconds, because the bridge
  // reconnects by itself, then the field, which has the real numbers.
  const off = { fieldUp: false };
  assert.deepEqual(walk([[0, {}], [1000, off], [11_000, off], [11_001, off], [12_000, {}], [16_999, {}], [17_000, {}]]),
    ['desk', 'desk', 'desk', 'cheesy', 'cheesy', 'cheesy', 'desk']);
  // No field to be on: nothing to hand off for, however long it lasts.
  assert.deepEqual(walk([[0, off], [60_000, off]], { fieldConfigured: false }), ['desk', 'desk']);
  // A field link that is down before the snapshot is not evidence of anything.
  assert.deepEqual(walk([[0, { synced: false, fieldUp: false }], [60_000, { synced: false, fieldUp: false }]]),
    ['desk', 'desk']);
});

test('the field is never shown without a frame known good, and losing it goes back at once', () => {
  const closed = { open: false, heardAt: 0 };
  // The desk long gone, but nothing good to show: the desk's last picture.
  assert.deepEqual(walk([[0, closed], [60_000, closed]], { backupReady: false }), ['desk', 'desk']);
  // The frame turns good mid-outage: shown at once, since the wait is over.
  assert.deepEqual(walk([[0, { ...closed, backupReady: false }], [60_000, { ...closed, backupReady: false }],
    [60_001, closed]]), ['desk', 'desk', 'cheesy']);
  // It turns bad while shown (Cheesy reloading itself, or gone): straight back.
  assert.deepEqual(walk([[0, closed], [4000, closed], [4001, { ...closed, backupReady: false }]]),
    ['desk', 'cheesy', 'desk']);
});

// ---- program.js on a stand-in browser ---------------------------------------------

interface FakeEl {
  id: string; tag: string;
  dataset: Record<string, string>;
  hidden: boolean; textContent: string; innerHTML: string; children: FakeEl[];
  attrs: Map<string, string>;
  /** Every address the page gave this element, in order: each one is a load. */
  srcs: string[];
  src: string;
  removed: boolean;
  fire: (type: string) => void;
  [rest: string]: unknown;
}

interface Where { search?: string; obs?: boolean; framed?: boolean }
interface Net {
  /** What /api/info answers, or 'fail' for a desk that does not answer it. */
  info: unknown;
  /** Something answers at the field's address, from this browser. */
  cheesy: boolean;
  /** The desk answers HTTP (the sign-in check's HEAD). */
  desk: boolean;
  /** Questions to the field wait on the wire until the test answers them (see held). */
  hold?: boolean;
}

const team = (number: number) => ({ number, name: `Team ${number}` });
const deskAfter = (...events: EmitInit[]): DeskState => {
  const bus = new EventBus();
  for (const ev of events) bus.emit(ev);
  return bus.state;
};
const fieldUp = (): DeskState => deskAfter({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } },
  { type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [254, 1678, 971].map(team), blue: [604, 3256, 8].map(team) } });
const fieldDown = (): DeskState => deskAfter({ type: 'arena.status', source: 'cheesy', payload: { cheesy: false } });
const snapshot = (state: DeskState) => ({ t: 'snapshot', state, media: {}, needsPin: false });

// The clock the page times its handoff on, which only the test moves: the
// real time a step takes must not leak into a three second window.
let ahead = 0;
(globalThis as unknown as Record<string, unknown>)['performance'] = { now: () => 1_000_000 + ahead };

/** Let every answer already given (a fetch, a probe) land. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));
};

async function openProgram(where: Where = {}, net: Net = { info: { mode: 'normal', field: { host: FIELD } }, cheesy: true, desk: true }) {
  const g = globalThis as unknown as Record<string, unknown>;
  const els = new Map<string, FakeEl>();
  const created: FakeEl[] = [];
  const appended: FakeEl[] = [];
  const navigations: string[] = [];
  const probes: string[] = [];
  const held: ((ok: boolean) => void)[] = [];
  const infos: number[] = [];

  const make = (id: string, tag = 'div'): FakeEl => {
    const attrs = new Map<string, string>();
    const listeners = new Map<string, (() => void)[]>();
    const srcs: string[] = [];
    let html = '';
    const node: FakeEl = {
      id, tag, dataset: {}, hidden: false, textContent: '', children: [], attrs, srcs, removed: false,
      style: { setProperty() {} }, className: '', offsetWidth: 0, scrollWidth: 0, clientWidth: 0, tabIndex: 0, title: '',
      classList: { add() {}, remove() {}, toggle() {} },
      toggleAttribute(n: string, on?: boolean) { if (on ?? !attrs.has(n)) attrs.set(n, ''); else attrs.delete(n); },
      setAttribute(n: string, v: string) { attrs.set(n, String(v)); },
      getAttribute(n: string) { return attrs.get(n) ?? null; },
      removeAttribute(n: string) { attrs.delete(n); },
      hasAttribute(n: string) { return attrs.has(n); },
      addEventListener(type: string, fn: () => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
      removeEventListener() {}, replaceChildren() {}, append() {},
      remove() { node.removed = true; },
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      querySelector: () => null,
      fire(type: string) { for (const fn of listeners.get(type) ?? []) fn(); },
      get firstElementChild() { return node; },
      get lastElementChild() { return node; },
      get innerHTML() { return html; },
      set innerHTML(v: string) { html = v; },
      get src() { return srcs.at(-1) ?? ''; },
      set src(v: string) { srcs.push(v); },
    };
    return node;
  };
  const el = (id: string): FakeEl => {
    let node = els.get(id);
    if (!node) { node = make(id); els.set(id, node); }
    return node;
  };

  const frames: ((now: number) => void)[] = [];
  const sockets: { onmessage: ((e: { data: string }) => void) | null; onopen: unknown; onclose: unknown;
    sent: string[]; readyState: number }[] = [];
  class FakeWS {
    static OPEN = 1;
    // Connecting until the test opens it, as a real socket is.
    readyState = 0;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: unknown = null; onclose: unknown = null; onerror: unknown = null;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(data: string): void { this.sent.push(data); }
    close(): void {}
  }

  const here = `/s/program${where.search ?? ''}`;
  // Every way a page can leave itself, each one written down.
  g['location'] = {
    pathname: '/s/program', search: where.search ?? '', host: 'desk.test', protocol: 'http:',
    origin: 'http://desk.test',
    get href() { return `http://desk.test${here}`; },
    set href(v: string) { navigations.push(`href=${v}`); },
    assign: (v: string) => { navigations.push(`assign ${v}`); },
    replace: (v: string) => { navigations.push(`replace ${v}`); },
    reload: () => { navigations.push('reload'); },
  };
  if (where.obs) g['obsstudio'] = { pluginVersion: '30.2.3' }; else delete g['obsstudio'];
  if (where.framed) { g['self'] = g; g['top'] = { parent: 'the kiosk' }; } else { delete g['self']; delete g['top']; }
  g['WebSocket'] = FakeWS;
  g['fetch'] = async (to: unknown, init?: { method?: string; mode?: string }) => {
    const url = String(to);
    // Anything that is not the desk's own is a question asked of some other
    // machine, and written down whatever it is.
    if (!url.startsWith('/')) {
      probes.push(`${init?.mode ?? 'cors'} ${url}`);
      // A question still on the wire, answered when the test says.
      if (net.hold) {
        return new Promise((resolve, reject) => held.push(ok => (ok
          ? resolve({ ok: false, status: 0, type: 'opaque' }) : reject(new TypeError('Failed to fetch')))));
      }
      if (!net.cheesy || !url.startsWith('http://10.0.100.5:8080/')) throw new TypeError('Failed to fetch');
      return { ok: false, status: 0, type: 'opaque' };
    }
    if (init?.method === 'HEAD') {
      if (!net.desk) throw new TypeError('Failed to fetch');
      return { redirected: false, url: `http://desk.test${url}` };
    }
    if (url === '/api/info') {
      infos.push(ahead);
      if (!net.desk || net.info === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => net.info };
    }
    return { ok: false };
  };
  const body = make('body', 'body');
  body.append = (child: FakeEl) => { appended.push(child); };
  g['document'] = {
    hidden: false, documentElement: make('html', 'html'), body,
    getElementById: el,
    createElement: (tag: string) => { const n = make('', tag); created.push(n); return n; },
    addEventListener() {}, removeEventListener() {},
  };
  g['requestAnimationFrame'] = (fn: (now: number) => void) => { frames.push(fn); return frames.length; };
  g['cancelAnimationFrame'] = () => {};
  g['addEventListener'] = () => {};
  g['innerWidth'] = 1920;
  g['innerHeight'] = 1080;
  g['screen'] = { width: 1920, height: 1080 };
  g['devicePixelRatio'] = 1;
  g['getComputedStyle'] = () => ({ getPropertyValue: () => '' });
  g['matchMedia'] = (q: string) => ({ matches: q.includes('reduced-motion') });

  const source = await readFile(join(SURFACES, 'program', 'program.js'), 'utf8');
  const local = source.replace(/from '\/(shared|s\/program)\/([\w.-]+)'/g, (_m, dir: string, file: string) =>
    `from '${pathToFileURL(join(SURFACES, dir === 'shared' ? '_shared' : 'program', file)).href}'`);
  assert.doesNotMatch(local, /from '\//, 'every server path in program.js was pointed at a file');
  const dir = await mkdtemp(join(tmpdir(), 'cg-handoff-'));
  const file = join(dir, 'program.mjs');
  await writeFile(file, local);
  // The client's watchdog and the tickers' backstops would keep this process
  // alive, and the page is stepped by its frames here instead. A truthy id,
  // so the client never starts a real watchdog on a redial.
  const realInterval = g['setInterval'];
  g['setInterval'] = () => -1;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    g['setInterval'] = realInterval;
    await rm(dir, { recursive: true, force: true });
  }
  await settle();
  const html = (g['document'] as { documentElement: FakeEl }).documentElement;
  const paint = (): void => { for (const fn of frames.splice(0)) fn(performance.now()); };

  const page = {
    html, net, created, appended, navigations, probes, infos, held,
    showing: (): string | undefined => html.dataset['showing'],
    /** What the page says about its stand-in for the field. */
    ready: (): string | undefined => html.dataset['backup'],
    /** The field's frame in the page now, if the page has made one. */
    backup: (): FakeEl | undefined => created.filter(n => n.tag === 'iframe' && !n.removed).at(-1),
    /** Every frame the page has made, removed ones included. */
    iframes: (): FakeEl[] => created.filter(n => n.tag === 'iframe'),
    stage: (id: string) => el(id),
    paint,
    send: async (msg: unknown): Promise<void> => {
      sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) });
      await settle();
      paint();
      await settle();
    },
    /** A frame from the desk, and its answers landing, with no paint after it. */
    deliver: async (msg: unknown): Promise<void> => {
      sockets.at(-1)!.onmessage!({ data: JSON.stringify(msg) });
      await settle();
    },
    open: async (): Promise<void> => {
      const s = sockets.at(-1)!;
      s.readyState = 1;
      (s.onopen as () => void)();
      await settle(); paint(); await settle();
    },
    /** The desk goes away: the socket closes and the client dials again. */
    drop: async (): Promise<void> => {
      const s = sockets.at(-1)!;
      s.readyState = 3;
      (s.onclose as () => void)();
      await settle();
      await new Promise(r => setTimeout(r, 300));
      paint();
      await settle();
    },
    /** Time passes in steps, the page painting (and probing) as a browser would. */
    pass: async (ms: number, { step = 500, beat = false }: { step?: number; beat?: boolean } = {}): Promise<void> => {
      let gone = 0;
      let sinceBeat = 0;
      while (gone < ms) {
        const d = Math.min(step, ms - gone);
        ahead += d;
        gone += d;
        sinceBeat += d;
        if (beat && sinceBeat >= 10_000) {
          sinceBeat = 0;
          sockets.at(-1)!.onmessage!({ data: JSON.stringify({ t: 'hb', now: Date.now() }) });
        }
        paint();
        await settle();
        paint();
      }
    },
    /** Every hello frame this page has sent, newest last, across its sockets. */
    hellos: (): Record<string, unknown>[] => sockets.flatMap(s => s.sent)
      .map(d => JSON.parse(d) as Record<string, unknown>).filter(m => m['t'] === 'hello'),
    dials: () => sockets.length,
  };
  return page;
}

type Page = Awaited<ReturnType<typeof openProgram>>;

/** A page caught up with a desk that is on the field, and its frame loaded. */
async function healthy(page: Page): Promise<void> {
  await page.open();
  await page.send(snapshot(fieldUp()));
  page.backup()?.fire('load');
  await page.pass(1000);
}

test('a keyer shows the desk while it works, the field while it does not, and back', async () => {
  const page = await openProgram();
  assert.equal(page.html.dataset['key'], 'luma', 'the plain address, alone in a browser');
  assert.equal(page.showing(), 'desk');

  // The desk named its field; this browser asked there and something
  // answered; the frame is made, unseen, at the field's own display.
  await page.pass(500);
  const frame = page.backup();
  assert.ok(frame, 'the frame is made once the field answers');
  assert.deepEqual(frame.srcs, [BACKUP_URL]);
  assert.equal(frame.attrs.get('allow'), "autoplay 'none'", 'never the field\'s buzzers out of this computer');
  assert.equal(frame.attrs.get('sandbox'), 'allow-scripts allow-same-origin', 'and never the right to send this page anywhere');
  assert.equal(frame.id, 'fieldBackup');
  assert.deepEqual(page.appended, [frame], 'into the page, once');
  assert.match(page.probes[0] ?? '', /^no-cors http:\/\/10\.0\.100\.5:8080\/displays\/audience\?displayId=contentdesk-backup/);
  assert.equal(page.showing(), 'desk');

  // All well, for a long while, with the desk's heartbeat: the desk's graphics.
  await healthy(page);
  await page.pass(120_000, { step: 1000, beat: true });
  assert.equal(page.showing(), 'desk', 'the field\'s overlay is never on the stream while the desk works');

  // The desk goes away (stopped, crashed, restarting).
  await page.drop();
  await page.pass(2500);
  assert.equal(page.showing(), 'desk', 'a blip is waited out');
  await page.pass(1000);
  assert.equal(page.showing(), 'cheesy', 'more than 3 s: the field\'s own score, on the same input');
  // And it stays there, live, for as long as the outage lasts.
  await page.pass(5 * 60_000, { step: 2000 });
  assert.equal(page.showing(), 'cheesy');
  assert.deepEqual(frame.srcs, [BACKUP_URL], 'the field\'s display is never reloaded while it is good');
  assert.ok(page.dials() > 1, 'the client kept dialling the desk');

  // The desk is back: open, but not caught up, is not enough.
  await page.open();
  await page.pass(6000, { step: 1000 });
  assert.equal(page.showing(), 'cheesy', 'no snapshot yet');
  await page.send(snapshot(fieldUp()));
  await page.pass(4500, { step: 500 });
  assert.equal(page.showing(), 'cheesy', 'caught up, but not for long enough');
  await page.pass(1000);
  assert.equal(page.showing(), 'desk', 'five seconds well: the desk\'s graphics again');

  assert.deepEqual(page.navigations, [], 'the page never reloaded or went anywhere');
  assert.equal(page.created.filter(n => n.tag === 'iframe').length, 1, 'one frame, all along');
});

test('the desk tells the switcher table which picture is on the input', async () => {
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  const first = page.hellos()[0];
  assert.ok(first, 'a hello as soon as the socket opened');
  assert.equal(first['surface'], 'program');
  assert.equal(first['key'], 'luma');
  assert.equal(first['showing'], 'desk');
  assert.equal(first['embedded'], false);

  await page.drop();
  await page.pass(4000);
  assert.equal(page.showing(), 'cheesy');
  // Reported when the desk can hear it again: at the open, before anything else.
  await page.open();
  const atOpen = page.hellos().at(-1)!;
  assert.equal(atOpen['showing'], 'cheesy', 'the reconnect says the field is on the input');
  await page.send(snapshot(fieldUp()));
  await page.pass(6000);
  assert.equal(page.showing(), 'desk');
  // The change itself is reported once things settle (about a second).
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(page.hellos().at(-1)!['showing'], 'desk');
});

test('a socket that looks open but says nothing hands off too, and the heartbeat keeps it from doing so', async () => {
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  // Beats every 10 s for ten minutes: never.
  await page.pass(10 * 60_000, { step: 1000, beat: true });
  assert.equal(page.showing(), 'desk');

  // The path dies without a close (a switch port, an AP roam): silence.
  await page.pass(27_000, { step: 500 });
  assert.equal(page.showing(), 'desk', '25 s of silence and 2 s more: still waiting');
  await page.pass(2000);
  assert.equal(page.showing(), 'cheesy', 'the desk is gone, whatever the socket says');
  // A frame arrives again: five seconds of it, then the desk.
  await page.send({ t: 'hb', now: Date.now() });
  await page.pass(4000, { step: 500 });
  assert.equal(page.showing(), 'cheesy');
  await page.pass(1500, { step: 500 });
  assert.equal(page.showing(), 'desk');
  assert.deepEqual(page.navigations, []);
});

test('the desk up with its field link down hands off after ten seconds: the field has the real score', async () => {
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  await page.send({ t: 'event', ev: { type: 'arena.status' }, state: fieldDown() });
  await page.pass(9000, { beat: true });
  assert.equal(page.showing(), 'desk', 'the bridge gets its ten seconds to reconnect');
  await page.pass(1500, { beat: true });
  assert.equal(page.showing(), 'cheesy');
  await page.send({ t: 'event', ev: { type: 'arena.status' }, state: fieldUp() });
  await page.pass(4500, { beat: true });
  assert.equal(page.showing(), 'cheesy');
  await page.pass(1000, { beat: true });
  assert.equal(page.showing(), 'desk', 'the field back for five seconds: the desk again');
});

test('a field this display cannot reach is never framed, and a frame that may be an error page is never shown', async () => {
  const page = await openProgram(undefined, { info: { mode: 'normal', field: { host: FIELD } }, cheesy: false, desk: true });
  await page.pass(30_000, { step: 1000 });
  assert.ok(page.probes.length >= 2, 'it keeps asking');
  assert.equal(page.backup(), undefined, 'nothing answers at the field: no frame, so no error page to show');

  await healthy(page);
  await page.drop();
  await page.pass(60_000, { step: 1000 });
  assert.equal(page.showing(), 'desk', 'the desk gone, the field unreachable: the desk\'s last picture');
  assert.equal(page.backup(), undefined);

  // The field answers: the frame is made, but not shown until it has loaded.
  page.net.cheesy = true;
  await page.pass(6000, { step: 1000 });
  const frame = page.backup();
  assert.ok(frame, 'made once the field answers');
  assert.equal(page.showing(), 'desk', 'loading is not shown: it might be anything');
  frame.fire('load');
  await page.pass(500);
  assert.equal(page.showing(), 'cheesy', 'the desk still gone, the field good: the field');

  // Cheesy's display reloads itself (its own socket dropped) and Cheesy is
  // gone: that load is the browser's error page, light, on a luma key.
  page.net.cheesy = false;
  frame.fire('load');
  assert.equal(page.showing(), 'desk', 'a load the page did not ask for comes off the stream at once');
  await page.pass(60_000, { step: 1000 });
  assert.equal(page.showing(), 'desk', 'and stays off while the field does not answer');
  assert.equal(frame.srcs.length, 1, 'no load asked for while nothing answers');

  // Back: loaded again (what it holds may be the error page), then shown.
  // In a NEW frame: a browser can refuse a new address on a frame that
  // holds an error page and still fire 'load' for the refusal.
  page.net.cheesy = true;
  await page.pass(6000, { step: 1000 });
  const again = page.backup();
  assert.ok(again && again !== frame, 'loaded again in a new frame, not just shown');
  assert.equal(frame.removed, true, 'the old one, and whatever it held, is gone');
  assert.deepEqual(frame.srcs, [BACKUP_URL], 'never a second address on the old one');
  assert.deepEqual(again.srcs, [BACKUP_URL]);
  assert.equal(page.iframes().length, 2);
  assert.equal(page.showing(), 'desk');
  // The old frame finishing something now is nothing: it is on no input.
  frame.fire('load');
  await page.pass(500);
  assert.equal(page.showing(), 'desk', 'only the frame in the page counts');
  again.fire('load');
  await page.pass(500);
  assert.equal(page.showing(), 'cheesy');
  assert.deepEqual(page.navigations, [], 'and through all of it, the page itself never moved');
});

test('a load that finishes after a probe failed is not trusted, even once the field answers again', async () => {
  // The race: the field answered, the page made its frame, and the field
  // went away before the frame finished. That load is the error page.
  const page = await openProgram(undefined, { info: { mode: 'normal', field: { host: FIELD } }, cheesy: true, desk: true, hold: true });
  await page.pass(500);
  assert.equal(page.held.length, 1);
  page.held.shift()!(true);
  await page.pass(100);
  const first = page.backup();
  assert.ok(first, 'the field answered: a frame, loading');
  await page.open();
  await page.send(snapshot(fieldUp()));
  await page.drop();
  // The next probe, while the frame is still loading, finds nothing.
  for (let i = 0; i < 20 && !page.held.length; i++) await page.pass(500);
  assert.equal(page.held.length, 1, 'a probe on the wire');
  page.held.shift()!(false);
  await page.pass(100);
  assert.equal(page.showing(), 'desk', 'the desk gone, but nothing good to show');
  // Only now does the frame finish: on the error page, whatever it says.
  first.fire('load');
  await page.pass(100);
  assert.equal(page.showing(), 'desk', 'a load after a failed probe is not shown');
  // The field answers the next probe: a new frame, never the old one shown.
  for (let i = 0; i < 20 && !page.held.length; i++) await page.pass(500);
  page.held.shift()!(true);
  await page.pass(100);
  assert.equal(page.showing(), 'desk', 'still not the frame that may hold the error page');
  const second = page.backup();
  assert.ok(second && second !== first, 'made again');
  assert.equal(first.removed, true);
  // The new one loads, a probe after it vouches, and only then is it shown.
  second.fire('load');
  await page.pass(100);
  assert.equal(page.showing(), 'desk', 'a load is checked before it is shown');
  assert.equal(page.held.length, 1, 'by a probe asked after it finished');
  page.held.shift()!(true);
  await page.pass(100);
  assert.equal(page.showing(), 'cheesy');
  assert.deepEqual(page.navigations, []);
});

test('a frame whose load never finishes is given up on and made again, and never shown meanwhile', async () => {
  // A half-open path to the field: it answered the probe, then the frame
  // hangs. Without giving up, the page would wait for that load forever.
  const page = await openProgram();
  await page.pass(500);
  const first = page.backup();
  assert.ok(first);
  await page.open();
  await page.send(snapshot(fieldUp()));
  await page.drop();
  const seen = new Set<string | undefined>();
  for (let t = 0; t < 18_000; t += 1000) { await page.pass(1000); seen.add(page.showing()); }
  assert.equal(page.iframes().length, 1, 'given its time first');
  for (let t = 0; t < 12_000; t += 1000) { await page.pass(1000); seen.add(page.showing()); }
  assert.deepEqual([...seen], ['desk'], 'the desk gone the whole time, and nothing good to show');
  assert.equal(page.iframes().length, 2, 'a load with no end is given up on, and the frame made again');
  assert.equal(first.removed, true);
  const second = page.backup()!;
  assert.deepEqual(second.srcs, [BACKUP_URL]);
  second.fire('load');
  await page.pass(500);
  assert.equal(page.showing(), 'cheesy', 'this one finished, and a probe after it vouched');
});

test('a probe for the field the desk named before says nothing about the one it names now', async () => {
  const page = await openProgram(undefined, { info: { mode: 'normal', field: { host: FIELD } }, cheesy: true, desk: true, hold: true });
  await page.pass(500);
  assert.equal(page.held.length, 1);
  assert.match(page.probes[0] ?? '', /10\.0\.100\.5:8080/);
  // While that question is on the wire, the desk moves to another field.
  page.net.info = { mode: 'normal', field: { host: OTHER_FIELD } };
  await page.open();
  await page.send(snapshot(fieldUp()));
  // The old field answers. That is not the new one answering.
  page.held.shift()!(true);
  await page.pass(100);
  assert.equal(page.backup(), undefined, "no frame on the old field's word");
  assert.equal(page.probes.at(-1), `no-cors ${OTHER_URL}`, 'the next question is for the field named now');
  assert.equal(page.held.length, 1);
  page.held.shift()!(false);
  await page.pass(100);
  assert.equal(page.backup(), undefined, 'the new field does not answer: still nothing');
  for (let i = 0; i < 20 && !page.held.length; i++) await page.pass(500);
  page.held.shift()!(true);
  await page.pass(100);
  assert.deepEqual(page.backup()?.srcs, [OTHER_URL], "it answers: the frame is the new field's");
});

test('the desk is told whether the stand-in is there, so a computer that cannot reach the field is found before it matters', async () => {
  // Cannot reach the field from here (a switcher computer on the venue
  // network only): said once it has lasted, not on the first miss.
  const page = await openProgram(undefined, { info: { mode: 'normal', field: { host: FIELD } }, cheesy: false, desk: true });
  await page.open();
  await page.send(snapshot(fieldUp()));
  assert.equal(page.ready(), 'none', 'nothing to say yet');
  await page.pass(10_000, { step: 1000, beat: true });
  assert.equal(page.ready(), 'none', 'one or two misses are not news');
  await page.pass(6000, { step: 1000, beat: true });
  assert.equal(page.ready(), 'bad', 'fifteen seconds of it is');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(page.hellos().at(-1)!['backup'], 'bad', 'and the desk hears it, while the desk is still working');
  assert.equal(page.showing(), 'desk');

  // Moved to the field network: ready once its display has loaded and been checked.
  page.net.cheesy = true;
  await page.pass(6000, { step: 1000, beat: true });
  assert.ok(page.backup(), 'made');
  assert.equal(page.ready(), 'bad', 'loading is not ready');
  page.backup()!.fire('load');
  await page.pass(500, { beat: true });
  assert.equal(page.ready(), 'ready');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(page.hellos().at(-1)!['backup'], 'ready');

  // Cheesy reloading its own display, with the field there: not news.
  page.backup()!.fire('load');
  assert.equal(page.ready(), 'ready');
  await page.pass(1000, { beat: true });
  assert.equal(page.ready(), 'ready');

  // A desk that names no field: nothing to stand in with, and no fault.
  page.net.info = { mode: 'normal', field: { host: null } };
  await page.drop();
  await page.open();
  await page.send(snapshot(fieldUp()));
  await page.pass(30_000, { step: 1000, beat: true });
  assert.equal(page.ready(), 'none');
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(page.hellos().at(-1)!['backup'], 'none');
});

test('a probe already on the wire when the display reloaded itself does not vouch for that reload', async () => {
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  await page.drop();
  await page.pass(4000);
  assert.equal(page.showing(), 'cheesy');
  const frame = page.backup();
  assert.ok(frame);
  // A probe goes out (every 5 s while the field is on screen) and hangs.
  page.net.hold = true;
  await page.pass(5000);
  assert.equal(page.held.length, 1, 'a probe on the wire');
  // Meanwhile the display reloads itself: off the stream at once.
  frame.fire('load');
  assert.equal(page.showing(), 'desk');
  // The old probe answers. It was asked before the reload, so whatever the
  // reload got (perhaps the error page) is not what it found.
  page.held.shift()!(true);
  await page.pass(100);
  assert.equal(page.showing(), 'desk', 'not vouched for by a question asked before it');
  assert.equal(page.held.length, 1, 'asked again at once');
  page.held.shift()!(true);
  await page.pass(100);
  assert.equal(page.showing(), 'cheesy', 'a probe asked after the reload vouches for it');
  assert.deepEqual(frame.srcs, [BACKUP_URL], 'and nothing was loaded again for it');
});

test('only a luma keyer on its own stands in for the field', async () => {
  // OBS has its own suppression of the field overlay; a frame (/s/watch) has
  // its own feed; fill and alpha are a projector and a layer.
  for (const [what, where] of [
    ['asked for alpha', { search: '?key=alpha' }],
    ['asked for fill', { search: '?key=fill' }],
    ['framed', { framed: true }],
    ['framed by the kiosk', { framed: true, search: '?key=fill&kiosk=1' }],
    ['framed and asked for luma', { framed: true, search: '?key=luma' }],
    ['in OBS', { obs: true }],
    ['in OBS asked for luma', { obs: true, search: '?key=luma' }],
  ] as [string, Where][]) {
    const page = await openProgram(where);
    await page.pass(1000);
    await page.open();
    await page.send(snapshot(fieldUp()));
    await page.drop();
    await page.pass(60_000, { step: 2000 });
    assert.equal(page.backup(), undefined, `${what}: no frame`);
    assert.deepEqual(page.probes, [], `${what}: nothing asked of the field`);
    assert.equal(page.showing(), undefined, `${what}: no handoff at all`);
    assert.ok(page.hellos().every(h => h['showing'] === null), `${what}: reports showing nothing`);
    assert.ok(page.hellos().every(h => h['backup'] === null), `${what}: and no stand-in`);
    assert.equal(page.ready(), undefined, what);
    assert.deepEqual(page.navigations, [], what);
  }
});

test('a page the desk names no field for never makes the frame, and follows the desk when it finds one', async () => {
  for (const [what, info] of [
    ['a desk still looking for the field', { mode: 'normal', field: { host: null } }],
    ['an older desk that does not say', { mode: 'normal' }],
    ['a desk that does not answer', 'fail'],
    ['an answer that is not a host', { mode: 'normal', field: { host: 'http://evil.example/x' } }],
    ['words', { mode: 'normal', field: { host: 'Free pizza at the snack bar' } }],
    ['a number', { mode: 'normal', field: { host: 8080 } }],
  ] as [string, unknown][]) {
    const page = await openProgram({}, { info, cheesy: true, desk: true });
    await healthy(page);
    await page.drop();
    await page.pass(60_000, { step: 2000 });
    assert.equal(page.backup(), undefined, `${what}: no frame`);
    assert.deepEqual(page.probes, [], `${what}: nothing asked of any field`);
    assert.equal(page.showing(), 'desk', what);
  }

  // The desk finds the field later (it keeps looking by itself): the next
  // snapshot after a reconnect brings the page the news.
  const page = await openProgram({}, { info: { mode: 'normal', field: { host: null } }, cheesy: true, desk: true });
  await healthy(page);
  assert.equal(page.backup(), undefined);
  page.net.info = { mode: 'normal', field: { host: FIELD } };
  await page.drop();
  await page.open();
  await page.send(snapshot(fieldUp()));
  await page.pass(1000);
  const frame = page.backup();
  assert.ok(frame, 'the field named: the frame is made');
  assert.deepEqual(frame.srcs, [BACKUP_URL]);

  // The desk drops the field: the frame goes with it.
  page.net.info = { mode: 'normal', field: { host: null } };
  await page.drop();
  await page.open();
  await page.send(snapshot(fieldUp()));
  await page.pass(1000);
  assert.equal(frame.removed, true, 'no field: nothing to stand in with');
  assert.equal(page.showing(), 'desk');

  // And without a reconnect, within a minute of asking again. (A page of
  // its own, opened last: the stand-in browser's globals are the newest
  // page's.)
  const later = await openProgram({}, { info: { mode: 'normal', field: { host: null } }, cheesy: true, desk: true });
  await healthy(later);
  later.net.info = { mode: 'normal', field: { host: FIELD } };
  await later.pass(61_000, { step: 1000, beat: true });
  assert.ok(later.backup(), 'asked again once a minute while the desk is up');
});

test('a desk that comes back naming no field takes the field display off the input in that moment', async () => {
  // Not at the next paint: with the frame gone and the page still saying
  // 'cheesy', the stage stays hidden and the input is empty until then.
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  await page.drop();
  await page.pass(4000);
  assert.equal(page.showing(), 'cheesy');
  page.net.info = { mode: 'normal', field: { host: null } };
  await page.open();
  await page.deliver(snapshot(fieldUp()));
  assert.equal(page.backup(), undefined, 'the frame is gone');
  assert.equal(page.showing(), 'desk', "and the desk's graphics are back on the input with it");
});

test('the page never navigates while the desk is unreachable, by any path', async () => {
  /*
   * Every way the shared client and the program can leave a page: the
   * sign-in check after a reconnect (a desk restart rotates the session),
   * which only moves on the desk's own answer, and nothing else. The desk
   * goes away and comes back several times, with and without HTTP, and the
   * page stays where it is.
   */
  const page = await openProgram();
  await page.pass(500);
  await healthy(page);
  for (let round = 0; round < 3; round++) {
    page.net.desk = false;
    await page.drop();
    await page.pass(40_000, { step: 2000 });
    // The socket back before the desk's pages are (a desk still starting):
    // the sign-in check's question goes unanswered, and nothing moves.
    await page.open();
    await page.send(snapshot(fieldUp()));
    await page.pass(2000, { step: 1000 });
    page.net.desk = true;
    await page.drop();
    await page.open();
    await page.send(snapshot(fieldUp()));
    await page.pass(6000, { step: 1000 });
  }
  assert.equal(page.showing(), 'desk');
  assert.deepEqual(page.navigations, []);
  const frame = page.backup();
  assert.ok(frame);
  assert.deepEqual(frame.srcs, [BACKUP_URL], 'nor its frame, which stayed good');
  // A desk that did not answer which field it is on said nothing about the
  // field: the page kept the one it knew, ready for the next outage.
  assert.equal(frame.removed, false);
  assert.ok(page.infos.length >= 4, 'it asked, each time the desk came back');
});
