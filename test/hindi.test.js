// Hindi (Devanagari) across producers, legacy Kruti Dev fonts, forms, environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, TextEditor, extractText, extractLines, editPdf, diagnose } from '../src/index.js';
import { krutiToUnicode, unicodeToKruti } from '../src/fonts/legacy.js';
import { buildPdf, simplePage, FIXTURES } from './helpers.js';

const hasDevanagariFont = diagnose().checks.find((c) => /Devanagari/.test(c.name)).ok;
const needFont = !hasDevanagariFont && 'no Devanagari font installed';
const flat = (s) => s.replace(/\s+/g, ' ');

const CERT_LINES = [
  'राजस्थान विश्वविद्यालय, जयपुर',
  'प्रमाणित किया जाता है कि श्री राम कुमार शर्मा पुत्र श्री श्याम लाल शर्मा',
  'अंग्रेज़ी',
  'उज्ज्वल भविष्य की कामना करते हैं।',
  'Registration No: RU/2024/15678',
];

for (const f of ['chrome-hindi-certificate.pdf', 'chrome-hindi-truetype.pdf', 'coretext-hindi.pdf']) {
  test(`hindi extraction: ${f}`, async () => {
    const text = flat(extractText(await PDFDocument.load(FIXTURES + f), 0));
    for (const l of CERT_LINES) assert.ok(text.includes(l), l);
  });

  test(`hindi edits: ${f}`, { skip: needFont }, async () => {
    const edits = [
      { search: 'श्री राम कुमार शर्मा', replace: 'श्री प्रियंक दाधीच' },
      { search: 'राजस्थान विश्वविद्यालय, जयपुर', replace: 'मोहनलाल सुखाड़िया विश्वविद्यालय, उदयपुर' },
      { search: 'अंग्रेज़ी', replace: 'गणित' },
      { search: 'कार्यालय', replace: 'विश्वविद्यालय के मुख्य कार्यालय' },
      { search: 'RU/2024/15678', replace: 'MLSU/2026/99999' },
      { search: 'स्नातक', replace: 'B.Sc.' },
    ];
    const before = extractLines(await PDFDocument.load(FIXTURES + f), 0)[0];
    const { pdf, report } = await editPdf(FIXTURES + f, edits, { includeText: true });
    assert.equal(report.ok, true, JSON.stringify(report.edits));
    const text = flat(report.text);
    for (const t of ['श्री प्रियंक दाधीच पुत्र', 'मोहनलाल सुखाड़िया विश्वविद्यालय, उदयपुर', 'गणित', 'मुख्य कार्यालय से संपर्क करें।', 'MLSU/2026/99999', 'की B.Sc. परीक्षा']) {
      assert.ok(text.includes(t), t);
    }
    // The centred heading stays centred.
    const after = extractLines(await PDFDocument.load(pdf), 0)[0];
    const mid = (l) => (l.bbox[0] + l.bbox[2]) / 2;
    assert.ok(Math.abs(mid(after) - mid(before)) < 1, `heading centre ${mid(after)} vs ${mid(before)}`);
  });
}

test('hindi without ActualText (Word-style): visual order is repaired', async () => {
  const text = extractText(await PDFDocument.load(FIXTURES + 'hindi-no-actualtext.pdf'), 0);
  assert.deepEqual(text.split('\n'), [
    'प्रमाणित किया जाता है कि श्री राम कुमार शर्मा',
    'पिता श्री कृष्ण मुरारी, निवासी हिन्दी कार्यालय',
    'विद्यार्थी ने परीक्षा उत्तीर्ण की है।',
  ]);
});

test('hindi without ActualText: search and replace work', { skip: needFont }, async () => {
  const { report } = await editPdf(FIXTURES + 'hindi-no-actualtext.pdf', [
    { search: 'राम कुमार शर्मा', replace: 'प्रियंक दाधीच' },
    { search: 'विद्यार्थी', replace: 'छात्रा' },
  ], { includeText: true });
  assert.equal(report.ok, true);
  assert.match(report.text, /श्री प्रियंक दाधीच/);
  assert.match(report.text, /छात्रा ने परीक्षा/);
});

test('logical-order glyph streams are not "repaired"', () => {
  // A producer drawing क then ि (placed left of क), then स: already logical.
  const tu = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 3 beginbfchar <41> <0915> <42> <093F> <43> <0938> endbfchar endcmap end end';
  const doc = new PDFDocument(buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
    // ि is a zero-width mark placed just left of क.
    { dict: '', stream: 'BT /F1 20 Tf 1 0 0 1 100 100 Tm (A) Tj 1 0 0 1 99 100 Tm (B) Tj 1 0 0 1 110 100 Tm (C) Tj ET' },
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /LastChar 67 /Widths [500 0 500] /ToUnicode 6 0 R>>',
    { dict: '', stream: tu },
  ]));
  assert.equal(extractText(doc, 0), 'किस');
});

// ---- Kruti Dev ----------------------------------------------------------------------------

test('kruti dev: conversion both ways on common words', () => {
  const words = [['jke', 'राम'], ['dqekj', 'कुमार'], ["'kekZ", 'शर्मा'], ['fgUnh', 'हिन्दी'], ['izek.k', 'प्रमाण'],
    ['dk;kZy;', 'कार्यालय'], ["fo'ofo|ky;", 'विश्वविद्यालय'], ['fLFkr', 'स्थित'], ['ijh{kk', 'परीक्षा'],
    ['mÙkh.kZ', 'उत्तीर्ण'], ['iq=', 'पुत्र'], ['Kku', 'ज्ञान'], ['fo|kFkhZ', 'विद्यार्थी'], ['fiz;ad', 'प्रियंक']];
  for (const [k, u] of words) {
    assert.equal(krutiToUnicode(k), u, k);
    assert.equal(unicodeToKruti(u), k, u);
  }
});

const krutiPdf = () => {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const widths = new Array(224).fill(500).join(' ');
  return buildPdf([
    '<</Type /Catalog /Pages 2 0 R>>', '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>',
    { dict: '', stream: Buffer.from(`BT /F1 16 Tf 72 700 Td (${esc("Jh jke dqekj 'kekZ] fuoklh t;iqj")}) Tj ET`, 'latin1') },
    `<</Type /Font /Subtype /TrueType /BaseFont /KrutiDev010 /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${widths}]>>`,
  ]);
};

test('kruti dev: extraction and edits written in the original font', async () => {
  const doc = new PDFDocument(krutiPdf());
  assert.equal(extractText(doc, 0), 'श्री राम कुमार शर्मा, निवासी जयपुर');
  const r = new TextEditor(doc).replace({ search: 'राम कुमार शर्मा', replace: 'प्रियंक दाधीच' });
  assert.equal(r.replaced, 1);
  assert.equal(r.details[0].font, 'KrutiDev010', 'kept the Kruti Dev font');
  const out = new PDFDocument(doc.save());
  assert.equal(extractText(out, 0), 'श्री प्रियंक दाधीच, निवासी जयपुर');
  assert.match(out.getPage(0).getContentBytes().toString('latin1'), /fiz;ad nk\/khp/);
});

// ---- forms & environment -----------------------------------------------------------------

test('form fields: values and appearances are replaced', async () => {
  const pdf = buildPdf([
    '<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R] /DR <</Font <</Helv 5 0 R>>>> /DA (/Helv 12 Tf 0 g)>>>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [6 0 R]>>',
    { dict: '', stream: '' },
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
    '<</FT /Tx /T (name) /V (Rahul Sharma) /Type /Annot /Subtype /Widget /Rect [200 712 450 736] /P 3 0 R>>',
  ]);
  const { pdf: out, report } = await editPdf(pdf, [{ search: 'Rahul', replace: 'Priyank' }]);
  assert.equal(report.replaced, 1);
  const doc = new PDFDocument(out);
  const field = doc.resolve(doc.resolve(doc.catalog.get('AcroForm')).get('Fields')[0]);
  assert.equal(field.get('V').toText(), 'Priyank Sharma');
  const ap = doc.resolve(field.get('AP').get('N'));
  assert.match(doc.decodeStream(ap).toString('latin1'), /\(Priyank Sharma\) Tj/);
});

test('doctor reports environment checks', () => {
  const r = diagnose();
  assert.ok(r.checks.length >= 5);
  for (const c of r.checks) assert.ok(c.ok || c.fix, c.name);
});

test('heading on the page centre is detected as centred', async () => {
  const doc = new PDFDocument(simplePage('BT /F1 20 Tf 287.11 700 Td (Title) Tj /F1 10 Tf -215.11 -40 Td (Body text line starts at the left margin of the page.) Tj ET'));
  const r = new TextEditor(doc).replace({ search: 'Title', replace: 'A Much Longer Title' });
  assert.equal(r.details[0].align, 'center');
});
