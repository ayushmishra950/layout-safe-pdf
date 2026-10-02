// Visual → logical repair for Devanagari text extracted without ActualText.
//
// PDF glyphs are drawn in visual order: the i-matra (ि) comes before the
// consonant it follows in speech, and the reph (र्) comes after the syllable it
// precedes. Producers such as MS Word don't add ActualText, so the raw text
// reads "प्रमािणत" / "शमार्" instead of "प्रमाणित" / "शर्मा". This moves those
// characters back, but only where the glyph geometry confirms visual order.

const CONS = (c) => (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095f) || (c >= 0x0978 && c <= 0x097f);
const NUKTA = 0x093c;
const HALANT = 0x094d;
const SIGN = (c) => (c >= 0x0900 && c <= 0x0903) || (c >= 0x093a && c <= 0x094c && c !== 0x093c) || (c >= 0x094e && c <= 0x094f) ||
  (c >= 0x0955 && c <= 0x0957) || c === 0x0962 || c === 0x0963;
const cp = (ch) => (ch ? ch.codePointAt(0) : 0);
const I_MATRA = 'ि';

/** True if the chars contain Devanagari glyph text not covered by ActualText. */
export function needsRepair(chars) {
  return chars.some((c) => c.glyph && !c.glyph.cluster && cp(c.ch) >= 0x0900 && cp(c.ch) <= 0x097f);
}

/** End index (exclusive) of the consonant cluster starting at i, or i if none. */
function clusterEnd(chars, i) {
  let j = i;
  if (!CONS(cp(chars[j]?.ch))) return i;
  j++;
  if (cp(chars[j]?.ch) === NUKTA) j++;
  while (cp(chars[j]?.ch) === HALANT && CONS(cp(chars[j + 1]?.ch))) {
    j += 2;
    if (cp(chars[j]?.ch) === NUKTA) j++;
  }
  return j;
}

/** Start index of the syllable that ends right before position `end`. */
function syllableStart(chars, end) {
  let j = end - 1;
  while (j >= 0 && SIGN(cp(chars[j].ch))) j--;
  if (j < 0 || !(CONS(cp(chars[j].ch)) || cp(chars[j].ch) === NUKTA)) return -1;
  if (cp(chars[j].ch) === NUKTA) j--;
  while (j >= 2 && cp(chars[j - 1].ch) === HALANT && CONS(cp(chars[j - 2].ch))) j -= 2;
  return j;
}

/**
 * Reorders `chars` (LineChar[]) in place.
 * @param {Array<{ch:string, glyph:any, part:number}>} chars
 */
export function repairDevanagari(chars) {
  // 1. Pre-base i-matra drawn before its consonant cluster.
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c.ch !== I_MATRA || !c.glyph || c.glyph.cluster) continue;
    const prev = chars[i - 1]?.glyph;
    // Logical-order producers place ि left of the consonant drawn before it.
    if (prev && prev !== c.glyph && c.glyph.x < prev.x - 0.01) continue;
    const end = clusterEnd(chars, i + 1);
    if (end === i + 1) continue;
    chars.splice(i, 1);
    chars.splice(end - 1, 0, c);
    i = end - 1;
  }
  // 2. Reph drawn after the syllable it belongs to.
  for (let i = 1; i + 1 < chars.length; i++) {
    const r = chars[i];
    const h = chars[i + 1];
    if (r.ch !== 'र' || h.ch !== '्' || !r.glyph || r.glyph !== h.glyph || r.glyph.cluster) continue;
    // A reph glyph sits on the previous syllable; in logical order the next
    // consonant would be drawn underneath it (to its left).
    const next = chars[i + 2]?.glyph;
    if (next && next !== r.glyph && next.x < r.glyph.x - 0.01) continue;
    const start = syllableStart(chars, i);
    if (start < 0) continue;
    const pair = chars.splice(i, 2);
    chars.splice(start, 0, ...pair);
    i++;
  }
}
