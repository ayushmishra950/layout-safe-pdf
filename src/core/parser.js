// Builds PDF objects out of lexer tokens (ISO 32000-1, sections 7.3 and 7.3.10).

import {
  Lexer, T_ARRAY_START, T_ARRAY_END, T_DICT_START, T_DICT_END, T_EOF, T_BRACE_START, T_BRACE_END,
} from './lexer.js';
import { PDFDict, PDFName, PDFNumber, PDFOperator, PDFRef, PDFStream, num } from './objects.js';
import { limits, PDFLimitError } from './limits.js';

export class PDFSyntaxError extends Error {}

const isInt = (t) => t instanceof PDFNumber && Number.isInteger(t.value) && !t.raw.includes('.');

export class Parser {
  /** @param {Lexer} lexer */
  constructor(lexer) {
    this.lexer = lexer;
    this.buf = lexer.buf;
    this.depth = 0;
  }

  /**
   * Parses one object. Handles "num gen R" references by look-ahead.
   * @param {any} [first] an already-read token
   */
  parseObject(first) {
    const lx = this.lexer;
    const tok = first === undefined ? lx.next() : first;
    if (tok === T_ARRAY_START || tok === T_DICT_START) {
      if (this.depth + 1 > limits.maxNestingDepth) {
        throw new PDFLimitError(`Objects nested deeper than ${limits.maxNestingDepth} levels`);
      }
      this.depth++;
      try {
        return this.#parseContainer(tok);
      } finally {
        this.depth--;
      }
    }
    return this.#parseScalar(tok);
  }

  #parseContainer(tok) {
    const lx = this.lexer;

    if (tok === T_ARRAY_START) {
      const arr = [];
      for (;;) {
        const t = lx.next();
        if (t === T_ARRAY_END || t === T_EOF) break;
        if (t instanceof PDFOperator && (t.op === 'endobj' || t.op === 'obj')) {
          break; // malformed: unterminated array
        }
        arr.push(this.parseObject(t));
      }
      return arr;
    }

    if (tok === T_DICT_START) {
      const dict = new PDFDict();
      for (;;) {
        const k = lx.next();
        if (k === T_DICT_END || k === T_EOF) break;
        if (!(k instanceof PDFName)) {
          if (k instanceof PDFOperator && (k.op === 'endobj' || k.op === 'stream')) break;
          continue; // skip junk keys leniently
        }
        const save = lx.pos;
        const vt = lx.next();
        if (vt === T_DICT_END) {
          dict.set(k.name, null);
          break;
        }
        if (vt instanceof PDFOperator && (vt.op === 'endobj' || vt.op === 'stream')) {
          lx.pos = save;
          break;
        }
        const v = this.parseObject(vt);
        // A null value is equivalent to the key being absent.
        if (v !== null) dict.set(k.name, v);
      }
      return dict;
    }

    return null;
  }

  #parseScalar(tok) {
    const lx = this.lexer;
    if (isInt(tok)) {
      // Look ahead for "gen R".
      const save = lx.pos;
      const t2 = lx.next();
      if (isInt(t2)) {
        const t3 = lx.next();
        if (t3 instanceof PDFOperator && t3.op === 'R') {
          return new PDFRef(tok.value, t2.value);
        }
      }
      lx.pos = save;
      return tok;
    }

    if (tok === T_BRACE_START || tok === T_BRACE_END) {
      // PostScript calculator functions – return as operator token.
      return new PDFOperator(tok === T_BRACE_START ? '{' : '}');
    }

    if (tok === T_EOF) return null;
    return tok; // number, string, name, boolean, null, operator
  }

  /**
   * Parses "num gen obj ... endobj" at the current position.
   * @param {(ref: any) => any} resolveLength resolves an indirect /Length
   * @returns {{ num: number, gen: number, value: any }}
   */
  parseIndirectObject(resolveLength) {
    const lx = this.lexer;
    const n = lx.next();
    const g = lx.next();
    const o = lx.next();
    if (!isInt(n) || !isInt(g) || !(o instanceof PDFOperator) || o.op !== 'obj') {
      throw new PDFSyntaxError(`Expected indirect object at offset ${lx.pos}`);
    }
    let value = this.parseObject();

    // Stream?
    const save = lx.pos;
    const t = lx.next();
    if (t instanceof PDFOperator && t.op === 'stream' && value instanceof PDFDict) {
      value = this.readStreamBody(value, resolveLength);
    } else {
      lx.pos = save;
    }
    return { num: n.value, gen: g.value, value };
  }

  /** Reads stream data after the `stream` keyword. */
  readStreamBody(dict, resolveLength) {
    const lx = this.lexer;
    const buf = this.buf;
    let p = lx.pos;
    // "stream" is followed by CRLF or LF (sometimes just CR in broken files).
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;
    const start = p;

    let length = dict.get('Length');
    if (length instanceof PDFRef) {
      try {
        length = resolveLength ? resolveLength(length) : undefined;
      } catch {
        length = undefined;
      }
    }
    length = num(length, -1);

    let end = -1;
    if (length >= 0 && start + length <= buf.length) {
      // Verify that "endstream" follows the declared length.
      const tail = new Lexer(buf, start + length);
      tail.skipWhitespace();
      if (buf.toString('latin1', tail.pos, tail.pos + 9) === 'endstream') {
        end = start + length;
        lx.pos = tail.pos + 9;
      }
    }
    if (end < 0) {
      // Recover: search for endstream.
      const idx = buf.indexOf('endstream', start, 'latin1');
      if (idx < 0) throw new PDFSyntaxError('Unterminated stream');
      end = idx;
      // Strip EOL that precedes "endstream".
      if (buf[end - 1] === 0x0a) end--;
      if (buf[end - 1] === 0x0d) end--;
      lx.pos = idx + 9;
    }
    return new PDFStream(dict, buf.subarray(start, end));
  }
}
