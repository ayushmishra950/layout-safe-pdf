// PDFDocument: lazy object loading, decryption, page tree, and saving.

import { readFile, writeFile } from 'node:fs/promises';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, num, N,
} from './objects.js';
import { findStartXref, readXrefChain, reconstructXref } from './xref.js';
import { decodeChain, getFilters, deflate, UnsupportedFilterError } from './filters.js';
import { SecurityHandler, createEncryptionDict } from './crypt.js';
import crypto from 'node:crypto';
import { writeIncremental, writeFull } from './writer.js';
import { PDFPage } from './page.js';
import { limits } from './limits.js';

export class PDFDocument {
  /**
   * @param {Buffer} buf
   * @param {{ password?: string }} [options]
   */
  constructor(buf, options = {}) {
    this.buf = buf;
    this.options = options;
    /** @type {Map<number, {gen:number, value:any}>} */
    this.cache = new Map();
    /** Object numbers changed or created since load. */
    this.modified = new Set();
    this.objStmCache = new Map();
    this.warnings = [];
    this.repaired = false;
    /** Callbacks run before serialization (e.g. finishing font subsets). */
    this.saveHooks = [];

    const m = /^%PDF-(\d\.\d)/.exec(buf.toString('latin1', 0, Math.min(1024, buf.length)).replace(/^[^%]*/, ''));
    this.version = m ? m[1] : '1.4';
    this.headerOffset = Math.max(0, buf.indexOf('%PDF-', 0, 'latin1'));

    this.#loadXref();
    this.#setupEncryption();
    this.#checkCatalog();
  }

  /** Loads a document from a file path or Buffer. */
  static async load(input, options = {}) {
    const buf = typeof input === 'string' ? await readFile(input) : Buffer.from(input);
    return new PDFDocument(buf, options);
  }

  // ---------------------------------------------------------------------------
  // Cross-reference
  // ---------------------------------------------------------------------------

  #loadXref() {
    const buf = this.buf;
    try {
      let startxref = findStartXref(buf);
      if (startxref < 0) throw new Error('startxref not found');
      // Some files have garbage before %PDF; all offsets are then relative to the header.
      let base = 0;
      const probe = buf.toString('latin1', startxref + this.headerOffset, startxref + this.headerOffset + 20);
      if (this.headerOffset > 0 && /xref|\d+\s+\d+\s+obj/.test(probe)) base = this.headerOffset;
      const { entries, trailer, sections } = readXrefChain(buf, startxref + base, base);
      this.xref = entries;
      this.trailer = trailer;
      this.startxref = startxref + base;
      this.xrefBase = base;
      this.lastXrefIsStream = sections[0].isStream;
      if (!this.trailer.get('Root')) throw new Error('Trailer has no /Root');
    } catch (err) {
      this.#repair(err);
    }
  }

  /** The catalog must load (after decryption is set up, as it may sit in an object stream). */
  #checkCatalog() {
    let root = null;
    try {
      root = this.resolve(this.trailer.get('Root'));
    } catch { /* handled below */ }
    if (root instanceof PDFDict) return;
    if (this.repaired) throw new Error('Unable to load the document catalog');
    this.#repair(new Error('Catalog not loadable'));
    if (!(this.resolve(this.trailer.get('Root')) instanceof PDFDict)) throw new Error('Unable to load the document catalog');
  }

  #repair(reason) {
    if (this.repaired) throw reason;
    if (this.buf.length >= 2 && this.buf[0] === 0x1f && this.buf[1] === 0x8b) throw new Error('Not a PDF file (gzip-compressed data)');
    if (this.buf.indexOf('obj', 0, 'latin1') < 0) throw new Error('Not a PDF file');
    this.warnings.push(`Cross-reference damaged (${reason.message}); rebuilt by scanning the file.`);
    this.repaired = true;
    // Drop cached reads, but never lose objects that were changed or created.
    for (const n of [...this.cache.keys()]) if (!this.modified.has(n)) this.cache.delete(n);
    this.objStmCache.clear();
    const { entries, trailer } = reconstructXref(this.buf);
    this.xref = entries;
    this.startxref = findStartXref(this.buf);
    this.xrefBase = 0;
    this.lastXrefIsStream = false;
    this.trailer = trailer || new PDFDict();
    // Object streams of encrypted files can only be read once decryption is set up.
    if (this.trailer.get('Encrypt')) {
      try { this.#setupEncryption(); } catch (e) { if (e.name === 'PDFPasswordError' || /password/i.test(e.message)) throw e; }
    }
    // Pick up objects that live in object streams.
    for (const [objNum, e] of [...entries]) {
      if (e.type !== 1) continue;
      let v;
      try {
        v = this.getObject(objNum);
      } catch { continue; }
      if (v instanceof PDFStream && v.dict.get('Type') === N('ObjStm')) {
        try {
          const { offsets } = this.#parseObjStm(objNum);
          offsets.forEach(([n], idx) => {
            if (!this.xref.has(n)) this.xref.set(n, { type: 2, stream: objNum, index: idx });
          });
        } catch { /* ignore */ }
      }
    }
    if (!this.trailer.get('Root')) {
      // Find a catalog ourselves.
      for (const [objNum] of this.xref) {
        try {
          const v = this.getObject(objNum);
          if (v instanceof PDFDict && v.get('Type') === N('Catalog')) {
            this.trailer.set('Root', new PDFRef(objNum, this.xref.get(objNum).gen || 0));
            break;
          }
        } catch { /* skip */ }
      }
    }
    if (!this.trailer.get('Root')) throw new Error('Unable to find document catalog');
  }

  #setupEncryption() {
    this.security = null;
    const encRef = this.trailer.get('Encrypt');
    if (!encRef) return;
    this.encryptRef = encRef instanceof PDFRef ? encRef : null;
    const encrypt = this.resolve(encRef);
    const ids = this.resolve(this.trailer.get('ID'));
    const id0 = Array.isArray(ids) && ids[0] instanceof PDFString ? ids[0].bytes : Buffer.alloc(0);
    this.security = new SecurityHandler(encrypt, id0, this.options.password || '', (v) => this.resolve(v));
    // Anything already cached was read without decryption.
    for (const n of [...this.cache.keys()]) if (!this.modified.has(n)) this.cache.delete(n);
    this.objStmCache.clear();
  }

  get isEncrypted() {
    return !!this.security;
  }

  /**
   * Encrypts the document with AES-256 (the next save is a full rewrite).
   * @param {{ userPassword?: string, ownerPassword?: string, permissions?: object }} options
   *   userPassword '' lets anyone open the file; permissions e.g. { copy: false, modify: false }
   */
  encrypt(options = {}) {
    // Make sure every object is loaded as plaintext before switching handlers.
    for (const n of this.objectNumbers) this.getObject(n);
    const dict = createEncryptionDict(options);
    let ids = this.resolve(this.trailer.get('ID'));
    if (!Array.isArray(ids) || !(ids[0] instanceof PDFString)) {
      const id = new PDFString(crypto.randomBytes(16), true);
      ids = [id, id];
      this.trailer.set('ID', ids);
    }
    const ref = this.register(dict);
    this.trailer.set('Encrypt', ref);
    this.encryptRef = ref;
    this.security = new SecurityHandler(dict, ids[0].bytes, options.ownerPassword ?? options.userPassword ?? '');
    this.forceFullSave = true;
    // AES-256 is PDF 2.0 / Adobe extension level 8 on top of PDF 1.7.
    if (parseFloat(this.version) < 1.7) this.version = '1.7';
    const catalog = this.catalog;
    if (catalog && parseFloat(this.version) < 2) {
      catalog.set('Extensions', new PDFDict().set('ADBE', new PDFDict().set('BaseVersion', PDFName.of('1.7')).set('ExtensionLevel', 8)));
      this.update(this.trailer.get('Root'), catalog);
    }
  }

  /** Removes encryption (requires the document to be open). Next save is a full rewrite. */
  removeEncryption() {
    for (const n of this.objectNumbers) this.getObject(n);
    if (this.encryptRef) this.cache.delete(this.encryptRef.num);
    this.trailer.delete('Encrypt');
    this.security = null;
    this.encryptRef = null;
    this.forceFullSave = true;
  }

  // ---------------------------------------------------------------------------
  // Object access
  // ---------------------------------------------------------------------------

  /** Resolves a PDFRef (recursively) to its value; other values pass through. */
  resolve(v) {
    let guard = 0;
    while (v instanceof PDFRef && guard++ < 32) v = this.getObject(v.num);
    return v;
  }

  /** Shortcut: dict.get(key) resolved. */
  get(dict, key) {
    if (!(dict instanceof PDFDict)) return undefined;
    return this.resolve(dict.get(key));
  }

  getObject(objNum) {
    const cached = this.cache.get(objNum);
    if (cached) return cached.value;
    const entry = this.xref.get(objNum);
    if (!entry || entry.type === 0) return null;

    let value;
    if (entry.type === 1) {
      value = this.#readUncompressed(objNum, entry);
    } else {
      value = this.#readCompressed(objNum, entry);
    }
    this.cache.set(objNum, { gen: entry.gen || 0, value });
    return value;
  }

  #readUncompressed(objNum, entry) {
    let obj;
    try {
      const lx = new Lexer(this.buf, entry.offset);
      obj = new Parser(lx).parseIndirectObject((ref) => this.resolve(ref));
      if (obj.num !== objNum) throw new Error(`xref offset points to object ${obj.num}, expected ${objNum}`);
    } catch {
      obj = null;
      // A single bad entry is common: look the object up by scanning first.
      const offset = this.#scanIndex().get(objNum);
      if (offset === undefined) {
        // Not defined anywhere in the file: treat as a null object (spec 7.3.10).
        this.warnings.push(`Object ${objNum} is referenced by the xref but missing from the file.`);
        return null;
      }
      if (offset !== undefined && offset !== entry.offset) {
        try {
          obj = new Parser(new Lexer(this.buf, offset)).parseIndirectObject((ref) => this.resolve(ref));
          if (obj.num === objNum) {
            this.warnings.push(`xref entry for object ${objNum} was wrong; found it by scanning.`);
            entry.offset = offset;
          } else obj = null;
        } catch { obj = null; }
      }
    }
    if (!obj) {
      const err = new Error(`object ${objNum} not found at its xref offset`);
      if (!this.repaired) {
        // Offsets are wrong – rebuild once, then retry.
        this.#repair(err);
        return this.getObject(objNum);
      }
      this.warnings.push(`Object ${objNum} unreadable: ${err.message}`);
      return null;
    }
    let value = obj.value;
    if (this.security && !(this.encryptRef && this.encryptRef.num === objNum)) {
      value = this.#decrypt(value, objNum, obj.gen);
    }
    return value;
  }

  /** Offsets of every "n g obj" header in the file (last definition wins). */
  #scanIndex() {
    if (this._scanIndex) return this._scanIndex;
    const index = new Map();
    const text = this.buf.toString('latin1');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) {
      const before = m.index > 0 ? text.charCodeAt(m.index - 1) : 10;
      if (before >= 0x30 && before <= 0x39) continue;
      index.set(parseInt(m[1], 10), m.index);
    }
    this._scanIndex = index;
    return index;
  }

  #decrypt(value, n, g) {
    const sec = this.security;
    if (value instanceof PDFString) return new PDFString(sec.decryptString(n, g, value.bytes), value.hex);
    if (Array.isArray(value)) return value.map((v) => this.#decrypt(v, n, g));
    if (value instanceof PDFDict) {
      const out = new PDFDict();
      for (const [k, v] of value.entries()) out.set(k, this.#decrypt(v, n, g));
      return out;
    }
    if (value instanceof PDFStream) {
      const type = value.dict.get('Type');
      if (type === N('XRef')) return value;
      const dict = this.#decrypt(value.dict, n, g);
      if (type === N('Metadata') && !sec.encryptMetadata) return new PDFStream(dict, value.data);
      const filters = getFilters(value.dict);
      if (filters.length && filters[0][0] === 'Crypt') {
        // A /Crypt filter names its own crypt filter; Identity (or none) = not encrypted.
        const cfName = filters[0][1]?.get('Name');
        if (!cfName || cfName.name === 'Identity') return new PDFStream(dict, value.data);
      }
      return new PDFStream(dict, sec.decryptStream(n, g, value.data));
    }
    return value;
  }

  #parseObjStm(streamNum) {
    let parsed = this.objStmCache.get(streamNum);
    if (parsed) return parsed;
    const stream = this.getObject(streamNum);
    if (!(stream instanceof PDFStream)) throw new Error(`Object stream ${streamNum} missing`);
    const data = this.decodeStream(stream);
    const n = num(this.resolve(stream.dict.get('N')));
    const first = num(this.resolve(stream.dict.get('First')));
    const lx = new Lexer(data, 0);
    const offsets = [];
    // Each header entry takes at least 4 bytes ("n o "), which bounds a bogus /N.
    const count = Math.min(n, Math.floor(Math.max(0, first) / 4) + 1, limits.maxObjectsPerStream);
    for (let i = 0; i < count; i++) {
      const a = lx.next();
      const b = lx.next();
      offsets.push([num(a), num(b)]);
    }
    parsed = { data, first, offsets };
    this.objStmCache.set(streamNum, parsed);
    return parsed;
  }

  #readCompressed(objNum, entry) {
    const { data, first, offsets } = this.#parseObjStm(entry.stream);
    let idx = entry.index;
    if (!offsets[idx] || offsets[idx][0] !== objNum) {
      idx = offsets.findIndex(([n]) => n === objNum);
      if (idx < 0) return null;
    }
    const lx = new Lexer(data, first + offsets[idx][1]);
    return new Parser(lx).parseObject();
  }

  /** Returns all object numbers known to the document. */
  get objectNumbers() {
    const nums = new Set(this.xref.keys());
    for (const k of this.cache.keys()) nums.add(k);
    return [...nums].sort((a, b) => a - b);
  }

  get maxObjectNumber() {
    let max = num(this.trailer.get('Size'), 1) - 1;
    for (const k of this.xref.keys()) max = Math.max(max, k);
    for (const k of this.cache.keys()) max = Math.max(max, k);
    return max;
  }

  /** Registers a new indirect object and returns its reference. */
  register(value) {
    const n = this.maxObjectNumber + 1;
    this.cache.set(n, { gen: 0, value });
    this.modified.add(n);
    return new PDFRef(n, 0);
  }

  /** Replaces (or marks as changed) the object behind `ref`. */
  update(ref, value) {
    const n = ref instanceof PDFRef ? ref.num : ref;
    const gen = ref instanceof PDFRef ? ref.gen : this.cache.get(n)?.gen ?? 0;
    if (value === undefined) value = this.getObject(n);
    this.cache.set(n, { gen, value });
    this.modified.add(n);
  }

  // ---------------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------------

  /** Returns decoded stream bytes. Throws UnsupportedFilterError for image codecs. */
  decodeStream(stream) {
    const filters = getFilters(stream.dict, (v) => this.resolve(v));
    const { data, remaining } = decodeChain(stream.data, filters, (v) => this.resolve(v));
    if (remaining.length) throw new UnsupportedFilterError(`Stream uses image filter ${remaining[0][0]}`);
    return data;
  }

  /** Sets decoded content on a stream, Flate-compressing it. */
  setStreamData(stream, decoded, { compress = true } = {}) {
    stream.dict.delete('DecodeParms');
    stream.dict.delete('DP');
    if (compress) {
      stream.data = deflate(decoded);
      stream.dict.set('Filter', N('FlateDecode'));
    } else {
      stream.data = Buffer.from(decoded);
      stream.dict.delete('Filter');
    }
    stream.dict.set('Length', stream.data.length);
  }

  // ---------------------------------------------------------------------------
  // Catalog & pages
  // ---------------------------------------------------------------------------

  /**
   * Signed signature fields (AcroForm /FT /Sig with a value). Editing a signed
   * document invalidates those signatures.
   * @returns {Array<{ name: string, signer: string|null }>}
   */
  get signatures() {
    const form = this.resolve(this.catalog?.get('AcroForm'));
    const out = [];
    const seen = new Set();
    const walk = (fields, prefix) => {
      for (const ref of this.resolve(fields) || []) {
        if (ref instanceof PDFRef) {
          if (seen.has(ref.num)) continue;
          seen.add(ref.num);
        }
        const f = this.resolve(ref);
        if (!(f instanceof PDFDict)) continue;
        const t = this.resolve(f.get('T'));
        const name = prefix + (t instanceof PDFString ? t.toText() : '');
        const v = this.resolve(f.get('V'));
        if (this.resolve(f.get('FT'))?.name === 'Sig' && v instanceof PDFDict) {
          const signer = this.resolve(v.get('Name'));
          out.push({ name, signer: signer instanceof PDFString ? signer.toText() : null });
        }
        if (f.get('Kids')) walk(f.get('Kids'), name ? name + '.' : '');
      }
    };
    if (form instanceof PDFDict) walk(form.get('Fields'), '');
    return out;
  }

  get isSigned() {
    return this.signatures.length > 0;
  }

  get catalog() {
    return this.resolve(this.trailer.get('Root'));
  }

  get info() {
    return this.resolve(this.trailer.get('Info'));
  }

  /** @returns {PDFPage[]} */
  getPages() {
    if (this._pages) return this._pages;
    const pages = [];
    const visited = new Set();
    const walk = (ref, inherited) => {
      const node = this.resolve(ref);
      if (!(node instanceof PDFDict)) return;
      if (ref instanceof PDFRef) {
        if (visited.has(ref.num)) return; // cycle guard
        visited.add(ref.num);
      }
      const inh = { ...inherited };
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        if (node.has(key)) inh[key] = node.get(key);
      }
      const type = this.resolve(node.get('Type'));
      const kids = this.resolve(node.get('Kids'));
      if ((type && type.name === 'Pages') || (Array.isArray(kids) && !(type && type.name === 'Page'))) {
        for (const kid of kids || []) walk(kid, inh);
      } else {
        pages.push(new PDFPage(this, node, ref instanceof PDFRef ? ref : null, inh, pages.length));
      }
    };
    walk(this.catalog.get('Pages'), {});
    this._pages = pages;
    return pages;
  }

  getPage(index) {
    return this.getPages()[index];
  }

  get pageCount() {
    return this.getPages().length;
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  /**
   * Serializes the document.
   * @param {{ incremental?: boolean, compress?: boolean }} [options]
   *   incremental (default true): append changes, original bytes untouched.
   * @returns {Buffer}
   */
  save(options = {}) {
    for (const hook of this.saveHooks) hook();
    const incremental = options.incremental !== false && !this.repaired && !this.forceFullSave;
    return incremental ? writeIncremental(this, options) : writeFull(this, options);
  }

  addSaveHook(fn) {
    this.saveHooks.push(fn);
  }

  async saveAs(path, options) {
    const out = this.save(options);
    await writeFile(path, out);
    return out;
  }
}

export { PDFName, PDFNumber, PDFRef, PDFStream, PDFString, PDFDict };
