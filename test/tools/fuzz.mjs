#!/usr/bin/env node
// Mutation fuzzer: corrupts the test fixtures in many ways and checks that the
// library never crashes, hangs or throws a programming error (TypeError etc.).
// Usage: node test/tools/fuzz.mjs [iterations=1000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '../../src/index.js');
const fixtures = path.resolve(here, '../fixtures');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'libr-fuzz-'));
const iterations = Number(process.argv[2] || 1000);

// Worker: runs one case. Prints OK / GRACEFUL / BUG.
const worker = path.join(work, 'case.mjs');
fs.writeFileSync(worker, `
import fs from 'node:fs';
import { PDFDocument, TextEditor, extractText } from ${JSON.stringify(lib)};
let stage = 'load';
try {
  const doc = new PDFDocument(fs.readFileSync(process.argv[2]));
  stage = 'extract'; for (let p = 0; p < Math.min(doc.pageCount, 3); p++) extractText(doc, p);
  stage = 'edit'; new TextEditor(doc, { useSystemFonts: false }).replace({ search: /[A-Za-z]{3,}/, replace: 'Changed text', maxCount: 2 });
  stage = 'save'; const a = doc.save(); const b = doc.save({ incremental: false });
  stage = 'reload'; new PDFDocument(a).pageCount; new PDFDocument(b).pageCount;
  console.log('OK');
} catch (e) {
  const bug = e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError;
  console.log((bug ? 'BUG ' : 'GRACEFUL ') + stage + ' ' + e.constructor.name + ': ' + e.message.slice(0, 120) + ' ' + ((e.stack || '').split('\\n')[1] || '').trim());
}
`);

// Seeds: the fixtures plus uncompressed copies (so mutations hit PDF syntax).
const { PDFDocument, PDFStream } = await import(lib);
const seeds = [];
for (const f of fs.readdirSync(fixtures).filter((f) => f.endsWith('.pdf') && !f.startsWith('encrypted'))) {
  const buf = fs.readFileSync(path.join(fixtures, f));
  seeds.push(buf);
  const doc = new PDFDocument(buf);
  for (const n of doc.objectNumbers) {
    const v = doc.getObject(n);
    if (v instanceof PDFStream && !v.dict.get('Length1') && !/Font|Image/.test(String(v.dict.get('Subtype')?.name))) {
      try { doc.setStreamData(v, doc.decodeStream(v), { compress: false }); doc.update(n); } catch { /* keep */ }
    }
  }
  seeds.push(doc.save({ incremental: false }));
}

let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const tokens = ['0', '-1', '99999999', '1e309', '[', ']', '<<', '>>', '(', ')', '/', 'R', 'obj', 'endobj', 'stream', 'endstream',
  'xref', 'trailer', 'null', '3 0 R', '1 0 R', 'BT', 'ET', 'Tj', 'TJ', 'Tf', 'Td', 'Tm', 'q', 'Q', 'cm', 'Do', 'BI', 'ID', 'EI'];
const stats = { OK: 0, GRACEFUL: 0, BUG: 0, HANG: 0, CRASH: 0 };
const problems = new Map();
for (let i = 0; i < iterations; i++) {
  const s = Buffer.from(seeds[rnd(seeds.length)]);
  let m = s;
  switch (rnd(5)) {
    case 0: for (let k = 0; k < 1 + rnd(30); k++) m[rnd(m.length)] = rnd(256); break;
    case 1: m = s.subarray(0, rnd(s.length)); break;
    case 2: { const p = rnd(s.length); m = Buffer.concat([s.subarray(0, p), Buffer.from(` ${tokens[rnd(tokens.length)]} `), s.subarray(p + rnd(20))]); break; }
    case 3: { const p = rnd(s.length), q = rnd(s.length); m = Buffer.concat([s.subarray(0, p), s.subarray(q, q + rnd(2000)), s.subarray(p)]); break; }
    default: for (let k = 0; k < 5; k++) { const p = rnd(m.length); m = Buffer.concat([m.subarray(0, p), Buffer.from(` ${tokens[rnd(tokens.length)]} `), m.subarray(p)]); }
  }
  const file = path.join(work, 'input.pdf');
  fs.writeFileSync(file, m);
  const r = spawnSync(process.execPath, ['--max-old-space-size=512', worker, file], { timeout: 20000, encoding: 'utf8' });
  let line = (r.stdout || '').trim().split('\n').pop() || '';
  let kind = line.split(' ')[0];
  if (r.signal) { kind = 'HANG'; line = `HANG/killed (${r.signal})`; }
  else if (!(kind in stats)) { kind = 'CRASH'; line = 'CRASH ' + (r.stderr || '').split('\n').find((l) => /Error/.test(l)); }
  stats[kind]++;
  if (kind === 'BUG' || kind === 'HANG' || kind === 'CRASH') {
    const key = line.replace(/\d+/g, 'N');
    if (!problems.has(key)) {
      const keep = path.join(work, `problem-${problems.size + 1}.pdf`);
      fs.copyFileSync(file, keep);
      problems.set(key, keep);
    }
  }
}
console.log(JSON.stringify(stats));
for (const [k, f] of problems) console.log(`${k}\n  -> ${f}`);
process.exit(problems.size ? 1 : 0);
