/**
 * Where discovery looks and how fast it asks.
 *
 * The order is what makes discovery quick when the address is right (one
 * hello, answered in a millisecond) and still useful when it is wrong. The
 * pace is what makes it safe to run on the FRC field network: at most about
 * 50 tiny UDP packets a second, and none once something answers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  DEFAULT_CANDIDATE_CAP,
  HelloProbe,
  PROBE_INTERVAL_MS,
  describeSubnets,
  discoveryCandidates,
  type Interfaces,
} from './discover.ts';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 };
}

/** What os.networkInterfaces() gives on a Windows desk with the usual extras. */
const WINDOWS_DESK: Interfaces = {
  Ethernet: [v6('fe80::1c2d:3e4f:5a6b:7c8d'), v4('10.0.100.12')],
  'Wi-Fi': [v4('192.168.1.23')],
  'Loopback Pseudo-Interface 1': [v6('::1'), v4('127.0.0.1', true)],
  // Windows' own address when DHCP failed: never where a switcher is.
  'Ethernet 2': [v4('169.254.77.3')],
  'vEthernet (WSL)': [v4('172.28.16.1')],
};

test('the configured host comes first, then the field network, then each local /24', () => {
  const list = discoveryCandidates('10.0.100.40', WINDOWS_DESK);
  assert.equal(list[0], '10.0.100.40');
  assert.equal(list[1], '10.0.100.1');
  // .40 is not asked twice, and .0 and .255 are never asked.
  assert.equal(list.filter(h => h === '10.0.100.40').length, 1);
  assert.ok(!list.some(h => h.endsWith('.0') || h.endsWith('.255')));
  assert.equal(list[254], '192.168.1.1');
  assert.equal(list[254 + 254], '172.28.16.1');
  assert.equal(list.length, 1 + 253 + 254 + 254);
  // Loopback and link-local are skipped; the IPv6 addresses are ignored.
  assert.ok(!list.some(h => h.startsWith('127.') || h.startsWith('169.254.')));
  assert.ok(!list.some(h => h.includes(':')));
});

test('the field network is swept even when the desk has no address on it', () => {
  const list = discoveryCandidates(null, { 'Wi-Fi': [v4('192.168.1.23')] });
  assert.equal(list[0], '10.0.100.1');
  assert.equal(list[253], '10.0.100.254');
  assert.equal(list[254], '192.168.1.1');
  assert.equal(list.length, 508);
  assert.deepEqual(discoveryCandidates(null, {}).length, 254);
});

test('a configured loopback address is honoured for rehearsal; garbage is not', () => {
  assert.equal(discoveryCandidates('127.0.0.1', {})[0], '127.0.0.1');
  assert.equal(discoveryCandidates('switcher.local', {})[0], '10.0.100.1');
  assert.equal(discoveryCandidates('10.0.100.400', {})[0], '10.0.100.1');
});

test('the list is capped, and the default cap keeps a sweep near 20 seconds', () => {
  const many: Interfaces = {};
  for (let i = 0; i < 12; i++) many[`nic${i}`] = [v4(`10.${i}.0.5`)];
  assert.equal(discoveryCandidates(null, many).length, DEFAULT_CANDIDATE_CAP);
  assert.equal(discoveryCandidates('10.0.100.40', many, 10).length, 10);
  assert.ok(DEFAULT_CANDIDATE_CAP * PROBE_INTERVAL_MS <= 21_000);
});

test('the same input gives the same list: candidates is pure', () => {
  assert.deepEqual(discoveryCandidates('10.0.100.40', WINDOWS_DESK), discoveryCandidates('10.0.100.40', WINDOWS_DESK));
  // Old Node versions said family 4 rather than 'IPv4'; both count.
  const numeric = { eth: [{ ...v4('192.168.5.9'), family: 4 as unknown as 'IPv4' }] };
  assert.equal(discoveryCandidates(null, numeric)[254], '192.168.5.1');
});

test('describeSubnets names the networks swept in words', () => {
  assert.equal(describeSubnets(['10.0.100.1', '10.0.100.2', '192.168.1.1']), '10.0.100.x, 192.168.1.x');
  assert.equal(describeSubnets(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5']), '1.1.1.x, 2.2.2.x, 3.3.3.x and 2 more');
});

test('the probe paces its hellos at 50 a second at most, and cannot be told to go faster', async () => {
  const sent: { host: string; at: number }[] = [];
  let finished = 0;
  const probe = new HelloProbe({
    send: host => { sent.push({ host, at: performance.now() }); },
    onSent: () => { finished++; },
    intervalMs: 1,
  });
  const hosts = Array.from({ length: 15 }, (_, i) => `10.0.100.${i + 1}`);
  probe.start([...hosts, hosts[0] ?? '']);
  await new Promise(r => setTimeout(r, 15 * PROBE_INTERVAL_MS + 300));
  assert.deepEqual(sent.map(s => s.host), hosts, 'every host once, in order, duplicates dropped');
  assert.equal(finished, 1);
  assert.equal(probe.finishedSending, true);
  for (let i = 1; i < sent.length; i++) {
    const gap = (sent[i]?.at ?? 0) - (sent[i - 1]?.at ?? 0);
    // Timers may fire a hair early on some platforms; never by a whole
    // interval. The span is the real rate check.
    assert.ok(gap >= PROBE_INTERVAL_MS - 3, `gap ${gap.toFixed(1)} ms between hello ${i - 1} and ${i}`);
  }
  const span = (sent.at(-1)?.at ?? 0) - (sent[0]?.at ?? 0);
  assert.ok(span >= (sent.length - 1) * (PROBE_INTERVAL_MS - 1), `15 hellos took ${span.toFixed(0)} ms`);
  probe.stop();
});

test('the first answer from a host the run asked wins, and stops the run at once', async () => {
  const sent: string[] = [];
  const probe = new HelloProbe({ send: host => { sent.push(host); } });
  probe.start(['10.0.100.1', '10.0.100.2', '10.0.100.3', '10.0.100.4']);
  assert.deepEqual(sent, ['10.0.100.1']);
  // An answer from somewhere this run never asked is not a winner.
  assert.equal(probe.answer('10.0.100.3'), false);
  assert.equal(probe.answer('192.168.1.1'), false);
  assert.equal(probe.answer('10.0.100.1'), true);
  assert.equal(probe.active, false);
  // A second answer after the winner is ignored.
  assert.equal(probe.answer('10.0.100.1'), false);
  await new Promise(r => setTimeout(r, 5 * PROBE_INTERVAL_MS));
  assert.deepEqual(sent, ['10.0.100.1'], 'no hello after the answer');
});

test('a send that throws is a host that did not answer, not a crash', async () => {
  const sent: string[] = [];
  const probe = new HelloProbe({
    send: host => { sent.push(host); throw new Error('ENETUNREACH'); },
    onSent: () => { throw new Error('a broken reporter'); },
  });
  probe.start(['10.0.100.1', '10.0.100.2']);
  await new Promise(r => setTimeout(r, 4 * PROBE_INTERVAL_MS));
  assert.deepEqual(sent, ['10.0.100.1', '10.0.100.2']);
  probe.stop();
});
