/**
 * The Lucide icon set (lucide.dev, ISC license), inlined.
 *
 * The desk has no build step, no icon font, and no other icon source: any
 * icon on any surface comes from this file, as Lucide path data wrapped in
 * the standard Lucide SVG shell, drawn in currentColor at 1em so it inherits
 * the text's size and color wherever it lands.
 *
 * Icons are decoration NEXT TO words, never the words themselves: every
 * control keeps its visible text or aria-label, because a first-time
 * volunteer under gym lights should never have to guess what a pictogram
 * means.
 */

const BODIES = {
  'chevron-left': "<path d='m15 18-6-6 6-6'/>",
  'chevron-right': "<path d='m9 18 6-6-6-6'/>",
  'chevron-up': "<path d='m18 15-6-6-6 6'/>",
  'chevron-down': "<path d='m6 9 6 6 6-6'/>",
  x: "<path d='M18 6 6 18'/><path d='m6 6 12 12'/>",
  check: "<path d='M20 6 9 17l-5-5'/>",
  flag: "<path d='M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'/><line x1='4' x2='4' y1='22' y2='15'/>",
};

/** One Lucide icon as an SVG element. Unknown names render as an empty box. */
export function iconEl(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = BODIES[name] ?? '';
  return svg;
}
