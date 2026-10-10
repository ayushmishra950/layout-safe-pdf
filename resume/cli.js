#!/usr/bin/env node
// Usage: node resume/cli.js data.json output.pdf
// The generator keeps nothing: the PDF is written only to the path you give.
import fs from 'node:fs';
import { buildResume } from './index.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node resume/cli.js data.json output.pdf');
  process.exit(1);
}
const r = buildResume(JSON.parse(fs.readFileSync(input, 'utf8')), { output });
console.log(`${output}\n  layout: ${r.layout}, pages: ${r.pages}, size: ${r.pdf.length} bytes`);
for (const w of r.warnings) console.warn('  warning:', w);
