/**
 * The desk looking for the field by itself.
 *
 * Against real sockets on 127.0.0.1: the fake arena (the real wire protocol),
 * a dev server that is not Cheesy, a redirect, and a port with nothing on it.
 * The pacing and one-at-a-time rules are measured with injected probes,
 * because those are promises about what the desk puts on a field network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { EventBus } from '../../bus.ts';
import { CheesyAdapter } from './adapter.ts';
import { startFakeArena } from './fake-arena.ts';
import { FieldLink } from './field-link.ts';
import {
  FIELD_PROBE_PATH, FINDER_TIMING, FieldFinder, fieldCandidates, knock, looksLikeCheesy,
  withFieldPort,
} from './finder.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
  return (server.address() as { port: number }).port;
}

/** A port that was free a moment ago, so a knock on it is refused. */
async function deadPort(): Promise<number> {
  const s = createTcpServer();
  const port = await listen(s);
  await new Promise<void>(res => s.close(() => res()));
  return port;
}

// ---- where it looks ------------------------------------------------------------

test('candidates: the settings address, then 10.0.100.5, the field /24, then local /24s', () => {
  const list = fieldCandidates('10.20.30.40', {
    Ethernet: [
      { family: 'IPv4', address: '192.168.7.23', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [{ family: 'IPv4', address: '169.254.10.9', internal: false }],
    Field: [{ family: 'IPv4', address: '10.0.100.77', internal: false }],
  });
  assert.equal(list[0], '10.20.30.40:8080');
  assert.equal(list[1], '10.0.100.5:8080');
  assert.equal(list[2], '10.0.100.1:8080');
  // The field /24 once, with .5 not repeated and the machine's own field
  // address not adding a second copy of the network.
  const field = list.filter(h => h.startsWith('10.0.100.'));
  assert.equal(field.length, 254);
  assert.equal(new Set(list).size, list.length, 'no address twice');
  // The venue LAN /24, after the field network.
  assert.ok(list.includes('192.168.7.1:8080'));
  assert.ok(list.indexOf('192.168.7.1:8080') > list.indexOf('10.0.100.254:8080'));
  // Never loopback, never 169.254, never IPv6.
  assert.ok(!list.some(h => h.startsWith('127.') || h.startsWith('169.254.') || h.includes('::')));
  assert.equal(list.length, 1 + 254 + 254);
});

test('candidates: a settings address that names a port keeps it; one that is 10.0.100.5 is not tried twice', () => {
  assert.equal(fieldCandidates('cheesy.local:9000', {})[0], 'cheesy.local:9000');
  const same = fieldCandidates('10.0.100.5', {});
  assert.equal(same[0], '10.0.100.5:8080');
  assert.equal(same.filter(h => h === '10.0.100.5:8080').length, 1);
  // Junk in the settings is skipped, not tried.
  assert.equal(fieldCandidates('http://10.0.100.5/', {})[0], '10.0.100.5:8080');
  assert.equal(fieldCandidates('', {})[0], '10.0.100.5:8080');
});

test('withFieldPort accepts host and host:port only', () => {
  assert.equal(withFieldPort('10.0.100.5'), '10.0.100.5:8080');
  assert.equal(withFieldPort(' 10.0.100.5:8081 '), '10.0.100.5:8081');
  assert.equal(withFieldPort('Cheesy'), 'cheesy:8080');
  for (const bad of ['', 'a b', 'http://x', 'x:0', 'x:70000', 'x/y', '::1', null, undefined]) {
    assert.equal(withFieldPort(bad as string), null, String(bad));
  }
});

// ---- the check itself ------------------------------------------------------------

test('the check says yes to the fake arena, and no to everything that is not Cheesy', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;

  const html = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><p>dev'); });
  // A JSON-looking body, so only the status can say no.
  const redirect = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${arenaPort}/api/rankings` }); res.end('[]'); });
  const missing = createServer((_req, res) => { res.writeHead(404); res.end('{}'); });
  const [htmlPort, redirectPort, missingPort] = await Promise.all([listen(html), listen(redirect), listen(missing)]);
  const dead = await deadPort();
  try {
    assert.equal(await looksLikeCheesy(`127.0.0.1:${arenaPort}`), true);
    assert.equal(await looksLikeCheesy(`127.0.0.1:${htmlPort}`), false, 'a dev server on the port');
    assert.equal(await looksLikeCheesy(`127.0.0.1:${redirectPort}`), false, 'redirects are not followed');
    assert.equal(await looksLikeCheesy(`127.0.0.1:${missingPort}`), false, 'a 404 with a JSON body');
    assert.equal(await looksLikeCheesy(`127.0.0.1:${dead}`), false);
    assert.equal(await knock(`127.0.0.1:${arenaPort}`), true);
    assert.equal(await knock(`127.0.0.1:${dead}`), false);
  } finally {
    arena.close();
    html.close(); redirect.close(); missing.close();
  }
});

test('the check is one GET of the allowlisted path, with nothing sent but its headers', async () => {
  const seen: string[] = [];
  const raw = createTcpServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += String(d);
      if (buf.includes('\r\n\r\n')) {
        seen.push(buf);
        sock.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[]');
      }
    });
  });
  const port = await listen(raw);
  try {
    assert.equal(await looksLikeCheesy(`127.0.0.1:${port}`), true);
    assert.equal(seen.length, 1);
    const [head, body] = seen[0]!.split('\r\n\r\n');
    assert.match(head!, /^GET \/api\/rankings HTTP\/1\.1\r\n/);
    assert.equal(body, '', 'no request body');
    assert.equal(FIELD_PROBE_PATH, '/api/rankings');
  } finally {
    raw.close();
  }
});

test('a silent server is given up on at the timeout, not waited on', async () => {
  const sockets: import('node:net').Socket[] = [];
  const silent = createTcpServer(sock => { sockets.push(sock); /* accepts, never answers */ });
  const port = await listen(silent);
  try {
    const t0 = Date.now();
    assert.equal(await looksLikeCheesy(`127.0.0.1:${port}`, 300), false);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

// ---- the finder ---------------------------------------------------------------

test('the finder finds the fake arena among dead ports and dev servers, attaches once, and stops', async () => {
  const arena = startFakeArena({ port: 0, speed: 40, log: () => {} });
  const arenaPort = await arena.ready;
  const html = createServer((_req, res) => { res.writeHead(200); res.end('<html>'); });
  const htmlPort = await listen(html);
  const dead = await deadPort();

  const bus = new EventBus();
  const field = new FieldLink();
  let changes = 0;
  field.on('change', () => { changes++; });
  const found: string[] = [];
  let candidateReads = 0;
  const finder = new FieldFinder({
    candidates: () => {
      candidateReads++;
      return [`127.0.0.1:${dead}`, `127.0.0.1:${htmlPort}`, `127.0.0.1:${dead}`, `127.0.0.1:${arenaPort}`];
    },
    onFound: hostPort => {
      found.push(hostPort);
      // Exactly what index.ts does with it.
      const adapter = new CheesyAdapter({ bus, host: hostPort, displayId: 'finder-test' });
      adapter.start();
      field.attach(adapter, hostPort);
    },
    sweepEveryMs: 50,
    log: () => {},
  });
  field.setSearching(true);
  finder.start();
  try {
    await until('the field to be found', () => found.length > 0);
    await until('the bridge to connect', () => bus.state.connected.cheesy === true);
    assert.deepEqual(found, [`127.0.0.1:${arenaPort}`]);
    assert.equal(field.host, `127.0.0.1:${arenaPort}`);
    assert.ok(field.adapter);
    assert.equal(field.searching, false);
    assert.equal(finder.running, false);
    const reads = candidateReads;
    await sleep(250);
    assert.equal(candidateReads, reads, 'no sweep after the field was found');
    assert.equal(found.length, 1);
    assert.ok(changes >= 2, 'searching on, then attached');
  } finally {
    finder.stop();
    field.adapter?.stop();
    arena.close();
    html.close();
  }
});

test('the likely addresses are tried alone first: when the first answers, nothing else is touched', async () => {
  const touched: string[] = [];
  const finder = new FieldFinder({
    candidates: () => ['10.0.100.5:8080', ...Array.from({ length: 50 }, (_, i) => `10.0.100.${i + 10}:8080`)],
    knock: async h => {
      touched.push(h);
      // Slow to answer, as a real field is: fanned out, the rest would be
      // knocked on while this one is still connecting.
      await sleep(150);
      return h === '10.0.100.5:8080';
    },
    check: async h => h === '10.0.100.5:8080',
    onFound: () => {},
    log: () => {},
  });
  finder.start();
  await until('found', () => finder.found !== null);
  await sleep(100);
  assert.deepEqual(touched, ['10.0.100.5:8080']);
});

test('pacing: no more than about 50 knocks a second, even when every knock answers at once', async () => {
  const at: number[] = [];
  const n = 62;
  const finder = new FieldFinder({
    candidates: () => Array.from({ length: n }, (_, i) => `10.9.9.${i + 1}:8080`),
    // Refused at once, as on a quiet /24: only the pacing holds the rate.
    knock: async () => { at.push(Date.now()); return false; },
    check: async () => false,
    onFound: () => {},
    sweepEveryMs: 60_000,
    log: () => {},
  });
  assert.equal(FINDER_TIMING.probesPerSecond, 50);
  finder.start();
  try {
    await until('the sweep to finish', () => finder.sweeps === 1 && !finder.sweeping && at.length === n, 20_000);
    // After the two lead addresses, the other 60 at 50 a second is at least
    // 1.2 s; allow for timer granularity.
    const fanOut = at.slice(FINDER_TIMING.leadCount);
    const span = fanOut[fanOut.length - 1]! - fanOut[0]!;
    assert.ok(span >= (fanOut.length - 1) * 20 * 0.85, `60 knocks took only ${span} ms`);
    // In any one second window, no more than about 50.
    for (let i = 0; i < fanOut.length; i++) {
      const inWindow = fanOut.filter(t => t >= fanOut[i]! && t < fanOut[i]! + 1000).length;
      assert.ok(inWindow <= 55, `${inWindow} knocks inside one second`);
    }
  } finally {
    finder.stop();
  }
});

test('never more than 16 knocks in flight, however fast it is allowed to go', async () => {
  let inFlight = 0;
  let peak = 0;
  let done = 0;
  const n = 60;
  const finder = new FieldFinder({
    candidates: () => Array.from({ length: n }, (_, i) => `10.9.8.${i + 1}:8080`),
    knock: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      // Dead addresses hold a knock open until its timeout.
      await sleep(400);
      inFlight--; done++;
      return false;
    },
    check: async () => false,
    onFound: () => {},
    probesPerSecond: 10_000,
    sweepEveryMs: 60_000,
    log: () => {},
  });
  assert.equal(FINDER_TIMING.maxInFlight, 16);
  finder.start();
  try {
    await until('the sweep to finish', () => done === n && !finder.sweeping, 20_000);
    assert.equal(peak, 16, `peak in flight ${peak}: the cap, and only the cap, held it`);
  } finally {
    finder.stop();
  }
});

test('one sweep at a time, a new one every sweepEveryMs while nothing answers, none after stop()', async () => {
  // Every knock, with the sweep it belongs to and when it started and ended.
  const knocks: { sweep: number; start: number; end: number }[] = [];
  const finder = new FieldFinder({
    candidates: () => ['a:1', 'b:1', 'c:1', 'd:1', 'e:1', 'f:1'],
    knock: async () => {
      const k = { sweep: finder.sweeps, start: Date.now(), end: Infinity };
      knocks.push(k);
      await sleep(30);
      k.end = Date.now();
      return false;
    },
    check: async () => false,
    onFound: () => {},
    sweepEveryMs: 60,
    log: () => {},
  });
  finder.start();
  try {
    await until('three sweeps', () => finder.sweeps >= 3, 10_000);
    // A knock of a later sweep never starts before every knock of an
    // earlier one has finished: its stragglers count as part of it.
    for (const a of knocks) {
      for (const b of knocks) {
        if (b.sweep > a.sweep) assert.ok(b.start >= a.end, `sweep ${b.sweep} began while sweep ${a.sweep} was still knocking`);
      }
    }
    // And the gap between sweeps is the interval, not zero.
    const firstOf = (n: number) => knocks.find(k => k.sweep === n)!;
    const lastOf = (n: number) => knocks.filter(k => k.sweep === n).at(-1)!;
    assert.ok(firstOf(2).start - lastOf(1).end >= 50, 'the next sweep waited out the interval');
    finder.stop();
    await sleep(200);
    const after = knocks.length;
    await sleep(300);
    assert.equal(knocks.length, after, 'nothing after stop()');
  } finally {
    finder.stop();
  }
});

test('the shipped timing: a sweep that finds nothing waits 30 s before the next, not less', async t => {
  // Every other test sets its own timing, so without this a desk that
  // re-swept the field network every second while Cheesy was down would pass
  // them all. The numbers are the launcher's, and what the FTA was told.
  assert.equal(FINDER_TIMING.sweepEveryMs, 30_000);
  assert.equal(FINDER_TIMING.knockTimeoutMs, 600);
  assert.equal(FINDER_TIMING.checkTimeoutMs, 2_500);
  assert.equal(FINDER_TIMING.leadCount, 2);
  assert.equal(FINDER_TIMING.probesPerSecond, 50);
  assert.equal(FINDER_TIMING.maxInFlight, 16);

  // And the finder uses it when nothing is passed: run on mocked timers,
  // with probes that answer at once, so the wait is the only thing timed.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise<void>(r => setImmediate(r));
  };
  const finder = new FieldFinder({
    candidates: () => ['192.0.2.1:8080'],
    knock: async () => false,
    check: async () => false,
    onFound: () => {},
    log: () => {},
  });
  finder.start();
  try {
    t.mock.timers.tick(0);
    await flush();
    assert.equal(finder.sweeps, 1, 'the first sweep starts at once');
    assert.equal(finder.sweeping, false);
    t.mock.timers.tick(29_999);
    await flush();
    assert.equal(finder.sweeps, 1, 'no second sweep before 30 s');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(finder.sweeps, 2, 'the second sweep at 30 s');
  } finally {
    finder.stop();
  }
});

test('retarget: the sweep in progress winds down and the next starts at once, with the new list', async () => {
  let preferred = 'old:8080';
  const seen: string[] = [];
  const finder = new FieldFinder({
    candidates: () => [preferred, 'x:1', ...Array.from({ length: 40 }, (_, i) => `y${i}:1`)],
    knock: async h => {
      seen.push(h);
      await sleep(5);
      return h === 'new:8080';
    },
    check: async h => h === 'new:8080',
    onFound: () => {},
    // Far away, so only retarget() can explain a second sweep this soon.
    sweepEveryMs: 60_000,
    log: () => {},
  });
  finder.start();
  try {
    await until('the first sweep to be under way', () => seen.length >= 5);
    preferred = 'new:8080';
    finder.retarget();
    await until('the new address to be found', () => finder.found === 'new:8080', 5000);
    assert.equal(finder.sweeps, 2);
    assert.ok(seen.length < 2 + 40 + 1, 'the first sweep stopped early instead of finishing');
  } finally {
    finder.stop();
  }
});

test('a candidates() that throws, a knock that throws and an onFound that throws never escape', async () => {
  const lines: string[] = [];
  let calls = 0;
  const finder = new FieldFinder({
    candidates: () => { calls++; if (calls === 1) throw new Error('no networks'); return ['z:1']; },
    knock: async () => { throw new Error('boom'); },
    check: async () => true,
    onFound: () => { throw new Error('attach failed'); },
    sweepEveryMs: 30,
    // The fallback after a throwing candidates() is the whole field /24.
    probesPerSecond: 5000,
    log: line => lines.push(line),
  });
  finder.start();
  try {
    await until('two sweeps', () => finder.sweeps >= 2);
    assert.ok(lines.some(l => l.includes('no networks')));
  } finally {
    finder.stop();
  }
  // And a found field whose attach throws is logged, and the finder still stops.
  const lines2: string[] = [];
  const f2 = new FieldFinder({
    candidates: () => ['q:1'],
    knock: async () => true,
    check: async () => true,
    onFound: () => { throw new Error('attach failed'); },
    log: line => lines2.push(line),
  });
  f2.start();
  await until('found', () => f2.found !== null);
  assert.equal(f2.running, false);
  assert.ok(lines2.some(l => l.includes('attach failed')));
});

// ---- FieldLink -----------------------------------------------------------------

test('FieldLink: attach once, searching ends at attach and cannot be turned back on', () => {
  const bus = new EventBus();
  const field = new FieldLink();
  let changes = 0;
  field.on('change', () => { changes++; });
  assert.equal(field.adapter, null);
  assert.equal(field.host, null);
  assert.equal(field.searching, false);

  field.setSearching(true);
  field.setSearching(true);
  assert.equal(changes, 1, 'only a real change is announced');
  assert.equal(field.searching, true);

  const a = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'x' });
  field.attach(a, '127.0.0.1:1');
  assert.equal(field.adapter, a);
  assert.equal(field.host, '127.0.0.1:1');
  assert.equal(field.searching, false);
  assert.equal(changes, 2);

  const b = new CheesyAdapter({ bus, host: '127.0.0.1:2', displayId: 'y' });
  field.attach(b, '127.0.0.1:2');
  assert.equal(field.adapter, a, 'the first bridge stays: two would put every field event on air twice');
  assert.equal(field.host, '127.0.0.1:1');

  field.setSearching(true);
  assert.equal(field.searching, false, 'a late sweep cannot say it is still looking');
  assert.equal(changes, 2);
});

test('FieldLink: a listener that throws does not escape attach()', () => {
  const field = new FieldLink();
  field.on('change', () => { throw new Error('listener broke'); });
  const bus = new EventBus();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => field.attach(new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'x' }), '127.0.0.1:1'));
  } finally {
    console.warn = warn;
  }
  assert.ok(field.adapter);
});
