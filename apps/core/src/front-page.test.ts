/**
 * The front page the exe opens, as a first-time volunteer meets it.
 *
 * On a test night with no OBS, the AV coordinator opened the first link on
 * this page (the program overlay, a see-through page a browser paints white)
 * and got stuck on white; the only help was a 43-page PDF. These run the real
 * server and read the page it actually sends: the plain choices, the status
 * strip, the help, the full list folded away, and the line between what the
 * desk laptop sees and what the rest of the venue Wi-Fi sees.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { DEFAULTS, type ConfigFileReport, type LaunchMode } from './config.ts';
import { CONTROL_ACTIONS } from './control-map.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import type { ObsClient } from './cue/obs.ts';
import { MediaLibrary } from './media.ts';
import {
  FRONT_CHOICES, FRONT_HELP, SCREEN_GROUPS, SURFACES, startServer, surfacePath,
} from './server.ts';
import { ScreenRegistry } from './screens.ts';
import type { AtemView, FieldView } from './vitals.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SURFACE_DIR = join(REPO, 'surfaces');

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

interface BootOpts {
  mode?: LaunchMode | null;
  configFile?: () => ConfigFileReport;
  cheesy?: unknown;
  /** A FieldLink, or anything shaped like one (adapter, host, searching). */
  field?: unknown;
  /** Anything with a `status` shaped like the ATEM watcher's. */
  atem?: unknown;
  screens?: ScreenRegistry;
  obs?: unknown;
  lanBase?: string | null | (() => string | null);
  statusSettleMs?: number;
  bus?: EventBus;
}

async function boot(o: BootOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-front-'));
  const bus = o.bus ?? new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS),
    lanBase: o.lanBase === undefined ? 'http://172.22.0.23:8720' : o.lanBase,
    mode: o.mode === undefined ? null : o.mode,
    configFile: o.configFile ?? (() => ({ state: 'read', duplicates: [] })),
    cheesy: (o.cheesy ?? null) as CheesyAdapter | null,
    ...(o.field !== undefined ? { field: o.field as FieldView } : {}),
    ...(o.atem !== undefined ? { atem: o.atem as AtemView } : {}),
    ...(o.screens ? { screens: o.screens } : {}),
    obs: (o.obs ?? null) as ObsClient | null,
    ...(o.statusSettleMs !== undefined ? { statusSettleMs: o.statusSettleMs } : {}),
  });
  const port = await server.listening;
  return { bus, port, done: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

/**
 * The front page as a browser naming the desk by `host` sees it, from the
 * local address `from` (the desk laptop itself is 127.0.0.1).
 */
const page = (port: number, host: string, from?: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', headers: { host }, ...(from ? { localAddress: from } : {}) },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject).end();
  });

/** What a person reads: no styles, no tags, entities as characters. */
const visible = (html: string): string => html
  .replace(/<style>[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

/** One element by its opening tag, through to its matching close. */
const slice = (html: string, open: string, close: string): string => {
  const from = html.indexOf(open);
  return from < 0 ? '' : html.slice(from, html.indexOf(close, from) + close.length);
};

const escaped = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- the choices ---------------------------------------------------------------

test('the page opens on a few plain choices, then the Start here box, then help, then the full list', async () => {
  const d = await boot();
  try {
    const { status, body } = await page(d.port, `localhost:${d.port}`);
    assert.equal(status, 200);
    const nav = slice(body, '<nav class="choices"', '</nav>');
    assert.ok(nav, 'the choices are there');
    assert.ok(FRONT_CHOICES.length >= 3 && FRONT_CHOICES.length <= 5, 'a handful, not thirty');
    for (const c of FRONT_CHOICES) {
      assert.ok(nav.includes(`<a class="choice" href="${c.href}"><b>${escaped(c.title)}</b>`), c.title);
    }
    assert.deepEqual(FRONT_CHOICES.map(c => c.href),
      ['/s/desk', '/s/program', '/s/watch', '/s/talent', '/s/awards']);
    // The projector choice is the answer to the white page, so it says how:
    // which computer, and the key that makes it full screen.
    const watch = slice(nav, '<a class="choice" href="/s/watch">', '</a>');
    assert.match(watch, /computer whose HDMI cable goes to that screen/);
    assert.match(watch, /F11/);
    assert.match(watch, /From another computer, open <code>http:\/\/172\.22\.0\.23:8720\/s\/watch<\/code>/);
    // The AV kit's case, in its own words: which computer (the one Cheesy's
    // overlay is on today), F11, and that Cheesy's comes back by itself.
    const sw = slice(nav, '<a class="choice" href="/s/program">', '</a>');
    assert.match(sw, /Put the graphics into the video switcher/);
    assert.match(sw, /feeds the switcher&#39;s overlay input|feeds the switcher's overlay input/);
    assert.match(sw, /Cheesy Arena's score overlay today/);
    assert.match(sw, /F11/);
    assert.match(sw, /comes back by itself if the desk stops/);
    assert.match(sw, /From another computer, open <code>http:\/\/172\.22\.0\.23:8720\/s\/program<\/code>/);
    // No bare ?key= on the switcher's address: a plain browser gets the black
    // a luma key needs by itself (C8), and one address must work everywhere.
    assert.doesNotMatch(sw, /\?key=/);

    const at = (s: string): number => body.indexOf(s);
    assert.ok(at('<h1>') < at('<ul class="status"'), 'status under the heading');
    assert.ok(at('<ul class="status"') < at('<nav class="choices"'), 'status above the choices');
    assert.ok(at('<nav class="choices"') < at('<div class="start">'), 'choices above Start here');
    assert.ok(at('<div class="start">') < at('<section class="help"'), 'Start here above the help');
    assert.ok(at('<section class="help"') < at('<details class="fold" id="all">'), 'help above the full list');
    assert.ok(at('<details class="fold" id="all">') < at('<details class="fold" id="obs">'), 'OBS last');
    assert.match(body, /<meta name="viewport"/, 'readable on a phone, which is where the address often gets typed');
  } finally {
    await d.done();
  }
});

test('no jargon outside the OBS note: no "surface", no "OBS Browser Source", no chapter numbers', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    // A broken file and practice mode too, so every optional line is drawn.
    const d = await boot({
      mode: 'rehearsal',
      configFile: () => ({ state: 'unusable', reason: 'typo', line: 12, duplicates: [] }),
    });
    try {
      const { body } = await page(d.port, `localhost:${d.port}`);
      const obsNote = slice(body, '<details class="fold" id="obs">', '</details>');
      assert.match(obsNote, /Browser Source/, 'the OBS note is where OBS words live');
      const rest = visible(body.replace(obsNote, ''));
      assert.doesNotMatch(rest, /\bsurfaces?\b/i);
      assert.doesNotMatch(rest, /Browser Source/);
      assert.doesNotMatch(rest, /\bchapter\s*\d/i);
      assert.doesNotMatch(rest, /Core is running/);
      // The house style, on the page a volunteer reads first.
      for (const dash of [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]) {
        assert.ok(!body.includes(dash), `no ${dash.charCodeAt(0).toString(16)} dash on the page`);
      }
      // The same rule for the words the page is built from, wherever they show.
      for (const s of SURFACES) assert.doesNotMatch(`${s.name} ${s.note}`, /\bsurface|Browser Source/i, s.name);
      for (const h of FRONT_HELP) assert.doesNotMatch(`${h.see} ${h.fix}`, /\bsurface|Browser Source|chapter\s*\d/i, h.id);
    } finally {
      await d.done();
    }
  });
});

// ---- the full list ----------------------------------------------------------------

test('every screen is still listed, folded away under the choices, with a plain title for its group', async () => {
  const d = await boot();
  try {
    const { body } = await page(d.port, `localhost:${d.port}`);
    const all = slice(body, '<details class="fold" id="all">', '</details>');
    assert.ok(all, 'the full list is there');
    assert.doesNotMatch(all.slice(0, all.indexOf('>') + 1), /\bopen\b/, 'folded until somebody opens it');
    const rows = [...all.matchAll(/<a class="row" href="([^"]+)"><b>([^<]*)<\/b><code>[^<]*<\/code><i>([^<]*)<\/i><\/a>/g)];
    assert.equal(rows.length, SURFACES.length, 'one row per screen, none lost and none doubled');
    for (const s of SURFACES) {
      assert.ok(rows.some(r => r[1] === surfacePath(s) && r[2] === escaped(s.name) && r[3] === escaped(s.note)),
        `${surfacePath(s)} (${s.name}) is listed with its note`);
    }
    // Every group has words a volunteer can read, so none falls back to the
    // desk's own key for it.
    const titled = new Set(SCREEN_GROUPS.map(g => g.group));
    for (const s of SURFACES) assert.ok(titled.has(s.group), `${s.group} has a title`);
    for (const g of SCREEN_GROUPS) assert.ok(all.includes(`<h3>${escaped(g.title)}</h3>`), g.title);
    // The projector list first, the see-through layers last.
    assert.equal(SCREEN_GROUPS[0]?.group, 'On a pit monitor');
    assert.equal(SCREEN_GROUPS.at(-1)?.group, 'On air');
  } finally {
    await d.done();
  }
});

test('every page the desk serves is on the full list, and every row opens a page that is there', async () => {
  // The test above counts rows against SURFACES, so it cannot see a row
  // deleted from SURFACES: the count drops with it. The folders are the truth
  // instead. /s/{name} serves surfaces/{name}/index.html, so every folder with
  // one is a page, and this list is the only place a volunteer finds its
  // address. A folder without one (the shared scripts) is not a page.
  const pages = readdirSync(SURFACE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(SURFACE_DIR, e.name, 'index.html')))
    .map(e => e.name);
  assert.ok(pages.length >= 20, `the folders were read (${pages.join(', ')})`);
  assert.ok(!pages.includes('_shared'), 'the shared scripts are not a page');
  const d = await boot();
  try {
    const { body } = await page(d.port, `localhost:${d.port}`);
    const all = slice(body, '<details class="fold" id="all">', '</details>');
    const listed = new Set([...all.matchAll(/<a class="row" href="\/s\/([^"?/]+)/g)].map(m => m[1]));
    for (const p of pages) assert.ok(listed.has(p), `/s/${p} is served but missing from the front page's list`);
  } finally {
    await d.done();
  }
  // And the other way: a row for a page that is gone is a dead link.
  for (const s of SURFACES) {
    assert.ok(existsSync(join(SURFACE_DIR, s.id, 'index.html')), `${surfacePath(s)} (${s.name}) opens a page that exists`);
  }
});

/** The key mode a page's own markup ships, which is what OBS gets with no ?key=. */
const markupKey = (id: string): string =>
  /<html[^>]*\sdata-key="(\w+)"/.exec(readFileSync(join(SURFACE_DIR, id, 'index.html'), 'utf8'))?.[1] ?? '';

test('the OBS note says which graphics stay see-through over a camera, and each page agrees', async () => {
  const d = await boot();
  try {
    const { body } = await page(d.port, `localhost:${d.port}`);
    const obs = slice(body, '<details class="fold" id="obs">', '</details>');
    const codes = (cls: string): string[] =>
      [...slice(obs, `<p class="${cls}">`, '</p>').matchAll(/<code>\/s\/(\w+)<\/code>/g)].map(m => m[1]!);
    const over = codes('obs-over');
    const full = codes('obs-full');
    assert.ok(over.length && full.length, 'both lists are there');
    // Every graphic in the OBS group is in exactly one of the two.
    const onAir = SURFACES.filter(s => s.group === 'On air').map(s => s.id);
    assert.deepEqual([...over, ...full].sort(), [...onAir].sort());

    // Inside OBS a page with no ?key= keeps the mode its markup ships
    // (desk-client.js, at HEAD and since). Only alpha is see-through, and only
    // while the page paints nothing on its stage itself: trivia does in every
    // mode, ?key=alpha included (measured in a browser: rgb(14, 1, 19)), which
    // is how the note came to promise a see-through trivia that covered the
    // camera. A rule on #stage alone; a :root[data-key] one is per mode.
    const own = (id: string): string => readFileSync(join(SURFACE_DIR, id, 'index.html'), 'utf8');
    for (const id of over) {
      assert.equal(markupKey(id), 'alpha', `/s/${id} is called see-through, so it must ship alpha`);
      assert.doesNotMatch(own(id), /(^|\n)\s*#stage\s*\{[^}]*background(?!:\s*transparent)/,
        `/s/${id} is called see-through, so its stage must not paint a background`);
      assert.doesNotMatch(SURFACES.find(s => s.id === id)!.note, /Draws its own background/, id);
    }
    for (const id of full) {
      assert.notEqual(markupKey(id), 'alpha', `/s/${id} is called a full picture, so it must not ship alpha`);
      assert.match(SURFACES.find(s => s.id === id)!.note, /Draws its own background\./, `${id}: its row says so too`);
    }
    // The group's intro sends the reader to those words, so they must be its words.
    assert.match(SCREEN_GROUPS.find(g => g.group === 'On air')!.intro, /"Draws its own background"/);
  } finally {
    await d.done();
  }
});

test('the projector rows say exactly what the /s/watch chooser they open says', () => {
  // surfaces/watch/index.html keeps the same rows and asks for both to be
  // edited together: a volunteer reads one, clicks, and lands on the other.
  const html = readFileSync(join(SURFACE_DIR, 'watch', 'index.html'), 'utf8');
  const block = /const PIT_SCREENS = \[([\s\S]*?)\];/.exec(html)?.[1] ?? '';
  // A blurb may be one string or several joined with +, across lines.
  const pit = [...block.matchAll(/\{\s*id: '(\w+)', name: '([^']*)',[^}]*?blurb: ((?:'[^']*'\s*\+?\s*)+)\}/g)]
    .map(m => ({ id: m[1]!, name: m[2]!, blurb: [...m[3]!.matchAll(/'([^']*)'/g)].map(p => p[1]).join('') }));
  assert.ok(pit.length >= 5, `the chooser's rows were read (${pit.map(p => p.id).join(', ')})`);
  for (const p of pit) {
    const row = SURFACES.find(s => surfacePath(s) === `/s/watch?screen=${p.id}`);
    assert.ok(row, `the front page lists /s/watch?screen=${p.id}`);
    assert.equal(row.name, p.name, `${p.id}: same name`);
    assert.equal(row.note, p.blurb, `${p.id}: same words`);
  }
});

// ---- what stays on the desk laptop ----------------------------------------------------

test('nothing secret reaches a browser that is not the desk laptop asking by a local name', async () => {
  const CASES: Record<string, string | undefined>[] = [
    // The shipped defaults: the page must not even say that they are.
    { REMOTE_PIN: undefined, JA_PIN: undefined, SETUP_PIN: undefined },
    { REMOTE_PIN: '4726', JA_PIN: '2580', SETUP_PIN: '3691' },
  ];
  for (const env of CASES) {
    await withEnv(env, async () => {
      const d = await boot({
        configFile: () => ({ state: 'unusable', reason: 'typo', line: 7, duplicates: [] }),
        obs: { connected: false }, cheesy: {}, statusSettleMs: 0,
      });
      try {
        // Proof the page under test does carry them, to the desk laptop.
        const here = (await page(d.port, `localhost:${d.port}`)).body;
        assert.match(here, new RegExp(`Desk PIN: <b>${env.REMOTE_PIN ?? '0864'}</b>`));
        assert.match(here, /config\.json has a typo near line 7/);

        const others = [
          // Another device on the venue Wi-Fi.
          await page(d.port, `172.22.0.23:${d.port}`),
          // A page on the desk laptop that pointed its own name at it.
          await page(d.port, `attacker.example:${d.port}`),
          await page(d.port, `localhost.attacker.example:${d.port}`),
        ];
        // A local name from an address that is not this machine's own.
        // Windows and Linux both answer the whole 127/8 as loopback; where a
        // machine refuses to bind it, the Host cases above still stand.
        try { others.push(await page(d.port, `localhost:${d.port}`, '127.0.0.2')); } catch { /* see above */ }
        for (const { status, body } of others) {
          assert.equal(status, 200, 'the page still goes out');
          assert.match(body, /172\.22\.0\.23:8720\//, 'with the address, which is not a secret');
          assert.match(body, /Put the show on a projector or TV/);
          assert.match(body, /Put the graphics into the video switcher/);
          assert.match(body, /Something not working\?/);
          assert.doesNotMatch(body, /0864|1357|4567|4726|2580|3691/, 'no code, default or chosen');
          assert.doesNotMatch(body, /Desk PIN:|shipped default|Still on the/, 'not even that one is a default');
          assert.doesNotMatch(body, /typo|line 7/, 'the desk\'s own file is the desk\'s business');
        }
      } finally {
        await d.done();
      }
    });
  }
  // And the words every visitor gets carry no code at all.
  assert.doesNotMatch(JSON.stringify([FRONT_CHOICES, FRONT_HELP, SCREEN_GROUPS, SURFACES]),
    /0864|1357|4567/);
});

test('the page says which computer runs the desk, first, on every computer', async () => {
  // The AV table runs several Windows computers side by side, and nothing on
  // any of them said which one is the desk.
  const d = await boot({ obs: { connected: false }, cheesy: {}, statusSettleMs: 0 });
  try {
    const here = (await page(d.port, `localhost:${d.port}`)).body;
    assert.match(here, /This computer runs the Content Desk\./);
    assert.doesNotMatch(here, /does not run the Content Desk/);
    // The desk laptop opened by its network name is still the desk laptop.
    const byName = (await page(d.port, `172.22.0.23:${d.port}`)).body;
    assert.match(byName, /This computer runs the Content Desk\./);
    // Another computer: Windows and Linux answer the whole 127/8 as loopback
    // but 127.0.0.2 is not one of this machine's own addresses.
    let other: string | null = null;
    try { other = (await page(d.port, `172.22.0.23:${d.port}`, '127.0.0.2')).body; } catch { other = null; }
    if (other !== null) {
      assert.match(other, /This computer does not run the Content Desk\./);
      assert.match(other, /the computer at http:\/\/172\.22\.0\.23:8720/);
    }
  } finally {
    await d.done();
  }
});

// ---- the help --------------------------------------------------------------------------

test('the help says what you see, then what to do, and names only what the desk console really has', async () => {
  const d = await boot();
  try {
    const { body } = await page(d.port, `172.22.0.23:${d.port}`);
    const help = slice(body, '<section class="help" id="help"', '</section>');
    assert.match(help, /Something not working\?/);
    const ids = FRONT_HELP.map(h => h.id);
    assert.equal(new Set(ids).size, ids.length, 'every answer has its own anchor');
    for (const h of FRONT_HELP) {
      assert.ok(help.includes(`<div class="q" id="help-${h.id}"><dt>${escaped(h.see)}</dt><dd>${h.fix}</dd></div>`), h.id);
      assert.ok(h.fix.length < 650, `${h.id}: a line or two, not a chapter (${h.fix.length} characters)`);
    }
    // The problems the volunteers actually met, each with its own answer.
    for (const id of ['white', 'empty', 'reach', 'field', 'pin', 'stopped', 'outline']) {
      assert.ok(ids.includes(id), `an answer for "${id}"`);
    }
    const said = (id: string): string => visible(FRONT_HELP.find(h => h.id === id)!.fix);
    assert.match(said('white'), /Put the show on a projector or TV/);
    // White is now only ever ?key=alpha in a plain browser (C8: everything
    // else draws on black), so the answer names it and says what to do.
    assert.match(said('white'), /\?key=alpha/);
    assert.match(said('white'), /draw on black, ready for a video switcher/);
    assert.match(said('empty'), /Test Match/);
    assert.match(said('reach'), /Allow access/);
    assert.match(said('reach'), /never localhost/);
    assert.match(said('reach'), /keeps devices apart/);
    // The field answer asks for no command prompt and no flag: the desk looks
    // by itself, and an address the search cannot find goes on a page.
    assert.match(said('field'), /looks for the field by itself/);
    assert.match(said('field'), /nothing needs restarting/);
    assert.match(said('field'), /Event settings/);
    assert.match(FRONT_HELP.find(h => h.id === 'field')!.fix, /href="\/s\/setup#connections"/);
    assert.doesNotMatch(said('field'), /cheesy-host|START-DESK|\bcmd\b|command/i);
    const launcher = readFileSync(join(REPO, 'tools', 'launcher', 'Launcher.cs'), 'utf8');
    // The folder the "stopped" answer sends the volunteer to is the one it unpacks to.
    assert.match(launcher, /FolderName = "CalGames2026-ContentDesk"/);
    assert.match(launcher, /Path\.Combine\(DownloadsFolder\(\), FolderName\)/);
    assert.match(said('stopped'), /CalGames2026-ContentDesk folder in Downloads/);
    assert.match(said('stopped'), /Double-click the exe again/);

    // Every link the page makes into the help lands on an answer that exists.
    const here = (await page(d.port, `localhost:${d.port}`)).body;
    for (const m of here.matchAll(/href="#help-(\w+)"/g)) assert.ok(ids.includes(m[1]!), `#help-${m[1]} exists`);

    // The console words the answers quote are the console's words. The
    // screen buttons are built from the control map, so Auto is read there.
    const desk = readFileSync(join(SURFACE_DIR, 'desk', 'index.html'), 'utf8');
    for (const h of FRONT_HELP) {
      for (const label of h.deskLabels ?? []) {
        assert.ok(desk.includes(label), `${h.id}: the desk console still says "${label}"`);
        assert.ok(h.fix.includes(label) || label.startsWith('id='), `${h.id}: and the answer quotes it`);
      }
    }
    assert.ok(CONTROL_ACTIONS.some(a => a.id === 'screen.auto' && a.label === 'Auto'), 'the Auto button is Auto');
    assert.match(said('stuck'), /press Auto/);
  } finally {
    await d.done();
  }
});

// ---- the status strip --------------------------------------------------------------------

/** The status strip's row for `label`, as text. */
const statusRow = (html: string, label: string): { level: string; text: string } => {
  const m = new RegExp(`<li class="st-(\\w+)">(?:(?!</li>).)*?<b>${label}:</b>((?:(?!</li>).)*)</li>`, 's').exec(html);
  return { level: m?.[1] ?? '', text: visible(m?.[2] ?? '').trim() };
};

test('the status strip says how the field and OBS stand, from what the desk already holds', async () => {
  // Nothing at all: no field and not looking for one, and nobody turned OBS on.
  const bare = await boot();
  try {
    const { body } = await page(bare.port, `172.22.0.23:${bare.port}`);
    const field = statusRow(body, 'Field');
    assert.equal(field.level, 'warn');
    assert.match(field.text, /not connected, and this desk is not looking for it, so matches are run by hand/);
    assert.match(body, /<b>Field:<\/b> [^<]*<a href="#help-field">/, 'with the way to fix it');
    const obs = statusRow(body, 'OBS');
    assert.equal(obs.level, 'off', 'no OBS is not a problem');
    assert.equal(obs.text, 'not used on this setup.');
    assert.doesNotMatch(obs.text, /config\.json|enabled/, 'and no file to edit for something this setup lacks');
  } finally {
    await bare.done();
  }

  // Still looking for the field by itself (the finder, C3): gray and calm,
  // because the usual answer is "wait", not "do something".
  const looking = await boot({ field: { adapter: null, host: null, searching: true } });
  try {
    const field = statusRow((await page(looking.port, `172.22.0.23:${looking.port}`)).body, 'Field');
    assert.equal(field.level, 'unknown');
    assert.match(field.text, /searching for the field by itself/);
    assert.match(field.text, /connects as soon as the field is up/);
  } finally {
    await looking.done();
  }

  // A bridge and OBS, both still shaking hands just after the start.
  const early = await boot({ cheesy: {}, obs: { connected: false } });
  try {
    const { body } = await page(early.port, `localhost:${early.port}`);
    assert.equal(statusRow(body, 'Field').level, 'unknown');
    assert.match(statusRow(body, 'Field').text, /connecting now/);
    assert.match(statusRow(body, 'OBS').text, /connecting now/);
  } finally {
    await early.done();
  }

  // The same, once they have had time and still have not answered.
  const late = await boot({ cheesy: {}, obs: { connected: false }, statusSettleMs: 0 });
  try {
    const { body } = await page(late.port, `localhost:${late.port}`);
    assert.equal(statusRow(body, 'Field').level, 'warn');
    assert.match(statusRow(body, 'Field').text, /not answering right now/);
    assert.equal(statusRow(body, 'OBS').level, 'warn');
    assert.match(statusRow(body, 'OBS').text, /switched on for this desk, but not answering/);
    assert.match(statusRow(body, 'OBS').text, /No OBS here: nothing to do, the show runs without it/,
      'the way out for a venue without it');
    assert.doesNotMatch(statusRow(body, 'OBS').text, /config\.json|"enabled"/, 'never a file to edit');

    // The field answers, parked on its Test Match: connected, nothing loaded.
    late.bus.emit({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } });
    let now = (await page(late.port, `localhost:${late.port}`)).body;
    assert.equal(statusRow(now, 'Field').level, 'ok');
    assert.match(statusRow(now, 'Field').text, /connected, with no match loaded yet/);
    assert.match(statusRow(now, 'Field').text, /Test Match does not count/);

    // A real match loads, with a name the page must print as text.
    late.bus.emit({ type: 'match.loaded', source: 'cheesy',
      payload: { id: 'Q12', displayName: 'Qualification 12 <b>', red: [], blue: [] } });
    now = (await page(late.port, `localhost:${late.port}`)).body;
    assert.match(now, /<b>Field:<\/b> connected\. Match on the screens: Qualification 12 &lt;b&gt;\./);
  } finally {
    await late.done();
  }

  const both = await boot({ obs: { connected: true } });
  try {
    assert.equal(statusRow((await page(both.port, `localhost:${both.port}`)).body, 'OBS').level, 'ok');
  } finally {
    await both.done();
  }

  const practice = await boot({ mode: 'demo' });
  try {
    const field = statusRow((await page(practice.port, `localhost:${practice.port}`)).body, 'Field');
    assert.equal(field.level, 'off');
    assert.match(field.text, /practice mode plays a pretend match/);
  } finally {
    await practice.done();
  }
});

test('the page goes out whole when every check it makes throws', async () => {
  await withEnv({ REMOTE_PIN: '4726' }, async () => {
    const bus = new EventBus();
    const screens = new ScreenRegistry();
    screens.list = () => { throw new Error('screens went away'); };
    const d = await boot({
      bus,
      cheesy: {},
      screens,
      atem: { get status(): never { throw new Error('the switcher went away'); } },
      obs: { get connected(): boolean { throw new Error('obs went away'); } },
      configFile: () => { throw new Error('the report itself is broken'); },
      lanBase: () => { throw new Error('no network stack'); },
    });
    // After the server is up, so only what the page reads is broken.
    Object.defineProperty(bus, 'state', { get() { throw new Error('state went away'); } });
    const { warn } = console;
    const said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    try {
      for (const host of [`localhost:${d.port}`, `172.22.0.23:${d.port}`]) {
        const { status, body } = await page(d.port, host);
        assert.equal(status, 200, host);
        assert.equal(statusRow(body, 'Field').level, 'unknown', host);
        assert.match(statusRow(body, 'Field').text, /could not be checked just now/);
        assert.equal(statusRow(body, 'OBS').level, 'unknown', host);
        assert.equal(statusRow(body, 'Switcher').level, 'unknown', host);
        assert.equal(statusRow(body, 'Screens').level, 'unknown', host);
        assert.match(body, /<div class="start"><p class="addr warn">This desk's address could not be read just now/);
        for (const c of FRONT_CHOICES) assert.ok(body.includes(`href="${c.href}"`), `${host}: ${c.title}`);
        assert.match(body, /Something not working\?/);
        assert.equal([...body.matchAll(/<a class="row" /g)].length, SURFACES.length, 'and the whole list');
        assert.doesNotMatch(body, /4726/, 'a box that fails says nothing it was guarding');
        assert.doesNotMatch(body, /From another computer/, 'no address to offer, so none is made up');
      }
      assert.ok(said.some(l => /\[front\] the Start here box could not be built/.test(l)), said.join('\n'));
      assert.ok(said.every(l => !/went away|broken|network stack/.test(l)), 'the part, never the error text');
    } finally {
      console.warn = warn;
      await d.done();
    }
  });
});

// ---- the switcher, the screens and the codes (tonight's kit) --------------------

/** The rack's switcher once connected: Cheesy's overlay on input 6, keyed on DSK1. */
const RACK = {
  state: 'connected', host: '10.0.100.40', model: 'ATEM Constellation 4K', protocol: '2.32',
  videoMode: { id: 13, label: '1080p59.94', width: 1920, height: 1080, fps: 59.94 },
  program: 1, preview: 2,
  inputs: [{ id: 1, longName: 'Field <Wide>', shortName: 'WIDE' }, { id: 6, longName: 'Graphics', shortName: 'GFX' }],
  keyers: [{ kind: 'downstream', me: null, index: 1, onAir: true, type: 'luma', fillSource: 6, keySource: 6 }],
  since: 1, lastHeard: 1, error: null,
};

test('the status strip says how the switcher and the screens stand, with addresses only on the desk laptop', async () => {
  const screens = new ScreenRegistry();
  const d = await boot({ atem: { status: RACK }, screens, statusSettleMs: 0 });
  try {
    // Nothing open yet.
    let here = (await page(d.port, `localhost:${d.port}`)).body;
    assert.equal(statusRow(here, 'Switcher').level, 'ok');
    assert.equal(statusRow(here, 'Switcher').text,
      'ATEM Constellation 4K at 10.0.100.40 running 1080p59.94. Program: Field <Wide>. Keyed on air: DSK1 (Graphics).');
    assert.match(here, /Program: Field &lt;Wide&gt;\./, 'the switcher\'s own labels are printed as text');
    assert.equal(statusRow(here, 'Screens').level, 'warn');
    assert.match(statusRow(here, 'Screens').text, /no program page is open anywhere/);
    // The desk console reads the same status, whole, with the desk PIN.
    const atem = await (await fetch(`http://127.0.0.1:${d.port}/api/atem`,
      { headers: { 'x-desk-pin': '0864' } })).json();
    assert.deepEqual(atem, { ...RACK, graphicsInput: null });

    // The switcher feed opens in a window on the AV table's computer.
    screens.add('feed', { surface: 'program', addr: '::ffff:10.0.100.21' });
    screens.hello('feed', { t: 'hello', surface: 'program', key: 'luma', embedded: false, full: false,
      w: 1366, h: 700, sw: 1366, sh: 768, dpr: 1, hz: 60, showing: 'desk' });
    here = (await page(d.port, `localhost:${d.port}`)).body;
    const mine = statusRow(here, 'Screens');
    assert.equal(mine.level, 'warn');
    assert.match(mine.text, /open on 1 page: 10\.0\.100\.21/);
    assert.match(mine.text, /in a window, not full screen/);
    assert.match(mine.text, /1366x768 screen, but the switcher runs 1080p59\.94/);
    assert.match(mine.text, /press F11/);

    // Everyone else: the same rows, no address of anything.
    const away = (await page(d.port, `172.22.0.23:${d.port}`)).body;
    const theirs = statusRow(away, 'Screens');
    assert.equal(theirs.level, 'warn');
    assert.equal(theirs.text, 'the program graphics are open on 1 computer. One of them needs a look: '
      + 'the desk laptop says which.');
    assert.equal(statusRow(away, 'Switcher').text,
      'ATEM Constellation 4K running 1080p59.94. Program: Field <Wide>. Keyed on air: DSK1 (Graphics).');
    assert.doesNotMatch(statusRow(away, 'Switcher').text + theirs.text, /10\.0\.100/);

    // Full screen at the switcher's format: all green.
    screens.hello('feed', { t: 'hello', surface: 'program', key: 'luma', embedded: false, full: true,
      w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk' });
    here = (await page(d.port, `localhost:${d.port}`)).body;
    assert.equal(statusRow(here, 'Screens').level, 'ok');
    assert.equal(statusRow(here, 'Screens').text, 'the program graphics are open on 1 page: 10.0.100.21.');

    // The clean second-stream feed (/s/program?mode=clean) on the switcher
    // instead: the graphics are on air, and the strip says so everywhere.
    screens.remove('feed');
    screens.add('clean', { surface: 'program-clean', addr: '10.0.100.21' });
    screens.hello('clean', { t: 'hello', surface: 'program-clean', key: 'luma', embedded: false, full: true,
      w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk' });
    here = (await page(d.port, `localhost:${d.port}`)).body;
    assert.equal(statusRow(here, 'Screens').text, 'the program graphics are open on 1 page: 10.0.100.21.');
    const elsewhere = statusRow((await page(d.port, `172.22.0.23:${d.port}`)).body, 'Screens');
    assert.equal(elsewhere.level, 'ok');
    assert.equal(elsewhere.text, 'the program graphics are open on 1 computer.');

    // The white page the AV table got stuck on: the see-through version in a
    // plain browser, on a desk with no OBS. Named, with what to open instead.
    screens.hello('clean', { t: 'hello', surface: 'program-clean', key: 'alpha', embedded: false, full: true,
      w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk' });
    const white = statusRow((await page(d.port, `localhost:${d.port}`)).body, 'Screens');
    assert.equal(white.level, 'warn');
    assert.match(white.text, /10\.0\.100\.21 is the see-through version made for OBS, so a plain browser shows it on white/);
    assert.match(white.text, /\/s\/program on the end and nothing after it, then press F11/);
  } finally {
    await d.done();
  }

  // Just after a start, the pages are still reconnecting: wait, not warn.
  const early = await boot({ screens: new ScreenRegistry() });
  try {
    const row = statusRow((await page(early.port, `localhost:${early.port}`)).body, 'Screens');
    assert.equal(row.level, 'unknown');
    assert.match(row.text, /waiting for the screens to reconnect/);
  } finally {
    await early.done();
  }
});

test('a code still on its default links the desk laptop to the page that changes it, and nobody else', async () => {
  for (const env of [
    { REMOTE_PIN: undefined, JA_PIN: undefined, SETUP_PIN: undefined },
    { REMOTE_PIN: '4726', JA_PIN: undefined, SETUP_PIN: '3691' },
  ]) {
    await withEnv(env, async () => {
      const d = await boot();
      try {
        const here = slice((await page(d.port, `localhost:${d.port}`)).body, '<div class="start">', '</div>');
        assert.match(here, /<a href="\/s\/setup#codes">Change the codes<\/a> on Event settings/);
        assert.match(here, /Judge Advisor changes the awards code on <a href="\/s\/awards">their own page<\/a>/);
        assert.doesNotMatch(visible(here), /START-DESK|\/pin:|config\.json/, 'no flag to type, no file to edit');
        const away = (await page(d.port, `172.22.0.23:${d.port}`)).body;
        assert.doesNotMatch(away, /Change the codes/, 'a default-code warning stays on the desk laptop');
      } finally {
        await d.done();
      }
    });
  }
  await withEnv({ REMOTE_PIN: '4726', JA_PIN: '2580', SETUP_PIN: '3691' }, async () => {
    const d = await boot();
    try {
      assert.doesNotMatch((await page(d.port, `localhost:${d.port}`)).body, /Change the codes/,
        'every code changed: nothing to say');
    } finally {
      await d.done();
    }
  });
});
