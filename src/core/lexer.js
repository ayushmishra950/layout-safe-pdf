// Tokenizer for PDF syntax (ISO 32000-1, section 7.2). Used for both the file
// body and content streams.

import { PDFName, PDFNumber, PDFString, PDFOperator } from './objects.js';

export const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;

export const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[0x30 + i] = i;
for (let i = 0; i < 6; i++) {
  HEX[0x41 + i] = 10 + i;
  HEX[0x61 + i] = 10 + i;
}
export { HEX };

// Token kinds for delimiters.
export const T_ARRAY_START = Symbol('[');
export const T_ARRAY_END = Symbol(']');
export const T_DICT_START = Symbol('<<');
export const T_DICT_END = Symbol('>>');
export const T_BRACE_START = Symbol('{');
export const T_BRACE_END = Symbol('}');
export const T_EOF = Symbol('EOF');

export class Lexer {
  /**
   * @param {Buffer} buf
   * @param {number} [pos]
   */
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipWhitespace() {
    const buf = this.buf;
    let p = this.pos;
    for (;;) {
      while (p < buf.length && WS[buf[p]]) p++;
      if (buf[p] === 0x25 /* % */) {
        while (p < buf.length && buf[p] !== 0x0a && buf[p] !== 0x0d) p++;
        continue;
      }
      break;
    }
    this.pos = p;
  }

  /**
   * Returns the next token: a value (number, PDFString, PDFName, boolean, null),
   * a PDFOperator for keywords, or one of the T_* symbols.
   */
  next() {
    this.skipWhitespace();
    const buf = this.buf;
    if (this.pos >= buf.length) return T_EOF;
    const c = buf[this.pos];

    switch (c) {
      case 0x5b: this.pos++; return T_ARRAY_START; // [
      case 0x5d: this.pos++; return T_ARRAY_END; // ]
      case 0x7b: this.pos++; return T_BRACE_START; // {
      case 0x7d: this.pos++; return T_BRACE_END; // }
      case 0x28: return this.readLiteralString(); // (
      case 0x2f: return this.readName(); // /
      case 0x3c: // <
        if (buf[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return T_DICT_START;
        }
        return this.readHexString();
      case 0x3e: // >
        if (buf[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return T_DICT_END;
        }
        this.pos++; // stray '>' – skip it, be lenient
        return this.next();
      case 0x29: // stray ')'
        this.pos++;
        return this.next();
    }

    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      return this.readNumber();
    }
    return this.readKeyword();
  }

  readNumber() {
    const buf = this.buf;
    const start = this.pos;
    let p = start;
    if (buf[p] === 0x2b || buf[p] === 0x2d) p++;
    // Some producers write things like "--5" or "-.5"; be lenient.
    while (buf[p] === 0x2d) p++;
    while (p < buf.length && ((buf[p] >= 0x30 && buf[p] <= 0x39) || buf[p] === 0x2e)) p++;
    this.pos = p;
    const raw = buf.toString('latin1', start, p);
    let value = parseFloat(raw.replace(/^([+-])-+/, '$1'));
    if (Number.isNaN(value)) value = 0;
    return new PDFNumber(value, raw);
  }

  readName() {
    const buf = this.buf;
    let p = this.pos + 1;
    const bytes = [];
    while (p < buf.length && !WS[buf[p]] && !DELIM[buf[p]]) {
      if (buf[p] === 0x23 /* # */ && HEX[buf[p + 1]] >= 0 && HEX[buf[p + 2]] >= 0) {
        bytes.push((HEX[buf[p + 1]] << 4) | HEX[buf[p + 2]]);
        p += 3;
      } else {
        bytes.push(buf[p++]);
      }
    }
    this.pos = p;
    // Names are byte sequences: keep them byte-exact (latin1) so they are written
    // back unchanged and keep matching the keys used in content streams.
    return PDFName.of(Buffer.from(bytes).toString('latin1'));
  }

  readLiteralString() {
    const buf = this.buf;
    let p = this.pos + 1;
    let depth = 1;
    let o = 0;
    let outBuf = Buffer.allocUnsafe(64);
    const push = (b) => {
      if (o >= outBuf.length) {
        const bigger = Buffer.allocUnsafe(outBuf.length * 2);
        outBuf.copy(bigger, 0, 0, o);
        outBuf = bigger;
      }
      outBuf[o++] = b;
    };
    while (p < buf.length) {
      const c = buf[p++];
      if (c === 0x5c /* \ */) {
        const e = buf[p++];
        switch (e) {
          case 0x6e: push(0x0a); break; // n
          case 0x72: push(0x0d); break; // r
          case 0x74: push(0x09); break; // t
          case 0x62: push(0x08); break; // b
          case 0x66: push(0x0c); break; // f
          case 0x28: push(0x28); break;
          case 0x29: push(0x29); break;
          case 0x5c: push(0x5c); break;
          case 0x0d: // line continuation
            if (buf[p] === 0x0a) p++;
            break;
          case 0x0a:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let k = 0; k < 2 && buf[p] >= 0x30 && buf[p] <= 0x37; k++) v = v * 8 + (buf[p++] - 0x30);
              push(v & 0xff);
            } else if (e !== undefined) {
              push(e);
            }
        }
      } else if (c === 0x28) {
        depth++;
        push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        push(c);
      } else {
        push(c);
      }
    }
    this.pos = p;
    return new PDFString(Buffer.from(outBuf.subarray(0, o)), false);
  }

  readHexString() {
    const buf = this.buf;
    let p = this.pos + 1;
    const bytes = [];
    let hi = -1;
    while (p < buf.length && buf[p] !== 0x3e) {
      const v = HEX[buf[p++]];
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        bytes.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) bytes.push(hi << 4);
    this.pos = p + 1;
    return new PDFString(Buffer.from(bytes), true);
  }

  readKeyword() {
    const buf = this.buf;
    const start = this.pos;
    let p = start;
    while (p < buf.length && !WS[buf[p]] && !DELIM[buf[p]]) p++;
    if (p === start) {
      // Unknown delimiter byte – consume it to avoid infinite loops.
      this.pos = p + 1;
      return new PDFOperator(String.fromCharCode(buf[start]));
    }
    this.pos = p;
    const word = buf.toString('latin1', start, p);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new PDFOperator(word);
  }
}
