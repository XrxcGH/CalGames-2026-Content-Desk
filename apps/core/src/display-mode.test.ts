/**
 * What a screen paints behind itself, and what it says when it has nothing
 * to show, driven for real.
 *
 * The venues stopped using OBS: the picture is now a browser full screen on
 * a computer whose HDMI goes to a projector, a TV or a hardware switcher. The
 * screens were transparent layers built for OBS, and a transparent page in a
 * plain browser is a WHITE page, which is what an AV coordinator testing the
 * desk saw, for good, until the volunteers gave up on it.
 *
 * The decision itself (displayModeFor) is run directly. The telestrator,
 * arcade and kiosk pages run their own inline scripts against a small
 * stand-in DOM built from their markup, with the real shared client's
 * applyDisplayMode reading the real globals a browser would have, the same
 * arrangement venue-safety.test.ts uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SURFACES = join(import.meta.dirname, '..', '..', '..', 'surfaces');
const pageHtml = (name: string): string => readFileSync(join(SURFACES, name, 'index.html'), 'utf8');

type Fn = (...args: unknown[]) => unknown;
interface Where { search?: string; obs?: boolean; framed?: boolean; userAgent?: string }
interface ModeInput { asked?: string | null; markup?: string | null; alone?: string | null; inObs?: boolean; embedded?: boolean }
interface Client {
  KEY_MODES: string[];
  displayModeFor: (o: ModeInput) => string;
  insideObs: (w: unknown) => boolean;
  framedPage: (w: unknown) => boolean;
  applyDisplayMode: (o?: { alone?: string | null }) => URLSearchParams;
  [rest: string]: unknown;
}
// @ts-expect-error untyped browser module, cast on the same line
const client = (await import('../../../surfaces/_shared/desk-client.js')) as Client;
// @ts-expect-error untyped browser module, cast on the same line
const telestrator = (await import('../../../surfaces/_shared/telestrator.js')) as Record<string, unknown>;

// ---- the decision ---------------------------------------------------------------

test('the address wins, then OBS and a frame keep the layer, and a browser alone is luma', () => {
  const mode = client.displayModeFor;
  // What the program, the telestrator and the arcade ask for: luma alone,
  // so the plain address is graphics on black, right on a switcher's luma
  // key and readable on a projector. Fill is ?key=fill.
  const program = { markup: 'alpha', alone: 'luma' };

  // A browser on its own: a switcher input, a projector, a TV.
  assert.equal(mode({ ...program }), 'luma');
  assert.equal(mode({ markup: 'alpha', alone: 'fill' }), 'fill', 'a screen whose alone look is fill gets it');
  // Inside OBS, exactly as before: a Browser Source at /s/program is transparent.
  assert.equal(mode({ ...program, inObs: true }), 'alpha');
  // Framed by /s/watch over a field feed: the feed still shows through.
  assert.equal(mode({ ...program, embedded: true }), 'alpha');
  assert.equal(mode({ ...program, inObs: true, embedded: true }), 'alpha');

  // An address that names a mode beats every guess, in every context.
  for (const ctx of [{}, { inObs: true }, { embedded: true }]) {
    for (const key of ['alpha', 'luma', 'fill']) {
      assert.equal(mode({ ...program, ...ctx, asked: key }), key, `?key=${key} in ${JSON.stringify(ctx)}`);
    }
  }
  assert.equal(mode({ ...program, asked: ' LUMA ' }), 'luma', 'typed loosely, still read');
  // An unknown key used to land on <html> as is, match no style, and leave
  // the page transparent: in a plain browser, the white page again.
  assert.equal(mode({ ...program, asked: 'green' }), 'luma');
  assert.equal(mode({ ...program, asked: 'green', inObs: true }), 'alpha');
  assert.equal(mode({ ...program, asked: '' }), 'luma', 'an empty ?key= is no answer');

  // A screen with no alone look keeps its markup default, as it always did:
  // the side screen and trivia ship luma, the telestrator pad alpha.
  assert.equal(mode({ markup: 'luma' }), 'luma');
  assert.equal(mode({ markup: 'luma', inObs: true }), 'luma');
  assert.equal(mode({ markup: 'luma', asked: 'alpha' }), 'alpha');
  assert.equal(mode({ markup: 'alpha' }), 'alpha');
  assert.equal(mode({}), 'alpha', 'no markup and no ask: the old default');

  assert.deepEqual(client.KEY_MODES, ['alpha', 'luma', 'fill'], 'no chroma mode: see KEY_MODES');
});

test('OBS is known by either of its two tells, and a frame by its parent', () => {
  assert.equal(client.insideObs({ obsstudio: { pluginVersion: '30.2.3' } }), true, 'the injected object');
  // The object only reaches a Browser Source's TOP frame; the agent reaches every frame.
  const obsAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/127.0.6533.120 Safari/537.36 OBS/31.0.2';
  assert.equal(client.insideObs({ navigator: { userAgent: obsAgent } }), true, 'the user agent');
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/127.0.0.0 Safari/537.36';
  assert.equal(client.insideObs({ navigator: { userAgent: chrome } }), false, 'a plain browser');
  assert.equal(client.insideObs({ obsstudio: null, navigator: { userAgent: chrome } }), false);
  assert.equal(client.insideObs({}), false);

  const self = {};
  assert.equal(client.framedPage({ self, top: self }), false, 'its own top');
  assert.equal(client.framedPage({ self, top: {} }), true, 'a parent page');
  assert.equal(client.framedPage({}), false, 'no browser at all');
  const refuses = { self, get top(): unknown { throw new Error('blocked'); } };
  assert.equal(client.framedPage(refuses), true, 'a browser that will not say is treated as framed: the old look');
});

// ---- a stand-in browser for the inline pages -----------------------------------

class El {
  id: string;
  hidden = false;
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  /** How many times the page set src: each one is a load (a reload, for a frame). */
  loads = 0;
  #src = '';
  get src(): string { return this.#src; }
  set src(v: string) { this.#src = v; this.loads++; }
  // What a feed element reports, set by a test as a browser would: an image
  // that has decoded a frame has a size, and one the browser has finished
  // with (an error, or a stream cut mid-way) is complete.
  naturalWidth = 0;
  complete = false;
  readyState = 0;
  error: unknown = null;
  onload: Fn | null = null;
  onerror: Fn | null = null;
  onloadeddata: Fn | null = null;
  onended: Fn | null = null;
  readonly attrs = new Set<string>();
  #child: El | null = null;
  constructor(id: string) { this.id = id; }
  get firstElementChild(): El { return (this.#child ??= new El('')); }
  get children(): El[] { return []; }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.add(name); else this.attrs.delete(name);
    return on;
  }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  setAttribute(name: string): void { this.attrs.add(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  addEventListener(): void {}
  removeEventListener(): void {}
  play(): Promise<void> { return Promise.resolve(); }
  load(): void {}
  getContext(): unknown {
    const ctx: Record<string, unknown> = { canvas: { width: 1920, height: 1080 } };
    return new Proxy(ctx, { get: (t, k) => (k in t ? t[k as string] : () => {}) });
  }
}

/** Every element with an id in the page's markup, with the flags it ships with. */
function elementsOf(html: string): Map<string, El> {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const els = new Map<string, El>();
  for (const m of markup.matchAll(/<[a-zA-Z][\w-]*\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) continue;
    const el = new El(id);
    el.hidden = /(^|\s)hidden(\s|=|$)/.test(attrs);
    if (/(^|\s)data-off(\s|=|$)/.test(attrs)) el.attrs.add('data-off');
    els.set(id, el);
  }
  return els;
}

/** The shared client's desk, as far as these pages use it. */
class FakeDesk {
  state: unknown = null;
  readonly #on = new Map<string, Fn[]>();
  on(type: string, fn: Fn): this { this.#on.set(type, [...(this.#on.get(type) ?? []), fn]); return this; }
  fire(type: string, detail: unknown): void { for (const fn of this.#on.get(type) ?? []) fn(detail); }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

/**
 * Run a page's own module script, in a browser opened `where` says. The
 * globals are set on the real global object as well as handed to the page,
 * because the real applyDisplayMode reads them from there, as it does in a
 * browser.
 */
async function runPage(name: string, where: Where = {}, answers: Record<string, unknown> = {}) {
  const html = pageHtml(name);
  const els = elementsOf(html);
  const root = new El('html');
  const markupKey = /<html\b[^>]*\bdata-key="(\w+)"/.exec(html)?.[1];
  if (markupKey) root.dataset['key'] = markupKey;
  const desk = new FakeDesk();
  const ticks: Fn[] = [];
  const intervals: [Fn, number][] = [];
  const fetched: string[] = [];
  const document = {
    documentElement: root, title: '',
    getElementById: (id: string): El | null => els.get(id) ?? null,
    addEventListener: (): void => {},
  };
  const location = { search: where.search ?? '', pathname: `/s/${name}`, host: 'desk.test',
    protocol: 'http:', origin: 'http://desk.test',
    href: `http://desk.test/s/${name}${where.search ?? ''}` };
  const fetch = async (url: string): Promise<unknown> => {
    fetched.push(url);
    const path = url.split('?')[0] ?? url;
    if (!(path in answers)) throw new TypeError('Failed to fetch');
    const body = answers[path];
    return { ok: true, status: 200, json: async () => body };
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g['location'] = location;
  g['document'] = document;
  g['getComputedStyle'] = () => ({ getPropertyValue: () => '' });
  if (where.obs) g['obsstudio'] = { pluginVersion: '30.2.3' }; else delete g['obsstudio'];
  if (where.framed) { g['self'] = g; g['top'] = { parent: 'a kiosk' }; } else { delete g['self']; delete g['top']; }
  const realNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
  if (where.userAgent) {
    Object.defineProperty(g, 'navigator', { value: { userAgent: where.userAgent }, configurable: true });
  }

  const mods: Record<string, Record<string, unknown>> = {
    '/shared/desk-client.js': {
      ...client,
      connect: () => desk,
      fitStage: () => {},
      startTicker: (fn: Fn) => { ticks.push(fn); return () => {}; },
      roll: (el: El, to: number) => { el.textContent = String(to); },
    },
    '/shared/telestrator.js': telestrator,
  };
  const window = { __tele: null as unknown, addEventListener: () => {}, location };
  const params: Record<string, unknown> = {
    __mods: mods, document, location, window, fetch,
    // Kept, not run: a test turns them by hand (every), so no real timer
    // outlives it.
    setInterval: (fn: Fn, ms: number) => { intervals.push([fn, ms]); return intervals.length; },
    clearInterval: () => {},
  };
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, `${name} has a module script`);
  const code = script.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm,
    (_, names: string, from: string) => `const {${names}} = __mods[${JSON.stringify(from)}];`);
  assert.doesNotMatch(code, /^\s*import\b/m, `${name}: every import was rewritten`);
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  try {
    await new AsyncFunction(...Object.keys(params), `'use strict';\n${code}`)(...Object.values(params));
    await flush();
  } finally {
    if (where.userAgent) {
      if (realNavigator) Object.defineProperty(g, 'navigator', realNavigator); else delete g['navigator'];
    }
  }
  return {
    $: (id: string): El => { const el = els.get(id); assert.ok(el, `${name} has #${id}`); return el; },
    key: (): string | undefined => root.dataset['key'],
    desk, window, fetched, document,
    tick: (): void => { for (const fn of ticks) fn(); },
    /** One turn of every interval the page set at this period. */
    every: (ms: number): void => { for (const [fn, at] of intervals) if (at === ms) fn(); },
  };
}

// ---- the telestrator layer ------------------------------------------------------

test('the telestrator asked for fill says what it is for until somebody draws', async () => {
  const page = await runPage('tele', { search: '?key=fill' });
  assert.equal(page.key(), 'fill', 'a projector that should never look empty');
  page.tick();
  const idle = page.$('idle');
  assert.equal(idle.hidden, false, 'nothing drawn: it says what the layer is for');

  // The analyst draws: the ink is the picture now.
  const book = (page.window.__tele as { book: { begin: Fn; append: Fn } }).book;
  page.desk.fire('relay:tele', { k: 'begin', id: 's1', tool: 'pen', ink: 'gold', width: 9 });
  page.desk.fire('relay:tele', { k: 'pts', id: 's1', pts: [[0.3, 0.3], [0.6, 0.4]] });
  assert.ok(book, 'the page published its stroke book');
  page.tick();
  assert.equal(idle.hidden, true, 'ink on the layer: the words step aside');
  assert.equal(page.$('chip').hasAttribute('data-on'), true, 'and the Analysis chip is up, as before');

  // Cleared: the words come back. The kill switch too.
  page.desk.fire('relay:tele', { k: 'clear' });
  page.tick();
  assert.equal(idle.hidden, false);
  page.desk.fire('relay:tele', { k: 'begin', id: 's2', tool: 'pen', ink: 'gold' });
  page.desk.state = { telestrator: { hidden: true } };
  page.tick();
  assert.equal(idle.hidden, false, 'ink hidden from program: the screen still says what it is');
});

test('the telestrator alone, in OBS, framed, or keyed is ink and nothing else', async () => {
  const obsAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0.0.0 Safari/537.36 OBS/31.0.2';
  for (const [what, where, key] of [
    // A plain browser is a switcher input now: ink on black, for its luma key.
    ['a browser on its own', {}, 'luma'],
    ['OBS', { obs: true }, 'alpha'],
    ['OBS known only by its agent', { userAgent: obsAgent }, 'alpha'],
    ['framed', { framed: true }, 'alpha'],
    ['a luma keyer', { search: '?key=luma' }, 'luma'],
    ['asked for alpha', { search: '?key=alpha' }, 'alpha'],
  ] as [string, Where, string][]) {
    const page = await runPage('tele', where);
    assert.equal(page.key(), key, what);
    page.tick();
    assert.equal(page.$('idle').hidden, true, `${what}: no words on the layer`);
  }
});

// ---- the arcade layer -----------------------------------------------------------

const ARCADE_SET = {
  set: { game: 'smash', round: 'Winners Final', players: [{ name: 'Ana' }, { name: 'Ben' }], scores: [2, 1] },
  gp: null, standings: [], upNext: null,
  boxes: { card: true, ffa: true, gp: true, upNext: true },
};

test('the arcade asked for fill says what it is for while no box is up', async () => {
  const fill = { search: '?key=fill' };
  const quiet = await runPage('arcade', fill, { '/api/arcade': { set: null, gp: null, standings: [], upNext: null } });
  assert.equal(quiet.key(), 'fill');
  assert.equal(quiet.$('idle').hidden, false, 'nothing being played: it says what the screen is for');

  const playing = await runPage('arcade', fill, { '/api/arcade': ARCADE_SET });
  assert.equal(playing.$('card').hasAttribute('data-off'), false, 'the premise: the versus card is up');
  assert.equal(playing.$('idle').hidden, true, 'a set on screen: no idle words');
  // The set ends with nothing else up: back to the words.
  playing.desk.fire('arcade.set_end', { payload: { ...ARCADE_SET, set: null } });
  assert.equal(playing.$('card').hasAttribute('data-off'), true);
  assert.equal(playing.$('idle').hidden, false);
  // Standings alone are something on screen.
  playing.desk.fire('arcade.bracket_updated', { payload: { ...ARCADE_SET, set: null,
    gp: { name: 'Pit Crew Cup', raceCount: 4, races: [] }, standings: [] } });
  assert.equal(playing.$('gp').hasAttribute('data-off'), false);
  assert.equal(playing.$('idle').hidden, true);
  // And a box the operator switched off is not.
  playing.desk.fire('arcade.bracket_updated', { payload: { ...ARCADE_SET, set: null,
    gp: { name: 'Pit Crew Cup', raceCount: 4, races: [] }, standings: [],
    boxes: { card: true, ffa: true, gp: false, upNext: true } } });
  assert.equal(playing.$('idle').hidden, false, 'every box off: the words again');

  const unreachable = await runPage('arcade', fill, {});
  assert.equal(unreachable.$('idle').hidden, false, 'no answer from the desk still leaves words, not an empty page');
});

test('the arcade alone, in OBS or framed over a game capture is the boxes and nothing else', async () => {
  for (const [where, key] of [
    // A plain browser is a switcher input now: boxes on black, for its luma key.
    [{}, 'luma'],
    [{ obs: true }, 'alpha'], [{ framed: true }, 'alpha'], [{ framed: true, search: '?key=alpha&kiosk=1' }, 'alpha'],
  ] as [Where, string][]) {
    const page = await runPage('arcade', where, { '/api/arcade': { set: null, gp: null, standings: [], upNext: null } });
    assert.equal(page.key(), key, JSON.stringify(where));
    assert.equal(page.$('idle').hidden, true, `${JSON.stringify(where)}: no words over the capture`);
  }
});

// ---- the kiosk ------------------------------------------------------------------

test('the kiosk frames the program over a feed as a layer, and with no feed lets it fill', async () => {
  const noFeed = { '/api/urls': { base: 'http://10.0.100.20:8720', fieldStream: null } };
  const withFeed = { '/api/urls': { base: 'http://10.0.100.20:8720', fieldStream: 'http://10.0.100.9/cam.mjpg' } };

  // No feed configured: nothing would show through, so the program draws the
  // backdrop itself and can say why it is empty. It used to sit on a black
  // stage: a pit TV that looked dead until the first real match.
  const bare = await runPage('watch', { search: '?screen=program' }, noFeed);
  assert.equal(bare.$('fg').src, '/s/program?key=fill&kiosk=1');
  assert.equal('alone' in bare.$('stage').dataset, true, 'the frame takes the whole display');
  assert.equal('feed' in bare.$('stage').dataset, false, 'and no black stage behind it');

  // A configured feed: transparent over it, as before, once it shows a picture.
  const fed = await runPage('watch', { search: '?screen=program' }, withFeed);
  const cam = fed.$('bgImg');
  assert.equal(cam.src, 'http://10.0.100.9/cam.mjpg');
  assert.equal(cam.hidden, false, 'laid out, so the browser loads it');
  assert.equal('picture' in cam.dataset, false, 'but not seen before it has a picture');
  assert.equal(fed.$('fg').src, '', 'no overlay chosen while the camera is asked');
  assert.equal('feed' in fed.$('stage').dataset, false, 'and no black stage meanwhile');
  cam.naturalWidth = 640;
  cam.complete = true;
  cam.onload?.();
  assert.equal(fed.$('fg').src, '/s/program?key=alpha&kiosk=1');
  assert.equal(fed.$('fg').loads, 1, 'straight to the layer: the backdrop look was never framed');
  assert.equal('feed' in fed.$('stage').dataset, true, 'black under the video');
  assert.equal('picture' in cam.dataset, true, 'and the video seen');

  // A feed named in the address wins, and needs no question to the desk.
  const asked = await runPage('watch', { search: '?screen=program&feed=http%3A%2F%2Fcam.local%2Fa.mjpg' }, noFeed);
  assert.equal(asked.$('bgImg').src, 'http://cam.local/a.mjpg');
  assert.deepEqual(asked.fetched.filter(u => u.startsWith('/api/urls')), [], 'no fetch for a feed it was given');

  // The desk not answering is the same as no feed: never a black screen.
  const offline = await runPage('watch', { search: '?screen=program' }, {});
  assert.equal(offline.$('fg').src, '/s/program?key=fill&kiosk=1');

  const arcade = await runPage('watch', { search: '?screen=arcade' }, noFeed);
  assert.equal(arcade.$('fg').src, '/s/arcade?key=fill&kiosk=1');

  // Screens that draw their own background are framed as they always were.
  for (const id of ['side', 'trivia', 'next']) {
    const page = await runPage('watch', { search: `?screen=${id}` }, withFeed);
    assert.equal(page.$('fg').src, `/s/${id}?key=alpha&kiosk=1`, id);
    assert.equal('alone' in page.$('stage').dataset || 'feed' in page.$('stage').dataset, false, id);
  }
});

test('a field feed that shows no picture leaves words on the display, never a black screen', async () => {
  /*
   * A kiosk with a feed configured used to trust it at once: the stage went
   * black and the program went transparent before anything had loaded. A
   * camera that was off, on another network, or typed wrong in Event
   * settings then left a 16:9 display solid black, with Chrome's
   * broken-image glyph in the corner and nothing to read, until the first
   * real match: the same dead screen this work set out to remove.
   */
  const secret = 'http://admin:hunter2@10.0.100.9:8080/video.mjpg?pwd=hunter2';
  const page = await runPage('watch', { search: '?screen=program' },
    { '/api/urls': { base: 'http://10.0.100.20:8720', fieldStream: secret } });
  const cam = page.$('bgImg');
  const stage = page.$('stage');
  const fg = page.$('fg');
  assert.equal(cam.src, secret, 'the camera is asked');
  assert.equal('picture' in cam.dataset, false, 'but not seen: no broken-image glyph');

  // It refuses: an error event, then an image the browser is done with, with no size.
  cam.complete = true;
  cam.onerror?.();
  assert.equal(fg.src, '/s/program?key=fill&kiosk=1&feeddown=10.0.100.9%3A8080',
    'the program on its own backdrop, told which feed to name');
  assert.doesNotMatch(fg.src, /hunter2|admin/, 'never the password a camera address can carry');
  assert.equal('alone' in stage.dataset, true, 'the whole display');
  assert.equal('feed' in stage.dataset, false, 'and no black stage');

  // It keeps asking, quietly, with a new address so no cached refusal answers.
  page.every(1000);
  page.every(1000);
  assert.equal(cam.loads, 1, 'not every second');
  page.every(1000);
  assert.equal(cam.loads, 2, 'asked again');
  assert.match(cam.src, /^http:\/\/admin:hunter2@10\.0\.100\.9:8080\/video\.mjpg\?pwd=hunter2&t=\d+$/);
  cam.complete = false;                       // the browser is asking
  for (let i = 0; i < 6; i++) page.every(1000);
  assert.equal(cam.loads, 2, 'a request still in flight is not cut short');
  assert.equal(fg.loads, 1, 'and the program is not reloaded while it waits');

  // The camera comes on: the video under the graphics, reloaded once as a layer.
  cam.naturalWidth = 640;
  cam.complete = true;
  cam.onload?.();
  assert.equal(fg.src, '/s/program?key=alpha&kiosk=1');
  assert.equal(fg.loads, 2, 'one reload, from the backdrop to the layer');
  assert.equal('feed' in stage.dataset, true);
  assert.equal('alone' in stage.dataset, false);
  assert.equal('picture' in cam.dataset, true);

  // Cut mid-show. Chrome fires nothing for this: the image only loses its size.
  cam.naturalWidth = 0;
  page.every(1000);
  assert.equal('feed' in stage.dataset, false, 'the backdrop behind the graphics, not black');
  assert.equal('picture' in cam.dataset, false, 'and no broken-image glyph');
  assert.equal(fg.loads, 2, 'the graphics are not reloaded over a live match');
  page.every(1000);
  page.every(1000);
  assert.equal(cam.loads, 3, 'asked again, which the old error-only retry never did for a cut');
  // Back by itself: under the graphics again, with no reload of them.
  cam.naturalWidth = 640;
  page.every(1000);
  assert.equal('feed' in stage.dataset, true);
  assert.equal('picture' in cam.dataset, true);
  assert.equal(fg.src, '/s/program?key=alpha&kiosk=1');
  assert.equal(fg.loads, 2);
});

test('a feed that hangs gets a few seconds, and video and YouTube feeds follow their own rules', async () => {
  // A camera on a network this display cannot reach: no picture, no error.
  const hung = await runPage('watch', { search: '?screen=program&feed=http%3A%2F%2Fcam.local%2Fa.mjpg' }, {});
  for (let i = 0; i < 3; i++) hung.every(1000);
  assert.equal(hung.$('fg').src, '', 'still giving it a chance');
  hung.every(1000);
  assert.equal(hung.$('fg').src, '/s/program?key=fill&kiosk=1&feeddown=cam.local');
  for (let i = 0; i < 6; i++) hung.every(1000);
  assert.equal(hung.$('bgImg').loads, 1, 'the browser is still asking; it is left to');

  // A video file or stream: a first frame is the picture, an error is a refusal.
  const vid = await runPage('watch', { search: '?screen=program&feed=http%3A%2F%2F10.0.100.9%2Ffield.mp4' }, {});
  const v = vid.$('bgVideo');
  assert.equal(v.src, 'http://10.0.100.9/field.mp4');
  assert.equal('picture' in v.dataset, false);
  v.error = { code: 2 };
  v.onerror?.();
  assert.equal(vid.$('fg').src, '/s/program?key=fill&kiosk=1&feeddown=10.0.100.9');
  v.error = null;
  v.readyState = 2;
  v.onloadeddata?.();
  assert.equal(vid.$('fg').src, '/s/program?key=alpha&kiosk=1');
  assert.equal('picture' in v.dataset, true);
  assert.equal('feed' in vid.$('stage').dataset, true);

  // A YouTube page cannot be asked whether it plays, and says so itself when it does not.
  const yt = await runPage('watch',
    { search: `?screen=program&feed=${encodeURIComponent('https://www.youtube.com/watch?v=abcdefghijk')}` }, {});
  assert.equal(yt.$('fg').src, '/s/program?key=alpha&kiosk=1', 'framed as a layer at once, as before');
  assert.equal(yt.$('bgFrame').hidden, false);
  assert.equal('feed' in yt.$('stage').dataset, true);

  // The arcade has a feed too: a dead one gives it its own backdrop and idle words.
  const arcade = await runPage('watch', { search: '?screen=arcade&feed=http%3A%2F%2F10.0.100.9%2Fcam.mjpg' }, {});
  arcade.$('bgImg').complete = true;
  arcade.$('bgImg').onerror?.();
  assert.match(arcade.$('fg').src, /^\/s\/arcade\?key=fill&kiosk=1/);
});

test('after a desk restart the kiosk reloads its screen only once the desk answers again', async () => {
  /*
   * The one reload a venue display does by itself. Done while the desk is
   * down, it is the browser's connection-refused page in the frame, light,
   * and with nothing left on it to come back from. So it waits for the
   * desk's answer, and reloads once, on that edge.
   */
  const answers: Record<string, unknown> = { '/api/urls': { base: 'http://10.0.100.20:8720', fieldStream: null } };
  const page = await runPage('watch', { search: '?screen=program' }, answers);
  const fg = page.$('fg');
  assert.equal(fg.src, '/s/program?key=fill&kiosk=1');
  assert.equal(fg.loads, 1);
  // The desk goes away: checked every 15 s, never reloaded meanwhile.
  for (let i = 0; i < 4; i++) { page.every(15_000); await flush(); }
  assert.equal(fg.loads, 1, 'nothing reloaded while the desk is not answering');
  // It answers again: one reload, of the same screen.
  answers['/api/state'] = { screen: 'blank' };
  page.every(15_000);
  await flush();
  assert.equal(fg.loads, 2, 'reloaded once, on the desk\'s answer');
  assert.equal(fg.src, '/s/program?key=fill&kiosk=1');
  page.every(15_000);
  await flush();
  assert.equal(fg.loads, 2, 'and not again while all is well');
});

test('the kiosk keeps the feed invisible until it has a picture, by the stylesheet too', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(pageHtml('watch'))?.[1] ?? '';
  assert.match(css, /#bgImg:not\(\[data-picture\]\), #bgVideo:not\(\[data-picture\]\) \{ visibility: hidden; \}/);
  assert.match(css, /#stage\[data-feed\] \{ background: #000; \}/, 'black only under a picture');
  assert.match(css, /#stage \{[^}]*background: transparent;/);
});

test('the chooser leads with the display each screen is for, in plain words', async () => {
  const page = await runPage('watch', {}, { '/api/urls': { base: 'http://10.0.100.20:8720', fieldStream: null } });
  const grid = page.$('grid').innerHTML;
  const cards = [...grid.matchAll(/<span class="for">([^<]*)<\/span>\s*<b>([^<]*)<\/b>/g)]
    .map(m => [m[1], m[2]]);
  assert.deepEqual(cards, [
    ['For the projector, or the stream', 'Program'],
    ['For the TVs beside the field', 'Side screen'],
    ['For pit TVs', 'When do we play?'],
    ['For the trivia monitor', 'Trivia'],
    ['For the arcade TV', 'Arcade'],
  ]);
  assert.equal(page.document.title, 'Pick a screen · CalGames 2026');
  const note = page.$('note').innerHTML;
  // The plain address is the keyer's now (luma alone), and it carries the
  // field's own score when the desk cannot, so it replaces that display.
  assert.match(note, /<b>http:\/\/10\.0\.100\.20:8720\/s\/program<\/b> full screen/, 'the one address for a hardware keyer');
  assert.match(note, /in place of the field's own score display/);
  assert.match(note, /No field feed is set, so Program draws on the CalGames backdrop/);
  // Words a volunteer reads, so none of the desk's own vocabulary.
  for (const text of [grid, note, pageHtml('watch').match(/<p class="lead">[\s\S]*?<\/p>/)?.[0] ?? '']) {
    assert.doesNotMatch(text, /\bsurfaces?\b|Browser Source|\bOBS\b/i);
  }
});

// ---- the stylesheet's half ------------------------------------------------------

test('fill paints the kiosk backdrop, and no standby words exist outside fill', () => {
  const css = readFileSync(join(SURFACES, '_shared', 'broadcast.css'), 'utf8');
  const fill = /:root\[data-key="fill"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(fill, /background-color:\s*var\(--cg-purple-void\)/);
  assert.match(fill, /background-image:\s*var\(--tex-perf\), var\(--geo\), var\(--atmo\)/);
  // One look: the kiosk's own backdrop is the same layers at the same sizes.
  const watchCss = /\nhtml \{([^}]*)\}/.exec(pageHtml('watch'))?.[1] ?? '';
  const layers = (block: string): string[] => ['background-color', 'background-image', 'background-size']
    .map(p => new RegExp(`${p}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? `no ${p}`);
  assert.deepEqual(layers(fill), layers(watchCss), 'fill and the kiosk draw one backdrop');
  // --atmo is three layers: one size each, or its gradient tiles in 320px bands.
  for (const m of css.matchAll(/background-image:\s*var\(--tex-perf\), var\(--geo\), var\(--atmo\);\s*background-size:\s*([^;]+);/g)) {
    assert.equal(m[1], 'var(--tex-perf-size), var(--geo-size), cover, cover, cover');
  }
  // The script hides the words outside fill; the stylesheet does too.
  assert.match(css, /:root:not\(\[data-key="fill"\]\) \.standby \{ display: none; \}/);
  // The screens without an alone look keep calling the shared default.
  for (const name of ['side', 'trivia']) {
    assert.match(pageHtml(name), /\bapplyDisplayMode\(\);/, `${name} keeps its markup default`);
  }
});
