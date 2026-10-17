/**
 * The one-page quick start, held to the screens it describes.
 *
 * On a test night with no OBS a screen stuck on white, and the volunteers
 * gave up rather than troubleshoot through a 43-page PDF. QUICK-START.md is
 * now the first thing they read, and it holds only what software cannot do
 * for itself: five steps for a person's hands, then where the desk itself
 * explains each problem. A sheet like that is only worth anything if every
 * line it quotes is the line on the screen in front of them, and if each
 * place it points at really says what it promises. So these run the code
 * that draws each screen (the program's standby lines, the real front page,
 * the doors check's Screens row, the chooser's cards, the desk console and
 * Event settings) and check the quick start and the handbook against what it
 * says. When a screen's words change, this fails and names the line to fix.
 *
 * The page count itself is checked where the PDF is made (npm run handbook);
 * here the budget is words, which needs no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from './bus.ts';
import { DEFAULTS } from './config.ts';
import { CONTROL_ACTIONS } from './control-map.ts';
import type { CheesyAdapter } from './ingest/cheesy/adapter.ts';
import { MediaLibrary } from './media.ts';
import type { ScreenInfo } from './screens.ts';
import { FRONT_CHOICES, FRONT_HELP, startServer } from './server.ts';
import { DEFAULT_CODES } from './settings.ts';
import { screensVital } from './vitals.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
/** Words as a reader meets them: one space wherever the source wrapped a line. */
const flat = (t: string): string => t.replace(/\s+/g, ' ');

const QS = read('QUICK-START.md');
const HANDBOOK = flat(read('RUN-THE-DESK.md'));

interface Decide {
  standbyLine: (a: { state: unknown; screen: string; link: string; address: string })
    => { text: string; warn: boolean } | null;
  feedNote: (host: unknown) => string;
}
// @ts-expect-error untyped browser module, cast on the same line
const decide = (await import('../../../surfaces/program/decide.js')) as Decide;

interface Client {
  displayModeFor: (o: { asked?: string | null; markup?: string | null; alone?: string | null;
    inObs?: boolean; embedded?: boolean }) => string;
}
// @ts-expect-error untyped browser module, cast on the same line
const client = (await import('../../../surfaces/_shared/desk-client.js')) as Client;

/** What the program's standby card says, from the real decide.js, for each case a volunteer meets. */
function standbyLines(address: string, host: string) {
  const waiting = (cheesy: boolean) => ({ connected: { cheesy }, screenHold: false, match: null });
  const line = (state: unknown, link: string): string => {
    const got = decide.standbyLine({ state, screen: 'blank', link, address });
    assert.ok(got, 'an empty program screen has a line to show');
    return got.text;
  };
  return {
    connecting: line(null, 'connecting'),
    noField: line(waiting(false), 'up'),
    fieldUp: line(waiting(true), 'up'),
    deskDown: line(waiting(false), 'down'),
    feedDown: decide.feedNote(host),
  };
}

test('the quick start quotes the lines the projector shows, as the projector says them', () => {
  const real = standbyLines('http://172.22.0.23:8720', '10.0.100.9');
  // The quick start quotes the start of the one line that asks somebody to
  // act, the part a volunteer reads first and matches against the screen.
  // Every other line says what to do on its own, which the sheet relies on
  // ("They say what it is waiting for"); the handbook quotes them all whole.
  const quoted: [keyof typeof real, string][] = [
    ['fieldUp', 'Connected to the field. Waiting for it to load a match'],
  ];
  for (const [which, words] of quoted) {
    assert.ok(QS.includes(`*${words}*`), `QUICK-START.md quotes "${words}"`);
    assert.ok(real[which].startsWith(words),
      `the projector's ${which} line now reads "${real[which]}": update QUICK-START.md`);
  }
  // The one line that asks somebody to act on the field says what does not
  // count, which is the trap the white-screen night fell into.
  assert.match(real.fieldUp, /Test Match does not count/);
  assert.match(QS, /Test Match does not count/);
});

test('the handbook quotes every standby line whole, with ADDRESS and HOST where the screen prints them', () => {
  const real = standbyLines('http://ADDRESS', 'HOST');
  for (const [which, text] of Object.entries(real)) {
    assert.ok(text, `${which} has words`);
    assert.ok(HANDBOOK.includes(`*${text}*`),
      `RUN-THE-DESK.md (chapter 4, What the projector says) should quote, word for word: ${text}`);
  }
});

test('every card the quick start sends people to is a card on Pick a screen, in the chooser\'s words', () => {
  const watch = read('surfaces/watch/index.html');
  const cards = [...watch.matchAll(/\{ id: '(\w+)', name: '([^']+)', for: '([^']+)'/g)]
    .map(m => ({ id: m[1]!, name: m[2]!, for: m[3]! }));
  assert.deepEqual(cards.map(c => c.id), ['program', 'side', 'next', 'trivia', 'arcade'],
    'the chooser has the five cards, in this order');
  assert.match(watch, /<h1>Pick a screen<\/h1>/);
  assert.match(watch, /F11/, 'the chooser itself says how to go full screen');

  for (const c of cards) assert.ok(QS.includes(`**${c.name}**`), `QUICK-START.md names the ${c.name} card`);
  // The For lines a volunteer matches against the display they are standing at.
  for (const id of ['program', 'side', 'next']) {
    const c = cards.find(x => x.id === id)!;
    assert.ok(QS.includes(`*For ${c.for}*`), `QUICK-START.md quotes "For ${c.for}"`);
  }
  // The handbook's table has every card, in the chooser's order, with its For line.
  let at = -1;
  for (const c of cards) {
    const forLine = c.for.charAt(0).toUpperCase() + c.for.slice(1);
    const row = `| ${forLine} | **${c.name}** | \`/s/watch?screen=${c.id}\` |`;
    const i = HANDBOOK.indexOf(row);
    assert.ok(i > at, `RUN-THE-DESK.md chapter 5 has the ${c.name} row, after the one before it: ${row}`);
    at = i;
  }
  // No feed: the kiosk asks the program for the backdrop, which is what the
  // quick start promises a projector shows (and what makes its lines visible).
  assert.match(watch, /key=fill&kiosk=1/);
  // A switcher keying the graphics needs the black one, and the chooser says
  // the same input replaces the field's own score display.
  assert.match(watch, /luma key/);
  assert.match(watch, /field\\'s own score display|field's own score display/);
  // The switcher's input replaces Cheesy Arena's overlay and hands back to it,
  // as the front page's switcher choice promises.
  const choice = FRONT_CHOICES.find(c => c.href === '/s/program')?.text ?? '';
  assert.match(choice, /Cheesy's comes back by itself/);
  assert.ok(QS.includes("Cheesy's comes back on that input by itself"), 'QUICK-START.md step 5 says so');
});

test('what the docs say each address looks like is what the display rules decide', () => {
  const { displayModeFor } = client;
  // ?key=luma is black whatever the page would choose for itself: the
  // address the quick start and the handbook give a switcher.
  for (const alone of ['luma', 'fill', null]) {
    assert.equal(displayModeFor({ asked: 'luma', markup: 'alpha', alone }), 'luma');
  }
  // An OBS setup made before any of this stays see-through.
  const program = read('surfaces/program/program.js');
  const alone = /applyDisplayMode\(\{ alone: '(\w+)' \}\)/.exec(program)?.[1] ?? null;
  assert.ok(alone, 'program.js names the look it takes on its own');
  assert.equal(displayModeFor({ markup: 'alpha', alone, inObs: true }), 'alpha');
  assert.equal(displayModeFor({ markup: 'alpha', alone, embedded: true }), 'alpha');
  // On its own in a browser: the handbook says graphics on black.
  assert.equal(displayModeFor({ markup: 'alpha', alone }), 'luma',
    'the program on its own is no longer black: change "graphics on black" in RUN-THE-DESK.md chapter 4, '
    + 'Appendix A, docs/13 and README.md');
  assert.ok(HANDBOOK.includes('`ADDRESS/s/program` opened by itself in a browser is graphics on black'));
  // And the address that sends a page white, which the fix table names.
  assert.equal(displayModeFor({ asked: 'alpha', markup: 'alpha', alone }), 'alpha');
});

/** A program page as the registry holds it after its hello (C2). */
const page = (o: Partial<ScreenInfo>): ScreenInfo => ({
  id: 'p1', surface: 'program', addr: '10.0.100.21', since: 0, key: 'luma', embedded: false,
  full: true, w: 1920, h: 1080, sw: 1920, sh: 1080, dpr: 1, hz: 60, showing: 'desk', backup: 'ready',
  ...o,
});

test('the Screens line says what the quick start sends people to it for', () => {
  // The fix table's white page: "the Screens line ... names that computer
  // and the address to open instead", on a desk with no OBS.
  const white = screensVital([page({ key: 'alpha' })], { obs: false });
  assert.equal(white.level, 'warn');
  assert.match(white.detail, /10\.0\.100\.21/, 'it names the computer');
  assert.match(white.detail, /white/, 'it says white');
  assert.match(white.fix ?? '', /^On 10\.0\.100\.21, open this desk's address with \/s\/program on the end and nothing after it/,
    'it gives that computer the address to open');
  assert.ok(QS.includes('names that computer and the address to open instead'));

  // Step 3: "Screens names that computer, and anything to fix there".
  const fine = screensVital([page({})], { obs: false });
  assert.equal(fine.level, 'ok');
  assert.match(fine.detail, /10\.0\.100\.21/);
  const windowed = screensVital([page({ full: false })], { obs: false });
  assert.equal(windowed.level, 'warn');
  assert.match(windowed.fix ?? '', /10\.0\.100\.21, click the page and press F11/);
  assert.ok(QS.includes('**Screens** names that computer, and anything to fix there'));

  // No program page anywhere says where to open one, in the sheet's words.
  const none = screensVital([], { obs: false });
  assert.match(none.fix ?? '', /\/s\/program on the end, and press F11/);
});

// ---- the front page, from the real server ----------------------------------------------

async function boot(cheesy: boolean, searching = false) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-quick-'));
  const bus = new EventBus();
  const server = startServer({
    bus, media: new MediaLibrary(dir), root: dir, port: 0, host: '127.0.0.1',
    config: structuredClone(DEFAULTS), lanBase: 'http://172.22.0.23:8720',
    configFile: () => ({ state: 'read', duplicates: [] }),
    cheesy: (cheesy ? {} : null) as CheesyAdapter | null, obs: null, statusSettleMs: 0,
    ...(searching ? { field: { adapter: null, host: null, searching: true } } : {}),
  });
  const port = await server.listening;
  return { bus, port, done: async () => { server.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** The front page's words, as the browser on the desk laptop shows them. */
const frontPage = (port: number): Promise<string> => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/', headers: { host: `localhost:${port}` } }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve(flat(body
      .replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))));
  }).on('error', reject).end();
});

test('the front page says what the quick start says it says', async () => {
  const off = await boot(false);
  try {
    const page = await frontPage(off.port);
    // Step 2: the line the browser opens on.
    const opens = 'The desk is running. Pick what this computer is for.';
    assert.ok(page.includes(opens), 'the front page still opens with that line');
    assert.ok(QS.includes(`*${opens}*`), 'QUICK-START.md quotes it');
    // Step 2 and step 5: the status lines and the Start here box, on the desk laptop.
    for (const words of ['Start here', 'This desk on the event network', 'Desk PIN', 'Switcher:',
      'Screens:', 'Still on the shipped default', 'Change the codes', 'Something not working?',
      'If you use OBS']) {
      assert.ok(page.includes(words), `the front page shows "${words}"`);
      assert.ok(QS.includes(words.replace(/:$/, '')), `QUICK-START.md names "${words}"`);
    }
    // Step 5 clicks the link by its own words, where the page puts it.
    assert.ok(QS.includes('click **Change the codes** in **Start here**'), 'QUICK-START.md step 5 names the link');
    assert.ok(page.includes('Fill the screens with sample data'), 'the handbook sends people to this link');
    assert.ok(HANDBOOK.includes('Fill the screens with sample data'));
    assert.ok(page.includes('print the QR posters'), 'the handbook sends people to this link');
    assert.ok(HANDBOOK.includes('**print the QR posters**'));
  } finally {
    await off.done();
  }

  // Step 2, before the field is up: the desk looks by itself, and says so.
  const looking = await boot(false, true);
  try {
    assert.match(await frontPage(looking.port), /Field: searching for the field by itself/);
    assert.ok(QS.includes('*searching*'), 'QUICK-START.md step 2 quotes the searching state');
    assert.match(QS, /finds the field and the video switcher by itself/);
  } finally {
    await looking.done();
  }

  const on = await boot(true);
  try {
    on.bus.emit({ type: 'arena.status', source: 'cheesy', payload: { cheesy: true } });
    assert.match(await frontPage(on.port), /Field: connected/);
    assert.ok(QS.includes('*Field: connected*'), 'QUICK-START.md step 2 quotes the status line');
  } finally {
    await on.done();
  }

  // The big buttons the quick start and the handbook name are the front page's own.
  const titles = FRONT_CHOICES.map(c => c.title);
  for (const t of ['This laptop runs the show', 'Announcer tablet', 'Judge Advisor']) {
    assert.ok(titles.includes(t), `the front page has a "${t}" button`);
    assert.ok(QS.includes(`**${t}**`), `QUICK-START.md names "${t}"`);
  }
  // Step 3 is the front page's switcher choice, and opens the page it opens.
  const switcher = FRONT_CHOICES.find(c => c.title === 'Put the graphics into the video switcher');
  assert.ok(switcher, 'the front page has the switcher choice');
  assert.equal(switcher.href, '/s/program');
  assert.ok(QS.includes(`**${switcher.title}.**`), 'QUICK-START.md step 3 is titled as the button is');
  assert.ok(QS.includes('`s/program`'), 'and gives the same address');
  // Step 4 is the projector choice.
  assert.ok(FRONT_CHOICES.some(c => c.href === '/s/watch'), 'the front page has the projector choice');
  for (const t of titles) assert.ok(HANDBOOK.includes(`**${t}**`), `RUN-THE-DESK.md names "${t}"`);
  // The handbook's field steps name the state the front page's status and help name.
  assert.ok(FRONT_HELP.some(h => h.see.startsWith('Field: searching')), 'the help has the field entry');
  assert.ok(HANDBOOK.includes('*Field: searching*'), 'RUN-THE-DESK.md chapter 9 names it');
});

test('the desk console buttons it names are on the desk console', () => {
  const html = read('surfaces/desk/index.html');
  const desk = flat(html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&'));
  for (const label of ['Simple', 'Doors check', 'Field down? Run matches by hand', 'Load a match by hand']) {
    assert.ok(desk.includes(label), `the desk console has "${label}"`);
    assert.ok(QS.includes(`**${label}**`), `QUICK-START.md names "${label}"`);
  }
  // It opens in Simple, as the sheet says, and Simple keeps the field-down band.
  assert.match(html, /<html[^>]*data-view="simple"/, 'the console opens in Simple');
  assert.match(html, /<summary data-simple>Field down\? Run matches by hand<\/summary>/,
    'Simple shows the field-down band');
  // The band's own hint names the keys the sheet names.
  assert.ok(desk.includes('the keys 1 to 5'), 'the console names the keys 1 to 5');
  assert.ok(QS.includes('the keys 1 to 5'));
  // The handbook's match-day table, Simple view paragraph and field-down steps.
  for (const label of ['Main screen (program)', 'Delay card', 'Field delay', 'Hide card', 'Safety message',
    'Put on every screen', 'Awards ceremony', 'Show the award', 'Reveal the winner', 'Everything',
    'Using OBS? Show the camera controls']) {
    assert.ok(desk.includes(label), `the desk console has "${label}"`);
    assert.ok(HANDBOOK.includes(label), `RUN-THE-DESK.md names "${label}"`);
  }
  assert.ok(desk.includes('Q W E') && desk.includes('A S D'), 'the console names the hand-scoring keys');

  // Event settings, where step 5 changes the codes and the handbook types
  // the field's and the switcher's addresses.
  const setupHtml = read('surfaces/setup/index.html');
  const setup = flat(setupHtml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&'));
  assert.ok(setup.includes('Event settings') && setup.includes('The settings code'),
    'it opens with the settings code');
  assert.ok(setup.includes('Access codes'), 'Event settings has "Access codes"');
  assert.ok(QS.includes('**Access codes**'), 'QUICK-START.md names "Access codes"');
  // "Change the codes" lands on them: the front page links /s/setup#codes,
  // and the page scrolls that anchor to the codes once it is unlocked.
  assert.match(setupHtml, /\['codes', 'codesSec'\]/, 'Event settings jumps #codes to the codes');
  assert.match(setupHtml, /<section id="codesSec">/);
  // The codes the sheet prints are the ones the desk ships with.
  assert.ok(QS.includes(`settings code, \`${DEFAULT_CODES.settings}\``), 'the shipped settings code');
  assert.ok(QS.includes(`shipped as \`${DEFAULT_CODES.awards}\``), 'the shipped awards code');
  for (const label of ['Connections', 'Save connections', 'Field address (Cheesy Arena)', 'FRC Nexus API key',
    'Video switcher address (ATEM)', 'Restart the desk']) {
    assert.ok(setup.includes(label), `Event settings has "${label}"`);
    assert.ok(HANDBOOK.includes(label), `RUN-THE-DESK.md names "${label}"`);
  }

  // Blank and Auto are drawn from the shared client's screen list.
  const client = read('surfaces/_shared/desk-client.js');
  for (const label of ['Blank', 'Auto']) {
    assert.ok(client.includes(`label: '${label}'`), `the main screen row has a "${label}" button`);
    assert.ok(QS.includes(`**${label}**`), `QUICK-START.md names "${label}"`);
  }

  // Keys 1 to 5, named in the handbook as the console and a Stream Deck name them.
  const steps = ['match.preview', 'match.armed', 'match.start', 'match.end', 'match.score']
    .map(id => CONTROL_ACTIONS.find(a => a.id === id)?.label);
  assert.ok(steps.every(Boolean), 'the control map has all five match steps');
  assert.ok(HANDBOOK.includes(`are ${steps.join(', ')}, Abort`),
    `RUN-THE-DESK.md lists the match steps as the console does: ${steps.join(', ')}`);
});

test('one page of plain words: the shape the quick start promises', () => {
  const dashes = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
  for (const file of ['QUICK-START.md', 'RUN-THE-DESK.md', 'README.md', 'docs/13-deployment.md',
    'tools/launcher/build.ps1', 'tools/make-handbook.mjs']) {
    const text = read(file);
    for (const d of dashes) assert.ok(!text.includes(d), `${file} has no em or en dash`);
  }

  assert.ok(!/surface/i.test(QS), 'no "surface": a volunteer reads "screen"');
  for (const para of QS.split(/\n\s*\n/)) {
    if (/Browser Source/.test(para)) assert.match(para, /^\*\*Using OBS\?\*\*/, 'OBS words stay in the OBS note');
  }
  // A coarse budget for one printed page; the PDF build counts the real page.
  const words = QS.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 850, `QUICK-START.md is ${words} words: one printed page holds about 850`);

  // Five steps, only the ones a person's hands have to take, each ending in
  // what you should see.
  const steps = QS.match(/^\d+\. \*\*/gm) ?? [];
  assert.equal(steps.length, 5, 'five numbered steps');
  assert.equal((QS.match(/^ {3}\*\*You should see\*\*/gm) ?? []).length, 5, 'each with a You should see line');
  // Nothing a volunteer is asked to do is a file to edit or a flag to type.
  assert.ok(!/config\.json|desk-pin\.txt|\/cheesy-host|\/pin:|command prompt|PowerShell/i.test(QS),
    'no file to edit and no flag to type');

  // The fix table starts with the white page, which is why this sheet exists,
  // and stays short: each row points at the place the desk explains it.
  const fixes = QS.slice(QS.indexOf('## If you see this'));
  const rows = fixes.split('\n')
    .filter(l => l.startsWith('| ') && !l.startsWith('| You see') && !/^\|[\s:|-]+\|$/.test(l));
  assert.ok(rows.length >= 1 && rows.length <= 6, `one to six fix rows, not ${rows.length}`);
  assert.match(rows[0]!, /^\| \*\*A white page/);

  // Every table row has its header's cell count: the PDF renderer splits on pipes.
  const lines = QS.split('\n');
  lines.forEach((line, i) => {
    if (!/^\|.*\|$/.test(line) || !/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) return;
    const width = line.split('|').length;
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith('|'); j++) {
      assert.equal(lines[j]!.split('|').length, width, `QUICK-START.md table row: ${lines[j]}`);
    }
  });

  // Every page it names exists.
  for (const m of QS.matchAll(/\/s\/([a-z]+)/g)) {
    assert.ok(existsSync(join(REPO, 'surfaces', m[1]!, 'index.html')), `/s/${m[1]} is a page the desk serves`);
  }
});

test('the doors into the docs lead to the quick start first', () => {
  const readme = read('tools/launcher/build.ps1');
  const note = readme.slice(readme.indexOf('$readme = @"'), readme.indexOf('"@', readme.indexOf('$readme = @"')));
  assert.ok(note.includes('QUICK-START.pdf'), 'READ-ME-FIRST.txt names the quick start');
  assert.ok(note.indexOf('QUICK-START.pdf') < note.indexOf('RUN-THE-DESK.pdf'), 'before the handbook');
  assert.ok(!/surface|Browser Source/i.test(note), 'in plain words');

  assert.match(read('RUN-THE-DESK.md').split('\n').slice(0, 10).join('\n'), /QUICK-START/,
    'the handbook points at the quick start at the top');
  assert.match(read('README.md').split('\n').slice(0, 5).join('\n'), /QUICK-START\.md/,
    'the README points at the quick start at the top');
  assert.match(read('tools/make-handbook.mjs'), /name: 'QUICK-START'[^\n]*maxPages: 1,/,
    'npm run handbook builds QUICK-START.pdf and holds it to one page');

  // Names the screens no longer use, which would send somebody looking for a row that is not there.
  for (const file of ['RUN-THE-DESK.md', 'README.md', 'docs/13-deployment.md']) {
    const text = read(file);
    for (const stale of ['Program with the field feed', 'Program, with the field feed', 'Core is running',
      'On a pit monitor**']) {
      assert.ok(!text.includes(stale), `${file} still says "${stale}"`);
    }
  }
});
