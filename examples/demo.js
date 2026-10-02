// Demo: node examples/demo.js  -> writes examples/invoice-edited.pdf
import { PDFDocument, TextEditor, extractText } from '../src/index.js';

const doc = await PDFDocument.load(new URL('../test/fixtures/chrome-invoice.pdf', import.meta.url).pathname);
const editor = new TextEditor(doc);
const edits = [
  ['Rahul Sharma', 'Priyank Dadhich'],
  ['15 March 2024', '02 October 2026'],
  ['25,000', '1,25,000'],
  ['29,500', '1,29,500'],
  ['Jaipur', 'Udaipur'],
  ['lazy dog', 'very lazy dog'],
  ['INV-2024-0042', 'INV-2026-0999'],
  ['Website Design', 'Website Design and Development Services'],
  ['Item', 'Description'],
  ['thirty', '45'],
];
for (const [search, replace] of edits) {
  const r = editor.replace({ search, replace });
  const d = r.details[0];
  console.log(`${search} -> ${replace}: ${r.replaced} replaced` + (d ? ` (align ${d.align}, scale ${d.scale}${d.embeddedFont ? ', font extended' : ''})` : ''));
}
const out = new URL('./invoice-edited.pdf', import.meta.url).pathname;
await doc.saveAs(out);
console.log('\n' + extractText(await PDFDocument.load(out), 0));
