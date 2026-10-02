// Text shaping: maps text to positioned glyphs using the font's OpenType
// tables. Implements the Indic (Devanagari) shaping model from Microsoft's
// "Developing OpenType Fonts for Devanagari Script" (dev2 / deva), following
// the same stages as HarfBuzz's Indic shaper:
//
//   cmap -> syllables -> initial reordering & masks -> basic features
//   (nukt akhn rphf rkrf blwf abvf half pstf vatu cjct) -> final reordering
//   (pre-base matra, reph) -> presentation features (pres abvs blws psts haln calt)
//   -> GPOS (kern dist abvm blwm mark mkmk)

import { GDEF, GSUB, GPOS, LayoutEngine } from './opentype.js';

// ---- Devanagari character categories -----------------------------------------------------

// C consonant, R ra, V independent vowel, N nukta, H halant, J ZWJ, Z ZWNJ,
// M matra, S syllable modifier, A accent, P placeholder, X other
function category(cp) {
  if (cp === 0x0930) return 'R';
  if ((cp >= 0x0915 && cp <= 0x0939) || (cp >= 0x0958 && cp <= 0x095f) || (cp >= 0x0978 && cp <= 0x097f)) return 'C';
  if ((cp >= 0x0904 && cp <= 0x0914) || cp === 0x0960 || cp === 0x0961 || (cp >= 0x0972 && cp <= 0x0977)) return 'V';
  if (cp === 0x093c) return 'N';
  if (cp === 0x094d) return 'H';
  if (cp === 0x200d) return 'J';
  if (cp === 0x200c) return 'Z';
  if ((cp >= 0x093a && cp <= 0x093b) || (cp >= 0x093e && cp <= 0x094c) || (cp >= 0x094e && cp <= 0x094f) ||
      (cp >= 0x0955 && cp <= 0x0957) || cp === 0x0962 || cp === 0x0963) return 'M';
  if (cp >= 0x0900 && cp <= 0x0903) return 'S';
  if (cp >= 0x0951 && cp <= 0x0954) return 'A';
  if (cp === 0x25cc || cp === 0x00a0) return 'P';
  return 'X';
}

const PRE_BASE_MATRAS = new Set([0x093f, 0x094e]);

export function isDevanagari(text) {
  return /[ऀ-ॿ]/.test(text);
}

// Syllable grammar over the category string (simplified HarfBuzz Indic machine).
const cn = '[CR]J?N?';
const halantGroup = '[JZ]?H(?:JN?)?';
const matraGroup = '[JZ]*MN?H?';
const tail = '(?:[JZ]?S{1,2}Z?)?A*';
const SYLLABLES = [
  ['consonant', new RegExp(`(?:${cn}${halantGroup}){0,4}${cn}A?(?:${halantGroup}Z?|(?:${matraGroup})*)${tail}`, 'y')],
  ['vowel', new RegExp(`(?:RH)?VN?(?:J|${halantGroup}${cn})*(?:${matraGroup})*${tail}`, 'y')],
  ['standalone', new RegExp(`PN?(?:${halantGroup}${cn})*(?:${matraGroup})*${tail}`, 'y')],
  ['broken', new RegExp(`(?:N|H|(?:${matraGroup})+|S)+${tail}`, 'y')],
];

function findSyllables(cats) {
  const out = [];
  let i = 0;
  while (i < cats.length) {
    let found = null;
    if (cats[i] !== 'X') {
      for (const [kind, re] of SYLLABLES) {
        re.lastIndex = i;
        const m = re.exec(cats);
        if (m && m[0].length) {
          found = { kind, start: i, end: i + m[0].length };
          break;
        }
      }
    }
    if (!found) found = { kind: 'other', start: i, end: i + 1 };
    out.push(found);
    i = found.end;
  }
  return out;
}

// Feature masks
const F = {
  GLOBAL: 1, RPHF: 2, HALF: 4, POST: 8, INIT: 16,
};

const BASIC_FEATURES = [
  ['nukt', F.GLOBAL], ['akhn', F.GLOBAL], ['rphf', F.RPHF], ['rkrf', F.GLOBAL], ['pref', F.POST],
  ['blwf', F.POST], ['abvf', F.POST], ['half', F.HALF], ['pstf', F.POST], ['vatu', F.GLOBAL], ['cjct', F.GLOBAL],
];
const PRESENTATION_FEATURES = ['init', 'pres', 'abvs', 'blws', 'psts', 'haln', 'calt', 'clig', 'rlig', 'liga'];
const POSITION_FEATURES = ['kern', 'dist', 'abvm', 'blwm', 'mark', 'mkmk'];

/**
 * Shaper bound to one font.
 */
export class Shaper {
  /** @param {import('./truetype.js').TrueTypeFont} ttf */
  constructor(ttf) {
    this.ttf = ttf;
    const gsub = ttf.table('GSUB');
    const gpos = ttf.table('GPOS');
    this.engine = new LayoutEngine({
      gdef: new GDEF(ttf.table('GDEF')),
      gsub: gsub ? new GSUB(gsub) : null,
      gpos: gpos ? new GPOS(gpos) : null,
    });
    this.gsubLs = this.engine.gsub?.langSys(['dev2', 'deva', 'DFLT', 'latn']) || null;
    this.gposLs = this.engine.gpos?.langSys(['dev2', 'deva', 'DFLT', 'latn']) || null;
    this.newSpec = this.gsubLs?.script === 'dev2';
  }

  get hasIndicLayout() {
    return !!this.gsubLs && (this.gsubLs.script === 'dev2' || this.gsubLs.script === 'deva');
  }

  #gsubLookups(tags) {
    if (!this.gsubLs) return [];
    const set = new Set();
    for (const t of tags) for (const l of this.engine.gsub.lookupsFor(this.gsubLs.ls, t)) set.add(l);
    return [...set].sort((a, b) => a - b);
  }

  #gposLookups(tags) {
    if (!this.gposLs) return [];
    const set = new Set();
    for (const t of tags) for (const l of this.engine.gpos.lookupsFor(this.gposLs.ls, t)) set.add(l);
    return [...set].sort((a, b) => a - b);
  }

  /** Would applying `feature` to these glyphs change them? (used to detect reph / below forms) */
  #wouldSubstitute(gids, feature) {
    const lookups = this.#gsubLookups([feature]);
    if (!lookups.length) return false;
    const buf = gids.map((gid, i) => ({ gid, cluster: i, mask: ~0 }));
    this.engine.substitute(buf, lookups);
    return buf.length !== gids.length || buf.some((g, i) => g.gid !== gids[i]);
  }

  #glyph(cp) {
    let gid = this.ttf.glyphForCodePoint(cp);
    if (!gid && cp >= 0x0958 && cp <= 0x095f) gid = 0; // decomposition handled by caller
    return gid;
  }

  /**
   * Shapes text into glyphs with positions in font units.
   * @param {string} text
   * @returns {Array<{ gid:number, cluster:number, xAdvance:number, yAdvance:number, xOffset:number, yOffset:number }>}
   */
  shape(text) {
    // Decompose nukta consonants the font lacks (क़ -> क + ़).
    const NUKTA_DECOMP = { 0x0958: 0x0915, 0x0959: 0x0916, 0x095a: 0x0917, 0x095b: 0x091c, 0x095c: 0x0921, 0x095d: 0x0922, 0x095e: 0x092b, 0x095f: 0x092f };
    const cps = [];
    let ci = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (NUKTA_DECOMP[cp] && !this.ttf.glyphForCodePoint(cp)) {
        cps.push({ cp: NUKTA_DECOMP[cp], cluster: ci }, { cp: 0x093c, cluster: ci });
      } else cps.push({ cp, cluster: ci });
      ci += ch.length;
    }
    const cats = cps.map((c) => category(c.cp)).join('');
    const syllables = findSyllables(cats);

    // Build the buffer, inserting dotted circles for broken clusters.
    const buf = [];
    const sylBounds = [];
    for (const syl of syllables) {
      const start = buf.length;
      if (syl.kind === 'broken' && this.ttf.glyphForCodePoint(0x25cc)) {
        buf.push(this.#entry(0x25cc, cps[syl.start].cluster, 'P'));
      }
      for (let i = syl.start; i < syl.end; i++) buf.push(this.#entry(cps[i].cp, cps[i].cluster, cats[i]));
      sylBounds.push({ kind: syl.kind, start, end: buf.length });
    }
    buf.forEach((g, i) => (g.sylIndex = sylBounds.findIndex((s) => i >= s.start && i < s.end)));

    if (this.hasIndicLayout) {
      for (const s of sylBounds) if (s.kind !== 'other') this.#initialReorder(buf, s);
      // locl / ccmp first, then the basic features one by one.
      this.engine.substitute(buf, this.#gsubLookups(['locl', 'ccmp']), F.GLOBAL);
      for (const [tag, mask] of BASIC_FEATURES) this.engine.substitute(buf, this.#gsubLookups([tag]), mask);
      this.#finalReorder(buf);
      // 'init' only applies to the first syllable of a word.
      buf.forEach((g, i) => {
        const prev = buf[i - 1];
        if (i === 0 || (prev.sylIndex !== g.sylIndex && !/[\u0900-\u097f]/.test(String.fromCodePoint(prev.cp ?? 32)))) {
          for (let k = i; k < buf.length && buf[k].sylIndex === g.sylIndex; k++) buf[k].mask |= F.INIT;
        }
      });
      this.engine.substitute(buf, this.#gsubLookups(['init']), F.INIT);
      this.engine.substitute(buf, this.#gsubLookups(PRESENTATION_FEATURES.filter((t) => t !== 'init')), F.GLOBAL);
    } else if (this.gsubLs) {
      this.engine.substitute(buf, this.#gsubLookups(['locl', 'ccmp', 'calt', 'clig', 'liga', 'rlig']), F.GLOBAL);
    }

    // Positioning
    for (const g of buf) {
      g.xAdvance = this.ttf.advances[g.gid] || 0;
      g.yAdvance = 0;
      g.xOffset = 0;
      g.yOffset = 0;
    }
    if (this.gposLs) this.engine.position(buf, this.#gposLookups(POSITION_FEATURES));
    else this.#legacyKern(buf);

    return buf.map((g) => ({
      gid: g.gid, cluster: g.cluster, text: g.text, xAdvance: g.xAdvance, yAdvance: g.yAdvance, xOffset: g.xOffset, yOffset: g.yOffset,
    }));
  }

  #entry(cp, cluster, cat) {
    return { gid: this.#glyph(cp), cp, cat, cluster, mask: F.GLOBAL, text: String.fromCodePoint(cp) };
  }

  /** Base consonant, reph and feature masks for one syllable (logical order kept). */
  #initialReorder(buf, s) {
    const { start, end } = s;
    if (s.kind !== 'consonant' && s.kind !== 'vowel') return;
    const g = (i) => buf[i];
    const isCons = (i) => g(i).cat === 'C' || g(i).cat === 'R';

    // Reph: Ra + Halant at the start, followed by more (and not Ra H ZWJ).
    let limit = start;
    let hasReph = false;
    if (end - start >= 3 && g(start).cat === 'R' && g(start + 1).cat === 'H' && g(start + 2).cat !== 'J' &&
        this.#wouldSubstitute([g(start).gid, g(start + 1).gid], 'rphf')) {
      hasReph = true;
      limit = start + 2;
    }

    // Base: last consonant that doesn't take a below-base form.
    let base = -1;
    if (s.kind === 'consonant') {
      for (let i = end - 1; i >= limit; i--) {
        if (!isCons(i)) continue;
        const belowForm = i > limit && g(i - 1).cat === 'H' && g(i).cat === 'R' &&
          (this.#wouldSubstitute([g(i - 1).gid, g(i).gid], 'blwf') || this.#wouldSubstitute([g(i - 1).gid, g(i).gid], 'rkrf'));
        if (belowForm) continue;
        base = i;
        break;
      }
      if (base < 0) base = hasReph && limit < end && isCons(limit) ? limit : start;
    } else {
      base = limit; // vowel syllable: the independent vowel is the base
    }

    for (let i = start; i < end; i++) {
      const e = g(i);
      e.syllableStart = start;
      if (hasReph && i < start + 2) {
        e.mask |= F.RPHF;
        e.isReph = true;
      } else if (i < base) {
        e.mask |= F.HALF;
      } else if (i > base) {
        e.mask |= F.POST;
      }
      if (i === base) e.isBase = true;
    }
  }

  /** Moves pre-base matras to the front and the reph glyph to the end of each syllable. */
  #finalReorder(buf) {
    // Group current buffer by syllable index (buffer may have changed length).
    let i = 0;
    while (i < buf.length) {
      const sIdx = buf[i].sylIndex;
      let j = i;
      while (j < buf.length && buf[j].sylIndex === sIdx) j++;
      this.#reorderSyllable(buf, i, j);
      i = j;
    }
  }

  #reorderSyllable(buf, start, end) {
    // 1. Pre-base matra: to the very start (after a reph that is still in front).
    for (let i = start; i < end; i++) {
      if (!PRE_BASE_MATRAS.has(buf[i].cp) || buf[i].cat !== 'M') continue;
      let target = start;
      while (target < i && buf[target].isReph) target++;
      if (target < i) {
        const [m] = buf.splice(i, 1);
        buf.splice(target, 0, m);
      }
    }
    // 2. Reph: formed by rphf (a substituted glyph flagged isReph at the front).
    const rephIdx = buf.findIndex((g, k) => k >= start && k < end && g.isReph && g.substituted);
    if (rephIdx >= 0) {
      // If an explicit (visible) halant remains between the reph and the base,
      // the reph goes right after it (e.g. आर्ट्स).
      const baseIdx = buf.findIndex((g, k) => k > rephIdx && k < end && g.isBase);
      for (let k = rephIdx + 1; baseIdx > 0 && k < baseIdx; k++) {
        if (buf[k].cat !== 'H') continue;
        let after = k + 1;
        while (after < end && (buf[after].cat === 'J' || buf[after].cat === 'Z')) after++;
        const [r] = buf.splice(rephIdx, 1);
        buf.splice(after - 1, 0, r);
        for (let q = start; q < end; q++) buf[q].mask |= F.GLOBAL;
        return;
      }
      let target = end - 1;
      while (target > rephIdx && (buf[target].cat === 'S' || buf[target].cat === 'A')) target--;
      if (target > rephIdx) {
        const [r] = buf.splice(rephIdx, 1);
        buf.splice(target, 0, r);
      }
    }
    // Presentation features (pres/abvs/...) run on everything afterwards.
    for (let i = start; i < end; i++) buf[i].mask |= F.GLOBAL;
  }

  /** Old-style 'kern' table (format 0) for fonts without GPOS. */
  #legacyKern(buf) {
    const k = this.ttf.table('kern');
    if (!k || k.readUInt16BE(0) !== 0) return;
    if (!this.kernPairs) {
      this.kernPairs = new Map();
      const n = k.readUInt16BE(2);
      let o = 4;
      for (let t = 0; t < n; t++) {
        const len = k.readUInt16BE(o + 2);
        const coverage = k.readUInt16BE(o + 4);
        if (coverage >> 8 === 0 && (coverage & 0x7) === 1) { // horizontal, not minimum/cross-stream
          const np = k.readUInt16BE(o + 6);
          for (let p = 0; p < np; p++) {
            const r = o + 14 + p * 6;
            this.kernPairs.set((k.readUInt16BE(r) << 16) | k.readUInt16BE(r + 2), k.readInt16BE(r + 4));
          }
        }
        o += len;
      }
    }
    for (let i = 0; i + 1 < buf.length; i++) {
      const v = this.kernPairs.get((buf[i].gid << 16) | buf[i + 1].gid);
      if (v) buf[i].xAdvance += v;
    }
  }
}
