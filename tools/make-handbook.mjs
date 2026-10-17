/**
 * Turn RUN-THE-DESK.md into RUN-THE-DESK.pdf, and QUICK-START.md into
 * QUICK-START.pdf.
 *
 *   npm run handbook
 *
 * The Markdown is the source; the PDF is what gets printed and handed to
 * volunteers, because a gym has worse Wi-Fi than it has photocopiers.
 *
 * The quick start exists because the handbook alone failed the people it was
 * for: on a test night a screen stuck on white, and the volunteers gave up
 * rather than troubleshoot through 43 pages. So the quick start is held to
 * ONE printed page, checked below on every build, and a build that lets it
 * grow past that says so and exits non-zero. One page because it now holds
 * only what software cannot do for itself: the desk finds the field and the
 * switcher, and its front page says what it found, so the sheet is the few
 * steps a person's hands have to take and where the desk explains the rest.
 *
 * No dependencies, for the same reason nothing else here has any: this repo
 * has one runtime dependency and no build step, and adding a Markdown library
 * plus a PDF library to print one document would be the tail wagging the dog.
 * So there is a small Markdown renderer below covering exactly the constructs
 * the handbook uses, and Chrome (already required for `npm run previews`)
 * does the PDF.
 *
 * If you add a Markdown construct to the handbook that this does not render,
 * it will show up as literal punctuation in the PDF. Check the output.
 */

import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = join(ROOT, '.handbook.tmp.html');

/**
 * What gets built. `maxPages` is the promise the document makes on its own
 * first line ("One page"), so the build checks it rather than trusting it.
 * `css` is added after the shared print styles: the quick start is set a
 * little tighter so one sheet holds the five steps AND the fix table, which
 * are the two things somebody holding it actually needs, at a size still
 * readable at arm's length on a cart.
 */
const DOCS = [
  { name: 'RUN-THE-DESK', title: 'Running the CalGames Content Desk', maxPages: null, css: '' },
  { name: 'QUICK-START', title: 'CalGames Content Desk: quick start', maxPages: 1, css: `
  @page { margin: 11mm 12mm 11mm; }
  body { font-size: 9.6pt; line-height: 1.4; }
  h1 { font-size: 18pt; }
  h2 { font-size: 12pt; margin: 9pt 0 4pt; padding-bottom: 2pt; }
  p { margin: 0 0 5pt; }
  ol { margin-bottom: 5pt; }
  li { margin-bottom: 3pt; }
  table { font-size: 8.6pt; margin-bottom: 0; }
  th { padding: 3pt 6pt; font-size: 8pt; }
  td { padding: 3pt 6pt; }
  th:first-child, td:first-child { width: 29%; }
` },
];

const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline formatting: code, bold, italic, links.
 *
 * Code spans are extracted FIRST and put back last, so backticked text is
 * never re-processed. Otherwise `**` inside a code span would turn into bold
 * and the reader would see formatting where the document meant literal
 * characters.
 */
function inline(text) {
  const spans = [];
  let out = esc(text).replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });

  out = out
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

/** A table row split on pipes, tolerating the leading and trailing ones. */
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

const isDivider = line => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

function render(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let list = null;                      // 'ul' | 'ol' | null

  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code.
    if (/^```/.test(line)) {
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++;
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Table: a pipe row followed by a divider row.
    if (line.includes('|') && isDivider(lines[i + 1] ?? '')) {
      closeList();
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        body.push(cells(lines[i++] ?? ''));
      }
      html.push('<table><thead><tr>'
        + head.map(c => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    // Horizontal rule. Doubles as the page-break marker: in this document a
    // rule always sits between chapters, which is exactly where a printed
    // copy should break.
    if (/^---+\s*$/.test(line)) {
      closeList();
      html.push('<hr>');
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }

    // Checklist item, which the Friday list is made of.
    const check = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      if (list !== 'ul') { closeList(); html.push('<ul class="checks">'); list = 'ul'; }
      html.push(`<li>${inline(check[2] ?? '')}</li>`);
      i++;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${inline(bullet[1] ?? '')}</li>`);
      i++;
      continue;
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${inline(numbered[1] ?? '')}</li>`);
      i++;
      continue;
    }

    // A continuation line inside a list item: indented, and the list is open.
    // A setup step ends with its **You should see** check, and that line is
    // what a volunteer's eye goes back to with the laptop in front of them,
    // so it starts a line of its own instead of trailing the instructions.
    if (list && /^\s{2,}\S/.test(line)) {
      const last = html.length - 1;
      const join = /^\s*\*\*You should see\*\*/.test(line) ? '<br>' : ' ';
      html[last] = (html[last] ?? '').replace(/<\/li>$/, `${join}${inline(line.trim())}</li>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        quote.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      }
      html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    // Paragraph: run to the next blank line, so wrapped source is one <p>.
    closeList();
    const para = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !/^(#{1,6}\s|```|>|---+\s*$)/.test(lines[i] ?? '')
      && !/^\s*([-*]|\d+\.)\s/.test(lines[i] ?? '')
      && !((lines[i] ?? '').includes('|') && isDivider(lines[i + 1] ?? ''))) {
      para.push(lines[i++] ?? '');
    }
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    else i++;                            // never stall
  }
  closeList();
  return html.join('\n');
}

/**
 * Print styling, and every rule here is about paper rather than screens.
 *
 * Serif body because this gets read on paper under gym lighting; a table that
 * splits across a page break is nearly useless when somebody is following it
 * step by step, so tables and headings are kept whole.
 */
const PAGE = (body, title = 'Running the CalGames Content Desk', extraCss = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: letter; margin: 18mm 16mm 20mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10.5pt/1.55 Georgia, 'Times New Roman', serif; color: #14121a; margin: 0; }

  h1 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 26pt; line-height: 1.1;
       color: #4B1D8C; margin: 0 0 4pt; letter-spacing: -.01em; }
  h2 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 16pt; color: #4B1D8C;
       margin: 20pt 0 7pt; padding-bottom: 4pt; border-bottom: 2px solid #F0AF00;
       break-after: avoid; break-inside: avoid; }
  h3 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12pt; margin: 15pt 0 5pt;
       color: #2b2440; break-after: avoid; }
  h1 + h3 { color: #6b6480; font-weight: 500; margin-top: 0; }

  p { margin: 0 0 8pt; }
  strong { color: #17122b; }
  a { color: #4B1D8C; }

  ul, ol { margin: 0 0 9pt; padding-left: 20pt; }
  li { margin-bottom: 3pt; break-inside: avoid; }
  /* The Friday list is meant to be ticked with a pen, so it gets real boxes. */
  ul.checks { list-style: none; padding-left: 2pt; }
  ul.checks li::before { content: ""; display: inline-block; width: 9pt; height: 9pt;
    border: 1.2pt solid #6b6480; margin-right: 7pt; vertical-align: -1pt; }

  code { font-family: Consolas, 'DejaVu Sans Mono', monospace; font-size: 9pt;
         background: #f2effa; padding: 1pt 3pt; border-radius: 2pt; }
  pre { background: #17122b; color: #f6f4ff; padding: 9pt 11pt; border-radius: 3pt;
        break-inside: avoid; margin: 0 0 10pt; }
  pre code { background: none; color: inherit; font-size: 9.5pt; }

  blockquote { margin: 10pt 0; padding: 8pt 12pt; background: #f7f4ff;
    border-left: 3pt solid #F0AF00; break-inside: avoid; }
  blockquote p { margin: 0; }

  /* Whole tables only. One split across a page break is nearly useless to
     somebody following it step by step with their finger on the row. */
  table { width: 100%; border-collapse: collapse; margin: 0 0 11pt;
          font-family: 'Segoe UI', system-ui, sans-serif; font-size: 9pt;
          break-inside: avoid; }
  th { text-align: left; background: #4B1D8C; color: #fff; padding: 5pt 7pt;
       font-weight: 600; font-size: 8.5pt; letter-spacing: .03em; text-transform: uppercase; }
  td { padding: 5pt 7pt; border-bottom: .6pt solid #ddd8ea; vertical-align: top; }
  tbody tr:nth-child(even) { background: #faf8ff; }

  /* A rule in this document always sits between chapters. */
  hr { border: 0; break-after: page; height: 0; margin: 0; }
  hr + h2 { margin-top: 0; }
${extraCss}
</style></head><body>
${body}
</body></html>`;

const chrome = () => CHROMES.find(existsSync);

/**
 * Pages in a PDF Chrome wrote: one `/Type /Page` object per printed page.
 * `/Type /Pages` is the tree that holds them, hence the look past the word.
 */
const pageCount = bytes => (bytes.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

async function main() {
  const built = [];
  for (const doc of DOCS) {
    const md = await readFile(join(ROOT, `${doc.name}.md`), 'utf8');
    built.push({ ...doc, md, html: PAGE(render(md), doc.title, doc.css) });
  }

  // `--html [path]` stops at the HTML. Useful for checking the layout, and it
  // is also the fallback below: a machine with no Chrome can still open that
  // file in any browser and use its own Print to PDF. A path given names the
  // handbook's file, as it always did; the quick start lands beside it.
  const flag = process.argv.indexOf('--html');
  if (flag !== -1) {
    const asked = process.argv[flag + 1];
    for (const doc of built) {
      const dest = asked
        ? (doc.name === 'RUN-THE-DESK' ? asked : join(dirname(resolve(asked)), `${doc.name}.html`))
        : join(ROOT, `${doc.name}.html`);
      await writeFile(dest, doc.html, 'utf8');
      console.log(`[handbook] ${dest}`);
    }
    return;
  }

  const bin = chrome();
  if (!bin) {
    for (const doc of built) await writeFile(join(ROOT, `${doc.name}.html`), doc.html, 'utf8');
    console.error('No Chrome or Edge found, so no PDF. Wrote '
      + built.map(d => `${d.name}.html`).join(' and ')
      + ' instead: open each in any browser and use Print to PDF.');
    return;
  }

  // One after the other through the one temp name, which .gitignore already
  // covers, so a build that dies half way leaves nothing to commit by mistake.
  for (const doc of built) {
    const out = join(ROOT, `${doc.name}.pdf`);
    await writeFile(TMP, doc.html, 'utf8');
    await new Promise((res, rej) => {
      const p = spawn(bin, [
        '--headless', '--disable-gpu', '--no-pdf-header-footer',
        `--print-to-pdf=${out}`, TMP,
      ], { stdio: 'ignore' });
      p.on('exit', code => (code === 0 ? res() : rej(new Error(`chrome exited ${code}`))));
      p.on('error', rej);
    }).finally(() => rm(TMP, { force: true }));

    const pages = pageCount(await readFile(out));
    console.log(`[handbook] ${doc.name}.pdf written from ${doc.md.split('\n').length} lines `
      + `of Markdown: ${pages} page${pages === 1 ? '' : 's'}`);
    if (doc.maxPages && pages > doc.maxPages) {
      console.error(`[handbook] ${doc.name}.pdf is ${pages} pages; it promises ${doc.maxPages}. `
        + 'Cut it back: a sheet nobody can hold in one hand is the 43-page problem again.');
      process.exitCode = 1;
    }
  }
}

await main();
