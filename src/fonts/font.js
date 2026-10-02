// Font model for text extraction and re-encoding (ISO 32000-1, chapter 9).

import { PDFDict, PDFName, PDFRef, PDFStream, num } from '../core/objects.js';
import { CMap, parseCMap, predefinedCMap } from './cmap.js';
import { ENCODINGS, StandardEncoding, glyphNameToUnicode, symbolUnicode } from './encodings.js';
import { standardFontName, standardWidth } from './standard14.js';
import { isKrutiFont } from './legacy.js';

/**
 * @typedef {{ code:number, len:number, unicode:string, width:number, isSpace:boolean }} Glyph
 * `width` is the horizontal advance in text space for a font size of 1
 * (i.e. glyph-space width * FontMatrix scale).
 */

export class PDFFont {
  /**
   * @param {import('../core/document.js').PDFDocument} doc
   * @param {PDFDict} dict
   * @param {PDFRef|null} ref
   */
  constructor(doc, dict, ref = null) {
    this.doc = doc;
    this.dict = dict;
    this.ref = ref;
    const r = (v) => doc.resolve(v);
    this.subtype = r(dict.get('Subtype'))?.name || 'Type1';
    this.baseFont = decodeName(r(dict.get('BaseFont'))?.name || '');
    this.isSubset = /^[A-Z]{6}\+/.test(this.baseFont);
    this.isType0 = this.subtype === 'Type0';
    this.isType3 = this.subtype === 'Type3';
    /** Legacy non-Unicode Hindi layout (e.g. 'kruti'), or null. */
    this.legacy = isKrutiFont(this.baseFont) ? 'kruti' : null;
    this.warnings = [];

    // ToUnicode
    this.toUnicode = null;
    const tu = r(dict.get('ToUnicode'));
    if (tu instanceof PDFStream) {
      try {
        this.toUnicode = parseCMap(doc.decodeStream(tu), predefinedCMap);
      } catch (e) {
        this.warnings.push(`ToUnicode unreadable: ${e.message}`);
      }
    }

    if (this.isType0) this.#initType0();
    else this.#initSimple();
  }

  // ---- simple fonts (Type1, TrueType, Type3, MMType1) ---------------------------

  #initSimple() {
    const doc = this.doc;
    const r = (v) => doc.resolve(v);
    const dict = this.dict;
    const descriptor = r(dict.get('FontDescriptor'));
    this.descriptor = descriptor instanceof PDFDict ? descriptor : null;
    this.embedded = !!(this.descriptor && (this.descriptor.get('FontFile') || this.descriptor.get('FontFile2') || this.descriptor.get('FontFile3')));
    this.standardName = standardFontName(this.baseFont);
    const flags = this.descriptor ? num(r(this.descriptor.get('Flags'))) : 0;
    this.symbolic = !!(flags & 4) && !(flags & 32);

    // Encoding: base table + Differences.
    let base = null;
    this.differences = new Map();
    const enc = r(dict.get('Encoding'));
    if (enc instanceof PDFName) base = ENCODINGS[enc.name] || null;
    else if (enc instanceof PDFDict) {
      const be = r(enc.get('BaseEncoding'));
      if (be instanceof PDFName) base = ENCODINGS[be.name] || null;
      const diffs = r(enc.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const d of diffs) {
          const v = r(d);
          if (typeof v === 'number' || (v && typeof v.value === 'number')) code = num(v);
          else if (v instanceof PDFName) this.differences.set(code++, v.name);
        }
      }
    }
    if (!base) {
      if (this.isType3 || (this.symbolic && this.embedded)) base = null; // built-in encoding
      else base = this.subtype === 'TrueType' ? ENCODINGS.WinAnsiEncoding : StandardEncoding;
    }
    this.baseEncoding = base;
    this.usesSymbolEncoding = /^(?:[A-Z]{6}\+)?Symbol(?:MT)?$/.test(this.baseFont) && !(enc instanceof PDFName) &&
      !(enc instanceof PDFDict && r(enc.get('BaseEncoding')));

    // Widths
    this.firstChar = num(r(dict.get('FirstChar')), 0);
    const widths = r(dict.get('Widths'));
    this.widths = Array.isArray(widths) ? widths.map((w) => num(r(w))) : null;
    this.missingWidth = this.descriptor ? num(r(this.descriptor.get('MissingWidth')), 0) : 0;
    this.widthScale = 0.001;
    if (this.isType3) {
      const fm = r(dict.get('FontMatrix'));
      this.widthScale = Array.isArray(fm) ? num(r(fm[0]), 0.001) : 0.001;
    }
    this.codeMap = null;
  }

  glyphName(code) {
    if (this.differences.has(code)) return this.differences.get(code);
    return this.baseEncoding ? this.baseEncoding[code] : undefined;
  }

  // ---- composite fonts (Type0 / CIDFont) ------------------------------------------

  #initType0() {
    const doc = this.doc;
    const r = (v) => doc.resolve(v);
    const enc = r(this.dict.get('Encoding'));
    if (enc instanceof PDFName) {
      this.cmap = predefinedCMap(enc.name);
      if (!this.cmap) {
        this.warnings.push(`Predefined CMap ${enc.name} not bundled; assuming 2-byte identity`);
        this.cmap = CMap.identity();
      }
    } else if (enc instanceof PDFStream) {
      this.cmap = parseCMap(doc.decodeStream(enc), predefinedCMap);
    } else {
      this.cmap = CMap.identity();
    }
    this.vertical = this.cmap.vertical;

    const desc = r((r(this.dict.get('DescendantFonts')) || [])[0]);
    this.cidFont = desc instanceof PDFDict ? desc : new PDFDict();
    const descriptor = r(this.cidFont.get('FontDescriptor'));
    this.descriptor = descriptor instanceof PDFDict ? descriptor : null;
    this.embedded = !!(this.descriptor && (this.descriptor.get('FontFile') || this.descriptor.get('FontFile2') || this.descriptor.get('FontFile3')));
    this.dw = num(r(this.cidFont.get('DW')), 1000);
    this.cidWidths = new Map();
    const W = r(this.cidFont.get('W'));
    if (Array.isArray(W)) {
      for (let i = 0; i < W.length; ) {
        const first = num(r(W[i]));
        const next = r(W[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((w, k) => this.cidWidths.set(first + k, num(r(w))));
          i += 2;
        } else {
          const last = num(next);
          const w = num(r(W[i + 2]));
          if (last - first < 0x10000) for (let c = first; c <= last; c++) this.cidWidths.set(c, w);
          i += 3;
        }
      }
    }
    this.widthScale = 0.001;
  }

  // ---- decoding -------------------------------------------------------------------

  /**
   * Splits a shown string into glyphs.
   * @param {Buffer} bytes
   * @returns {Glyph[]}
   */
  decode(bytes) {
    if (this.isType0) {
      return this.cmap.readCodes(bytes).map(({ code, len }) => this.#glyph(code, len));
    }
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = this.#glyph(bytes[i], 1);
    return out;
  }

  #glyph(code, len) {
    return {
      code,
      len,
      unicode: this.unicodeOf(code),
      width: this.widthOf(code),
      isSpace: len === 1 && code === 32,
    };
  }

  unicodeOf(code) {
    if (this.toUnicode) {
      const u = this.toUnicode.unicode.get(code);
      if (u !== undefined) return u;
    }
    if (!this.isType0) {
      // The Symbol font's built-in encoding (when no explicit encoding overrides it).
      if (this.usesSymbolEncoding && !this.differences.has(code)) {
        const u = symbolUnicode(code);
        if (u !== undefined) return u;
      }
      const name = this.glyphName(code);
      const u = glyphNameToUnicode(name);
      if (u !== undefined) return u;
      if (this.symbolic && code >= 32 && code < 127) return String.fromCharCode(code);
    }
    return '�';
  }

  /** Advance width in text space units for font size 1. */
  widthOf(code) {
    if (this.isType0) {
      const cid = this.cmap.lookupCID(code);
      const w = this.cidWidths.get(cid);
      return (w === undefined ? this.dw : w) * this.widthScale;
    }
    if (this.widths) {
      const i = code - this.firstChar;
      if (i >= 0 && i < this.widths.length) return this.widths[i] * this.widthScale;
      return this.missingWidth * this.widthScale;
    }
    if (this.standardName) {
      const u = this.unicodeOf(code);
      const w = standardWidth(this.standardName, u);
      if (w !== undefined) return w * this.widthScale;
    }
    return (this.missingWidth || 500) * this.widthScale;
  }

  // ---- encoding (text -> codes) -------------------------------------------------------

  /** Whether a glyph for `code` is actually present/usable in this font. */
  isAvailable(code) {
    if (this.isType3) {
      // A Type3 glyph exists only if its procedure is in /CharProcs.
      this.charProcs ??= this.doc.resolve(this.dict.get('CharProcs')) || null;
      const name = this.glyphName(code);
      return !!(name && this.charProcs && this.charProcs.has(name)) && this.widthOf(code) > 0;
    }
    if (this.isType0) {
      if (this.toUnicode) return this.toUnicode.unicode.has(code);
      return this.cidWidths.has(this.cmap.lookupCID(code));
    }
    if (this.embedded) {
      if (this.widths) {
        const i = code - this.firstChar;
        if (i < 0 || i >= this.widths.length || this.widths[i] === 0) return false;
      }
      if (this.isSubset && this.toUnicode && !this.toUnicode.unicode.has(code)) return false;
      return true;
    }
    return this.glyphName(code) !== undefined || !!this.toUnicode?.unicode.has(code);
  }

  /** Lazily built map: unicode string -> best code. */
  #reverseMap() {
    if (this.codeMap) return this.codeMap;
    const map = new Map();
    const consider = (code, unicode) => {
      if (!unicode || unicode === '�' || !this.isAvailable(code)) return;
      const prev = map.get(unicode);
      // Prefer a code with a real width, then the lowest code.
      if (prev === undefined || (this.widthOf(prev) === 0 && this.widthOf(code) > 0)) map.set(unicode, code);
    };
    if (this.toUnicode) for (const [code, u] of this.toUnicode.unicode) consider(code, u);
    if (!this.isType0) for (let code = 0; code < 256; code++) consider(code, this.unicodeOf(code));
    // Treat NBSP and space as interchangeable.
    if (!map.has(' ') && map.has(' ')) map.set(' ', map.get(' '));
    this.codeMap = map;
    return map;
  }

  /**
   * Encodes text into this font's codes.
   * @param {string} text
   * @returns {{ glyphs: Glyph[], missing: string[] }}
   */
  encode(text) {
    const map = this.#reverseMap();
    const glyphs = [];
    const missing = [];
    const chars = [...text];
    for (let i = 0; i < chars.length; ) {
      let found = false;
      // Single characters first, then ligature glyphs (up to 3 chars).
      for (const n of [1, 2, 3]) {
        if (i + n > chars.length) break;
        const s = chars.slice(i, i + n).join('');
        const code = map.get(s);
        if (code !== undefined) {
          const len = this.isType0 ? this.cmap.codeLength(code) : 1;
          glyphs.push({ code, len, unicode: s, width: this.widthOf(code), isSpace: len === 1 && code === 32 });
          i += n;
          found = true;
          break;
        }
      }
      if (!found) {
        missing.push(chars[i]);
        glyphs.push({ code: -1, len: 0, unicode: chars[i], width: 0, isSpace: false });
        i++;
      }
    }
    return { glyphs, missing };
  }

  /** Serializes codes to the byte string for Tj/TJ. */
  static codesToBytes(glyphs) {
    const bytes = [];
    for (const g of glyphs) {
      if (g.code < 0) continue;
      for (let k = g.len - 1; k >= 0; k--) bytes.push((g.code >> (8 * k)) & 0xff);
    }
    return Buffer.from(bytes);
  }

  /**
   * Widths (1/1000 em) of glyphs that stand for a single character, used to
   * identify the real font behind nameless or unresolvable fonts.
   * @returns {Map<string, number>} char -> width
   */
  sampleWidths() {
    const out = new Map();
    const add = (code, u) => {
      if (!u || [...u].length !== 1 || /\s/.test(u) || u === '\ufffd' || u === '\u0000') return;
      if (!this.isAvailable(code)) return;
      const w = this.widthOf(code) * 1000;
      if (w > 0 && !out.has(u)) out.set(u, w);
    };
    if (this.toUnicode) for (const [code, u] of this.toUnicode.unicode) add(code, u);
    if (!this.isType0) for (let c = 0; c < 256; c++) add(c, this.unicodeOf(c));
    return out;
  }

  /** Average width of a space for synthesizing word gaps (text space, size 1). */
  get spaceWidth() {
    const map = this.#reverseMap();
    const code = map.get(' ');
    if (code !== undefined) {
      const w = this.widthOf(code);
      if (w > 0) return w;
    }
    return 0.25;
  }
}

/** Names are stored byte-exact; font names are usually ASCII but may be UTF-8. */
function decodeName(name) {
  if (/^[\x00-\x7f]*$/.test(name)) return name;
  const u = Buffer.from(name, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? name : u;
}

/** Per-document font cache. */
const caches = new WeakMap();

/**
 * @param {import('../core/document.js').PDFDocument} doc
 * @param {any} fontRefOrDict
 */
export function loadFont(doc, fontRefOrDict) {
  let cache = caches.get(doc);
  if (!cache) caches.set(doc, (cache = new Map()));
  if (fontRefOrDict instanceof PDFRef && doc.embeddedFonts?.has(fontRefOrDict.num)) {
    return doc.embeddedFonts.get(fontRefOrDict.num);
  }
  const dict = doc.resolve(fontRefOrDict);
  if (!(dict instanceof PDFDict)) return null;
  const key = fontRefOrDict instanceof PDFRef ? fontRefOrDict.key : dict;
  let f = cache.get(key);
  if (!f) {
    f = new PDFFont(doc, dict, fontRefOrDict instanceof PDFRef ? fontRefOrDict : null);
    cache.set(key, f);
  }
  return f;
}
