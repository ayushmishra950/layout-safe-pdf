// Phase 5-7: ActualText, Devanagari shaping, CFF subsetting, paragraph re-wrap, AES-256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, TextEditor, extractText, extractLines } from '../src/index.js';
import { TrueTypeFont } from '../src/fonts/truetype.js';
import { Shaper } from '../src/fonts/shaper.js';
import { CFFFont } from '../src/fonts/cff.js';
import { FIXTURES, simplePage } from './helpers.js';

const KOHINOOR = '/System/Library/Fonts/Kohinoor.ttc';
const hasKohinoor = fs.existsSync(KOHINOOR);
const skipNoKohinoor = !hasKohinoor && 'Kohinoor Devanagari (macOS) not available';
const reload = async (doc, opts) => PDFDocument.load(doc.save(), opts);

// ---- ActualText -------------------------------------------------------------------------

test('extract: Hindi from Chrome Type3 fonts via ActualText clusters', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-hindi.pdf');
  assert.deepEqual(extractText(doc, 0).split('\n'), [
    'प्रमाण पत्र',
    'नाम: राम कुमार शर्मा',
    'पिता का नाम: श्याम लाल',
    'यह प्रमाणित किया जाता है कि छात्र ने परीक्षा उत्तीर्ण की है।',
    'English line: Certificate No. 12345',
  ]);
});

// ---- shaping ---------------------------------------------------------------------------------

// Reference output captured from macOS CoreText for KohinoorDevanagari-Regular:
// [gid, x, y] in font units.
const CORETEXT = [
  ['प्रियंक', [[781, 0, 0], [254, 273, 0], [76, 856, 0], [128, 1465, 0], [51, 1465, 0]]],
  ['शर्मा', [[80, 0, 0], [75, 718, 0], [27, 1297, 0], [161, 1570, 0]]],
  ['कृष्ण', [[51, 0, 0], [32, 522, 0], [733, 770, 0]]],
  ['आर्ट्स', [[3, 0, 0], [61, 997, 0], [132, 1424, 41], [161, 1483, 0], [82, 1500, 0]]],
  ['सफलतापूर्वक', [[82, 0, 0], [72, 680, 0], [78, 1474, 0], [66, 2187, 0], [27, 2743, 0], [71, 3016, 0], [31, 3578, 0], [79, 3578, 0], [161, 4126, 0], [51, 4126, 0]]],
  ['उज्ज्वल', [[6, 0, 0], [466, 475, 0], [78, 1990, 0]]],
  ['हिन्दी', [[780, 0, 0], [83, 273, 0], [577, 780, 0], [29, 1574, 0]]],
  ['क़िला', [[780, 0, 0], [87, 273, 0], [78, 1043, 0], [27, 1756, 0]]],
];

test('shaper: Devanagari output matches CoreText (gids and positions)', { skip: skipNoKohinoor }, () => {
  const shaper = new Shaper(new TrueTypeFont(fs.readFileSync(KOHINOOR), 0));
  for (const [word, ref] of CORETEXT) {
    let pen = 0;
    const ours = shaper.shape(word).map((g) => {
      const r = [g.gid, pen + g.xOffset, g.yOffset];
      pen += g.xAdvance;
      return r;
    });
    assert.deepEqual(ours, ref, word);
  }
});

test('cff: subset keeps glyph ids, becomes CID-keyed and shrinks', { skip: skipNoKohinoor }, () => {
  const ttf = new TrueTypeFont(fs.readFileSync(KOHINOOR), 0);
  const cff = new CFFFont(ttf.table('CFF '));
  assert.equal(cff.isCID, false);
  const out = new CFFFont(cff.subset(new Set([51, 66])));
  assert.equal(out.isCID, true);
  assert.equal(out.numGlyphs, cff.numGlyphs);
  assert.ok(out.charStrings[51].equals(cff.charStrings[51]));
  assert.equal(out.charStrings[52].length, 1, 'unused glyph is an empty endchar');
  assert.ok(out.b.length < cff.b.length / 4);
});

// ---- Hindi editing ---------------------------------------------------------------------------

test('replace: Hindi text is shaped, embedded and extractable', { skip: skipNoKohinoor }, async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-hindi.pdf');
  const ed = new TextEditor(doc);
  const r = ed.replace({ search: 'राम कुमार शर्मा', replace: 'प्रियंक दाधीच' });
  assert.equal(r.replaced, 1);
  assert.equal(r.details[0].font, 'KohinoorDevanagari-Regular', 'chosen by metric matching');
  // A second edit on the same page before saving sees the new text correctly.
  assert.match(extractText(doc, 0), /नाम: प्रियंक दाधीच/);
  ed.replace({ search: '12345', replace: '98765' });
  const out = await reload(doc);
  const text = extractText(out, 0);
  assert.match(text, /नाम: प्रियंक दाधीच/);
  assert.match(text, /Certificate No\. 98765/);
  assert.match(out.getPage(0).getContentBytes().toString('latin1'), /ActualText/);
});

// ---- paragraph re-wrap -----------------------------------------------------------------------

test('rewrap: long replacement re-flows a justified paragraph, keeping later content fixed', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-paragraphs.pdf');
  const before = extractLines(doc, 0);
  const r = new TextEditor(doc).replace({
    search: 'Rahul Sharma and the Company',
    replace: 'Priyank Dadhich, Managing Director of Libr Technologies Private Limited, and the Company',
  });
  assert.equal(r.details[0].rewrapped, true);
  const after = extractLines(await reload(doc), 0);
  const para = after.filter((l) => l.fontName.includes('Times'));
  const right = Math.max(...before.filter((l) => l.fontName.includes('Times')).map((l) => l.bbox[2]));
  for (const l of para.slice(0, -1)) assert.ok(Math.abs(l.bbox[2] - right) < 1, `justified edge kept: ${l.text}`);
  assert.equal(after.map((l) => l.text).join(' ').replace(/\s+/g, ' ').includes(
    'between Priyank Dadhich, Managing Director of Libr Technologies Private Limited, and the Company on the fifteenth day'), true);
  const footer = (ls) => ls.find((l) => l.text.startsWith('Footer'));
  assert.deepEqual(footer(after).bbox, footer(before).bbox);
});

test('rewrap: bold and coloured words keep their style', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-paragraphs.pdf');
  const r = new TextEditor(doc).replace({ search: 'has paid', replace: 'has successfully paid, through a bank transfer dated 2 October 2026,' });
  assert.equal(r.details[0].rewrapped, true);
  const out = await reload(doc);
  const lines = extractLines(out, 0);
  assert.ok(lines.some((l) => l.text.startsWith('The customer Rahul Sharma has successfully paid')));
  const right = 612 - 37.5;
  for (const l of lines) assert.ok(l.bbox[2] <= right + 0.5, `inside margin: ${l.text}`);
  const content = out.getPage(0).getContentBytes().toString('latin1');
  assert.match(content, /0\.75294\d* 0 0 rg|0\.75 0 0 rg|rg/);
});

test('rewrap: Hindi paragraph with mixed original and new glyphs', { skip: skipNoKohinoor }, async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-paragraphs.pdf');
  const r = new TextEditor(doc).replace({ search: 'राम कुमार शर्मा', replace: 'प्रियंक दाधीच, पुत्र श्री कृष्ण मुरारी दाधीच, निवासी उदयपुर,' });
  assert.equal(r.details[0].rewrapped, true);
  const text = extractText(await reload(doc), 0).replace(/\s+/g, ' ');
  assert.ok(text.includes('कि श्री प्रियंक दाधीच, पुत्र श्री कृष्ण मुरारी दाधीच, निवासी उदयपुर, ने संस्थान'));
  assert.ok(text.includes('उज्ज्वल भविष्य की कामना करते हैं।'));
});

test('rewrap can be disabled', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'chrome-paragraphs.pdf');
  const r = new TextEditor(doc).replace({ search: 'has paid', replace: 'has successfully paid, through a bank transfer,', wrap: false });
  assert.notEqual(r.details[0].rewrapped, true);
});

// ---- AES-256 -----------------------------------------------------------------------------------

test('encrypt: AES-256 (R6) round trip, owner/user passwords, removal', async () => {
  const doc = new PDFDocument(simplePage('BT /F1 12 Tf 72 700 Td (Top secret) Tj ET'));
  doc.encrypt({ userPassword: 'u-pass', ownerPassword: 'o-pass', permissions: { copy: false } });
  const bytes = doc.save();
  assert.ok(!bytes.includes('Top secret'));
  const asUser = new PDFDocument(bytes, { password: 'u-pass' });
  assert.equal(asUser.security.R, 6);
  assert.equal(asUser.security.isOwner, false);
  assert.equal(extractText(asUser, 0), 'Top secret');
  assert.equal(new PDFDocument(bytes, { password: 'o-pass' }).security.isOwner, true);
  assert.throws(() => new PDFDocument(bytes, { password: 'nope' }), /Incorrect password/);
  const P = asUser.security.P;
  assert.equal(P & (1 << 4), 0, 'copy permission removed');
  assert.ok(P & (1 << 2), 'print still allowed');

  asUser.removeEncryption();
  const plain = new PDFDocument(asUser.save());
  assert.equal(plain.isEncrypted, false);
  assert.equal(extractText(plain, 0), 'Top secret');
});
