// Select & replace (position-based) and filling form fields by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, TextEditor, extractText, editPdf, getFormFields, setFormFields } from '../src/index.js';
import { simplePage, FIXTURES } from './helpers.js';

const twoTotals = () => new PDFDocument(simplePage(
  'BT /F1 12 Tf 72 700 Td (Total: 2024) Tj 0 -40 Td (Other line) Tj 0 -40 Td (Total: 2024) Tj ET',
));

test('replaceAt: only the selected occurrence changes', () => {
  const doc = twoTotals();
  const ed = new TextEditor(doc);
  const hits = ed.find('2024');
  assert.equal(hits.length, 2);
  const second = hits[1];
  const r = ed.replaceAt({ page: 0, bbox: second.bbox, search: '2024', replace: '2026' });
  assert.equal(r.replaced, 1);
  assert.deepEqual(extractText(new PDFDocument(doc.save()), 0).split('\n'), ['Total: 2024', 'Other line', 'Total: 2026']);
});

test('replaceAt: a loose selection box still picks the right occurrence', () => {
  const doc = twoTotals();
  const ed = new TextEditor(doc);
  const first = ed.find('2024')[0];
  const [x0, y0, x1, y1] = first.bbox;
  ed.replaceAt({ page: 0, bbox: [x0 - 4, y0 - 3, x1 + 6, y1 + 2], search: '2024', replace: '1999' });
  assert.deepEqual(extractText(new PDFDocument(doc.save()), 0).split('\n'), ['Total: 1999', 'Other line', 'Total: 2024']);
});

test('replaceAt: nothing in the selected area is reported, nothing changes', () => {
  const doc = twoTotals();
  const r = new TextEditor(doc).replaceAt({ page: 0, bbox: [400, 100, 500, 120], search: '2024', replace: 'x' });
  assert.equal(r.replaced, 0);
  assert.match(r.skipped[0].reason, /selected area/);
  assert.throws(() => new TextEditor(doc).replaceAt({ page: 9, bbox: [0, 0, 1, 1], search: 'a', replace: 'b' }), RangeError);
});

test('editPdf: edits with page + bbox use select & replace', async () => {
  const doc = twoTotals();
  const bbox = new TextEditor(doc).find('2024')[1].bbox;
  const { report } = await editPdf(doc.save(), [{ search: '2024', replace: '2030', page: 1, bbox }], { includeText: true });
  assert.equal(report.ok, true);
  assert.equal(report.text, 'Total: 2024\nOther line\nTotal: 2030');
});

test('getFormFields lists fields with types, values and options', async () => {
  const fields = getFormFields(await PDFDocument.load(FIXTURES + 'form-fields.pdf'));
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(by.name.type, 'text');
  assert.equal(by.name.value, 'Rahul Sharma');
  assert.equal(by.city.value, null);
  assert.equal(by.city.maxLength, 20);
  assert.equal(by.agree.type, 'checkbox');
  assert.equal(by.agree.value, false);
  assert.deepEqual(by.gender.options.map((o) => o.value), ['Male', 'Female']);
  assert.equal(by.state.type, 'dropdown');
  assert.deepEqual(by.state.options.map((o) => o.value), ['Rajasthan', 'Gujarat', 'Delhi']);
  assert.equal(by.id.readOnly, true);
});

test('setFormFields fills text (incl. empty), checkbox, radio and dropdown', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'form-fields.pdf');
  const r = setFormFields(doc, { name: 'Priyank Dadhich', city: 'Udaipur', agree: true, gender: 'Female', state: 'Delhi' });
  assert.deepEqual(r.set, ['name', 'city', 'agree', 'gender', 'state']);
  assert.deepEqual(r.errors, []);
  const out = new PDFDocument(doc.save());
  const by = Object.fromEntries(getFormFields(out).map((f) => [f.name, f.value]));
  assert.deepEqual(by, { name: 'Priyank Dadhich', city: 'Udaipur', agree: true, gender: 'Female', state: 'Delhi', id: 'A-100' });
  // Appearances follow the new state.
  const fieldsArr = out.resolve(out.resolve(out.catalog.get('AcroForm')).get('Fields'));
  const gender = out.resolve(fieldsArr[3]);
  const states = out.resolve(gender.get('Kids')).map((k) => out.resolve(k).get('AS').name);
  assert.deepEqual(states, ['Off', 'Female']);
  const city = out.resolve(fieldsArr[1]);
  assert.match(out.decodeStream(out.resolve(city.get('AP').get('N'))).toString('latin1'), /\(Udaipur\) Tj/);
});

test('setFormFields rejects bad values and read-only fields with reasons', async () => {
  const doc = await PDFDocument.load(FIXTURES + 'form-fields.pdf');
  const r = setFormFields(doc, { state: 'Goa', gender: 'Other', city: 'x'.repeat(30), id: 'B', nope: 1 });
  assert.deepEqual(r.set, []);
  assert.deepEqual(r.notFound, ['nope']);
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ['city', 'gender', 'id', 'state']);
  const ok = setFormFields(doc, { id: 'B-200' }, { allowReadOnly: true });
  assert.deepEqual(ok.set, ['id']);
});

test('editPdf: fields option fills the form and reports problems', async () => {
  const { report } = await editPdf(FIXTURES + 'form-fields.pdf', [], { fields: { name: 'Priyank', missing: 'x' } });
  assert.deepEqual(report.fields.set, ['name']);
  assert.deepEqual(report.fields.notFound, ['missing']);
  assert.equal(report.ok, false);
});
