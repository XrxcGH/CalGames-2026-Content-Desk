/**
 * The desk console's two views, Simple and Everything, and the OBS fold,
 * driven for real.
 *
 * surfaces/desk/index.html is parsed into a small stand-in document, its own
 * head script runs against a stand-in localStorage and address, and its own
 * stylesheet (with the shared tokens.css under it) decides what is on the
 * page: getComputedStyle here applies those rules, as written, to the parsed
 * markup. surfaces/desk/desk.js is then loaded on top exactly as served, with
 * its server paths pointed at the files behind them (the program overlay's
 * test does the same), fed by the real shared client over a stand-in socket
 * and desk states built by the real reducer.
 *
 * So "Simple hides the hand-scoring panel" below is the shipped stylesheet
 * hiding the shipped markup, and "the key still fires" is the shipped keydown
 * handler sending over the shipped client. Nothing here restates the rules.
 *
 * The document is deliberately small: it knows the selectors, attributes and
 * tree operations this page uses, and a selector it cannot read never
 * matches, which can only make a rule look absent, never present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventBus, type EmitInit } from './bus.ts';
import { AtemWatcher } from './atem/watcher.ts';
import type { DeskState } from './types.ts';

const SURFACES = fileURLToPath(new URL('../../../surfaces/', import.meta.url));
const THEME = fileURLToPath(new URL('../../../packages/theme/tokens.css', import.meta.url));
const PAGE = readFileSync(join(SURFACES, 'desk', 'index.html'), 'utf8');
const DESK_JS = readFileSync(join(SURFACES, 'desk', 'desk.js'), 'utf8');

// ---- a small document ----------------------------------------------------------

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
  type: string; target: El; key?: string; repeat?: boolean;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; preventDefault(): void;
}

const kebab = (k: string): string => k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
const camel = (k: string): string => k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Which document an element's focus() moves; set by each page load. */
let activeDoc: { activeElement: El | null } = { activeElement: null };

class Node0 {
  parentNode: El | null = null;
  get parentElement(): El | null { return this.parentNode; }
  remove(): void {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}

class Txt extends Node0 {
  readonly nodeType = 3;
  data: string;
  constructor(data: string) { super(); this.data = data; }
  get textContent(): string { return this.data; }
  set textContent(v: string) { this.data = String(v); }
}

class El extends Node0 {
  [prop: string]: unknown;
  readonly nodeType = 1;
  readonly localName: string;
  readonly attrs = new Map<string, string>();
  childNodes: Node0[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string | undefined>;
  #style: Record<string, unknown> | null = null;
  #value: string | null = null;
  #checked: boolean | null = null;
  #selected: boolean | null = null;

  constructor(name: string) {
    super();
    this.localName = name.toLowerCase();
    const attrs = this.attrs;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k) => (typeof k === 'string' ? attrs.get(`data-${kebab(k)}`) : undefined),
      set: (_t, k, v) => { attrs.set(`data-${kebab(String(k))}`, String(v)); return true; },
      deleteProperty: (_t, k) => { attrs.delete(`data-${kebab(String(k))}`); return true; },
      has: (_t, k) => attrs.has(`data-${kebab(String(k))}`),
    });
  }

  // Attributes, and the properties a browser reflects from them.
  getAttribute(n: string): string | null { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: unknown): void { this.attrs.set(n, String(v)); }
  removeAttribute(n: string): void { this.attrs.delete(n); }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  toggleAttribute(n: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(n);
    if (on) this.attrs.set(n, ''); else this.attrs.delete(n);
    return on;
  }
  #flag(n: string, v: unknown): void { if (v) this.attrs.set(n, ''); else this.attrs.delete(n); }
  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }
  get className(): string { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', v); }
  get title(): string { return this.attrs.get('title') ?? ''; }
  set title(v: string) { this.attrs.set('title', v); }
  get type(): string { return this.attrs.get('type') ?? ''; }
  set type(v: string) { this.attrs.set('type', v); }
  get name(): string { return this.attrs.get('name') ?? ''; }
  set name(v: string) { this.attrs.set('name', v); }
  get hidden(): boolean { return this.attrs.has('hidden'); }
  set hidden(v: boolean) { this.#flag('hidden', v); }
  get disabled(): boolean { return this.attrs.has('disabled'); }
  set disabled(v: boolean) { this.#flag('disabled', v); }
  get open(): boolean { return this.attrs.has('open'); }
  set open(v: boolean) { this.#flag('open', v); }
  get checked(): boolean { return this.#checked ?? this.attrs.has('checked'); }
  set checked(v: boolean) { this.#checked = !!v; }
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
    } else this.#value = String(v);
  }
  get options(): El[] { return this.querySelectorAll('option'); }
  get selectedOptions(): El[] {
    const all = this.options;
    const picked = all.filter(o => o.selected);
    return picked.length ? picked.slice(0, 1) : all.slice(0, 1);
  }
  get classList() {
    const read = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (l: string[]): void => { this.className = l.join(' '); };
    return {
      contains: (c: string) => read().includes(c),
      add: (...cs: string[]) => write([...new Set([...read(), ...cs])]),
      remove: (...cs: string[]) => write(read().filter(c => !cs.includes(c))),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !read().includes(c);
        write(on ? [...new Set([...read(), c])] : read().filter(x => x !== c));
        return on;
      },
    };
  }
  /** The inline style, read from the attribute the first time it is asked for. */
  get style(): Record<string, unknown> {
    if (!this.#style) {
      const s: Record<string, unknown> = { setProperty: (n: string, v: string) => { s[n] = v; } };
      for (const decl of (this.attrs.get('style') ?? '').split(';')) {
        const at = decl.indexOf(':');
        if (at > 0) s[camel(decl.slice(0, at).trim())] = decl.slice(at + 1).trim();
      }
      this.#style = s;
    }
    return this.#style;
  }

  // The tree.
  get children(): El[] { return this.childNodes.filter((n): n is El => n instanceof El); }
  get firstChild(): Node0 | null { return this.childNodes[0] ?? null; }
  get lastChild(): Node0 | null { return this.childNodes.at(-1) ?? null; }
  get firstElementChild(): El | null { return this.children[0] ?? null; }
  get textContent(): string {
    return this.childNodes.map(n => (n instanceof El || n instanceof Txt ? n.textContent : '')).join('');
  }
  set textContent(v: string) { this.replaceChildren(...(String(v) ? [String(v)] : [])); }
  get innerHTML(): string { return this.textContent; }
  set innerHTML(html: string) { this.replaceChildren(); parseInto(this, String(html)); }
  #adopt(nodes: (Node0 | string)[]): Node0[] {
    return nodes.map(n => {
      const node = typeof n === 'string' ? new Txt(n) : n;
      node.remove();
      node.parentNode = this;
      return node;
    });
  }
  append(...nodes: (Node0 | string)[]): void { this.childNodes.push(...this.#adopt(nodes)); }
  appendChild<T extends Node0>(node: T): T { this.append(node); return node; }
  prepend(...nodes: (Node0 | string)[]): void { this.childNodes.unshift(...this.#adopt(nodes)); }
  replaceChildren(...nodes: (Node0 | string)[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  contains(node: unknown): boolean {
    for (let n = node as Node0 | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  /** Every element under this one, in document order. */
  descendants(): El[] {
    const out: El[] = [];
    const walk = (e: El): void => { for (const c of e.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(sel: string): boolean { return selectorList(sel).some(cx => matchComplex(this, cx)); }
  querySelectorAll(sel: string): El[] {
    const list = selectorList(sel);
    return this.descendants().filter(e => list.some(cx => matchComplex(e, cx)));
  }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): El | null {
    for (let n: El | null = this; n; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }

  // Behaviour.
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  focus(): void { activeDoc.activeElement = this; }
  blur(): void {}
  scrollIntoView(): void {}
  get offsetHeight(): number { return 0; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  /**
   * A real click: nothing at all on a disabled control, and on a fold's
   * heading the browser's own job afterwards, opening or shutting the fold,
   * unless a listener prevented it.
   */
  click(): void {
    if (this.disabled) return;
    let prevented = false;
    const ev: FakeEvent = { type: 'click', target: this, preventDefault() { prevented = true; } };
    for (const fn of this.listeners.get('click') ?? []) fn(ev);
    const on = this['onclick'];
    if (typeof on === 'function') on.call(this, ev);
    const fold = this.parentNode;
    if (!prevented && this.localName === 'summary' && fold?.localName === 'details'
      && fold.children.find(c => c.localName === 'summary') === this) fold.open = !fold.open;
  }
}

// ---- markup -------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ENTITY[e.toLowerCase()] ?? m));

/** HTML into `parent`: enough of the parsing rules for hand-written markup. */
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
        while (/\s/.test(html[j] ?? '')) j++;
        let value = '';
        if (html[j] === '=') {
          j++;
          while (/\s/.test(html[j] ?? '')) j++;
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
        if (text) el.append(el.localName === 'textarea' || el.localName === 'title' ? decode(text) : text);
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

// ---- selectors ----------------------------------------------------------------

interface Compound {
  tag: string | null; ids: string[]; classes: string[];
  attrs: { name: string; op: string; value: string }[];
  pseudo: string[]; nots: Complex[][]; never: boolean;
}
interface Complex { parts: Compound[]; combs: string[] }

/** The matching closing bracket for the opener at `open`. */
function closer(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && --depth === 0) return k;
  }
  return s.length;
}

/** Split on top-level commas only (not the ones inside :not(...)). */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '(' || s[k] === '[') depth++;
    else if (s[k] === ')' || s[k] === ']') depth--;
    else if (s[k] === ',' && depth === 0) { out.push(s.slice(from, k)); from = k + 1; }
  }
  out.push(s.slice(from));
  return out.map(x => x.trim()).filter(Boolean);
}

function parseCompound(s: string, at: number): [Compound, number] {
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], pseudo: [], nots: [], never: false };
  let i = at;
  const ident = (): string => {
    const m = /^[-\w]+/.exec(s.slice(i));
    i += m ? m[0].length : 0;
    return m ? m[0] : '';
  };
  if (s[i] === '*') i++;
  else if (/[a-z]/i.test(s[i] ?? '')) c.tag = ident().toLowerCase();
  for (;;) {
    const ch = s[i];
    if (ch === '#') { i++; c.ids.push(ident()); }
    else if (ch === '.') { i++; c.classes.push(ident()); }
    else if (ch === '[') {
      const end = s.indexOf(']', i);
      const m = /^\s*([-\w]+)\s*(?:([\^$*~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(s.slice(i + 1, end));
      if (m) c.attrs.push({ name: m[1]!.toLowerCase(), op: m[2] ?? '', value: m[3] ?? m[4] ?? m[5] ?? '' });
      else c.never = true;
      i = end + 1;
    } else if (ch === ':') {
      const element = s[i + 1] === ':';
      i += element ? 2 : 1;
      const name = ident();
      let arg: string | null = null;
      if (s[i] === '(') {
        const end = closer(s, i);
        arg = s.slice(i + 1, end);
        i = end + 1;
      }
      if (element) c.never = true;                       // ::before is not the element
      else if (name === 'not' && arg !== null) c.nots.push(splitList(arg).map(parseComplex));
      else if (arg === null && ['first-child', 'last-child', 'disabled', 'checked'].includes(name)) c.pseudo.push(name);
      else c.never = true;                               // :hover, :focus-visible: never at rest
    } else break;
  }
  return [c, i];
}

function parseComplex(src: string): Complex {
  const s = src.trim();
  const parts: Compound[] = [];
  const combs: string[] = [];
  let i = 0;
  while (i < s.length) {
    let comb: string | null = null;
    while (/\s/.test(s[i] ?? '')) { i++; comb = ' '; }
    if (s[i] === '>' || s[i] === '+' || s[i] === '~') {
      comb = s[i]!;
      i++;
      while (/\s/.test(s[i] ?? '')) i++;
    }
    if (i >= s.length) break;
    const [c, next] = parseCompound(s, i);
    if (next === i) return { parts: [{ ...c, never: true }], combs: [] };  // unreadable: never matches
    if (parts.length) combs.push(comb ?? ' ');
    parts.push(c);
    i = next;
  }
  return { parts, combs };
}

const SELECTORS = new Map<string, Complex[]>();
function selectorList(sel: string): Complex[] {
  let list = SELECTORS.get(sel);
  if (!list) { list = splitList(sel).map(parseComplex); SELECTORS.set(sel, list); }
  return list;
}

function matchCompound(el: El, c: Compound): boolean {
  if (c.never) return false;
  if (c.tag && el.localName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  const cls = el.className.split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const a of c.attrs) {
    const v = el.attrs.get(a.name);
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
  }
  for (const p of c.pseudo) {
    if (p === 'first-child' && el.parentNode?.children[0] !== el) return false;
    if (p === 'last-child' && el.parentNode?.children.at(-1) !== el) return false;
    if (p === 'disabled' && !el.disabled) return false;
    if (p === 'checked' && !el.checked) return false;
  }
  for (const not of c.nots) if (not.some(cx => matchComplex(el, cx))) return false;
  return true;
}

function matchFrom(el: El, cx: Complex, k: number): boolean {
  if (!matchCompound(el, cx.parts[k]!)) return false;
  if (k === 0) return true;
  const comb = cx.combs[k - 1];
  if (comb === '>') return !!el.parentNode && matchFrom(el.parentNode, cx, k - 1);
  if (comb === ' ') {
    for (let p = el.parentNode; p; p = p.parentNode) if (matchFrom(p, cx, k - 1)) return true;
    return false;
  }
  const sibs = el.parentNode?.children ?? [];
  const before = sibs.slice(0, sibs.indexOf(el));
  if (comb === '+') return !!before.length && matchFrom(before.at(-1)!, cx, k - 1);
  return before.some(s => matchFrom(s, cx, k - 1));
}

const matchComplex = (el: El, cx: Complex): boolean =>
  !!cx.parts.length && matchFrom(el, cx, cx.parts.length - 1);

function specificity(cx: Complex): number {
  let n = 0;
  for (const p of cx.parts) {
    n += p.ids.length * 1e6 + (p.classes.length + p.attrs.length + p.pseudo.length) * 1e3 + (p.tag ? 1 : 0);
    for (const not of p.nots) n += Math.max(...not.map(specificity));
  }
  return n;
}

// ---- the stylesheet, for `display` only ---------------------------------------

interface Rule { selectors: Complex[]; display: string; important: boolean; order: number }

/** Top-level rules that set `display`. @media, @container and the like are skipped. */
function displayRules(...sheets: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const sheet of sheets) {
    const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      const prelude = css.slice(i, open).trim();
      let depth = 1;
      let k = open + 1;
      while (k < css.length && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
      const body = css.slice(open + 1, k - 1);
      i = k;
      if (prelude.startsWith('@')) continue;
      const m = /(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!\s*important)?\s*(?:;|$)/.exec(body);
      if (m) rules.push({ selectors: selectorList(prelude), display: m[1]!, important: !!m[2], order: rules.length });
    }
  }
  return rules;
}

const PAGE_CSS = /<style>([\s\S]*?)<\/style>/.exec(PAGE)?.[1] ?? '';
const RULES = displayRules(readFileSync(THEME, 'utf8'), PAGE_CSS);

/** What the cascade gives `display` on this element: author rules, then inline style, then [hidden]. */
function displayOf(el: El): string {
  let best: { important: boolean; spec: number; order: number; value: string } | null = null;
  for (const r of RULES) {
    let spec = -1;
    for (const cx of r.selectors) if (matchComplex(el, cx)) spec = Math.max(spec, specificity(cx));
    if (spec < 0) continue;
    const cand = { important: r.important, spec, order: r.order, value: r.display };
    if (!best || (cand.important !== best.important ? cand.important
      : cand.spec !== best.spec ? cand.spec > best.spec : cand.order > best.order)) best = cand;
  }
  const inline = el.style['display'];
  if (typeof inline === 'string' && inline && !best?.important) return inline;
  if (best) return best.value;
  return el.hidden ? 'none' : 'block';
}

// ---- the page -------------------------------------------------------------------

interface Emitted { type: string; payload?: Record<string, unknown> }

interface Desk {
  html: El;
  el: (id: string) => El;
  /** Not drawn at all, by the stylesheet, on this element or one around it. */
  off: (el: El) => boolean;
  /** The panels on the page, by heading (or id when they have none), in order. */
  panels: () => string[];
  /** The jump strip's links that are showing. */
  jumps: () => string[];
  /** The words of `el` a volunteer can read: hidden parts left out, spaces collapsed. */
  said: (el: El) => string;
  /** Every question the page put to confirm(), in order (each one answered yes). */
  confirms: string[];
  emits: Emitted[];
  press: (key: string) => Promise<void>;
  send: (msg: unknown) => Promise<void>;
  /** Ask the stream poll and the setup strip again, as coming back to the tab does. */
  repoll: () => Promise<void>;
  stored: Map<string, string> | null;
  addressChanges: string[];
  /** Answer the stream poll with this from now on (null: the poll fails). */
  stream: { answer: unknown };
  /** What other GETs answer, by path, from now on: absent is a 404, THROW a failed request. */
  answers: Record<string, unknown>;
  /** Every request the page made, in order. */
  requests: { path: string; method: string }[];
}

/** An answer that makes the request itself fail, as a desk restarting does. */
const THROW = Symbol('the request fails');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
};

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/**
 * The desk console, loaded fresh: the head script against `storage` and the
 * address, then desk.js. `storage: 'blocked'` is a browser that throws on any
 * touch of localStorage (a locked-down profile, some private windows).
 */
async function openDesk(opts: {
  storage?: Record<string, string> | 'blocked';
  search?: string;
  hash?: string;
  stream?: unknown;
  answers?: Record<string, unknown>;
  /** The address the page was opened by, as the address bar has it. */
  host?: string;
} = {}): Promise<Desk> {
  const g = globalThis as unknown as Record<string, unknown>;
  const docRoot = new El('#document');
  parseInto(docRoot, PAGE);
  const html = docRoot.querySelector('html')!;
  const body = html.querySelector('body')!;
  // The nav strip nav.js injects (its module script is not run here), with
  // the links this page's stylesheet picks out, so the rules about them are
  // tested on the markup nav.js writes.
  const nav = new El('nav');
  nav.className = 'opnav';
  parseInto(nav, '<a href="/s/desk" aria-current="page">Desk</a><a href="/s/replay">Replay</a>'
    + '<a href="/s/var">Ref review</a><a href="/s/media">Media</a>');
  body.prepend(nav);
  const doc = {
    documentElement: html, body, activeElement: body as El | null, hidden: false,
    getElementById: (id: string) => html.descendants().find(e => e.id === id) ?? null,
    querySelector: (sel: string) => (html.matches(sel) ? html : html.querySelector(sel)),
    querySelectorAll: (sel: string) => html.querySelectorAll(sel),
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
    createTextNode: (text: string) => new Txt(text),
    addEventListener() {}, removeEventListener() {},
  };
  activeDoc = doc;

  let stored: Map<string, string> | null = null;
  if (opts.storage === 'blocked') {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, get() { throw new Error('SecurityError: storage is blocked'); },
    });
  } else {
    const map = new Map(Object.entries(opts.storage ?? {}));
    stored = map;
    setGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
    });
  }

  const host = opts.host ?? 'desk.test';
  const location = {
    pathname: '/s/desk', search: opts.search ?? '', hash: opts.hash ?? '',
    host, hostname: new URL(`http://${host}`).hostname, protocol: 'http:',
    get href() { return `http://${host}${this.pathname}${this.search}${this.hash}`; },
    replace() {},
  };
  const addressChanges: string[] = [];
  setGlobal('location', location);
  setGlobal('history', {
    state: null,
    replaceState: (_s: unknown, _t: string, url: URL | string) => {
      const u = new URL(String(url));
      location.search = u.search;
      addressChanges.push(u.pathname + u.search + u.hash);
    },
  });
  setGlobal('document', doc);
  setGlobal('window', globalThis);
  setGlobal('getComputedStyle', (el: El) => ({
    get display() { return displayOf(el); },
    getPropertyValue: (p: string) => (p === 'display' ? displayOf(el) : ''),
  }));
  setGlobal('CSS', { escape: (v: string) => String(v).replace(/["\\]/g, m => `\\${m}`) });
  setGlobal('Option', function Option(text: string, value: string) {
    const o = new El('option');
    o.append(text);
    o.setAttribute('value', value);
    return o;
  });
  const confirms: string[] = [];
  setGlobal('confirm', (question: string) => { confirms.push(String(question)); return true; });
  setGlobal('print', () => {});
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('cancelAnimationFrame', () => {});

  // The window's own listeners: the console's keys, and coming back to the tab.
  const windowListeners = new Map<string, ((e: unknown) => void)[]>();
  setGlobal('addEventListener', (type: string, fn: (e: unknown) => void) => {
    windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
  });
  setGlobal('removeEventListener', () => {});

  const stream = { answer: opts.stream === undefined ? null : opts.stream };
  const answers: Record<string, unknown> = { ...opts.answers };
  const requests: { path: string; method: string }[] = [];
  g['fetch'] = async (url: string, init?: { method?: string }) => {
    const path = String(url).split('?')[0]!;
    requests.push({ path, method: (init?.method ?? 'GET').toUpperCase() });
    if (path === '/api/stream' && stream.answer !== null) {
      return { ok: true, status: 200, json: async () => stream.answer };
    }
    if (answers[path] === THROW) throw new TypeError('Failed to fetch');
    if (path in answers) return { ok: true, status: 200, json: async () => answers[path] };
    // Everything else declines, so each panel stays in its empty state and
    // only what this test is about moves.
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const emits: Emitted[] = [];
  const sockets: { onmessage: ((e: { data: string }) => void) | null; onopen: (() => void) | null }[] = [];
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null; onclose: unknown = null; onerror: unknown = null;
    constructor() { sockets.push(this); }
    send(data: string): void {
      const msg = JSON.parse(data) as { t: string; init?: Emitted };
      if (msg.t === 'emit' && msg.init) emits.push(msg.init);
    }
    close(): void {}
  }
  g['WebSocket'] = FakeWS;

  // The head script, as the browser runs it: before anything else.
  const head = html.querySelector('head')!;
  const inline = head.querySelectorAll('script').filter(s => !s.hasAttribute('src') && !s.hasAttribute('type'));
  assert.equal(inline.length, 1, 'the page has one classic script in its head, the view picker');
  new Function(inline[0]!.textContent)();

  // desk.js as served, with its server paths pointed at the files behind them.
  const local = DESK_JS.replace(/from '\/shared\/([\w.-]+)'/g, (_m, file: string) =>
    `from '${pathToFileURL(join(SURFACES, '_shared', file)).href}'`);
  assert.doesNotMatch(local, /from '\//, 'every server path in desk.js was pointed at a file');
  const dir = await mkdtemp(join(tmpdir(), 'cg-desk-views-'));
  const file = join(dir, 'desk.mjs');
  await writeFile(file, local);
  // Its polls and the client's watchdog are intervals that would keep this
  // process alive, and none of them is what is under test.
  const realInterval = g['setInterval'];
  g['setInterval'] = () => 0;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    g['setInterval'] = realInterval;
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(sockets.length, 1, 'the page opened its socket');
  // The link comes up, so the keys are live: the console refuses them, out
  // loud, on a dead one.
  sockets[0]!.onopen!();
  await flush();

  const off = (el: El): boolean => {
    for (let n: El | null = el; n && n !== body; n = n.parentNode) if (displayOf(n) === 'none') return true;
    return false;
  };
  const headingOf = (s: El): string => {
    const h2 = s.querySelector('h2');
    const first = h2?.childNodes.find(n => n instanceof Txt && n.data.trim());
    return first instanceof Txt ? first.data.trim() : `#${s.id}`;
  };
  const words = (n: Node0): string => (n instanceof Txt ? n.data
    : n instanceof El && displayOf(n) !== 'none' ? n.childNodes.map(words).join('') : '');
  return {
    html, emits, stored, addressChanges, stream, confirms, answers, requests,
    said: el => (off(el) ? '' : words(el).replace(/\s+/g, ' ').trim()),
    el: id => {
      const found = doc.getElementById(id);
      assert.ok(found, `the page has #${id}`);
      return found;
    },
    off,
    // The field-down band and then the card flow, in page order.
    panels: () => html.querySelectorAll('#fieldBand section, .grid section').filter(s => !off(s)).map(headingOf),
    jumps: () => html.querySelectorAll('.jump a').filter(a => !off(a)).map(a => a.textContent.trim()),
    press: async key => {
      for (const fn of windowListeners.get('keydown') ?? []) {
        fn({
          key, repeat: false, ctrlKey: false, metaKey: false, altKey: false,
          target: body, preventDefault() {},
        });
      }
      await flush();
    },
    send: async msg => { sockets[0]!.onmessage!({ data: JSON.stringify(msg) }); await flush(); },
    repoll: async () => {
      for (const fn of windowListeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
      await flush();
    },
  };
}

/** A desk state the real reducer built from these events. */
function deskAfter(...events: EmitInit[]): DeskState {
  const bus = new EventBus();
  for (const ev of events) bus.emit(ev);
  return bus.state;
}
const snapshot = (state: DeskState) => ({ t: 'snapshot', state, media: {}, needsPin: false });
const fieldUp: EmitInit = { type: 'arena.status', source: 'cheesy', payload: { cheesy: true } };

// What a match day needs, in page order: the panels the first-timer gets
// while the field runs the matches.
const SIMPLE = [
  'On the field now',             // the score, the clock, the match
  'Match steps',                  // the match buttons, the card call, the program screen row
  'Delay card: why we are waiting',
  'Name on screen (lower third)',
  'Safety message',
  'Slides & shout-outs',
  'Awards ceremony',
  'Doors check',
];
// And while it does not: "Field down? Run matches by hand" comes first, in
// its band above the cards, with Load a match alone in it. The sample data
// is for testing and waits in Everything: beside Load a match it pushed
// Match steps off a 1080p screen at the moment the field dropped.
const SIMPLE_DOWN = ['Load a match by hand', ...SIMPLE];
const SIMPLE_JUMPS = ['Match', 'Delay card', 'Slides', 'Awards', 'Doors check', 'Safety'];
const SIMPLE_JUMPS_DOWN = SIMPLE_JUMPS;

/** The doors check's answer, with these rows. */
const vitalsWith = (...checks: { id: string; label: string; level: string; detail: string; fix?: string }[]) =>
  ({ checks, worst: 'ok', blockers: [], updatedAt: 0 });
const ALL_JUMPS = ['Match', 'Cameras', 'Automation', 'Music', 'Delay card', 'On camera', 'Slides',
  'Timer', 'Awards', 'Doors check', 'Sample data', 'Safety'];

const NO_OBS = { available: false, connected: false, streaming: null, reconnecting: null, timecode: null };
const OBS_UP = { available: true, connected: true, streaming: false, reconnecting: false, timecode: null };
const OBS_DOWN = { available: true, connected: false, streaming: null, reconnecting: null, timecode: null };

// ---- the views -------------------------------------------------------------------

test('a first visit opens on Simple: the match-day panels, as plain cards, and a jump strip to match', async () => {
  const desk = await openDesk({ stream: NO_OBS });
  await desk.send(snapshot(deskAfter()));
  assert.equal(desk.html.dataset['view'], 'simple', 'Simple is the default the first time');
  assert.deepEqual(desk.panels(), SIMPLE_DOWN, 'no field yet, so the kit for running matches by hand');
  assert.deepEqual(desk.jumps(), SIMPLE_JUMPS_DOWN, 'every link goes somewhere that is on the page');

  // The match buttons, Auto and Blank, and the card call are all in Match steps.
  assert.equal(desk.off(desk.el('screenRow')), false);
  const screens = desk.el('screenRow').querySelectorAll('[data-screen-take]').map(b => b.dataset['screenTake']);
  assert.ok(screens.includes('auto') && screens.includes('blank'), `Auto and Blank are on the row: ${screens}`);
  assert.equal(desk.html.querySelectorAll('#sec-match [data-emit]').filter(b => !desk.off(b)).length, 6);
  assert.equal(desk.off(desk.el('ccShow')), false, 'the card call');

  // The doors check and Load a match live in folds; Simple opens them. The
  // doors check's fold heading is put away; the field-down kit's stays, as a
  // plain heading, because the front page quotes it.
  for (const id of ['fieldDownKit', 'setupGroup']) {
    assert.equal(desk.el(id).open, true, `${id} is open in Simple`);
  }
  assert.equal(desk.off(desk.el('setupGroup').querySelector('summary')!), true, 'the doors check heading is put away');
  assert.equal(desk.said(desk.el('fieldDownKit').querySelector('summary')!), 'Field down? Run matches by hand');
  assert.equal(desk.off(desk.el('vitalsCheck')), false);
  assert.equal(desk.off(desk.el('loadMatch')), false);
  assert.equal(desk.off(desk.html.querySelector('[data-score="red:fuel:1"]')!), true,
    'but not the hand scoring beside it');
  assert.equal(desk.off(desk.el('sampleGo')), true, 'nor the sample data, which is for testing');

  const pick = (v: string) => desk.html.querySelector(`[data-view-pick="${v}"]`)!;
  assert.equal(pick('simple').getAttribute('aria-pressed'), 'true');
  assert.equal(pick('everything').getAttribute('aria-pressed'), 'false');
  assert.match(desk.said(desk.html.querySelector('.viewbar')!),
    /^Simple Everything What a match day needs\. Everything adds music, show automation, scoring by hand/);

  // With the field connected the field runs the matches, and the kit for
  // doing it by hand (whose sample data the desk refuses then anyway) waits
  // in Everything.
  const up = await openDesk({ stream: NO_OBS });
  await up.send(snapshot(deskAfter(fieldUp)));
  assert.deepEqual(up.panels(), SIMPLE);
  assert.deepEqual(up.jumps(), SIMPLE_JUMPS);
  assert.equal(up.off(up.el('screenRow')), false, 'Auto and Blank stay');
  assert.equal(up.html.querySelectorAll('#sec-match [data-emit]').filter(b => !up.off(b)).length, 6,
    'and so do the match buttons, which put the screens right when the field gets a step wrong');
});

test('Simple is whole before the desk has said anything: no stream answer, no state yet', async () => {
  // The first paint a volunteer sees comes before any poll or snapshot
  // answers, and on a struggling desk it can be the only one for a while.
  // The field-down kit waits for the desk's word: drawing it and then taking
  // it away would move every card on a reload mid-show.
  const desk = await openDesk({ stream: null });
  assert.equal(desk.html.dataset['obs'], undefined, 'nothing has answered');
  assert.equal(desk.html.dataset['field'], undefined);
  assert.equal(desk.html.querySelector('[data-view-pick="simple"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(desk.html.querySelector('[data-view-pick="everything"]')!.getAttribute('aria-pressed'), 'false');
  assert.equal(desk.el('fieldDownKit').open, true);
  assert.equal(desk.el('setupGroup').open, true);
  assert.deepEqual(desk.jumps(), SIMPLE_JUMPS);
  assert.deepEqual(desk.panels(), SIMPLE);
  assert.equal(desk.off(desk.el('kit')), true, 'and the setup strip has nothing to say yet');
});

test('Everything is one click away, remembered for this browser, and Simple is one click back', async () => {
  const first = await openDesk({ stream: OBS_UP });
  first.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(first.html.dataset['view'], 'everything');
  assert.equal(first.stored!.get('desk.view'), 'everything', 'remembered');
  const everything = first.panels();
  assert.ok(everything.length >= 25, `every panel is back: ${everything.length}`);
  for (const p of SIMPLE_DOWN) assert.ok(everything.includes(p), `${p} is in Everything too`);
  assert.ok(everything.includes('Cameras in OBS') && everything.includes('Live stream in OBS'));
  assert.deepEqual(first.jumps(), ALL_JUMPS, 'the whole jump strip, as before');
  // Folds Simple opened go back to how Everything keeps them: shut.
  assert.equal(first.el('fieldDownKit').open, false);
  assert.equal(first.el('setupGroup').open, false);
  assert.equal(first.off(first.el('setupGroup').querySelector('summary')!), false);
  assert.equal(first.html.querySelector('[data-view-pick="everything"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(first.html.querySelector('[data-view-pick="simple"]')!.getAttribute('aria-pressed'), 'false');
  assert.equal(first.said(first.html.querySelector('.viewbar')!), 'Simple Everything Every panel on the desk. '
    + 'Simple keeps only what a match day needs. The keys work the same in both.');

  // The next visit from this browser opens where it was left.
  const again = await openDesk({ storage: Object.fromEntries(first.stored!), stream: OBS_UP });
  assert.equal(again.html.dataset['view'], 'everything', 'the head script picked it before any paint');
  assert.deepEqual(again.panels(), everything);

  again.html.querySelector('[data-view-pick="simple"]')!.click();
  assert.deepEqual(again.panels(), SIMPLE);
  assert.equal(again.stored!.get('desk.view'), 'simple');
});

test('blocked storage still opens on Simple, and the switch still works for the visit', async () => {
  const desk = await openDesk({ storage: 'blocked', stream: NO_OBS });
  assert.equal(desk.html.dataset['view'], 'simple');
  assert.deepEqual(desk.panels(), SIMPLE);
  desk.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(desk.html.dataset['view'], 'everything');
  assert.ok(desk.panels().length > SIMPLE.length);
  desk.el('obsToggle').click();
  assert.equal(desk.off(desk.el('sec-cameras')), false, 'the OBS line works without storage too');
});

test('?view= opens one view for this visit without changing what the browser remembers', async () => {
  const desk = await openDesk({ storage: { 'desk.view': 'simple' }, search: '?view=everything', stream: OBS_UP });
  assert.equal(desk.html.dataset['view'], 'everything');
  assert.equal(desk.stored!.get('desk.view'), 'simple', 'not written by just opening the page');
  assert.deepEqual(desk.addressChanges, []);

  // Choosing by hand is a real choice: it is remembered, and the address
  // stops overriding it on the next reload.
  desk.html.querySelector('[data-view-pick="simple"]')!.click();
  assert.equal(desk.stored!.get('desk.view'), 'simple');
  assert.deepEqual(desk.addressChanges, ['/s/desk']);

  const odd = await openDesk({ search: '?view=nonsense', stream: OBS_UP });
  assert.equal(odd.html.dataset['view'], 'simple', 'an unknown view is the default');
});

test('a link to a panel Simple leaves out opens Everything for that visit only', async () => {
  const desk = await openDesk({ hash: '#sec-cues', stream: OBS_UP });
  assert.equal(desk.html.dataset['view'], 'everything');
  assert.equal(desk.off(desk.el('sec-cues')), false);
  assert.equal(desk.stored!.has('desk.view'), false, 'an old bookmark does not change tomorrow');

  // The Start here box's link to the sample data opens Everything for the
  // visit, field or no field: Simple keeps it out. A link into the band
  // waits for the desk to say where the field is (before that the band is
  // not drawn yet, which is not the same as Simple leaving it out).
  for (const field of [[], [fieldUp]]) {
    const sample = await openDesk({ hash: '#sec-sample', stream: NO_OBS });
    assert.equal(sample.html.dataset['view'], 'simple', 'still Simple while the desk has said nothing');
    await sample.send(snapshot(deskAfter(...field)));
    assert.equal(sample.html.dataset['view'], 'everything', `field ${field.length ? 'up' : 'down'}`);
    assert.equal(sample.off(sample.el('sec-sample')), false);
    assert.equal(sample.el('fieldDownKit').open, true, 'its fold opened on the way');
    assert.equal(sample.stored!.has('desk.view'), false);
  }
});

test('every key fires in both views, including the keys of panels Simple leaves out', async () => {
  for (const view of ['simple', 'everything']) {
    const desk = await openDesk({ storage: { 'desk.view': view }, stream: NO_OBS });
    assert.equal(desk.html.dataset['view'], view);
    if (view === 'simple') {
      // The hand-scoring keys and the replay mark belong to panels that are
      // not on the page at all in Simple.
      assert.equal(desk.off(desk.html.querySelector('[data-score="red:fuel:1"]')!), true);
      assert.equal(desk.off(desk.el('mark')), true);
    }
    desk.el('t1').value = 'Priya Raman';
    for (const key of ['1', '2', '3', '4', '5', '0', 'b', 't', 'y', 'q', 'w', 'e', 'a', 's', 'd', ' ']) {
      await desk.press(key);
    }
    assert.deepEqual(desk.emits.map(e => e.type), [
      'match.preview', 'match.armed', 'match.start', 'match.end', 'match.score_posted', 'match.aborted',
      'screen.change', 'lower_third.show', 'lower_third.hide',
      'score.delta', 'score.delta', 'score.delta', 'score.delta', 'score.delta', 'score.delta',
      'replay.marker',
    ], `the keys in ${view}`);
    assert.deepEqual(desk.emits[6]!.payload, { screen: 'blank' });
    assert.equal(desk.emits[7]!.payload!['line1'], 'Priya Raman');
  }
});

test('the field dropping brings the kit forward above the cards, and no card changes column', async () => {
  // Load a match by hand used to arrive with a field drop INSIDE the card
  // flow, and on a wide monitor that one card rebalanced every column: Safety
  // message jumped below the fold at the moment somebody reaches for it. The
  // kit now comes and goes in its own band above the flow, so everything the
  // columns balance is drawn the same either way, element by element, and
  // the only attribute on <html> that moves is the field's own.
  const desk = await openDesk({ stream: NO_OBS });
  await desk.send(snapshot(deskAfter(fieldUp)));
  const cards = desk.html.querySelectorAll('.grid *');
  const drawn = (): boolean[] => cards.map(e => !desk.off(e));
  const attrs = (): string[] => [...desk.html.attrs].filter(([k]) => k !== 'data-field')
    .map(([k, v]) => `${k}=${v}`).sort();
  const up = { drawn: drawn(), attrs: attrs() };
  assert.deepEqual(desk.panels(), SIMPLE);
  assert.equal(desk.html.dataset['field'], 'up');
  assert.equal(desk.off(desk.el('fieldBand')), true, 'the kit waits in Everything');

  await desk.send(snapshot(deskAfter()));
  assert.equal(desk.html.dataset['field'], 'down', 'said at once: that is when it is needed');
  assert.deepEqual(desk.panels(), SIMPLE_DOWN);
  assert.deepEqual(desk.jumps(), SIMPLE_JUMPS_DOWN);
  assert.equal(desk.off(desk.el('loadMatch')), false);
  assert.equal(desk.el('fieldDownKit').open, true);
  assert.equal(desk.html.querySelector('.grid')!.contains(cards[0]), true, 'the same page, not a rebuilt one');
  assert.deepEqual({ drawn: drawn(), attrs: attrs() }, up, 'the cards below it are exactly as they were');
  // Above the flow, not in it: the band is the page's, not a column's.
  assert.equal(desk.el('fieldBand').closest('.grid'), null);
  assert.ok(desk.el('fieldBand').contains(desk.el('fieldDownKit')));
});

test('the kit goes back only once the field has stayed up, and never while somebody types in it', async () => {
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const desk = await openDesk({ stream: NO_OBS });
    await desk.send(snapshot(deskAfter()));
    assert.equal(desk.html.dataset['field'], 'down');

    // The field comes back: a flapping bridge must not pull the form away.
    await desk.send(snapshot(deskAfter(fieldUp)));
    assert.equal(desk.html.dataset['field'], 'down', 'held while the field settles');
    shift = 19_000;
    await desk.send(snapshot(deskAfter(fieldUp)));
    assert.equal(desk.html.dataset['field'], 'down');

    // It drops again inside the wait: the wait starts over.
    await desk.send(snapshot(deskAfter()));
    await desk.send(snapshot(deskAfter(fieldUp)));
    shift = 30_000;
    await desk.send(snapshot(deskAfter(fieldUp)));
    assert.equal(desk.html.dataset['field'], 'down', 'eleven seconds up is not twenty');

    // Somebody is typing a match in: it stays while they are in the form.
    desk.el('mRed').focus();
    shift = 60_000;
    await desk.send(snapshot(deskAfter(fieldUp)));
    assert.equal(desk.html.dataset['field'], 'down', 'not while the operator is in the kit');
    assert.equal(desk.off(desk.el('mRed')), false);

    // Out of the form, the next tick of the setup strip puts it away, with
    // no desk event needed: a quiet desk between matches still tidies up.
    desk.el('t1').focus();
    await desk.repoll();
    assert.equal(desk.html.dataset['field'], 'up');
    assert.deepEqual(desk.panels(), SIMPLE);
    assert.deepEqual(desk.jumps(), SIMPLE_JUMPS);
  } finally {
    Date.now = realNow;
  }
});

test('the field-down heading in Simple is a heading: a click on it hides nothing', async () => {
  // The front page's help sends a volunteer to "Field down? Run matches by
  // hand", then "Load a match by hand". The heading is a fold's, and one
  // click on it used to shut the fold: Load a match and the sample data
  // (where the Start here box sends a first-timer) went with it.
  const desk = await openDesk({ stream: NO_OBS });
  await desk.send(snapshot(deskAfter()));
  const heading = desk.el('fieldDownKit').querySelector('summary')!;
  assert.equal(desk.said(heading), 'Field down? Run matches by hand');
  heading.click();
  heading.click();
  heading.click();
  assert.equal(desk.el('fieldDownKit').open, true);
  assert.equal(desk.off(desk.el('loadMatch')), false);
  assert.deepEqual(desk.panels(), SIMPLE_DOWN);

  // Running matches by hand, it says what comes after Load, by button and
  // by key (on a laptop the band can push Match steps below the bottom
  // edge), and where the score is typed, since Simple leaves Score by hand
  // out. The keys it names are the ones that fire.
  assert.equal(desk.said(desk.el('loadScoreHint')), "Fill in the boxes and press Load to put the match's "
    + 'teams on the screens. Then step the screens through the match with Match steps below, or the keys '
    + '1 to 5. To type the score as it happens, press Everything and use Score by hand, or the keys Q W E '
    + '(red) and A S D (blue). Every key works from anywhere on this page.');
  await desk.press('q');
  await desk.press('a');
  assert.deepEqual(desk.emits.map(e => [e.type, e.payload!['alliance']]),
    [['score.delta', 'red'], ['score.delta', 'blue']]);
  for (const key of ['1', '2', '3', '4', '5']) await desk.press(key);
  assert.deepEqual(desk.emits.slice(2).map(e => e.type), ['match.preview', 'match.armed', 'match.start',
    'match.end', 'match.score_posted']);
  // Short in Simple, where it sits above every card: the hint says what
  // Load does, so the card's general lines wait in Everything.
  const card = desk.el('loadMatch').closest('section')!;
  assert.doesNotMatch(desk.said(card), /when the field cannot|numbers alone are enough/);

  // In Everything it is the fold it always was, and the pointer to it goes:
  // Score by hand is right there.
  desk.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(desk.off(desk.el('loadScoreHint')), true);
  assert.match(desk.said(card), /Puts a match's teams on the screens when the field cannot\..*numbers alone are enough/);
  const open = desk.el('fieldDownKit').open;
  heading.click();
  assert.equal(desk.el('fieldDownKit').open, !open, 'a click opens or shuts it in Everything');
  heading.click();
  assert.equal(desk.el('fieldDownKit').open, open);
});

test('the field dropping opens the hand-scoring kit for good, in whichever view it happens', async () => {
  // With the field connected, Simple's open folds are Simple's: back in
  // Everything they are shut again, as the page has always kept them.
  const up = await openDesk({ stream: NO_OBS });
  await up.send(snapshot(deskAfter(fieldUp)));
  up.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(up.el('fieldDownKit').open, false);

  // A desk with no field: the kit opened itself because the field is down,
  // and that is still true after leaving Simple.
  const down = await openDesk({ stream: NO_OBS });
  await down.send(snapshot(deskAfter()));
  down.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(down.el('fieldDownKit').open, true, 'the kit stays open: the field is still down');
  assert.equal(down.el('setupGroup').open, false, 'the doors check fold was only open for Simple');
});

// ---- OBS -------------------------------------------------------------------------

test('with no OBS set up, the camera and stream panels fold behind one line', async () => {
  const desk = await openDesk({ storage: { 'desk.view': 'everything' }, stream: NO_OBS });
  assert.equal(desk.html.dataset['obs'], 'off');
  const panels = desk.panels();
  assert.ok(!panels.includes('Cameras in OBS') && !panels.includes('Live stream in OBS'), panels.join(' / '));
  assert.ok(panels.includes('#sec-obs'), 'the one line in their place');
  assert.deepEqual(desk.jumps(), ALL_JUMPS.filter(j => j !== 'Cameras'));
  assert.match(desk.el('obsToggle').textContent, /^Using OBS\? Show the camera controls$/);
  assert.equal(desk.el('obsToggle').getAttribute('aria-expanded'), 'false');
  // Show automation's example stops promising a camera cut.
  const words = (state: string) => desk.html.querySelector(`#sec-cues [data-when-obs="${state}"]`)!;
  assert.equal(desk.off(words('on')), true);
  assert.equal(desk.off(words('off')), false);
  const example = desk.html.querySelector('#sec-cues p.hint')!;
  assert.match(desk.said(example), /^A cue is the desk doing one thing by itself: putting the score bar up when the match arms, ducking/);
  assert.doesNotMatch(desk.said(example), /cut|camera/i);
  // And so does the question before arming them all.
  desk.el('cueArmAll').click();
  assert.match(desk.confirms.at(-1) ?? '', /^Arm every cue\? The desk starts switching the screens and driving audio/);
  assert.doesNotMatch(desk.confirms.at(-1) ?? '', /camera/i);

  // Somebody who is about to set OBS up can still see the controls.
  desk.el('obsToggle').click();
  assert.equal(desk.off(desk.el('sec-cameras')), false);
  assert.equal(desk.off(desk.el('sec-stream')), false);
  assert.deepEqual(desk.jumps(), ALL_JUMPS);
  assert.equal(desk.stored!.get('desk.obsShown'), '1');
  assert.equal(desk.el('obsToggle').textContent, 'Put the camera controls away');
  assert.equal(desk.el('obsToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(desk.off(words('on')), true, 'the cue example still tells the truth about this desk');

  // Remembered for this browser, from the first paint.
  const again = await openDesk({ storage: Object.fromEntries(desk.stored!), stream: NO_OBS });
  assert.equal(again.off(again.el('sec-cameras')), false);
  again.el('obsToggle').click();
  assert.equal(again.off(again.el('sec-cameras')), true);
  assert.equal(again.stored!.has('desk.obsShown'), false);

  // In Simple the OBS panels and the line are both left out: Simple has no
  // camera panels to stand in for.
  again.html.querySelector('[data-view-pick="simple"]')!.click();
  assert.equal(again.off(again.el('sec-obs')), true);
  assert.deepEqual(again.panels(), SIMPLE);
});

test('a desk with OBS set up shows every OBS panel as before, connected or not, and never the line', async () => {
  for (const [name, answer] of [['connected', OBS_UP], ['set up but down', OBS_DOWN]] as const) {
    const desk = await openDesk({ storage: { 'desk.view': 'everything' }, stream: answer });
    assert.equal(desk.html.dataset['obs'], 'on', name);
    const panels = desk.panels();
    assert.ok(panels.includes('Cameras in OBS') && panels.includes('Live stream in OBS'), `${name}: ${panels}`);
    assert.ok(!panels.includes('#sec-obs'), `${name}: no OBS line`);
    assert.deepEqual(desk.jumps(), ALL_JUMPS, name);
    assert.equal(desk.off(desk.html.querySelector('#sec-cues [data-when-obs="on"]')!), false);
    assert.match(desk.said(desk.html.querySelector('#sec-cues p.hint')!),
      /by itself: cutting to the field when the match arms, ducking/, name);
    desk.el('cueArmAll').click();
    assert.match(desk.confirms.at(-1) ?? '', /^Arm every cue\? The desk starts cutting cameras and driving audio/, name);
  }

  // A stream poll that does not answer says nothing about OBS: the page is
  // left as it is, which before any answer is the page as it always was.
  const quiet = await openDesk({ storage: { 'desk.view': 'everything' }, stream: null });
  assert.equal(quiet.html.dataset['obs'], undefined);
  assert.ok(quiet.panels().includes('Cameras in OBS'));
  assert.ok(!quiet.panels().includes('#sec-obs'));

  // OBS set up later (the desk restarted with it on): the panels come back
  // at the next poll, and a failed poll after that changes nothing.
  const later = await openDesk({ storage: { 'desk.view': 'everything' }, stream: NO_OBS });
  assert.equal(later.off(later.el('sec-cameras')), true);
  later.stream.answer = OBS_DOWN;
  await later.repoll();
  assert.equal(later.off(later.el('sec-cameras')), false);
  assert.ok(later.jumps().includes('Cameras'));
  later.stream.answer = null;
  await later.repoll();
  assert.equal(later.off(later.el('sec-cameras')), false);
});

// ---- the setup strip ---------------------------------------------------------------

const ATEM_UP = {
  state: 'connected', host: '10.0.100.40', model: 'ATEM Constellation 8K', protocol: '2.30',
  videoMode: { id: 13, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 },
  program: 2, preview: 1,
  inputs: [
    { id: 1, longName: 'Field wide', shortName: 'WIDE' },
    { id: 2, longName: 'Camera 2', shortName: 'CAM2' },
    { id: 5, longName: 'Graphics PC', shortName: 'GFX' },
  ],
  keyers: [
    { kind: 'downstream', me: null, index: 1, onAir: true, type: 'luma', fillSource: 5, keySource: 5 },
    { kind: 'downstream', me: null, index: 2, onAir: false, type: null, fillSource: null, keySource: null },
    { kind: 'upstream', me: 1, index: 1, onAir: false, type: 'luma', fillSource: 1, keySource: 1 },
  ],
  since: 0, lastHeard: 0, error: null,
};

/** A main-screen page that has said hello: by default, the switcher's input, as C8 opens it. */
const screen = (over: Record<string, unknown> = {}) => ({
  id: 's1', surface: 'program', addr: '10.0.100.21', since: 0, key: 'luma', embedded: false,
  full: true, w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', ...over,
});

/** The strip's problems line, one entry per problem. */
const problems = (desk: Desk): string[] =>
  desk.el('kitWarn').children.filter(li => !desk.off(li)).map(li => desk.said(li));

/** Answer the doors check with these rows, and ask it again, as Run the check does. */
async function check(desk: Desk, ...rows: Parameters<typeof vitalsWith>): Promise<void> {
  desk.answers['/api/vitals'] = vitalsWith(...rows);
  desk.el('vitalsCheck').click();
  await desk.repoll();
}

test('the setup strip says where the field is, in both views, and points at the kit while it is not connected', async () => {
  const desk = await openDesk({
    stream: NO_OBS, answers: { '/api/info': { mode: 'normal', field: { host: '10.0.100.5:8080' } } },
  });
  assert.equal(desk.off(desk.el('kit')), true, 'nothing to say before the desk has said anything');

  await desk.send(snapshot(deskAfter(fieldUp)));
  assert.equal(desk.said(desk.el('kitField')),
    'Field connected to Cheesy Arena at 10.0.100.5:8080. Matches load by themselves.');
  assert.equal(desk.el('kitField').dataset['l'], 'ok');
  assert.equal(desk.off(desk.el('kitFieldGo')), true, 'nothing to run by hand');
  assert.deepEqual(problems(desk), []);

  // Lost: the desk has the field, and it stopped answering.
  await check(desk, { id: 'field', label: 'Field bridge', level: 'warn', detail: 'not answering' });
  await desk.send(snapshot(deskAfter()));
  assert.equal(desk.said(desk.el('kitField')), 'Field not answering. The desk reconnects by itself. '
    + 'Until then, run matches by hand below. Run matches by hand');
  assert.equal(desk.el('kitField').dataset['l'], 'warn');
  assert.deepEqual(problems(desk), ["The desk laptop cannot reach the field at 10.0.100.5:8080. Check the "
    + "desk laptop's network cable to the field network, and ask the scorekeeper whether Cheesy Arena is running."]);
  assert.equal(desk.el('kitFieldGo').getAttribute('href'), '#fieldDownKit');

  // Still looking for it, by itself: gray, and no problem to fix.
  await check(desk, { id: 'field', label: 'Field bridge', level: 'off',
    detail: 'searching for the field by itself. It connects as soon as the field is up; until then, '
      + 'matches are run by hand (Field down? Run matches by hand, in the desk console).' });
  assert.equal(desk.said(desk.el('kitField')), 'Field not found yet. The desk keeps looking for it by itself. '
    + 'Until then, run matches by hand below. Run matches by hand');
  assert.equal(desk.el('kitField').dataset['l'], 'wait');
  assert.deepEqual(problems(desk), []);

  await check(desk, { id: 'field', label: 'Field bridge', level: 'off',
    detail: 'not connected: practice mode runs without the field' });
  assert.match(desk.said(desk.el('kitField')), /^Field not used in practice mode\. Run matches by hand below\./);
  assert.equal(desk.el('kitField').dataset['l'], 'off');

  // Started without looking ("not looking" has "looking" in it too).
  await check(desk, { id: 'field', label: 'Field bridge', level: 'off',
    detail: 'not connected, and this desk is not looking for the field, so matches are run by hand. '
      + 'Once the field is up, restart the desk (Task Manager, End task, double-click the exe) '
      + 'and it finds the field by itself.' });
  assert.match(desk.said(desk.el('kitField')),
    /^Field not used on this setup: the desk was started without looking for it\. Run matches by hand below\./);
  assert.equal(desk.el('kitField').dataset['l'], 'off', 'never red for a field this setup does not have');

  await check(desk, { id: 'field', label: 'Field bridge', level: 'off',
    detail: 'not connected: this desk is playing back a saved event log' });
  assert.equal(desk.said(desk.el('kitField')), 'Field not used: this desk is playing back a saved day.');

  await check(desk, { id: 'field', label: 'Field bridge', level: 'off', detail: 'not connected' });
  assert.match(desk.said(desk.el('kitField')), /^Field not connected\. Run matches by hand below\./);

  // The same strip in Everything, and its link opens the kit there.
  desk.html.querySelector('[data-view-pick="everything"]')!.click();
  assert.equal(desk.off(desk.el('kit')), false);
  const kitHeading = desk.el('fieldDownKit').querySelector('summary')!;
  kitHeading.click();
  assert.equal(desk.el('fieldDownKit').open, false, 'shut by hand');
  desk.el('kitFieldGo').click();
  assert.equal(desk.el('fieldDownKit').open, true, 'the link opens it on the way');
});

test('the switcher row: what is on air by input name and which keyer, gray when there is none', async () => {
  // An older desk has no switcher watcher at all: no row, not a guess.
  const old = await openDesk({ stream: NO_OBS });
  await old.send(snapshot(deskAfter(fieldUp)));
  assert.equal(old.off(old.el('kitSwitcher')), true);

  const desk = await openDesk({ stream: NO_OBS, answers: { '/api/atem': ATEM_UP } });
  assert.equal(desk.off(desk.el('kit')), false, 'the switcher alone is worth the strip');
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher ATEM Constellation 8K at 10.0.100.40, '
    + '1080p59.94. On air: Camera 2. Overlay on air: DSK1, luma key of Graphics PC.');
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'ok');

  // Wrapped with the graphics input, as a settings-shaped answer might be.
  desk.answers['/api/atem'] = { atem: { ...ATEM_UP, program: 1, keyers: [
    { kind: 'upstream', me: 1, index: 1, onAir: true, type: 'luma', fillSource: 9, keySource: 9 },
  ] }, graphicsInput: 5 };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher ATEM Constellation 8K at 10.0.100.40, '
    + '1080p59.94. On air: Field wide. Overlay on air: key 1 on M/E 1, luma key of input 9.');

  desk.answers['/api/atem'] = { ...ATEM_UP, keyers: ATEM_UP.keyers.map(k => ({ ...k, onAir: false })) };
  await desk.repoll();
  assert.match(desk.said(desk.el('kitSwitcher')), /On air: Camera 2\. No overlay keyer is on air\.$/);

  // A request that fails outright (the desk restarting) keeps the last answer.
  desk.answers['/api/atem'] = THROW;
  await desk.repoll();
  assert.match(desk.said(desk.el('kitSwitcher')), /No overlay keyer is on air\.$/);

  // Lost: one problem, naming the machine that lost it and what to check.
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'lost', error: 'no answer for 10 s' };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitSwitcher')),
    'Switcher lost at 10.0.100.40. The desk reconnects by itself, and the switcher keeps running without it.');
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn');
  assert.deepEqual(problems(desk), ['The desk laptop lost the switcher at 10.0.100.40. Check the switcher is '
    + 'on and the network cable between it and the desk laptop. Nothing on air changes: the desk only watches '
    + 'the switcher.']);

  // No switcher on this kit: gray, in so many words, and never a problem.
  for (const [state, words] of [
    ['off', 'Switcher not used on this setup.'],
    ['searching', 'Switcher none found: not used on this setup, or not on the network yet. '
      + 'The desk keeps looking by itself.'],
  ] as const) {
    desk.answers['/api/atem'] = { ...ATEM_UP, state, host: null, model: null, videoMode: null };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitSwitcher')), words);
    assert.equal(desk.el('kitSwitcher').dataset['l'], 'off', state);
    assert.deepEqual(problems(desk), [], state);
  }
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'connecting', model: null, videoMode: null };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher found one at 10.0.100.40, connecting.');

  // It only ever read: every request this page made by itself is a GET, and
  // nothing went out on the socket.
  assert.deepEqual(desk.requests.filter(r => r.method !== 'GET'), []);
  assert.deepEqual(desk.emits, []);
  for (const path of ['/api/atem', '/api/screens', '/api/info']) {
    assert.ok(desk.requests.some(r => r.path === path), `asked ${path}`);
  }
});

test('the graphics row counts the main-screen pages, full screen or not, and whose overlay they show', async () => {
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const desk = await openDesk({
      stream: NO_OBS, answers: { '/api/screens': { screens: [] }, '/api/urls': { base: 'http://10.0.100.10:8080' } },
    });
    // Every page reconnects by itself after the desk starts, a few seconds
    // apart: no page yet is not a problem yet.
    assert.equal(desk.said(desk.el('kitGraphics')), 'Graphics waiting for the screens to say where they are.');
    assert.equal(desk.el('kitGraphics').dataset['l'], 'wait');
    assert.deepEqual(problems(desk), []);
    shift = 16_000;
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitGraphics')), 'Graphics not open on any screen yet.');
    assert.equal(desk.el('kitGraphics').dataset['l'], 'warn');
    assert.deepEqual(problems(desk), ['No computer has the graphics open. On the computer whose HDMI goes to '
      + 'the switcher, open http://10.0.100.10:8080/s/program in Chrome or Edge, then press F11. For a '
      + 'projector or TV, open /s/watch on that computer instead.']);

    // Two screens, one of them a projector framed by /s/watch; the desk
    // console's own socket is not a screen.
    desk.answers['/api/screens'] = { screens: [
      screen(), screen({ id: 's2', addr: '::ffff:10.0.100.22', key: 'fill', embedded: true, full: false }),
      screen({ id: 'd', surface: 'desk', full: false }),
    ] };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitGraphics')),
      "Graphics on 2 screens, 1 full screen, 1 on a projector or TV, showing the desk's graphics.");
    assert.equal(desk.el('kitGraphics').dataset['l'], 'ok');
    assert.deepEqual(problems(desk), [], "a framed page is the projector page's to fill, not held to F11");

    // Not full screen, on the desk laptop itself.
    desk.answers['/api/screens'] = { screens: [screen(), screen({ id: 's3', addr: '127.0.0.1', full: false })] };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitGraphics')), "Graphics on 2 screens, 1 of 2 full screen, showing the desk's graphics.");
    assert.deepEqual(problems(desk), ['The graphics on the desk laptop are not full screen. On that computer, '
      + 'click them and press F11.']);

    // Cheesy Arena's overlay in the desk's place, named for the computer.
    desk.answers['/api/screens'] = { screens: [screen({ showing: 'cheesy' })] };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitGraphics')), "Graphics on 1 screen, full screen, showing Cheesy Arena's own overlay.");
    assert.deepEqual(problems(desk), ["The computer at 10.0.100.21 is showing Cheesy Arena's own score overlay, "
      + "because the desk has no field data right now. It switches back to the desk's graphics by itself a few "
      + 'seconds after the desk and the field are both answering.']);

    // A see-through page on a desk with no OBS: the white page the AV
    // table got stuck on (a plain browser showing ?key=alpha, which the
    // switcher keys over the whole stream). Amber, one line naming the
    // computer, the address to open instead, and F11.
    desk.answers['/api/screens'] = { screens: [screen({ key: 'alpha', full: false })] };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitGraphics')),
      "Graphics on 1 screen, 0 of 1 full screen, 1 on white, showing the desk's graphics.");
    assert.equal(desk.el('kitGraphics').dataset['l'], 'warn');
    assert.deepEqual(problems(desk), ['The graphics on the computer at 10.0.100.21 are the see-through version '
      + 'made for OBS, so a plain browser shows them on white, and on the switcher that white covers the whole '
      + 'stream. If that computer is not running OBS, open http://10.0.100.10:8080/s/program there instead, '
      + 'with nothing after it, then press F11.'], 'one line for it, not a second about F11');

    // Gone again (the desk restarted): a fresh wait, not an instant alarm.
    desk.answers['/api/screens'] = { screens: [] };
    await desk.repoll();
    assert.equal(desk.el('kitGraphics').dataset['l'], 'wait');
    shift = 40_000;
    await desk.repoll();
    assert.equal(desk.el('kitGraphics').dataset['l'], 'warn');

    // A page that has not said hello yet (everything null), or has not said
    // whether it fills its screen, is held to nothing: only a page that said
    // "not full screen" gets the F11 line.
    for (const sc of [screen({ full: null, embedded: null, key: null, sw: null, sh: null, dpr: null, hz: null,
      showing: null }), screen({ full: null })]) {
      desk.answers['/api/screens'] = { screens: [sc] };
      await desk.repoll();
      assert.deepEqual(problems(desk), [], JSON.stringify(sc));
    }
  } finally {
    Date.now = realNow;
  }
});

test("a switcher feed that cannot reach the field's own display is said while the field is up", async () => {
  const desk = await openDesk({ stream: NO_OBS, answers: { '/api/screens': { screens: [screen({ backup: 'bad' })] } } });
  // The field down: its own row says so, and this line would only repeat it.
  await desk.send(snapshot(deskAfter()));
  assert.deepEqual(problems(desk).filter(p => /score display/.test(p)), []);
  await desk.send(snapshot(deskAfter(fieldUp)));
  await desk.repoll();
  assert.deepEqual(problems(desk), ["The computer at 10.0.100.21 cannot reach Cheesy Arena's own score display, "
    + "so if the desk stops, that input keeps its last picture instead of showing the field's score. Plug that "
    + 'computer into the field network (the same switch as Cheesy Arena).']);
  for (const backup of ['ready', 'none', null]) {
    desk.answers['/api/screens'] = { screens: [screen({ backup })] };
    await desk.repoll();
    assert.deepEqual(problems(desk), [], String(backup));
  }
  // The clean second-stream feed is a main-screen page too (screens.ts
  // isProgramPage): counted, and held to the same checks.
  desk.answers['/api/screens'] = { screens: [screen({ surface: 'program-clean', full: false })] };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitGraphics')), "Graphics on 1 screen, 0 of 1 full screen, showing the desk's graphics.");
  assert.deepEqual(problems(desk), ['The graphics on the computer at 10.0.100.21 are not full screen. On that '
    + 'computer, click them and press F11.']);
});

test('a see-through page is in OBS on a desk with OBS, and held to nothing there', async () => {
  for (const stream of [OBS_UP, OBS_DOWN]) {
    const desk = await openDesk({ stream, answers: {
      '/api/screens': { screens: [screen({ key: 'alpha', full: false, sw: 1366, sh: 768, hz: 30 })] },
      '/api/atem': ATEM_UP,
    } });
    assert.equal(desk.said(desk.el('kitGraphics')), "Graphics on 1 screen, 1 in OBS, showing the desk's graphics.");
    assert.equal(desk.el('kitGraphics').dataset['l'], 'ok');
    assert.deepEqual(problems(desk), [], 'in OBS full screen and the switcher format mean nothing');
  }
  // Before the stream poll has said whether there is OBS, the page is not
  // accused: it stays "in OBS" until the desk says it has none.
  const desk = await openDesk({ stream: null, answers: { '/api/screens': { screens: [screen({ key: 'alpha' })] } } });
  assert.equal(desk.said(desk.el('kitGraphics')), "Graphics on 1 screen, 1 in OBS, showing the desk's graphics.");
  assert.deepEqual(problems(desk), []);
  desk.stream.answer = NO_OBS;
  await desk.repoll();
  assert.equal(desk.html.dataset['obs'], 'off');
  assert.match(desk.said(desk.el('kitGraphics')), /1 on white/);
  assert.match(problems(desk)[0] ?? '', /see-through version made for OBS/);
});

test("the switcher's input is held to the switcher's format, and only that page", async () => {
  const desk = await openDesk({ stream: NO_OBS, answers: {
    '/api/atem': ATEM_UP, '/api/screens': { screens: [screen({ sw: 1366, sh: 768, hz: 30 })] },
  } });
  assert.deepEqual(problems(desk), [
    'The computer at 10.0.100.21 sends 1366x768, and the switcher runs 1080p59.94 (1920x1080). If it feeds '
      + 'the switcher, set that display to 1920x1080 in Windows: Settings, System, Display.',
    'The computer at 10.0.100.21 refreshes 30 times a second, and the switcher runs 1080p59.94. If it feeds '
      + 'the switcher, set that display to 60 Hz in Windows: Settings, System, Display, Advanced display.',
  ]);
  assert.equal(desk.el('kitGraphics').dataset['l'], 'warn');

  // Windows display scaling is not a wrong format: 1536 at 125% is 1920.
  // Nor is 59 against 59.94. A projector's page, framed by /s/watch or
  // opened on the backdrop with ?key=fill, and any page while no switcher
  // is connected, are not held to it.
  for (const screens of [
    [screen({ sw: 1536, sh: 864, dpr: 1.25, hz: 59 })],
    [screen({ key: 'fill', embedded: true, sw: 1280, sh: 720, hz: 30 })],
    [screen({ key: 'fill', sw: 1280, sh: 720, hz: 30 })],
  ]) {
    desk.answers['/api/screens'] = { screens };
    await desk.repoll();
    assert.deepEqual(problems(desk), [], JSON.stringify(screens));
  }

  // An interlaced format is fed at its field rate: 1080i59.94 wants 60 Hz.
  desk.answers['/api/atem'] = { ...ATEM_UP,
    videoMode: { id: 4, label: '1080i59.94', width: 1920, height: 1080, fps: 29.97 } };
  desk.answers['/api/screens'] = { screens: [screen({ hz: 60 })] };
  await desk.repoll();
  assert.deepEqual(problems(desk), []);
  desk.answers['/api/screens'] = { screens: [screen({ hz: 30 })] };
  await desk.repoll();
  assert.match(problems(desk)[0] ?? '', /refreshes 30 times a second, and the switcher runs 1080i59\.94\. .* to 60 Hz/);

  desk.answers['/api/screens'] = { screens: [screen({ sw: 1366, sh: 768 })] };
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'lost' };
  await desk.repoll();
  assert.deepEqual(problems(desk).filter(p => /sends|refreshes/.test(p)), []);
});

test('the switcher row warns of two overlays at once, and of a match with the graphics keyed off', async () => {
  const keyer = (index: number, fillSource: number, over: Record<string, unknown> = {}) =>
    ({ kind: 'downstream', me: null, index, onAir: true, type: 'luma', fillSource, keySource: fillSource, ...over });
  const desk = await openDesk({ stream: NO_OBS, answers: {
    '/api/atem': { ...ATEM_UP, keyers: [keyer(1, 5), keyer(2, 1)] },
  } });
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn');
  assert.deepEqual(problems(desk), ['The switcher has 2 overlays keyed on air at once, one over the other '
    + "(DSK1, DSK2). On the switcher's panel, take all but one off air with its ON AIR button: the desk's "
    + "graphics and Cheesy Arena's overlay come through the same input, so one key is enough."]);

  // A picture-in-picture box is an upstream DVE key, not a second overlay.
  desk.answers['/api/atem'] = { ...ATEM_UP, keyers: [keyer(1, 5),
    { kind: 'upstream', me: 1, index: 1, onAir: true, type: 'dve', fillSource: 2, keySource: 2 }] };
  await desk.repoll();
  assert.deepEqual(problems(desk), []);
  assert.match(desk.said(desk.el('kitSwitcher')),
    /Overlay on air: DSK1, luma key of Graphics PC; key 1 on M\/E 1, DVE key of Camera 2\.$/);

  // The desk knows its graphics input, a match is running, and nothing
  // carries that input on air: the stream has no score.
  desk.answers['/api/atem'] = { atem: { ...ATEM_UP, keyers: [keyer(1, 5, { onAir: false })] }, graphicsInput: 5 };
  await desk.repoll();
  assert.deepEqual(problems(desk), [], 'no match running: keys off between matches is normal');
  await desk.send(snapshot({ ...deskAfter(fieldUp), matchStartedAt: Date.now() }));
  assert.deepEqual(problems(desk), ['A match is running and the graphics input (Graphics PC) is not keyed on '
    + "air, so the stream shows no score. On the switcher's panel, put the key that carries it on air (on "
    + 'this kit, DSK 1: press its ON AIR button).']);
  desk.answers['/api/atem'] = { atem: { ...ATEM_UP, keyers: [keyer(1, 5)] }, graphicsInput: 5 };
  await desk.repoll();
  assert.deepEqual(problems(desk), []);

  // The NorCal changeover: Cheesy Arena's overlay keyed on DSK1 from its
  // own input, the desk's graphics input keyed off, a match running. One key
  // is on air, so it is not two overlays; it is the score missing.
  desk.answers['/api/atem'] = { atem: { ...ATEM_UP, keyers: [keyer(1, 9), keyer(2, 5, { onAir: false })] },
    graphicsInput: 5 };
  await desk.repoll();
  assert.deepEqual(problems(desk), ['A match is running and the graphics input (Graphics PC) is not keyed on '
    + "air, so the stream shows no score. On the switcher's panel, put the key that carries it on air (on "
    + 'this kit, DSK 1: press its ON AIR button).']);

  // A typed address that does not answer is a problem; a handshake is not.
  // The problem is the switcher watcher's own words: it knows which of the
  // three it is, and each sends somebody somewhere else.
  const noAnswer = 'No answer from the switcher at 10.0.100.40. Check that it is powered on and plugged into '
    + 'the field network, and that 10.0.100.40 is what ATEM Setup shows under Network. Trying again in 8 s.';
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'connecting', error: noAnswer };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher not answering at 10.0.100.40. The desk keeps trying by itself.');
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn');
  assert.deepEqual(problems(desk), [noAnswer]);

  const refused = 'The switcher at 10.0.100.40 turned the desk down. It may have no free connection slots: close '
    + 'any copy of ATEM Software Control nobody is using. Trying again in 2 s.';
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'connecting', error: refused };
  await desk.repoll();
  assert.equal(desk.said(desk.el('kitSwitcher')),
    'Switcher not connected yet at 10.0.100.40. The desk keeps trying by itself.');
  assert.deepEqual(problems(desk), [refused], 'not "check the cable": the cable is fine');

  // The same refusal while the desk searches (no typed address): a switcher
  // that is plainly there is not "not used on this setup".
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'searching', host: null, error: refused };
  await desk.repoll();
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn');
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher not connected. The desk keeps trying by itself.');
  assert.deepEqual(problems(desk), [refused]);
  // An address typed wrong says where it was typed.
  const typo = '"10.0.100" is not a switcher address. Type four numbers with dots, like 10.0.100.40 '
    + '(ATEM Setup shows it under Network).';
  for (const state of ['searching', 'off']) {
    desk.answers['/api/atem'] = { ...ATEM_UP, state, host: null, error: typo };
    await desk.repoll();
    assert.equal(desk.said(desk.el('kitSwitcher')),
      'Switcher not connected: the address typed for it is not a switcher address.', state);
    assert.deepEqual(problems(desk), [`The switcher address on the Event settings page: ${typo}`], state);
  }
  // But a search that simply found nothing is a kit with no switcher: gray.
  desk.answers['/api/atem'] = { ...ATEM_UP, state: 'searching', host: null, error: 'No ATEM switcher answered on '
    + '10.0.100.x (253 addresses tried). Check that it is powered on and plugged into the same network as this '
    + 'computer, or type its address on the settings page. Searching again in 60 s.' };
  await desk.repoll();
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'off');
  assert.deepEqual(problems(desk), []);
});

test("the switcher row reads the switcher watcher's real words, not a copy of them", async () => {
  // The strip tells a refusal and a mistyped address (amber, somebody's to
  // fix) from a search that found nothing (gray) by the watcher's words.
  // These come from the watcher itself, never started, so nothing touches
  // the network: if it rewords them, this fails rather than the strip going
  // quietly gray.
  const desk = await openDesk({ stream: NO_OBS });
  for (const typed of ['10.0.100', '10.0.100.40:80']) {
    const w = new AtemWatcher({ discover: false });
    w.setHost(typed);
    const st = w.status;
    assert.ok(st.error, `the watcher has words for "${typed}"`);
    desk.answers['/api/atem'] = st;
    await desk.repoll();
    assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn', typed);
    assert.deepEqual(problems(desk), [`The switcher address on the Event settings page: ${st.error}`], typed);
    await w.stop();
  }
  const src = readFileSync(fileURLToPath(new URL('./atem/watcher.ts', import.meta.url)), 'utf8');
  assert.match(src, /turned the desk down/, 'the refusal the strip names');
  assert.match(src, /`No answer from the switcher at /, 'the no-answer the strip names');
});

test("without /api/atem the switcher row is the doors check's, in its words", async () => {
  const desk = await openDesk({ stream: NO_OBS, answers: { '/api/vitals': vitalsWith(
    { id: 'switcher', label: 'Switcher', level: 'ok',
      detail: 'ATEM Constellation 8K at 10.0.100.40 running 1080p59.94. Program: Camera 2. Keyed on air: DSK1 (Graphics PC).' },
  ) } });
  assert.equal(desk.said(desk.el('kitSwitcher')), 'Switcher ATEM Constellation 8K at 10.0.100.40 running '
    + '1080p59.94. Program: Camera 2. Keyed on air: DSK1 (Graphics PC).');
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'ok');
  assert.deepEqual(problems(desk), []);

  await check(desk, { id: 'switcher', label: 'Switcher', level: 'warn',
    detail: 'lost the switcher at 10.0.100.40, so what is on air is unknown.',
    fix: 'Check the switcher is on and its network cable is in.' });
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'warn');
  assert.deepEqual(problems(desk), ['On the switcher: Check the switcher is on and its network cable is in.']);

  await check(desk, { id: 'switcher', label: 'Switcher', level: 'off',
    detail: 'No video switcher found on the network. Fine if this setup has none.' });
  assert.equal(desk.el('kitSwitcher').dataset['l'], 'off', 'gray, never red');
  assert.deepEqual(problems(desk), []);

  // The live answer, once there is one, wins over the thirty-second check.
  desk.answers['/api/atem'] = ATEM_UP;
  await desk.repoll();
  assert.match(desk.said(desk.el('kitSwitcher')),
    /^Switcher ATEM Constellation 8K at 10\.0\.100\.40, 1080p59\.94\. On air: Camera 2\./);
});

test('the access codes show only while they still need changing, with the way to change them', async () => {
  // On the desk laptop, opened by a local name, as the launcher opens it.
  const desk = await openDesk({ stream: NO_OBS, host: 'localhost:8080' });
  await desk.send(snapshot(deskAfter(fieldUp)));
  await check(desk, { id: 'codes', label: 'Access codes', level: 'ok', detail: 'all three changed from the shipped defaults' });
  assert.equal(desk.off(desk.el('kitCodes')), true);

  await check(desk, { id: 'codes', label: 'Access codes', level: 'warn',
    detail: 'still on the shipped default: desk PIN, awards code. Anyone with a copy of this software knows '
      + 'the awards code, so it leaks winners before the ceremony. Change it for a real event.' });
  assert.equal(desk.said(desk.el('kitCodes')), 'Access codes still the shipped desk PIN, awards code, which '
    + 'anyone with a copy of this software knows. Change the codes');
  const link = desk.el('kitCodes').querySelector('a')!;
  assert.equal(link.getAttribute('href'), '/s/setup#codes', 'straight to the codes, once unlocked');
  assert.equal(link.textContent, 'Change the codes');
  assert.equal(desk.el('kitCodes').dataset['l'], 'warn');

  await check(desk, { id: 'codes', label: 'Access codes', level: 'fail',
    detail: 'The desk PIN is empty, so every control surface is open to anyone on the venue Wi-Fi.' });
  assert.equal(desk.said(desk.el('kitCodes')),
    'Access codes the desk PIN is empty, so anyone who can reach this desk can run the show. Change the codes');
  assert.equal(desk.el('kitCodes').dataset['l'], 'fail');

  // The empty PIN that is no open door, on a desk only this machine can
  // reach: gray, and in the row's own words, which say why.
  const own = 'The desk PIN is empty, but the desk only answers on this machine (127.0.0.1), '
    + 'so nobody on the venue Wi-Fi can reach it.';
  await check(desk, { id: 'codes', label: 'Access codes', level: 'off', detail: own });
  assert.equal(desk.said(desk.el('kitCodes')), `Access codes ${own} Change the codes`);
  assert.equal(desk.el('kitCodes').dataset['l'], 'off');

  // Which codes are still the shipped ones is for the desk laptop only (the
  // shipped awards code opens the winners): a console at another computer,
  // or one on the desk laptop opened by its network address, never
  // headlines it, whatever the doors check answers.
  const defaults = { id: 'codes', label: 'Access codes', level: 'warn',
    detail: 'still on the shipped default: desk PIN, awards code. Change them.' };
  for (const host of ['10.0.100.10:8080', 'desk.test', 'localhost.evil.example:8080']) {
    const other = await openDesk({ stream: NO_OBS, host });
    await other.send(snapshot(deskAfter(fieldUp)));
    await check(other, defaults);
    assert.equal(other.off(other.el('kitCodes')), true, host);
    assert.doesNotMatch(other.said(other.el('kit')), /shipped|Change the codes/, host);
  }
  for (const host of ['127.0.0.1:8080', '[::1]:8080', 'localhost']) {
    const own = await openDesk({ stream: NO_OBS, host });
    await check(own, defaults);
    assert.equal(own.off(own.el('kitCodes')), false, host);
  }
});

test('a desk that records nothing folds away the replay, video and referee controls, and the keys still work', async () => {
  const REC = ['Mark a moment for replay', 'Make a video of a ceremony', 'Match videos: any missing?',
    'Videos waiting to upload'];
  const navOn = (desk: Desk) => desk.html.querySelectorAll('.opnav a').filter(a => !desk.off(a))
    .map(a => a.getAttribute('href'));
  const desk = await openDesk({ storage: { 'desk.view': 'everything' }, stream: NO_OBS });
  assert.equal(desk.html.dataset['recording'], undefined, 'not known yet: everything as before');
  for (const p of REC) assert.ok(desk.panels().includes(p), p);

  // The doors check's words for a desk with neither half of recording set up.
  await check(desk, { id: 'recorder', label: 'Recording', level: 'off',
    detail: 'not used on this setup: this desk records no cameras, so its replay and match video tools have '
      + 'nothing to cut (ffmpeg is not installed, and no cameras are listed under "recording" in config.json)' });
  assert.equal(desk.html.dataset['recording'], 'off');
  for (const p of REC) assert.ok(!desk.panels().includes(p), `${p} is folded away`);
  assert.ok(desk.panels().includes('YouTube chapters for the day'), 'the stream chapters need no recording');
  assert.deepEqual(navOn(desk), ['/s/desk', '/s/media']);
  await desk.press(' ');
  assert.deepEqual(desk.emits.map(e => e.type), ['replay.marker'], 'Space still marks a moment');

  // A recorder that is set up but failing keeps its controls: its row says
  // what broke. So does a gray row that is a setup half done, or a recorder
  // that failed to start: clips cut before a restart still wait in the
  // upload queue, and only these controls release them.
  for (const row of [
    { level: 'fail', detail: '1 of 2 source(s) stopped: cam2' },
    { level: 'off', detail: 'not running, though ffmpeg is installed and config.json lists cameras: '
      + 'desk-log.txt says why (a camera entry it could not use, a recorder that failed to start, or '
      + 'ffmpeg installed after the desk started). Fix that, then restart the desk.' },
    { level: 'off', detail: 'not running: ffmpeg is not installed on this laptop, so there are no replays or match videos' },
    { level: 'off', detail: 'not running: no cameras are listed under "recording" in config.json, so there are '
      + 'no replays or match videos' },
  ]) {
    await check(desk, { id: 'recorder', label: 'Recording', ...row });
    assert.equal(desk.html.dataset['recording'], 'on', row.detail);
    for (const p of REC) assert.ok(desk.panels().includes(p), p);
    assert.deepEqual(navOn(desk), ['/s/desk', '/s/replay', '/s/var', '/s/media']);
  }
});

test('the strip survives answers it does not expect, and never stops the page', async () => {
  const desk = await openDesk({ stream: NO_OBS, answers: {
    '/api/atem': { state: 'connected', program: 2, keyers: null, inputs: 'nope', videoMode: null },
    '/api/screens': { screens: 'nope' },
    '/api/info': { field: 'nope' },
  } });
  assert.equal(desk.said(desk.el('kitSwitcher')),
    'Switcher ATEM switcher. On air: input 2. No overlay keyer is on air.');
  assert.equal(desk.off(desk.el('kitGraphics')), true, 'a list that is not a list says nothing');
  for (const atem of ['nonsense', null, 42, { state: 7 }]) {
    desk.answers['/api/atem'] = atem;
    await desk.repoll();
    assert.equal(desk.off(desk.el('kitSwitcher')), true, JSON.stringify(atem));
  }
  desk.answers['/api/screens'] = { screens: [null, 7, screen({ addr: null, full: false, sw: 'x' })] };
  await desk.repoll();
  assert.match(problems(desk)[0] ?? '', /^The graphics on a computer the desk cannot name are not full screen/);
  // And the page still works: a key still sends.
  await desk.press('b');
  assert.deepEqual(desk.emits.map(e => e.type), ['screen.change']);
});

// ---- the words ---------------------------------------------------------------------

test('every panel says what it is for, in words a volunteer uses', () => {
  // No "surface", the internal word for a page; no bare handbook chapter as
  // the only help. Comments are for the next developer, so only what a
  // volunteer can read is checked: the markup outside comments, scripts and
  // styles, and the string literals desk.js paints.
  const docRoot = new El('#document');
  parseInto(docRoot, PAGE);
  const body = docRoot.querySelector('body')!;
  const elements = body.descendants().filter(e => e.localName !== 'script' && e.localName !== 'style');
  const visible = elements
    .flatMap(e => [
      ...e.childNodes.filter((n): n is Txt => n instanceof Txt).map(n => n.data),
      // A tooltip or a grey example is read too.
      ...['title', 'placeholder', 'aria-label'].map(a => e.getAttribute(a) ?? ''),
    ])
    .join(' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(visible, /\bsurfaces?\b/i);
  assert.doesNotMatch(visible, /bridge/i, 'the field is connected, not bridged');
  assert.doesNotMatch(visible, /\brender\b/i, 'the telestrator puts up a drawing');
  // The delay card is called that on its own panel; the Sample data card
  // named it the old way, and named the countdown "the timer".
  assert.doesNotMatch(visible, /status card|the timer\b/i);
  const literals = DESK_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .match(/'[^'\n]*'|`[^`]*`/g) ?? [];
  for (const s of literals) {
    assert.doesNotMatch(s, /render surface/i, s);
    // The row is "Main screen (program)", so the console says main screen.
    assert.doesNotMatch(s, /program screen|\bon program\b|over program\b/i, s);
    if (/handbook chapter/.test(s)) assert.match(s, /config\.json/, `a chapter number is never the only help: ${s}`);
  }

  // The run of show is this console's own list. It promised that the side
  // screens counted down to it, and no screen reads it at all: only this
  // console and Event settings (which builds it) mention it. Should a screen
  // ever start to, this fails and the panel's words want changing with it.
  const readers = readdirSync(SURFACES, { recursive: true, encoding: 'utf8' })
    .filter(f => /\.(html|js)$/.test(f) && !/^(desk|setup)[\\/]/.test(f))
    .filter(f => /rundown|run of show/i.test(readFileSync(join(SURFACES, f), 'utf8')));
  assert.deepEqual(readers, [], 'no screen reads the run of show');
  const rundown = docRoot.querySelector('#sec-rundown')!;
  const rundownWords = rundown.querySelectorAll('p').map(p => p.textContent).join(' ').replace(/\s+/g, ' ');
  assert.match(rundownWords, /no screen shows it/);
  assert.doesNotMatch(rundownWords, /screens? count/i);

  // Every panel has a heading, or is the one-line OBS stand-in.
  for (const s of body.querySelectorAll('.grid section')) {
    assert.ok(s.querySelector('h2') || s.id === 'sec-obs', `a panel with no heading: ${s.textContent.slice(0, 60)}`);
  }
});
