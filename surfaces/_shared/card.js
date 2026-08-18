/**
 * Post-match social card renderer.
 *
 * Drawn on a canvas rather than laid out in HTML, for one reason: the output
 * has to be a real PNG somebody can post. `canvas.toBlob()` gives that with no
 * dependency, whereas rasterizing a DOM node needs a library or a headless
 * browser. The trade is doing layout by hand, which for a fixed 1080x1080
 * composition is a fair price.
 *
 * Colors come from the same CSS custom properties every other surface uses,
 * so the card can never drift from the broadcast look.
 */

import { allianceRoster } from './alliance.js';
import { rpBadges } from './rp.js';

export const CARD_SIZE = 1080;

const css = name => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

function palette() {
  return {
    purple: css('--cg-purple') || '#560F6B',
    purpleHi: css('--cg-purple-hi') || '#7B2394',
    purpleLo: css('--cg-purple-lo') || '#33073F',
    void: css('--cg-purple-void') || '#0E0113',
    gold: css('--cg-gold') || '#F0AF00',
    green: css('--cg-green-hi') || '#0D9B74',
    white: css('--cg-white') || '#FFFFFF',
    dim: css('--cg-white-dim') || '#C9BCD0',
    red: css('--alliance-red') || '#ED1C24',
    blue: css('--alliance-blue') || '#0066B3',
  };
}

/** Chamfered rect: the shape language from docs/03, in canvas form. */
function chamfer(ctx, x, y, w, h, ch) {
  ctx.beginPath();
  ctx.moveTo(x + ch, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - ch);
  ctx.lineTo(x + w - ch, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + ch);
  ctx.closePath();
}

/** Perforated-aluminum dots, same motif as the overlays. */
function perf(ctx, x, y, w, h, step = 18) {
  ctx.save();
  chamfer(ctx, x, y, w, h, 0);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let py = y; py < y + h; py += step) {
    for (let px = x; px < x + w; px += step) {
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function fitText(ctx, text, maxWidth, startPx, font, minPx = 12) {
  let size = startPx;
  do {
    ctx.font = font(size);
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  } while (size > minPx);
  return size;
}

/**
 * Centered tracked text: canvas letterSpacing, like CSS, adds a trailing
 * advance after the last glyph, so centered ink sits half a track left. The
 * CSS side corrects with text-indent; here the same correction is half the
 * track added to x. Sets the tracking, draws, resets to 0.
 */
function trackedCenter(ctx, text, x, y, trackPx) {
  ctx.letterSpacing = `${trackPx}px`;
  ctx.fillText(text, x + trackPx / 2, y);
  ctx.letterSpacing = '0px';
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} card
 *   { eventName, matchName, red:{teams:[{number,name}], score, rp}, blue:{...},
 *     footer }
 */
export function drawCard(ctx, card) {
  const S = CARD_SIZE;
  const p = palette();
  const num = w => size => `${w} ${size}px Chivo, Archivo, system-ui, sans-serif`;
  const cond = w => size => `${w} ${size}px "Saira Condensed", Archivo, system-ui, sans-serif`;

  // ---- background -------------------------------------------------------
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, p.purple);
  bg.addColorStop(1, p.void);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);
  perf(ctx, 0, 0, S, S, 22);

  // ---- header -----------------------------------------------------------
  ctx.fillStyle = p.gold;
  ctx.font = cond(700)(34);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  trackedCenter(ctx, (card.eventName ?? '').toUpperCase(), S / 2, 92, 6);

  ctx.fillStyle = p.white;
  const mSize = fitText(ctx, card.matchName ?? '', S - 160, 66, num(900));
  ctx.font = num(900)(mSize);
  ctx.fillText(card.matchName ?? '', S / 2, 168);

  // measurement ticks, the blueprint motif
  ctx.fillStyle = p.gold;
  for (let x = S / 2 - 210; x < S / 2 + 210; x += 14) ctx.fillRect(x, 196, 2, 5);

  // ---- score blocks -----------------------------------------------------
  const won = (card.red?.score ?? 0) > (card.blue?.score ?? 0) ? 'red'
    : (card.blue?.score ?? 0) > (card.red?.score ?? 0) ? 'blue' : 'tie';

  const blockY = 240, blockH = 300, gap = 24;
  const blockW = (S - 120 - gap) / 2;

  const side = (x, data, color, label, isWinner) => {
    ctx.save();
    chamfer(ctx, x, blockY, blockW, blockH, 26);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    perf(ctx, x, blockY, blockW, blockH, 20);

    // Winner gets a gold cap. Position and a label carry it too, never color
    // alone, because red/blue is ~8% of male viewers' worst case. Clipped to
    // the plate's chamfer so the band ends where the corner cut begins.
    if (isWinner) {
      ctx.save();
      chamfer(ctx, x, blockY, blockW, blockH, 26);
      ctx.clip();
      ctx.fillStyle = p.gold;
      ctx.fillRect(x, blockY, blockW, 10);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = p.white;
    ctx.font = cond(700)(30);
    trackedCenter(ctx, label.toUpperCase(), x + blockW / 2, blockY + 74, 5);

    ctx.font = num(900)(150);
    if (card.estimated) {
      // Shadow-scored totals are OUTLINED here for the same reason the score
      // bar outlines them: a guess must never leave the desk looking
      // official, least of all on a card someone is about to post.
      ctx.lineWidth = 5;
      ctx.strokeStyle = p.white;
      ctx.strokeText(String(data?.score ?? 0), x + blockW / 2, blockY + 218);
    } else {
      ctx.fillText(String(data?.score ?? 0), x + blockW / 2, blockY + 218);
    }

    if (isWinner) {
      ctx.fillStyle = p.gold;
      ctx.font = cond(700)(28);
      trackedCenter(ctx, 'WINNER', x + blockW / 2, blockY + 264, 4);
    } else if (won === 'tie') {
      ctx.fillStyle = p.dim;
      ctx.font = cond(600)(26);
      ctx.fillText('TIE', x + blockW / 2, blockY + 264);
    }
  };

  side(60, card.red, p.red, 'Red', won === 'red');
  side(60 + blockW + gap, card.blue, p.blue, 'Blue', won === 'blue');

  // ---- vertical rhythm below the score blocks ---------------------------
  // Three equal optical gaps: blocks to team list, team list to RP badges,
  // badges to the footer rule. Measured off cap height and descender rather
  // than baselines, because a baseline sits well inside the ink and matching
  // baseline gaps leaves the block looking bottom-heavy.
  //
  // The old layout placed the badges a full row pitch below the last name, as
  // though a fourth team were coming, which opened a gap three times the one
  // above the list.
  // Alliance size is whatever the match actually fielded. Qualification
  // alliances are three; a playoff alliance can carry a fourth, and the card
  // has to make room for it rather than quietly dropping a team off the
  // bottom. The pitch tightens so the block still lands on the same rhythm.
  const rows = Math.max(1,
    (card.red?.teams ?? []).length, (card.blue?.teams ?? []).length);
  const ROW_PITCH = rows > 3 ? 64 : 78;
  const NUM_CAP = 33;        // cap height of the 46px team number
  const NAME_DROP = 34;      // name baseline offset below the number, plus descender
  const RP_H = 78;           // badge plate plus its label
  const teamsH = NUM_CAP + (rows - 1) * ROW_PITCH + NAME_DROP;
  const footerRule = S - 96;
  const vGap = (footerRule - (blockY + blockH) - teamsH - RP_H) / 3;

  // ---- team lists -------------------------------------------------------
  const teamsY = blockY + blockH + vGap + NUM_CAP;
  const drawTeams = (x, teams) => {
    ctx.textAlign = 'center';
    (teams ?? []).forEach((t, i) => {
      const y = teamsY + i * ROW_PITCH;
      ctx.fillStyle = p.gold;
      ctx.font = num(900)(46);
      ctx.fillText(String(t.number ?? ''), x + blockW / 2, y);

      ctx.fillStyle = p.dim;
      // Fit the exact string that gets drawn. Measuring the raw name at zero
      // tracking undersold the width, and a long name drawn uppercase with
      // 2px tracking ran into the other alliance's column.
      const name = (t.name ?? '').toUpperCase();
      ctx.letterSpacing = '2px';
      const nameSize = fitText(ctx, name, blockW - 40, 26, cond(600));
      ctx.font = cond(600)(nameSize);
      trackedCenter(ctx, name, x + blockW / 2, y + 28, 2);
    });
  };
  drawTeams(60, card.red?.teams);
  drawTeams(60 + blockW + gap, card.blue?.teams);

  // ---- ranking point badges --------------------------------------------
  // Icon says which bonus, numeral says the threshold: same vocabulary as
  // the broadcast score bar, so the card teaches nothing new.
  const rpY = teamsY - NUM_CAP + teamsH + vGap;
  const drawRp = (x, rp) => {
    const bw = 128, bh = 46, sp = 16;
    const badges = rpBadges(card.thresholds);
    const total = badges.length * bw + (badges.length - 1) * sp;
    let px = x + blockW / 2 - total / 2;
    for (const b of badges) {
      const earned = !!rp?.[b.key];
      const ink = earned ? p.white : 'rgba(255,255,255,.66)';
      ctx.save();
      chamfer(ctx, px, rpY, bw, bh, 12);
      ctx.fillStyle = earned ? p.green : 'rgba(0,0,0,.30)';
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(px + 16, rpY + (bh - 26) / 2);
      ctx.scale(26 / 24, 26 / 24);
      ctx.fillStyle = ink;
      ctx.fill(new Path2D(b.path));
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.fillStyle = ink;
      ctx.font = num(700)(30);
      ctx.fillText(String(b.need), px + 54, rpY + bh / 2 + 11);

      ctx.textAlign = 'center';
      ctx.fillStyle = p.dim;
      ctx.font = cond(600)(16);
      trackedCenter(ctx, b.label.toUpperCase(), px + bw / 2, rpY + bh + 26, 2);

      px += bw + sp;
    }
  };
  drawRp(60, card.red?.rp);
  drawRp(60 + blockW + gap, card.blue?.rp);

  // ---- footer -----------------------------------------------------------
  ctx.fillStyle = p.gold;
  ctx.fillRect(60, S - 96, S - 120, 4);
  ctx.textAlign = 'center';
  ctx.fillStyle = p.dim;
  ctx.font = cond(600)(26);
  trackedCenter(ctx, (card.footer ?? '').toUpperCase(), S / 2, S - 52, 4);
}

/** Build the card model from a DeskState snapshot. */
export function cardFromState(state, opts = {}) {
  // The card is about the alliance, so it names the whole alliance. In a
  // playoff that is four teams even though three played, because CalGames
  // picks four and never calls a backup: leaving the fourth off the result
  // graphic tells a team that won a match they were not part of it. In
  // qualification this is just the three on the field.
  const side = which => ({
    teams: allianceRoster(state, which).map(t => ({ number: t.number, name: t.name })),
    score: state.score?.[which]?.total ?? 0,
    rp: state.score?.[which]?.rp ?? {},
  });
  return {
    eventName: opts.eventName ?? 'CalGames 2026',
    matchName: state.match?.displayName ?? 'Match',
    // Carried onto the card so the printed numeral matches what the match
    // was actually scored against.
    thresholds: state.thresholds,
    // Shadow-scored (desk-typed) totals render outlined, same contract as the
    // score bar. A card built from estimated numbers must say so visibly.
    // totalConfidence, not confidence: this card shows the FINAL SCORE, and
    // an official total posted over a typed-in breakdown is not a guess.
    estimated: state.totalConfidence === 'estimated',
    red: side('red'),
    blue: side('blue'),
    footer: opts.footer ?? 'calgames.org',
  };
}
