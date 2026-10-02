// PDF object model (ISO 32000-1, section 7.3).
//
// Mapping to JS values:
//   boolean      -> true / false
//   number       -> PDFNumber when parsed (keeps original text), or plain JS number
//   string       -> PDFString (raw bytes + whether it was written as hex)
//   name         -> PDFName (interned, compare with ===)
//   array        -> JS Array
//   dictionary   -> PDFDict
//   stream       -> PDFStream (dict + raw, still-encoded bytes)
//   null         -> null
//   indirect ref -> PDFRef

export class PDFName {
  static #cache = new Map();

  /** @param {string} name decoded name without the leading slash */
  constructor(name) {
    this.name = name;
  }

  /** Returns the interned PDFName for `name` so names can be compared with ===. */
  static of(name) {
    let n = PDFName.#cache.get(name);
    if (!n) {
      n = new PDFName(name);
      PDFName.#cache.set(name, n);
    }
    return n;
  }

  toString() {
    return '/' + this.name;
  }
}

export const N = (name) => PDFName.of(name);

export class PDFRef {
  constructor(num, gen = 0) {
    this.num = num;
    this.gen = gen;
  }

  get key() {
    return `${this.num} ${this.gen}`;
  }

  equals(other) {
    return other instanceof PDFRef && other.num === this.num && other.gen === this.gen;
  }

  toString() {
    return `${this.num} ${this.gen} R`;
  }
}

/**
 * A number that remembers how it was written, so unchanged values are written
 * back byte-for-byte (e.g. "0.0300" stays "0.0300").
 */
export class PDFNumber {
  constructor(value, raw) {
    this.value = value;
    this.raw = raw;
  }

  valueOf() {
    return this.value;
  }
}

export class PDFString {
  /**
   * @param {Buffer} bytes raw string bytes (already un-escaped, possibly encrypted)
   * @param {boolean} hex whether it was written as <hex>
   */
  constructor(bytes, hex = false) {
    this.bytes = bytes;
    this.hex = hex;
  }

  /** Creates a PDF text string; uses UTF-16BE with BOM when not plain Latin-1 PDFDoc. */
  static fromText(text) {
    if (/^[\x20-\x7e\n\r\t]*$/.test(text)) return new PDFString(Buffer.from(text, 'latin1'));
    const utf16 = Buffer.alloc(2 + text.length * 2);
    utf16[0] = 0xfe;
    utf16[1] = 0xff;
    for (let i = 0; i < text.length; i++) utf16.writeUInt16BE(text.charCodeAt(i), 2 + i * 2);
    return new PDFString(utf16, true);
  }

  /** Decodes a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding). */
  toText() {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      return b.subarray(3).toString('utf8');
    }
    let s = '';
    for (const c of b) s += PDF_DOC_ENCODING[c] ?? String.fromCharCode(c);
    return s;
  }
}

// PDFDocEncoding differences from Latin-1 (ISO 32000-1, Annex D.3).
const PDF_DOC_ENCODING = {
  0x18: '\u02d8', 0x19: '\u02c7', 0x1a: '\u02c6', 0x1b: '\u02d9', 0x1c: '\u02dd', 0x1d: '\u02db', 0x1e: '\u02da', 0x1f: '\u02dc',
  0x80: '\u2022', 0x81: '\u2020', 0x82: '\u2021', 0x83: '\u2026', 0x84: '\u2014', 0x85: '\u2013', 0x86: '\u0192', 0x87: '\u2044',
  0x88: '\u2039', 0x89: '\u203a', 0x8a: '\u2212', 0x8b: '\u2030', 0x8c: '\u201e', 0x8d: '\u201c', 0x8e: '\u201d', 0x8f: '\u2018',
  0x90: '\u2019', 0x91: '\u201a', 0x92: '\u2122', 0x93: '\ufb01', 0x94: '\ufb02', 0x95: '\u0141', 0x96: '\u0152', 0x97: '\u0160',
  0x98: '\u0178', 0x99: '\u017d', 0x9a: '\u0131', 0x9b: '\u0142', 0x9c: '\u0153', 0x9d: '\u0161', 0x9e: '\u017e', 0xa0: '\u20ac',
};

export class PDFDict {
  /** @param {Map<string, any>} [map] */
  constructor(map) {
    this.map = map || new Map();
  }

  /** Raw value (may be a PDFRef). */
  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return this;
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    this.map.delete(key);
  }

  keys() {
    return this.map.keys();
  }

  entries() {
    return this.map.entries();
  }

  get size() {
    return this.map.size;
  }

  clone() {
    return new PDFDict(new Map(this.map));
  }
}

export class PDFStream {
  /**
   * @param {PDFDict} dict
   * @param {Buffer} data encoded (filtered) stream bytes, as stored in the file
   */
  constructor(dict, data) {
    this.dict = dict;
    this.data = data;
  }
}

/** Operators/keywords inside content streams, and the special `R`/`obj` tokens. */
export class PDFOperator {
  constructor(op) {
    this.op = op;
  }
}

// ---- small helpers ----------------------------------------------------------

export const isName = (v, name) => v instanceof PDFName && (name === undefined || v.name === name);
export const isDict = (v) => v instanceof PDFDict;
export const isRef = (v) => v instanceof PDFRef;
export const isStream = (v) => v instanceof PDFStream;

/** Converts PDFNumber -> number, leaving other values untouched. */
export function num(v, fallback = 0) {
  if (v instanceof PDFNumber) return v.value;
  if (typeof v === 'number') return v;
  return fallback;
}
