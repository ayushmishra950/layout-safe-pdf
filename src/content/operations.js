// Content stream tokenizer (ISO 32000-1, section 7.8.2 and 8.9.7 for inline
// images). Every operation remembers its exact byte span in the source so that
// untouched operations can be copied back byte-for-byte.

import { Lexer, T_ARRAY_START, T_DICT_START, T_EOF, T_ARRAY_END, T_DICT_END, WS } from '../core/lexer.js';
import { Parser } from '../core/parser.js';
import { PDFDict, PDFOperator } from '../core/objects.js';
import { serialize } from '../core/writer.js';

/**
 * @typedef {{ op: string, operands: any[], start: number, end: number, inlineImage?: { dict: PDFDict, data: Buffer } }} Operation
 */

/**
 * Parses a decoded content stream into operations.
 * @param {Buffer} buf
 * @returns {Operation[]}
 */
export function parseOperations(buf) {
  const lx = new Lexer(buf);
  const parser = new Parser(lx);
  const ops = [];
  let operands = [];
  let start = -1;

  for (;;) {
    lx.skipWhitespace();
    const tokStart = lx.pos;
    const tok = lx.next();
    if (tok === T_EOF) break;
    if (start < 0) start = tokStart;

    if (tok instanceof PDFOperator) {
      if (tok.op === 'BI') {
        const img = readInlineImage(buf, lx, parser);
        ops.push({ op: 'BI', operands: [], start, end: lx.pos, inlineImage: img });
      } else {
        ops.push({ op: tok.op, operands, start, end: lx.pos });
      }
      operands = [];
      start = -1;
      continue;
    }
    if (tok === T_ARRAY_END || tok === T_DICT_END) continue; // stray closers
    operands.push(parser.parseObject(tok));
  }
  return ops;
}

function readInlineImage(buf, lx, parser) {
  const dict = new PDFDict();
  for (;;) {
    const k = lx.next();
    if (k === T_EOF) break;
    if (k instanceof PDFOperator && k.op === 'ID') break;
    const v = parser.parseObject();
    if (k && k.name !== undefined) dict.set(k.name, v);
  }
  // Exactly one whitespace byte after ID.
  let p = lx.pos;
  if (WS[buf[p]]) p++;
  const dataStart = p;
  // Find "EI" surrounded by whitespace/EOF. Binary data may contain "EI", so
  // also require that what follows looks like normal content.
  let end = -1;
  for (let i = dataStart; i < buf.length - 1; i++) {
    if (buf[i] === 0x45 && buf[i + 1] === 0x49 && (i === dataStart || WS[buf[i - 1]]) &&
        (i + 2 >= buf.length || WS[buf[i + 2]])) {
      if (looksLikeContent(buf, i + 2)) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) end = buf.length;
  let dataEnd = end;
  if (dataEnd > dataStart && WS[buf[dataEnd - 1]]) dataEnd--;
  lx.pos = Math.min(buf.length, end + 2);
  return { dict, data: buf.subarray(dataStart, dataEnd) };
}

function looksLikeContent(buf, p) {
  const sample = buf.subarray(p, Math.min(buf.length, p + 64));
  for (const b of sample) {
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b > 0x7e)) return false;
  }
  return true;
}

/** Serializes one operation to bytes. */
export function serializeOperation(o) {
  if (o.op === 'BI' && o.inlineImage) {
    let s = 'BI';
    for (const [k, v] of o.inlineImage.dict.entries()) s += ` /${k} ${serialize(v)}`;
    return Buffer.concat([Buffer.from(s + ' ID ', 'latin1'), o.inlineImage.data, Buffer.from('\nEI', 'latin1')]);
  }
  const parts = o.operands.map((x) => serialize(x));
  parts.push(o.op);
  return Buffer.from(parts.join(' '), 'latin1');
}

/**
 * Rebuilds a content stream. Operations with a valid `start/end` and no
 * `dirty` flag are copied verbatim from `source`, so only edited operations
 * change. `replacements` maps an operation index to a list of new operations.
 * @param {Buffer} source
 * @param {Operation[]} ops
 * @param {Map<number, Operation[]>} replacements
 */
export function rebuildContent(source, ops, replacements) {
  const out = [];
  let cursor = 0;
  const sorted = [...replacements.keys()].sort((a, b) => a - b);
  for (const idx of sorted) {
    const o = ops[idx];
    out.push(source.subarray(cursor, o.start));
    const repl = replacements.get(idx);
    // Keep a token boundary between the previous operator and our first token.
    if (o.start > 0 && !WS[source[o.start - 1]]) out.push(Buffer.from(' '));
    repl.forEach((r, i) => {
      if (i > 0) out.push(Buffer.from('\n'));
      out.push(serializeOperation(r));
    });
    cursor = o.end;
  }
  out.push(source.subarray(cursor));
  return Buffer.concat(out);
}
