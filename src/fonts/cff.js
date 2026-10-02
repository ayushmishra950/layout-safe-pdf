// CFF (Compact Font Format, Adobe TN #5176) reader and "keep glyph ids"
// subsetter. The output is always a CID-keyed CFF with an identity charset,
// so that CID == GID — exactly what a PDF Type0 /Identity-H font needs
// (FontFile3 /CIDFontType0C).

const STANDARD_STRINGS = 391;

// ---- INDEX ------------------------------------------------------------------------------

function readIndex(b, p) {
  const count = b.readUInt16BE(p);
  if (count === 0) return { items: [], end: p + 2 };
  const offSize = b[p + 2];
  const off = (k) => {
    let v = 0;
    for (let j = 0; j < offSize; j++) v = v * 256 + b[p + 3 + k * offSize + j];
    return v;
  };
  const base = p + 2 + (count + 1) * offSize;
  const items = [];
  for (let k = 0; k < count; k++) items.push(b.subarray(base + off(k), base + off(k + 1)));
  return { items, end: base + off(count) };
}

function writeIndex(items) {
  if (!items.length) return Buffer.from([0, 0]);
  const total = items.reduce((s, x) => s + x.length, 0) + 1;
  const offSize = total < 0x100 ? 1 : total < 0x10000 ? 2 : total < 0x1000000 ? 3 : 4;
  const head = Buffer.alloc(3 + (items.length + 1) * offSize);
  head.writeUInt16BE(items.length, 0);
  head[2] = offSize;
  let o = 1;
  const put = (k, v) => {
    for (let j = offSize - 1; j >= 0; j--) {
      head[3 + k * offSize + j] = v & 0xff;
      v = Math.floor(v / 256);
    }
  };
  items.forEach((it, k) => {
    put(k, o);
    o += it.length;
  });
  put(items.length, o);
  return Buffer.concat([head, ...items]);
}

// ---- DICT -------------------------------------------------------------------------------

/** Parses a DICT into [{ op, operands, raw }] keeping the original operand bytes. */
function readDict(b) {
  const entries = [];
  let operands = [];
  let rawStart = 0;
  let p = 0;
  while (p < b.length) {
    const b0 = b[p];
    if (b0 <= 21) {
      let op = b0;
      let len = 1;
      if (b0 === 12) {
        op = 1200 + b[p + 1];
        len = 2;
      }
      entries.push({ op, operands, raw: b.subarray(rawStart, p) });
      p += len;
      operands = [];
      rawStart = p;
      continue;
    }
    if (b0 >= 32 && b0 <= 246) { operands.push(b0 - 139); p += 1; }
    else if (b0 >= 247 && b0 <= 250) { operands.push((b0 - 247) * 256 + b[p + 1] + 108); p += 2; }
    else if (b0 >= 251 && b0 <= 254) { operands.push(-(b0 - 251) * 256 - b[p + 1] - 108); p += 2; }
    else if (b0 === 28) { operands.push(b.readInt16BE(p + 1)); p += 3; }
    else if (b0 === 29) { operands.push(b.readInt32BE(p + 1)); p += 5; }
    else if (b0 === 30) {
      // Real number: nibbles until 0xf.
      let s = '';
      p++;
      const map = '0123456789.EE?-';
      for (let done = false; !done; p++) {
        for (const nib of [b[p] >> 4, b[p] & 0xf]) {
          if (nib === 0xf) { done = true; break; }
          s += nib === 0xc ? 'E-' : map[nib];
        }
      }
      operands.push(parseFloat(s) || 0);
    } else p++; // reserved
  }
  return entries;
}

const int5 = (v) => {
  const b = Buffer.alloc(5);
  b[0] = 29;
  b.writeInt32BE(v, 1);
  return b;
};

const opBytes = (op) => (op >= 1200 ? Buffer.from([12, op - 1200]) : Buffer.from([op]));

/** Serializes entries; values in `override` (op -> number[]) are written as 5-byte ints. */
function writeDict(entries, override = new Map(), prepend = []) {
  const parts = [];
  for (const [op, vals] of prepend) {
    for (const v of vals) parts.push(int5(v));
    parts.push(opBytes(op));
  }
  for (const e of entries) {
    if (override.has(e.op)) {
      const vals = override.get(e.op);
      if (vals === null) continue; // drop
      for (const v of vals) parts.push(int5(v));
    } else parts.push(e.raw);
    parts.push(opBytes(e.op));
  }
  // Overrides for operators that were not present.
  for (const [op, vals] of override) {
    if (vals === null || entries.some((e) => e.op === op)) continue;
    for (const v of vals) parts.push(int5(v));
    parts.push(opBytes(op));
  }
  return Buffer.concat(parts);
}

const get = (entries, op) => entries.find((e) => e.op === op)?.operands;

// ---- reading ------------------------------------------------------------------------------

export class CFFFont {
  /** @param {Buffer} b raw CFF table */
  constructor(b) {
    this.b = b;
    this.major = b[0];
    this.minor = b[1];
    const hdrSize = b[2];
    const names = readIndex(b, hdrSize);
    const tops = readIndex(b, names.end);
    const strings = readIndex(b, tops.end);
    const gsubrs = readIndex(b, strings.end);
    this.name = names.items[0];
    this.strings = strings.items;
    this.gsubrsRaw = b.subarray(strings.end, gsubrs.end);
    this.top = readDict(tops.items[0]);
    this.isCID = !!get(this.top, 1230);
    const cs = get(this.top, 17);
    this.charStrings = readIndex(b, cs[0]).items;
    this.numGlyphs = this.charStrings.length;

    const readPrivate = (sizeOff) => {
      if (!sizeOff) return { dict: [], subrsRaw: null };
      const [size, off] = sizeOff;
      const dict = readDict(b.subarray(off, off + size));
      const subrs = get(dict, 19);
      let subrsRaw = null;
      if (subrs) {
        const start = off + subrs[0];
        subrsRaw = b.subarray(start, readIndex(b, start).end);
      }
      return { dict, subrsRaw };
    };

    if (this.isCID) {
      const fdArray = readIndex(b, get(this.top, 1236)[0]).items.map(readDict);
      this.fds = fdArray.map((fd) => ({ dict: fd, priv: readPrivate(get(fd, 18)) }));
      const fdsOff = get(this.top, 1237)[0];
      this.fdSelectRaw = this.#fdSelectBytes(fdsOff);
    } else {
      this.priv = readPrivate(get(this.top, 18));
    }
  }

  #fdSelectBytes(off) {
    const b = this.b;
    const format = b[off];
    if (format === 0) return b.subarray(off, off + 1 + this.numGlyphs);
    const n = b.readUInt16BE(off + 1);
    return b.subarray(off, off + 3 + n * 3 + 2);
  }

  /**
   * Builds a CID-keyed CFF keeping glyph ids; unused glyphs become empty.
   * @param {Set<number>} keep glyph ids to keep (0 is always kept)
   */
  subset(keep) {
    const strings = [...this.strings, Buffer.from('Adobe'), Buffer.from('Identity')];
    const sidAdobe = STANDARD_STRINGS + strings.length - 2;
    const sidIdentity = sidAdobe + 1;
    const n = this.numGlyphs;
    const endchar = Buffer.from([14]);
    const charStrings = this.charStrings.map((c, gid) => (gid === 0 || keep.has(gid) ? c : endchar));

    // Identity charset (format 2: one range covering CIDs 1..n-1).
    const charset = Buffer.alloc(n > 1 ? 5 : 1);
    charset[0] = 2;
    if (n > 1) {
      charset.writeUInt16BE(1, 1);
      charset.writeUInt16BE(n - 2, 3);
    }
    let fdSelect;
    let fds;
    if (this.isCID) {
      fdSelect = this.fdSelectRaw;
      fds = this.fds;
    } else {
      fdSelect = Buffer.alloc(8);
      fdSelect[0] = 3;
      fdSelect.writeUInt16BE(1, 1);
      fdSelect.writeUInt16BE(0, 3);
      fdSelect[5] = 0;
      fdSelect.writeUInt16BE(n, 6);
      fds = [{ dict: [], priv: this.priv }];
    }

    const header = Buffer.from([this.major, this.minor, 4, 4]);
    const nameIndex = writeIndex([this.name]);
    const stringIndex = writeIndex(strings);
    const gsubrs = this.gsubrsRaw;
    const charStringsIndex = writeIndex(charStrings);

    // Private dicts (each followed by its local subrs).
    const privBlocks = fds.map(({ priv }) => {
      const hasSubrs = !!priv.subrsRaw;
      // Subrs offset is relative to the private dict start = private dict size.
      let dict = writeDict(priv.dict, new Map([[19, hasSubrs ? [0] : null]]));
      if (hasSubrs) dict = writeDict(priv.dict, new Map([[19, [dict.length]]]));
      return { dict, subrs: priv.subrsRaw || Buffer.alloc(0) };
    });

    const topOverride = (offs) => new Map([
      [15, [offs.charset]],
      [16, null],
      [17, [offs.charStrings]],
      [18, null],
      [1230, null],
      [1234, [n]],
      [1236, [offs.fdArray]],
      [1237, [offs.fdSelect]],
    ]);
    const ros = [[1230, [sidAdobe, sidIdentity, 0]]];
    const buildTop = (offs) => writeIndex([writeDict(this.top, topOverride(offs), ros)]);
    const buildFdArray = (privOffsets) => writeIndex(fds.map(({ dict }, i) =>
      writeDict(dict, new Map([[18, [privBlocks[i].dict.length, privOffsets[i]]]])),
    ));

    // Sizes are stable (5-byte ints), so compute layout with placeholders first.
    const zero = { charset: 0, charStrings: 0, fdArray: 0, fdSelect: 0 };
    const topLen = buildTop(zero).length;
    const fdArrayLen = buildFdArray(fds.map(() => 0)).length;
    let pos = header.length + nameIndex.length + topLen + stringIndex.length + gsubrs.length;
    const offs = {};
    offs.charset = pos; pos += charset.length;
    offs.fdSelect = pos; pos += fdSelect.length;
    offs.charStrings = pos; pos += charStringsIndex.length;
    offs.fdArray = pos; pos += fdArrayLen;
    const privOffsets = [];
    for (const blk of privBlocks) {
      privOffsets.push(pos);
      pos += blk.dict.length + blk.subrs.length;
    }
    return Buffer.concat([
      header, nameIndex, buildTop(offs), stringIndex, gsubrs, charset, fdSelect, charStringsIndex,
      buildFdArray(privOffsets), ...privBlocks.flatMap((blk) => [blk.dict, blk.subrs]),
    ]);
  }
}
