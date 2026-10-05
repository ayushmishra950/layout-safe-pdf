import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, TextEditor, extractText, extractLines, ContentInterpreter, parseOperations } from '../src/index.js';
import { buildLines } from '../src/text/layout.js';
import { TrueTypeFont } from '../src/fonts/truetype.js';
import { simplePage, FIXTURES } from './helpers.js';

/** Positions of every glyph on page 1, keyed by "char#occurrence". */
function glyphPositions(doc) {
  const it = new ContentInterpreter(doc);
  it.runPage(doc.getPage(0));
  const out = [];
  for (const s of it.shows) for (const g of s.glyphs) out.push({ ch: g.unicode, x: g.x, y: g.y, ex: g.ex });
  return out;
}

const reload = (doc) => new PDFDocument(doc.save());

test('extract: TJ kerning, word gaps without space glyphs, quote operators', () => {
  const doc = new PDFDocument(simplePage(
    'BT /F1 12 Tf 14 TL 72 700 Td [(Hel) 20 (lo) -600 (World)] TJ (Second line) \' 2 1 (Third) " ET',
  ));
  const lines = extractLines(doc, 0).map((l) => l.text);
  assert.deepEqual(lines, ['Hello World', 'Second line', 'Third']);
  const l = extractLines(doc, 0);
  assert.equal(l[1].y, 686);
  assert.equal(l[0].fontName, 'Helvetica');
});

test('extract: text inside a form XObject with its own matrix', () => {
  const doc = new PDFDocument(simplePage('q 1 0 0 1 100 0 cm /Fm1 Do Q', {
    extraResources: '/XObject <</Fm1 6 0 R>>',
    extraObjects: [{ dict: '/Type /XObject /Subtype /Form /BBox [0 0 500 500] /Matrix [1 0 0 1 0 50] /Resources <</Font <</F1 5 0 R>>>>', stream: 'BT /F1 10 Tf 10 20 Td (In form) Tj ET' }],
  }));
  const [line] = extractLines(doc, 0);
  assert.equal(line.text, 'In form');
  assert.equal(line.x, 110);
  assert.equal(line.y, 70);
});

test('content: inline images survive rewriting byte-for-byte', () => {
  const content = 'q 10 0 0 10 0 0 cm BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\xffEI\x10 EI Q BT /F1 12 Tf 72 700 Td (Name: Old) Tj ET';
  const doc = new PDFDocument(simplePage(content));
  const ops = parseOperations(doc.getPage(0).getContentBytes());
  const bi = ops.find((o) => o.op === 'BI');
  assert.deepEqual([...bi.inlineImage.data], [0x00, 0xff, 0x45, 0x49, 0x10]);
  new TextEditor(doc).replace({ search: 'Old', replace: 'New' });
  const after = reload(doc).getPage(0).getContentBytes().toString('latin1');
  assert.ok(after.includes('ID \x00\xffEI\x10 EI'), 'binary image data untouched');
  assert.match(after, /\(Name: New\) Tj|\(Name: \)|New/);
});

test('replace (preserve): untouched glyphs keep their exact positions', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td [(Name: Rahul) -250 (Sharma, Jaipur)] TJ ET'));
  const before = glyphPositions(doc);
  const r = new TextEditor(doc).replace({ search: 'Rahul', replace: 'Ram', mode: 'preserve' });
  assert.equal(r.replaced, 1);
  const out = reload(doc);
  assert.equal(extractText(out, 0), 'Name: Ram Sharma, Jaipur');
  const after = glyphPositions(out);
  const tail = (list) => list.slice(-14).map((g) => [g.ch, +g.x.toFixed(4), g.y]);
  assert.deepEqual(tail(after), tail(before), '"Sharma, Jaipur" did not move');
  const head = (list) => list.slice(0, 6).map((g) => [g.ch, +g.x.toFixed(4)]);
  assert.deepEqual(head(after), head(before), '"Name: " did not move');
});

test('replace (reflow): rest of the line moves by exactly the width difference', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Name: Rahul Sharma) Tj ET'));
  const before = glyphPositions(doc);
  new TextEditor(doc).replace({ search: 'Rahul', replace: 'Rahul Kumar' });
  const after = glyphPositions(reload(doc));
  // Helvetica widths: " Kumar" = space 278 + K 667 + u 556 + m 833 + a 556 + r 333 = 3223/1000 em
  const expected = 3.223 * 12;
  const lastBefore = before[before.length - 1];
  const lastAfter = after[after.length - 1];
  assert.equal(lastAfter.ch, 'a');
  assert.ok(Math.abs(lastAfter.x - lastBefore.x - expected) < 1e-3, `shift ${lastAfter.x - lastBefore.x}`);
});

test('replace: matches spanning several operations and Td moves', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Total ) Tj 31.344 0 Td (Due:) Tj 30 0 Td (500) Tj ET'));
  const before = glyphPositions(doc);
  const r = new TextEditor(doc).replace({ search: 'Total Due', replace: 'Amount Payable', mode: 'preserve' });
  assert.equal(r.replaced, 1);
  const out = reload(doc);
  assert.match(extractText(out, 0), /Amount Payable\s*:\s*500/);
  const after = glyphPositions(out);
  assert.deepEqual(after.slice(-3).map((g) => +g.x.toFixed(3)), before.slice(-3).map((g) => +g.x.toFixed(3)));
});

test('replace: regex, case-insensitive, $& and function replacements', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Invoice 2024 and invoice 2025) Tj ET'));
  const ed = new TextEditor(doc);
  assert.equal(ed.replace({ search: /\d{4}/, replace: (m) => String(+m + 2) }).replaced, 2);
  assert.equal(ed.replace({ search: 'INVOICE', replace: '[$&]', caseSensitive: false }).replaced, 2);
  assert.equal(extractText(reload(doc), 0), '[Invoice] 2026 and [invoice] 2027');
});

test('replace: maxCount and page selection', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (a a a) Tj ET'));
  const ed = new TextEditor(doc);
  assert.equal(ed.replace({ search: 'a', replace: 'b', maxCount: 2 }).replaced, 2);
  assert.equal(ed.replace({ search: 'a', replace: 'b', pages: [5] }).replaced, 0);
  assert.equal(extractText(reload(doc), 0), 'b b a');
});

test('replace: fit mode condenses longer text into the original width', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Tiny tail) Tj ET'));
  const before = glyphPositions(doc);
  new TextEditor(doc).replace({ search: 'Tiny', replace: 'Enormous', mode: 'fit' });
  const out = reload(doc);
  assert.match(out.getPage(0).getContentBytes().toString(), / Tz/);
  const after = glyphPositions(out);
  assert.equal(+after[after.length - 1].x.toFixed(3), +before[before.length - 1].x.toFixed(3));
});

test('replace: unencodable characters are skipped with a reason when no font is available', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Hello) Tj ET'));
  const ed = new TextEditor(doc, { useSystemFonts: false });
  const r = ed.replace({ search: 'Hello', replace: 'नमस्ते' });
  assert.equal(r.replaced, 0);
  assert.match(r.skipped[0].reason, /no glyph|no Devanagari font/);
});

test('replace: incremental save keeps the original bytes as a prefix', () => {
  const src = simplePage('BT /F1 12 Tf 72 700 Td (Keep me) Tj ET');
  const doc = new PDFDocument(src);
  new TextEditor(doc).replace({ search: 'Keep', replace: 'Changed' });
  const out = doc.save();
  assert.ok(out.subarray(0, src.length).equals(src));
});

// ---- real-world fixtures --------------------------------------------------------------

test('fixture: Chrome invoice extraction', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-invoice.pdf');
  const text = extractText(doc, 0);
  for (const s of ['INVOICE #INV-2024-0042', 'Customer Name: Rahul Sharma', 'Rs. 29,500', 'Thank you for your business!']) {
    assert.ok(text.includes(s), s);
  }
});

const arial = '/System/Library/Fonts/Supplemental/Arial.ttf';
const hasArial = fs.existsSync(arial);

test('fixture: Chrome invoice edits (subset font extended from system font, table alignment)', { skip: !hasArial && 'Arial.ttf not available' }, async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-invoice.pdf');
  const ed = new TextEditor(doc);
  const name = ed.replace({ search: 'Rahul Sharma', replace: 'Priyank Dadhich' });
  assert.equal(name.replaced, 1);
  assert.equal(name.details[0].embeddedFont, true, 'P is not in the original subset');
  const amount = ed.replace({ search: '25,000', replace: '1,25,000' });
  assert.equal(amount.details[0].align, 'right');
  const city = ed.replace({ search: 'Jaipur', replace: 'Udaipur' });
  assert.equal(city.replaced, 1);

  const out = await PDFDocument.load(doc.save());
  const lines = extractLines(out, 0);
  const find = (s) => lines.find((l) => l.text.includes(s));
  assert.ok(find('Customer Name: Priyank Dadhich'));
  assert.ok(find('Udaipur, Rajasthan'), 'following text reflowed without overlap');
  const orig = extractLines(await PDFDocument.load(FIXTURES + 'chrome-invoice.pdf'), 0);
  const origAmt = orig.find((l) => l.text === 'Rs. 25,000');
  const newAmt = find('Rs. 1,25,000');
  assert.ok(Math.abs(newAmt.bbox[2] - origAmt.bbox[2]) < 0.05, 'right edge of the amount cell kept');
});

// Apple's Xcode licence is a useful real-world multi-page PDF, but it is
// copyrighted, so it is not committed: the test runs where it exists locally.
const XCODE_LICENSE = fs.existsSync(FIXTURES + 'xcode-license.pdf');

test('fixture: multi-page Xcode license, simple TrueType fonts', { skip: !XCODE_LICENSE && 'xcode-license.pdf not present (not redistributable)' }, async () => {
  const doc = await PDFDocument.load(FIXTURES + 'xcode-license.pdf');
  const r = new TextEditor(doc).replace({ search: 'Apple Software', replace: 'Libr Software' });
  assert.ok(r.replaced > 50);
  assert.equal(r.skipped.length, 0);
  const out = await PDFDocument.load(doc.save());
  const all = extractText(out);
  assert.ok(!all.includes('Apple Software'));
  assert.ok(all.includes('Libr Software'));
});

test('fixture: encrypted invoice can be edited and stays encrypted', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'encrypted-user.pdf', { password: 'user123' });
  new TextEditor(doc).replace({ search: 'Rahul', replace: 'Rahul' });
  const out = await PDFDocument.load(doc.save(), { password: 'user123' });
  assert.ok(out.isEncrypted);
  assert.match(extractText(out, 0), /Customer Name: Rahul Sharma/);
});

// ---- fonts --------------------------------------------------------------------------

test('truetype: subset keeps glyph ids and produces a parseable font', { skip: !hasArial && 'Arial.ttf not available' }, () => {
  const ttf = new TrueTypeFont(fs.readFileSync(arial));
  const gidA = ttf.glyphForCodePoint(0x41);
  const gidE = ttf.glyphForCodePoint(0xe9); // é is a composite glyph in Arial
  const sub = new TrueTypeFont(ttf.subset([gidA, gidE]));
  assert.equal(sub.numGlyphs, ttf.numGlyphs);
  const a = ttf.glyphData(gidA);
  assert.ok(sub.glyphData(gidA).subarray(0, a.length).equals(a), "outline copied (plus 4-byte padding)");
  assert.ok(sub.glyphData(gidE).length > 0);
  assert.equal(sub.glyphData(ttf.glyphForCodePoint(0x42)).length, 0, 'unused glyph dropped');
  assert.ok(sub.file.length < ttf.file.length / 5);
});

test('layout: line building keeps ligature mapping', () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (ab) Tj ET'));
  const it = new ContentInterpreter(doc);
  it.runPage(doc.getPage(0));
  const [line] = buildLines(it.shows);
  assert.equal(line.chars.length, 2);
  assert.equal(line.chars[1].glyph.code, 0x62);
});

test('replace (reflow): several matches on one line share the free space', () => {
  // Two lines so the page text area is 72..540 (symmetric margins).
  const doc = new PDFDocument(simplePage(
    'BT /F1 12 Tf 72 700 Td (ab cd ab cd ab cd ab cd ab cd ab cd ab) Tj 0 -14 Td (x) Tj 468 0 Td (y) Tj ET',
  ));
  const r = new TextEditor(doc).replace({ search: 'ab', replace: 'abababab' });
  assert.equal(r.replaced, 7);
  const out = reload(doc);
  const line = extractLines(out, 0).find((l) => l.text.startsWith('abababab'));
  assert.ok(line.bbox[2] <= 540 + 0.6 * 12 + 0.01, `line end ${line.bbox[2]} stays inside the text area`);
});

test('layout: repeated identical lines are not mistaken for justified text', () => {
  const doc = new PDFDocument(simplePage(
    'BT /F1 12 Tf 72 700 Td (one two three four five six seven eight nine ten eleven) Tj 0 -14 Td (one two three four five six seven eight nine ten eleven) Tj ET',
  ));
  const before = glyphPositions(doc);
  new TextEditor(doc).replace({ search: 'two', replace: 'twenty', maxCount: 1 });
  const after = glyphPositions(reload(doc));
  // Ragged-right reflow: the last glyph of line 1 moves right instead of gaps shrinking.
  const lastOfLine1 = (list) => list.filter((g) => g.y === 700).pop();
  assert.ok(lastOfLine1(after).x > lastOfLine1(before).x + 1);
});
