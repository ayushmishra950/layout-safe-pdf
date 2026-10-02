import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Lexer } from '../src/core/lexer.js';
import { Parser } from '../src/core/parser.js';
import { PDFDict, PDFName, PDFRef, PDFStream, PDFString, N } from '../src/core/objects.js';
import { ascii85Decode, asciiHexDecode, lzwDecode, runLengthDecode, applyPredictor } from '../src/core/filters.js';
import { rc4 } from '../src/core/crypt.js';
import { PDFDocument, PDFPasswordError } from '../src/index.js';
import { buildPdf, simplePage, FIXTURES } from './helpers.js';

const parse = (s) => new Parser(new Lexer(Buffer.from(s, 'latin1'))).parseObject();

test('lexer: literal strings with escapes, nesting and octal', () => {
  const s = parse('(a\\(b\\) (nested) \\101\\n\\\\ end)');
  assert.equal(s.bytes.toString('latin1'), 'a(b) (nested) A\n\\ end');
  const cont = parse('(line\\\ncontinued)');
  assert.equal(cont.bytes.toString('latin1'), 'linecontinued');
});

test('lexer: hex strings, names with # escapes, numbers', () => {
  assert.deepEqual([...parse('<48 65 6C6C 6>').bytes], [0x48, 0x65, 0x6c, 0x6c, 0x60]);
  assert.equal(parse('/A#20B').name, 'A B');
  assert.equal(parse('-.5').value, -0.5);
  assert.equal(parse('+17').value, 17);
});

test('parser: dictionaries, arrays and references', () => {
  const d = parse('<</Type /Page /Kids [1 0 R 2 0 R] /N null /Box [0 0 612.5 792]>>');
  assert.ok(d instanceof PDFDict);
  assert.equal(d.get('Type'), N('Page'));
  assert.ok(d.get('Kids')[1] instanceof PDFRef);
  assert.equal(d.get('Kids')[1].num, 2);
  assert.equal(d.has('N'), false, 'null values are dropped');
  assert.equal(d.get('Box')[2].value, 612.5);
});

test('filters: ASCIIHex, ASCII85, RunLength, LZW (spec example)', () => {
  assert.equal(asciiHexDecode(Buffer.from('48 65 6c6c6f>')).toString(), 'Hello');
  assert.equal(ascii85Decode(Buffer.from('87cURD]i,"Ebo80~>')).toString(), 'Hello World!');
  assert.equal(ascii85Decode(Buffer.from('<~z~>')).length, 4);
  assert.equal(runLengthDecode(Buffer.from([2, 0x61, 0x62, 0x63, 254, 0x7a, 128])).toString(), 'abczzz');
  // ISO 32000-1, 7.4.4.2 example
  const lzw = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
  assert.equal(lzwDecode(lzw).toString('latin1'), '-----A---B');
});

test('filters: PNG Up predictor', () => {
  const rows = Buffer.from([2, 1, 2, 3, 2, 1, 1, 1]);
  const parms = new PDFDict().set('Predictor', 12).set('Columns', 3);
  assert.deepEqual([...applyPredictor(rows, parms)], [1, 2, 3, 2, 3, 4]);
});

test('crypt: RC4 test vector', () => {
  assert.equal(rc4(Buffer.from('Key'), Buffer.from('Plaintext')).toString('hex'), 'bbf316e8d940af0ad3');
});

test('document: classic xref, pages and content', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET'));
  assert.equal(doc.pageCount, 1);
  assert.deepEqual(doc.getPage(0).mediaBox, [0, 0, 612, 792]);
  assert.match(doc.getPage(0).getContentBytes().toString(), /Hello/);
  assert.equal(doc.warnings.length, 0);
});

test('document: xref stream with PNG predictor and object stream', () => {
  const buf = buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R>>',
    { dict: '', stream: 'BT ET' },
  ], { xrefStream: true, objStm: [1, 2, 3] });
  const doc = new PDFDocument(buf);
  assert.equal(doc.lastXrefIsStream, true);
  assert.equal(doc.pageCount, 1);
  assert.deepEqual(doc.getPage(0).mediaBox, [0, 0, 200, 200]);
  assert.equal(doc.warnings.length, 0);

  // Incremental update after an xref stream uses an xref stream too.
  const page = doc.getPage(0);
  page.setContentBytes(Buffer.from('BT /F1 9 Tf ET'));
  const out = doc.save();
  assert.ok(out.subarray(0, buf.length).equals(buf), 'original bytes untouched');
  const again = new PDFDocument(out);
  assert.equal(again.warnings.length, 0);
  assert.equal(again.getPage(0).getContentBytes().toString().trim(), 'BT /F1 9 Tf ET');
});

test('document: broken xref offsets are repaired', () => {
  const doc = new PDFDocument(simplePage('BT ET', { brokenOffsets: true }));
  assert.equal(doc.pageCount, 1);
  assert.ok(doc.warnings.some((w) => /scanning/.test(w)));
  doc.getPage(0).setContentBytes(Buffer.from('BT (fixed) Tj ET'));
  for (const incremental of [true, false]) {
    const again = new PDFDocument(doc.save({ incremental }));
    assert.equal(again.pageCount, 1);
    assert.match(again.getPage(0).getContentBytes().toString(), /fixed/);
  }
});

test('document: repair keeps pending edits', () => {
  const doc = new PDFDocument(simplePage('BT ET'));
  const ref = doc.register(new PDFDict().set('Kept', true));
  doc.getObject(1);
  // Simulate damage discovered later.
  doc.xref.set(99, { type: 1, offset: 5, gen: 0 });
  doc._scanIndex = new Map([[99, 9]]);
  doc.getObject(99);
  assert.equal(doc.resolve(ref).get('Kept'), true);
});

test('document: missing startxref is repaired', () => {
  const buf = simplePage('BT ET');
  const cut = buf.subarray(0, buf.lastIndexOf('startxref'));
  const doc = new PDFDocument(Buffer.from(cut));
  assert.equal(doc.pageCount, 1);
});

test('document: wrong /Length on a stream is recovered', () => {
  const buf = buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R>>',
    '<</Length 3>>\nstream\nBT (x) Tj ET\nendstream',
  ]);
  const doc = new PDFDocument(buf);
  assert.match(doc.getPage(0).getContentBytes().toString(), /\(x\) Tj ET/);
});

test('document: page tree inheritance (MediaBox, Resources, Rotate)', () => {
  const buf = buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 2 /MediaBox [0 0 300 400] /Rotate 90 /Resources <</Font <</F1 6 0 R>>>>>>',
    '<</Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2>>',
    '<</Type /Page /Parent 3 0 R>>',
    '<</Type /Page /Parent 3 0 R /MediaBox [0 0 100 100]>>',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  ]);
  const doc = new PDFDocument(buf);
  assert.equal(doc.pageCount, 2);
  assert.deepEqual(doc.getPage(0).mediaBox, [0, 0, 300, 400]);
  assert.deepEqual(doc.getPage(1).mediaBox, [0, 0, 100, 100]);
  assert.equal(doc.getPage(0).rotate, 90);
  assert.ok(doc.getPage(1).resources.get('Font'));
});

test('writer: full save drops unreachable objects and keeps content', () => {
  const buf = buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R>>',
    { dict: '', stream: 'BT ET' },
    '(orphan object)',
  ]);
  const doc = new PDFDocument(buf);
  const out = doc.save({ incremental: false });
  assert.ok(!out.includes('orphan object'));
  const again = new PDFDocument(out);
  assert.equal(again.getPage(0).getContentBytes().toString().trim(), 'BT ET');
});

test('writer: strings and names round-trip through serialization', () => {
  const doc = new PDFDocument(simplePage('BT ET'));
  const dict = new PDFDict()
    .set('A', new PDFString(Buffer.from('a(b)\\c\r\n')))
    .set('B', PDFName.of('With Space#'))
    .set('C', PDFString.fromText('हिंदी'))
    .set('D', 1.23456789);
  const ref = doc.register(dict);
  const again = new PDFDocument(doc.save());
  const d = again.resolve(ref);
  assert.equal(d.get('A').bytes.toString('latin1'), 'a(b)\\c\r\n');
  assert.equal(d.get('B').name, 'With Space#');
  assert.equal(d.get('C').toText(), 'हिंदी');
  assert.equal(d.get('D').value, 1.234568);
});

test('encryption: AES-128 fixture opens with user and owner password, rejects wrong one', async () => {
  for (const pw of ['user123', 'owner123']) {
    const doc = await PDFDocument.load(FIXTURES + 'encrypted-user.pdf', { password: pw });
    assert.ok(doc.isEncrypted);
    assert.match(doc.getPage(0).getContentBytes().toString('latin1'), /BT/);
    assert.equal(doc.security.isOwner, pw === 'owner123');
  }
  await assert.rejects(PDFDocument.load(FIXTURES + 'encrypted-user.pdf', { password: 'nope' }), PDFPasswordError);
});

test('encryption: edits are re-encrypted on incremental and full save', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'encrypted-nopass.pdf');
  const page = doc.getPage(0);
  const original = page.getContentBytes();
  page.setContentBytes(Buffer.concat([original, Buffer.from('\n% marker-comment\n')]));
  for (const incremental of [true, false]) {
    const out = doc.save({ incremental });
    assert.ok(!out.includes('marker-comment'), 'plaintext must not leak');
    const again = new PDFDocument(out);
    assert.ok(again.isEncrypted);
    assert.match(again.getPage(0).getContentBytes().toString('latin1'), /marker-comment/);
  }
});

test('real-world fixtures load without warnings', async () => {
  for (const f of ['chrome-invoice.pdf', 'chrome-hindi.pdf', 'quartz-text.pdf', 'xcode-license.pdf']) {
    const doc = await PDFDocument.load(FIXTURES + f);
    assert.ok(doc.pageCount >= 1, f);
    for (const n of doc.objectNumbers) doc.getObject(n);
    assert.deepEqual(doc.warnings, [], f);
    const again = new PDFDocument(doc.save({ incremental: false }));
    assert.equal(again.pageCount, doc.pageCount, f);
  }
});

test('flate: truncated streams are recovered as far as possible', () => {
  const full = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (Hello world) Tj ET '.repeat(50)));
  const doc = new PDFDocument(simplePage('BT ET'));
  const s = new PDFStream(new PDFDict().set('Filter', N('FlateDecode')), full.subarray(0, full.length - 10));
  const out = doc.decodeStream(s).toString();
  assert.match(out, /^BT \/F1 12 Tf \(Hello world\)/);
});
