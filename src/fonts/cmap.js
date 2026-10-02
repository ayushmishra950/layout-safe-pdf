// CMap parsing (ISO 32000-1, section 9.7.5 and 9.10.3; Adobe TN 5014/5099).
// Used for ToUnicode maps and Type0 encoding CMaps.

import { Lexer, T_ARRAY_START, T_ARRAY_END, T_EOF } from '../core/lexer.js';
import { PDFName, PDFNumber, PDFOperator, PDFString } from '../core/objects.js';

export class CMap {
  constructor() {
    /** @type {Array<{low:number, high:number, bytes:number}>} */
    this.codespaces = [];
    /** code -> unicode string (ToUnicode) */
    this.unicode = new Map();
    /** code -> CID (encoding CMaps) */
    this.cid = new Map();
    /** Range mappings for CIDs kept compact: [low, high, cidStart, bytes] */
    this.cidRanges = [];
    this.identity = false;
    this.vertical = false;
    this.name = null;
  }

  static identity(vertical = false) {
    const c = new CMap();
    c.identity = true;
    c.vertical = vertical;
    c.codespaces.push({ low: 0, high: 0xffff, bytes: 2 });
    return c;
  }

  /**
   * Splits a byte string into codes using the codespace ranges.
   * @param {Buffer} bytes
   * @returns {Array<{code:number, len:number}>}
   */
  readCodes(bytes) {
    const out = [];
    const spaces = this.codespaces.length ? this.codespaces : [{ low: 0, high: 0xff, bytes: 1 }];
    let i = 0;
    while (i < bytes.length) {
      let matched = false;
      let code = 0;
      for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
        code = code * 256 + bytes[i + n - 1];
        for (const cs of spaces) {
          if (cs.bytes === n && code >= cs.low && code <= cs.high) {
            out.push({ code, len: n });
            i += n;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        // Not in any range: use the shortest codespace length (per spec 9.7.6.3).
        const n = Math.min(...spaces.map((s) => s.bytes));
        let c = 0;
        for (let k = 0; k < n && i + k < bytes.length; k++) c = c * 256 + bytes[i + k];
        out.push({ code: c, len: n });
        i += n;
      }
    }
    return out;
  }

  /** Byte length a code would be written with. */
  codeLength(code) {
    for (const cs of this.codespaces) if (code >= cs.low && code <= cs.high) return cs.bytes;
    return this.codespaces[0]?.bytes || 1;
  }

  lookupCID(code) {
    const direct = this.cid.get(code);
    if (direct !== undefined) return direct;
    for (const [low, high, start] of this.cidRanges) if (code >= low && code <= high) return start + (code - low);
    return this.identity ? code : 0;
  }
}

function bytesToInt(b) {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** Decodes UTF-16BE bytes from a bfchar/bfrange destination. */
function utf16(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

/** Increments the last UTF-16 code unit (bfrange semantics). */
function incrementString(bytes, delta) {
  const b = Buffer.from(bytes);
  let carry = delta;
  for (let i = b.length - 1; i >= 0 && carry; i--) {
    const v = b[i] + carry;
    b[i] = v & 0xff;
    carry = v >> 8;
  }
  return b;
}

/**
 * Parses a CMap program.
 * @param {Buffer} data
 * @param {(name:string)=>CMap|null} [loadNamed] resolves `usecmap`
 */
export function parseCMap(data, loadNamed) {
  const cmap = new CMap();
  const lx = new Lexer(data);
  const stack = [];
  const readArray = () => {
    const arr = [];
    for (;;) {
      const t = lx.next();
      if (t === T_ARRAY_END || t === T_EOF) break;
      arr.push(t);
    }
    return arr;
  };

  for (;;) {
    let tok;
    try {
      tok = lx.next();
    } catch {
      break;
    }
    if (tok === T_EOF) break;
    if (tok === T_ARRAY_START) {
      stack.push(readArray());
      continue;
    }
    if (!(tok instanceof PDFOperator)) {
      stack.push(tok);
      if (stack.length > 64) stack.shift();
      continue;
    }
    const op = tok.op;
    if (op === 'begincodespacerange') {
      for (;;) {
        const a = lx.next();
        if (!(a instanceof PDFString)) break;
        const b = lx.next();
        cmap.codespaces.push({ low: bytesToInt(a.bytes), high: bytesToInt(b.bytes), bytes: a.bytes.length });
      }
    } else if (op === 'beginbfchar') {
      for (;;) {
        const src = lx.next();
        if (!(src instanceof PDFString)) break;
        const dst = lx.next();
        const code = bytesToInt(src.bytes);
        if (dst instanceof PDFString) cmap.unicode.set(code, utf16(dst.bytes));
        else if (dst instanceof PDFName) cmap.unicode.set(code, dst.name);
        else if (dst instanceof PDFNumber) cmap.unicode.set(code, String.fromCodePoint(dst.value));
      }
    } else if (op === 'beginbfrange') {
      for (;;) {
        const lo = lx.next();
        if (!(lo instanceof PDFString)) break;
        const hi = lx.next();
        let dst = lx.next();
        if (dst === T_ARRAY_START) dst = readArray();
        const low = bytesToInt(lo.bytes);
        const high = bytesToInt(hi.bytes);
        if (high - low > 0x10000) continue; // guard against absurd ranges
        if (Array.isArray(dst)) {
          for (let c = low; c <= high && c - low < dst.length; c++) {
            const d = dst[c - low];
            if (d instanceof PDFString) cmap.unicode.set(c, utf16(d.bytes));
          }
        } else if (dst instanceof PDFString) {
          for (let c = low; c <= high; c++) cmap.unicode.set(c, utf16(incrementString(dst.bytes, c - low)));
        }
      }
    } else if (op === 'begincidchar') {
      for (;;) {
        const src = lx.next();
        if (!(src instanceof PDFString)) break;
        const cid = lx.next();
        cmap.cid.set(bytesToInt(src.bytes), cid instanceof PDFNumber ? cid.value : 0);
      }
    } else if (op === 'begincidrange') {
      for (;;) {
        const lo = lx.next();
        if (!(lo instanceof PDFString)) break;
        const hi = lx.next();
        const start = lx.next();
        cmap.cidRanges.push([bytesToInt(lo.bytes), bytesToInt(hi.bytes), start instanceof PDFNumber ? start.value : 0, lo.bytes.length]);
      }
    } else if (op === 'usecmap') {
      const parent = stack.pop();
      if (parent instanceof PDFName && loadNamed) {
        const base = loadNamed(parent.name);
        if (base) {
          cmap.codespaces.push(...base.codespaces);
          for (const [k, v] of base.unicode) if (!cmap.unicode.has(k)) cmap.unicode.set(k, v);
          for (const [k, v] of base.cid) if (!cmap.cid.has(k)) cmap.cid.set(k, v);
          cmap.cidRanges.push(...base.cidRanges);
          if (base.identity) cmap.identity = true;
        }
      }
    } else if (op === 'def') {
      const value = stack.pop();
      const key = stack.pop();
      if (key instanceof PDFName && key.name === 'CMapName' && value instanceof PDFName) cmap.name = value.name;
      if (key instanceof PDFName && key.name === 'WMode' && value instanceof PDFNumber) cmap.vertical = value.value === 1;
    }
  }
  if (!cmap.codespaces.length) {
    // ToUnicode maps sometimes omit codespaces; infer from key widths.
    let maxBytes = 1;
    for (const k of cmap.unicode.keys()) if (k > 0xff) maxBytes = 2;
    cmap.codespaces.push({ low: 0, high: maxBytes === 2 ? 0xffff : 0xff, bytes: maxBytes });
  }
  return cmap;
}

/** Predefined CMaps we support without external files. */
export function predefinedCMap(name) {
  if (name === 'Identity-H') return CMap.identity(false);
  if (name === 'Identity-V') return CMap.identity(true);
  return null;
}
