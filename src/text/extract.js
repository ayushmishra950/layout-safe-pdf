// Text extraction helpers.

import { ContentInterpreter } from '../content/interpreter.js';
import { buildLines, readingOrder } from './layout.js';

const round = (v) => Math.round(v * 100) / 100;

/**
 * Returns positioned lines for a page in reading order.
 * @param {import('../core/document.js').PDFDocument} doc
 * @param {number} pageIndex
 */
export function extractLines(doc, pageIndex) {
  const it = new ContentInterpreter(doc);
  it.runPage(doc.getPage(pageIndex));
  return readingOrder(buildLines(it.shows)).map((l) => {
    const g = l.glyphs[0];
    return {
      text: l.text,
      x: round(l.x),
      y: round(l.y),
      fontSize: round(l.size),
      fontName: g.show.font?.baseFont || '',
      bbox: l.bbox.map(round),
    };
  });
}

/** Plain text of one page (or all pages when pageIndex is omitted). */
export function extractText(doc, pageIndex) {
  const pages = pageIndex === undefined ? [...Array(doc.pageCount).keys()] : [pageIndex];
  return pages
    .map((p) => extractLines(doc, p).map((l) => l.text.replace(/\s+$/, '')).join('\n'))
    .join('\n\f\n');
}
