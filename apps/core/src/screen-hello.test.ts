/**
 * Every screen tells the desk what it is: the hello frame, from the real
 * shared client.
 *
 * The desk can only say "the projector is at 30 Hz" or "the switcher input
 * is not full screen" or "the program is showing the field's own score" if
 * each screen reports it, so nobody has to walk over to a display and look.
 * Every page that uses desk-client.js sends one after its socket opens, and
 * again, a second after things stop changing, whenever what it would say
 * can have changed. It never waits for an answer: an older desk ignores a
 * frame type it does not know.
 *
 * helloFrame is run directly against made-up windows; then the client is
 * driven over a stand-in socket, with the animation frames and the window's
 * events in the test's hands (the same arrangement as
 * desk-client-signin.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHello } from './screens.ts';

type Frame = Record<string, unknown>;
interface Client extends EventTarget {
  setShowing(v: unknown): void;
  setBackup(v: unknown): void;
  authenticate(pin: string): void;
  readonly heardAt: number | null;
  readonly synced: boolean;
}
interface Mod {
  connect: (name: string) => Client;
  helloFrame: (win: unknown, o?: { surface?: unknown; showing?: unknown; hz?: unknown; backup?: unknown }) => Frame;
  hzOf: (frames: number, spanMs: number) => number | null;
}
// @ts-expect-error untyped browser module, cast on the same line
const shared = (await import('../../../surfaces/_shared/desk-client.js')) as Mod;

/**
 * The C1 contract, in order, then backup: whether a program's stand-in for
 * the field is ready (program.js). backup is an addition a desk that does
 * not know it drops, keeping the rest (proven below against the real
 * validateHello). Nothing more ever goes out, and nothing less.
 */
const C1_KEYS = ['t', 'surface', 'key', 'embedded', 'full', 'w', 'h', 'sw', 'sh', 'dpr', 'hz', 'showing', 'backup'];

const win = (over: Record<string, unknown> = {}, key?: string) => {
  const self = {};
  return {
    self, top: self,
    innerWidth: 1920, innerHeight: 1080, screen: { width: 1920, height: 1080 }, devicePixelRatio: 1,
    document: { fullscreenElement: null, documentElement: { dataset: key ? { key } : {} } },
    matchMedia: () => ({ matches: false }),
    ...over,
  };
};

// ---- the frame itself ---------------------------------------------------------

test('the hello frame says what the screen is, in exactly the agreed fields', () => {
  const f = shared.helloFrame(win({}, 'luma'), { surface: 'program', showing: 'desk', hz: 60, backup: 'ready' });
  assert.deepEqual(Object.keys(f), C1_KEYS);
  assert.deepEqual(f, {
    t: 'hello', surface: 'program', key: 'luma', embedded: false, full: true,
    w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', backup: 'ready',
  });
  for (const word of ['none', 'ready', 'bad']) {
    assert.equal(shared.helloFrame(win(), { backup: word }).backup, word);
  }
  for (const odd of [undefined, null, 'READY', 'good', 1, true]) {
    assert.equal(shared.helloFrame(win(), { backup: odd }).backup, null, `only the three words: ${String(odd)}`);
  }

  // F11 leaves a window the size of the screen and no fullscreenElement:
  // that is full. A maximized window, with the taskbar and the tabs, is not.
  const maximized = shared.helloFrame(win({ innerWidth: 1920, innerHeight: 945 }));
  assert.equal(maximized.full, false);
  assert.equal(shared.helloFrame(win({ innerWidth: 1920, innerHeight: 945,
    document: { fullscreenElement: {}, documentElement: { dataset: {} } } })).full, true, 'the Fullscreen API');
  assert.equal(shared.helloFrame(win({ innerWidth: 1280, innerHeight: 700,
    matchMedia: (q: string) => ({ matches: q === '(display-mode: fullscreen)' }) })).full, true, 'the browser says so');
  // Windows display scaling: a 1920 panel at 150% is 1280 CSS pixels each way.
  const scaled = shared.helloFrame(win({ innerWidth: 1280, innerHeight: 720,
    screen: { width: 1280, height: 720 }, devicePixelRatio: 1.5 }));
  assert.equal(scaled.full, true);
  assert.equal(scaled.dpr, 1.5);
  assert.equal(shared.helloFrame(win({ devicePixelRatio: 1.2500001 })).dpr, 1.25, 'two places');

  // Framed (/s/watch), and a page with no key (a console).
  assert.equal(shared.helloFrame(win({ top: {} })).embedded, true);
  assert.equal(shared.helloFrame(win()).key, null);
  assert.equal(shared.helloFrame(win({}, 'green')).key, null, 'only a real mode');

  // Only what it should be, whatever it was handed.
  const odd = shared.helloFrame(win({ innerWidth: Number.NaN, innerHeight: -5, screen: undefined,
    devicePixelRatio: 'x' }), { surface: 'x'.repeat(100), showing: 'the desk', hz: 59.94 });
  assert.equal(odd.w, 0);
  assert.equal(odd.h, 0);
  assert.equal(odd.sw, 0);
  assert.equal(odd.dpr, 1);
  assert.equal((odd.surface as string).length, 32, 'the longest name the desk takes');
  assert.equal(shared.helloFrame(win({ innerWidth: 99_999 })).w, 32_768, 'the largest size it takes');
  assert.equal(odd.showing, null);
  assert.equal(odd.hz, null, 'a rate is a whole number, measured');
  assert.equal(odd.full, false);
  assert.deepEqual(Object.keys(odd), C1_KEYS);
  // A window that throws on the questions is reported as not full screen,
  // and the page carries on.
  const touchy = win({ matchMedia: () => { throw new Error('no'); } });
  assert.equal(shared.helloFrame(touchy).full, false);
});

test('the refresh rate is frames over time, rounded, or nothing', () => {
  assert.equal(shared.hzOf(120, 2000), 60);
  assert.equal(shared.hzOf(119, 1985.3), 60, '59.94 Hz video reads 60');
  assert.equal(shared.hzOf(60, 2000), 30, 'a projector at 30');
  assert.equal(shared.hzOf(0, 2000), null);
  assert.equal(shared.hzOf(10, 0), null);
  assert.equal(shared.hzOf(5000, 2), null, 'nonsense is not a rate');
});

// ---- the client sending it ------------------------------------------------------

async function page({ throwOnSend = false } = {}) {
  const g = globalThis as unknown as Record<string, unknown>;
  const names = ['location', 'WebSocket', 'fetch', 'document', 'requestAnimationFrame', 'cancelAnimationFrame',
    'addEventListener', 'innerWidth', 'innerHeight', 'screen', 'devicePixelRatio', 'matchMedia', 'self', 'top'];
  const saved = Object.fromEntries(names.map(n => [n, g[n]]));
  const sockets: { onopen: (() => void) | null; onclose: (() => void) | null; sent: string[]; readyState: number }[] = [];
  class FakeWS {
    static OPEN = 1;
    // Connecting until the test opens it, as a real socket is.
    readyState = 0;
    onopen: (() => void) | null = null; onclose: (() => void) | null = null;
    onmessage: unknown = null; onerror: unknown = null;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(data: string): void { if (throwOnSend) throw new Error('socket refused'); this.sent.push(data); }
    close(): void {}
  }
  const docListeners = new Map<string, (() => void)[]>();
  const winListeners = new Map<string, (() => void)[]>();
  const listen = (map: Map<string, (() => void)[]>) => (type: string, fn: () => void) => {
    map.set(type, [...(map.get(type) ?? []), fn]);
  };
  const frames: ((t: number) => void)[] = [];
  const doc = { hidden: false, fullscreenElement: null as unknown,
    documentElement: { dataset: { key: 'fill' } }, addEventListener: listen(docListeners) };
  g['location'] = { pathname: '/s/side', search: '', host: 'desk.test', protocol: 'http:' };
  g['WebSocket'] = FakeWS;
  g['fetch'] = async () => ({ ok: false });
  g['document'] = doc;
  g['requestAnimationFrame'] = (fn: (t: number) => void) => { frames.push(fn); return frames.length; };
  g['cancelAnimationFrame'] = () => { frames.length = 0; };
  g['addEventListener'] = listen(winListeners);
  g['innerWidth'] = 1920; g['innerHeight'] = 1080;
  g['screen'] = { width: 1920, height: 1080 };
  g['devicePixelRatio'] = 1;
  g['matchMedia'] = () => ({ matches: false });
  delete g['self']; delete g['top'];

  const tag = Math.random().toString(36).slice(2);
  const mod = (await import(`../../../surfaces/_shared/desk-client.js?${tag}`)) as Mod;
  // The liveness watchdog would keep this process alive; a truthy id, so a
  // redial does not start a real one either.
  const realInterval = g['setInterval'];
  g['setInterval'] = () => -1;
  const client = mod.connect('side');
  g['setInterval'] = realInterval;

  let clock = 1000;
  return {
    client, doc, sockets,
    hellos: (): Frame[] => sockets.flatMap(s => s.sent).map(d => JSON.parse(d) as Frame).filter(m => m['t'] === 'hello'),
    open: () => { const s = sockets.at(-1)!; s.readyState = 1; s.onopen!(); },
    close: () => { const s = sockets.at(-1)!; s.readyState = 3; s.onclose!(); },
    fire: (where: 'doc' | 'win', type: string) => {
      for (const fn of (where === 'doc' ? docListeners : winListeners).get(type) ?? []) fn();
    },
    /** Animation frames at `hz` for `ms`, as a visible browser would run them. */
    frames: (hz: number, ms: number) => {
      const end = clock + ms;
      while (clock < end && frames.length) {
        clock += 1000 / hz;
        for (const fn of frames.splice(0)) fn(clock);
      }
    },
    pending: () => frames.length,
    restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } },
  };
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

test('a screen says hello when its socket opens, then again a second after anything changes', async () => {
  const p = await page();
  try {
    assert.deepEqual(p.hellos(), [], 'nothing before the socket opens');
    p.open();
    const first = p.hellos();
    assert.equal(first.length, 1, 'at once on open, before anything waits on it');
    assert.deepEqual(first[0], {
      t: 'hello', surface: 'side', key: 'fill', embedded: false, full: true,
      w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: null, showing: null, backup: null,
    }, 'no rate yet: it is still being measured');

    // Two seconds of frames at 60: the rate, reported once it is known.
    assert.ok(p.pending() > 0, 'measuring from the first frame');
    p.frames(60, 2100);
    assert.equal(p.pending(), 0, 'measured once, then it stops asking for frames');
    await settle(1150);
    assert.equal(p.hellos().length, 2);
    assert.equal(p.hellos()[1]!['hz'], 60);

    // A burst of resizes (a window dragged to the projector) is one report.
    (globalThis as unknown as Record<string, unknown>)['innerHeight'] = 945;
    p.fire('win', 'resize'); p.fire('win', 'resize'); p.fire('win', 'resize');
    await settle(400);
    assert.equal(p.hellos().length, 2, 'it waits for the window to settle');
    await settle(800);
    assert.equal(p.hellos().length, 3, 'then says it once');
    assert.equal(p.hellos()[2]!['full'], false, 'no longer filling the screen');
    // The new display may run at another rate, so it measures again.
    p.frames(30, 2100);
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['hz'], 30);

    // Full screen by the Fullscreen API.
    p.doc.fullscreenElement = {};
    p.fire('doc', 'fullscreenchange');
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['full'], true);

    // Hidden: no frames, so no rate, rather than a number from before.
    p.doc.hidden = true;
    p.fire('doc', 'visibilitychange');
    assert.equal(p.pending(), 0, 'no frames asked of a hidden page');
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['hz'], null);
    p.doc.hidden = false;
    p.fire('doc', 'visibilitychange');
    p.frames(60, 2100);
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['hz'], 60, 'shown again: measured again');

    // What a program is showing, when it says.
    const before = p.hellos().length;
    p.client.setShowing('cheesy');
    p.client.setShowing('cheesy');
    await settle(1150);
    assert.equal(p.hellos().length, before + 1, 'once for one change');
    assert.equal(p.hellos().at(-1)!['showing'], 'cheesy');
    p.client.setShowing('the desk');
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['showing'], null, 'only the two words it can be');

    // Whether its stand-in for the field is ready, the same way.
    const then = p.hellos().length;
    p.client.setBackup('bad');
    p.client.setBackup('bad');
    await settle(1150);
    assert.equal(p.hellos().length, then + 1, 'once for one change');
    assert.equal(p.hellos().at(-1)!['backup'], 'bad');
    p.client.setBackup('broken');
    await settle(1150);
    assert.equal(p.hellos().at(-1)!['backup'], null, 'only the three words it can be');

    // The PIN never rides along, whatever the page holds.
    p.client.authenticate('4826');
    for (const h of p.hellos()) assert.deepEqual(Object.keys(h), C1_KEYS);
    assert.doesNotMatch(JSON.stringify(p.hellos()), /4826/);

    // Closed: nothing is sent into a dead socket; the next open says it all.
    p.close();
    const count = p.hellos().length;
    p.fire('win', 'resize');
    await settle(1150);
    assert.equal(p.hellos().length, count, 'no socket, no report');
    p.open();
    assert.equal(p.hellos().length, count + 1);
    assert.equal(p.hellos().at(-1)!['showing'], null);
  } finally {
    p.restore();
  }
});

test('the desk as it stands takes the frame whole, backup and all, and keeps only what it knows', () => {
  for (const backup of [null, 'none', 'ready', 'bad']) {
    const f = shared.helloFrame(win({}, 'luma'), { surface: 'program', showing: 'cheesy', hz: 60, backup });
    const kept = validateHello(f);
    assert.ok(kept, `a frame with backup ${String(backup)} is not dropped`);
    assert.equal(kept.showing, 'cheesy');
    assert.equal(kept.key, 'luma');
  }
});

test('a socket that refuses the report changes nothing else', async () => {
  const p = await page({ throwOnSend: true });
  try {
    let linked = false;
    p.client.addEventListener('link', e => { linked = (e as CustomEvent).detail === true; });
    assert.doesNotThrow(() => p.open());
    assert.equal(linked, true, 'the page still hears that it is linked');
    p.fire('win', 'resize');
    await settle(1150);
    assert.equal(p.hellos().length, 0);
  } finally {
    p.restore();
  }
});
