// Paragraph detection and re-wrapping.
//
// When an edit makes a line too long for its paragraph, the paragraph's words
// are laid out again (greedy line breaking) on the original baselines, adding
// lines below only where the page is empty. Justified paragraphs are
// re-justified. The original glyphs are removed and the new lines are drawn
// in a self-contained "q BT ... ET Q" block, reusing each word's original font,
// size, spacing, rise, colour and render mode.

import { PDFDict, PDFName, PDFString } from '../core/objects.js';
import { multiply, invert } from '../content/matrix.js';
import { PDFFont } from '../fonts/font.js';

const round = (v) => Math.round(v * 1000) / 1000;
const lineStart = (l) => l.glyphs[0].x;
const lineEnd = (l) => {
  let i = l.glyphs.length - 1;
  while (i > 0 && !l.glyphs[i].unicode.trim() && !l.glyphs[i].cluster) i--;
  return l.glyphs[i].ex;
};
const horizontal = (l) => Math.abs(l.dir[1]) < 0.01 && l.dir[0] > 0;

/** Width of the first word of a line (user space). */
function firstWordWidth(line) {
  let end = null;
  for (const c of line.chars) {
    if (/\s/.test(c.ch)) {
      if (end) break;
      continue;
    }
    if (c.glyph) end = c.glyph;
  }
  return end ? end.ex - line.glyphs[0].x : 0;
}

/**
 * Finds the paragraph (block of wrapped lines) containing `line`.
 * @returns {{ lines: any[], left: number, firstLeft: number, right: number, leading: number, justified: boolean } | null}
 */
export function detectParagraph(line, ctx) {
  if (!horizontal(line)) return null;
  const size = line.size;
  const candidates = ctx.lines.filter((l) => horizontal(l) && l.text.trim() && Math.abs(l.size - size) < 0.6);
  // Lines sharing a baseline with another segment are table/column content.
  const sharesBaseline = (l) => ctx.lines.some((o) => o !== l && o.text.trim() && Math.abs(o.y - l.y) < l.size * 0.4);
  if (sharesBaseline(line)) return null;
  const sorted = candidates.filter((l) => !sharesBaseline(l)).sort((a, b) => b.y - a.y);
  const idx = sorted.indexOf(line);
  if (idx < 0) return null;

  const block = [line];
  let leading = null;
  const colRight = ctx.textRight ?? Math.max(...candidates.map(lineEnd));
  const okLeading = (dy) => dy > size * 0.95 && dy < size * 1.8 && (leading === null || Math.abs(dy - leading) < size * 0.15);
  // Grow upwards.
  for (let i = idx - 1; i >= 0; i--) {
    const up = sorted[i];
    const below = block[0];
    const dy = up.y - below.y;
    if (!okLeading(dy)) break;
    const sameLeft = Math.abs(lineStart(up) - lineStart(below)) < 1;
    // `below` may be a continuation of `up` only if below's first word would not fit on up.
    const indentedFirst = lineStart(up) > lineStart(below) && lineStart(up) - lineStart(below) < size * 4;
    if (!sameLeft && !indentedFirst) break;
    if (!isContinuation(up, below, colRight)) break;
    leading ??= dy;
    block.unshift(up);
    if (indentedFirst) break; // an indented line starts the paragraph
  }
  // Grow downwards.
  for (let i = idx + 1; i < sorted.length; i++) {
    const down = sorted[i];
    const above = block[block.length - 1];
    const dy = above.y - down.y;
    if (!okLeading(dy)) break;
    const left = block.length > 1 ? lineStart(block[1]) : lineStart(block[0]);
    if (Math.abs(lineStart(down) - left) > 1 && !(block.length === 1 && lineStart(above) > lineStart(down))) break;
    if (!isContinuation(above, down, colRight)) break;
    leading ??= dy;
    block.push(down);
  }

  // All glyphs must come from one content source with one CTM.
  const shows = new Set(block.flatMap((l) => l.glyphs.map((g) => g.show)));
  const first = [...shows][0];
  for (const s of shows) {
    if (s.source !== first.source || s.ctm.some((v, k) => Math.abs(v - first.ctm[k]) > 1e-6)) return null;
  }

  const left = block.length > 1 ? lineStart(block[1]) : lineStart(block[0]);
  const ends = block.slice(0, -1).map(lineEnd);
  const right = ends.length ? Math.max(...ends) : colRight;
  const justified = block.length > 2 && ends.every((e) => Math.abs(e - right) < 1.5);
  return {
    lines: block,
    left,
    firstLeft: lineStart(block[0]),
    right,
    leading: leading ?? size * 1.2,
    justified,
    source: first.source,
    ctm: first.ctm,
  };
}

/**
 * `next` continues `prev` when next's first word could not have fitted at
 * the end of prev (i.e. the line was broken by wrapping, not by the author).
 */
function isContinuation(prev, next, colRight) {
  const space = prev.size * 0.28;
  return lineEnd(prev) + space + firstWordWidth(next) > colRight - 1;
}

/**
 * Re-wraps a paragraph with replacements applied.
 *
 * @param {object} para          result of detectParagraph
 * @param {Array<{job:any, plan:any}>} edits  replacements inside the paragraph
 * @param {object} ctx           editor page context (lines, interpreter, page)
 * @returns {{ removed: Set<any>, opIndex: number, ops: any[], lines: number } | null}
 */
const minParagraphScale = 0.85;

export function rewrapParagraph(para, edits, ctx) {
  // 1. Turn the paragraph into words made of items.
  const replaced = new Map(); // first glyph of a match -> edit
  const inMatch = new Set();
  for (const e of edits) {
    e.job.glyphs.forEach((g) => inMatch.add(g));
    replaced.set(e.job.glyphs[0], e);
  }
  const words = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.items.length) words.push(cur);
    cur = null;
  };
  const push = (item) => {
    cur ??= { items: [] };
    cur.items.push(item);
  };

  para.lines.forEach((line, li) => {
    const seen = new Set();
    for (let ci = 0; ci < line.chars.length; ci++) {
      const c = line.chars[ci];
      const g = c.glyph;
      if (g && replaced.has(g) && !seen.has(g)) {
        // Insert the new text, split into words at spaces.
        seen.add(g);
        const e = replaced.get(g);
        const parts = e.job.newText.split(/(\s+)/);
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { flush(); continue; }
          const enc = e.plan.font.encode(part);
          push({ kind: 'new', enc, plan: e.plan, show: e.job.glyphs[0].show, text: part });
        }
        continue;
      }
      if (g && inMatch.has(g)) continue;
      if (/\s/.test(c.ch)) { flush(); continue; }
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (g.cluster) g.cluster.glyphs.forEach((x) => seen.add(x));
      push({ kind: 'glyph', g, cluster: g.cluster ? g.cluster.glyphs.filter((x) => line.glyphs.includes(x)) : null });
    }
    // Line end: a hyphen joining a word broken across lines is dropped.
    const next = para.lines[li + 1];
    const last = cur?.items[cur.items.length - 1];
    if (next && last?.kind === 'glyph' && /^[-­]$/.test(last.g.unicode) && /^\p{Ll}/u.test(next.text.trimStart())) {
      cur.items.pop();
      return; // continue the same word on the next line
    }
    flush();
  });
  flush();

  // 2. Measure (user space).
  const hsOf = (show) => show.hscale;
  for (const w of words) {
    w.width = 0;
    for (const it of w.items) {
      if (it.kind === 'glyph') {
        const gl = it.cluster && it.cluster.length ? it.cluster : [it.g];
        const xs = gl.flatMap((x) => [x.x, x.ex]);
        it.width = gl.length > 1 ? Math.max(...xs) - Math.min(it.g.x, ...xs) : Math.abs(it.g.ex - it.g.x);
        // Spacing that belongs to a word-space glyph (Tw) is dropped with the space.
      } else {
        const s = it.show, fs = s.fontSize, Th = s.Th;
        let d = 0;
        for (const g of it.enc.glyphs) d += g.code < 0 ? 0 : ((g.width + (g.dx || 0)) * fs + s.Tc) * Th;
        it.width = d * hsOf(s);
      }
      w.width += it.width;
    }
    const firstShow = w.items[0].kind === 'glyph' ? w.items[0].g.show : w.items[0].show;
    const font = w.items[0].kind === 'glyph' ? firstShow.font : w.items[0].plan.font;
    w.space = (font?.spaceWidth ?? 0.25) * firstShow.fontSize * firstShow.Th * hsOf(firstShow);
  }

  // 3. Greedy line breaking. `scale` < 1 condenses the whole paragraph
  // horizontally when there is no room for extra lines.
  const avail = (k) => para.right - (k === 0 ? para.firstLeft : para.left);
  const breakLines = (scale) => {
    const out = [];
    let line = [];
    let width = 0;
    for (const w of words) {
      const add = ((line.length ? line[line.length - 1].space : 0) + w.width) * scale;
      if (line.length && width + add > avail(out.length) + 0.01) {
        out.push({ words: line, width });
        line = [w];
        width = w.width * scale;
      } else {
        line.push(w);
        width += add;
      }
    }
    if (line.length) out.push({ words: line, width });
    return out;
  };

  // 4. How many lines may we use? Extra lines need a free line slot below.
  const lastY = para.lines[para.lines.length - 1].y;
  const ys = para.lines.map((l) => l.y);
  for (let k = 1; k <= 20; k++) {
    const y = lastY - para.leading * k;
    if (!regionFree(y, para, ctx)) break;
    ys.push(y);
  }
  // Prefer a barely visible condensing over eating into the space below the
  // paragraph; add lines only when that is not enough.
  const fit = (maxLines, minScale) => {
    for (let sc = 1; sc >= minScale - 1e-9; sc -= 0.01) {
      const ls = breakLines(sc);
      if (ls.length <= maxLines) return { scale: sc, lines: ls };
    }
    return null;
  };
  const best = fit(para.lines.length, 0.93) || fit(ys.length, minParagraphScale);
  let scale = best ? best.scale : 1;
  let lines = best ? best.lines : breakLines(1);
  if (lines.length > ys.length) return null;
  if (lines.some((l) => l.width > avail(1) + 0.5 && l.words.length > 1)) return null;

  // 5. Emit the new text block.
  const removed = new Set(para.lines.flatMap((l) => l.glyphs));
  const blockCtm = para.ctm;
  const inv = invert(blockCtm);
  const ops = [{ op: 'q', operands: [] }, { op: 'BT', operands: [] }];
  const state = { font: null, size: null, Tc: null, Th: null, rise: null, fill: null, stroke: null, Tr: null, Tw: null };
  const setState = (show, fontKey) => {
    if (state.font !== fontKey || state.size !== show.fontSize) {
      ops.push({ op: 'Tf', operands: [PDFName.of(fontKey), show.fontSize] });
      state.font = fontKey;
      state.size = show.fontSize;
    }
    if (state.Tc !== show.Tc) { ops.push({ op: 'Tc', operands: [round(show.Tc)] }); state.Tc = show.Tc; }
    if (state.Tw !== 0) { ops.push({ op: 'Tw', operands: [0] }); state.Tw = 0; }
    const Th = show.Th * (state.scale ?? 1);
    if (state.Th !== Th) { ops.push({ op: 'Tz', operands: [round(Th * 100)] }); state.Th = Th; }
    if (state.rise !== show.rise) { ops.push({ op: 'Ts', operands: [round(show.rise)] }); state.rise = show.rise; }
    if (state.Tr !== show.renderMode) { ops.push({ op: 'Tr', operands: [show.renderMode] }); state.Tr = show.renderMode; }
    if (state.fill !== show.fill) { for (const f of show.fill) ops.push({ op: f.op, operands: f.operands }); state.fill = show.fill; }
    if (state.stroke !== show.stroke && [1, 2, 5, 6].includes(show.renderMode)) {
      for (const f of show.stroke) ops.push({ op: f.op, operands: f.operands });
      state.stroke = show.stroke;
    }
  };

  lines.forEach((ln, k) => {
    const y = ys[k];
    let x = k === 0 ? para.firstLeft : para.left;
    const isLast = k === lines.length - 1;
    const gaps = ln.words.length - 1;
    const extra = para.justified && !isLast && gaps > 0 ? (avail(k) - ln.width) / gaps : 0;
    state.scale = scale;
    let pen = null; // current user-space pen x on this line, null = needs Tm
    state.linKey = null;
    ln.words.forEach((w, wi) => {
      if (wi > 0) x += ln.words[wi - 1].space * scale + extra;
      for (const it of w.items) {
        const show = it.kind === 'glyph' ? it.g.show : it.show;
        if (pen !== null && state.linKey !== multiply(show.tm, show.ctm).slice(0, 4).join()) pen = null;
        const fontKey = it.kind === 'glyph' ? show.fontKey : it.plan.fontKey || show.fontKey;
        setState(show, fontKey);
        // Position with a text matrix whenever the pen is not where we want it.
        const lin = multiply(show.tm, show.ctm);
        const needTm = pen === null || Math.abs(pen - x) > 0.01 || state.linKey !== lin.slice(0, 4).join();
        if (needTm) {
          const sameLin = pen !== null && state.linKey === lin.slice(0, 4).join();
          if (sameLin) {
            // Same line and orientation: just move the pen with a displacement.
            ops.push({ op: 'TJ', operands: [[round((-(x - pen) / show.hscale) * 1000 / (show.fontSize * state.Th))]] });
          } else {
            const M = [lin[0], lin[1], lin[2], lin[3], x - lin[2] * show.rise, y - lin[3] * show.rise];
            ops.push({ op: 'Tm', operands: multiply(M, inv).map(round) });
            state.linKey = lin.slice(0, 4).join();
          }
        }
        if (it.kind === 'glyph') {
          const gl = it.cluster && it.cluster.length ? it.cluster : [it.g];
          if (it.g.cluster) {
            ops.push({ op: 'BDC', operands: [PDFName.of('Span'), new PDFDict().set('ActualText', PDFString.fromText(it.g.cluster.text))] });
          }
          // Keep the cluster's internal geometry exactly. Glyphs of one cluster
          // may come from different fonts (e.g. Chrome's Type3 split fonts).
          // Displacements use the unscaled Th so they shrink with Tz like the glyphs.
          const disp = (d, s) => round((-d / s.hscale) * 1000 / (s.fontSize * s.Th));
          let arr = [];
          let p = it.g.x;
          let cur = show;
          for (const g of gl) {
            if (g.show.fontKey !== cur.fontKey || g.show.fontSize !== cur.fontSize) {
              if (arr.length) ops.push({ op: 'TJ', operands: [arr] });
              arr = [];
              setState(g.show, g.show.fontKey);
              cur = g.show;
            }
            const shift = g.x - p;
            if (Math.abs(shift) > 1e-6) arr.push(disp(shift, cur));
            arr.push(new PDFString(PDFFont.codesToBytes([g]), !!cur.font?.isType0));
            p = g.ex;
          }
          const end = Math.max(...gl.map((g) => g.ex));
          if (Math.abs(end - p) > 1e-6) arr.push(disp(end - p, cur));
          if (arr.length) ops.push({ op: 'TJ', operands: [arr] });
          if (it.g.cluster) ops.push({ op: 'EMC', operands: [] });
        } else {
          emitNew(ops, it, show, state);
        }
        x += it.width * scale;
        pen = x;
      }
    });
  });
  ops.push({ op: 'ET', operands: [] }, { op: 'Q', operands: [] });

  // Insert before the first text object (in content order) of the paragraph.
  const firstShow = [...new Set(para.lines.flatMap((l) => l.glyphs.map((g) => g.show)))]
    .sort((a, b) => a.opIndex - b.opIndex)[0];
  return { removed, opIndex: firstShow.btIndex, ops, lineCount: lines.length, scale };
}

function emitNew(ops, it, show, state) {
  const fs = show.fontSize;
  const arr = [];
  const flushTJ = () => {
    if (arr.length) ops.push({ op: 'TJ', operands: [arr.splice(0)] });
  };
  if (it.enc.actualText) ops.push({ op: 'BDC', operands: [PDFName.of('Span'), new PDFDict().set('ActualText', PDFString.fromText(it.text))] });
  for (const g of it.enc.glyphs) {
    if (g.code < 0) continue;
    if (g.xOff) arr.push(round(-g.xOff * 1000));
    if (g.yOff) {
      flushTJ();
      ops.push({ op: 'Ts', operands: [round(show.rise + g.yOff * fs)] });
    }
    arr.push(new PDFString(PDFFont.codesToBytes([g]), true));
    if (g.yOff) {
      flushTJ();
      ops.push({ op: 'Ts', operands: [round(show.rise)] });
    }
    if (g.xOff) arr.push(round(g.xOff * 1000));
    if (g.dx) arr.push(round(-g.dx * 1000));
  }
  flushTJ();
  if (it.enc.actualText) ops.push({ op: 'EMC', operands: [] });
  state.rise = show.rise;
}

/** True when a new line at baseline y would not collide with anything. */
function regionFree(y, para, ctx) {
  const size = para.lines[0].size;
  const top = y + size * 0.9;
  // Keep a whole line slot free so paragraph spacing to what follows survives.
  const bottom = y - Math.max(size * 0.3, para.leading * 0.8);
  const [, py0] = ctx.page.cropBox;
  if (bottom < py0 + size) return false;
  for (const l of ctx.lines) {
    if (para.lines.includes(l) || !l.text.trim()) continue;
    const [x0, y0, x1, y1] = l.bbox;
    if (x1 < para.left || x0 > para.right) continue;
    if (y1 > bottom && y0 < top) return false;
  }
  for (const r of ctx.interpreter.hrules) {
    if (r.x1 < para.left || r.x0 > para.right) continue;
    if (r.y0 > bottom && r.y0 < top) return false;
  }
  return true;
}
