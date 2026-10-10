// Carlito font access for the resume generator: width measuring + subset embedding data.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TrueTypeFont } from '../src/fonts/truetype.js';
import { buildToUnicodeCMap } from '../src/fonts/embedder.js';

const TTC = fileURLToPath(new URL('./fonts/Carlito.ttc', import.meta.url));
const INDEX = { regular: 0, italic: 1, bold: 3 };

const NORMALIZE = new Map([
  [' ', ' '], [' ', ' '], [' ', ' '], ['\t', ' '],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['−', '-'],
  ['​', ''], ['‌', ''], ['‍', ''], ['﻿', ''],
]);

export class Face {
  constructor(ttf) {
    this.ttf = ttf;
    this.used = new Map(); // gid -> unicode string
    this.missing = new Set();
    this.cache = new Map();
  }

  /** Cleans a string so every character exists in the font. */
  clean(text) {
    let out = '';
    for (const ch of String(text)) {
      const c = NORMALIZE.has(ch) ? NORMALIZE.get(ch) : ch;
      for (const x of c) {
        if (x === '\n' || x === '\r') { out += ' '; continue; }
        if (this.ttf.glyphForCodePoint(x.codePointAt(0)) === 0) { this.missing.add(x); out += '?'; } else out += x;
      }
    }
    return out;
  }

  /** Width in points. */
  width(text, size) {
    let w = 0;
    for (const ch of text) {
      let a = this.cache.get(ch);
      if (a === undefined) {
        a = this.ttf.advance1000(this.ttf.glyphForCodePoint(ch.codePointAt(0)));
        this.cache.set(ch, a);
      }
      w += a;
    }
    return (w * size) / 1000;
  }

  /** Hex-encodes text as 2-byte glyph ids and records usage. */
  encode(text) {
    let hex = '';
    for (const ch of text) {
      const gid = this.ttf.glyphForCodePoint(ch.codePointAt(0)) || this.ttf.glyphForCodePoint(63);
      this.used.set(gid, ch);
      hex += gid.toString(16).padStart(4, '0');
    }
    return hex;
  }

  /** Subset font program + metrics needed for the PDF font objects. */
  embedData(tag) {
    const ttf = this.ttf;
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const scale = (v) => Math.round((v * 1000) / ttf.unitsPerEm);
    const W = [];
    for (let i = 0; i < gids.length; ) {
      const ws = [ttf.advance1000(gids[i])];
      let j = i + 1;
      while (j < gids.length && gids[j] === gids[j - 1] + 1) ws.push(ttf.advance1000(gids[j++]));
      W.push(`${gids[i]} [${ws.join(' ')}]`);
      i = j;
    }
    return {
      name: `${tag}+${ttf.postScriptName}`,
      program: ttf.subset(gids),
      toUnicode: buildToUnicodeCMap(this.used),
      widths: W.join(' '),
      flags: ttf.flags,
      bbox: ttf.bbox.map(scale),
      italicAngle: ttf.italicAngle,
      ascent: scale(ttf.typoAscender ?? ttf.ascent),
      descent: scale(ttf.typoDescender ?? ttf.descent),
      capHeight: scale(ttf.capHeight),
      stemV: Math.round(10 + 220 * Math.max(0, (ttf.weightClass - 50) / 900) ** 2),
    };
  }
}

export function loadFaces() {
  const buf = fs.readFileSync(TTC);
  const faces = {};
  for (const [k, i] of Object.entries(INDEX)) {
    const ttf = new TrueTypeFont(buf, i);
    if (!ttf.embeddingAllowed) throw new Error('Carlito embedding not allowed');
    faces[k] = new Face(ttf);
  }
  return faces;
}
