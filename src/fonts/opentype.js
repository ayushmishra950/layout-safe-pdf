// OpenType layout tables: GDEF, GSUB and GPOS (OpenType spec, "Common Table
// Formats", "GSUB", "GPOS", "GDEF").
//
// The engine works on a glyph buffer:
//   { gid, cluster, mask, ligId, ligComp, xAdvance, yAdvance, xOffset, yOffset, attachTo }
// and applies lookups the way HarfBuzz does: per lookup, scanning forward,
// skipping glyphs ignored by the lookup flags.

// ---- small readers ----------------------------------------------------------------

const u16 = (b, o) => b.readUInt16BE(o);
const i16 = (b, o) => b.readInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);
const tag = (b, o) => b.toString('latin1', o, o + 4);

/** Coverage table -> Map<gid, coverageIndex> */
function readCoverage(b, o) {
  const map = new Map();
  const format = u16(b, o);
  if (format === 1) {
    const n = u16(b, o + 2);
    for (let i = 0; i < n; i++) map.set(u16(b, o + 4 + i * 2), i);
  } else if (format === 2) {
    const n = u16(b, o + 2);
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 6;
      const start = u16(b, r), end = u16(b, r + 2), idx = u16(b, r + 4);
      for (let g = start; g <= end; g++) map.set(g, idx + g - start);
    }
  }
  return map;
}

/** ClassDef table -> (gid) => class */
/** ClassDef at `base + rel`; a zero relative offset means "no ClassDef" (all class 0). */
function classDefAt(b, base, rel) {
  return rel ? readClassDef(b, base + rel) : () => 0;
}

function readClassDef(b, o) {
  const map = new Map();
  const format = u16(b, o);
  if (format === 1) {
    const start = u16(b, o + 2);
    const n = u16(b, o + 4);
    for (let i = 0; i < n; i++) map.set(start + i, u16(b, o + 6 + i * 2));
  } else if (format === 2) {
    const n = u16(b, o + 2);
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 6;
      const start = u16(b, r), end = u16(b, r + 2), cls = u16(b, r + 4);
      for (let g = start; g <= end; g++) map.set(g, cls);
    }
  }
  return (g) => map.get(g) || 0;
}

// ---- GDEF -------------------------------------------------------------------------

export const GLYPH_BASE = 1, GLYPH_LIGATURE = 2, GLYPH_MARK = 3, GLYPH_COMPONENT = 4;

export class GDEF {
  constructor(b) {
    this.glyphClass = () => 0;
    this.markAttachClass = () => 0;
    this.markSets = [];
    if (!b) return;
    const major = u16(b, 0), minor = u16(b, 2);
    if (major !== 1) return;
    this.glyphClass = classDefAt(b, 0, u16(b, 4));
    this.markAttachClass = classDefAt(b, 0, u16(b, 10));
    if (minor >= 2 && b.length >= 14) {
      const msOff = u16(b, 12);
      if (msOff) {
        const n = u16(b, msOff + 2);
        for (let i = 0; i < n; i++) this.markSets.push(readCoverage(b, msOff + u32(b, msOff + 4 + i * 4)));
      }
    }
  }
}

// ---- common layout structure ------------------------------------------------------------

class LayoutTable {
  /**
   * @param {Buffer} b
   * @param {(b:Buffer, type:number, offset:number) => any} parseSubtable
   * @param {number} extensionType
   */
  constructor(b, parseSubtable, extensionType) {
    this.b = b;
    const scriptList = u16(b, 4);
    const featureList = u16(b, 6);
    const lookupList = u16(b, 8);

    // Scripts: tag -> { default: langSys, langs: Map<tag, langSys> }
    this.scripts = new Map();
    const ns = u16(b, scriptList);
    for (let i = 0; i < ns; i++) {
      const r = scriptList + 2 + i * 6;
      const so = scriptList + u16(b, r + 4);
      const def = u16(b, so);
      const langs = new Map();
      const nl = u16(b, so + 2);
      for (let k = 0; k < nl; k++) {
        const lr = so + 4 + k * 6;
        langs.set(tag(b, lr), readLangSys(b, so + u16(b, lr + 4)));
      }
      this.scripts.set(tag(b, r), { default: def ? readLangSys(b, so + def) : null, langs });
    }

    this.features = [];
    const nf = u16(b, featureList);
    for (let i = 0; i < nf; i++) {
      const r = featureList + 2 + i * 6;
      const fo = featureList + u16(b, r + 4);
      const nli = u16(b, fo + 2);
      const lookups = [];
      for (let k = 0; k < nli; k++) lookups.push(u16(b, fo + 4 + k * 2));
      this.features.push({ tag: tag(b, r), lookups });
    }

    this.lookups = [];
    const nlk = u16(b, lookupList);
    for (let i = 0; i < nlk; i++) {
      const lo = lookupList + u16(b, lookupList + 2 + i * 2);
      let type = u16(b, lo);
      const flag = u16(b, lo + 2);
      const n = u16(b, lo + 4);
      const subtables = [];
      for (let k = 0; k < n; k++) {
        let so = lo + u16(b, lo + 6 + k * 2);
        let t = type;
        if (type === extensionType) {
          t = u16(b, so + 2);
          so += u32(b, so + 4);
        }
        try {
          const st = parseSubtable(b, t, so);
          if (st) subtables.push(st);
        } catch { /* skip malformed subtable */ }
        if (type === extensionType) type = t === extensionType ? type : type;
      }
      const markFilteringSet = flag & 0x10 ? u16(b, lo + 6 + n * 2) : null;
      this.lookups.push({ index: i, flag, markFilteringSet, subtables });
    }
  }

  /** Picks the LangSys for a script (falling back to DFLT/latn). */
  langSys(scripts, lang) {
    for (const s of scripts) {
      const sc = this.scripts.get(s);
      if (!sc) continue;
      if (lang && sc.langs.has(lang)) return { script: s, ls: sc.langs.get(lang) };
      if (sc.default) return { script: s, ls: sc.default };
      const first = sc.langs.values().next().value;
      if (first) return { script: s, ls: first };
    }
    return null;
  }

  /**
   * Lookup indices for a feature tag in a LangSys, in lookup-list order.
   */
  lookupsFor(ls, featureTag) {
    const out = [];
    if (!ls) return out;
    const idx = [...ls.features];
    if (ls.required !== 0xffff) idx.push(ls.required);
    for (const fi of idx) {
      const f = this.features[fi];
      if (f && f.tag === featureTag) out.push(...f.lookups);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  }

  hasFeature(ls, featureTag) {
    return this.lookupsFor(ls, featureTag).length > 0;
  }
}

function readLangSys(b, o) {
  const required = u16(b, o + 2);
  const n = u16(b, o + 4);
  const features = [];
  for (let i = 0; i < n; i++) features.push(u16(b, o + 6 + i * 2));
  return { required, features };
}

// ---- contextual (shared by GSUB 5/6 and GPOS 7/8) ---------------------------------------------

function readSeqLookups(b, o, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seq: u16(b, o + i * 4), lookup: u16(b, o + i * 4 + 2) });
  return out;
}

function parseContext(b, o) {
  const format = u16(b, o);
  if (format === 1) {
    const cov = readCoverage(b, o + u16(b, o + 2));
    const n = u16(b, o + 4);
    const ruleSets = [];
    for (let i = 0; i < n; i++) {
      const rso = u16(b, o + 6 + i * 2);
      const rules = [];
      if (rso) {
        const base = o + rso;
        const nr = u16(b, base);
        for (let k = 0; k < nr; k++) {
          const ro = base + u16(b, base + 2 + k * 2);
          const gc = u16(b, ro), sc = u16(b, ro + 2);
          const input = [];
          for (let j = 1; j < gc; j++) input.push(u16(b, ro + 4 + (j - 1) * 2));
          rules.push({ input, lookups: readSeqLookups(b, ro + 4 + (gc - 1) * 2, sc) });
        }
      }
      ruleSets.push(rules);
    }
    return { kind: 'ctx', format, cov, ruleSets };
  }
  if (format === 2) {
    const cov = readCoverage(b, o + u16(b, o + 2));
    const cls = classDefAt(b, o, u16(b, o + 4));
    const n = u16(b, o + 6);
    const ruleSets = [];
    for (let i = 0; i < n; i++) {
      const rso = u16(b, o + 8 + i * 2);
      const rules = [];
      if (rso) {
        const base = o + rso;
        const nr = u16(b, base);
        for (let k = 0; k < nr; k++) {
          const ro = base + u16(b, base + 2 + k * 2);
          const gc = u16(b, ro), sc = u16(b, ro + 2);
          const input = [];
          for (let j = 1; j < gc; j++) input.push(u16(b, ro + 4 + (j - 1) * 2));
          rules.push({ input, lookups: readSeqLookups(b, ro + 4 + (gc - 1) * 2, sc) });
        }
      }
      ruleSets.push(rules);
    }
    return { kind: 'ctx', format, cov, cls, ruleSets };
  }
  if (format === 3) {
    const gc = u16(b, o + 2), sc = u16(b, o + 4);
    const covs = [];
    for (let i = 0; i < gc; i++) covs.push(readCoverage(b, o + u16(b, o + 6 + i * 2)));
    return { kind: 'ctx', format, covs, lookups: readSeqLookups(b, o + 6 + gc * 2, sc) };
  }
  return null;
}

function parseChainContext(b, o) {
  const format = u16(b, o);
  const readRule = (ro) => {
    let p = ro;
    const bc = u16(b, p); p += 2;
    const backtrack = []; for (let i = 0; i < bc; i++, p += 2) backtrack.push(u16(b, p));
    const ic = u16(b, p); p += 2;
    const input = []; for (let i = 1; i < ic; i++, p += 2) input.push(u16(b, p));
    const lc = u16(b, p); p += 2;
    const lookahead = []; for (let i = 0; i < lc; i++, p += 2) lookahead.push(u16(b, p));
    const sc = u16(b, p); p += 2;
    return { backtrack, input, lookahead, lookups: readSeqLookups(b, p, sc) };
  };
  if (format === 1 || format === 2) {
    let p = o + 2;
    const cov = readCoverage(b, o + u16(b, p)); p += 2;
    let bcls, icls, lcls;
    if (format === 2) {
      bcls = classDefAt(b, o, u16(b, p)); p += 2;
      icls = classDefAt(b, o, u16(b, p)); p += 2;
      lcls = classDefAt(b, o, u16(b, p)); p += 2;
    }
    const n = u16(b, p); p += 2;
    const ruleSets = [];
    for (let i = 0; i < n; i++) {
      const rso = u16(b, p + i * 2);
      const rules = [];
      if (rso) {
        const base = o + rso;
        const nr = u16(b, base);
        for (let k = 0; k < nr; k++) rules.push(readRule(base + u16(b, base + 2 + k * 2)));
      }
      ruleSets.push(rules);
    }
    return { kind: 'chain', format, cov, bcls, icls, lcls, ruleSets };
  }
  if (format === 3) {
    let p = o + 2;
    const readCovs = () => {
      const n = u16(b, p); p += 2;
      const covs = [];
      for (let i = 0; i < n; i++, p += 2) covs.push(readCoverage(b, o + u16(b, p)));
      return covs;
    };
    const backtrack = readCovs();
    const input = readCovs();
    const lookahead = readCovs();
    const sc = u16(b, p); p += 2;
    return { kind: 'chain', format, backtrack, input, lookahead, lookups: readSeqLookups(b, p, sc) };
  }
  return null;
}

// ---- GSUB ------------------------------------------------------------------------------

function parseGsubSubtable(b, type, o) {
  const format = u16(b, o);
  switch (type) {
    case 1: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      if (format === 1) return { type, cov, delta: i16(b, o + 4) };
      const n = u16(b, o + 4);
      const subs = [];
      for (let i = 0; i < n; i++) subs.push(u16(b, o + 6 + i * 2));
      return { type, cov, subs };
    }
    case 2:
    case 3: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      const n = u16(b, o + 4);
      const seqs = [];
      for (let i = 0; i < n; i++) {
        const so = o + u16(b, o + 6 + i * 2);
        const gc = u16(b, so);
        const gs = [];
        for (let k = 0; k < gc; k++) gs.push(u16(b, so + 2 + k * 2));
        seqs.push(gs);
      }
      return { type, cov, seqs };
    }
    case 4: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      const n = u16(b, o + 4);
      const sets = [];
      for (let i = 0; i < n; i++) {
        const so = o + u16(b, o + 6 + i * 2);
        const lc = u16(b, so);
        const ligs = [];
        for (let k = 0; k < lc; k++) {
          const lo = so + u16(b, so + 2 + k * 2);
          const lig = u16(b, lo);
          const cc = u16(b, lo + 2);
          const comps = [];
          for (let j = 1; j < cc; j++) comps.push(u16(b, lo + 4 + (j - 1) * 2));
          ligs.push({ lig, comps });
        }
        sets.push(ligs);
      }
      return { type, cov, sets };
    }
    case 5: return { type, ...parseContext(b, o) };
    case 6: return { type, ...parseChainContext(b, o) };
    case 8: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      let p = o + 4;
      const bc = u16(b, p); p += 2;
      const backtrack = []; for (let i = 0; i < bc; i++, p += 2) backtrack.push(readCoverage(b, o + u16(b, p)));
      const lc = u16(b, p); p += 2;
      const lookahead = []; for (let i = 0; i < lc; i++, p += 2) lookahead.push(readCoverage(b, o + u16(b, p)));
      const gc = u16(b, p); p += 2;
      const subs = []; for (let i = 0; i < gc; i++, p += 2) subs.push(u16(b, p));
      return { type, cov, backtrack, lookahead, subs };
    }
    default:
      return null;
  }
}

export class GSUB extends LayoutTable {
  constructor(b) {
    super(b, parseGsubSubtable, 7);
  }
}

// ---- GPOS ------------------------------------------------------------------------------

function valueRecordSize(fmt) {
  let n = 0;
  for (let i = 0; i < 8; i++) if (fmt & (1 << i)) n++;
  return n * 2;
}

function readValueRecord(b, o, fmt) {
  const v = { xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0 };
  let p = o;
  if (fmt & 1) { v.xPlacement = i16(b, p); p += 2; }
  if (fmt & 2) { v.yPlacement = i16(b, p); p += 2; }
  if (fmt & 4) { v.xAdvance = i16(b, p); p += 2; }
  if (fmt & 8) { v.yAdvance = i16(b, p); p += 2; }
  return v;
}

function readAnchor(b, o) {
  return { x: i16(b, o + 2), y: i16(b, o + 4) };
}

function readMarkArray(b, o) {
  const n = u16(b, o);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = o + 2 + i * 4;
    out.push({ cls: u16(b, r), anchor: readAnchor(b, o + u16(b, r + 2)) });
  }
  return out;
}

function parseGposSubtable(b, type, o) {
  const format = u16(b, o);
  switch (type) {
    case 1: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      const vf = u16(b, o + 4);
      if (format === 1) return { type, cov, value: readValueRecord(b, o + 6, vf) };
      const n = u16(b, o + 6);
      const values = [];
      for (let i = 0; i < n; i++) values.push(readValueRecord(b, o + 8 + i * valueRecordSize(vf), vf));
      return { type, cov, values };
    }
    case 2: {
      const cov = readCoverage(b, o + u16(b, o + 2));
      const vf1 = u16(b, o + 4), vf2 = u16(b, o + 6);
      const s1 = valueRecordSize(vf1), s2 = valueRecordSize(vf2);
      if (format === 1) {
        const n = u16(b, o + 8);
        const sets = [];
        for (let i = 0; i < n; i++) {
          const so = o + u16(b, o + 10 + i * 2);
          const pc = u16(b, so);
          const pairs = new Map();
          for (let k = 0; k < pc; k++) {
            const r = so + 2 + k * (2 + s1 + s2);
            pairs.set(u16(b, r), { v1: readValueRecord(b, r + 2, vf1), v2: readValueRecord(b, r + 2 + s1, vf2) });
          }
          sets.push(pairs);
        }
        return { type, format, cov, sets };
      }
      const cls1 = classDefAt(b, o, u16(b, o + 8));
      const cls2 = classDefAt(b, o, u16(b, o + 10));
      const c1 = u16(b, o + 12), c2 = u16(b, o + 14);
      const matrix = [];
      let p = o + 16;
      for (let i = 0; i < c1; i++) {
        const row = [];
        for (let k = 0; k < c2; k++) {
          row.push({ v1: readValueRecord(b, p, vf1), v2: readValueRecord(b, p + s1, vf2) });
          p += s1 + s2;
        }
        matrix.push(row);
      }
      return { type, format, cov, cls1, cls2, matrix };
    }
    case 4:
    case 6: {
      const markCov = readCoverage(b, o + u16(b, o + 2));
      const baseCov = readCoverage(b, o + u16(b, o + 4));
      const classCount = u16(b, o + 6);
      const marks = readMarkArray(b, o + u16(b, o + 8));
      const bao = o + u16(b, o + 10);
      const nb = u16(b, bao);
      const bases = [];
      for (let i = 0; i < nb; i++) {
        const anchors = [];
        for (let c = 0; c < classCount; c++) {
          const ao = u16(b, bao + 2 + (i * classCount + c) * 2);
          anchors.push(ao ? readAnchor(b, bao + ao) : null);
        }
        bases.push(anchors);
      }
      return { type, markCov, baseCov, marks, bases };
    }
    case 5: {
      const markCov = readCoverage(b, o + u16(b, o + 2));
      const ligCov = readCoverage(b, o + u16(b, o + 4));
      const classCount = u16(b, o + 6);
      const marks = readMarkArray(b, o + u16(b, o + 8));
      const lao = o + u16(b, o + 10);
      const nl = u16(b, lao);
      const ligs = [];
      for (let i = 0; i < nl; i++) {
        const at = lao + u16(b, lao + 2 + i * 2);
        const comps = u16(b, at);
        const compAnchors = [];
        for (let k = 0; k < comps; k++) {
          const anchors = [];
          for (let c = 0; c < classCount; c++) {
            const ao = u16(b, at + 2 + (k * classCount + c) * 2);
            anchors.push(ao ? readAnchor(b, at + ao) : null);
          }
          compAnchors.push(anchors);
        }
        ligs.push(compAnchors);
      }
      return { type, markCov, ligCov, marks, ligs };
    }
    case 7: return { type, ...parseContext(b, o) };
    case 8: return { type, ...parseChainContext(b, o) };
    default:
      return null; // cursive (3) is not used by Indic scripts
  }
}

export class GPOS extends LayoutTable {
  constructor(b) {
    super(b, parseGposSubtable, 9);
  }
}

// ---- engine ------------------------------------------------------------------------------

export class LayoutEngine {
  /**
   * @param {{ gdef: GDEF, gsub: GSUB|null, gpos: GPOS|null }} tables
   */
  constructor({ gdef, gsub, gpos }) {
    this.gdef = gdef || new GDEF(null);
    this.gsub = gsub;
    this.gpos = gpos;
  }

  glyphClass(gid) {
    return this.gdef.glyphClass(gid);
  }

  /** Whether lookup flags make glyph `g` invisible to the lookup. */
  ignored(g, lookup) {
    const flag = lookup.flag;
    const cls = this.glyphClass(g.gid);
    if (flag & 0x2 && cls === GLYPH_BASE) return true;
    if (flag & 0x4 && cls === GLYPH_LIGATURE) return true;
    if (cls === GLYPH_MARK) {
      if (flag & 0x8) return true;
      if (flag & 0x10 && lookup.markFilteringSet !== null) {
        const set = this.gdef.markSets[lookup.markFilteringSet];
        if (set && !set.has(g.gid)) return true;
      } else if (flag & 0xff00 && this.gdef.markAttachClass(g.gid) !== flag >> 8) return true;
    }
    return false;
  }

  /** Next / previous non-ignored index. */
  next(buf, i, lookup, end = buf.length) {
    for (let j = i + 1; j < end; j++) if (!this.ignored(buf[j], lookup)) return j;
    return -1;
  }

  prev(buf, i, lookup) {
    for (let j = i - 1; j >= 0; j--) if (!this.ignored(buf[j], lookup)) return j;
    return -1;
  }

  /**
   * Applies GSUB lookups to the buffer in order, honouring per-glyph masks.
   * @param {any[]} buf
   * @param {number[]} lookupIndices
   * @param {number} mask  only glyphs with (glyph.mask & mask) are affected
   * @param {{ start?: number, end?: number }} [range]
   */
  substitute(buf, lookupIndices, mask = ~0) {
    if (!this.gsub) return buf;
    for (const li of lookupIndices) {
      const lookup = this.gsub.lookups[li];
      if (!lookup) continue;
      if (lookup.subtables[0]?.type === 8) {
        // Reverse chaining: applied backwards.
        for (let i = buf.length - 1; i >= 0; i--) {
          if (!(buf[i].mask & mask) || this.ignored(buf[i], lookup)) continue;
          this.#applyGsubAt(buf, i, lookup);
        }
        continue;
      }
      let i = 0;
      while (i < buf.length) {
        if (buf[i].mask & mask && !this.ignored(buf[i], lookup)) {
          const r = this.#applyGsubAt(buf, i, lookup);
          if (r) {
            i = r.next;
            continue;
          }
        }
        i++;
      }
    }
    return buf;
  }

  /** Tries each subtable at position i. Returns { next } on success. */
  #applyGsubAt(buf, i, lookup, depth = 0) {
    const g = buf[i];
    for (const st of lookup.subtables) {
      switch (st.type) {
        case 1: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          g.gid = st.delta !== undefined ? (g.gid + st.delta) & 0xffff : st.subs[ci];
          g.substituted = true;
          return { next: i + 1 };
        }
        case 2: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          const seq = st.seqs[ci];
          if (!seq.length) {
            buf.splice(i, 1);
            return { next: i };
          }
          const repl = seq.map((gid, k) => ({ ...g, gid, multiIndex: k, text: k === 0 ? g.text : '' }));
          buf.splice(i, 1, ...repl);
          return { next: i + repl.length };
        }
        case 3: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          g.gid = st.seqs[ci][0];
          return { next: i + 1 };
        }
        case 4: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          for (const { lig, comps } of st.sets[ci]) {
            const positions = [i];
            let j = i;
            let ok = true;
            for (const c of comps) {
              j = this.next(buf, j, lookup);
              if (j < 0 || buf[j].gid !== c) { ok = false; break; }
              positions.push(j);
            }
            if (!ok) continue;
            // Form the ligature at i; drop the components, keep skipped marks.
            const ligId = (this.ligCounter = (this.ligCounter || 0) + 1);
            const first = buf[i];
            first.gid = lig;
            first.ligId = ligId;
            first.ligComps = positions.length;
            first.substituted = true;
            first.cluster = Math.min(...positions.map((p) => buf[p].cluster));
            // Text the ligature stands for (used for ToUnicode maps).
            if (first.text !== undefined) first.text = positions.map((p) => buf[p].text ?? '').join('');
            // Marks between components get attached to the right component.
            let comp = 0;
            for (let p = i + 1; p <= positions[positions.length - 1]; p++) {
              if (positions.includes(p)) comp++;
              else { buf[p].ligId = ligId; buf[p].ligComp = comp; }
            }
            for (let k = positions.length - 1; k >= 1; k--) buf.splice(positions[k], 1);
            return { next: i + 1 };
          }
          continue;
        }
        case 5:
        case 6: {
          const m = this.#matchContext(buf, i, st, lookup);
          if (!m) continue;
          // Nested lookups may grow or shrink the buffer: resume after the matched input.
          const before = buf.length;
          if (depth < 8) this.#applyNested(buf, m.positions, m.lookups, depth, 'gsub');
          return { next: Math.max(i + 1, m.end + (buf.length - before)) };
        }
        case 8: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          let j = i, ok = true;
          for (const cov of st.backtrack) { j = this.prev(buf, j, lookup); if (j < 0 || !cov.has(buf[j].gid)) { ok = false; break; } }
          if (!ok) continue;
          j = i;
          for (const cov of st.lookahead) { j = this.next(buf, j, lookup); if (j < 0 || !cov.has(buf[j].gid)) { ok = false; break; } }
          if (!ok) continue;
          g.gid = st.subs[ci];
          return { next: i + 1 };
        }
        default:
          continue;
      }
    }
    return null;
  }

  /**
   * Matches a (chain) context subtable at i. Returns the matched input
   * positions and nested lookup records.
   */
  #matchContext(buf, i, st, lookup) {
    const g = buf[i];
    const matchSeq = (start, items, test, dir) => {
      const pos = [];
      let j = start;
      for (const it of items) {
        j = dir > 0 ? this.next(buf, j, lookup) : this.prev(buf, j, lookup);
        if (j < 0 || !test(buf[j].gid, it)) return null;
        pos.push(j);
      }
      return pos;
    };
    const tryRule = (rule, inTest, bTest, lTest) => {
      const input = matchSeq(i, rule.input, inTest, 1);
      if (!input) return null;
      if (rule.backtrack && !matchSeq(i, rule.backtrack, bTest, -1)) return null;
      const last = input.length ? input[input.length - 1] : i;
      if (rule.lookahead && !matchSeq(last, rule.lookahead, lTest, 1)) return null;
      return { positions: [i, ...input], lookups: rule.lookups, end: last + 1 };
    };

    if (st.format === 3) {
      const covs = st.kind === 'chain' ? st.input : st.covs;
      if (!covs[0].has(g.gid)) return null;
      return tryRule(
        { input: covs.slice(1), backtrack: st.backtrack, lookahead: st.lookahead, lookups: st.lookups },
        (gid, cov) => cov.has(gid), (gid, cov) => cov.has(gid), (gid, cov) => cov.has(gid),
      );
    }
    const ci = st.cov.get(g.gid);
    if (ci === undefined) return null;
    if (st.format === 1) {
      const rules = st.ruleSets[ci] || [];
      const eq = (gid, x) => gid === x;
      for (const rule of rules) {
        const m = tryRule(rule, eq, eq, eq);
        if (m) return m;
      }
      return null;
    }
    // format 2: class based
    const icls = st.kind === 'chain' ? st.icls : st.cls;
    const rules = st.ruleSets[icls(g.gid)] || [];
    for (const rule of rules) {
      const m = tryRule(
        rule,
        (gid, c) => icls(gid) === c,
        (gid, c) => st.bcls(gid) === c,
        (gid, c) => st.lcls(gid) === c,
      );
      if (m) return m;
    }
    return null;
  }

  #applyNested(buf, positions, records, depth, kind) {
    // Positions may shift as nested lookups change the buffer length; track by object.
    const objs = positions.map((p) => buf[p]);
    for (const { seq, lookup: li } of records) {
      const target = objs[seq];
      if (!target) continue;
      const idx = buf.indexOf(target);
      if (idx < 0) continue;
      const table = kind === 'gsub' ? this.gsub : this.gpos;
      const lookup = table.lookups[li];
      if (!lookup) continue;
      const before = buf.length;
      if (kind === 'gsub') this.#applyGsubAt(buf, idx, lookup, depth + 1);
      else this.#applyGposAt(buf, idx, lookup, depth + 1);
      // A multiple substitution grows the buffer; later records refer to new glyphs.
      if (buf.length !== before && kind === 'gsub') {
        const now = buf.indexOf(target) >= 0 ? buf.indexOf(target) : idx;
        const added = buf.length - before;
        const extra = buf.slice(now + 1, now + 1 + Math.max(0, added));
        objs.splice(seq + 1, 0, ...extra);
      }
    }
  }

  // ---- positioning ---------------------------------------------------------------------

  /** Applies GPOS lookups. Buffer entries need xAdvance etc. initialised. */
  position(buf, lookupIndices, mask = ~0) {
    if (!this.gpos) return buf;
    for (const li of lookupIndices) {
      const lookup = this.gpos.lookups[li];
      if (!lookup) continue;
      for (let i = 0; i < buf.length; i++) {
        if (!(buf[i].mask & mask) || this.ignored(buf[i], lookup)) continue;
        this.#applyGposAt(buf, i, lookup, 0);
      }
    }
    return buf;
  }

  #applyGposAt(buf, i, lookup, depth) {
    const g = buf[i];
    const add = (target, v) => {
      target.xOffset += v.xPlacement;
      target.yOffset += v.yPlacement;
      target.xAdvance += v.xAdvance;
      target.yAdvance += v.yAdvance;
    };
    for (const st of lookup.subtables) {
      switch (st.type) {
        case 1: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          add(g, st.value || st.values[ci]);
          return true;
        }
        case 2: {
          const ci = st.cov.get(g.gid);
          if (ci === undefined) continue;
          const j = this.next(buf, i, lookup);
          if (j < 0) continue;
          let pair;
          if (st.format === 1) pair = st.sets[ci].get(buf[j].gid);
          else {
            const row = st.matrix[st.cls1(g.gid)];
            pair = row && row[st.cls2(buf[j].gid)];
          }
          if (!pair) continue;
          add(g, pair.v1);
          add(buf[j], pair.v2);
          return true;
        }
        case 4:
        case 6: {
          const mi = st.markCov.get(g.gid);
          if (mi === undefined) continue;
          // Find the base: previous glyph that is not a mark (type 4) / previous mark (type 6).
          let j = i - 1;
          if (st.type === 4) {
            while (j >= 0 && this.glyphClass(buf[j].gid) === GLYPH_MARK) j--;
          } else {
            while (j >= 0 && this.ignored(buf[j], lookup)) j--;
          }
          if (j < 0) continue;
          const bi = st.baseCov.get(buf[j].gid);
          if (bi === undefined) continue;
          const mark = st.marks[mi];
          const anchor = st.bases[bi][mark.cls];
          if (!anchor) continue;
          this.#attach(buf, i, j, anchor, mark.anchor);
          return true;
        }
        case 5: {
          const mi = st.markCov.get(g.gid);
          if (mi === undefined) continue;
          let j = i - 1;
          while (j >= 0 && this.glyphClass(buf[j].gid) === GLYPH_MARK) j--;
          if (j < 0) continue;
          const li2 = st.ligCov.get(buf[j].gid);
          if (li2 === undefined) continue;
          const comps = st.ligs[li2];
          const compIndex = g.ligId && g.ligId === buf[j].ligId && g.ligComp !== undefined
            ? Math.min(g.ligComp, comps.length - 1) : comps.length - 1;
          const mark = st.marks[mi];
          const anchor = comps[compIndex][mark.cls];
          if (!anchor) continue;
          this.#attach(buf, i, j, anchor, mark.anchor);
          return true;
        }
        case 7:
        case 8: {
          const m = this.#matchContext(buf, i, st, lookup);
          if (!m) continue;
          if (depth < 8) this.#applyNested(buf, m.positions, m.lookups, depth, 'gpos');
          return true;
        }
        default:
          continue;
      }
    }
    return false;
  }

  /** Places mark i so its anchor coincides with the base j anchor. */
  #attach(buf, i, j, baseAnchor, markAnchor) {
    const mark = buf[i];
    // Pen distance from base origin to mark origin (advances between them).
    let dx = 0;
    for (let k = j; k < i; k++) dx += buf[k].xAdvance;
    const base = buf[j];
    mark.xOffset = base.xOffset + baseAnchor.x - markAnchor.x - dx;
    mark.yOffset = base.yOffset + baseAnchor.y - markAnchor.y;
    mark.attachTo = j;
  }
}
