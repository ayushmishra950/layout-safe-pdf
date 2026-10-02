#!/usr/bin/env node
// Command-line interface for libr-pdf.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PDFDocument, TextEditor, extractText, extractLines, ContentInterpreter, diagnose } from '../src/index.js';

const USAGE = `libr-pdf – zero-dependency PDF text editing

Usage:
  libr-pdf info    <file.pdf>
  libr-pdf text    <file.pdf> [--page N] [--positions]
  libr-pdf find    <file.pdf> <text> [--regex] [--ignore-case]
  libr-pdf replace <in.pdf> <out.pdf> --search <text> --replace <text>
                   [--mode reflow|preserve|fit] [--align auto|left|right|center]
                   [--page N] [--regex] [--ignore-case] [--full] [--no-wrap]
                   [--font Name=path.ttf] [--script-font deva=path.ttf]
  libr-pdf replace <in.pdf> <out.pdf> --spec edits.json
  libr-pdf encrypt <in.pdf> <out.pdf> --user-password <pw> [--owner-password <pw>] [--no-copy] [--no-print] [--no-modify]
  libr-pdf decrypt <in.pdf> <out.pdf> --password <pw>
  libr-pdf doctor   (checks Node.js and the fonts needed for English and Hindi edits)

Common options:
  --password <pw>   password for encrypted files
  --full            write a full rewrite instead of an incremental update

edits.json: [{ "search": "Old", "replace": "New", "mode": "reflow", "regex": false }]
Pages are 1-based on the command line.`;

let parsed;
try {
  parsed = parseArgs({
  allowPositionals: true,
  options: {
    page: { type: 'string' },
    password: { type: 'string' },
    search: { type: 'string' },
    replace: { type: 'string' },
    mode: { type: 'string' },
    align: { type: 'string' },
    regex: { type: 'boolean' },
    'ignore-case': { type: 'boolean' },
    full: { type: 'boolean' },
    positions: { type: 'boolean' },
    spec: { type: 'string' },
    font: { type: 'string', multiple: true },
    'script-font': { type: 'string', multiple: true },
    'no-wrap': { type: 'boolean' },
    'user-password': { type: 'string' },
    'owner-password': { type: 'string' },
    'no-copy': { type: 'boolean' },
    'no-print': { type: 'boolean' },
    'no-modify': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
const { values: opts, positionals } = parsed;

const [cmd, ...args] = positionals;
if (!cmd || opts.help) {
  console.log(USAGE);
  process.exit(cmd ? 0 : 1);
}

if (opts.page !== undefined && !(Number.isInteger(Number(opts.page)) && Number(opts.page) >= 1)) {
  console.error(`Error: --page must be a page number starting at 1 (got "${opts.page}")`);
  process.exit(1);
}
const pages = opts.page ? [Number(opts.page) - 1] : undefined;
/** "Name=path" -> [Name, path] (the path may itself contain "="). */
const splitPair = (s) => {
  const i = s.indexOf('=');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
};
const load = (file) => PDFDocument.load(file, { password: opts.password });
const toPattern = (s, isRegex) => (isRegex ? new RegExp(s) : s);

async function main() {
  switch (cmd) {
    case 'info': {
      const doc = await load(args[0]);
      console.log(`PDF version : ${doc.version}`);
      console.log(`Pages       : ${doc.pageCount}`);
      console.log(`Encrypted   : ${doc.isEncrypted ? `yes (R${doc.security.R}, ${doc.security.stmMethod})` : 'no'}`);
      console.log(`Xref        : ${doc.lastXrefIsStream ? 'stream' : 'table'}${doc.repaired ? ' (repaired)' : ''}`);
      const info = doc.info;
      if (info) for (const [k, v] of info.entries()) {
        const val = doc.resolve(v);
        if (val && typeof val.toText === 'function') console.log(`${k.padEnd(12)}: ${val.toText()}`);
      }
      for (let i = 0; i < doc.pageCount; i++) {
        const it = new ContentInterpreter(doc);
        it.runPage(doc.getPage(i));
        const fonts = new Set(it.shows.filter((s) => s.font).map((s) => `${s.font.baseFont || '(unnamed)'} [${s.font.subtype}${s.font.embedded ? ', embedded' : ''}${s.font.isSubset ? ', subset' : ''}]`));
        const p = doc.getPage(i);
        console.log(`Page ${i + 1}: ${p.width}x${p.height}pt, fonts: ${[...fonts].join('; ') || 'none'}`);
      }
      if (doc.warnings.length) console.log('Warnings:\n  ' + doc.warnings.join('\n  '));
      break;
    }
    case 'text': {
      const doc = await load(args[0]);
      if (opts.positions) {
        for (const p of pages || [...Array(doc.pageCount).keys()]) {
          for (const l of extractLines(doc, p)) {
            console.log(`p${p + 1} x=${l.x} y=${l.y} size=${l.fontSize} ${l.fontName}: ${l.text}`);
          }
        }
      } else {
        console.log(pages ? extractText(doc, pages[0]) : extractText(doc));
      }
      break;
    }
    case 'find': {
      const doc = await load(args[0]);
      const hits = new TextEditor(doc).find(toPattern(args[1], opts.regex), { pages, caseSensitive: !opts['ignore-case'] });
      for (const h of hits) console.log(`page ${h.page + 1} [${h.bbox.join(', ')}] ${h.fontName} ${h.fontSize}pt: ${h.text}`);
      console.log(`${hits.length} match(es)`);
      break;
    }
    case 'replace': {
      const [input, output] = args;
      if (!input || !output) throw new Error('replace needs <in.pdf> <out.pdf>');
      const doc = await load(input);
      const fonts = Object.fromEntries((opts.font || []).map(splitPair));
      const scriptFonts = Object.fromEntries((opts['script-font'] || []).map(splitPair));
      const editorOptions = {};
      if (Object.keys(fonts).length) editorOptions.fonts = fonts;
      if (Object.keys(scriptFonts).length) editorOptions.scriptFonts = scriptFonts;
      const editor = new TextEditor(doc, editorOptions);
      const edits = opts.spec
        ? JSON.parse(await readFile(opts.spec, 'utf8'))
        : [{ search: opts.search, replace: opts.replace, mode: opts.mode, align: opts.align, regex: opts.regex }];
      let total = 0;
      for (const e of edits) {
        if (e.search === undefined || e.replace === undefined) throw new Error('Each edit needs search and replace');
        const r = editor.replace({
          search: toPattern(e.search, e.regex),
          replace: e.replace,
          mode: e.mode,
          align: e.align,
          pages: e.pages ? e.pages.map((p) => p - 1) : pages,
          caseSensitive: !(e.ignoreCase ?? opts['ignore-case']),
          wrap: e.wrap ?? !opts['no-wrap'],
        });
        total += r.replaced;
        const wrappedCount = r.details.filter((d) => d.rewrapped).length;
        console.log(`"${e.search}" -> "${e.replace}": ${r.replaced} replaced${wrappedCount ? ` (${wrappedCount} paragraph re-wrap)` : ''}`);
        for (const s of r.skipped) console.log(`  skipped on page ${s.page + 1}: ${s.reason}`);
        for (const w of r.warnings) console.log(`  warning: ${w}`);
      }
      await doc.saveAs(output, { incremental: !opts.full });
      console.log(`Saved ${output} (${total} replacement(s), ${opts.full ? 'full rewrite' : 'incremental update'})`);
      break;
    }
    case 'doctor': {
      const r = diagnose();
      for (const c of r.checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
        if (c.fix) console.log(`    fix: ${c.fix}`);
      }
      console.log(r.ok ? '\nAll good: English and Hindi editing are available.' : '\nSome checks failed; see the fixes above.');
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'encrypt': {
      const [input, output] = args;
      const doc = await load(input);
      if (doc.isEncrypted) doc.removeEncryption();
      doc.encrypt({
        userPassword: opts['user-password'] ?? '',
        ownerPassword: opts['owner-password'],
        permissions: { copy: !opts['no-copy'], print: !opts['no-print'], printHighQuality: !opts['no-print'], modify: !opts['no-modify'] },
      });
      await doc.saveAs(output);
      console.log(`Saved ${output} (AES-256)`);
      break;
    }
    case 'decrypt': {
      const [input, output] = args;
      const doc = await load(input);
      if (!doc.isEncrypted) throw new Error('Document is not encrypted');
      doc.removeEncryption();
      await doc.saveAs(output);
      console.log(`Saved ${output} (no encryption)`);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
