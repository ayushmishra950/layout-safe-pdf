// TrueType / OpenType (sfnt) parser and glyf-based subsetter.
// Reference: Apple TrueType Reference Manual, Microsoft OpenType spec.

const tag = (buf, off) => buf.toString('latin1', off, off + 4);

export class TrueTypeFont {
  /**
   * @param {Buffer} buf whole file (may be a .ttc collection)
   * @param {number} [fontIndex] font index inside a collection
   */
  constructor(buf, fontIndex = 0) {
    this.file = buf;
    let base = 0;
    if (tag(buf, 0) === 'ttcf') {
      const numFonts = buf.readUInt32BE(8);
      if (fontIndex >= numFonts) throw new Error('Font index out of range');
      base = buf.readUInt32BE(12 + 4 * fontIndex);
    }
    this.sfntVersion = buf.readUInt32BE(base);
    this.isCFF = tag(buf, base) === 'OTTO';
    const numTables = buf.readUInt16BE(base + 4);
    /** @type {Map<string, {offset:number, length:number}>} */
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      this.tables.set(tag(buf, rec), { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
    }
    this.#parseHead();
    this.#parseHhea();
    this.numGlyphs = this.table('maxp') ? this.table('maxp').readUInt16BE(4) : 0;
    this.#parseHmtx();
    this.#parseName();
    this.#parseOS2();
    this.#parsePost();
    this.#parseCmap();
  }

  /** Number of fonts in a file (1 for plain .ttf/.otf). */
  static count(buf) {
    return tag(buf, 0) === 'ttcf' ? buf.readUInt32BE(8) : 1;
  }

  table(name) {
    const t = this.tables.get(name);
    return t ? this.file.subarray(t.offset, t.offset + t.length) : null;
  }

  #parseHead() {
    const h = this.table('head');
    if (!h) throw new Error('Missing head table');
    this.unitsPerEm = h.readUInt16BE(18) || 1000;
    this.bbox = [h.readInt16BE(36), h.readInt16BE(38), h.readInt16BE(40), h.readInt16BE(42)];
    this.macStyle = h.readUInt16BE(44);
    this.indexToLocFormat = h.readInt16BE(50);
  }

  #parseHhea() {
    const h = this.table('hhea');
    this.ascent = h ? h.readInt16BE(4) : this.bbox[3];
    this.descent = h ? h.readInt16BE(6) : this.bbox[1];
    this.numberOfHMetrics = h ? h.readUInt16BE(34) : 0;
  }

  #parseHmtx() {
    const h = this.table('hmtx');
    this.advances = new Uint16Array(this.numGlyphs);
    if (!h || !this.numberOfHMetrics) return;
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      if (g < this.numberOfHMetrics) last = h.readUInt16BE(g * 4);
      this.advances[g] = last;
    }
  }

  #parseName() {
    const n = this.table('name');
    this.names = {};
    let thisRank;
    if (!n) return;
    const count = n.readUInt16BE(2);
    const strOff = n.readUInt16BE(4);
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = n.readUInt16BE(r);
      const nameId = n.readUInt16BE(r + 6);
      const len = n.readUInt16BE(r + 8);
      const off = n.readUInt16BE(r + 10);
      const raw = n.subarray(strOff + off, strOff + off + len);
      let s;
      if (platform === 3 || platform === 0) {
        s = '';
        for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
      } else if (platform === 1) {
        s = raw.toString('latin1');
      } else continue;
      // Prefer Windows/Unicode entries, which come later in the sorted table.
      // Prefer English: Windows en-US (0x409), then Mac English (0), then anything.
      const lang = n.readUInt16BE(r + 4);
      const rank = platform === 3 && lang === 0x409 ? 3 : platform === 1 && lang === 0 ? 2 : platform === 3 ? 1 : 0;
      thisRank ??= {};
      if (!this.names[nameId] || rank > (thisRank[nameId] ?? -1)) {
        this.names[nameId] = s;
        thisRank[nameId] = rank;
      }
    }
    this.postScriptName = (this.names[6] || this.names[4] || 'Font').replace(/[^\x21-\x7e]/g, '').replace(/[[\](){}<>/%]/g, '');
    this.familyName = this.names[16] || this.names[1] || '';
    this.subfamilyName = this.names[17] || this.names[2] || '';
    this.fullName = this.names[4] || '';
  }

  #parseOS2() {
    const o = this.table('OS/2');
    this.weightClass = 400;
    this.fsType = 0;
    this.capHeight = Math.round(this.ascent * 0.7);
    this.xHeight = Math.round(this.ascent * 0.5);
    if (!o) return;
    const version = o.readUInt16BE(0);
    this.weightClass = o.readUInt16BE(4);
    this.fsType = o.readUInt16BE(8);
    if (o.length >= 72) {
      this.typoAscender = o.readInt16BE(68);
      this.typoDescender = o.readInt16BE(70);
    }
    if (version >= 2 && o.length >= 90) {
      this.xHeight = o.readInt16BE(86);
      this.capHeight = o.readInt16BE(88);
    }
  }

  #parsePost() {
    const p = this.table('post');
    this.italicAngle = p ? p.readInt32BE(4) / 65536 : 0;
    this.isFixedPitch = p ? p.readUInt32BE(12) !== 0 : false;
  }

  #parseCmap() {
    /** @type {Map<number, number>} codepoint -> glyph id */
    this.cmap = new Map();
    const c = this.table('cmap');
    if (!c) return;
    const n = c.readUInt16BE(2);
    const subtables = [];
    for (let i = 0; i < n; i++) {
      const r = 4 + i * 8;
      subtables.push({ platform: c.readUInt16BE(r), encoding: c.readUInt16BE(r + 2), offset: c.readUInt32BE(r + 4) });
    }
    const score = (s) => {
      const fmt = c.readUInt16BE(s.offset);
      if (s.platform === 3 && s.encoding === 10 && fmt === 12) return 5;
      if (s.platform === 0 && fmt === 12) return 4;
      if (s.platform === 3 && s.encoding === 1 && fmt === 4) return 3;
      if (s.platform === 0 && fmt === 4) return 2;
      if (s.platform === 3 && s.encoding === 0) return 1; // symbol
      return 0;
    };
    subtables.sort((a, b) => score(b) - score(a));
    const best = subtables.find((s) => score(s) > 0);
    if (!best) return;
    this.symbolCmap = best.platform === 3 && best.encoding === 0;
    const t = c.subarray(best.offset);
    const fmt = t.readUInt16BE(0);
    if (fmt === 4) {
      const segX2 = t.readUInt16BE(6);
      const seg = segX2 / 2;
      const endO = 14, startO = 16 + segX2, deltaO = 16 + 2 * segX2, rangeO = 16 + 3 * segX2;
      for (let s = 0; s < seg; s++) {
        const end = t.readUInt16BE(endO + s * 2);
        const start = t.readUInt16BE(startO + s * 2);
        const delta = t.readInt16BE(deltaO + s * 2);
        const range = t.readUInt16BE(rangeO + s * 2);
        if (start === 0xffff) continue;
        for (let cp = start; cp <= end; cp++) {
          let gid;
          if (range === 0) gid = (cp + delta) & 0xffff;
          else {
            const p = rangeO + s * 2 + range + (cp - start) * 2;
            if (p + 1 >= t.length) continue;
            gid = t.readUInt16BE(p);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          if (gid) this.cmap.set(cp, gid);
        }
      }
    } else if (fmt === 12) {
      const groups = t.readUInt32BE(12);
      for (let g = 0; g < groups; g++) {
        const r = 16 + g * 12;
        const start = t.readUInt32BE(r);
        const end = t.readUInt32BE(r + 4);
        const sg = t.readUInt32BE(r + 8);
        if (end - start > 0x20000) continue;
        for (let cp = start; cp <= end; cp++) this.cmap.set(cp, sg + (cp - start));
      }
    }
  }

  /** Glyph id for a Unicode code point (0 = .notdef). */
  glyphForCodePoint(cp) {
    let gid = this.cmap.get(cp);
    if (gid === undefined && this.symbolCmap) gid = this.cmap.get(0xf000 + cp);
    return gid || 0;
  }

  /** Advance width in PDF glyph-space units (1/1000 em). */
  advance1000(gid) {
    return Math.round((this.advances[gid] * 1000) / this.unitsPerEm);
  }

  /** Embedding permission per OS/2 fsType. */
  get embeddingAllowed() {
    return (this.fsType & 0x000f) !== 0x0002; // 2 = restricted license embedding
  }

  get flags() {
    let f = 0;
    if (this.isFixedPitch) f |= 1;
    if (/serif|times|georgia|roman|garamond|book/i.test(this.familyName) && !/sans/i.test(this.familyName)) f |= 2;
    f |= 32; // nonsymbolic
    if (this.italicAngle !== 0 || this.macStyle & 2) f |= 64;
    return f;
  }

  // ---- glyf access & subsetting ------------------------------------------------------

  #glyphLocation(gid) {
    const loca = this.table('loca');
    if (!loca) return null;
    if (this.indexToLocFormat === 0) {
      return [loca.readUInt16BE(gid * 2) * 2, loca.readUInt16BE(gid * 2 + 2) * 2];
    }
    return [loca.readUInt32BE(gid * 4), loca.readUInt32BE(gid * 4 + 4)];
  }

  glyphData(gid) {
    const loc = this.#glyphLocation(gid);
    const glyf = this.table('glyf');
    if (!loc || !glyf || loc[1] <= loc[0]) return Buffer.alloc(0);
    return glyf.subarray(loc[0], loc[1]);
  }

  /** Component glyph ids of a composite glyph. */
  #components(data) {
    const out = [];
    if (data.length < 10 || data.readInt16BE(0) >= 0) return out;
    let p = 10;
    for (;;) {
      const flags = data.readUInt16BE(p);
      out.push(data.readUInt16BE(p + 2));
      p += 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) p += 2;
      else if (flags & 0x0040) p += 4;
      else if (flags & 0x0080) p += 8;
      if (!(flags & 0x0020) || p >= data.length) break;
    }
    return out;
  }

  /**
   * Builds a subset font that keeps original glyph ids (unused glyphs become
   * empty), so CIDToGIDMap can stay /Identity.
   * @param {Iterable<number>} gids
   * @returns {Buffer}
   */
  subset(gids) {
    if (this.isCFF || !this.table('glyf')) throw new Error('subset() supports TrueType (glyf) outlines only');
    const keep = new Set([0, ...gids]);
    const queue = [...keep];
    while (queue.length) {
      const g = queue.pop();
      for (const c of this.#components(this.glyphData(g))) {
        if (!keep.has(c) && c < this.numGlyphs) {
          keep.add(c);
          queue.push(c);
        }
      }
    }

    // glyf + loca (long format)
    const parts = [];
    const loca = Buffer.alloc((this.numGlyphs + 1) * 4);
    let off = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      loca.writeUInt32BE(off, g * 4);
      if (keep.has(g)) {
        const d = this.glyphData(g);
        parts.push(d);
        off += d.length;
        if (off % 4) {
          const pad = 4 - (off % 4);
          parts.push(Buffer.alloc(pad));
          off += pad;
        }
      }
    }
    loca.writeUInt32BE(off, this.numGlyphs * 4);
    const glyf = Buffer.concat(parts);

    const head = Buffer.from(this.table('head'));
    head.writeInt16BE(1, 50); // long loca
    head.writeUInt32BE(0, 8); // checksum adjustment, fixed later

    const tables = { head, loca, glyf };
    for (const name of ['hhea', 'maxp', 'hmtx', 'cvt ', 'fpgm', 'prep', 'OS/2']) {
      const t = this.table(name);
      if (t) tables[name] = Buffer.from(t);
    }
    // Minimal post table (version 3: no glyph names).
    const post = Buffer.alloc(32);
    post.writeUInt32BE(0x00030000, 0);
    const origPost = this.table('post');
    if (origPost && origPost.length >= 16) origPost.copy(post, 4, 4, 16);
    tables.post = post;
    return buildSfnt(tables);
  }
}

function checksum(buf) {
  let sum = 0;
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** Serializes tables into an sfnt file with a valid directory and checksums. */
export function buildSfnt(tables) {
  const names = Object.keys(tables).sort();
  const n = names.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(log, 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  let offset = header.length;
  const body = [];
  names.forEach((name, i) => {
    const data = tables[name];
    const r = 12 + i * 16;
    header.write(name.padEnd(4, ' '), r, 'latin1');
    header.writeUInt32BE(checksum(data), r + 4);
    header.writeUInt32BE(offset, r + 8);
    header.writeUInt32BE(data.length, r + 12);
    const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
    body.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...body]);
  // head.checkSumAdjustment
  const headIndex = names.indexOf('head');
  if (headIndex >= 0) {
    const headOffset = header.readUInt32BE(12 + headIndex * 16 + 8);
    font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  }
  return font;
}
