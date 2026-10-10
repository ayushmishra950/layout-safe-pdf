// Resume generator: layout, fresher/experienced ordering, pagination, text integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, extractLines } from '../src/index.js';
import { buildResume } from '../resume/index.js';

const sample = (n) => JSON.parse(fs.readFileSync(new URL(`../resume/samples/${n}.json`, import.meta.url), 'utf8'));
const read = async (pdf) => {
  const doc = await PDFDocument.load(pdf);
  return Array.from({ length: doc.pageCount }, (_, p) => extractLines(doc, p));
};
const HEADINGS = ['PROFILE SUMMARY', 'WORK EXPERIENCE', 'INTERNSHIP EXPERIENCE', 'KEY PROJECTS', 'TECHNICAL SKILLS', 'EDUCATION', 'CERTIFICATIONS', 'ACHIEVEMENTS'];
const headingsOf = (pages) => pages.flat().map((l) => l.text.trim()).filter((t) => HEADINGS.includes(t));

test('experienced resume: one page, reference section order, selectable text', async () => {
  const r = buildResume(sample('experienced'));
  assert.equal(r.layout, 'experienced');
  assert.equal(r.pages, 1);
  const pages = await read(r.pdf);
  assert.deepEqual(headingsOf(pages), ['PROFILE SUMMARY', 'WORK EXPERIENCE', 'KEY PROJECTS', 'TECHNICAL SKILLS', 'EDUCATION']);
  const lines = pages[0];
  assert.equal(lines[0].text.trim(), 'ROHAN MEHTA');
  assert.equal(lines[0].fontSize, 20);
  assert.equal(lines[0].x > 200 && lines[0].x < 260, true); // centered
  assert.match(lines[0].fontName, /Carlito-Bold/);
  assert.ok(lines.some((l) => l.text.includes('Jan 2026 – Present')));
  assert.ok(lines.some((l) => l.text.includes('rohan.mehta@example.com')));
});

test('fresher resume: no experience section, education comes right after the summary', async () => {
  const d = sample('fresher');
  delete d.experience;
  const r = buildResume(d);
  assert.equal(r.layout, 'fresher');
  const h = headingsOf(await read(r.pdf));
  assert.deepEqual(h, ['PROFILE SUMMARY', 'EDUCATION', 'TECHNICAL SKILLS', 'KEY PROJECTS', 'CERTIFICATIONS', 'ACHIEVEMENTS']);
});

test('internship-only candidate is laid out as a fresher with an INTERNSHIP section', async () => {
  const r = buildResume(sample('fresher'));
  assert.equal(r.layout, 'fresher');
  const h = headingsOf(await read(r.pdf));
  assert.deepEqual(h.slice(0, 4), ['PROFILE SUMMARY', 'EDUCATION', 'TECHNICAL SKILLS', 'INTERNSHIP EXPERIENCE']);
});

test('empty optional sections are omitted, only a name is required', async () => {
  const r = buildResume({ name: 'Test User', skills: { Languages: 'JavaScript' } });
  assert.deepEqual(headingsOf(await read(r.pdf)), ['TECHNICAL SKILLS']);
  assert.throws(() => buildResume({ summary: 'x' }), /name/);
});

test('long resume flows onto extra pages without orphaned headings or overflow', async () => {
  const r = buildResume(sample('long'));
  assert.ok(r.pages >= 2);
  const pages = await read(r.pdf);
  for (const lines of pages) {
    assert.ok(lines.length > 3);
    assert.equal(lines[0].y, 737.95); // every page starts at the same top
    for (const l of lines) {
      assert.ok(l.y >= 50, `line below bottom margin: ${l.text}`);
      assert.ok(l.bbox[2] <= 612 - 40, `line overflows right margin: ${l.text}`);
    }
    // a heading must not be the last line of a page
    assert.ok(!HEADINGS.includes(lines.at(-1).text.trim()), 'heading orphaned at page bottom');
  }
  // nothing lost: every bullet of the data is present exactly once in the output text
  const text = pages.flat().map((l) => l.text).join('\n');
  assert.equal((text.match(/Delivered feature number 4/g) || []).length, 6);
  assert.equal((text.match(/Example University/g) || []).length, 1);
});

test('unsupported characters are reported and replaced, long words are hard-wrapped', async () => {
  const r = buildResume({ name: 'A B', summary: 'Hello 中 world ' + 'x'.repeat(300) });
  assert.ok(r.warnings.some((w) => w.includes('中')));
  const lines = (await read(r.pdf))[0];
  for (const l of lines) assert.ok(l.bbox[2] <= 612 - 40);
});

test('contact links become clickable annotations', () => {
  const r = buildResume(sample('fresher'));
  const s = r.pdf.toString('latin1');
  assert.ok(s.includes('/URI (mailto:riya.sharma@example.com)'));
  assert.ok(s.includes('/URI (https://github.com/riyasharma)'));
});

test('spacing auto: sparse resumes are opened up, full and multi-page ones keep the reference spacing', async () => {
  const sparse = { name: 'Neha Singh', education: [{ degree: 'Class XII', institution: 'CBSE', status: '2025' }], skills: { Computer: 'MS Office' } };
  const auto = buildResume(sparse);
  const normal = buildResume({ ...sparse, spacing: 'normal' });
  assert.equal(normal.spacing.stretch, 0);
  assert.ok(auto.spacing.stretch > 0);
  const lowest = async (r) => Math.min(...(await read(r.pdf))[0].map((l) => l.y));
  assert.ok((await lowest(auto)) < (await lowest(normal)) - 30, 'auto should use more of the page');
  assert.equal(auto.pages, 1);
  // mid-size content is stretched but stays on one page and below the fill target
  const mid = buildResume(sample('class12-fresher'));
  assert.equal(mid.pages, 1);
  assert.ok(mid.spacing.fill <= 0.88);
  // full / long content: identical to normal spacing
  for (const n of ['experienced', 'long']) {
    const a = buildResume(sample(n));
    const b2 = buildResume({ ...sample(n), spacing: 'normal' });
    assert.equal(a.spacing.stretch, 0);
    assert.deepEqual((await read(a.pdf)).flat().map((l) => [l.text, l.x, l.y]), (await read(b2.pdf)).flat().map((l) => [l.text, l.x, l.y]));
  }
});
