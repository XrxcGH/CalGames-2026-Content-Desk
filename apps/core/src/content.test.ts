import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventContent, uniqueSlug } from './content.ts';
import { DEFAULTS, type Config } from './config.ts';

const scratch = () => mkdtemp(join(tmpdir(), 'cg-content-'));
const fresh = (): Config => structuredClone(DEFAULTS);

test('a desk edit overlays the live config in place and survives a restart', async () => {
  // The whole feature: content edited at the desk lands in
  // data/event-content.json, mutates the config object everything else holds
  // a reference to, and comes back after a restart without config.json ever
  // being touched.
  const dir = await scratch();
  try {
    const config = fresh();
    const content = new EventContent(dir);
    await content.load();
    content.apply(config);

    await content.set('event', { name: 'CalGames', year: 2026, key: '2026CACG' }, config);
    assert.equal(config.event.name, 'CalGames');
    assert.equal(config.event.key, '2026cacg', 'TBA keys are lowercase');

    // The restart: a new store, a new config object, same directory.
    const config2 = fresh();
    const content2 = new EventContent(dir);
    await content2.load();
    content2.apply(config2);
    assert.equal(config2.event.key, '2026cacg');
    assert.deepEqual(content2.overridden, ['event']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credentials are not editable, by name, whatever the request says', async () => {
  // The allowlist IS the security boundary: the desk endpoint takes a section
  // name from the network, and the sections holding tokens and PINs must be
  // unreachable through it no matter what a request claims.
  const dir = await scratch();
  try {
    const config = fresh();
    const content = new EventContent(dir);
    for (const section of ['youtube', 'tba', 'audio', 'nexus', 'startgg', 'recording', 'publish', 'awardsPin']) {
      await assert.rejects(
        () => content.set(section, { anything: 'x' }, config),
        /not editable from the desk/,
        `section "${section}" should be refused`,
      );
    }
    assert.equal(config.youtube.clientId, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited file cannot smuggle a credential section past load()', async () => {
  // Same boundary, other direction: the store re-sanitizes what it reads, so
  // editing data/event-content.json by hand adds nothing the desk could not.
  const dir = await scratch();
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'event-content.json'), JSON.stringify({
      youtube: { refreshToken: 'stolen' },
      event: { name: 'Legit Edit', year: 2026 },
    }), 'utf8');

    const config = fresh();
    const content = new EventContent(dir);
    await content.load();
    content.apply(config);
    assert.equal(config.youtube.refreshToken, '', 'the credential section must be dropped');
    assert.equal(config.event.name, 'Legit Edit', 'the legitimate section still loads');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lists are sanitized: blank rows drop, ids are minted, caps hold', async () => {
  const dir = await scratch();
  try {
    const config = fresh();
    const content = new EventContent(dir);
    const stored = await content.set('sponsors', {
      list: [
        { name: 'Acme Robotics', tier: 'title', line: '  Proud   sponsor  ' },
        { name: '' },                                   // no name: dropped
        { name: 'Beta Corp', tier: 'diamond' },         // invented tier: dropped, sponsor kept
        { name: 'Acme Robotics' },                      // same name: kept, id minted -2
        { name: 'Gamma', logo: 'https://elsewhere.example/x.png' }, // off-origin logo: dropped
      ],
    }, config) as { list: { id: string; tier?: string; line?: string; logo?: string }[] };

    assert.equal(stored.list.length, 4);
    assert.equal(stored.list[0]!.id, 'acme-robotics');
    assert.equal(stored.list[0]!.line, 'Proud sponsor');
    assert.equal(stored.list[1]!.tier, undefined);
    assert.equal(stored.list[2]!.id, 'acme-robotics-2',
      'two sponsors may share a name; neither silently disappears');
    assert.equal(stored.list[3]!.logo, undefined, 'logos must be served from this process');
    assert.deepEqual(config.sponsors.list, stored.list);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rundown rows keep only real kinds and the file empties itself', async () => {
  const dir = await scratch();
  try {
    const config = fresh();
    const content = new EventContent(dir);
    const stored = await content.set('rundown', {
      segments: [
        { label: 'Quals block 1', kind: 'matches', matches: 20 },
        { label: 'Lunch', kind: 'brunch', minutes: 45 },   // not a kind: becomes a fixed break
      ],
    }, config) as { segments: { kind: string; minutes?: number; matches?: number }[] };
    assert.equal(stored.segments[0]!.kind, 'matches');
    assert.equal(stored.segments[0]!.matches, 20);
    assert.equal(stored.segments[1]!.kind, 'break');
    assert.equal(stored.segments[1]!.minutes, 45);

    // Clearing every section deletes the file: no residue after an event.
    await content.set('rundown', { segments: [] }, config);
    const file = join(dir, 'data', 'event-content.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(raw['rundown'], { segments: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uniqueSlug mints readable ids and never collides', () => {
  const taken = new Set(['team-spirit']);
  assert.equal(uniqueSlug("Directors' Award", taken), 'directors-award');
  assert.equal(uniqueSlug('Team Spirit', taken), 'team-spirit-2');
  taken.add('team-spirit-2');
  assert.equal(uniqueSlug('Team Spirit', taken), 'team-spirit-3');
  assert.equal(uniqueSlug('!!!', taken), 'item');
});
