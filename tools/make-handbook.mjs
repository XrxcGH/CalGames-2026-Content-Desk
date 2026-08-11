/**
 * Turn RUN-THE-DESK.md into RUN-THE-DESK.pdf.
 *
 *   npm run handbook
 *
 * The Markdown is the source; the PDF is what gets printed and handed to
 * volunteers, because a gym has worse Wi-Fi than it has photocopiers.
 *
 * No dependencies, for the same reason nothing else here has any: this repo
 * has one runtime dependency and no build step, and adding a Markdown library
 * plus a PDF library to print one document would be the tail wagging the dog.
 * So there is a small Markdown renderer below covering exactly the constructs
 * the handbook uses, and Chrome — already required for `npm run previews` —
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
const SRC = join(ROOT, 'RUN-THE-DESK.md');
const OUT = join(ROOT, 'RUN-THE-DESK.pdf');
const TMP = join(ROOT, '.handbook.tmp.html');

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
 * never re-processed — otherwise `**` inside a code span would turn into bold
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
    if (list && /^\s{2,}\S/.test(line)) {
      const last = html.length - 1;
      html[last] = (html[last] ?? '').replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
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
const PAGE = body => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Running the CalGames Content Desk</title>
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
</style></head><body>
${body}
</body></html>`;

const chrome = () => CHROMES.find(existsSync);

async function main() {
  const md = await readFile(SRC, 'utf8');
  const html = PAGE(render(md));

  // `--html [path]` stops at the HTML. Useful for checking the layout, and it
  // is also the fallback below: a machine with no Chrome can still open that
  // file in any browser and use its own Print to PDF.
  const flag = process.argv.indexOf('--html');
  if (flag !== -1) {
    const dest = process.argv[flag + 1] ?? join(ROOT, 'RUN-THE-DESK.html');
    await writeFile(dest, html, 'utf8');
    console.log(`[handbook] ${dest}`);
    return;
  }

  const bin = chrome();
  if (!bin) {
    const fallback = join(ROOT, 'RUN-THE-DESK.html');
    await writeFile(fallback, html, 'utf8');
    console.error('No Chrome or Edge found, so no PDF. Wrote RUN-THE-DESK.html instead: '
      + 'open it in any browser and use Print to PDF.');
    return;
  }

  await writeFile(TMP, html, 'utf8');

  await new Promise((res, rej) => {
    const p = spawn(bin, [
      '--headless', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${OUT}`, TMP,
    ], { stdio: 'ignore' });
    p.on('exit', code => (code === 0 ? res() : rej(new Error(`chrome exited ${code}`))));
    p.on('error', rej);
  }).finally(() => rm(TMP, { force: true }));

  console.log(`[handbook] RUN-THE-DESK.pdf written from ${md.split('\n').length} lines of Markdown`);
}

await main();
