import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The number-roll animation, driven for real.
 *
 * This file used to hold a hand-copied duplicate of `roll()`'s easing
 * arithmetic behind a comment claiming "if somebody simplifies the clamp back
 * out, this fails". It would not have. The clamp under test was the copy in
 * THIS file, and `desk-client.js` could have lost its own without a single
 * test going red, which is worse than no test, because it reads as coverage.
 *
 * `roll()` is a browser module, but it touches the DOM only inside the
 * function, so four small stubs are enough to import it in Node and drive the
 * real code. That is the point: the bug being pinned was found on a live
 * overlay reading "-18 FUEL" while the desk state said 119, and a test that
 * cannot see the real function cannot catch that again.
 */

interface FakeEl { dataset: Record<string, string>; textContent: string }

/** Drive roll() through a controlled sequence of rAF frame timestamps. */
async function drive(
  frames: number[],
  opts: { from?: number; to: number; ms?: number; t0?: number;
    hidden?: boolean; reducedMotion?: boolean },
): Promise<{ rendered: string[] }> {
  const t0 = opts.t0 ?? 1000;
  const queue: ((now: number) => void)[] = [];
  const rendered: string[] = [];

  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    document: g['document'], performance: g['performance'],
    matchMedia: g['matchMedia'], requestAnimationFrame: g['requestAnimationFrame'],
  };

  g['document'] = { hidden: opts.hidden ?? false };
  g['performance'] = { now: () => t0 };
  g['matchMedia'] = () => ({ matches: opts.reducedMotion ?? false });
  g['requestAnimationFrame'] = (fn: (now: number) => void) => { queue.push(fn); return 1; };

  try {
    // The surfaces are plain browser JS with no declarations and no build
    // step, which is the deliberate arrangement for everything under
    // surfaces/. Importing one from a typechecked test is the one place that
    // costs anything, and it costs exactly this line.
    // @ts-expect-error untyped browser module, cast on the next line
    const mod = (await import('../../../surfaces/_shared/desk-client.js')) as
      { roll: (el: unknown, to: number, ms?: number) => void };
    const el: FakeEl = { dataset: { v: String(opts.from ?? 0) }, textContent: '' };
    const proxy = new Proxy(el, {
      set(target, key, value) {
        if (key === 'textContent') rendered.push(String(value));
        return Reflect.set(target, key, value);
      },
    });

    mod.roll(proxy, opts.to, opts.ms ?? 600);
    // Each queued frame gets the next timestamp, and may queue another.
    for (const now of frames) {
      const fn = queue.shift();
      if (!fn) break;
      fn(now);
    }
    return { rendered };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  }
}

test('a frame stamped BEFORE the call that scheduled it renders the start value', async () => {
  // The bug, exactly as it happened. t0 comes from performance.now() and `now`
  // is the rAF frame timestamp, which can be stamped fractionally earlier. The
  // ease 1-(1-p)**3 at p = -1 is -7, so with no bottom clamp the element
  // renders seven times the distance in the WRONG direction: an overlay read
  // "-18 FUEL" against a state that said 119 the whole time.
  const { rendered } = await drive([400], { from: 119, to: 137, ms: 600, t0: 1000 });
  assert.equal(rendered[0], '119', 'the start value, not a number below it');
});

test('it lands exactly on the target, not near it', async () => {
  const { rendered } = await drive([1000, 1300, 1600, 1900],
    { from: 0, to: 137, ms: 600, t0: 1000 });
  assert.equal(rendered[rendered.length - 1], '137');
});

test('it never overshoots, however late the last frame arrives', async () => {
  // The top clamp. A frame arriving well after the duration must not run the
  // curve past 1.
  const { rendered } = await drive([9000], { from: 0, to: 137, ms: 600, t0: 1000 });
  assert.equal(rendered[0], '137');
});

test('every value on the way is between the two ends', async () => {
  for (const [from, to] of [[0, 119], [119, 0], [88, 91], [1200, 3]] as const) {
    const { rendered } = await drive([900, 1100, 1200, 1350, 1500, 1600, 5000],
      { from, to, ms: 600, t0: 1000 });
    const lo = Math.min(from, to), hi = Math.max(from, to);
    for (const v of rendered) {
      assert.ok(Number(v) >= lo && Number(v) <= hi,
        `roll(${from} -> ${to}) rendered ${v}, outside [${lo}, ${hi}]`);
    }
  }
});

test('a score can never render negative on the way to zero', async () => {
  // The specific on-air symptom, as a regression test against the real code.
  const { rendered } = await drive([500, 900, 1100, 1400, 1700],
    { from: 119, to: 0, ms: 600, t0: 1000 });
  for (const v of rendered) assert.ok(Number(v) >= 0, `rendered ${v}`);
});

test('a hidden page and reduced motion both get the number, instantly', async () => {
  // rAF does not fire in a backgrounded page, so an animated roll started
  // while hidden would strand the element on a stale number. Nobody is
  // watching a hidden source, but the correct value still matters.
  const hidden = await drive([], { from: 0, to: 137, hidden: true });
  assert.deepEqual(hidden.rendered, ['137']);

  const reduced = await drive([], { from: 0, to: 137, reducedMotion: true });
  assert.deepEqual(reduced.rendered, ['137']);
});

test('rolling to the value it already shows does nothing at all', async () => {
  const { rendered } = await drive([1100], { from: 137, to: 137 });
  assert.deepEqual(rendered, []);
});
