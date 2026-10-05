// Long-running use (e.g. a web server) must not accumulate memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, TextEditor, editPdf, extractText, PDFName } from '../src/index.js';
import { buildPdf, FIXTURES } from './helpers.js';

const canGC = typeof global.gc === 'function';
const settle = async () => {
  for (let k = 0; k < 3; k++) {
    global.gc();
    await new Promise((r) => setImmediate(r));
  }
};
const rnd = () => Math.random().toString(36).slice(2, 10);
const uniquePdf = () => buildPdf([
  '<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
  `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R ${Array.from({ length: 30 }, () => `/R${rnd()} 5 0 R`).join(' ')}>>>> /Contents 4 0 R>>`,
  { dict: '', stream: 'BT /F1 12 Tf 72 700 Td (Hello Rahul) Tj ET' },
  `<</Type /Font /Subtype /Type1 /BaseFont /${rnd().toUpperCase()}+Helvetica /Encoding /WinAnsiEncoding>>`,
]);

test('names from finished documents are released (no growth across requests)', { skip: !canGC && 'run with --expose-gc' }, async () => {
  await settle();
  const baseline = PDFName.internedCount;
  for (let i = 0; i < 300; i++) {
    const { report } = await editPdf(uniquePdf(), [{ search: 'Rahul', replace: 'Priyank' }], { editor: { useSystemFonts: false } });
    assert.equal(report.ok, true);
    await new Promise((r) => setImmediate(r)); // like separate server requests
  }
  await settle();
  // 300 documents x ~32 unique names would be ~9,600 entries without release.
  assert.ok(PDFName.internedCount < baseline + 100, `interned names: ${PDFName.internedCount} (baseline ${baseline})`);
});

test('names stay identical (===) while a document is alive, across GCs', { skip: !canGC && 'run with --expose-gc' }, async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-invoice.pdf');
  await settle(); // names held only by the document must survive
  const r = new TextEditor(doc).replace({ search: 'Rahul Sharma', replace: 'Priyank Dadhich' });
  assert.equal(r.replaced, 1);
  await settle();
  const out = new PDFDocument(doc.save());
  assert.match(extractText(out, 0), /Customer Name: Priyank Dadhich/);
  assert.equal(PDFName.of('XRef'), PDFName.of('XRef'));
});
