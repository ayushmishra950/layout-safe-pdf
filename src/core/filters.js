// Stream filters (ISO 32000-1, section 7.4).

import zlib from 'node:zlib';
import { HEX, WS } from './lexer.js';
import { PDFDict, PDFName, num } from './objects.js';
import { limits, PDFLimitError } from './limits.js';

const tooBig = () => new PDFLimitError(`Decoded stream exceeds the ${Math.round(limits.maxStreamSize / 1048576)} MB limit (setLimits({ maxStreamSize }) to raise it)`);
const isSizeError = (e) => e instanceof RangeError || /maxOutputLength|larger than|buffer length/i.test(e.message);

export class UnsupportedFilterError extends Error {}

/** Image codecs that we keep encoded (we never need their pixels for editing). */
export const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'DCT', 'CCF']);

const ABBREVIATIONS = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

/**
 * Returns the list of [filterName, decodeParms] for a stream dictionary.
 * @param {PDFDict} dict
 * @param {(v:any)=>any} resolve
 */
export function getFilters(dict, resolve = (v) => v) {
  let f = resolve(dict.get('Filter'));
  let p = resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  if (!f) return [];
  if (!Array.isArray(f)) f = [f];
  if (!Array.isArray(p)) p = [p];
  return f.map((name, i) => {
    const n = resolve(name);
    const full = n instanceof PDFName ? ABBREVIATIONS[n.name] || n.name : String(n);
    const parms = resolve(p[i]);
    return [full, parms instanceof PDFDict ? parms : null];
  });
}

/**
 * Applies a single decode filter.
 * @param {string} name
 * @param {Buffer} data
 * @param {PDFDict|null} parms
 * @param {(v:any)=>any} resolve
 */
export function decodeFilter(name, data, parms, resolve = (v) => v) {
  switch (name) {
    case 'FlateDecode':
      return applyPredictor(inflate(data), parms, resolve);
    case 'LZWDecode': {
      const early = parms ? num(resolve(parms.get('EarlyChange')), 1) : 1;
      return applyPredictor(lzwDecode(data, early), parms, resolve);
    }
    case 'ASCIIHexDecode':
      return asciiHexDecode(data);
    case 'ASCII85Decode':
      return ascii85Decode(data);
    case 'RunLengthDecode':
      return runLengthDecode(data);
    case 'Crypt':
      return data; // Identity crypt filter; real decryption is done by the security handler.
    default:
      throw new UnsupportedFilterError(`Unsupported filter: ${name}`);
  }
}

/**
 * Decodes stream data through its whole filter chain. Stops (and reports) at
 * image codecs, returning data that is still encoded with those codecs.
 * @returns {{ data: Buffer, remaining: Array<[string, PDFDict|null]> }}
 */
export function decodeChain(data, filters, resolve) {
  let out = data;
  for (let i = 0; i < filters.length; i++) {
    const [name, parms] = filters[i];
    if (IMAGE_FILTERS.has(name)) return { data: out, remaining: filters.slice(i) };
    out = decodeFilter(name, out, parms, resolve);
  }
  return { data: out, remaining: [] };
}

// ---- Flate -------------------------------------------------------------------

export function inflate(data) {
  const max = limits.maxStreamSize;
  const attempts = [
    () => zlib.inflateSync(data, { maxOutputLength: max }),
    // Truncated / slightly corrupt streams: recover what we can.
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: max }),
    // Missing or broken zlib header: try raw deflate.
    () => zlib.inflateRawSync(data.subarray(2), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: max }),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: max }),
  ];
  let last;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (e) {
      if (isSizeError(e)) throw tooBig();
      last = e;
    }
  }
  throw last;
}

export function deflate(data) {
  return zlib.deflateSync(data, { level: 6 });
}

// ---- Predictors (TIFF 2, PNG 10-15) -----------------------------------------

export function applyPredictor(data, parms, resolve = (v) => v) {
  if (!parms) return data;
  const predictor = num(resolve(parms.get('Predictor')), 1);
  if (predictor <= 1) return data;
  const colors = num(resolve(parms.get('Colors')), 1);
  const bpc = num(resolve(parms.get('BitsPerComponent')), 8);
  const columns = num(resolve(parms.get('Columns')), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    // TIFF predictor 2: each component is stored as the difference to its left neighbour.
    if (!(rowLen > 0) || rowLen > data.length) return data;
    const out = Buffer.from(data);
    if (bpc < 8) {
      const mask = (1 << bpc) - 1;
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        const prev = new Array(colors).fill(0);
        let bit = 0;
        for (let x = 0; x < columns; x++) {
          for (let c = 0; c < colors; c++, bit += bpc) {
            const byte = r + (bit >> 3);
            const shift = 8 - bpc - (bit & 7);
            const v = (((out[byte] >> shift) & mask) + prev[c]) & mask;
            prev[c] = v;
            out[byte] = (out[byte] & ~(mask << shift)) | (v << shift);
          }
        }
      }
    } else if (bpc === 8) {
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
      }
    } else if (bpc === 16) {
      for (let r = 0; r + rowLen <= out.length; r += rowLen) {
        for (let i = bpp; i + 1 < rowLen; i += 2) {
          const v = (out.readUInt16BE(r + i) + out.readUInt16BE(r + i - bpp)) & 0xffff;
          out.writeUInt16BE(v, r + i);
        }
      }
    }
    return out;
  }

  // PNG predictors: each row is prefixed with a filter-type byte.
  if (!(rowLen > 0) || rowLen > data.length) return data; // nonsensical /Columns: leave as is
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const src = (rowLen + 1) * r;
    const type = data[src];
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + 1 + i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: {
          const pp = left + up - upLeft;
          const pa = Math.abs(pp - left);
          const pb = Math.abs(pp - up);
          const pc = Math.abs(pp - upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: v = raw;
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

// ---- LZW ---------------------------------------------------------------------

export function lzwDecode(data, earlyChange = 1) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256 clear, 257 EOD
  };
  reset();
  let codeLen = 9;
  let bitBuf = 0;
  let bitCount = 0;
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    bitBuf = (bitBuf << 8) | data[i];
    bitCount += 8;
    while (bitCount >= codeLen) {
      const code = (bitBuf >>> (bitCount - codeLen)) & ((1 << codeLen) - 1);
      bitCount -= codeLen;
      bitBuf &= (1 << bitCount) - 1;
      if (code === 256) {
        reset();
        codeLen = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (prev) entry = prev.concat(prev[0]);
      else continue;
      if (out.length + entry.length > limits.maxStreamSize) throw tooBig();
      for (const b of entry) out.push(b);
      if (prev) dict.push(prev.concat(entry[0]));
      prev = entry;
      const next = dict.length + earlyChange;
      if (next >= 4096) codeLen = 12;
      else if (next >= 2048) codeLen = 12;
      else if (next >= 1024) codeLen = 11;
      else if (next >= 512) codeLen = 10;
      else codeLen = 9;
    }
  }
  return Buffer.from(out);
}

// ---- ASCII filters & RunLength -------------------------------------------------

export function asciiHexDecode(data) {
  const out = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = HEX[c];
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return Buffer.from(out);
}

export function ascii85Decode(data) {
  const out = [];
  const group = [];
  let i = 0;
  // Skip optional "<~" prefix.
  while (i < data.length && WS[data[i]]) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (WS[c]) continue;
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

export function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]);
    } else {
      const b = data[i++];
      for (let k = 0; k < 257 - len; k++) out.push(b);
    }
  }
  return Buffer.from(out);
}
