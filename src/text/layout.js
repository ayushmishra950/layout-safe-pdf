import { krutiToUnicode } from '../fonts/legacy.js';
import { needsRepair, repairDevanagari } from './devanagari.js';
// Groups positioned glyphs into text lines with virtual spaces, keeping a
// char -> glyph mapping so matches can be traced back to content operations.

/**
 * @typedef {import('../content/interpreter.js').PositionedGlyph} PositionedGlyph
 * @typedef {{ ch: string, glyph: PositionedGlyph|null, part: number }} LineChar
 *   `part` is the index of `ch` inside the glyph's unicode (ligatures map to >1 char).
 * @typedef {{ text: string, chars: LineChar[], glyphs: PositionedGlyph[], x: number, y: number,
 *             size: number, dir: [number, number], bbox: [number, number, number, number] }} TextLine
 */

/**
 * @param {import('../content/interpreter.js').TextShow[]} shows
 * @param {{ gapFactor?: number, splitFactor?: number }} [options]
 * @returns {TextLine[]} lines in drawing order
 */
export function buildLines(shows, options = {}) {
  const gapFactor = options.gapFactor ?? 0.18; // fraction of font size that counts as a space
  const splitFactor = options.splitFactor ?? 1.6; // gap (in em) that starts a new segment
  const lines = [];
  let cur = null;

  const startLine = (g, dir) => {
    cur = { glyphs: [g], dir, last: g };
    lines.push(cur);
  };

  for (const show of shows) {
    if (show.renderMode === 3 && options.skipInvisible) continue;
    for (const g of show.glyphs) {
      const dx = g.ex - g.x;
      const dy = g.ey - g.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const hasDir = len > 1e-6;
      const ux = hasDir ? dx / len : cur ? cur.dir[0] : 1;
      const uy = hasDir ? dy / len : cur ? cur.dir[1] : 0;
      if (!cur) {
        startLine(g, [ux, uy]);
        continue;
      }
      const last = cur.last;
      const size = Math.max(g.size, last.size, 1e-3);
      // Position of g relative to the end of the previous glyph, in the line's frame.
      const rx = g.x - last.ex;
      const ry = g.y - last.ey;
      const along = rx * cur.dir[0] + ry * cur.dir[1];
      const perp = -rx * cur.dir[1] + ry * cur.dir[0];
      const sameDir = Math.abs(ux * cur.dir[0] + uy * cur.dir[1]) > 0.99;
      if (sameDir && Math.abs(perp) < size * 0.5 && along > -size * 0.6 && along < size * splitFactor) {
        cur.glyphs.push(g);
        cur.last = g;
      } else {
        startLine(g, [ux, uy]);
      }
    }
  }

  return lines.map((l) => finishLine(l, gapFactor));
}

/**
 * Words drawn with a legacy Hindi font (Kruti Dev) hold Latin codes. Group
 * each word's glyphs into a cluster carrying the converted Unicode text, the
 * same way ActualText clusters work.
 */
function convertLegacyWords(glyphs) {
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const raw = run.map((g) => g.unicode).join('');
    const cluster = { text: krutiToUnicode(raw), glyphs: run, legacy: 'kruti' };
    run.forEach((g, i) => {
      g.ownUnicode = g.unicode;
      g.cluster = cluster;
      g.unicode = i === 0 ? cluster.text : '';
    });
    run = [];
  };
  for (const g of glyphs) {
    const legacy = g.show.font?.legacy === 'kruti' && !g.cluster;
    const prev = run[run.length - 1];
    const gap = prev ? Math.hypot(g.x - prev.ex, g.y - prev.ey) : 0;
    if (!legacy || /^\s*$/.test(g.unicode) || (prev && gap > g.size * 0.25)) {
      flush();
      if (legacy && !/^\s*$/.test(g.unicode)) run.push(g);
      continue;
    }
    run.push(g);
  }
  flush();
}

function finishLine(l, gapFactor) {
  if (l.glyphs.some((g) => g.show.font?.legacy)) convertLegacyWords(l.glyphs);
  const chars = [];
  let prev = null;
  // Furthest point reached along the line so far. Zero-width marks (Devanagari
  // matras, accents) can end before the base glyph does, so gaps are measured
  // from here rather than from the previous glyph.
  let reach = -Infinity;
  const d0 = l.dir[0], d1 = l.dir[1];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of l.glyphs) {
    const top = g.y + g.size * 0.8;
    if (g.x < minX) minX = g.x; if (g.ex < minX) minX = g.ex;
    if (g.x > maxX) maxX = g.x; if (g.ex > maxX) maxX = g.ex;
    if (g.y < minY) minY = g.y; if (g.ey < minY) minY = g.ey;
    if (top > maxY) maxY = top; if (g.ey > maxY) maxY = g.ey; if (g.y > maxY) maxY = g.y;
    const a0 = g.x * d0 + g.y * d1;
    const a1 = g.ex * d0 + g.ey * d1;
    const reached = a0 > a1 ? a0 : a1;
    if (g.cluster && g.unicode === '') {
      // Non-first glyph of an ActualText cluster: contributes no text of its own.
      prev = g;
      reach = Math.max(reach, reached);
      continue;
    }
    if (prev) {
      const gap = a0 - reach;
      if (gap > Math.max(g.size, prev.size) * gapFactor) {
        const lastCh = chars.length ? chars[chars.length - 1].ch : ' ';
        if (!isSpace(lastCh) && !isSpace(g.unicode[0] || '')) chars.push({ ch: ' ', glyph: null, part: 0 });
      }
    }
    const u = g.unicode || '�';
    if (u.length === 1) chars.push({ ch: u, glyph: g, part: 0 });
    else {
      let part = 0;
      for (const ch of u) chars.push({ ch, glyph: g, part: part++ });
    }
    prev = g;
    reach = Math.max(reach, reached);
  }
  if (needsRepair(chars)) repairDevanagari(chars);
  const first = l.glyphs[0];
  return {
    text: chars.reduce((s, c) => s + c.ch, ''),
    chars,
    glyphs: l.glyphs,
    x: first.x,
    y: first.y,
    size: first.size,
    dir: l.dir,
    bbox: [minX, minY, maxX, maxY],
  };
}

const isSpace = (c) => c === ' ' || (c !== '' && /\s/.test(c));

/** Sorts lines into a top-to-bottom, left-to-right reading order. */
export function readingOrder(lines) {
  return [...lines].sort((a, b) => {
    const tol = Math.min(a.size, b.size) * 0.4;
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    return a.x - b.x;
  });
}
