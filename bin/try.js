#!/usr/bin/env node
// Easy testing: put PDFs in try/input, edits in try/edits.json, run `npm run try`.
// Edited files and a report are written to try/output.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, TextEditor, extractText } from '../src/index.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'try');
const inputDir = path.join(root, 'input');
const outputDir = path.join(root, 'output');
await mkdir(outputDir, { recursive: true });

const edits = JSON.parse(await readFile(path.join(root, 'edits.json'), 'utf8'));
const files = (await readdir(inputDir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
if (!files.length) {
  console.log(`try/input mein koi PDF nahi mili. Apni PDF yahan copy kariye:\n  ${inputDir}`);
  process.exit(1);
}

const report = [];
const log = (s = '') => { console.log(s); report.push(s); };

for (const file of files) {
  log(`=== ${file}`);
  const relevant = edits.filter((e) => !e.file || e.file === file);
  try {
    const doc = await PDFDocument.load(path.join(inputDir, file), { password: relevant.find((e) => e.password)?.password });
    const editor = new TextEditor(doc);
    for (const e of relevant) {
      if (e.search === undefined || e.replace === undefined) continue;
      const r = editor.replace({
        search: e.regex ? new RegExp(e.search) : e.search,
        replace: e.replace,
        mode: e.mode,
        align: e.align,
        wrap: e.wrap,
        caseSensitive: e.ignoreCase ? false : true,
        pages: e.pages ? e.pages.map((p) => p - 1) : undefined,
      });
      const how = r.details.map((d) => (d.rewrapped ? `paragraph re-wrap ${Math.round(d.scale * 100)}%` : `${d.align}${d.scale < 1 ? ` ${Math.round(d.scale * 100)}%` : ''}`));
      log(`  "${e.search}" -> "${e.replace}": ${r.replaced} replaced${how.length ? ` (${[...new Set(how)].join(', ')})` : ''}`);
      if (!r.replaced && !r.skipped.length) log('    (yeh text PDF mein nahi mila)');
      for (const s of r.skipped) log(`    SKIPPED page ${s.page + 1}: ${s.reason}`);
      for (const w of [...new Set(r.warnings)]) log(`    note: ${w}`);
    }
    const outName = file.replace(/\.pdf$/i, '') + '-edited.pdf';
    await doc.saveAs(path.join(outputDir, outName));
    const text = extractText(await PDFDocument.load(path.join(outputDir, outName), { password: relevant.find((e) => e.password)?.password }));
    await writeFile(path.join(outputDir, outName.replace(/\.pdf$/, '.txt')), text);
    log(`  saved: try/output/${outName}`);
  } catch (err) {
    log(`  ERROR: ${err.message}`);
  }
  log();
}
await writeFile(path.join(outputDir, 'report.txt'), report.join('\n'));
console.log('Report: try/output/report.txt');
