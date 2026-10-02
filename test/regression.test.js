// Regression tests for bugs found in the full audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, TextEditor, extractText, ContentInterpreter } from '../src/index.js';
import { createEncryptionDict, SecurityHandler } from '../src/core/crypt.js';
import { serialize } from '../src/core/writer.js';
import { Lexer } from '../src/core/lexer.js';
import { Parser } from '../src/core/parser.js';
import { PDFString, PDFDict } from '../src/core/objects.js';
import { applyPredictor } from '../src/core/filters.js';
import { parseCMap, predefinedCMap } from '../src/fonts/cmap.js';
import { standardWidth } from '../src/fonts/standard14.js';
import { buildPdf, simplePage, FIXTURES } from './helpers.js';

const reload = (doc) => new PDFDocument(doc.save());
const positions = (doc) => {
  const it = new ContentInterpreter(doc);
  it.runPage(doc.getPage(0));
  return it.shows.flatMap((s) => s.glyphs).map((g) => [g.unicode, +g.x.toFixed(2)]);
};

test('encrypted file with the catalog inside an object stream opens', () => {
  const enc = createEncryptionDict({ userPassword: '' });
  const id = Buffer.alloc(16, 7);
  const sec = new SecurityHandler(enc, id, '');
  const objs = ['<</Type/Catalog/Pages 3 0 R>>', '<</Type/Pages/Kids[4 0 R]/Count 1>>', '<</Type/Page/Parent 3 0 R/MediaBox[0 0 100 100]>>'];
  let body = '';
  const offs = [];
  for (const o of objs) { offs.push(body.length); body += o + '\n'; }
  const hdr = `2 ${offs[0]} 3 ${offs[1]} 4 ${offs[2]} `;
  const data = sec.encryptStream(1, 0, zlib.deflateSync(Buffer.from(hdr + body, 'latin1')));
  const chunks = [Buffer.from('%PDF-1.7\n')];
  let off = chunks[0].length;
  const xo = {};
  const add = (b) => { chunks.push(b); off += b.length; };
  xo[1] = off;
  add(Buffer.concat([Buffer.from(`1 0 obj\n<</Type/ObjStm/N 3/First ${hdr.length}/Filter/FlateDecode/Length ${data.length}>>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n')]));
  xo[5] = off;
  add(Buffer.from(`5 0 obj\n${serialize(enc)}\nendobj\n`, 'latin1'));
  const xrefOff = off;
  const rows = Buffer.alloc(7 * 7);
  const put = (i, t, a, b) => { rows[i * 7] = t; rows.writeUInt32BE(a, i * 7 + 1); rows.writeUInt16BE(b, i * 7 + 5); };
  put(0, 0, 0, 65535); put(1, 1, xo[1], 0); put(2, 2, 1, 0); put(3, 2, 1, 1); put(4, 2, 1, 2); put(5, 1, xo[5], 0); put(6, 1, xrefOff, 0);
  add(Buffer.concat([
    Buffer.from(`6 0 obj\n<</Type/XRef/Size 7/W[1 4 2]/Root 2 0 R/Encrypt 5 0 R/ID[<${id.toString('hex')}><${id.toString('hex')}>]/Length ${rows.length}>>\nstream\n`, 'latin1'),
    rows, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOff}\n%%EOF\n`),
  ]));
  const doc = new PDFDocument(Buffer.concat(chunks));
  assert.equal(doc.repaired, false);
  assert.equal(doc.pageCount, 1);
});

test('names are written back byte-exact', () => {
  const name = new Parser(new Lexer(Buffer.from('/Caf#C3#A9'))).parseObject();
  assert.equal(serialize(name).toLowerCase(), '/caf#c3#a9');
});

test('junk before %PDF: incremental save stays readable without repair', async () => {
  const src = await PDFDocument.load(FIXTURES + 'quartz-text.pdf');
  const junk = Buffer.concat([Buffer.from('JUNKJUNK\n'), src.buf]);
  const doc = new PDFDocument(junk);
  assert.equal(doc.repaired, false);
  doc.getPage(0).setContentBytes(Buffer.from('BT ET'));
  const again = reload(doc);
  assert.equal(again.repaired, false);
  assert.equal(again.getPage(0).getContentBytes().toString().trim(), 'BT ET');
});

test('xref subsection with an overstated count does not force a repair', () => {
  const buf = simplePage('BT ET');
  const text = buf.toString('latin1').replace(/xref\n0 (\d+)\n/, (m, n) => `xref\n0 ${Number(n) + 2}\n`);
  const doc = new PDFDocument(Buffer.from(text, 'latin1'));
  assert.equal(doc.repaired, false);
  assert.equal(doc.pageCount, 1);
});

test('not a PDF: clear error', () => {
  assert.throws(() => new PDFDocument(zlib.gzipSync(Buffer.from('hello'))), /Not a PDF/);
});

test('PDFDocEncoding text strings and TIFF predictor with 4 bpc', () => {
  assert.equal(new PDFString(Buffer.from([0x8d, 0x41, 0x84, 0x8e])).toText(), '“A—”');
  const parms = new PDFDict().set('Predictor', 2).set('BitsPerComponent', 4).set('Columns', 4);
  assert.equal(applyPredictor(Buffer.from([0x11, 0x11]), parms).toString('hex'), '1234');
});

test('CMap: usecmap Identity does not override explicit cid ranges', () => {
  const cmap = parseCMap(Buffer.from('/Identity-H usecmap 1 begincidrange <0000> <00FF> 500 endcidrange'), predefinedCMap);
  assert.equal(cmap.lookupCID(0x10), 516);
  assert.equal(cmap.lookupCID(0x1234), 0x1234);
});

test('Symbol font built-in encoding and Times-BoldItalic metrics', () => {
  const doc = new PDFDocument(buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
    { dict: '', stream: 'BT /F1 12 Tf 10 100 Td (abp \\245) Tj ET' },
    '<</Type /Font /Subtype /Type1 /BaseFont /Symbol>>',
  ]));
  assert.equal(extractText(doc, 0), 'αβπ ∞');
  assert.equal(standardWidth('Times-BoldItalic', 'A'), 667);
});

test('a gap-only space at the match edge is not inserted twice', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td [(Hello) -278 (World)] TJ ET'));
  const before = positions(doc);
  new TextEditor(doc).replace({ search: ' World', replace: ' Earth', mode: 'preserve' });
  const after = positions(reload(doc));
  assert.equal(after[5][0], 'E');
  assert.equal(after[5][1], before[5][1], 'E lands where W was');
});

test('$ patterns in matched text are not expanded; case-insensitive search with İ', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Price $$ only) Tj ET'));
  new TextEditor(doc).replace({ search: '$$', replace: '[$&]' });
  assert.equal(extractText(reload(doc), 0), 'Price [$$] only');
});

test('maxCount counts only successful replacements', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (cat cat) Tj ET'));
  const r = new TextEditor(doc, { useSystemFonts: false }).replace({ search: 'cat', replace: 'cow', maxCount: 1 });
  assert.equal(r.replaced, 1);
  assert.equal(extractText(reload(doc), 0), 'cow cat');
});

test('a form XObject shared by two pages is edited once', () => {
  const doc = new PDFDocument(buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</XObject <</H 6 0 R>>>> /Contents 5 0 R>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</XObject <</H 6 0 R>>>> /Contents 5 0 R>>',
    { dict: '', stream: '/H Do' },
    { dict: '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources <</Font <</F1 7 0 R>>>>', stream: 'BT /F1 12 Tf 72 700 Td (Header cat here) Tj ET' },
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
  ]));
  const r = new TextEditor(doc).replace({ search: 'cat', replace: 'cats' });
  assert.equal(r.replaced, 1);
  const out = reload(doc);
  assert.equal(extractText(out, 0), 'Header cats here');
  assert.equal(extractText(out, 1), 'Header cats here');
});

test('two paragraphs re-wrapped in the same text object are both kept', () => {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
  const lines = [];
  let y = 700;
  for (const p of ['FOO', 'BAR']) {
    for (let i = 0; i < 3; i++) {
      lines.push(`1 0 0 1 72 ${y} Tm (${i === 0 ? p + ' ' : ''}${words}) Tj`);
      y -= 14;
    }
    y -= 20;
  }
  const doc = new PDFDocument(simplePage(`BT /F1 12 Tf ${lines.join(' ')} ET`));
  const r = new TextEditor(doc).replace({ search: /FOO|BAR/, replace: (m) => `${m} with a considerably longer replacement text` });
  assert.equal(r.replaced, 2);
  const text = extractText(reload(doc), 0).replace(/\s+/g, ' ');
  assert.ok(text.includes('FOO with a considerably longer replacement text alpha'));
  assert.ok(text.includes('BAR with a considerably longer replacement text alpha'));
});

// ---- hostile input (denial of service) -------------------------------------------------

import { PDFLimitError, setLimits, limits } from '../src/index.js';

const page = (content) => buildPdf([
  '<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
  '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
  content, '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>']);

test('limits: decompression bomb is refused, not inflated', () => {
  const old = limits.maxStreamSize;
  setLimits({ maxStreamSize: 1024 * 1024 });
  try {
    const doc = new PDFDocument(page({ dict: '/Filter /FlateDecode', stream: zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024)) }));
    assert.throws(() => extractText(doc, 0), PDFLimitError);
  } finally {
    setLimits({ maxStreamSize: old });
  }
});

test('limits: deep nesting, bogus predictor columns and object-stream counts', () => {
  const deep = new PDFDocument(page({ dict: '', stream: '['.repeat(100000) + ' BT ET' }));
  assert.throws(() => extractText(deep, 0), PDFLimitError);
  const cols = new PDFDocument(page({ dict: '/Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns 2000000000 /Colors 4>>', stream: zlib.deflateSync(Buffer.from('BT ET')) }));
  assert.equal(extractText(cols, 0), '');
  const objStm = buildPdf(['<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>', '<</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>>'], { xrefStream: true, objStm: [1, 2, 3] });
  const bogus = new PDFDocument(Buffer.from(objStm.toString('latin1').replace('/N 3', '/N 999999999'), 'latin1'));
  assert.equal(bogus.pageCount, 1);
});

test('limits: a page with too many glyphs is refused', () => {
  const old = limits.maxGlyphsPerPage;
  setLimits({ maxGlyphsPerPage: 1000 });
  try {
    const doc = new PDFDocument(page({ dict: '', stream: `BT /F1 12 Tf (${'A'.repeat(5000)}) Tj ET` }));
    assert.throws(() => extractText(doc, 0), PDFLimitError);
  } finally {
    setLimits({ maxGlyphsPerPage: old });
  }
});

test('signed documents are detected and editing them warns', () => {
  const doc = new PDFDocument(buildPdf([
    '<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R] /SigFlags 3>>>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
    { dict: '', stream: 'BT /F1 12 Tf 10 100 Td (Hello) Tj ET' }, '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
    '<</FT /Sig /T (Signature1) /V <</Type /Sig /Name (Signer) /Filter /Adobe.PPKLite>>>>',
  ]));
  assert.deepEqual(doc.signatures, [{ name: 'Signature1', signer: 'Signer' }]);
  const r = new TextEditor(doc).replace({ search: 'Hello', replace: 'Hi' });
  assert.match(r.warnings[0], /digitally signed/);
});
