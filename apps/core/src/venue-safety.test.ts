import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_SURFACES } from './access.ts';

/**
 * The safety message on the venue screens and the phone pages, driven for real.
 *
 * The pages are inline browser modules, so each test lifts the page's own
 * <script type="module"> out of its HTML and runs all of it against a small
 * stand-in DOM built from the page's own markup: a fake desk socket for the
 * screens that subscribe to state, a stubbed fetch for the pages that poll it,
 * fake timers and a fake clock for both. The assertions read what the page
 * drew. The checks these replace read the source with regexes, and they all
 * still passed with every safety display switched off.
 */

const SURFACES = join(import.meta.dirname, '..', '..', '..', 'surfaces');
const pageHtml = (name: string): string => readFileSync(join(SURFACES, name, 'index.html'), 'utf8');

// @ts-expect-error untyped browser module, cast on the same line
const realClient = (await import('../../../surfaces/_shared/desk-client.js')) as Record<string, unknown>;

type Fn = (...args: unknown[]) => unknown;
interface Rect { top: number; bottom: number; left: number; right: number; width: number; height: number }
interface Geometry {
  offsetTop?: () => number;
  offsetHeight?: () => number;
  clientHeight?: () => number;
  clientWidth?: () => number;
  scrollHeight?: () => number;
  scrollWidth?: () => number;
  rect?: () => Rect;
}

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
};

/** Just enough of an Element for these pages. Layout reads come from `geom`. */
class El {
  readonly tag: string;
  id = '';
  className = '';
  hidden = false;
  textContent = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  geom: Geometry = {};
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Fn[]>();
  constructor(tag: string) { this.tag = tag; }

  get firstElementChild(): El | null { return this.children[0] ?? null; }
  get lastElementChild(): El | null { return this.children.at(-1) ?? null; }
  get offsetTop(): number { return this.geom.offsetTop?.() ?? 0; }
  get offsetHeight(): number { return this.geom.offsetHeight?.() ?? 0; }
  get offsetWidth(): number { return 0; }
  get clientHeight(): number { return this.geom.clientHeight?.() ?? 0; }
  get clientWidth(): number { return this.geom.clientWidth?.() ?? 0; }
  get scrollHeight(): number { return this.geom.scrollHeight?.() ?? 0; }
  get scrollWidth(): number { return this.geom.scrollWidth?.() ?? 0; }
  getBoundingClientRect(): Rect {
    return this.geom.rect?.() ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }

  setAttribute(name: string, value: unknown): void {
    const v = String(value);
    if (name === 'hidden') this.hidden = true;
    else if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = v;
    else this.attrs.set(name, v);
  }
  hasAttribute(name: string): boolean {
    if (name === 'hidden') return this.hidden;
    if (name.startsWith('data-')) return camel(name.slice(5)) in this.dataset;
    return this.attrs.has(name);
  }
  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    if (name === 'hidden') this.hidden = false;
    else if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
    else this.attrs.delete(name);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
    return on;
  }
  addEventListener(type: string, fn: Fn): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  appendChild(child: El): El { child.parent = this; this.children.push(child); return child; }
  append(...kids: El[]): void { for (const k of kids) this.appendChild(k); }
  replaceChildren(...kids: El[]): void { this.children = []; this.append(...kids); }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  querySelector(): null { return null; }
  querySelectorAll(): El[] { return []; }
  focus(): void {}
  blur(): void {}
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** The page's markup as a tree of stand-ins, attributes and nesting kept. */
function parseMarkup(html: string): El {
  const doc = new El('#document');
  const stack: El[] = [doc];
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const tag = (m[2] ?? '').toLowerCase();
    if (m[1]) {
      const at = stack.map(e => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el = new El(tag);
    for (const a of (m[3] ?? '').matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
      el.setAttribute(a[1] ?? '', a[2] ?? a[3] ?? '');
    }
    stack.at(-1)?.appendChild(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  return doc;
}

function walk(el: El, visit: (e: El) => void): void {
  visit(el);
  for (const c of el.children) walk(c, visit);
}

/** Fake timers on a fake clock. Interval callbacks are awaited, then settled. */
class Timers {
  now = 0;
  #seq = 0;
  readonly #list = new Map<number, { fn: Fn; at: number; every: number | null }>();
  setInterval = (fn: Fn, ms = 0): number => this.#add(fn, ms, true);
  setTimeout = (fn: Fn, ms = 0): number => this.#add(fn, ms, false);
  clear = (id: number): void => { this.#list.delete(id); };
  #add(fn: Fn, ms: number, repeat: boolean): number {
    const id = ++this.#seq;
    this.#list.set(id, { fn, at: this.now + Math.max(0, ms), every: repeat ? Math.max(1, ms) : null });
    return id;
  }
  async advance(ms: number, errors: unknown[]): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let id = -1;
      let at = Infinity;
      for (const [k, t] of this.#list) if (t.at <= end && t.at < at) { id = k; at = t.at; }
      const t = this.#list.get(id);
      if (!t) break;
      this.now = t.at;
      if (t.every === null) this.#list.delete(id); else t.at += t.every;
      try { await t.fn(); } catch (err) { errors.push(err); }
      await flush();
    }
    this.now = end;
  }
}

/** document.fonts: loading until finish(), which is what a browser does when the last face lands. */
class Fonts {
  status: 'loading' | 'loaded';
  ready: Promise<void>;
  #resolve: () => void = () => {};
  readonly #done: Fn[] = [];
  constructor(loading: boolean) {
    this.status = loading ? 'loading' : 'loaded';
    this.ready = loading ? new Promise<void>(r => { this.#resolve = r; }) : Promise.resolve();
  }
  addEventListener(type: string, fn: Fn): void { if (type === 'loadingdone') this.#done.push(fn); }
  finish(): void {
    this.status = 'loaded';
    this.#resolve();
    for (const fn of this.#done) fn({});
  }
}

/** The shared client's DeskClient, as far as these pages use it. */
class FakeDesk {
  state: unknown = null;
  media: Record<string, unknown> = {};
  connected = true;
  readonly #handlers = new Map<string, Fn[]>();
  readonly #now: () => number;
  readonly #errors: unknown[];
  constructor(now: () => number, errors: unknown[]) { this.#now = now; this.#errors = errors; }
  get serverNow(): number { return this.#now(); }
  on(type: string, fn: Fn): this {
    this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), fn]);
    return this;
  }
  mediaFor(): null { return null; }
  emit(): void {}
  /** A state frame: kept, then handed to every listener, as the real client does. */
  push(state: unknown): void {
    this.state = state;
    this.fire('state', state);
  }
  /** One listener throwing does not stop the next, same as EventTarget. */
  fire(type: string, detail: unknown): void {
    for (const fn of this.#handlers.get(type) ?? []) {
      try { fn(detail); } catch (err) { this.#errors.push(err); }
    }
  }
}

/** Saturday of quals, 2 PM in Pleasanton. */
const WALL = Date.UTC(2026, 9, 17, 21, 0, 0);

interface Net {
  /** What /api/state answers. */
  state: unknown;
  /** Every request fails the way a phone off the wifi fails. */
  offline: boolean;
  calls: string[];
  /** How far the desk's clock (its Date header) runs ahead of the page's. */
  deskAhead?: number;
}

async function boot(name: string, opts: { fontsLoading?: boolean; state?: unknown } = {}) {
  const html = pageHtml(name);
  const doc = parseMarkup(html);
  const root = doc.children.find(c => c.tag === 'html');
  assert.ok(root, `${name} has an <html> element`);
  const byId = new Map<string, El>();
  walk(doc, e => { if (e.id) byId.set(e.id, e); });

  const errors: unknown[] = [];
  const timers = new Timers();
  const wall = (): number => WALL + timers.now;
  const desk = new FakeDesk(wall, errors);
  const fonts = new Fonts(opts.fontsLoading ?? false);
  const net: Net = { state: opts.state ?? null, offline: false, calls: [] };
  const docListeners = new Map<string, Fn[]>();
  const document = {
    documentElement: root,
    hidden: false,
    title: '',
    fonts,
    getElementById: (id: string): El | null => byId.get(id) ?? null,
    querySelectorAll: (sel: string): El[] => {
      if (!/^\.[\w-]+$/.test(sel)) return [];
      const out: El[] = [];
      walk(doc, e => { if (e.className.split(/\s+/).includes(sel.slice(1))) out.push(e); });
      return out;
    },
    createElement: (tag: string): El => new El(tag),
    addEventListener: (type: string, fn: Fn): void => {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
  };
  const fetch = async (url: string): Promise<unknown> => {
    net.calls.push(url);
    if (net.offline) throw new TypeError('Failed to fetch');
    const found = url === '/api/state' && net.state !== null;
    const body = found ? net.state : { error: 'not found' };
    const date = new Date(wall() + (net.deskAhead ?? 0)).toUTCString();
    return {
      ok: found, status: found ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body),
      headers: { get: (h: string) => (h.toLowerCase() === 'date' ? date : null) },
    };
  };
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: unknown) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
    };
  };
  class PageDate extends Date {
    constructor(v?: number | string) { super(v === undefined ? wall() : v); }
    static override now(): number { return wall(); }
  }
  const location = { search: '', pathname: `/s/${name}`, host: 'desk.test', protocol: 'http:', origin: 'http://desk.test' };
  const mods: Record<string, Record<string, unknown>> = {
    '/shared/desk-client.js': {
      ...realClient,
      connect: () => desk,
      applyDisplayMode: () => {},
      fitStage: () => {},
      restart: () => {},
      startTicker: () => {},
      roll: (el: El, to: number) => { el.textContent = String(to); },
    },
    '/shared/qr.js': { qrSvg: () => '<svg></svg>' },
  };
  const globals: Record<string, unknown> = {
    __mods: mods,
    document,
    window: { innerWidth: 1920, innerHeight: 1080, addEventListener: () => {}, location },
    location,
    fetch,
    setInterval: timers.setInterval,
    setTimeout: timers.setTimeout,
    clearInterval: timers.clear,
    clearTimeout: timers.clear,
    localStorage: storage(),
    sessionStorage: storage(),
    getComputedStyle: () => ({ lineHeight: '0px', getPropertyValue: () => '' }),
    addEventListener: () => {},
    innerWidth: 1920,
    innerHeight: 1080,
    Date: PageDate,
  };

  // The module's static imports become reads off the stand-in modules above.
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, `${name} has a module script`);
  const code = script.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm,
    (_, names: string, from: string) =>
      `const {${names.replace(/\s+as\s+/g, ': ')}} = __mods[${JSON.stringify(from)}];`);
  assert.doesNotMatch(code, /^\s*import\b/m, `${name}: every import was rewritten`);
  const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  await new AsyncFunction(...Object.keys(globals), `'use strict';\n${code}`)(...Object.values(globals));
  await flush();

  return {
    root,
    desk,
    fonts,
    net,
    errors,
    timers,
    document,
    $: (id: string): El => {
      const el = byId.get(id);
      assert.ok(el, `${name} has #${id}`);
      return el;
    },
    advance: (ms: number): Promise<void> => timers.advance(ms, errors),
    async fireDocument(type: string): Promise<void> {
      for (const fn of docListeners.get(type) ?? []) await fn({});
      await flush();
    },
  };
}
type Page = Awaited<ReturnType<typeof boot>>;

// ---- fixtures ---------------------------------------------------------------

interface Emergency { kind: string; message: string; detail?: string | null }
const EVACUATE: Emergency = {
  kind: 'evacuate',
  message: 'Leave by the north doors now',
  detail: 'Staff in yellow vests will guide you to the parking lot',
};

/** A state frame with nothing on it but what a test asks for. */
function frame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    emergency: null, status: null, match: null, announcement: null, nowQueuing: null,
    timer: null, pace: null, teams: {}, rankings: [], highestPlayedMatch: null,
    deck: { rows: [], offs: [], etas: [] },
    updatedAt: WALL,
    ...extra,
  };
}

/** The label table the program overlay paints; every other screen must say the same words. */
function programKinds(): Record<string, string> {
  const src = readFileSync(join(SURFACES, 'program', 'program.js'), 'utf8');
  const block = /const EMERG_KIND = \{([\s\S]*?)\};/.exec(src);
  assert.ok(block, 'program.js has an EMERG_KIND table');
  const out: Record<string, string> = {};
  for (const m of (block[1] ?? '').matchAll(/(\w+):\s*'([^']*)'/g)) out[m[1] as string] = m[2] as string;
  assert.equal(out['evacuate'], 'Evacuate', 'the program table was read');
  return out;
}

// ---- how each page hears about it ------------------------------------------------

/** The screens on the desk's socket: a state frame is the whole story. */
const SOCKET_SCREENS = ['side', 'trivia', 'arcade'] as const;
/** The phone pages, which read /api/state on a poll of their own. */
const POLLED_PAGES = ['next', 'gp', 'quiz'] as const;
/** Every page this file drives. */
const DRIVEN: readonly string[] = [...SOCKET_SCREENS, ...POLLED_PAGES];

/** Puts `e` on the desk and lets the page find out the way it really would. */
async function raise(p: Page, name: string, e: Emergency | null): Promise<void> {
  if ((SOCKET_SCREENS as readonly string[]).includes(name)) {
    p.desk.push(frame({ emergency: e }));
    await flush();
  } else {
    p.net.state = frame({ emergency: e });
    // One poll, whatever its period, as long as it is under ten seconds:
    // longer than that and a phone is still showing the schedule while the
    // building empties.
    await p.advance(10_000);
  }
}

// ---- every screen the crowd reads ----------------------------------------------

/** Open surfaces that are not an audience screen, and why none of them paints it. */
const NOT_A_SCREEN_THE_CROWD_READS: Record<string, string> = {
  watch: 'a kiosk wrapper: every screen it frames draws the message itself (checked below)',
  tele: 'the telestrator render: it draws strokes over the program feed, never text',
  testcard: 'a test pattern with no state',
  awards: 'the Judge Advisor sign-in shell, not an audience screen',
  setup: 'the settings sign-in shell, not an audience screen',
};

test('every open audience surface is one this file drives, or the program overlay', () => {
  // program.js is a thousand lines of video, canvas and replay plumbing, so it
  // is not driven here; its plate and label table are read from the source.
  const program = readFileSync(join(SURFACES, 'program', 'program.js'), 'utf8');
  assert.match(program, /paintEmergency\(state\.emergency\)/, 'the program overlay paints the plate');

  const unaccounted = [...OPEN_SURFACES].filter(name =>
    !DRIVEN.includes(name) && name !== 'program' && !(name in NOT_A_SCREEN_THE_CROWD_READS));
  assert.deepEqual(unaccounted, [], `open surfaces nobody checks for the safety message: ${unaccounted.join(', ')}`);
  for (const name of DRIVEN) assert.ok(OPEN_SURFACES.has(name), `${name} is still an open surface`);
});

test('every screen /s/watch can put on a crowd monitor draws the safety message itself', () => {
  // The kiosk frames one page over a black stage. A framed page that hides
  // itself instead of drawing the plate leaves that monitor black for the
  // whole of an evacuation, which is what the trivia monitor used to do.
  const block = /const PIT_SCREENS = \[([\s\S]*?)\];/.exec(pageHtml('watch'));
  assert.ok(block, 'watch has its PIT_SCREENS table');
  const ids = [...(block[1] ?? '').matchAll(/id: '(\w+)'/g)].map(m => m[1] as string);
  assert.ok(ids.length >= 5, `the kiosk's screens were read (${ids.join(', ')})`);
  for (const id of ids) {
    assert.ok(DRIVEN.includes(id) || id === 'program', `/s/watch?screen=${id} is driven by this file`);
  }
});

for (const name of DRIVEN) {
  test(`${name}: the safety message goes up with the program overlay's words, and comes down on a clear`, async () => {
    const p = await boot(name);
    const plate = p.$('emerg');
    assert.equal(plate.hidden, true, 'nothing is up before the desk raises it');

    await raise(p, name, EVACUATE);
    assert.equal(plate.hidden, false, 'raised');
    assert.equal(p.$('emergKind').textContent, 'Evacuate');
    assert.equal(p.$('emergMsg').textContent, EVACUATE.message);
    assert.equal(p.$('emergDetail').textContent, EVACUATE.detail);
    assert.equal(p.$('emergDetail').hidden, false, 'the detail line is shown');

    for (const [kind, label] of Object.entries(programKinds())) {
      await raise(p, name, { kind, message: `Message for ${kind}` });
      assert.equal(p.$('emergKind').textContent, label, `${kind} reads "${label}", as on the program overlay`);
      assert.equal(p.$('emergMsg').textContent, `Message for ${kind}`);
      assert.equal(p.$('emergDetail').hidden, true, 'no detail, no empty detail line');
    }
    await raise(p, name, { kind: 'something-new', message: 'From a newer desk' });
    assert.equal(p.$('emergKind').textContent, 'Announcement', 'an unknown kind falls back the way program.js does');

    await raise(p, name, null);
    assert.equal(plate.hidden, true, 'cleared');
    assert.deepEqual(p.errors, [], 'nothing threw');
  });
}

for (const name of SOCKET_SCREENS) {
  test(`${name}: the plate covers the whole stage, and the stage itself never hides`, async () => {
    const p = await boot(name);
    // Last in the stage, so it paints over every pane, box and sweep there is.
    assert.equal(p.$('stage').lastElementChild, p.$('emerg'), 'the plate is the last thing in the stage');
    assert.ok(p.$('emerg').className.split(/\s+/).includes('emerg'), 'it is the shared full-frame .emerg plate');

    await raise(p, name, EVACUATE);
    assert.equal(p.$('emerg').hidden, false);
    // The old trivia and arcade answer: hide the whole stage, which on a
    // crowd monitor framed by /s/watch is a black screen.
    assert.equal(p.root.hasAttribute('data-emergency'), false, 'the page does not mark itself to stand down');
    assert.equal(p.$('stageWrap').hidden, false);
    const css = [...pageHtml(name).matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    assert.doesNotMatch(css, /data-emergency[^{]*\{[^}]*(visibility\s*:\s*hidden|display\s*:\s*none)/,
      'no rule hides the page while a message is up');
  });
}

for (const name of ['gp', 'quiz'] as const) {
  test(`${name}: the banner follows the desk on its own poll, and an offline phone keeps it`, async () => {
    const p = await boot(name, { state: frame({ emergency: EVACUATE }) });
    const banner = p.$('emerg');
    assert.equal(banner.hidden, false, 'the first read, as the page opens, puts it up');
    assert.equal(p.$('emergKind').textContent, 'Evacuate');

    p.net.state = frame({ emergency: null });
    await p.advance(10_000);
    assert.equal(banner.hidden, true, 'a clear reaches the phone within one poll');

    p.net.state = frame({ emergency: { kind: 'shelter', message: 'Stay inside', detail: null } });
    await p.advance(10_000);
    assert.equal(banner.hidden, false);
    assert.equal(p.$('emergKind').textContent, 'Shelter in place');

    // Off the wifi: a failed read is not a clear.
    p.net.offline = true;
    await p.advance(30_000);
    assert.equal(banner.hidden, false, 'a phone that loses the wifi keeps the message');
    p.net.offline = false;

    // A tab in somebody's pocket does not poll, and catches up when it is shown.
    p.document.hidden = true;
    p.net.state = frame({ emergency: null });
    const before = p.net.calls.filter(u => u === '/api/state').length;
    await p.advance(60_000);
    assert.equal(p.net.calls.filter(u => u === '/api/state').length, before, 'a hidden tab does not poll');
    p.document.hidden = false;
    await p.fireDocument('visibilitychange');
    assert.equal(banner.hidden, true, 'shown again, it reads the desk at once');
  });
}

// ---- the side screen ----------------------------------------------------------

test('side: paint() draws the plate before anything else in the frame can throw', async () => {
  const p = await boot('side');
  // A deck the page cannot read: everything after the plate throws.
  p.desk.push(frame({ emergency: EVACUATE, deck: { rows: null, offs: [], etas: [] } }));
  assert.equal(p.errors.length, 1, 'the premise: the rest of the frame threw');
  assert.equal(p.$('emerg').hidden, false, 'the safety message is up anyway');
  assert.equal(p.$('emergMsg').textContent, EVACUATE.message);
});

test('side: the plate outranks the timer, the QR box and the rotation', () => {
  const html = pageHtml('side');
  const css = readFileSync(join(SURFACES, '_shared', 'broadcast.css'), 'utf8');
  const z = (re: RegExp, text: string): number => Number(re.exec(text)?.[1] ?? NaN);
  const timerZ = z(/#timerOver\s*\{[^}]*z-index:\s*(\d+)/, html);
  const plateZ = z(/#emerg\s*\{[^}]*z-index:\s*(\d+)/, html);
  const sharedZ = z(/\.emerg\s*\{[^}]*z-index:\s*(\d+)/, css);
  assert.ok(timerZ > 0, 'the timer takeover has a z-index');
  assert.ok(plateZ > timerZ && sharedZ > timerZ, `the plate (${plateZ}/${sharedZ}) sits above the timer (${timerZ})`);
  assert.ok(html.indexOf('id="emerg"') > html.indexOf('id="qrBox"'), 'the plate follows the QR box in the stage');
  assert.ok(!/<section[^>]*id="emerg"/.test(html), 'it is not a rotating pane');
});

/**
 * Lays the plate out the way its flex column does: the children stacked and
 * centred in the 1080px plate, 24px apart, the message as tall as `msgHeight`
 * says for the fit step it is on. `scale` is fitStage()'s transform, which
 * getBoundingClientRect() sees and offsetTop and offsetHeight do not.
 */
function layOutPlate(p: Page, scale: number, msgHeight: (fit: string) => number): void {
  const plate = p.$('emerg');
  const msg = p.$('emergMsg');
  const STAGE = 1080;
  const GAP = 24;
  const tall = (el: El): number =>
    el === msg ? msgHeight(msg.dataset['fit'] ?? '') : el === p.$('emergKind') ? 100 : 69;
  const place = (el: El): { top: number; height: number } => {
    const shown = plate.children.filter(c => !c.hidden);
    const total = shown.reduce((sum, c) => sum + tall(c), 0) + GAP * (shown.length - 1);
    let top = (STAGE - total) / 2;
    for (const c of shown) {
      if (c === el) return { top, height: tall(c) };
      top += tall(c) + GAP;
    }
    return { top: 0, height: 0 };
  };
  const rect = (top: number, height: number): Rect => ({
    top: top * scale, bottom: (top + height) * scale, left: 0, right: 1920 * scale,
    width: 1920 * scale, height: height * scale,
  });
  plate.geom = { clientHeight: () => STAGE, offsetHeight: () => STAGE, clientWidth: () => 1920, rect: () => rect(0, STAGE) };
  for (const c of plate.children) {
    c.geom = {
      offsetTop: () => Math.round(place(c).top),
      offsetHeight: () => Math.round(place(c).height),
      rect: () => rect(place(c).top, place(c).height),
    };
  }
  msg.geom = { ...msg.geom, scrollWidth: () => 1680, clientWidth: () => 1680 };
}

const step = (p: Page): string => p.$('emergMsg').dataset['fit'] ?? 'none';

for (const name of SOCKET_SCREENS) {
  test(`${name}: the plate is refit when the webfont lands, not left at the fallback's measurement`, async () => {
    // A freshly loaded TV (a power cycle, a desk restart, /s/watch reloading
    // its frame) measures the plate before Archivo has arrived. Archivo is
    // wider than the fallback, so the size that fit the fallback runs off the
    // top and bottom of the TV once the real face draws.
    const p = await boot(name, { fontsLoading: true });
    let archivo = false;
    const fallback: Record<string, number> = { none: 700, 1: 560, 2: 450, 3: 380 };
    const real: Record<string, number> = { none: 900, 1: 740, 2: 600, 3: 480 };
    layOutPlate(p, 1, fit => (archivo ? real : fallback)[fit || 'none'] ?? 380);
    await raise(p, name, EVACUATE);
    assert.equal(step(p), 'none', 'the fallback face fits at full size');

    archivo = true;
    p.fonts.finish();
    await flush();
    assert.equal(step(p), '1', 'refit for the face that actually drew');

    await raise(p, name, EVACUATE);
    assert.equal(step(p), '1', 'and the next identical frame keeps it');
  });

  test(`${name}: the plate fits the same way on every TV, whatever the stage scale`, async () => {
    // fitStage() scales the stage with a transform. Measured in viewport px,
    // the 48px clear of the TV's edge was 96 stage px in a 960x540 window and
    // 24 on a 4K TV, so the same message took a different size, and on the
    // big TV crowded the edge that overscan crops.
    const heights: Record<string, number> = { none: 900, 1: 803, 2: 703, 3: 480 };
    for (const scale of [0.5, 1, 2]) {
      const p = await boot(name);
      layOutPlate(p, scale, fit => heights[fit || 'none'] ?? 480);
      await raise(p, name, EVACUATE);
      assert.equal(step(p), '2', `at scale ${scale}: the first step that clears 48 stage px`);
    }
  });
}

// ---- the field's break card ----------------------------------------------------

const AWARDS_BREAK = { kind: 'custom', message: 'Awards Break', backAt: WALL + 15 * 60_000, auto: true };
const MIDDOT = String.fromCharCode(0xb7);

test('side: a break card stops promising a time that has already gone by', async () => {
  // The arena stamps backAt from the break's scheduled length, and an awards
  // ceremony routinely runs over it. "Back ~2:15" at 2:30 reads as a screen
  // that has frozen.
  const p = await boot('side');
  p.desk.push(frame({ status: AWARDS_BREAK }));
  assert.match(p.$('deckSub').textContent, new RegExp(`^Awards Break ${MIDDOT} back ~\\d`), 'a time while it is ahead');

  // No new frame: a quiet desk sends nothing while everyone waits.
  await p.advance(16 * 60_000);
  assert.equal(p.$('deckSub').textContent, `Awards Break ${MIDDOT} back soon`);

  p.desk.push(frame({ status: { ...AWARDS_BREAK, message: 'Field timeout', backAt: null } }));
  assert.equal(p.$('deckSub').textContent, 'Field timeout', 'no time, no promise');
});

test('next: a break card stops promising a time that has already gone by', async () => {
  const p = await boot('next', { state: frame({ status: AWARDS_BREAK }) });
  assert.match(p.$('now').textContent, new RegExp(`^Awards Break ${MIDDOT} back ~\\d`));
  await p.advance(16 * 60_000);
  assert.equal(p.$('now').textContent, `Awards Break ${MIDDOT} back soon`);
});

test("next: the break card turns over on the desk's clock, not the pit monitor's", async () => {
  // The page's own clock is ten minutes behind the desk. Five minutes in, the
  // desk is past the break's end even though the page's clock is not.
  const p = await boot('next', { state: frame({ status: AWARDS_BREAK }) });
  p.net.deskAhead = 10 * 60_000;
  await p.advance(6 * 60_000);
  assert.equal(p.$('now').textContent, `Awards Break ${MIDDOT} back soon`);
});
