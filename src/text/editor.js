// Layout-aware text replacement.
//
// How it works
// 1. The page is interpreted; every glyph knows its operation, position and font.
// 2. Matches are found on reconstructed lines (layout.js).
// 3. For each match we decide geometry in user space:
//      - alignment (left / right / center; "auto" detects table cells & columns)
//      - how much room there is (table borders, neighbouring text, page margins)
//      - what happens to the rest of the line (reflow, keep, or justify)
//    The result is a desired horizontal offset for every affected glyph.
// 4. Only the text-showing operations that contain affected glyphs are
//    rewritten. Untouched bytes of the content stream are copied verbatim, and
//    TJ displacements put every glyph exactly at its desired position.

import { PDFDict, PDFName, PDFRef, PDFString, num } from '../core/objects.js';
import { ContentInterpreter } from '../content/interpreter.js';
import { rebuildContent } from '../content/operations.js';
import { buildLines } from './layout.js';
import { PDFFont } from '../fonts/font.js';
import { FontResolver, defaultResolver, normalizeFontName } from '../fonts/resolver.js';
import { EmbeddedFont } from '../fonts/embedder.js';
import { isDevanagari } from '../fonts/shaper.js';
import { detectParagraph, rewrapParagraph } from './paragraph.js';

/**
 * @typedef {object} ReplaceOptions
 * @property {string|RegExp} search
 * @property {string|((match:string)=>string)} replace   "$&" inserts the matched text
 * @property {number[]} [pages]        page indexes, 0-based (default: all)
 * @property {'reflow'|'preserve'|'fit'} [mode]
 *   reflow   – (default) the rest of the line moves with the new width; if there is
 *              not enough room (cell border, next column, margin) the new text is
 *              condensed; justified lines absorb the change in their word gaps
 *   preserve – every other glyph keeps its exact position (may overlap if longer)
 *   fit      – new text is condensed into the old width if it is longer
 * @property {'auto'|'left'|'right'|'center'} [align]  (default auto)
 * @property {boolean} [caseSensitive]  default true
 * @property {number} [maxCount]        max replacements (default: all)
 * @property {number} [minScale]        smallest horizontal condensing allowed (default 0.5)
 */

const round = (v) => Math.round(v * 1000) / 1000;

export class TextEditor {
  /**
   * @param {import('../core/document.js').PDFDocument} doc
   * @param {{ fonts?: Record<string,string>, fontDirs?: string[], useSystemFonts?: boolean,
   *           fallbackFont?: string, embedMissingGlyphs?: boolean }} [options]
   *   fonts: map PDF font names to font files, e.g. { ArialMT: './arial.ttf' }
   *   fallbackFont: font file used when no matching font is found
   *   embedMissingGlyphs (default true): when the PDF's subset font lacks a
   *   character, embed a matching font that has it.
   */
  constructor(doc, options = {}) {
    this.doc = doc;
    this.options = options;
    this.resolver = options.fonts || options.fontDirs || options.useSystemFonts === false
      ? new FontResolver(options)
      : defaultResolver();
    /** normalized PDF font name -> EmbeddedFont | null */
    this.substitutes = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Finds text occurrences with their positions.
   * @returns {Array<{page:number, text:string, bbox:number[], fontName:string, fontSize:number}>}
   */
  find(search, { pages, caseSensitive = true } = {}) {
    const out = [];
    for (const pageIndex of this.#pageList(pages)) {
      const { lines } = this.#analyze(pageIndex);
      for (const line of lines) {
        for (const m of findInLine(line.text, search, caseSensitive)) {
          const glyphs = glyphsOf(line, m.start, m.end);
          if (!glyphs.length) continue;
          out.push({
            page: pageIndex,
            text: m.text,
            bbox: bboxOf(glyphs),
            fontName: glyphs[0].show.font?.baseFont || '',
            fontSize: round(glyphs[0].size),
          });
        }
      }
    }
    return out;
  }

  /**
   * Replaces text. Returns a report of what changed and what was skipped.
   * @param {ReplaceOptions} options
   */
  replace(options) {
    const { search, replace, pages, caseSensitive = true } = options;
    const mode = options.mode === 'flow' ? 'reflow' : options.mode || 'reflow';
    const align = options.align || 'auto';
    const minScale = options.minScale ?? 0.5;
    let remaining = options.maxCount ?? Infinity;
    const report = { replaced: 0, skipped: [], warnings: [], details: [] };
    if (this.signedWarning === undefined) {
      this.signedWarning = this.doc.isSigned
        ? 'The document is digitally signed: editing it invalidates the signature(s). An incremental save keeps the signed revision intact inside the file, but viewers will report that the document was changed after signing.'
        : null;
    }
    /** Form XObjects already rewritten in this call (shared between pages). */
    const doneForms = new Set();

    for (const pageIndex of this.#pageList(pages)) {
      if (remaining <= 0) break;
      const ctx = this.#analyze(pageIndex);
      const { lines, interpreter } = ctx;

      // A form drawn several times is interpreted once per drawing, but only its
      // first drawing (in content order) is rewritten.
      const firstDraw = new Map();
      for (const s of interpreter.shows) {
        const k = `${s.source.id}#${s.opIndex}`;
        if (!firstDraw.has(k)) firstDraw.set(k, s);
      }
      const isRepeat = (g) => firstDraw.get(`${g.show.source.id}#${g.show.opIndex}`) !== g.show;
      const twin = (g) => firstDraw.get(`${g.show.source.id}#${g.show.opIndex}`).glyphs[g.show.glyphs.indexOf(g)];

      // 1. Collect matches.
      const jobs = [];
      const used = new Set();
      for (const line of lines) {
        for (const m of findInLine(line.text, search, caseSensitive)) {
          let { start, end } = m;
          // Expand to whole glyphs when a ligature is cut by the match.
          while (start > 0 && line.chars[start].glyph && line.chars[start].part > 0) start--;
          while (end < line.chars.length && line.chars[end]?.glyph && line.chars[end].part > 0) end++;
          let core = typeof replace === 'function' ? replace(m.text) : String(replace).replace(/\$&/g, () => m.text);
          // A space that is only a positioning gap (no glyph) at either end of the
          // match stays as it is; don't insert it a second time.
          while (start < end && !line.chars[start].glyph && start === m.start && /^\s/.test(core)) {
            start++; core = core.slice(1); m.start++;
          }
          while (end > start && !line.chars[end - 1].glyph && end === m.end && /\s$/.test(core)) {
            end--; core = core.slice(0, -1); m.end--;
          }
          const glyphs = glyphsOf(line, start, end);
          if (!glyphs.length || glyphs.some((g) => used.has(g))) continue;
          if (glyphs.some((g) => g.show.source.kind === 'xobject' && doneForms.has(g.show.source.id))) continue;
          if (glyphs.some(isRepeat)) {
            // Same text where the form is first drawn is edited there (and shows up here too).
            if (!glyphs.every((g) => used.has(twin(g)))) {
              report.skipped.push({ page: pageIndex, text: m.text, reason: 'text belongs to a form drawn more than once and differs from its first drawing' });
            }
            continue;
          }
          const newText = line.text.slice(start, m.start) + core + line.text.slice(m.end, end);
          jobs.push({ glyphs, newText, line, original: m.text });
          glyphs.forEach((g) => used.add(g));
        }
      }
      if (!jobs.length) continue;

      // 2. Plan each match.
      /** desired user-space shift along the line for glyphs; accumulates across matches */
      const offsets = new Map();
      const addOffset = (g, d) => offsets.set(g, (offsets.get(g) || 0) + d);
      /** removed glyph -> match id */
      const removed = new Map();
      /** first glyph of a match -> insertion */
      const insertions = new Map();
      let id = 0;

      // maxCount counts successful replacements only.
      const planned = [];
      for (const job of jobs) {
        if (remaining <= 0) break;
        const plan = this.#planJob(job, ctx, { mode, align, minScale }, report, pageIndex);
        if (plan) {
          planned.push({ job, plan });
          remaining--;
        }
      }

      // Paragraphs where a match does not fit on its line are re-wrapped.
      const wrapped = new Set();
      const blocks = [];
      if (mode === 'reflow' && options.wrap !== false) {
        ctx.textRight = ctx.textArea?.right;
        const done = new Set();
        for (const e of planned) {
          if (!e.plan.needsWrap || done.has(e.job.line)) continue;
          const para = detectParagraph(e.job.line, ctx);
          if (!para) continue;
          para.lines.forEach((l) => done.add(l));
          const edits = planned.filter((x) => para.lines.includes(x.job.line));
          const res = rewrapParagraph(para, edits, ctx);
          if (!res) continue;
          edits.forEach((x) => wrapped.add(x));
          blocks.push({ source: para.source, ...res, id: `para${blocks.length}` });
          for (const x of edits) {
            report.replaced++;
            report.details.push({
              page: pageIndex, from: x.job.original, to: x.job.newText, align: 'paragraph', scale: round(res.scale),
              font: x.plan.font.baseFont, embeddedFont: x.plan.font instanceof EmbeddedFont, rewrapped: true, lines: res.lineCount,
            });
          }
        }
        for (const b of blocks) for (const g of b.removed) removed.set(g, b.id);
      }

      for (const { job, plan } of planned) {
        if ([...wrapped].some((x) => x.job === job)) continue;
        report.warnings.push(...plan.warnings);
        const matchId = id++;
        job.glyphs.forEach((g) => removed.set(g, matchId));
        insertions.set(job.glyphs[0], { ...plan, id: matchId });
        for (const [g, d] of plan.shifts) addOffset(g, d);
        report.replaced++;
        report.details.push({
          page: pageIndex,
          from: job.original,
          to: job.newText,
          align: plan.align,
          scale: round(plan.scale),
          font: plan.font.baseFont,
          embeddedFont: plan.font instanceof EmbeddedFont,
        });
      }
      if (!insertions.size && !blocks.length) continue;

      // 3. Rewrite affected operations, source by source, in content order.
      const bySource = new Map();
      for (const show of interpreter.shows) {
        if (!bySource.has(show.source)) bySource.set(show.source, []);
        bySource.get(show.source).push(show);
      }
      for (const [source, shows] of bySource) {
        const replacements = new Map();
        const outgoing = new Map();
        // Several paragraphs may start in the same text object: keep all their blocks.
        for (const b of blocks) {
          if (b.source !== source) continue;
          const prev = replacements.get(b.opIndex);
          replacements.set(b.opIndex, prev ? [...prev.slice(0, -1), ...b.ops, prev[prev.length - 1]] : [...b.ops, { op: 'BT', operands: [] }]);
        }
        // ActualText spans whose glyphs were all replaced would hide the new text
        // (the outermost span wins), so drop their ActualText.
        for (const g of removed.keys()) {
          const span = g.cluster;
          if (!span || span.source !== source || replacements.has(span.opIndex)) continue;
          if (span.glyphs.every((x) => removed.has(x))) {
            replacements.set(span.opIndex, [{ op: 'BDC', operands: [span.tag || PDFName.of('Span'), new PDFDict()] }]);
          }
        }
        const ordered = [...shows].sort((a, b) => a.opIndex - b.opIndex);
        const seen = new Set();
        for (const show of ordered) {
          if (seen.has(show.opIndex)) continue; // a form drawn twice is interpreted twice
          seen.add(show.opIndex);
          const incoming = show.prev ? outgoing.get(show.prev) || 0 : 0;
          const res = rewriteShow(show, { removed, insertions, offsets, incoming });
          outgoing.set(show, res.outgoing);
          if (res.ops) replacements.set(show.opIndex, res.ops);
        }
        if (replacements.size) {
          this.#writeSource(source, rebuildContent(source.bytes, source.ops, replacements), report);
          if (source.kind === 'xobject') doneForms.add(source.id);
        }
      }
      report.warnings.push(...interpreter.warnings.map((w) => `page ${pageIndex + 1}: ${w}`));
    }
    if (report.replaced && this.signedWarning) report.warnings.unshift(this.signedWarning);
    report.warnings = [...new Set(report.warnings)];
    return report;
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  /**
   * Decides font, encoding and geometry for one match.
   * Returns null (and records the reason) when it cannot be replaced.
   */
  #planJob(job, ctx, { mode, align, minScale }, report, pageIndex) {
    const first = job.glyphs[0];
    const last = job.glyphs[job.glyphs.length - 1];
    const show = first.show;
    const font = show.font;
    const skip = (reason) => {
      report.skipped.push({ page: pageIndex, text: job.original, reason });
      return null;
    };
    if (!font) return skip('font not loaded');
    if (font.vertical) return skip('vertical writing not supported yet');

    // Encoding: the PDF's own font first, then a matching full font.
    // Complex scripts always need a font with OpenType layout tables.
    let useFont = font;
    let enc;
    let missing;
    if (isDevanagari(job.newText)) {
      const sf = this.#complexFontFor(font, 'deva');
      if (!sf) {
        return skip('no Devanagari font with OpenType layout found (install e.g. Noto Sans Devanagari or pass options.scriptFonts.deva)');
      }
      useFont = sf;
      enc = sf.encode(job.newText);
      missing = enc.missing.filter((c) => !/\s/.test(c));
    } else {
      enc = font.encode(job.newText);
      missing = enc.missing.filter((c) => !/\s/.test(c));
    }
    if (missing.length && this.options.embedMissingGlyphs !== false && useFont === font) {
      const sub = this.#substituteFor(font);
      if (sub && sub.supports(job.newText)) {
        useFont = sub;
        enc = sub.encode(job.newText);
        missing = [];
        if (!sub.matched) report.warnings.push(`Font ${font.baseFont || '(unnamed)'} is not installed; "${job.newText}" uses the closest match ${sub.baseFont}.`);
        report.warnings.push(...sub.warnings.splice(0));
      }
    }
    if (missing.length) {
      return skip(`font ${font.baseFont} has no glyph for: ${[...new Set(missing)].join(' ')}` +
        ' and no matching font file was found (pass options.fonts or fallbackFont)');
    }
    const fontKey = useFont !== font ? this.#fontResource(show.source, useFont) : null;

    // Widths in the text space of the first operation.
    const fs = show.fontSize, Th = show.Th;
    const spaceGap = ((useFont.spaceWidth ?? 0.25) * fs + show.Tw) * Th;
    let insDisp = 0;
    for (const g of enc.glyphs) {
      insDisp += g.code < 0 ? spaceGap : ((g.width + (g.dx || 0)) * fs + show.Tc + (g.isSpace ? show.Tw : 0)) * Th;
    }
    const hs = show.hscale; // user units per text-space unit
    const line = job.line;
    const along = (x, y) => x * line.dir[0] + y * line.dir[1];
    const startU = along(first.x, first.y);
    const endU = along(last.ex, last.ey);
    const availU = endU - startU;
    const insU = insDisp * hs;

    // Line segment context.
    const inJob = new Set(job.glyphs);
    const idxFirst = line.glyphs.indexOf(first);
    const idxLast = line.glyphs.indexOf(last);
    const before = line.glyphs.slice(0, idxFirst).filter((g) => !inJob.has(g));
    const after = line.glyphs.slice(idxLast + 1).filter((g) => !inJob.has(g));
    const geo = lineGeometry(line, ctx);

    let resolvedAlign = align;
    if (align === 'auto') resolvedAlign = detectAlignment(line, geo, ctx, after.length === 0);

    const warnings = [];
    let needsWrap = false;
    // Several matches on one line share its free space.
    ctx.budget ??= new Map();
    if (!ctx.budget.has(line)) ctx.budget.set(line, { left: 0, right: 0, gaps: 0 });
    const budget = ctx.budget.get(line);

    let scale = 1;
    const shifts = new Map();
    let blockStartU; // start of the new text relative to the old match start (user space)
    const growth = () => insU * scale - availU;

    if (mode === 'preserve' || mode === 'fit') {
      if (mode === 'fit' && insU > availU && insU > 0) scale = availU / insU;
      blockStartU = resolvedAlign === 'right' ? -growth() : resolvedAlign === 'center' ? -growth() / 2 : 0;
      if (mode === 'preserve' && growth() > fs * 0.05 * hs && after.length) {
        report.warnings.push(`"${job.newText}" is wider than "${job.original}" and may overlap the following text (mode "preserve").`);
      }
    } else if (geo.justified && (wordStarts(line, inJob).length > 0)) {
      // Justified line: spread the change over all word gaps of the line so
      // both edges stay where they were.
      const starts = wordStarts(line, inJob); // glyphs that begin a word (outside the match)
      const nBefore = starts.filter((g) => line.glyphs.indexOf(g) < idxFirst).length;
      const G = starts.length;
      const em = line.size || fs * hs;
      const maxShrink = em * 0.12; // per gap
      const maxGrow = em * 0.6;
      const capacity = Math.max(0, G * maxShrink - budget.gaps);
      if (growth() > capacity && insU > 0) {
        scale = Math.max(minScale, (availU + capacity) / insU);
        needsWrap = true;
      }
      const g = growth();
      // Much shorter text would stretch gaps absurdly: leave the line ragged instead.
      const per = g <= capacity && -g <= G * maxGrow ? g / G : 0;
      budget.gaps += per ? g : 0;
      const startSet = new Set(starts);
      let k = 0;
      for (const gl of line.glyphs) {
        if (inJob.has(gl)) continue;
        if (startSet.has(gl)) k++;
        const isAfter = line.glyphs.indexOf(gl) > idxLast;
        shifts.set(gl, isAfter ? (per ? g - k * per : g) : -k * per);
      }
      blockStartU = -nBefore * per;
    } else {
      const roomRight = Math.max(0, geo.rightLimit - geo.end - budget.right);
      const roomLeft = Math.max(0, geo.start - geo.leftLimit - budget.left);
      if (growth() > 0 && insU > 0) {
        const room = resolvedAlign === 'right' ? roomLeft
          : resolvedAlign === 'center' ? 2 * Math.min(roomLeft, roomRight)
            : roomRight;
        if (growth() > room) {
          scale = Math.max(minScale, (availU + room) / insU);
          needsWrap = true;
        }
      }
      const g = growth();
      if (resolvedAlign === 'right') budget.left += g;
      else if (resolvedAlign === 'center') { budget.left += g / 2; budget.right += g / 2; }
      else budget.right += g;
      if (resolvedAlign === 'right') {
        blockStartU = -g;
        for (const gl of before) shifts.set(gl, -g);
      } else if (resolvedAlign === 'center') {
        blockStartU = -g / 2;
        for (const gl of before) shifts.set(gl, -g / 2);
        for (const gl of after) shifts.set(gl, g / 2);
      } else {
        blockStartU = 0;
        for (const gl of after) shifts.set(gl, g);
      }
    }
    if (scale < 0.75) {
      warnings.push(`"${job.newText}" condensed to ${Math.round(scale * 100)}% width to fit the available space.`);
    }
    if (mode !== 'preserve' && scale <= minScale && insU * scale - availU > 0.5) {
      warnings.push(`"${job.newText}" does not fully fit even at ${Math.round(minScale * 100)}% width.`);
    }

    return { glyphs: enc.glyphs, actualText: enc.actualText, font: useFont, fontKey, scale, blockStart: blockStartU, spaceGap, shifts, align: resolvedAlign, needsWrap, warnings };
  }

  /**
   * A font able to shape a complex script: the PDF font's own family if it
   * is installed and has the layout tables, else a known good system font.
   */
  #complexFontFor(font, script) {
    const key = `${script}:${normalizeFontName(font.baseFont || '')}`;
    if (this.substitutes.has(key)) return this.substitutes.get(key);
    const candidates = [];
    const explicit = this.options.scriptFonts?.[script];
    if (explicit) candidates.push({ file: explicit, index: 0 });
    const own = font.baseFont ? this.resolver.resolve(font.baseFont) : null;
    if (own) candidates.push(own);
    const bold = /bold|black|heavy|semibold/i.test(font.baseFont || '');
    const scriptFonts = this.resolver.resolveScript(script, { bold });
    // Nameless fonts (e.g. Chrome's Type3 fonts): pick the weight whose metrics match.
    const byMetrics = this.#metricMatch(font, scriptFonts);
    if (byMetrics) candidates.push(byMetrics);
    candidates.push(...scriptFonts);
    let chosen = null;
    for (const c of candidates) {
      try {
        const ef = this.#openFont(c);
        if (script === 'deva' && !ef.canShapeDevanagari) continue;
        ef.register();
        chosen = ef;
        break;
      } catch { /* try next */ }
    }
    this.substitutes.set(key, chosen);
    return chosen;
  }

  #openFont(c) {
    this.fontCache ??= new Map();
    const k = `${c.file}#${c.index ?? 0}`;
    if (!this.fontCache.has(k)) this.fontCache.set(k, new EmbeddedFont(this.doc, c.file, c.index ?? 0, { register: false }));
    return this.fontCache.get(k);
  }

  /**
   * Chooses the candidate font whose advance widths best match the glyphs the
   * PDF font actually contains. Returns null when nothing matches closely.
   */
  #metricMatch(font, candidates, maxScore = 0.03) {
    const best = this.#rankByMetrics(font, candidates);
    return best && best.score < maxScore ? best.c : null;
  }

  /** Best candidate by average relative advance-width error (null without samples). */
  #rankByMetrics(font, candidates) {
    const samples = font.sampleWidths();
    if (samples.size < 3) return null;
    let best = null;
    for (const c of candidates) {
      let ef;
      try { ef = this.#openFont(c); } catch { continue; }
      let err = 0, n = 0, missing = 0;
      for (const [ch, w] of samples) {
        const gid = ef.ttf.glyphForCodePoint(ch.codePointAt(0));
        if (!gid) { missing++; continue; }
        err += Math.abs(ef.ttf.advance1000(gid) - w) / Math.max(w, 1);
        n++;
      }
      if (n < 3 || missing > samples.size * 0.2) continue;
      const score = err / n;
      if (!best || score < best.score) best = { c, score };
    }
    return best;
  }

  /**
   * Last resort when the PDF's font is not installed: the most similar
   * installed font (serif/sans/monospace, bold, italic, then widths).
   */
  #similarFont(font) {
    const name = (font.baseFont || '').replace(/^[A-Z]{6}\+/, '');
    const flags = font.descriptor ? num(this.doc.resolve(font.descriptor.get('Flags'))) : 0;
    const mono = /mono|courier|consol|menlo|code/i.test(name) || !!(flags & 1);
    const serif = !mono && (/serif|times|roman|georgia|garamond|minion|cambria|book|palatino|baskerville/i.test(name.replace(/sans/i, '')) && !/sans/i.test(name) || (!!(flags & 2) && !/sans/i.test(name)));
    const bold = /bold|black|heavy|semibold|demi/i.test(name);
    const italic = /italic|oblique/i.test(name) || !!(flags & 64);
    const pool = this.resolver.candidates().filter((c) => {
      const st = `${c.style} ${c.ps}`;
      const cMono = /mono|courier/i.test(c.family);
      const cSerif = /times|georgia|cambria|serif/i.test(c.family) && !/sans/i.test(c.family);
      return cMono === mono && (mono || cSerif === serif) && /bold|black|heavy/i.test(st) === bold && /italic|oblique/i.test(st) === italic;
    });
    if (!pool.length) return null;
    const ranked = this.#rankByMetrics(font, pool);
    if (ranked) return ranked.c;
    const order = mono ? ['Courier New', 'Courier'] : serif ? ['Times New Roman', 'Times', 'Georgia'] : ['Helvetica', 'Arial', 'Helvetica Neue'];
    for (const fam of order) {
      const hit = pool.find((c) => c.family === fam);
      if (hit) return hit;
    }
    return pool[0];
  }

  /** Finds (and caches) an embeddable font matching a PDF font. */
  #substituteFor(font) {
    const key = normalizeFontName(font.baseFont || '');
    if (this.substitutes.has(key)) return this.substitutes.get(key);
    let sub = null;
    let found = font.baseFont ? this.resolver.resolve(font.baseFont) : null;
    if (!found) found = this.#metricMatch(font, this.resolver.candidates());
    let similar = null;
    if (!found && !this.options.fallbackFont && this.options.substituteFonts !== false) similar = this.#similarFont(font);
    const pick = found || similar || (this.options.fallbackFont ? { file: this.options.fallbackFont, index: 0 } : null);
    if (pick) {
      try {
        sub = this.#openFont(pick);
        sub.register();
        sub.matched = !!found;
      } catch {
        sub = null;
      }
    }
    this.substitutes.set(key, sub);
    return sub;
  }

  /** Adds `embedded` to a content source's font resources; returns its name. */
  #fontResource(source, embedded) {
    source.addedFonts ??= new Map();
    if (source.addedFonts.has(embedded)) return source.addedFonts.get(embedded);
    const doc = this.doc;
    let resources;
    if (source.kind === 'page') {
      resources = source.ownResources ??= source.page.ownResources();
    } else {
      resources = doc.resolve(source.stream.dict.get('Resources'));
      if (!(resources instanceof PDFDict)) {
        resources = source.resources.clone();
        source.stream.dict.set('Resources', resources);
      } else if (source.stream.dict.get('Resources') instanceof PDFRef) {
        doc.update(source.stream.dict.get('Resources'), resources);
      }
    }
    let fonts = resources.get('Font');
    const resolvedFonts = doc.resolve(fonts);
    if (fonts instanceof PDFRef || !(resolvedFonts instanceof PDFDict)) {
      // Never modify a font dictionary that may be shared: copy it in place.
      fonts = resolvedFonts instanceof PDFDict ? resolvedFonts.clone() : new PDFDict();
      resources.set('Font', fonts);
    }
    let i = 1;
    while (fonts.has(`LbF${i}`)) i++;
    const name = `LbF${i}`;
    fonts.set(name, embedded.ref);
    source.addedFonts.set(embedded, name);
    return name;
  }

  #pageList(pages) {
    const count = this.doc.pageCount;
    if (!pages) return [...Array(count).keys()];
    return pages.filter((p) => p >= 0 && p < count);
  }

  #analyze(pageIndex) {
    const page = this.doc.getPage(pageIndex);
    const interpreter = new ContentInterpreter(this.doc);
    interpreter.runPage(page);
    const lines = buildLines(interpreter.shows);
    return { page, lines, interpreter };
  }

  #writeSource(source, bytes, report) {
    if (source.kind === 'page') {
      source.page.setContentBytes(bytes);
    } else {
      if ((source.uses || 0) > 1) {
        report.warnings.push(`Edited a form XObject used ${source.uses} times; the change appears everywhere it is used.`);
      }
      this.doc.setStreamData(source.stream, bytes);
      if (source.ref) this.doc.update(source.ref, source.stream);
    }
  }
}

// ---- layout analysis ----------------------------------------------------------------

/**
 * Works out the room around a line segment: table borders, neighbouring
 * segments and page margins, plus whether it belongs to a justified block.
 */
function lineGeometry(line, ctx) {
  const { lines, interpreter, page } = ctx;
  const horizontal = Math.abs(line.dir[1]) < 0.01 && line.dir[0] > 0;
  const size = line.size || 10;
  const first = line.glyphs[0];
  // Trailing blanks (e.g. fixed-width layouts padded with spaces) take no room.
  let li = line.glyphs.length - 1;
  while (li > 0 && !line.glyphs[li].unicode.trim() && !line.glyphs[li].cluster) li--;
  const last = line.glyphs[li];
  const start = first.x;
  const end = last.ex;
  const y = first.y;
  const geo = { start, end, leftLimit: start, rightLimit: end, leftRule: null, rightRule: null, justified: false };
  if (!horizontal) return geo; // rotated text: no growth room assumed

  // Vertical rules crossing the baseline region.
  for (const r of interpreter.vrules) {
    if (r.y0 > y + size * 0.8 || r.y1 < y - size * 0.3) continue;
    if (r.x0 <= start + 0.5 && (geo.leftRule === null || r.x0 > geo.leftRule)) geo.leftRule = r.x0;
    if (r.x0 >= end - 0.5 && (geo.rightRule === null || r.x0 < geo.rightRule)) geo.rightRule = r.x0;
  }
  // Neighbouring segments on the same baseline.
  let prevEnd = -Infinity, nextStart = Infinity;
  for (const l of lines) {
    if (l === line || Math.abs(l.y - y) > size * 0.4 || Math.abs(l.dir[1]) > 0.01) continue;
    const ls = l.glyphs[0].x, le = l.glyphs[l.glyphs.length - 1].ex;
    if (ls >= end - 0.5) nextStart = Math.min(nextStart, ls);
    if (le <= start + 0.5) prevEnd = Math.max(prevEnd, le);
  }
  const [px0, , px1] = page.cropBox;
  // Text area of the page, assumed to have symmetric left/right margins.
  if (!ctx.textArea) {
    let minX = Infinity, maxX = -Infinity;
    for (const l of lines) {
      if (Math.abs(l.dir[1]) > 0.01 || !l.text.trim()) continue;
      const visible = l.glyphs.filter((g) => g.unicode.trim());
      if (!visible.length) continue;
      minX = Math.min(minX, visible[0].x);
      maxX = Math.max(maxX, visible[visible.length - 1].ex);
    }
    ctx.textArea = {
      left: Math.min(minX, px0 + (px1 - maxX)),
      right: Math.max(maxX, px1 - (minX - px0)),
    };
  }
  const area = ctx.textArea;
  const padL = geo.leftRule !== null ? Math.max(1, Math.min(start - geo.leftRule, size * 0.6)) : 0;
  const padR = geo.rightRule !== null ? Math.max(1, Math.min(geo.rightRule - end, size * 0.6)) : 0;
  geo.rightLimit = Math.min(
    geo.rightRule !== null ? geo.rightRule - padR : Infinity,
    nextStart !== Infinity ? nextStart - size * 0.5 : Infinity,
    Math.max(end, area.right),
  );
  geo.leftLimit = Math.max(
    geo.leftRule !== null ? geo.leftRule + padL : -Infinity,
    prevEnd !== -Infinity ? prevEnd + size * 0.5 : -Infinity,
    Math.min(start, area.left),
  );

  // Justified block: word gaps stretched beyond the natural space width, and a
  // neighbouring line with the same start and end.
  if (!gapsStretched(line)) return geo;
  for (const l of lines) {
    if (l === line || Math.abs(l.size - size) > 0.5 || Math.abs(l.dir[1]) > 0.01) continue;
    const dy = Math.abs(l.y - y);
    if (dy < size * 0.5 || dy > size * 2.5) continue;
    const ls = l.glyphs[0].x, le = l.glyphs[l.glyphs.length - 1].ex;
    if (Math.abs(ls - start) < 1 && Math.abs(le - end) < 1.5 && end - start > size * 15) {
      geo.justified = true;
      break;
    }
  }
  return geo;
}

/**
 * True when the line's word gaps are wider than the font's natural space,
 * i.e. the producer stretched them (via Tw, TJ offsets or positioning).
 */
function gapsStretched(line) {
  let actual = 0, natural = 0, n = 0;
  for (let i = 1; i < line.chars.length - 1; i++) {
    const c = line.chars[i];
    if (c.ch !== ' ') continue;
    const prev = line.chars[i - 1].glyph;
    const next = line.chars[i + 1].glyph;
    if (!prev || !next || prev === next) continue;
    const gap = Math.hypot(next.x - prev.ex, next.y - prev.ey);
    const font = (c.glyph || prev).show.font;
    const nat = (font?.spaceWidth ?? 0.25) * prev.size;
    actual += gap;
    natural += nat;
    n++;
  }
  return n >= 2 && actual > natural * 1.08;
}

/** Guesses whether a segment is left, right or centre aligned. */
function detectAlignment(line, geo, ctx, matchAtEnd) {
  const size = line.size || 10;
  // Inside a table cell: compare the gaps to both borders.
  if (geo.leftRule !== null && geo.rightRule !== null) {
    const gl = geo.start - geo.leftRule;
    const gr = geo.rightRule - geo.end;
    if (Math.abs(gl - gr) < Math.max(1, 0.1 * Math.min(gl, gr)) && gl > size * 0.8) return 'center';
    if (gr < gl * 0.5 && gr < size * 2 && matchAtEnd) return 'right';
    return 'left';
  }
  // Borderless columns: other lines stacked above/below sharing an edge.
  let sameEnd = 0, sameStart = 0, sameCenter = 0;
  const center = (geo.start + geo.end) / 2;
  for (const l of ctx.lines) {
    if (l === line || Math.abs(l.dir[1]) > 0.01) continue;
    const dy = Math.abs(l.y - line.y);
    if (dy < size * 0.5 || dy > size * 12) continue;
    const ls = l.glyphs[0].x, le = l.glyphs[l.glyphs.length - 1].ex;
    if (Math.abs(le - geo.end) < 0.6 && Math.abs(ls - geo.start) > 2) sameEnd++;
    if (Math.abs(ls - geo.start) < 0.6) sameStart++;
    if (Math.abs((ls + le) / 2 - center) < 0.6 && Math.abs(ls - geo.start) > 2) sameCenter++;
  }
  if (sameEnd > 0 && sameEnd >= sameStart && matchAtEnd) return 'right';
  if (sameCenter > 0 && sameCenter > sameStart) return 'center';
  return 'left';
}

/** Glyphs (outside `exclude`) that begin a word after a gap – where justification space lives. */
function wordStarts(line, exclude) {
  const out = [];
  for (let i = 1; i < line.chars.length; i++) {
    const c = line.chars[i];
    if (!c.glyph || exclude.has(c.glyph) || c.part > 0) continue;
    if (/\s/.test(line.chars[i - 1].ch) && !/\s/.test(c.ch)) out.push(c.glyph);
  }
  return out;
}

// ---- matching -----------------------------------------------------------------------

function findInLine(text, search, caseSensitive) {
  const out = [];
  if (search instanceof RegExp) {
    let flags = search.flags.includes('g') ? search.flags : search.flags + 'g';
    if (!caseSensitive && !flags.includes('i')) flags += 'i';
    const re = new RegExp(search.source, flags);
    let m;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return out;
  }
  if (!search) return out;
  if (!caseSensitive) {
    // Lower-casing can change string length (e.g. "İ"), so match with a regex instead.
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
    return findInLine(text, new RegExp(escaped, 'iu'), true);
  }
  let i = 0;
  while ((i = text.indexOf(search, i)) >= 0) {
    out.push({ start: i, end: i + search.length, text: text.slice(i, i + search.length) });
    i += search.length;
  }
  return out;
}

function glyphsOf(line, start, end) {
  const seen = new Set();
  const add = (g) => {
    if (seen.has(g)) return;
    seen.add(g);
    // ActualText clusters (e.g. Devanagari syllables) are edited as a unit.
    if (g.cluster) for (const c of g.cluster.glyphs) seen.add(c);
  };
  for (let i = start; i < end; i++) {
    const g = line.chars[i]?.glyph;
    if (g) add(g);
  }
  const order = new Map(line.glyphs.map((g, i) => [g, i]));
  return [...seen].filter((g) => order.has(g)).sort((a, b) => order.get(a) - order.get(b));
}

function bboxOf(glyphs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of glyphs) {
    x0 = Math.min(x0, g.x, g.ex); x1 = Math.max(x1, g.x, g.ex);
    y0 = Math.min(y0, g.y, g.ey); y1 = Math.max(y1, g.y + g.size, g.ey + g.size);
  }
  return [round(x0), round(y0), round(x1), round(y1)];
}

// ---- rewriting a single text-show operation -------------------------------------------

/**
 * Re-emits one Tj/TJ/'/" operation so that every kept glyph lands at its
 * desired offset and insertions appear where planned.
 *
 * `off` tracks (actual pen − original pen) in this op's text space.
 *
 * @returns {{ ops: Array<{op:string, operands:any[]}>|null, outgoing: number }}
 */
function rewriteShow(show, { removed, insertions, offsets, incoming }) {
  const fs = show.fontSize;
  const Th = show.Th;
  const unit = fs * Th; // a TJ number n moves the pen by -n/1000 * unit
  const hs = show.hscale;
  const toText = (u) => u / hs;
  const toNum = (d) => (unit ? (-d * 1000) / unit : 0);

  // Does this op need rewriting at all?
  let touched = false;
  for (const g of show.glyphs) {
    if (removed.has(g) || Math.abs(toText(offsets.get(g) || 0) - incoming) > 1e-6) {
      touched = true;
      break;
    }
  }
  if (!touched) return { ops: null, outgoing: incoming };

  const useHex = show.font?.isType0 || show.elements.some((e) => e.type === 'str' && e.hex);
  const items = [];
  for (const el of show.elements) {
    if (el.type === 'num') items.push({ kind: 'num', value: el.value });
    else for (const g of el.glyphs) items.push({ kind: 'glyph', g });
  }

  const segments = [{ type: 'tj', items: [] }];
  const cur = () => segments[segments.length - 1];
  const pushStr = (bytes, hex) => {
    const list = cur().items;
    const last = list[list.length - 1];
    if (last instanceof Buffer) list[list.length - 1] = Buffer.concat([last, bytes]);
    else list.push(Buffer.from(bytes));
    if (hex) cur().hex = true;
  };
  const pushNum = (n) => {
    if (Math.abs(n) < 1e-4) return;
    const list = cur().items;
    const last = list[list.length - 1];
    if (typeof last === 'number') list[list.length - 1] = last + n;
    else list.push(n);
  };

  let off = incoming;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === 'num') {
      pushNum(it.value);
      i++;
      continue;
    }
    const id = removed.get(it.g);
    if (id === undefined) {
      const want = toText(offsets.get(it.g) || 0);
      if (Math.abs(want - off) > 1e-6) {
        pushNum(toNum(want - off));
        off = want;
      }
      pushStr(PDFFont.codesToBytes([it.g]));
      i++;
      continue;
    }

    // Run of removed glyphs of match `id` (numbers in between are consumed).
    let j = i, lastRemoved = i;
    while (j < items.length) {
      const x = items[j];
      if (x.kind === 'glyph') {
        if (removed.get(x.g) !== id) break;
        lastRemoved = j;
      }
      j++;
    }
    let removedDisp = 0;
    for (let k = i; k <= lastRemoved; k++) {
      const x = items[k];
      removedDisp += x.kind === 'glyph' ? x.g.adv : (-x.value / 1000) * unit;
    }

    const ins = insertions.get(it.g);
    if (ins) {
      // Move the pen to the planned start of the new text.
      const startWant = toText((offsets.get(it.g) || 0) + ins.blockStart);
      if (Math.abs(startWant - off) > 1e-6) pushNum(toNum(startWant - off));
      const switchFont = ins.fontKey && show.fontKey;
      if (switchFont) {
        segments.push({ type: 'tf', name: ins.fontKey, size: fs });
        segments.push({ type: 'tj', items: [] });
      }
      if (ins.scale !== 1) {
        segments.push({ type: 'tz', value: Th * ins.scale * 100 });
        segments.push({ type: 'tj', items: [] });
      }
      if (ins.actualText) {
        // Shaped text is in visual order; ActualText keeps search/copy correct.
        segments.push({ type: 'bdc', text: ins.actualText });
        segments.push({ type: 'tj', items: [] });
      }
      let insDisp = 0;
      for (const g of ins.glyphs) {
        if (g.code < 0) {
          pushNum(toNum(ins.spaceGap)); // scaled by Tz like the glyphs
          insDisp += ins.spaceGap;
          continue;
        }
        // GPOS placement: x via TJ displacement around the glyph, y via text rise.
        if (g.xOff) pushNum(-g.xOff * 1000);
        if (g.yOff) {
          segments.push({ type: 'ts', value: show.rise + g.yOff * fs });
          segments.push({ type: 'tj', items: [] });
        }
        pushStr(PDFFont.codesToBytes([g]), !!switchFont);
        if (g.yOff) {
          segments.push({ type: 'ts', value: show.rise });
          segments.push({ type: 'tj', items: [] });
        }
        if (g.xOff) pushNum(g.xOff * 1000);
        if (g.dx) pushNum(-g.dx * 1000);
        insDisp += ((g.width + (g.dx || 0)) * fs + show.Tc + (g.isSpace ? show.Tw : 0)) * Th;
      }
      if (ins.actualText) {
        segments.push({ type: 'emc' });
        segments.push({ type: 'tj', items: [] });
      }
      if (ins.scale !== 1) {
        segments.push({ type: 'tz', value: Th * 100 });
        segments.push({ type: 'tj', items: [] });
      }
      if (switchFont) {
        segments.push({ type: 'tf', name: show.fontKey, size: fs });
        segments.push({ type: 'tj', items: [] });
      }
      // Actual pen is at startWant + insDisp*scale; the original pen at the removed end.
      off = startWant + insDisp * ins.scale - removedDisp;
    } else {
      // Pure removal (continuation of a match that began in an earlier op).
      off -= removedDisp;
    }
    i = lastRemoved + 1;
  }

  const ops = [];
  if (show.op === "'") ops.push({ op: 'T*', operands: [] });
  if (show.op === '"') {
    const src = show.source.ops[show.opIndex].operands;
    ops.push({ op: 'Tw', operands: [src[0]] }, { op: 'Tc', operands: [src[1]] }, { op: 'T*', operands: [] });
  }
  for (const seg of segments) {
    if (seg.type === 'tz') {
      ops.push({ op: 'Tz', operands: [round(seg.value)] });
      continue;
    }
    if (seg.type === 'tf') {
      ops.push({ op: 'Tf', operands: [PDFName.of(seg.name), seg.size] });
      continue;
    }
    if (seg.type === 'ts') {
      ops.push({ op: 'Ts', operands: [round(seg.value)] });
      continue;
    }
    if (seg.type === 'bdc') {
      ops.push({ op: 'BDC', operands: [PDFName.of('Span'), new PDFDict().set('ActualText', PDFString.fromText(seg.text))] });
      continue;
    }
    if (seg.type === 'emc') {
      ops.push({ op: 'EMC', operands: [] });
      continue;
    }
    if (!seg.items.length) continue;
    const arr = seg.items.map((x) => (x instanceof Buffer ? new PDFString(x, useHex || !!seg.hex) : round(x)));
    if (arr.length === 1 && arr[0] instanceof PDFString) ops.push({ op: 'Tj', operands: arr });
    else ops.push({ op: 'TJ', operands: [arr] });
  }
  // Keep a pen-moving no-op if everything was removed, so later ops stay in sync.
  if (!ops.length) ops.push({ op: 'Tj', operands: [new PDFString(Buffer.alloc(0))] });
  return { ops, outgoing: off };
}
