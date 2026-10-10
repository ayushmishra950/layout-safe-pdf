// Minimal PDF writer for the resume generator (pure Node: zlib + crypto + Buffer).

import zlib from 'node:zlib';
import crypto from 'node:crypto';

const num = (n) => (Math.round(n * 100) / 100).toString();
const pdfStr = (s) => '(' + String(s).replace(/[\\()]/g, '\\$&') + ')';
const utf16Hex = (s) => '<FEFF' + Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase() + '>';
const tagFor = (seed) => {
  const h = crypto.createHash('md5').update(seed).digest();
  return Array.from({ length: 6 }, (_, i) => String.fromCharCode(65 + (h[i] % 26))).join('');
};

/**
 * @param {{pages: {ops: string, links: {rect:number[], url:string}[]}[], faces: Record<string, import('./font.js').Face>,
 *   width: number, height: number, info: {title?: string, author?: string, subject?: string, keywords?: string}}} spec
 */
export function writePdf({ pages, faces, width, height, info }) {
  const objs = []; // index = id - 1, value = Buffer
  const alloc = () => { objs.push(null); return objs.length; };
  const put = (id, body) => { objs[id - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'); };
  const stream = (dict, data, compress = true) => {
    const raw = Buffer.from(data);
    const body = compress ? zlib.deflateSync(raw) : raw;
    return Buffer.concat([
      Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  };

  const catalog = alloc();
  const pagesId = alloc();
  const infoId = alloc();

  // Fonts (one Type0/CIDFontType2 per used face)
  const fontRefs = {};
  const fontNames = { regular: 'F1', bold: 'F2', italic: 'F3' };
  for (const [key, face] of Object.entries(faces)) {
    if (!face.used.size) continue;
    const d = face.embedData(tagFor(key + [...face.used.keys()].join(',')));
    const type0 = alloc(), cid = alloc(), desc = alloc(), file = alloc(), tou = alloc();
    put(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${d.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tou} 0 R >>`);
    put(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${d.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${d.widths}] /CIDToGIDMap /Identity >>`);
    put(desc, `<< /Type /FontDescriptor /FontName /${d.name} /Flags ${d.flags} /FontBBox [${d.bbox.join(' ')}] /ItalicAngle ${num(d.italicAngle)} /Ascent ${d.ascent} /Descent ${d.descent} /CapHeight ${d.capHeight} /StemV ${d.stemV} /FontFile2 ${file} 0 R >>`);
    put(file, stream(`/Length1 ${d.program.length}`, d.program));
    put(tou, stream('', d.toUnicode));
    fontRefs[fontNames[key]] = type0;
  }
  const fontDict = Object.entries(fontRefs).map(([n, id]) => `/${n} ${id} 0 R`).join(' ');

  const pageIds = [];
  for (const p of pages) {
    const content = alloc(), page = alloc();
    put(content, stream('', p.ops));
    const annotIds = p.links.map((l) => {
      const a = alloc();
      put(a, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(l.url)} >> >>`);
      return a;
    });
    put(page, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << ${fontDict} >> >> /Contents ${content} 0 R${annotIds.length ? ` /Annots [${annotIds.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`);
    pageIds.push(page);
  }
  put(pagesId, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  put(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>`);
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const date = `D:${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  put(infoId, `<< /Producer (layout-safe-pdf resume) /CreationDate (${date})${info.title ? ` /Title ${utf16Hex(info.title)}` : ''}${info.author ? ` /Author ${utf16Hex(info.author)}` : ''}${info.subject ? ` /Subject ${utf16Hex(info.subject)}` : ''} >>`);

  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    pos += chunk.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
