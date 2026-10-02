// Content-stream interpreter that tracks the graphics and text state and
// records every text-showing operation with exact glyph positions
// (ISO 32000-1, sections 8.4, 9.3, 9.4).

import { PDFDict, PDFName, PDFRef, PDFStream, PDFString, num } from '../core/objects.js';
import { parseOperations } from './operations.js';
import { IDENTITY, multiply, apply, translate } from './matrix.js';
import { loadFont } from '../fonts/font.js';
import { limits, PDFLimitError } from '../core/limits.js';

/**
 * @typedef {object} ContentSource
 * @property {string} id
 * @property {'page'|'xobject'} kind
 * @property {PDFRef|null} ref        XObject ref (kind = xobject)
 * @property {Buffer} bytes           decoded content
 * @property {import('./operations.js').Operation[]} ops
 * @property {PDFDict} resources
 */

/**
 * @typedef {object} PositionedGlyph
 * @property {string} unicode
 * @property {number} code
 * @property {number} len
 * @property {number} width   glyph width (text space, size 1)
 * @property {number} adv     horizontal displacement in unscaled text space (tx)
 * @property {number} x       user-space origin
 * @property {number} y
 * @property {number} ex      user-space end point
 * @property {number} ey
 * @property {number} size    effective font size in user space
 * @property {TextShow} show
 * @property {number} elem    index of the string element inside the op (TJ array index; 0 for Tj)
 * @property {number} idx     index of the glyph inside that string element
 */

/**
 * @typedef {object} TextShow
 * @property {ContentSource} source
 * @property {number} opIndex
 * @property {string} op
 * @property {import('../fonts/font.js').PDFFont} font
 * @property {string} fontKey
 * @property {number} fontSize
 * @property {number} Tc
 * @property {number} Tw
 * @property {number} Th
 * @property {number} rise
 * @property {number[]} tm      text matrix at the start of the shown text
 * @property {number[]} ctm
 * @property {Array<{type:'str', bytes:Buffer, hex:boolean, glyphs:PositionedGlyph[]} | {type:'num', value:number}>} elements
 * @property {PositionedGlyph[]} glyphs
 * @property {number} renderMode
 * @property {TextShow|null} prev  previous show whose end is this show's start
 *   (no text positioning operator in between), so pen shifts carry over
 */

/** @typedef {{ x0:number, y0:number, x1:number, y1:number }} Rule  painted line segment (user space) */

const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

const defaultTextState = () => ({
  font: null,
  fontKey: null,
  fontSize: 0,
  Tc: 0,
  Tw: 0,
  Th: 1,
  TL: 0,
  rise: 0,
  renderMode: 0,
});

export class ContentInterpreter {
  /**
   * @param {import('../core/document.js').PDFDocument} doc
   * @param {{ followForms?: boolean }} [options]
   */
  constructor(doc, options = {}) {
    this.doc = doc;
    this.followForms = options.followForms !== false;
    /** @type {TextShow[]} */
    this.shows = [];
    /** @type {Map<string, ContentSource>} */
    this.sources = new Map();
    this.warnings = [];
    /** Vertical / horizontal painted rules (table borders etc.). @type {Rule[]} */
    this.vrules = [];
    /** @type {Rule[]} */
    this.hrules = [];
  }

  /** Interprets a page; returns all text-show records in drawing order. */
  runPage(page) {
    const bytes = page.getContentBytes();
    const source = {
      id: `page:${page.index}`,
      kind: 'page',
      ref: null,
      page,
      bytes,
      ops: parseOperations(bytes),
      resources: page.resources,
    };
    this.sources.set(source.id, source);
    this.#run(source, [...IDENTITY], new Set());
    return this.shows;
  }

  #run(source, baseCtm, formStack) {
    const doc = this.doc;
    const r = (v) => doc.resolve(v);
    let gs = { ctm: baseCtm, text: defaultTextState(), fill: [], stroke: [] };
    const stack = [];
    let tm = [...IDENTITY];
    let tlm = [...IDENTITY];

    const fontsDict = r(source.resources.get('Font'));
    const xobjects = r(source.resources.get('XObject'));

    const cloneGs = (g) => ({ ctm: [...g.ctm], text: { ...g.text }, fill: g.fill, stroke: g.stroke });
    const properties = r(source.resources.get('Properties'));
    /** Marked-content stack; entries carry an ActualText span when present. */
    const mc = [];
    let btIndex = -1;
    const ops = source.ops;
    /** Last show in the current text object, if the pen hasn't been repositioned since. */
    let continuous = null;
    let path = [];
    let subStart = null;
    let cp = null;

    for (let i = 0; i < ops.length; i++) {
      const { op, operands: a } = ops[i];
      const n = (k) => num(a[k]);
      const t = gs.text;
      switch (op) {
        case 'q':
          stack.push(cloneGs(gs));
          break;
        case 'Q':
          if (stack.length) gs = stack.pop();
          break;
        case 'cm':
          if (a.length >= 6) gs.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm);
          break;
        case 'BT':
          tm = [...IDENTITY];
          tlm = [...IDENTITY];
          continuous = null;
          btIndex = i;
          break;
        case 'BMC':
          mc.push(null);
          break;
        case 'BDC': {
          let props = a[1];
          if (props instanceof PDFName && properties instanceof PDFDict) props = r(properties.get(props.name));
          props = r(props);
          const at = props instanceof PDFDict ? r(props.get('ActualText')) : null;
          mc.push(at instanceof PDFString ? { text: at.toText(), glyphs: [], opIndex: i, source, tag: a[0] } : null);
          break;
        }
        case 'EMC':
          mc.pop();
          break;
        // Fill / stroke colour (kept as the ops that set it, for re-emission).
        case 'g': case 'rg': case 'k':
          gs.fill = [{ op, operands: a }];
          break;
        case 'G': case 'RG': case 'K':
          gs.stroke = [{ op, operands: a }];
          break;
        case 'cs':
          gs.fill = [{ op, operands: a }];
          break;
        case 'CS':
          gs.stroke = [{ op, operands: a }];
          break;
        case 'sc': case 'scn':
          gs.fill = [...gs.fill.filter((x) => x.op === 'cs'), { op, operands: a }];
          break;
        case 'SC': case 'SCN':
          gs.stroke = [...gs.stroke.filter((x) => x.op === 'CS'), { op, operands: a }];
          break;
        case 'm':
          cp = apply(gs.ctm, n(0), n(1));
          subStart = cp;
          break;
        case 'l': {
          const p2 = apply(gs.ctm, n(0), n(1));
          if (cp) path.push({ x0: cp[0], y0: cp[1], x1: p2[0], y1: p2[1] });
          cp = p2;
          break;
        }
        case 'c': cp = apply(gs.ctm, n(4), n(5)); break;
        case 'v': case 'y': cp = apply(gs.ctm, n(2), n(3)); break;
        case 'h':
          if (cp && subStart) path.push({ x0: cp[0], y0: cp[1], x1: subStart[0], y1: subStart[1] });
          cp = subStart;
          break;
        case 're': {
          const [x, y, w, h] = [n(0), n(1), n(2), n(3)];
          const c = [apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h)];
          for (let k = 0; k < 4; k++) path.push({ x0: c[k][0], y0: c[k][1], x1: c[(k + 1) % 4][0], y1: c[(k + 1) % 4][1], rect: c });
          cp = subStart = c[0];
          break;
        }
        case 'n':
          path = [];
          break;
        case 'ET':
          continuous = null;
          break;
        case 'Tf': {
          const name = a[0] instanceof PDFName ? a[0].name : null;
          t.fontKey = name;
          t.fontSize = n(1);
          const ref = fontsDict instanceof PDFDict && name ? fontsDict.get(name) : null;
          try {
            t.font = ref ? loadFont(doc, ref) : null;
          } catch (e) {
            t.font = null;
            this.warnings.push(`Font ${name} failed to load: ${e.message}`);
          }
          if (!t.font) this.warnings.push(`Font resource ${name} not found`);
          break;
        }
        case 'Tc': t.Tc = n(0); break;
        case 'Tw': t.Tw = n(0); break;
        case 'Tz': t.Th = n(0) / 100; break;
        case 'TL': t.TL = n(0); break;
        case 'Ts': t.rise = n(0); break;
        case 'Tr': t.renderMode = n(0); break;
        case 'Td':
          continuous = null;
          tlm = multiply(translate(n(0), n(1)), tlm);
          tm = [...tlm];
          break;
        case 'TD':
          continuous = null;
          t.TL = -n(1);
          tlm = multiply(translate(n(0), n(1)), tlm);
          tm = [...tlm];
          break;
        case 'Tm':
          continuous = null;
          tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
          tm = [...tlm];
          break;
        case 'T*':
          continuous = null;
          tlm = multiply(translate(0, -t.TL), tlm);
          tm = [...tlm];
          break;
        case "'":
        case '"':
        case 'Tj':
        case 'TJ': {
          if (op === '"') {
            t.Tw = n(0);
            t.Tc = n(1);
          }
          if (op === "'" || op === '"') {
            tlm = multiply(translate(0, -t.TL), tlm);
            tm = [...tlm];
          }
          if (op === "'" || op === '"') continuous = null;
          const arg = op === 'TJ' ? a[0] : a[a.length - 1];
          // The outermost ActualText span wins (ISO 32000-1, 14.9.4).
          const span = mc.find((m) => m);
          tm = this.#show(source, i, op, arg, gs, tm, continuous, { span, tlm, btIndex });
          continuous = this.shows[this.shows.length - 1];
          break;
        }
        case 'Do': {
          if (!this.followForms) break;
          const name = a[0] instanceof PDFName ? a[0].name : null;
          const ref = xobjects instanceof PDFDict && name ? xobjects.get(name) : null;
          const xo = r(ref);
          if (!(xo instanceof PDFStream)) break;
          if (r(xo.dict.get('Subtype'))?.name !== 'Form') break;
          const key = ref instanceof PDFRef ? ref.key : name;
          if (formStack.has(key) || formStack.size > 12) break; // recursion guard
          let bytes;
          try {
            bytes = doc.decodeStream(xo);
          } catch (e) {
            this.warnings.push(`Form XObject ${name}: ${e.message}`);
            break;
          }
          const m = r(xo.dict.get('Matrix'));
          const fm = Array.isArray(m) && m.length === 6 ? m.map((v) => num(r(v))) : [...IDENTITY];
          const res = r(xo.dict.get('Resources'));
          const id = `xobject:${key}`;
          let sub = this.sources.get(id);
          if (!sub) {
            sub = {
              id,
              kind: 'xobject',
              ref: ref instanceof PDFRef ? ref : null,
              stream: xo,
              bytes,
              ops: parseOperations(bytes),
              resources: res instanceof PDFDict ? res : source.resources,
              uses: 0,
            };
            this.sources.set(id, sub);
          }
          sub.uses = (sub.uses || 0) + 1;
          formStack.add(key);
          this.#run(sub, multiply(fm, gs.ctm), formStack);
          formStack.delete(key);
          break;
        }
        default:
          if (PAINT_OPS.has(op)) {
            this.#collectRules(path);
            path = [];
          }
          break;
      }
    }
  }

  /** Keeps axis-aligned segments of painted paths as layout rules. */
  #collectRules(path) {
    for (const s of path) {
      const dx = Math.abs(s.x1 - s.x0);
      const dy = Math.abs(s.y1 - s.y0);
      if (s.rect) {
        // Thin filled rectangles are drawn as lines by many producers.
        const xs = s.rect.map((p) => p[0]);
        const ys = s.rect.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        if (w <= 3 && h > w) {
          if (dy > dx) this.vrules.push({ x0: (Math.max(...xs) + Math.min(...xs)) / 2, x1: (Math.max(...xs) + Math.min(...xs)) / 2, y0: Math.min(...ys), y1: Math.max(...ys) });
          continue;
        }
        if (h <= 3 && w > h) {
          if (dx > dy) this.hrules.push({ y0: (Math.max(...ys) + Math.min(...ys)) / 2, y1: (Math.max(...ys) + Math.min(...ys)) / 2, x0: Math.min(...xs), x1: Math.max(...xs) });
          continue;
        }
      }
      if (dx < 0.5 && dy > 2) this.vrules.push({ x0: s.x0, x1: s.x0, y0: Math.min(s.y0, s.y1), y1: Math.max(s.y0, s.y1) });
      else if (dy < 0.5 && dx > 2) this.hrules.push({ y0: s.y0, y1: s.y0, x0: Math.min(s.x0, s.x1), x1: Math.max(s.x0, s.x1) });
    }
  }

  /** Records a text-show op and returns the text matrix after it. */
  #show(source, opIndex, op, arg, gs, tm, prev, { span, tlm, btIndex }) {
    const t = gs.text;
    const font = t.font;
    const show = {
      source,
      opIndex,
      op,
      font,
      fontKey: t.fontKey,
      fontSize: t.fontSize,
      Tc: t.Tc,
      Tw: t.Tw,
      Th: t.Th,
      rise: t.rise,
      tm: [...tm],
      ctm: [...gs.ctm],
      elements: [],
      glyphs: [],
      renderMode: t.renderMode,
      prev: prev && prev.source === source ? prev : null,
      hscale: Math.hypot(...multiply(tm, gs.ctm).slice(0, 2)) || 1,
      tlm: [...tlm],
      btIndex,
      fill: gs.fill,
      stroke: gs.stroke,
    };
    const items = op === 'TJ' ? (Array.isArray(arg) ? arg : []) : [arg];
    const fs = t.fontSize;

    items.forEach((item, elem) => {
      if (item instanceof PDFString) {
        // Guard against pages with absurd amounts of text (memory exhaustion).
        this.glyphCount = (this.glyphCount || 0) + Math.ceil(item.bytes.length / (font?.isType0 ? 2 : 1));
        if (this.glyphCount > limits.maxGlyphsPerPage) {
          throw new PDFLimitError(`Page has more than ${limits.maxGlyphsPerPage} glyphs (setLimits({ maxGlyphsPerPage }) to raise it)`);
        }
        const glyphs = font ? font.decode(item.bytes) : [...item.bytes].map((b) => ({ code: b, len: 1, unicode: String.fromCharCode(b), width: 0.5, isSpace: b === 32 }));
        const element = { type: 'str', bytes: item.bytes, hex: item.hex, glyphs: [] };
        // Within a string only the translation of the text matrix changes, so
        // the user-space matrix is updated incrementally instead of re-multiplied.
        tm = [...tm];
        const M = multiply(tm, gs.ctm);
        const size = Math.hypot(M[2], M[3]) * fs;
        const rise = t.rise;
        glyphs.forEach((g, idx) => {
          const x = M[4] + M[2] * rise;
          const y = M[5] + M[3] * rise;
          const adv = (g.width * fs + t.Tc + (g.isSpace ? t.Tw : 0)) * t.Th;
          tm[4] += adv * tm[0];
          tm[5] += adv * tm[1];
          M[4] += adv * M[0];
          M[5] += adv * M[1];
          // Fixed object shape (no spread, no later additions) keeps V8 fast on big pages.
          const pg = {
            code: g.code, len: g.len, unicode: g.unicode, width: g.width, isSpace: g.isSpace,
            adv, x, y, ex: M[4] + M[2] * rise, ey: M[5] + M[3] * rise, size, show, elem, idx, cluster: null,
          };
          if (span) {
            // Glyphs of an ActualText span form one cluster: the first carries the text.
            pg.cluster = span;
            pg.unicode = span.glyphs.length ? '' : span.text;
            span.glyphs.push(pg);
          }
          element.glyphs.push(pg);
          show.glyphs.push(pg);
        });
        show.elements.push(element);
      } else {
        const v = num(item);
        const adv = (-v / 1000) * fs * t.Th;
        tm = multiply(translate(adv, 0), tm);
        show.elements.push({ type: 'num', value: v });
      }
    });
    this.shows.push(show);
    return tm;
  }
}
