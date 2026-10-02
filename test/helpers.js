// Builds small synthetic PDFs for tests, with exact control over syntax.

import zlib from 'node:zlib';

/**
 * @param {Array<string|{dict:string, stream:Buffer|string}>} objects  object bodies, numbered from 1
 * @param {{ xrefStream?: boolean, objStm?: number[], trailer?: string, brokenOffsets?: boolean, header?: string }} [opts]
 *   objStm: object numbers to pack into an object stream (requires xrefStream)
 */
export function buildPdf(objects, opts = {}) {
  const chunks = [Buffer.from((opts.header ?? '%PDF-1.7') + '\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = new Map();
  const packed = new Set(opts.objStm || []);
  const write = (s) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    chunks.push(b);
    offset += b.length;
  };

  objects.forEach((body, i) => {
    const num = i + 1;
    if (packed.has(num)) return;
    offsets.set(num, offset);
    if (typeof body === 'string') {
      write(`${num} 0 obj\n${body}\nendobj\n`);
    } else {
      const data = Buffer.isBuffer(body.stream) ? body.stream : Buffer.from(body.stream, 'latin1');
      write(`${num} 0 obj\n<<${body.dict} /Length ${data.length}>>\nstream\n`);
      write(data);
      write('\nendstream\nendobj\n');
    }
  });

  let objStmNum = null;
  if (packed.size) {
    objStmNum = objects.length + 1;
    const nums = [...packed];
    let header = '';
    let body = '';
    for (const n of nums) {
      header += `${n} ${body.length} `;
      body += objects[n - 1] + '\n';
    }
    const content = Buffer.from(header + body, 'latin1');
    const data = zlib.deflateSync(content);
    offsets.set(objStmNum, offset);
    write(`${objStmNum} 0 obj\n<</Type /ObjStm /N ${nums.length} /First ${header.length} /Filter /FlateDecode /Length ${data.length}>>\nstream\n`);
    write(data);
    write('\nendstream\nendobj\n');
  }

  const size = (objStmNum || objects.length) + 1 + (opts.xrefStream ? 1 : 0);
  const trailer = opts.trailer ?? '/Root 1 0 R';
  const xrefOffset = offset;
  if (opts.xrefStream) {
    const xrefNum = size - 1;
    offsets.set(xrefNum, offset);
    const rows = [];
    for (let n = 0; n < size; n++) {
      const row = Buffer.alloc(7);
      if (n === 0) { row[0] = 0; row.writeUInt16BE(65535, 5); }
      else if (packed.has(n)) {
        row[0] = 2;
        row.writeUInt32BE(objStmNum, 1);
        row.writeUInt16BE([...packed].indexOf(n), 5);
      } else {
        row[0] = 1;
        row.writeUInt32BE(offsets.get(n), 1);
      }
      rows.push(row);
    }
    // PNG "Up" predictor, as produced by many writers.
    const raw = [];
    let prev = Buffer.alloc(7);
    for (const r of rows) {
      raw.push(Buffer.from([2]));
      raw.push(Buffer.from(r.map((b, i) => (b - prev[i]) & 0xff)));
      prev = r;
    }
    const data = zlib.deflateSync(Buffer.concat(raw));
    write(`${xrefNum} 0 obj\n<</Type /XRef /Size ${size} /W [1 4 2] ${trailer} /Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns 7>> /Length ${data.length}>>\nstream\n`);
    write(data);
    write('\nendstream\nendobj\n');
  } else {
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) {
      const o = (offsets.get(n) ?? 0) + (opts.brokenOffsets ? 7 : 0);
      x += `${String(o).padStart(10, '0')} 00000 n \n`;
    }
    write(x + `trailer\n<</Size ${size} ${trailer}>>\n`);
  }
  write(`startxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** A one-page PDF with a Helvetica (standard 14, WinAnsi) font and the given content. */
export function simplePage(content, { extraResources = '', extraObjects = [], ...opts } = {}) {
  return buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R>> ${extraResources}>> /Contents 4 0 R>>`,
    { dict: '', stream: content },
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
    ...extraObjects,
  ], opts);
}

export const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
