// Advance widths of the standard 14 fonts for ASCII 32..126 (from the Adobe
// Core14 AFM files). Used only when a simple font has no /Widths array.

const parse = (s) => s.trim().split(/\s+/).map(Number);

const HELVETICA = parse(`
278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556
278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667
611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833
556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584`);

const HELVETICA_BOLD = parse(`
278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556
333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667
611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889
611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584`);

const TIMES_ROMAN = parse(`
250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500
278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556
611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778
500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541`);

const TIMES_BOLD = parse(`
250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500
333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556
667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833
556 500 556 556 444 389 333 556 500 722 500 500 444 394 220 394 520`);

const TIMES_ITALIC = parse(`
250 333 420 500 500 833 778 214 333 333 500 675 250 333 250 278 500 500 500 500 500 500 500 500 500 500
333 333 675 675 675 500 920 611 611 667 722 611 611 722 722 333 444 667 556 833 667 722 611 722 611 500
556 722 611 833 611 556 556 389 278 389 422 500 333 500 500 444 500 444 278 500 500 278 278 444 278 722
500 500 500 500 389 389 278 500 444 667 444 444 389 400 275 400 541`);

const TIMES_BOLD_ITALIC = parse(`
250 389 555 500 500 833 778 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500
333 333 570 570 570 500 832 667 667 667 722 667 667 722 778 389 500 667 611 889 722 722 611 722 667 556
611 722 667 889 667 611 611 333 278 333 570 500 333 500 500 444 500 444 333 500 556 278 278 500 278 778
556 500 500 500 389 389 278 556 444 667 500 444 389 348 220 348 570`);

const COURIER = new Array(95).fill(600);

const TABLES = {
  Helvetica: HELVETICA,
  'Helvetica-Oblique': HELVETICA,
  'Helvetica-Bold': HELVETICA_BOLD,
  'Helvetica-BoldOblique': HELVETICA_BOLD,
  'Times-Roman': TIMES_ROMAN,
  'Times-Bold': TIMES_BOLD,
  'Times-Italic': TIMES_ITALIC,
  'Times-BoldItalic': TIMES_BOLD_ITALIC,
  Courier: COURIER,
  'Courier-Bold': COURIER,
  'Courier-Oblique': COURIER,
  'Courier-BoldOblique': COURIER,
};

const ALIASES = {
  Arial: 'Helvetica', 'Arial,Bold': 'Helvetica-Bold', 'Arial-BoldMT': 'Helvetica-Bold', ArialMT: 'Helvetica',
  'Arial,Italic': 'Helvetica-Oblique', 'Arial-ItalicMT': 'Helvetica-Oblique',
  'Arial,BoldItalic': 'Helvetica-BoldOblique', 'Arial-BoldItalicMT': 'Helvetica-BoldOblique',
  TimesNewRoman: 'Times-Roman', TimesNewRomanPSMT: 'Times-Roman', 'TimesNewRoman,Bold': 'Times-Bold',
  'TimesNewRomanPS-BoldMT': 'Times-Bold', 'TimesNewRoman,Italic': 'Times-Italic',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic', CourierNew: 'Courier', CourierNewPSMT: 'Courier',
};

export const STANDARD_14 = new Set([...Object.keys(TABLES), 'Symbol', 'ZapfDingbats']);

/** Normalizes a BaseFont name (drops subset prefix) to a standard-14 name, if any. */
export function standardFontName(baseFont) {
  if (!baseFont) return null;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  if (TABLES[name]) return name;
  if (ALIASES[name]) return ALIASES[name];
  return null;
}

/**
 * Width (glyph space, 1/1000 em) of a Unicode character in a standard font.
 * Returns undefined when unknown.
 */
export function standardWidth(fontName, ch) {
  const table = TABLES[fontName];
  if (!table) return undefined;
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return table[c - 32];
  if (c === 0xa0) return table[0];
  return undefined;
}
