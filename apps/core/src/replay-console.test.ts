/**
 * The replay console's keys, driven for real: surfaces/replay/replay.js, fed
 * by the real shared client (desk-client.js) over a stand-in socket, with a
 * desk state built by the real reducer.
 *
 * replay.js is DOM code whose imports are server paths, so, as the program
 * overlay's test does, this copies it to a temp file with those paths
 * pointed at the same files on disk and nothing else changed, and gives it
 * the browser globals it touches: a document whose elements only remember
 * what was done to them, a socket, and a fetch that answers the console's
 * reads and holds each cut open until the test answers it.
 *
 * The console is used hardest in the sixty seconds after a match, and a key
 * held a moment too long auto-repeats at about thirty a second. Every repeat
 * of Enter was a cut, and every cut an ffmpeg encode on the desk laptop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventBus } from './bus.ts';

const SURFACES = fileURLToPath(new URL('../../../surfaces/', import.meta.url));

interface FakeEl {
  id: string;
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
  children: FakeEl[];
  listeners: Map<string, (e: unknown) => void>;
  onclick: (() => unknown) | null;
  [rest: string]: unknown;
}

interface Key { key: string; repeat?: boolean }

interface Emitted { type: string; payload?: { takeId?: string } }

interface Console {
  el: (id: string) => FakeEl;
  /** Every POST to /api/clips, in order, each with a way to answer it, or refuse it. */
  cuts: { body: unknown; answer: (clip: unknown, good?: boolean) => Promise<void> }[];
  /** Every event this console put on the bus. */
  emits: Emitted[];
  press: (k: Key) => Promise<void>;
  send: (msg: unknown) => Promise<void>;
  open: () => Promise<void>;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
};

async function openConsole(): Promise<Console> {
  const g = globalThis as unknown as Record<string, unknown>;
  const els = new Map<string, FakeEl>();
  const make = (id: string): FakeEl => {
    const attrs = new Set<string>();
    const node: FakeEl = {
      id, textContent: '', innerHTML: '', value: '', disabled: false, children: [],
      listeners: new Map(), onclick: null,
      style: {}, dataset: {}, className: '', src: '',
      addEventListener(type: string, fn: (e: unknown) => void) { node.listeners.set(type, fn); },
      toggleAttribute(n: string, on?: boolean) { if (on ?? !attrs.has(n)) attrs.add(n); else attrs.delete(n); },
      setAttribute(n: string) { attrs.add(n); },
      hasAttribute(n: string) { return attrs.has(n); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 40 }),
      prepend(child: FakeEl) { node.children.unshift(child); },
      append() {}, replaceChildren() {}, remove() {}, focus() {},
      contains: () => false, querySelector: () => null,
      get lastChild() { return node.children.at(-1) ?? null; },
      parentElement: { appendChild() {} },
    };
    return node;
  };
  const el = (id: string): FakeEl => {
    let node = els.get(id);
    if (!node) { node = make(id); els.set(id, node); }
    return node;
  };
  el('src').value = 'program';
  el('speed').value = '0.5';

  const cuts: Console['cuts'] = [];
  g['fetch'] = async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown) => ({ ok: true, json: async () => body });
    if (url === '/api/recorder') {
      return ok({ available: true, encoder: 'test', sources: [{ id: 'program', label: 'Program', running: true }] });
    }
    if (url === '/api/markers') return ok([]);
    if (url === '/api/clips' && init?.method === 'POST') {
      return new Promise(resolve => {
        cuts.push({
          body: JSON.parse(init.body ?? '{}'),
          answer: async (clip, good = true) => {
            resolve({ ok: good, json: async () => clip });
            await flush();
          },
        });
      });
    }
    // The REST head start and anything else: the socket is the path in.
    return { ok: false, json: async () => ({}) };
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

  let keydown: ((e: unknown) => void) | null = null;
  g['location'] = { pathname: '/s/replay', search: '', host: 'desk.test', protocol: 'http:' };
  g['WebSocket'] = FakeWS;
  g['document'] = {
    hidden: false, activeElement: null, documentElement: make('html'),
    getElementById: el, createElement: () => make(''), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  g['requestAnimationFrame'] = () => 0;
  g['cancelAnimationFrame'] = () => {};
  g['addEventListener'] = (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') keydown = fn; };

  // The page as served, with its server paths pointed at the files behind them.
  const source = await readFile(join(SURFACES, 'replay', 'replay.js'), 'utf8');
  const local = source.replace(/from '\/(shared|s\/replay)\/([\w.-]+)'/g, (_m, dir: string, file: string) =>
    `from '${pathToFileURL(join(SURFACES, dir === 'shared' ? '_shared' : 'replay', file)).href}'`);
  assert.doesNotMatch(local, /from '\//, 'every server path in replay.js was pointed at a file');
  const dir = await mkdtemp(join(tmpdir(), 'cg-replay-'));
  const file = join(dir, 'replay.mjs');
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
  assert.ok(keydown, 'the page listens for its keys');

  return {
    el, cuts, emits,
    press: async ({ key, repeat = false }) => {
      keydown!({
        key, repeat, ctrlKey: false, metaKey: false, altKey: false,
        target: { closest: () => null }, preventDefault() {},
      });
      await flush();
    },
    send: async msg => { sockets[0]!.onmessage!({ data: JSON.stringify(msg) }); await flush(); },
    open: async () => { sockets[0]!.onopen!(); await flush(); },
  };
}

/** A match the desk has seen start, so the timeline maps onto wall time. */
function startedMatch() {
  const bus = new EventBus();
  const at = Date.now() - 3 * 60_000;
  bus.emit({ type: 'match.loaded', source: 'cheesy', ts: at - 60_000,
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] } });
  bus.emit({ type: 'match.start', source: 'cheesy', ts: at });
  bus.emit({ type: 'match.end', source: 'cheesy', ts: at + 163_000 });
  return bus.state;
}

const clip = (n: number) => ({
  url: `/clips/Qualification_42-0140-19000${n}-05x.mp4`, label: `Qualification 42-0140 #${n}`,
  seconds: 20, speed: 0.5, sourceId: 'program', ranges: [{ fromMs: 1, toMs: 10_001 }],
});

test('a held or repeated key starts one cut, and a cut in flight takes no second one', { timeout: 60_000 }, async () => {
  const page = await openConsole();
  await page.send({ t: 'hb', now: Date.now() });
  await page.send({ t: 'snapshot', state: startedMatch(), media: {}, needsPin: false });
  await page.open();

  // An in-point a minute into teleop, as a click on the timeline sets it.
  page.el('track').listeners.get('pointerdown')!({ clientX: 500 });

  // Enter, held: one keydown, then the auto-repeat.
  await page.press({ key: 'Enter' });
  for (let i = 0; i < 30; i++) await page.press({ key: 'Enter', repeat: true });
  assert.equal(page.cuts.length, 1, 'one cut for one press, however long it was held');
  assert.equal(page.el('cut').disabled, true, 'and the button says a cut is under way');
  assert.equal(page.el('status').textContent, 'Cutting...');

  // Pressed again, by key and by button, while the slow-motion encode runs.
  await page.press({ key: 'Enter' });
  // Not awaited: a cut that did start would wait on an answer that never comes.
  void page.el('cut').onclick!();
  await flush();
  assert.equal(page.cuts.length, 1, 'a second press waits for the first cut to answer');

  await page.cuts[0]!.answer(clip(1));
  assert.match(page.el('status').textContent, /^Ready/);
  assert.equal(page.el('cut').disabled, false);
  // The key still held after the answer is still the same press.
  await page.press({ key: 'Enter', repeat: true });
  assert.equal(page.cuts.length, 1, 'a repeat never starts a cut');

  // A new press once it has answered is a new cut.
  await page.press({ key: 'Enter' });
  assert.equal(page.cuts.length, 2);
  await page.cuts[1]!.answer(clip(2));
  // A refused cut frees the console too.
  await page.press({ key: 'Enter' });
  assert.equal(page.cuts.length, 3);
  await page.cuts[2]!.answer({ error: 'No recorded footage for "program".' }, false);
  assert.equal(page.el('status').textContent, 'No recorded footage for "program".');
  assert.equal(page.el('cut').disabled, false);
  await page.press({ key: 'Enter' });
  assert.equal(page.cuts.length, 4, 'and the next press cuts');
  await page.cuts[3]!.answer(clip(3));

  // Take, held: one replay.play, not one per repeat, each of which restarted
  // the clip in OBS from the top.
  await page.press({ key: 't' });
  for (let i = 0; i < 20; i++) await page.press({ key: 't', repeat: true });
  assert.deepEqual(page.emits.map(e => e.type), ['replay.play'], 'one Take for one press');
  // The desk's answer, which also stops the console waiting on it.
  const takeId = page.emits[0]!.payload?.takeId;
  await page.send({ t: 'event', state: startedMatch(),
    ev: { type: 'replay.on_air', source: 'cue', payload: { takeId, seconds: 20 } } });
  assert.match(page.el('status').textContent, /^On program/);
});
