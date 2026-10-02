// High-level one-call API: give a PDF and a list of edits, get the edited PDF
// and a report back.

import { writeFile } from 'node:fs/promises';
import { PDFDocument } from './core/document.js';
import { TextEditor } from './text/editor.js';
import { extractText } from './text/extract.js';
import { setFormFields } from './text/forms.js';

/**
 * @typedef {object} Edit
 * @property {string} search            text to find (or a regex source when `regex` is true)
 * @property {string} replace           new text ("$&" = the matched text)
 * @property {boolean} [regex]
 * @property {boolean} [ignoreCase]
 * @property {number[]} [pages]         1-based page numbers (default: all pages)
 * @property {'reflow'|'preserve'|'fit'} [mode]
 * @property {'auto'|'left'|'right'|'center'} [align]
 * @property {boolean} [wrap]
 * @property {number} [maxCount]
 * @property {number} [page]            select & replace: 1-based page of the selection
 * @property {number[]} [bbox]          select & replace: selected area [x0, y0, x1, y1] in PDF points
 */

/**
 * Edits a PDF in one call.
 *
 * @param {string | Buffer | Uint8Array} input  file path or PDF bytes
 * @param {Edit[]} edits
 * @param {{ password?: string, output?: string, incremental?: boolean, includeText?: boolean,
 *           editor?: object }} [options]
 *   output: also write the result to this path
 *   includeText: add the edited document's text to the report (useful for checks)
 *   editor: options for TextEditor (fonts, scriptFonts, fallbackFont, ...)
 * @returns {Promise<{ pdf: Buffer, report: EditReport }>}
 *
 * @typedef {object} EditReport
 * @property {boolean} ok                 true when every edit replaced something and nothing was skipped
 * @property {number} replaced            total replacements
 * @property {Array<{ search: string, replace: string, replaced: number, skipped: Array<{page:number, reason:string}>, warnings: string[], notFound?: boolean }>} edits
 * @property {string[]} warnings          document-level warnings (repairs, signatures)
 * @property {number} pageCount
 * @property {string} [text]
 */
export async function editPdf(input, edits = [], options = {}) {
  if (!Array.isArray(edits)) throw new TypeError('edits must be an array of { search, replace }');
  const doc = await PDFDocument.load(input, { password: options.password });
  const editor = new TextEditor(doc, options.editor || {});
  const report = { ok: true, replaced: 0, edits: [], warnings: [...doc.warnings], pageCount: doc.pageCount };

  for (const e of edits) {
    if (typeof e?.search !== 'string' || typeof e?.replace !== 'string') {
      throw new TypeError('each edit needs string "search" and "replace" fields');
    }
    const common = {
      search: e.regex ? new RegExp(e.search, e.ignoreCase ? 'iu' : 'u') : e.search,
      replace: e.replace,
      caseSensitive: !e.ignoreCase,
      mode: e.mode,
      align: e.align,
      wrap: e.wrap,
    };
    const r = e.bbox
      ? editor.replaceAt({ ...common, page: (e.page ?? 1) - 1, bbox: e.bbox })
      : editor.replace({
      search: e.regex ? new RegExp(e.search, e.ignoreCase ? 'iu' : 'u') : e.search,
      replace: e.replace,
      caseSensitive: !e.ignoreCase,
      pages: e.pages ? e.pages.map((p) => p - 1) : undefined,
      mode: e.mode,
      align: e.align,
      wrap: e.wrap,
      maxCount: e.maxCount,
    });
    report.replaced += r.replaced;
    report.edits.push({
      search: e.search,
      replace: e.replace,
      replaced: r.replaced,
      skipped: r.skipped.map((s) => ({ page: s.page + 1, reason: s.reason })),
      warnings: r.warnings,
      ...(r.replaced === 0 && r.skipped.length === 0 ? { notFound: true } : {}),
    });
    if (!r.replaced || r.skipped.length) report.ok = false;
  }

  // Fill form fields by name.
  if (options.fields) {
    const f = setFormFields(doc, options.fields, { allowReadOnly: options.allowReadOnly });
    report.fields = f;
    report.warnings.push(...f.warnings);
    if (f.notFound.length || f.errors.length) report.ok = false;
  }

  const pdf = doc.save({ incremental: options.incremental !== false });
  if (options.output) await writeFile(options.output, pdf);
  if (options.includeText) {
    report.text = extractText(await PDFDocument.load(pdf, { password: options.password }));
  }
  return { pdf, report };
}
