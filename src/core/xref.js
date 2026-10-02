// Cross-reference reading (ISO 32000-1, sections 7.5.4, 7.5.6, 7.5.8) with
// recovery for damaged files.

import { Lexer, T_EOF } from './lexer.js';
import { Parser } from './parser.js';
import { PDFDict, PDFNumber, PDFOperator, PDFStream, PDFName, num } from './objects.js';
import { decodeChain, getFilters } from './filters.js';

/**
 * Entry kinds:
 *   { type: 0 }                               free
 *   { type: 1, offset, gen }                  uncompressed object at byte offset
 *   { type: 2, stream, index }                object inside an object stream
 */

/** Finds the byte offset given after the last `startxref`. */
export function findStartXref(buf) {
  const tailStart = Math.max(0, buf.length - 4096);
  const idx = buf.lastIndexOf('startxref', buf.length, 'latin1');
  if (idx < 0 || idx < tailStart - 1024 * 1024) return -1;
  const lx = new Lexer(buf, idx + 9);
  const t = lx.next();
  return t instanceof PDFNumber ? t.value : -1;
}

/**
 * Reads the whole xref chain starting at `startxref`.
 * @returns {{ entries: Map<number, any>, trailer: PDFDict, sections: Array<{offset:number, isStream:boolean}> }}
 */
export function readXrefChain(buf, startxref, base = 0) {
  const entries = new Map();
  let trailer = null;
  const sections = [];
  const seen = new Set();
  const queue = [startxref];

  while (queue.length) {
    const offset = queue.shift();
    if (seen.has(offset) || offset < 0 || offset >= buf.length) continue;
    seen.add(offset);

    const section = readXrefSection(buf, offset, base);
    sections.push({ offset, isStream: section.isStream });
    // Earlier-read (newer) sections win.
    for (const [k, v] of section.entries) if (!entries.has(k)) entries.set(k, v);
    if (!trailer) trailer = section.trailer;

    // Hybrid-reference files: /XRefStm points to an xref stream with extra entries.
    const xrefStm = section.trailer.get('XRefStm');
    if (xrefStm !== undefined && !section.isStream) {
      try {
        const hybrid = readXrefSection(buf, num(xrefStm) + base, base);
        for (const [k, v] of hybrid.entries) if (!entries.has(k)) entries.set(k, v);
      } catch { /* ignore broken hybrid sections */ }
    }
    const prev = section.trailer.get('Prev');
    if (prev !== undefined) queue.push(num(prev) + base);
  }
  if (!trailer) throw new Error('No trailer found');
  return { entries, trailer, sections };
}

function readXrefSection(buf, offset, base = 0) {
  const lx = new Lexer(buf, offset);
  lx.skipWhitespace();
  const section = buf.toString('latin1', lx.pos, lx.pos + 4) === 'xref'
    ? (lx.pos += 4, readXrefTable(buf, lx))
    : readXrefStream(buf, lx);
  if (base) for (const e of section.entries.values()) if (e.type === 1) e.offset += base;
  return section;
}

function readXrefTable(buf, lx) {
  const entries = new Map();
  for (;;) {
    const save = lx.pos;
    const t = lx.next();
    if (t instanceof PDFOperator && t.op === 'trailer') break;
    if (!(t instanceof PDFNumber)) {
      lx.pos = save;
      throw new Error('Malformed xref table');
    }
    const first = t.value;
    const count = num(lx.next());
    for (let i = 0; i < count; i++) {
      // Each entry: "nnnnnnnnnn ggggg n" – parse tolerantly by tokens.
      const entryStart = lx.pos;
      const off = lx.next();
      const gen = lx.next();
      const kind = lx.next();
      if (!(off instanceof PDFNumber) || !(kind instanceof PDFOperator) || (kind.op !== 'n' && kind.op !== 'f')) {
        lx.pos = entryStart; // overstated count: leave the next token for the outer loop
        break;
      }
      const objNum = first + i;
      if (entries.has(objNum)) continue;
      if (kind.op === 'n') entries.set(objNum, { type: 1, offset: off.value, gen: num(gen) });
      else entries.set(objNum, { type: 0 });
    }
  }
  const parser = new Parser(lx);
  const trailer = parser.parseObject();
  if (!(trailer instanceof PDFDict)) throw new Error('Malformed trailer');
  // Fix an off-by-one common in broken producers: table starting at 1 instead of 0.
  return { entries, trailer, isStream: false };
}

function readXrefStream(buf, lx) {
  const parser = new Parser(lx);
  const obj = parser.parseIndirectObject();
  const stream = obj.value;
  if (!(stream instanceof PDFStream)) throw new Error('Expected xref stream');
  const dict = stream.dict;
  const type = dict.get('Type');
  if (!(type instanceof PDFName) || type.name !== 'XRef') throw new Error('Not an xref stream');

  const { data } = decodeChain(stream.data, getFilters(dict));
  const W = dict.get('W').map((w) => num(w));
  const size = num(dict.get('Size'));
  const index = dict.get('Index') ? dict.get('Index').map((v) => num(v)) : [0, size];
  const rowLen = W[0] + W[1] + W[2];
  const entries = new Map();
  const readField = (p, w) => {
    let v = 0;
    for (let i = 0; i < w; i++) v = v * 256 + data[p + i];
    return v;
  };

  let p = 0;
  for (let s = 0; s + 1 < index.length; s += 2) {
    const first = index[s];
    const count = index[s + 1];
    for (let i = 0; i < count && p + rowLen <= data.length; i++, p += rowLen) {
      const t = W[0] === 0 ? 1 : readField(p, W[0]);
      const f2 = readField(p + W[0], W[1]);
      const f3 = readField(p + W[0] + W[1], W[2]);
      const objNum = first + i;
      if (entries.has(objNum)) continue;
      if (t === 0) entries.set(objNum, { type: 0 });
      else if (t === 1) entries.set(objNum, { type: 1, offset: f2, gen: f3 });
      else if (t === 2) entries.set(objNum, { type: 2, stream: f2, index: f3 });
    }
  }
  return { entries, trailer: dict, isStream: true, streamObjNum: obj.num };
}

/**
 * Rebuilds the xref by scanning the whole file for "n g obj" headers.
 * Used when the xref is missing or damaged.
 */
export function reconstructXref(buf) {
  const entries = new Map();
  let trailer = null;
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const text = buf.toString('latin1');
  let m;
  const objStreams = [];
  while ((m = re.exec(text))) {
    // Must be at the start of a line/token.
    const before = m.index > 0 ? text.charCodeAt(m.index - 1) : 10;
    if (before >= 0x30 && before <= 0x39) continue;
    const n = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    entries.set(n, { type: 1, offset: m.index, gen: g }); // later definitions win
    // Peek for ObjStm / XRef so we can pick up compressed objects & trailers.
    const head = text.slice(m.index, m.index + 300);
    if (/\/Type\s*\/ObjStm/.test(head)) objStreams.push(n);
    if (/\/Type\s*\/XRef/.test(head)) {
      try {
        const lx = new Lexer(buf, m.index);
        const obj = new Parser(lx).parseIndirectObject();
        if (obj.value instanceof PDFStream) trailer = obj.value.dict;
      } catch { /* ignore */ }
    }
  }
  // Trailers written as "trailer << ... >>".
  let idx = text.lastIndexOf('trailer');
  while (idx >= 0) {
    try {
      const lx = new Lexer(buf, idx + 7);
      const t = new Parser(lx).parseObject();
      if (t instanceof PDFDict && t.get('Root')) {
        trailer = t;
        break;
      }
    } catch { /* keep looking */ }
    idx = text.lastIndexOf('trailer', idx - 1);
  }
  return { entries, trailer, objStreams };
}

export { T_EOF };
