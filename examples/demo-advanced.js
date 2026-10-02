// Demo of phases 5-7: node examples/demo-advanced.js
import { PDFDocument, TextEditor, extractText } from '../src/index.js';

const fixture = (f) => new URL(`../test/fixtures/${f}`, import.meta.url).pathname;
const out = (f) => new URL(`./${f}`, import.meta.url).pathname;

// 1. Hindi certificate: shaped Devanagari replacement (needs a Devanagari system font).
{
  const doc = await PDFDocument.load(fixture('chrome-hindi.pdf'));
  const ed = new TextEditor(doc);
  for (const [a, b] of [['राम कुमार शर्मा', 'प्रियंक दाधीच'], ['श्याम लाल', 'श्री कृष्ण मुरारी'], ['उत्तीर्ण', 'सफलतापूर्वक उत्तीर्ण'], ['12345', '98765']]) {
    const r = ed.replace({ search: a, replace: b });
    console.log(`${a} -> ${b}: ${r.replaced}`, r.skipped.map((s) => s.reason).join('; '));
  }
  await doc.saveAs(out('hindi-edited.pdf'));
  console.log(extractText(await PDFDocument.load(out('hindi-edited.pdf')), 0), '\n');
}

// 2. Paragraph re-wrap (justified English, styled words, Hindi).
{
  const doc = await PDFDocument.load(fixture('chrome-paragraphs.pdf'));
  const ed = new TextEditor(doc);
  for (const [a, b] of [
    ['Rahul Sharma and the Company', 'Priyank Dadhich, Managing Director of Libr Technologies Private Limited, and the Company'],
    ['has paid', 'has successfully paid, through a bank transfer dated 2 October 2026,'],
    ['राम कुमार शर्मा', 'प्रियंक दाधीच, पुत्र श्री कृष्ण मुरारी दाधीच, निवासी उदयपुर,'],
  ]) {
    const r = ed.replace({ search: a, replace: b });
    console.log(`${a.slice(0, 20)}…: ${r.details.map((d) => (d.rewrapped ? `re-wrapped into ${d.lines} lines at ${Math.round(d.scale * 100)}%` : d.align)).join(', ')}`);
  }
  await doc.saveAs(out('paragraphs-edited.pdf'));
  console.log(extractText(await PDFDocument.load(out('paragraphs-edited.pdf')), 0), '\n');
}

// 3. AES-256 encryption.
{
  const doc = await PDFDocument.load(out('paragraphs-edited.pdf'));
  doc.encrypt({ userPassword: 'open123', ownerPassword: 'owner123', permissions: { copy: false } });
  await doc.saveAs(out('paragraphs-encrypted.pdf'));
  const back = await PDFDocument.load(out('paragraphs-encrypted.pdf'), { password: 'open123' });
  console.log(`AES-256: R${back.security.R}, opens with password, first line: ${extractText(back, 0).split('\n')[0].slice(0, 50)}…`);
}
