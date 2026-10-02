// Serialization: object syntax, incremental updates (ISO 32000-1 section 7.5.6)
// and full rewrites.

import crypto from 'node:crypto';
import {
  PDFDict, PDFName, PDFNumber, PDFOperator, PDFRef, PDFStream, PDFString, N,
} from './objects.js';
import { deflate } from './filters.js';

// ---- value serialization -------------------------------------------------------

export function formatNumber(n) {
  if (n instanceof PDFNumber) return n.raw;
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

const NAME_REGULAR = new Uint8Array(256);
for (let c = 0x21; c <= 0x7e; c++) NAME_REGULAR[c] = 1;
for (const c of '()<>[]{}/%#') NAME_REGULAR[c.charCodeAt(0)] = 0;

export function formatName(name) {
  const bytes = Buffer.from(name, /[^\x00-\xff]/.test(name) ? 'utf8' : 'latin1');
  let s = '/';
  for (const b of bytes) s += NAME_REGULAR[b] ? String.fromCharCode(b) : '#' + b.toString(16).padStart(2, '0');
  return s;
}

export function formatStringBytes(bytes, hex) {
  if (hex) return '<' + bytes.toString('hex') + '>';
  // Literal: escape \ ( ) and control chars that would get mangled by EOL normalisation.
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x0a) s += '\\n';
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

/**
 * Serializes a value to a latin1 string (binary-safe).
 * @param {any} v
 * @param {null | ((bytes:Buffer)=>Buffer)} encryptString
 */
export function serialize(v, encryptString = null) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number' || v instanceof PDFNumber) return formatNumber(v);
  if (v instanceof PDFName) return formatName(v.name);
  if (v instanceof PDFRef) return `${v.num} ${v.gen} R`;
  if (v instanceof PDFString) {
    if (encryptString) return formatStringBytes(encryptString(v.bytes), true);
    return formatStringBytes(v.bytes, v.hex);
  }
  if (v instanceof PDFOperator) return v.op;
  if (Array.isArray(v)) return '[' + v.map((x) => serialize(x, encryptString)).join(' ') + ']';
  if (v instanceof PDFDict) {
    let s = '<<';
    for (const [k, val] of v.entries()) s += formatName(k) + ' ' + serialize(val, encryptString);
    return s + '>>';
  }
  if (v instanceof PDFStream) throw new Error('Streams must be indirect objects');
  throw new Error(`Cannot serialize ${typeof v}`);
}

/** Serializes "n g obj ... endobj" for one object. */
function serializeIndirect(doc, objNum, gen, value, { encrypt }) {
  const sec = encrypt ? doc.security : null;
  const isEncryptDict = doc.encryptRef && doc.encryptRef.num === objNum;
  const encStr = sec && !isEncryptDict ? (b) => sec.encryptString(objNum, gen, b) : null;
  const head = Buffer.from(`${objNum} ${gen} obj\n`, 'latin1');

  if (value instanceof PDFStream) {
    let data = value.data;
    const type = value.dict.get('Type');
    const skip = !sec || isEncryptDict || type === N('XRef') || (type === N('Metadata') && !sec.encryptMetadata) || identityCrypt(value.dict);
    if (!skip) data = sec.encryptStream(objNum, gen, data);
    const dict = value.dict.clone();
    dict.set('Length', data.length);
    return Buffer.concat([
      head,
      Buffer.from(serialize(dict, encStr) + '\nstream\n', 'latin1'),
      data,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
  }
  return Buffer.concat([head, Buffer.from(serialize(value, encStr) + '\nendobj\n', 'latin1')]);
}

/** Streams whose first filter is /Crypt with the Identity crypt filter stay unencrypted. */
function identityCrypt(dict) {
  let f = dict.get('Filter');
  if (!f) return false;
  if (!Array.isArray(f)) f = [f];
  if (!(f[0] instanceof PDFName) || f[0].name !== 'Crypt') return false;
  let p = dict.get('DecodeParms');
  if (Array.isArray(p)) p = p[0];
  const name = p instanceof PDFDict ? p.get('Name') : null;
  return !name || name.name === 'Identity';
}

function newFileId(doc, size) {
  return crypto.createHash('md5').update(`${Date.now()}-${size}-${Math.random()}`).digest();
}

/** Copies trailer keys that must survive into the new trailer. */
function baseTrailer(doc, size) {
  const t = new PDFDict();
  t.set('Size', size);
  for (const key of ['Root', 'Info', 'Encrypt']) {
    const v = doc.trailer.get(key);
    if (v !== undefined) t.set(key, v);
  }
  const ids = doc.resolve(doc.trailer.get('ID'));
  if (Array.isArray(ids) && ids.length === 2) {
    // ID[0] is permanent (and part of the encryption key); ID[1] changes per revision.
    t.set('ID', [ids[0], new PDFString(newFileId(doc, size), true)]);
  } else if (!doc.security) {
    const id = new PDFString(newFileId(doc, size), true);
    t.set('ID', [id, id]);
  }
  return t;
}

// ---- xref writing ----------------------------------------------------------------

function xrefTable(rows) {
  // rows: sorted [{num, offset, gen, free}]
  let s = 'xref\n';
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].num === rows[j].num + 1) j++;
    s += `${rows[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const r = rows[k];
      s += `${String(r.offset).padStart(10, '0')} ${String(r.gen).padStart(5, '0')} ${r.free ? 'f' : 'n'} \n`;
    }
    i = j + 1;
  }
  return s;
}

function xrefStreamObject(rows, trailer, selfNum, selfOffset) {
  const all = [...rows, { num: selfNum, offset: selfOffset, gen: 0 }].sort((a, b) => a.num - b.num);
  const index = [];
  const data = Buffer.alloc(all.length * 7);
  let i = 0;
  let p = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].num === all[j].num + 1) j++;
    index.push(all[i].num, j - i + 1);
    for (let k = i; k <= j; k++, p += 7) {
      const r = all[k];
      data[p] = r.free ? 0 : 1;
      data.writeUInt32BE(r.free ? 0 : r.offset, p + 1);
      data.writeUInt16BE(r.free ? 65535 : r.gen, p + 5);
    }
    i = j + 1;
  }
  const compressed = deflate(data);
  const dict = trailer.clone();
  dict.set('Type', N('XRef'));
  dict.set('W', [1, 4, 2]);
  dict.set('Index', index);
  dict.set('Filter', N('FlateDecode'));
  dict.set('Length', compressed.length);
  return new PDFStream(dict, compressed);
}

// ---- incremental update ------------------------------------------------------------

/**
 * Appends only changed objects after the original bytes. Everything that was
 * there before stays byte-identical (keeps signatures' signed ranges intact).
 */
export function writeIncremental(doc) {
  const chunks = [doc.buf];
  let offset = doc.buf.length;
  if (doc.buf[doc.buf.length - 1] !== 0x0a) {
    chunks.push(Buffer.from('\n'));
    offset += 1;
  }
  const rows = [];
  const nums = [...doc.modified].sort((a, b) => a - b);
  for (const n of nums) {
    const entry = doc.cache.get(n);
    const bytes = serializeIndirect(doc, n, entry.gen, entry.value, { encrypt: true });
    rows.push({ num: n, offset: offset - (doc.xrefBase || 0), gen: entry.gen });
    chunks.push(bytes);
    offset += bytes.length;
  }

  let size = doc.maxObjectNumber + 1;
  const xrefOffset = offset - (doc.xrefBase || 0);
  if (doc.lastXrefIsStream) {
    const selfNum = size;
    size += 1;
    const trailer = baseTrailer(doc, size);
    trailer.set('Prev', doc.startxref - (doc.xrefBase || 0));
    const stream = xrefStreamObject(rows, trailer, selfNum, xrefOffset);
    chunks.push(serializeIndirect(doc, selfNum, 0, stream, { encrypt: false }));
  } else {
    const trailer = baseTrailer(doc, size);
    trailer.set('Prev', doc.startxref - (doc.xrefBase || 0));
    const table = xrefTable(rows);
    chunks.push(Buffer.from(table + 'trailer\n' + serialize(trailer) + '\n', 'latin1'));
  }
  chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

// ---- full rewrite ------------------------------------------------------------------

/** Collects object numbers reachable from the trailer. */
function reachable(doc) {
  const seen = new Set();
  const stack = [];
  const visit = (v) => {
    if (v instanceof PDFRef) {
      if (!seen.has(v.num)) {
        seen.add(v.num);
        stack.push(doc.getObject(v.num));
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v instanceof PDFDict) for (const [, x] of v.entries()) visit(x);
    else if (v instanceof PDFStream) visit(v.dict);
  };
  for (const key of ['Root', 'Info', 'Encrypt']) visit(doc.trailer.get(key));
  while (stack.length) visit(stack.pop());
  return [...seen].sort((a, b) => a - b);
}

/**
 * Rewrites the whole file: drops unreachable objects, unpacks object streams,
 * and optionally compresses uncompressed streams.
 */
export function writeFull(doc, { compress = false } = {}) {
  const header = Buffer.from(`%PDF-${doc.version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1');
  const chunks = [header];
  let offset = header.length;
  const rows = [{ num: 0, offset: 0, gen: 65535, free: true }];
  const nums = reachable(doc);
  let maxNum = 0;
  for (const n of nums) {
    let value = doc.getObject(n);
    if (value === null || value === undefined) continue;
    const gen = doc.cache.get(n)?.gen ?? 0;
    if (value instanceof PDFStream && value.dict.get('Type') === N('XRef')) continue;
    if (value instanceof PDFStream && value.dict.get('Type') === N('ObjStm')) continue;
    if (compress && value instanceof PDFStream && !value.dict.get('Filter') && value.dict.get('Type') !== N('Metadata')) {
      const dict = value.dict.clone();
      const data = deflate(value.data);
      dict.set('Filter', N('FlateDecode'));
      value = new PDFStream(dict, data);
    }
    const bytes = serializeIndirect(doc, n, gen, value, { encrypt: true });
    rows.push({ num: n, offset, gen });
    chunks.push(bytes);
    offset += bytes.length;
    maxNum = Math.max(maxNum, n);
  }
  // Fill gaps with free entries so the table is one contiguous section.
  const present = new Map(rows.map((r) => [r.num, r]));
  const full = [];
  for (let i = 0; i <= maxNum; i++) full.push(present.get(i) || { num: i, offset: 0, gen: 0, free: true });

  const trailer = baseTrailer(doc, maxNum + 1);
  chunks.push(Buffer.from(xrefTable(full) + 'trailer\n' + serialize(trailer) + '\n', 'latin1'));
  chunks.push(Buffer.from(`startxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
