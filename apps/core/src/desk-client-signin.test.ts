import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A signed-out console goes to sign in; an open screen never does.
 *
 * After a desk restart (a new session) or an expired sign-in, a console's
 * socket reconnected and read "linked" while every gated read failed in
 * silence: the announcer's card flags froze and the desk's panels went stale.
 * The shared client now asks the server about its own page on every snapshot
 * and goes to /signin only when the server would send it there. The other
 * half of that sentence is the one that matters on air: the program overlay
 * and the venue TVs share this client, and a sign-in form on the stream is
 * the worst thing this fix could do.
 *
 * desk-client.js is a browser module, so the few globals it touches are
 * stubbed and the real module is driven (the same arrangement as
 * roll.test.ts). Each case imports its own copy, because the redirect latch
 * is module state, exactly as it is per page in a browser.
 */

interface FakeSocket { onmessage: ((e: { data: string }) => void) | null; readyState: number }
interface Client extends EventTarget { authenticate(pin: string): void }

async function page(path: string, opts: { gated: boolean }) {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    location: g['location'], WebSocket: g['WebSocket'], fetch: g['fetch'], setInterval: g['setInterval'],
  };
  const sockets: FakeSocket[] = [];
  const heads: string[] = [];
  const replaced: string[] = [];
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    onmessage: FakeSocket['onmessage'] = null;
    onopen: unknown = null; onclose: unknown = null; onerror: unknown = null;
    constructor() { sockets.push(this); }
    send(): void {}
    close(): void {}
  }
  g['location'] = {
    pathname: path, search: '', host: 'desk.test', protocol: 'http:',
    replace: (to: string) => { replaced.push(to); },
  };
  g['WebSocket'] = FakeWS;
  g['fetch'] = async (url: string, init?: { method?: string }) => {
    if (init?.method === 'HEAD') {
      heads.push(url);
      // What the server does: a gated page without a valid session is sent
      // to /signin; an open page is simply served.
      return opts.gated
        ? { redirected: true, url: `http://desk.test/signin?next=${encodeURIComponent(url)}` }
        : { redirected: false, url: `http://desk.test${url}` };
    }
    return { ok: false };
  };
  // The liveness watchdog would keep this test process alive forever.
  g['setInterval'] = () => 0;

  const tag = `${path.replace(/\W/g, '')}${Math.random().toString(36).slice(2)}`;
  // A computed specifier, so TypeScript does not resolve the untyped module;
  // the cast on the next line is the whole of its type.
  const mod = (await import(`../../../surfaces/_shared/desk-client.js?${tag}`)) as
    { connect: (name: string) => Client };
  const client = mod.connect('test');
  g['setInterval'] = saved['setInterval'];
  const denied: unknown[] = [];
  client.addEventListener('denied', e => denied.push((e as CustomEvent).detail));

  const snapshot = async (needsPin: boolean) => {
    sockets.at(-1)!.onmessage!({ data: JSON.stringify({ t: 'snapshot', state: {}, media: {}, needsPin }) });
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  };
  return { client, snapshot, heads, replaced, denied, restore };
}

test('a console whose session is gone is sent to sign in, and comes back to the same page', async () => {
  const p = await page('/s/talent', { gated: true });
  try {
    await p.snapshot(true);
    assert.deepEqual(p.replaced, ['/signin?next=%2Fs%2Ftalent']);
    assert.deepEqual(p.denied, ['PIN required'], 'the page hears it, so the desk can paint it');
    await p.snapshot(true);
    assert.equal(p.replaced.length, 1, 'once, not once per snapshot');
  } finally {
    p.restore();
  }
});

test('an open screen is never sent to a sign-in form', async () => {
  // The program overlay: no cookie, never authed, and must stay on air.
  const p = await page('/s/program', { gated: false });
  try {
    await p.snapshot(true);
    assert.equal(p.heads.length, 1, 'it asks');
    assert.deepEqual(p.replaced, [], 'and the server says this page is open');
    assert.deepEqual(p.denied, []);
  } finally {
    p.restore();
  }
});

test('no gate, or a page holding a typed PIN, asks nothing', async () => {
  const p = await page('/s/remote', { gated: true });
  try {
    await p.snapshot(false);
    assert.equal(p.heads.length, 0, 'REMOTE_PIN is off: nothing to sign in to');

    // The phone remote re-authenticates its socket with the PIN it holds.
    p.client.authenticate('2468');
    await p.snapshot(true);
    assert.equal(p.heads.length, 0);
    assert.deepEqual(p.replaced, []);
  } finally {
    p.restore();
  }
});
