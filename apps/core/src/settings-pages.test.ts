/**
 * The Event settings page's codes, connections and restart, and the Judge
 * Advisor's "Change the awards code", driven for real.
 *
 * These are the settings a first-time volunteer used to need config.json, a
 * launcher flag or a 43-page PDF for. surfaces/setup/index.html and
 * surfaces/awards/index.html are parsed into a small stand-in document and
 * their own module scripts run on top, as served, against a fake fetch that
 * answers the way the desk does (including the way an OLDER desk answers a
 * route it does not have: a plain-text 404). So "the boxes are empty while
 * the code is on its way" below is the shipped script emptying the shipped
 * boxes, read from inside the request itself.
 *
 * The document is deliberately small (the desk console test has the fuller
 * one): it knows the selectors and tree operations these two pages use, and
 * a selector it cannot read never matches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Awards } from './awards.ts';
import { EventBus } from './bus.ts';
import { DEFAULTS } from './config.ts';
import { EventContent } from './content.ts';
import { MediaLibrary } from './media.ts';
import { startServer } from './server.ts';

const SURFACES = fileURLToPath(new URL('../../../surfaces/', import.meta.url));

// ---- a small document ----------------------------------------------------------

interface Ev { type: string; target: El; defaultPrevented: boolean; preventDefault(): void }
type Listener = (e: Ev) => void;

const kebab = (k: string): string => k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);

let activeDoc: { activeElement: El | null } = { activeElement: null };
/** Which elements the page scrolled into view, in order. */
let scrolledTo: string[] = [];

class Txt {
  parentNode: El | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent(): string { return this.data; }
  remove(): void {
    const p = this.parentNode;
    if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; }
  }
}

class El {
  [prop: string]: unknown;
  parentNode: El | null = null;
  readonly localName: string;
  readonly attrs = new Map<string, string>();
  childNodes: (El | Txt)[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string | undefined>;
  readonly style: Record<string, string> = {};
  #value: string | null = null;
  #selected: boolean | null = null;

  constructor(name: string) {
    this.localName = name.toLowerCase();
    const attrs = this.attrs;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k) => (typeof k === 'string' ? attrs.get(`data-${kebab(k)}`) : undefined),
      set: (_t, k, v) => { attrs.set(`data-${kebab(String(k))}`, String(v)); return true; },
    });
  }

  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: unknown): void { this.attrs.set(n, String(v)); }
  removeAttribute(n: string): void { this.attrs.delete(n); }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  #flag(n: string, v: unknown): void { if (v) this.attrs.set(n, ''); else this.attrs.delete(n); }
  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }
  get className(): string { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', v); }
  get type(): string { return this.attrs.get('type') ?? ''; }
  set type(v: string) { this.attrs.set('type', v); }
  get hidden(): boolean { return this.attrs.has('hidden'); }
  set hidden(v: boolean) { this.#flag('hidden', v); }
  get disabled(): boolean { return this.attrs.has('disabled'); }
  set disabled(v: boolean) { this.#flag('disabled', v); }
  get selected(): boolean { return this.#selected ?? this.attrs.has('selected'); }
  set selected(v: boolean) { this.#selected = !!v; }
  get value(): string {
    if (this.localName === 'select') return this.selectedOptions[0]?.value ?? '';
    if (this.localName === 'option') return this.attrs.get('value') ?? this.textContent;
    if (this.#value !== null) return this.#value;
    return this.localName === 'textarea' ? this.textContent : (this.attrs.get('value') ?? '');
  }
  set value(v: string) {
    if (this.localName === 'select') {
      for (const o of this.options) o.selected = o.value === String(v);
    } else if (this.localName === 'option') this.attrs.set('value', String(v));
    else this.#value = String(v);
  }
  get options(): El[] { return this.querySelectorAll('option'); }
  get selectedOptions(): El[] {
    const all = this.options;
    const picked = all.filter(o => o.selected);
    return picked.length ? picked.slice(0, 1) : all.slice(0, 1);
  }
  get classList() {
    const read = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => read().includes(c),
      add: (...cs: string[]) => { this.className = [...new Set([...read(), ...cs])].join(' '); },
      remove: (...cs: string[]) => { this.className = read().filter(c => !cs.includes(c)).join(' '); },
    };
  }

  get children(): El[] { return this.childNodes.filter((n): n is El => n instanceof El); }
  get textContent(): string { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v: string) { this.replaceChildren(...(String(v) ? [String(v)] : [])); }
  set innerHTML(html: string) { this.replaceChildren(); parseInto(this, String(html)); }
  get innerHTML(): string { return this.textContent; }
  #adopt(nodes: (El | Txt | string)[]): (El | Txt)[] {
    return nodes.map(n => {
      const node = typeof n === 'string' ? new Txt(n) : n;
      node.remove();
      node.parentNode = this;
      return node;
    });
  }
  append(...nodes: (El | Txt | string)[]): void { this.childNodes.push(...this.#adopt(nodes)); }
  appendChild<T extends El | Txt>(node: T): T { this.append(node); return node; }
  prepend(...nodes: (El | Txt | string)[]): void { this.childNodes.unshift(...this.#adopt(nodes)); }
  replaceChildren(...nodes: (El | Txt | string)[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    const p = this.parentNode;
    if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; }
  }
  contains(node: El): boolean {
    for (let n: El | null = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  descendants(): El[] {
    const out: El[] = [];
    const walk = (e: El): void => { for (const c of e.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(sel: string): boolean { return parseList(sel).some(cx => matchComplex(this, cx)); }
  querySelectorAll(sel: string): El[] {
    const list = parseList(sel);
    return this.descendants().filter(e => list.some(cx => matchComplex(e, cx)));
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): El | null {
    for (let n: El | null = this; n; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  /** Run this element's listeners and its on<type> property; true when nobody prevented it. */
  dispatch(type: string): boolean {
    const ev: Ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    const on = this[`on${type}`];
    if (typeof on === 'function') on.call(this, ev);
    return !ev.defaultPrevented;
  }
  focus(): void { activeDoc.activeElement = this; }
  blur(): void {}
  scrollIntoView(): void { scrolledTo.push(this.id); }
  /** A real click: nothing on a disabled control, and a submit button submits its form. */
  click(): void {
    if (this.disabled) return;
    if (!this.dispatch('click')) return;
    const submits = this.localName === 'button' && (this.type === '' || this.type === 'submit');
    if (submits) this.closest('form')?.dispatch('submit');
  }
}

// ---- markup ----------------------------------------------------------------------

const VOID = new Set(['br', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr', 'path', 'line']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string): string => s.replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
  (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : ENTITY[e.toLowerCase()] ?? m));

function parseInto(parent: El, html: string): void {
  const stack: El[] = [parent];
  const top = (): El => stack[stack.length - 1]!;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
    } else if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1;
    } else if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const name = html.slice(i + 2, end).trim().toLowerCase();
      i = end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.localName === name) { stack.length = k; break; }
      }
    } else if (html[i] === '<' && /[a-z]/i.test(html[i + 1] ?? '')) {
      let j = i + 1;
      while (j < html.length && !/[\s/>]/.test(html[j]!)) j++;
      const el = new El(html.slice(i + 1, j));
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(html[j] ?? '')) j++;
        if (html[j] === '>') { j++; break; }
        if (html.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
        let k = j;
        while (k < html.length && !/[\s=/>]/.test(html[k]!)) k++;
        const name = html.slice(j, k).toLowerCase();
        j = k;
        let value = '';
        if (html[j] === '=') {
          j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end);
            j = end + 1;
          } else {
            let e = j;
            while (e < html.length && !/[\s>]/.test(html[e]!)) e++;
            value = html.slice(j, e);
            j = e;
          }
        }
        if (name) el.attrs.set(name, decode(value));
        else j++;
      }
      top().append(el);
      i = j;
      if (RAW.has(el.localName)) {
        const close = html.toLowerCase().indexOf(`</${el.localName}`, i);
        const text = html.slice(i, close < 0 ? html.length : close);
        if (text) el.append(el.localName === 'script' || el.localName === 'style' ? text : decode(text));
        i = close < 0 ? html.length : html.indexOf('>', close) + 1;
      } else if (!VOID.has(el.localName) && !selfClosing) {
        stack.push(el);
      }
    } else {
      let end = html.indexOf('<', i + 1);
      if (end < 0) end = html.length;
      top().append(decode(html.slice(i, end)));
      i = end;
    }
  }
}

// ---- selectors: tags, #id, .class, [attr], [attr="v"], :not(), :disabled, ' ' and '>' ----

interface Compound {
  tag: string | null; ids: string[]; classes: string[];
  attrs: { name: string; value: string | null }[]; nots: Compound[]; disabled: boolean; never: boolean;
}
interface Complex { parts: Compound[]; combs: string[] }

function parseCompound(s: string): Compound {
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], nots: [], disabled: false, never: false };
  let i = 0;
  const ident = (): string => {
    const m = /^[-\w]+/.exec(s.slice(i));
    i += m ? m[0].length : 0;
    return m ? m[0] : '';
  };
  if (/[a-z]/i.test(s[0] ?? '')) c.tag = ident().toLowerCase();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { i++; c.ids.push(ident()); }
    else if (ch === '.') { i++; c.classes.push(ident()); }
    else if (ch === '[') {
      const end = s.indexOf(']', i);
      const m = /^([-\w]+)(?:="([^"]*)")?$/.exec(s.slice(i + 1, end));
      if (m) c.attrs.push({ name: m[1]!, value: m[2] ?? null }); else c.never = true;
      i = end + 1;
    } else if (s.startsWith(':not(', i)) {
      const end = s.indexOf(')', i);
      c.nots.push(parseCompound(s.slice(i + 5, end)));
      i = end + 1;
    } else if (s.startsWith(':disabled', i)) { c.disabled = true; i += 9; }
    else { c.never = true; break; }
  }
  return c;
}

function parseList(sel: string): Complex[] {
  return sel.split(',').map(part => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const parts: Compound[] = [];
    const combs: string[] = [];
    let comb = ' ';
    for (const t of tokens) {
      if (t === '>') { comb = '>'; continue; }
      if (parts.length) combs.push(comb);
      parts.push(parseCompound(t));
      comb = ' ';
    }
    return { parts, combs };
  });
}

function matchCompound(el: El, c: Compound): boolean {
  if (c.never) return false;
  if (c.tag && el.localName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  const cls = el.className.split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const a of c.attrs) {
    const v = el.attrs.get(a.name);
    if (v === undefined || (a.value !== null && v !== a.value)) return false;
  }
  if (c.disabled && !el.disabled) return false;
  for (const n of c.nots) if (matchCompound(el, n)) return false;
  return true;
}

function matchFrom(el: El, cx: Complex, k: number): boolean {
  if (!matchCompound(el, cx.parts[k]!)) return false;
  if (k === 0) return true;
  if (cx.combs[k - 1] === '>') return !!el.parentNode && matchFrom(el.parentNode, cx, k - 1);
  for (let p = el.parentNode; p; p = p.parentNode) if (matchFrom(p, cx, k - 1)) return true;
  return false;
}
const matchComplex = (el: El, cx: Complex): boolean => !!cx.parts.length && matchFrom(el, cx, cx.parts.length - 1);

// ---- the desk, as fetch sees it --------------------------------------------------

interface Call { method: string; url: string; body: unknown }
interface Answer { status: number; json?: unknown; text?: string }
type Route = Answer | ((call: Call) => Answer | Promise<Answer>);

const realSetTimeout = globalThis.setTimeout;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
};

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/*
 * Once for the file. Timers: the pages' own timeouts (the awards page locks
 * itself after ten minutes) run for real but never hold this process open;
 * intervals are kept, not run, and a test runs one by calling tick().
 */
let intervals: (() => void)[] = [];
setGlobal('setTimeout', (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const t = realSetTimeout(() => fn(...rest), ms);
  if ((ms ?? 0) > 0) t.unref();
  return t;
});
setGlobal('setInterval', (fn: () => void) => { intervals.push(fn); return intervals.length; });
setGlobal('window', globalThis);
setGlobal('requestAnimationFrame', () => 0);

interface Page {
  el: (id: string) => El;
  has: (id: string) => boolean;
  /** Drawn: neither it nor anything around it is hidden. */
  shown: (el: El) => boolean;
  /** The words a person can read in `el`: hidden parts left out, spaces collapsed. */
  said: (el: El) => string;
  calls: Call[];
  /** Calls other than the reads the page makes by itself. */
  posts: () => Call[];
  confirms: string[];
  confirmAnswer: { yes: boolean };
  /** Every touch of browser storage and of the address, which no code may reach. */
  storage: string[];
  address: string[];
  routes: Record<string, Route>;
  fill: (values: Record<string, string>) => void;
  click: (id: string) => Promise<void>;
  /** Run the page's own intervals once (the settings refresh, the awards session check). */
  tick: () => Promise<void>;
  /** The tab goes into the background, or comes back to the front. */
  setHidden: (hidden: boolean) => Promise<void>;
  /** Make this the page fetch and document answer for: two tablets open at once. */
  use: () => void;
}

let current: Page | null = null;

setGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
  const page = current!;
  const method = init?.method ?? 'GET';
  const call: Call = { method, url: String(url), body: init?.body === undefined ? undefined : JSON.parse(init.body) };
  page.calls.push(call);
  const route = page.routes[`${method} ${String(url)}`] ?? page.routes['*'];
  // What any desk answers for a path nothing handles: plain text, not JSON.
  const ans: Answer = route === undefined ? { status: 404, text: 'Not found' }
    : typeof route === 'function' ? await route(call) : route;
  return {
    ok: ans.status >= 200 && ans.status < 300,
    status: ans.status,
    json: async () => {
      if (ans.json === undefined) throw new SyntaxError('Unexpected token N in JSON');
      return structuredClone(ans.json);
    },
    text: async () => ans.text ?? JSON.stringify(ans.json),
  };
});

/** One surface's page, loaded fresh, with its module script run as served. */
async function openPage(surface: 'setup' | 'awards', routes: Record<string, Route>,
  opts: { hash?: string; port?: string } = {}): Promise<Page> {
  const html = readFileSync(join(SURFACES, surface, 'index.html'), 'utf8');
  const docRoot = new El('#document');
  parseInto(docRoot, html);
  const root = docRoot.querySelector('html')!;
  const body = root.querySelector('body')!;
  const docListeners = new Map<string, (() => void)[]>();
  const doc = {
    documentElement: root, body, activeElement: body as El | null, hidden: false as boolean,
    getElementById: (id: string) => root.descendants().find(e => e.id === id) ?? null,
    querySelector: (sel: string) => root.querySelector(sel),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    createTextNode: (text: string) => new Txt(text),
    addEventListener(type: string, fn: () => void) {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
  };
  activeDoc = doc;
  setGlobal('document', doc);

  const storage: string[] = [];
  const address: string[] = [];
  setGlobal('localStorage', {
    getItem: (k: string) => { storage.push(`get ${k}`); return null; },
    setItem: (k: string, v: string) => { storage.push(`set ${k}=${v}`); },
    removeItem: (k: string) => { storage.push(`remove ${k}`); },
  });
  setGlobal('sessionStorage', globalThis.localStorage);
  const port = opts.port ?? '';
  setGlobal('location', {
    pathname: `/s/${surface}`, search: '', hash: opts.hash ?? '', protocol: 'http:', port,
    host: port ? `desk.test:${port}` : 'desk.test', hostname: 'desk.test',
    href: `http://desk.test${port ? `:${port}` : ''}/s/${surface}`,
    replace: (to: string) => { address.push(`replace ${to}`); },
    assign: (to: string) => { address.push(`assign ${to}`); },
    reload: () => { address.push('reload'); },
  });
  setGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: unknown) => { address.push(`replaceState ${String(url)}`); },
    pushState: (_s: unknown, _t: string, url: unknown) => { address.push(`pushState ${String(url)}`); },
  });
  const confirms: string[] = [];
  const confirmAnswer = { yes: true };
  setGlobal('confirm', (q: string) => { confirms.push(String(q)); return confirmAnswer.yes; });

  // This page's own intervals: registered while its script first runs, which
  // is while `intervals` points here.
  const mine: (() => void)[] = [];
  intervals = mine;
  scrolledTo = [];
  const shown = (el: El): boolean => {
    for (let n: El | null = el; n; n = n.parentNode) if (n.hidden) return false;
    return true;
  };
  const words = (n: El | Txt): string => (n instanceof Txt ? n.data
    : n.hidden || n.localName === 'script' || n.localName === 'style' ? '' : n.childNodes.map(words).join(' '));
  const page: Page = {
    el: id => {
      const found = doc.getElementById(id);
      assert.ok(found, `the page has #${id}`);
      return found;
    },
    has: id => !!doc.getElementById(id),
    shown,
    said: el => (shown(el) ? words(el).replace(/\s+/g, ' ').trim() : ''),
    calls: [],
    posts: () => page.calls.filter(c => c.method !== 'GET'),
    confirms, confirmAnswer, storage, address, routes,
    fill: values => { for (const [id, v] of Object.entries(values)) page.el(id).value = v; },
    click: async id => { page.use(); page.el(id).click(); await settle(); },
    tick: async () => { page.use(); for (const fn of mine) fn(); await settle(); },
    setHidden: async hidden => {
      page.use();
      doc.hidden = hidden;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn();
      await settle();
    },
    use: () => { current = page; activeDoc = doc; setGlobal('document', doc); },
  };
  current = page;

  // The page's module script, with its server paths pointed at the files behind them.
  const script = root.querySelectorAll('script').find(s => s.getAttribute('type') === 'module');
  assert.ok(script, `${surface} has its module script`);
  const local = script.textContent.replace(/from '\/shared\/([\w.-]+)'/g, (_m, file: string) =>
    `from '${pathToFileURL(join(SURFACES, '_shared', file)).href}'`);
  assert.doesNotMatch(local, /from '\//, 'every server path in the script was pointed at a file');
  const dir = await mkdtemp(join(tmpdir(), `cg-${surface}-page-`));
  const file = join(dir, 'page.mjs');
  await writeFile(file, local);
  try {
    await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await settle();
  return page;
}

// ---- what the desk says --------------------------------------------------------

const SETUP_BODY = {
  event: { name: 'CalGames', year: 2026, key: '2026cacg', resultsUrl: '' },
  game: { rpEnergizedFuel: 100, rpSuperchargedFuel: 360, rpTraversalTower: 50 },
  kiosk: { fieldStreamUrl: '' }, stream: { webcastUrl: '' },
  sponsors: { list: [] }, rundown: { segments: [] },
  accessibility: { services: [], ask: '' }, overridden: [],
};

const ATEM_UP = {
  state: 'connected', host: '10.0.100.40', model: 'ATEM Constellation 4 M/E 4K',
  videoMode: { id: 7, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 },
  inputs: [{ id: 1, longName: 'Camera 1' }, { id: 5, longName: 'Desk graphics' }, { id: 6, longName: 'Cheesy overlay' }],
};

function settings(over: Record<string, unknown> = {}) {
  return {
    codes: { desk: { isDefault: true }, awards: { isDefault: false }, settings: { isDefault: true } },
    connections: { fieldHost: null as string | null, atemHost: '10.0.100.40', nexusKey: { set: true, hint: '9f2c' } },
    graphicsInput: 5,
    deskMachine: true,
    field: { host: '10.0.100.5', connected: true, searching: false },
    atem: ATEM_UP,
    ...over,
  };
}

/** A desk this page is already signed in to, answering GET /api/settings with `s`. */
function signedIn(s: unknown): Record<string, Route> {
  return {
    'GET /api/setup': { status: 200, json: SETUP_BODY },
    'GET /api/settings': { status: 200, json: s },
  };
}

const ids = (sel: El): string[] => sel.options.map(o => o.value);

// ---- the settings page -------------------------------------------------------------

test('the code prompt opens the page on access codes, connections and restart, with what the desk sees now', async () => {
  let authed = false;
  const p = await openPage('setup', {
    'GET /api/setup': () => (authed ? { status: 200, json: SETUP_BODY } : { status: 403, json: { error: 'locked', locked: true } }),
    'POST /api/setup/auth': () => { authed = true; return { status: 200, json: { ok: true } }; },
    'GET /api/settings': { status: 200, json: settings() },
  });
  assert.equal(p.shown(p.el('gate')), true, 'the code prompt first');
  assert.equal(p.shown(p.el('editors')), false);

  p.fill({ code: '4567' });
  await p.click('unlock');
  assert.deepEqual(p.posts(), [{ method: 'POST', url: '/api/setup/auth', body: { pin: '4567' } }]);
  assert.equal(p.el('code').value, '', 'the code box is emptied once sent');
  assert.equal(p.shown(p.el('gate')), false);

  // The new sections lead the page: they are what stands between a volunteer and doors.
  const sections = p.el('editors').children.filter(c => c.localName === 'section');
  assert.deepEqual(sections.slice(0, 3).map(s => s.id), ['codesSec', 'connSec', 'restartSec']);
  for (const id of ['codesSec', 'connSec', 'restartSec', 'codeDesk', 'codeSettings', 'codeAwards']) {
    assert.equal(p.shown(p.el(id)), true, `${id} is on the page`);
  }
  assert.equal(p.shown(p.el('codeDeskElsewhere')), false);
  assert.match(p.said(p.el('codesSec')), /signs out everyone else using the old code/);
  assert.match(p.said(p.el('codeAwards')), /belongs to the Judge Advisor\. They can change it on their own page/);

  // The desk laptop is told which codes are still the shipped ones.
  assert.equal(p.shown(p.el('codeDeskDefault')), true);
  assert.equal(p.shown(p.el('codeSettingsDefault')), true);
  assert.equal(p.shown(p.el('codeAwardsDefault')), false);

  // Every code box is a password box, and none is filled.
  for (const which of ['Desk', 'Settings', 'Awards']) {
    for (const part of ['Cur', 'New', 'Again']) {
      const box = p.el(`code${which}${part}`);
      assert.equal(box.type, 'password', `code${which}${part}`);
      assert.equal(box.value, '');
    }
  }

  // What the desk sees right now, in words.
  assert.equal(p.said(p.el('connFieldNow')), 'Connected to the field at 10.0.100.5.');
  assert.equal(p.el('connFieldNow').dataset['level'], 'ok');
  assert.equal(p.said(p.el('connAtemNow')),
    'Connected: ATEM Constellation 4 M/E 4K at 10.0.100.40, running 1080p59.94.');
  assert.equal(p.el('connField').value, '', 'no field address typed: the desk finds it');
  assert.equal(p.el('connAtem').value, '10.0.100.40');

  // The graphics input: the switcher's own names, blank for none, the saved one picked.
  const sel = p.el('connInput');
  assert.deepEqual(ids(sel), ['', '1', '5', '6']);
  assert.equal(sel.value, '5');
  assert.equal(sel.options[2]!.textContent, 'Desk graphics (input 5)');
  assert.equal(sel.options[0]!.textContent, 'None, or not sure');

  // The Nexus key: whether one is set and its last characters, never the key.
  assert.equal(p.el('connNexus').type, 'password');
  assert.equal(p.el('connNexus').value, '');
  assert.match(p.said(p.el('connNexusNow')), /A key is set \(it ends in 9f2c\)/);
  assert.equal(p.shown(p.el('connNexusClear')), true);
});

test('"Change the codes" from the front page lands on the codes once the page opens', async () => {
  let authed = false;
  const routes: Record<string, Route> = {
    'GET /api/setup': () => (authed ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
    'POST /api/setup/auth': () => { authed = true; return { status: 200, json: { ok: true } }; },
    'GET /api/settings': { status: 200, json: settings() },
  };
  for (const [hash, id] of [['#codes', 'codesSec'], ['#connections', 'connSec'], ['#restart', 'restartSec']]) {
    authed = false;
    const p = await openPage('setup', routes, { hash });
    assert.deepEqual(scrolledTo, [], 'nothing to land on behind the code prompt');
    p.fill({ code: '4567' });
    await p.click('unlock');
    assert.deepEqual(scrolledTo, [id], hash);
  }
  // Any other mark, or none, leaves the page at its top.
  authed = false;
  const q = await openPage('setup', routes, { hash: '#constructor' });
  q.fill({ code: '4567' });
  await q.click('unlock');
  assert.deepEqual(scrolledTo, []);
});

test('on any other computer: no desk PIN form, no restart, and no word about which codes are defaults', async () => {
  // Every flag up, as a desk that forgot to hold them back would send them:
  // the page keeps the rule itself.
  const all = { desk: { isDefault: true }, awards: { isDefault: true }, settings: { isDefault: true } };
  const p = await openPage('setup', signedIn(settings({ deskMachine: false, codes: all })), { port: '8080' });
  assert.equal(p.shown(p.el('codesSec')), true);
  assert.equal(p.shown(p.el('codeDesk')), false, 'the desk PIN changes only on the desk laptop');
  // A volunteer AT the desk laptop by its network address is told the exact
  // address that counts as the desk laptop, as a link, never just "there".
  assert.equal(p.said(p.el('codeDeskElsewhere')),
    'The desk PIN changes only on the desk laptop itself. If this is the desk laptop, open '
    + 'http://localhost:8080/s/setup in its browser: the desk knows it is the desk laptop '
    + 'only by that address. It asks for the settings code again.');
  const link = p.el('codeDeskElsewhere').querySelector('a')!;
  assert.equal(link.href, 'http://localhost:8080/s/setup');
  assert.equal(p.shown(p.el('codeSettings')), true);
  assert.equal(p.shown(p.el('codeAwards')), true);
  // A shipped-default code is a door anyone on the venue Wi-Fi can open.
  for (const id of ['codeDeskDefault', 'codeAwardsDefault']) {
    assert.equal(p.shown(p.el(id)), false, id);
  }
  // Except this page's own: whoever reads it already holds the settings code.
  assert.equal(p.shown(p.el('codeSettingsDefault')), true);
  // Restart only from the desk laptop: the section says where, with no button.
  assert.equal(p.shown(p.el('restartSec')), true);
  assert.equal(p.shown(p.el('restartGo')), false, 'restart only from the desk laptop');
  assert.equal(p.said(p.el('restartElsewhere')),
    'Restarting is done only on the desk laptop itself. If this is the desk laptop, open '
    + 'http://localhost:8080/s/setup in its browser and the button is there. It asks for the '
    + 'settings code again.');
  // The refresh repaints these lines every five seconds: the link is the same node after.
  await p.tick();
  assert.equal(p.el('codeDeskElsewhere').querySelector('a'), link, 'not rebuilt under the pointer');

  // A change that waits for a restart names the same address.
  p.routes['POST /api/settings/connections'] = { status: 200, json: { ok: true, restartNeeded: ['fieldHost'] } };
  p.fill({ connField: '10.0.100.6' });
  await p.click('connSave');
  assert.equal(p.said(p.el('connMsg')), 'Saved. The field address takes effect the next time the desk '
    + 'starts. Restart the desk between matches, from http://localhost:8080/s/setup on the desk laptop.');

  // A desk on the default web port: no port in the address.
  const q = await openPage('setup', signedIn(settings({ deskMachine: false })));
  assert.match(q.said(q.el('codeDeskElsewhere')), /open http:\/\/localhost\/s\/setup in its browser/);

  // And on the desk laptop by localhost: the button, and no "elsewhere" line.
  const r = await openPage('setup', signedIn(settings()), { port: '8080' });
  assert.equal(r.shown(r.el('restartGo')), true);
  assert.equal(r.shown(r.el('restartElsewhere')), false);
  assert.equal(r.shown(r.el('codeDeskElsewhere')), false);
});

test('changing the settings code: one POST body, the boxes empty while it travels, and the page says where it stands', async () => {
  // Both answers a desk can give: it keeps this page's session (the person
  // here proved both codes), or it signs out everyone on the old code.
  for (const keepsThisPage of [true, false]) {
    let open = true;
    let seenWhileSending: string[] = [];
    const p = await openPage('setup', {
      'GET /api/setup': () => (open ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
      'GET /api/settings': { status: 200, json: settings() },
      'POST /api/settings/code': () => {
        seenWhileSending = ['codeSettingsCur', 'codeSettingsNew', 'codeSettingsAgain'].map(id => p.el(id).value);
        open = keepsThisPage;
        return { status: 200, json: { ok: true } };
      },
    });
    p.fill({ codeSettingsCur: '4567', codeSettingsNew: '8642', codeSettingsAgain: '8642' });
    await p.click('codeSettingsGo');
    assert.deepEqual(p.posts(), [{
      method: 'POST', url: '/api/settings/code', body: { which: 'settings', current: '4567', next: '8642' },
    }]);
    assert.deepEqual(seenWhileSending, ['', '', ''], 'out of the boxes the moment it is sent');
    if (keepsThisPage) {
      assert.equal(p.shown(p.el('editors')), true);
      assert.equal(p.said(p.el('codeSettingsMsg')),
        'Changed. Every other page using the old settings code was signed out. This one stays open.');
    } else {
      assert.equal(p.shown(p.el('gate')), true, 'never a page that only looks open');
      assert.equal(p.shown(p.el('editors')), false);
      assert.match(p.said(p.el('gateNote')), /Settings code changed\. .*type the new code to come back in/);
    }
  }
});

test('the desk PIN: a wrong current PIN is said plainly, a right one is confirmed, and the default line goes', async () => {
  let answer: Answer = { status: 401, json: { error: 'That is not the current desk PIN.' } };
  let s = settings();
  const p = await openPage('setup', {
    'GET /api/setup': { status: 200, json: SETUP_BODY },
    'GET /api/settings': () => ({ status: 200, json: s }),
    'POST /api/settings/code': () => answer,
  });
  assert.equal(p.shown(p.el('codeDeskDefault')), true);

  p.fill({ codeDeskCur: '1111', codeDeskNew: '2468', codeDeskAgain: '2468' });
  await p.click('codeDeskGo');
  assert.deepEqual(p.posts().at(-1)!.body, { which: 'desk', current: '1111', next: '2468' });
  assert.equal(p.said(p.el('codeDeskMsg')), 'That is not the current desk PIN.');
  assert.match(p.el('codeDeskMsg').className, /\berr\b/);
  for (const id of ['codeDeskCur', 'codeDeskNew', 'codeDeskAgain']) assert.equal(p.el(id).value, '', id);
  assert.equal(p.shown(p.el('editors')), true, 'still signed in: only the code was wrong');

  answer = { status: 200, json: { ok: true } };
  s = settings({ codes: { desk: { isDefault: false }, awards: { isDefault: false }, settings: { isDefault: true } } });
  p.fill({ codeDeskCur: '1234', codeDeskNew: '2468', codeDeskAgain: '2468' });
  await p.click('codeDeskGo');
  assert.match(p.said(p.el('codeDeskMsg')), /^Changed\. Every console signed in with the old PIN asks for the new one now\. Write it on the whiteboard\.$/);
  assert.equal(p.shown(p.el('codeDeskDefault')), false, 're-read: no longer the shipped PIN');
  assert.equal(p.shown(p.el('editors')), true);
});

test('codes are checked on the page before anything is sent', async () => {
  const p = await openPage('setup', signedIn(settings()));
  const tries: [Record<string, string>, RegExp][] = [
    [{ codeDeskCur: '', codeDeskNew: '2468', codeDeskAgain: '2468' }, /^Type the current desk PIN first\.$/],
    [{ codeDeskCur: '1234', codeDeskNew: '24a8', codeDeskAgain: '24a8' }, /has to be 4 to 8 digits, numbers only/],
    [{ codeDeskCur: '1234', codeDeskNew: '246', codeDeskAgain: '246' }, /has to be 4 to 8 digits/],
    [{ codeDeskCur: '1234', codeDeskNew: '123456789', codeDeskAgain: '123456789' }, /has to be 4 to 8 digits/],
    [{ codeDeskCur: '1234', codeDeskNew: '2468', codeDeskAgain: '2469' }, /^The two new boxes did not match/],
    [{ codeDeskCur: '1234', codeDeskNew: '1234', codeDeskAgain: '1234' }, /That is the desk PIN already/],
  ];
  for (const [values, said] of tries) {
    p.fill(values);
    await p.click('codeDeskGo');
    assert.match(p.said(p.el('codeDeskMsg')), said, JSON.stringify(values));
    if (values['codeDeskCur']) {
      assert.equal(p.el('codeDeskNew').value, '', 'a bad new code is cleared to be typed again');
      assert.equal(p.el('codeDeskAgain').value, '');
    }
  }
  assert.deepEqual(p.posts(), [], 'nothing reached the desk');
});

test('the awards code from this page goes through the Judge Advisor\'s own door, and closes it after', async () => {
  let codeAnswer: Answer = { status: 200, json: { ok: true } };
  let authAnswer: Answer = { status: 200, json: { ok: true } };
  const p = await openPage('setup', {
    ...signedIn(settings()),
    'POST /api/awards/auth': () => authAnswer,
    'POST /api/awards/code': () => codeAnswer,
    'POST /api/awards/signout': { status: 200, json: { ok: true } },
  });
  p.fill({ codeAwardsCur: '1357', codeAwardsNew: '9753', codeAwardsAgain: '9753' });
  await p.click('codeAwardsGo');
  assert.deepEqual(p.posts().map(c => [c.url, c.body]), [
    ['/api/awards/auth', { pin: '1357' }],
    ['/api/awards/code', { current: '1357', next: '9753' }],
    ['/api/awards/signout', undefined],
  ], 'signed in with the current code, changed, and signed straight back out');
  assert.match(p.said(p.el('codeAwardsMsg')), /^Changed\. The Judge Advisor's page locks within half a minute and asks for the new code: tell them what it is\.$/);
  for (const id of ['codeAwardsCur', 'codeAwardsNew', 'codeAwardsAgain']) assert.equal(p.el(id).value, '', id);

  // A wrong current code stops at the door: nothing is changed and no session opened.
  p.calls.length = 0;
  authAnswer = { status: 401, json: { error: 'That code was not accepted.' } };
  p.fill({ codeAwardsCur: '0000', codeAwardsNew: '9753', codeAwardsAgain: '9753' });
  await p.click('codeAwardsGo');
  assert.deepEqual(p.posts().map(c => c.url), ['/api/awards/auth']);
  assert.equal(p.said(p.el('codeAwardsMsg')), 'That is not the current awards code. Nothing was changed.');

  // A desk without the route: says so, and still closes the session it opened.
  p.calls.length = 0;
  authAnswer = { status: 200, json: { ok: true } };
  codeAnswer = { status: 404, text: 'Not found' };
  p.fill({ codeAwardsCur: '1357', codeAwardsNew: '9753', codeAwardsAgain: '9753' });
  await p.click('codeAwardsGo');
  assert.deepEqual(p.posts().map(c => c.url), ['/api/awards/auth', '/api/awards/code', '/api/awards/signout']);
  assert.match(p.said(p.el('codeAwardsMsg')), /needs a restart before it can offer this/);
});

test('connections: only what changed is sent, a pasted link becomes an address, and the key box is write-only', async () => {
  const s = settings();
  let answer: Answer = { status: 200, json: { ok: true, restartNeeded: ['fieldHost'] } };
  let keyBoxWhileSending: string | null = null;
  const p = await openPage('setup', {
    'GET /api/setup': { status: 200, json: SETUP_BODY },
    'GET /api/settings': () => ({ status: 200, json: s }),
    'POST /api/settings/connections': call => {
      keyBoxWhileSending = p.el('connNexus').value;
      const patch = call.body as Record<string, unknown>;
      if (answer.status === 200) {
        if ('fieldHost' in patch) s.connections.fieldHost = (patch['fieldHost'] as string) || null;
        if ('graphicsInput' in patch) s.graphicsInput = patch['graphicsInput'] as number;
      }
      return answer;
    },
  });

  // Nothing typed: nothing sent.
  await p.click('connSave');
  assert.deepEqual(p.posts(), []);
  assert.match(p.said(p.el('connMsg')), /^Nothing to save/);

  // The field, pasted as the link from Cheesy's own page.
  p.fill({ connField: '  http://10.0.100.5:8080/displays/audience?displayId=1 ' });
  await p.click('connSave');
  assert.deepEqual(p.posts().at(-1)!.body, { fieldHost: '10.0.100.5:8080' },
    'the address alone, and nothing that did not change');
  assert.equal(p.el('connField').value, '10.0.100.5:8080');
  assert.equal(p.said(p.el('connMsg')), 'Saved. The field address takes effect the next time the desk starts. '
    + 'Use Restart the desk below, between matches.');
  // Connected to one field with another typed: it says which wins until the restart.
  assert.match(p.said(p.el('connFieldNow')), /^Connected to the field at 10\.0\.100\.5\. The address above takes effect the next time the desk starts\.$/);

  // The graphics input, and the key: sent, and out of its box at once.
  answer = { status: 200, json: { ok: true, restartNeeded: [] } };
  p.el('connInput').value = '6';
  p.fill({ connNexus: 'nexus-key-abcdef-1234' });
  await p.click('connSave');
  assert.deepEqual(p.posts().at(-1)!.body, { graphicsInput: 6, nexusKey: 'nexus-key-abcdef-1234' });
  assert.equal(keyBoxWhileSending, '', 'the key left its box as it was sent');
  assert.equal(p.el('connNexus').value, '');
  assert.equal(p.said(p.el('connMsg')), 'Saved. The desk uses it now.');
  assert.equal(p.el('connInput').value, '6', 'repainted from what the desk now has');

  // Back to none.
  p.el('connInput').value = '';
  await p.click('connSave');
  assert.deepEqual(p.posts().at(-1)!.body, { graphicsInput: null });

  // A typo never leaves the page.
  const before = p.posts().length;
  p.fill({ connAtem: 'switcher at the back' });
  await p.click('connSave');
  assert.equal(p.posts().length, before);
  assert.match(p.said(p.el('connMsg')), /^"switcher at the back" does not look like the switcher's address\. Type it like 10\.0\.100\.5/);
  p.fill({ connAtem: '10.0.100.40:99999' });
  await p.click('connSave');
  assert.equal(p.posts().length, before, 'no such port');
  p.fill({ connAtem: '10.0.100.40' });

  // The desk's own refusal is shown as it said it.
  answer = { status: 422, json: { error: 'That is the field\'s address, not the switcher\'s.' } };
  p.fill({ connAtem: '10.0.100.5' });
  await p.click('connSave');
  assert.equal(p.said(p.el('connMsg')), 'That is the field\'s address, not the switcher\'s.');

  // Removing the key is its own button, asked first.
  answer = { status: 200, json: { ok: true, restartNeeded: [] } };
  p.confirmAnswer.yes = false;
  await p.click('connNexusClear');
  assert.notDeepEqual(p.posts().at(-1)!.body, { nexusKey: '' }, 'a no is a no');
  p.confirmAnswer.yes = true;
  await p.click('connNexusClear');
  assert.deepEqual(p.posts().at(-1)!.body, { nexusKey: '' });
  assert.match(p.confirms.at(-1)!, /Remove the Nexus key\?/);
});

test('a desk without the new routes: each new section says to restart, and the event editors still work', async () => {
  for (const missing of [
    { status: 404, text: 'Not found' },                       // no handler for the path
    { status: 401, json: { error: 'PIN required' } },          // behind a door this session does not open
  ]) {
    let open = true;
    const p = await openPage('setup', {
      'GET /api/setup': () => (open ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
      'GET /api/settings': () => (open || missing.status === 404 ? missing : { status: 401, json: { error: 'PIN required' } }),
      'POST /api/setup': { status: 200, json: { ok: true } },
    });
    assert.equal(p.shown(p.el('editors')), true, 'the page is open');
    for (const [gone, body] of [['codesGone', 'codesBody'], ['connGone', 'connBody']] as const) {
      assert.match(p.said(p.el(gone)), /^This desk needs a restart before it can offer this here\. On the desk laptop, between matches, press Ctrl\+Shift\+Esc/);
      assert.equal(p.shown(p.el(body)), false);
    }
    assert.equal(p.shown(p.el('restartSec')), false);
    // The rest of the page carries on as before.
    assert.equal(p.el('setEvName').value, 'CalGames');
    await p.click('setEvSave');
    assert.equal(p.posts().at(-1)!.url, '/api/setup');
    assert.match(p.said(p.el('setEvMsg')), /^Saved\./);
    // And the refresh keeps asking, without breaking anything.
    await p.tick();
    assert.equal(p.shown(p.el('editors')), true);
    // Somebody restarts the desk by hand, as the line says: this page's
    // session went with the old process, and the refresh finds that out.
    open = false;
    await p.tick();
    assert.equal(p.shown(p.el('gate')), true, 'signed out, not "still missing"');
    assert.match(p.said(p.el('gateNote')), /^This page got signed out/);
  }
});

test('signed out between the two first reads: the code prompt, not a restart message', async () => {
  let reads = 0;
  const p = await openPage('setup', {
    'GET /api/setup': () => (++reads === 1 ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
    'GET /api/settings': { status: 403, json: { error: 'locked' } },
  });
  assert.equal(p.shown(p.el('gate')), true);
  assert.match(p.said(p.el('gateNote')), /^This page got signed out/);
  assert.equal(p.el('codesGone').textContent, '', 'no restart advice for a page that is only signed out');
});

test('a desk that reads the new settings but lacks a write route says restart, never "PIN required"', async () => {
  const p = await openPage('setup', {
    ...signedIn(settings()),
    // The desk PIN's generic door, for a path the settings session does not open yet.
    'POST /api/settings/code': { status: 401, json: { error: 'PIN required' } },
    'POST /api/settings/connections': { status: 404, text: 'Not found' },
    'POST /api/settings/restart': { status: 404, text: 'Not found' },
  });
  p.fill({ codeSettingsCur: '4567', codeSettingsNew: '8642', codeSettingsAgain: '8642' });
  await p.click('codeSettingsGo');
  assert.match(p.said(p.el('codeSettingsMsg')), /^This desk needs a restart before it can offer this here\./);
  assert.equal(p.shown(p.el('editors')), true, 'not mistaken for being signed out');

  p.fill({ connAtem: '10.0.100.41' });
  await p.click('connSave');
  assert.match(p.said(p.el('connMsg')), /^This desk needs a restart before it can offer this here\./);

  await p.click('restartGo');
  assert.match(p.said(p.el('restartMsg')), /^This desk needs a restart before it can offer this here\./);
});

test('restart: only on the desk laptop, asked first in plain words, and back to the code prompt after', async () => {
  let restarted = false;
  const p = await openPage('setup', {
    'GET /api/setup': () => (restarted ? { status: 403, json: { locked: true } } : { status: 200, json: SETUP_BODY }),
    'GET /api/settings': { status: 200, json: settings() },
    'POST /api/settings/restart': () => ({ status: 200, json: { ok: true } }),
  });
  p.confirmAnswer.yes = false;
  await p.click('restartGo');
  assert.deepEqual(p.posts(), [], 'asked, and a no sends nothing');
  const asked = p.confirms[0]!;
  assert.match(asked, /^Restart the desk now\?/);
  assert.match(asked, /between matches/);
  assert.match(asked, /Every screen reconnects by itself/);
  assert.match(asked, /Every console, this page included, asks for its code again/);

  p.confirmAnswer.yes = true;
  await p.click('restartGo');
  assert.deepEqual(p.posts().map(c => c.url), ['/api/settings/restart']);
  assert.match(p.said(p.el('restartMsg')), /^Restarting\. This page asks for the settings code again when the desk is back/);

  // The old desk is still on its way out: keep waiting.
  await p.tick();
  assert.equal(p.shown(p.el('editors')), true);
  // A new desk, which does not know this page's session.
  restarted = true;
  await p.tick();
  assert.equal(p.shown(p.el('gate')), true);
  assert.equal(p.said(p.el('gateNote')), 'The desk restarted. Type the settings code to open this page again.');
});

test('what the desk sees, in words: looking, lost and not used, and a refresh leaves typing alone', async () => {
  let s: Record<string, unknown> = settings({
    field: { host: null, connected: false, searching: true },
    atem: { state: 'off', host: null, model: null, videoMode: null, inputs: [] },
    graphicsInput: null,
    connections: { fieldHost: null, atemHost: null, nexusKey: { set: false, hint: null } },
  });
  const p = await openPage('setup', {
    'GET /api/setup': { status: 200, json: SETUP_BODY },
    'GET /api/settings': () => ({ status: 200, json: s }),
  });
  assert.equal(p.said(p.el('connFieldNow')), 'Looking for the field on the network by itself.');
  assert.equal(p.el('connFieldNow').dataset['level'], 'off');
  assert.equal(p.said(p.el('connAtemNow')), 'Not used on this setup.');
  assert.equal(p.el('connAtemNow').dataset['level'], 'off', 'no switcher is gray, never a fault');
  assert.deepEqual(ids(p.el('connInput')), ['']);
  assert.match(p.said(p.el('connInputNow')), /fills in from the switcher once the desk is connected/);
  assert.match(p.said(p.el('connNexusNow')), /^No key set\./);
  assert.equal(p.shown(p.el('connNexusClear')), false, 'nothing to remove');

  // Somebody starts typing; then the desk finds a switcher and loses the field.
  p.fill({ connAtem: '10.0.100.4' });
  s = settings({
    field: { host: '10.0.100.5', connected: false, searching: false },
    atem: { ...ATEM_UP, state: 'lost' },
    graphicsInput: null,
  });
  await p.tick();
  assert.match(p.said(p.el('connFieldNow')), /^Not reaching the field at 10\.0\.100\.5\. The desk keeps trying by itself\./);
  assert.equal(p.el('connFieldNow').dataset['level'], 'warn');
  assert.match(p.said(p.el('connAtemNow')), /^Lost the switcher at 10\.0\.100\.40\. The desk reconnects by itself/);
  assert.equal(p.el('connAtem').value, '10.0.100.4', 'what is being typed stays');
  assert.deepEqual(ids(p.el('connInput')), ['', '1', '5', '6'], 'the input names arrived');

  // A pick not yet saved survives the next refresh.
  p.el('connInput').value = '5';
  await p.tick();
  assert.equal(p.el('connInput').value, '5');

  // A saved input the switcher is not listing stays chosen, by number.
  const q = await openPage('setup', signedIn(settings({
    graphicsInput: 12, atem: { state: 'searching', host: null, model: null, videoMode: null, inputs: [] },
  })));
  assert.deepEqual(ids(q.el('connInput')), ['', '12']);
  assert.equal(q.el('connInput').value, '12');
  assert.equal(q.said(q.el('connAtemNow')), 'Looking for a switcher on the network by itself.');
});

test('signed out elsewhere: the refresh notices, says so, and empties every half-typed code', async () => {
  let open = true;
  const p = await openPage('setup', {
    'GET /api/setup': () => (open ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
    'GET /api/settings': () => (open ? { status: 200, json: settings() } : { status: 403, json: { error: 'locked' } }),
  });
  p.fill({ codeDeskCur: '1234', codeAwardsNew: '97', connNexus: 'half-a-key' });
  open = false;
  await p.tick();
  assert.equal(p.shown(p.el('gate')), true);
  assert.match(p.said(p.el('gateNote')), /^This page got signed out/);
  for (const id of ['codeDeskCur', 'codeAwardsNew', 'connNexus']) assert.equal(p.el(id).value, '', id);
});

test('a change refused because this page was signed out meanwhile brings the code prompt back', async () => {
  // The desk's real refusal for a settings route without a settings session.
  const LOCKED = { status: 403, json: { error: 'This is behind the settings code, which the content lead holds. '
    + 'Unlock Event settings (/s/setup) first.' } };
  for (const via of ['code', 'connections'] as const) {
    let open = true;
    const p = await openPage('setup', {
      'GET /api/setup': () => (open ? { status: 200, json: SETUP_BODY } : { status: 403, json: { locked: true } }),
      'GET /api/settings': { status: 200, json: settings() },
      // The desk restarted, or the settings code changed on another laptop,
      // between this page's last refresh and the press.
      'POST /api/settings/code': () => { open = false; return LOCKED; },
      'POST /api/settings/connections': () => { open = false; return LOCKED; },
    });
    if (via === 'code') {
      p.fill({ codeSettingsCur: '4567', codeSettingsNew: '8642', codeSettingsAgain: '8642' });
      await p.click('codeSettingsGo');
    } else {
      p.fill({ connAtem: '10.0.100.41', connNexus: 'half-a-new-key', codeDeskCur: '12' });
      await p.click('connSave');
    }
    assert.equal(p.posts().length, 1, via);
    assert.equal(p.shown(p.el('gate')), true, `${via}: the code prompt, not a dead end`);
    assert.equal(p.shown(p.el('editors')), false);
    assert.match(p.said(p.el('gateNote')), /^This page got signed out: the desk restarted or the settings code changed\./);
    for (const id of ['codeSettingsCur', 'codeDeskCur', 'connNexus']) assert.equal(p.el(id).value, '', `${via}: ${id}`);
  }

  // The same refusal while still signed in is only the refusal: the page stays open.
  const q = await openPage('setup', {
    ...signedIn(settings()),
    'POST /api/settings/connections': { status: 422, json: { error: 'That is the field\'s address, not the switcher\'s.' } },
  });
  q.fill({ connAtem: '10.0.100.5' });
  await q.click('connSave');
  assert.equal(q.shown(q.el('editors')), true);
  assert.equal(q.said(q.el('connMsg')), 'That is the field\'s address, not the switcher\'s.');
});

test('no code or key ever reaches the address bar, browser storage, a GET or a log line', async () => {
  const logged: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const p = await openPage('setup', {
      ...signedIn(settings()),
      'POST /api/settings/code': { status: 200, json: { ok: true } },
      'POST /api/awards/auth': { status: 200, json: { ok: true } },
      'POST /api/awards/code': { status: 200, json: { ok: true } },
      'POST /api/awards/signout': { status: 200, json: { ok: true } },
      'POST /api/settings/connections': { status: 200, json: { ok: true, restartNeeded: [] } },
    });
    const secrets = ['73915', '86204', '51739', 'secret-nexus-key-0042'];
    p.fill({ codeDeskCur: '73915', codeDeskNew: '86204', codeDeskAgain: '86204' });
    await p.click('codeDeskGo');
    p.fill({ codeAwardsCur: '51739', codeAwardsNew: '86205', codeAwardsAgain: '86205' });
    await p.click('codeAwardsGo');
    p.fill({ connNexus: 'secret-nexus-key-0042' });
    await p.click('connSave');
    await p.tick();

    assert.deepEqual(p.storage, [], 'the page never touches browser storage');
    assert.deepEqual(p.address, [], 'or the address');
    for (const c of p.calls) {
      assert.doesNotMatch(c.url, /[?#]/, `${c.method} ${c.url} carries nothing in its address`);
      if (c.method === 'GET') assert.equal(c.body, undefined);
    }
    for (const secret of secrets) {
      assert.ok(p.calls.some(c => c.method === 'POST' && JSON.stringify(c.body ?? null).includes(secret)), `${secret} was sent`);
      assert.ok(!logged.some(l => l.includes(secret)), `${secret} never logged`);
    }
  } finally {
    Object.assign(console, saved);
  }
});

// ---- the Judge Advisor's page -------------------------------------------------------

const AWARDS_OPEN = {
  list: [{ id: 'imagery', title: 'Imagery Award', description: 'For visual flair.', day: 'Sunday', onAir: 'For visual flair.' }],
  locked: false, separate: true,
};

test('the Judge Advisor changes the awards code: one POST body, boxes emptied, and the page says where it stands', async () => {
  for (const keepsThisPage of [true, false]) {
    let locked = false;
    let seenWhileSending: string[] = [];
    const p = await openPage('awards', {
      'GET /api/awards': () => ({ status: 200, json: { ...AWARDS_OPEN, locked } }),
      'POST /api/awards/code': () => {
        seenWhileSending = ['awCodeCur', 'awCodeNew', 'awCodeAgain'].map(id => p.el(id).value);
        locked = !keepsThisPage;
        return { status: 200, json: { ok: true } };
      },
    });
    assert.equal(p.shown(p.el('list')), true);
    const card = p.el('codeCard');
    assert.ok(p.el('list').contains(card), 'inside the list, so locking takes it away with the winners');
    // "Within half a minute", because that is what the pages on the old code
    // actually do: this one checks every twenty seconds, the desk every thirty.
    assert.match(p.said(card), /^Change the awards code Works at once\. Every other page open with the old code locks within half a minute and asks for the new one/);
    for (const id of ['awCodeCur', 'awCodeNew', 'awCodeAgain']) assert.equal(p.el(id).type, 'password', id);

    p.fill({ awCodeCur: '1357', awCodeNew: '24680', awCodeAgain: '24680' });
    await p.click('awCodeGo');
    assert.deepEqual(p.posts().map(c => [c.url, c.body]), [['/api/awards/code', { current: '1357', next: '24680' }]]);
    assert.deepEqual(seenWhileSending, ['', '', '']);
    if (keepsThisPage) {
      assert.equal(p.shown(p.el('list')), true);
      assert.equal(p.said(p.el('pageNote')),
        'Awards code changed. Every other page using the old code locks within half a minute and asks for the new one.');
      for (const id of ['awCodeCur', 'awCodeNew', 'awCodeAgain']) assert.equal(p.el(id).value, '', id);
    } else {
      assert.equal(p.shown(p.el('gate')), true, 'never a list that only looks unlocked');
      assert.equal(p.el('list').children.length, 0, 'the winners are off the screen');
      assert.match(p.said(p.el('lockNote')), /^Awards code changed\. Enter the new code to open the list again\./);
    }
    assert.deepEqual(p.storage, []);
    assert.deepEqual(p.address, []);
  }
});

test('the awards code form: checked before sending, a refusal said in the card, an older desk said plainly', async () => {
  let answer: Answer = { status: 401, json: { error: 'That is not the current awards code.' } };
  const p = await openPage('awards', {
    'GET /api/awards': { status: 200, json: AWARDS_OPEN },
    'POST /api/awards/code': () => answer,
  });
  p.fill({ awCodeCur: '1357', awCodeNew: '2468', awCodeAgain: '2486' });
  await p.click('awCodeGo');
  assert.deepEqual(p.posts(), []);
  assert.match(p.said(p.el('codeCard')), /The two new boxes did not match/);

  p.fill({ awCodeCur: '0000', awCodeNew: '2468', awCodeAgain: '2468' });
  await p.click('awCodeGo');
  assert.deepEqual(p.posts().map(c => c.url), ['/api/awards/code']);
  assert.match(p.said(p.el('codeCard')), /That is not the current awards code\./);
  assert.equal(p.shown(p.el('list')), true, 'still open: the page is signed in, only the code was wrong');
  for (const id of ['awCodeCur', 'awCodeNew', 'awCodeAgain']) assert.equal(p.el(id).value, '', id);

  answer = { status: 404, text: 'Not found' };
  p.fill({ awCodeCur: '1357', awCodeNew: '2468', awCodeAgain: '2468' });
  await p.click('awCodeGo');
  assert.match(p.said(p.el('codeCard')), /This desk needs a restart before it can change the awards code here\./);
});

test('a Judge Advisor page left open locks by itself once its session is gone, and says why', async () => {
  let locked = false;
  let down = false;
  const p = await openPage('awards', {
    'GET /api/awards': () => {
      if (down) throw new TypeError('Failed to fetch');
      return { status: 200, json: { ...AWARDS_OPEN, locked } };
    },
  });
  assert.equal(p.shown(p.el('list')), true);
  // A winner half typed when the check runs: an open session leaves it alone.
  const winner = p.el('list').querySelector('input')!;
  winner.value = 'Team 254';
  await p.tick();
  assert.equal(p.shown(p.el('list')), true);
  assert.equal(p.el('list').querySelector('input'), winner, 'the list is not repainted by a check');
  assert.equal(winner.value, 'Team 254');
  // The desk unreachable for a moment is not a sign-out.
  down = true;
  await p.tick();
  assert.equal(p.shown(p.el('list')), true, 'a blip is not a lock');
  down = false;

  // The code changed on Event settings (or the desk restarted): nobody touches the tablet.
  locked = true;
  await p.tick();
  assert.equal(p.shown(p.el('gate')), true, 'the code prompt is back with nobody touching it');
  assert.equal(p.shown(p.el('lockBar')), false);
  assert.equal(p.el('list').children.length, 0, 'every winner is off the screen, not just hidden');
  assert.equal(p.said(p.el('gateErr')), 'This page got signed out: the awards code was changed, or the '
    + 'desk restarted. Enter the code again. Winners already loaded are saved on the desk.');

  // In the background it does not ask; back in front it asks at once.
  let qLocked = false;
  const q = await openPage('awards', { 'GET /api/awards': () => ({ status: 200, json: { ...AWARDS_OPEN, locked: qLocked } }) });
  await q.setHidden(true);
  qLocked = true;
  const reads = q.calls.length;
  await q.tick();
  assert.equal(q.calls.length, reads, 'a tab in the background is not polled');
  assert.equal(q.shown(q.el('list')), true);
  await q.setHidden(false);
  assert.equal(q.shown(q.el('gate')), true, 'checked the moment it is back on screen');
  assert.match(q.said(q.el('gateErr')), /^This page got signed out: the awards code was changed, or the desk restarted\./);
});

test('a session check sent before a lock is not believed after the page was unlocked again', async () => {
  // In a holder, because a plain `let` set inside the route reads as never-set to tsc.
  const stalled: { release: (() => void) | null } = { release: null };
  let held = false;
  const p = await openPage('awards', {
    'GET /api/awards': () => {
      if (!held) return { status: 200, json: AWARDS_OPEN };
      held = false;
      return new Promise<Answer>(r => { stalled.release = () => r({ status: 200, json: { ...AWARDS_OPEN, locked: true } }); });
    },
    'POST /api/awards/signout': { status: 200, json: { ok: true } },
    'POST /api/awards/auth': { status: 200, json: { ok: true } },
  });
  // A check goes out and stalls on a slow network.
  held = true;
  await p.tick();
  assert.ok(stalled.release, 'the check is in flight');
  // Meanwhile the Judge Advisor locks the page and opens it again with the code.
  await p.click('lock');
  p.fill({ code: '1357' });
  await p.click('unlock');
  assert.equal(p.shown(p.el('list')), true);
  // The stale answer ("locked", from before) arrives now.
  stalled.release();
  await settle();
  assert.equal(p.shown(p.el('list')), true, 'the new session is not thrown away by an old answer');
});

test('a winner loaded on a session that is gone: the prompt back, the list emptied, both causes said', async () => {
  const p = await openPage('awards', {
    'GET /api/awards': { status: 200, json: AWARDS_OPEN },
    'POST /api/awards': { status: 403, json: { error: 'Awards are locked behind the Judge Advisor code.' } },
  });
  const load = p.el('list').querySelector('.btn-go')!;
  assert.equal(load.textContent, 'Load winner');
  p.el('list').querySelector('input')!.value = 'Team 254';
  load.click();
  await settle();
  assert.equal(p.shown(p.el('gate')), true);
  assert.equal(p.el('list').children.length, 0, 'no winner left behind in a hidden list');
  assert.match(p.said(p.el('gateErr')), /^This page got signed out: the awards code was changed, or the desk restarted\./);

  // Saved, and the session ends before the list is read back: the same words.
  let locked = false;
  const q = await openPage('awards', {
    'GET /api/awards': () => ({ status: 200, json: { ...AWARDS_OPEN, locked } }),
    'POST /api/awards': () => { locked = true; return { status: 200, json: { ok: true } }; },
  });
  q.el('list').querySelector('.btn-go')!.click();
  await settle();
  assert.equal(q.shown(q.el('gate')), true);
  assert.equal(q.el('list').children.length, 0);
  assert.match(q.said(q.el('gateErr')), /^This page got signed out: the awards code was changed, or the desk restarted\./);

  // Locked on the way in is only the code prompt: nothing was signed out.
  const r = await openPage('awards', { 'GET /api/awards': { status: 200, json: { ...AWARDS_OPEN, locked: true } } });
  assert.equal(r.shown(r.el('gate')), true);
  assert.equal(r.shown(r.el('gateErr')), false, 'no sign-out line on a page that was never open');
});

test('no separate awards code on this desk: no form for one', async () => {
  const p = await openPage('awards', {
    'GET /api/awards': { status: 200, json: { ...AWARDS_OPEN, separate: false } },
  });
  assert.equal(p.shown(p.el('list')), true);
  assert.equal(p.has('codeCard'), false);
});

// ---- against the real desk ----------------------------------------------------------

/** Set env vars for one test and put them back, whatever the test does. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await run(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/**
 * One browser talking to the real server: its own cookies, and the Host it
 * names the desk by. From 127.0.0.1 by `localhost` it is the desk laptop.
 */
function browserAt(port: number, host: string): (call: Call) => Promise<Answer> {
  const jar = new Map<string, string>();
  return (call: Call) => new Promise<Answer>((resolve, reject) => {
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const req = request({
      host: '127.0.0.1', port, path: call.url, method: call.method,
      headers: {
        host,
        ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
    }, res => {
      for (const line of res.headers['set-cookie'] ?? []) {
        const [pair = '', ...attrs] = line.split(';');
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (!value || attrs.some(a => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
        else jar.set(name, value);
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('the real desk: codes, connections and restart from the settings page, and the Judge Advisor\'s own change', async () => {
  await withEnv({ REMOTE_PIN: '2580', JA_PIN: '1357', SETUP_PIN: '4567' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cg-settings-real-'));
    const bus = new EventBus();
    const exits: number[] = [];
    const server = startServer({
      bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
      config: structuredClone(DEFAULTS), content: new EventContent(dir),
      awards: new Awards(dir, bus, [{ id: 'imagery', title: 'Imagery Award', description: 'For visual flair.' }]),
      restartable: true, exit: code => { exits.push(code); },
    });
    try {
      const port = await server.listening;
      const desk = browserAt(port, `localhost:${port}`);

      // The desk laptop: the code prompt, then everything.
      const p = await openPage('setup', { '*': desk });
      assert.equal(p.shown(p.el('gate')), true);
      p.fill({ code: '4567' });
      await p.click('unlock');
      assert.equal(p.shown(p.el('editors')), true, 'the settings code opens the page');
      assert.equal(p.shown(p.el('codeDesk')), true, 'the desk laptop gets the desk PIN form');
      assert.equal(p.shown(p.el('restartSec')), true);
      assert.equal(p.shown(p.el('codeSettingsDefault')), true, '4567 is the shipped settings code');
      assert.equal(p.shown(p.el('codeDeskDefault')), false, '2580 is not the shipped PIN');
      assert.equal(p.said(p.el('connFieldNow')), 'Not used on this setup.', 'no field on this test desk');
      assert.equal(p.said(p.el('connAtemNow')), 'Not used on this setup.');

      // The desk PIN.
      p.fill({ codeDeskCur: '2580', codeDeskNew: '3690', codeDeskAgain: '3690' });
      await p.click('codeDeskGo');
      assert.match(p.said(p.el('codeDeskMsg')), /^Changed\./);
      const auth = await desk({ method: 'POST', url: '/api/auth', body: { pin: '3690' } });
      assert.equal(auth.status, 200, 'the new desk PIN opens the desk');

      // The settings code: this page stays open, as the desk keeps its session.
      p.fill({ codeSettingsCur: '4567', codeSettingsNew: '8642', codeSettingsAgain: '8642' });
      await p.click('codeSettingsGo');
      assert.equal(p.said(p.el('codeSettingsMsg')),
        'Changed. Every other page using the old settings code was signed out. This one stays open.');
      await p.tick();
      assert.equal(p.shown(p.el('codeSettingsDefault')), false, 'no longer the shipped code');

      // The awards code, through the Judge Advisor's door, which is closed again after.
      p.fill({ codeAwardsCur: '1357', codeAwardsNew: '9753', codeAwardsAgain: '9753' });
      await p.click('codeAwardsGo');
      assert.match(p.said(p.el('codeAwardsMsg')), /^Changed\. The Judge Advisor's page locks/);
      const peek = await desk({ method: 'GET', url: '/api/awards', body: undefined });
      assert.equal((peek.json as { locked: boolean }).locked, true, 'this browser kept no awards session');

      // Connections: a pasted link saved as an address, and a key that is never read back.
      p.fill({ connField: 'http://10.0.100.5:8080/displays/audience', connNexus: 'nexus-0123456789abcd' });
      await p.click('connSave');
      assert.match(p.said(p.el('connMsg')), /^Saved\./);
      assert.equal(p.el('connField').value, '10.0.100.5:8080', 'repainted from what the desk stored');
      assert.match(p.said(p.el('connNexusNow')), /A key is set \(it ends in abcd\)/);
      assert.equal(p.el('connNexus').value, '');
      for (const c of p.calls.filter(x => x.method === 'GET')) assert.doesNotMatch(c.url, /\?/);

      // Restart: answered, then the process asks to be started again.
      await p.click('restartGo');
      assert.match(p.said(p.el('restartMsg')), /^Restarting\./);
      await new Promise(r => realSetTimeout(r, 600));
      assert.deepEqual(exits, [75], 'exit code 75: the launcher starts the desk again');

      // Another computer on the venue Wi-Fi, holding the new settings code. Or
      // the desk laptop itself, by its network address: the server cannot
      // tell, so the page names the address that counts.
      const other = await openPage('setup', { '*': browserAt(port, `192.168.1.20:${port}`) }, { port: String(port) });
      other.fill({ code: '8642' });
      await other.click('unlock');
      assert.equal(other.shown(other.el('editors')), true);
      assert.equal(other.shown(other.el('codeDesk')), false, 'no desk PIN form off the desk laptop');
      assert.match(other.said(other.el('codeDeskElsewhere')),
        new RegExp(`If this is the desk laptop, open http://localhost:${port}/s/setup in its browser`));
      assert.equal(other.shown(other.el('restartGo')), false);
      assert.match(other.said(other.el('restartElsewhere')), new RegExp(`open http://localhost:${port}/s/setup`));

      // Two Judge Advisor tablets on the code the content lead set: one is
      // left lying on the list, the other changes the code.
      const lying = await openPage('awards', { '*': browserAt(port, `192.168.1.31:${port}`) });
      lying.fill({ code: '9753' });
      await lying.click('unlock');
      assert.equal(lying.shown(lying.el('list')), true);
      const ja = await openPage('awards', { '*': browserAt(port, `192.168.1.30:${port}`) });
      ja.fill({ code: '9753' });
      await ja.click('unlock');
      assert.equal(ja.shown(ja.el('list')), true, 'the new awards code opens the Judge Advisor page');
      ja.fill({ awCodeCur: '9753', awCodeNew: '1470', awCodeAgain: '1470' });
      await ja.click('awCodeGo');
      assert.equal(ja.shown(ja.el('list')), true, 'the desk keeps the page of the person who changed it');
      assert.match(ja.said(ja.el('pageNote')), /^Awards code changed\./);
      // Nobody touches the other tablet: its own check finds the session gone.
      await lying.tick();
      assert.equal(lying.shown(lying.el('gate')), true, 'the tablet left on the list locked by itself');
      assert.equal(lying.el('list').children.length, 0);
      assert.match(lying.said(lying.el('gateErr')), /^This page got signed out: the awards code was changed/);
      // And the changer's own page, checked the same way, stays open.
      await ja.tick();
      assert.equal(ja.shown(ja.el('list')), true);
      const fresh = await browserAt(port, `192.168.1.40:${port}`)({ method: 'POST', url: '/api/awards/auth', body: { pin: '1470' } });
      assert.equal(fresh.status, 200, 'and the new one works for everyone else');
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
