// Embeds a TrueType/OpenType font as a Type0 (Identity-H) font, subset to the
// glyphs actually used. Glyph ids are kept, so CID = GID.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { PDFDict, PDFStream, PDFString, N } from '../core/objects.js';
import { TrueTypeFont } from './truetype.js';
import { CFFFont } from './cff.js';
import { Shaper, isDevanagari } from './shaper.js';

/** Writes a ToUnicode CMap for 2-byte codes. */
export function buildToUnicodeCMap(map) {
  const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();
  const utf16Hex = (s) => {
    let h = '';
    for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i));
    return h;
  };
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [code, uni] of chunk) body += `<${hex4(code)}> <${utf16Hex(uni)}>\n`;
    body += 'endbfchar\n';
  }
  return Buffer.from(
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      body +
      'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n',
    'latin1',
  );
}

function subsetTag(seed) {
  const h = crypto.createHash('md5').update(seed).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += String.fromCharCode(65 + (h[i] % 26));
  return s;
}

export class EmbeddedFont {
  /**
   * @param {import('../core/document.js').PDFDocument} doc
   * @param {string} file path to .ttf/.otf/.ttc
   * @param {number} [index] font index inside a collection
   */
  constructor(doc, file, index = 0, { register = true } = {}) {
    this.doc = doc;
    this.file = file;
    this.ttf = new TrueTypeFont(fs.readFileSync(file), index);
    this.used = new Map(); // gid -> unicode
    this.isType0 = true;
    this.vertical = false;
    this.baseFont = this.ttf.postScriptName;
    if (this.ttf.isCFF && !this.ttf.table('CFF ')) throw new Error(`${this.baseFont}: CFF2 (variable OpenType) fonts are not supported`);
    if (!this.ttf.table('glyf') && !this.ttf.table('CFF ')) throw new Error(`${this.baseFont}: no glyph outlines (bitmap/SVG-only font)`);
    this.warnings = [];
    if (!this.ttf.embeddingAllowed) {
      this.warnings.push(`Font ${this.baseFont} has a restricted-license embedding flag (OS/2 fsType).`);
    }
    if (register) this.register();
  }

  /**
   * Registers the PDF objects (references stay stable); their contents are
   * filled in by finalize() right before saving.
   */
  register() {
    if (this.ref) return;
    const doc = this.doc;
    this.descriptor = new PDFDict();
    this.cidFont = new PDFDict();
    this.fontDict = new PDFDict();
    this.fontFile = new PDFStream(new PDFDict(), Buffer.alloc(0));
    this.toUnicodeStream = new PDFStream(new PDFDict(), Buffer.alloc(0));
    this.ref = doc.register(this.fontDict);
    this.cidRef = doc.register(this.cidFont);
    this.descriptorRef = doc.register(this.descriptor);
    this.fontFileRef = doc.register(this.fontFile);
    this.toUnicodeRef = doc.register(this.toUnicodeStream);
    doc.addSaveHook(() => this.finalize());
    // Until saved, the font dictionaries are empty: content that uses this font
    // is interpreted through this object instead (see loadFont).
    doc.embeddedFonts ??= new Map();
    doc.embeddedFonts.set(this.ref.num, this);
  }

  // ---- font-model interface used by the interpreter / editor ------------------------

  get subtype() { return 'Type0'; }
  get legacy() { return null; }
  get isType3() { return false; }
  get embedded() { return true; }
  get isSubset() { return true; }
  get toUnicode() { return null; }

  /** Splits 2-byte Identity-H codes into glyphs. */
  decode(bytes) {
    const out = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const gid = (bytes[i] << 8) | bytes[i + 1];
      out.push({ code: gid, len: 2, unicode: this.used.get(gid) ?? '\ufffd', width: this.widthOf(gid), isSpace: false });
    }
    return out;
  }

  widthOf(gid) {
    return this.ttf.advance1000(gid) / 1000;
  }

  unicodeOf(gid) {
    return this.used.get(gid) ?? '\ufffd';
  }

  isAvailable(gid) {
    return gid > 0 && gid < this.ttf.numGlyphs;
  }

  sampleWidths() {
    return new Map();
  }

  /** Whether every (non-space) character of `text` exists in this font. */
  supports(text) {
    return [...text].every((ch) => /[\s\u200c\u200d]/.test(ch) || this.ttf.glyphForCodePoint(ch.codePointAt(0)) !== 0);
  }

  get shaper() {
    if (this._shaper === undefined) {
      try {
        this._shaper = new Shaper(this.ttf);
      } catch {
        this._shaper = null;
      }
    }
    return this._shaper;
  }

  /** Whether this font carries OpenType layout for Devanagari. */
  get canShapeDevanagari() {
    return !!this.shaper?.hasIndicLayout && this.ttf.glyphForCodePoint(0x0915) !== 0;
  }

  /**
   * Shapes text (complex scripts) into positioned glyphs.
   * Glyph extras (em units): dx = advance change from GPOS, xOff / yOff = placement.
   * The whole run should be tagged with ActualText, because visual glyph
   * order differs from the logical text order.
   */
  shape(text) {
    const upm = this.ttf.unitsPerEm;
    const shaped = this.shaper.shape(text);
    const missing = [...text].filter((ch) => !/[\s\u200c\u200d]/.test(ch) && !this.ttf.glyphForCodePoint(ch.codePointAt(0)));
    // Reverse cmap: glyphs that directly represent one character map to it in ToUnicode.
    if (!this.reverseCmap) {
      this.reverseCmap = new Map();
      for (const [cp, gid] of this.ttf.cmap) if (!this.reverseCmap.has(gid)) this.reverseCmap.set(gid, String.fromCodePoint(cp));
    }
    const perCluster = new Map();
    for (const g of shaped) perCluster.set(g.cluster, (perCluster.get(g.cluster) || 0) + 1);
    // Map UTF-16 cluster offsets to the text each cluster covers.
    const starts = [...new Set(shaped.map((g) => g.cluster))].sort((a, b) => a - b);
    const clusterText = new Map();
    starts.forEach((c, i) => clusterText.set(c, text.slice(c, i + 1 < starts.length ? starts[i + 1] : text.length)));
    const seen = new Set();
    const glyphs = shaped.map((g) => {
      const first = !seen.has(g.cluster);
      seen.add(g.cluster);
      const unicode = first ? clusterText.get(g.cluster) : '';
      if (!this.used.has(g.gid) && g.gid) {
        // Ligatures/conjuncts only get the cluster text when they alone form the cluster.
        // The glyph's own text (ligatures carry their components) first, then the
        // character it directly represents, then the whole cluster if it is alone.
        const direct = this.reverseCmap.get(g.gid);
        this.used.set(g.gid, g.text || direct || (perCluster.get(g.cluster) === 1 ? clusterText.get(g.cluster) : ''));
      }
      const hm = this.ttf.advances[g.gid] || 0;
      return {
        code: g.gid, len: 2, unicode, isSpace: false,
        width: this.ttf.advance1000(g.gid) / 1000,
        dx: (g.xAdvance - hm) / upm,
        xOff: g.xOffset / upm,
        yOff: g.yOffset / upm,
      };
    });
    return { glyphs, missing, actualText: text };
  }

  /**
   * Encodes text as 2-byte glyph ids.
   * @returns {{ glyphs: Array<{code:number,len:number,unicode:string,width:number,isSpace:boolean}>, missing: string[] }}
   */
  encode(text) {
    if (isDevanagari(text) && this.canShapeDevanagari) return this.shape(text);
    const glyphs = [];
    const missing = [];
    for (const ch of text) {
      const gid = this.ttf.glyphForCodePoint(ch.codePointAt(0));
      if (!gid) {
        missing.push(ch);
        glyphs.push({ code: -1, len: 0, unicode: ch, width: 0, isSpace: false });
        continue;
      }
      if (!this.used.has(gid)) this.used.set(gid, ch);
      glyphs.push({ code: gid, len: 2, unicode: ch, width: this.ttf.advance1000(gid) / 1000, isSpace: false });
    }
    return { glyphs, missing };
  }

  get spaceWidth() {
    const gid = this.ttf.glyphForCodePoint(32);
    return gid ? this.ttf.advance1000(gid) / 1000 : 0.25;
  }

  finalize() {
    const doc = this.doc;
    const ttf = this.ttf;
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const name = `${subsetTag(this.baseFont + gids.join(','))}+${this.baseFont}`;
    const scale = (v) => Math.round((v * 1000) / ttf.unitsPerEm);

    // Font program
    let program;
    let cidSubtype;
    this.fontFile.dict = new PDFDict();
    if (ttf.isCFF || !ttf.table('glyf')) {
      // CFF outlines: subset into a CID-keyed CFF where CID == GID.
      if (!ttf.table('CFF ')) throw new Error(`${this.baseFont}: CFF2 (variable OpenType) fonts are not supported`);
      program = new CFFFont(ttf.table('CFF ')).subset(new Set(gids));
      this.fontFile.dict.set('Subtype', N('CIDFontType0C'));
      cidSubtype = 'CIDFontType0';
    } else {
      program = ttf.subset(gids);
      this.fontFile.dict.set('Length1', program.length);
      cidSubtype = 'CIDFontType2';
    }
    doc.setStreamData(this.fontFile, program);

    // Descriptor
    const d = this.descriptor;
    d.set('Type', N('FontDescriptor'));
    d.set('FontName', N(name));
    d.set('Flags', ttf.flags);
    d.set('FontBBox', ttf.bbox.map(scale));
    d.set('ItalicAngle', ttf.italicAngle);
    d.set('Ascent', scale(ttf.typoAscender ?? ttf.ascent));
    d.set('Descent', scale(ttf.typoDescender ?? ttf.descent));
    d.set('CapHeight', scale(ttf.capHeight));
    d.set('StemV', Math.round(10 + 220 * Math.max(0, (ttf.weightClass - 50) / 900) ** 2));
    d.set(cidSubtype === 'CIDFontType2' ? 'FontFile2' : 'FontFile3', this.fontFileRef);

    // CIDFont with widths
    const W = [];
    for (let i = 0; i < gids.length; ) {
      const start = gids[i];
      const ws = [ttf.advance1000(start)];
      let j = i + 1;
      while (j < gids.length && gids[j] === gids[j - 1] + 1) ws.push(ttf.advance1000(gids[j++]));
      W.push(start, ws);
      i = j;
    }
    const c = this.cidFont;
    c.set('Type', N('Font'));
    c.set('Subtype', N(cidSubtype));
    c.set('BaseFont', N(name));
    c.set('CIDSystemInfo', new PDFDict().set('Registry', new PDFString(Buffer.from('Adobe'))).set('Ordering', new PDFString(Buffer.from('Identity'))).set('Supplement', 0));
    c.set('FontDescriptor', this.descriptorRef);
    c.set('DW', 1000);
    c.set('W', W);
    if (cidSubtype === 'CIDFontType2') c.set('CIDToGIDMap', N('Identity'));

    doc.setStreamData(this.toUnicodeStream, buildToUnicodeCMap(this.used));

    const f = this.fontDict;
    f.set('Type', N('Font'));
    f.set('Subtype', N('Type0'));
    f.set('BaseFont', N(name));
    f.set('Encoding', N('Identity-H'));
    f.set('DescendantFonts', [this.cidRef]);
    f.set('ToUnicode', this.toUnicodeRef);

    for (const [ref, v] of [[this.ref, f], [this.cidRef, c], [this.descriptorRef, d], [this.fontFileRef, this.fontFile], [this.toUnicodeRef, this.toUnicodeStream]]) {
      doc.update(ref, v);
    }
  }
}
