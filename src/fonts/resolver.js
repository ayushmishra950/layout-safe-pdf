// Locates font files (system or user-supplied) that match a PDF font name.
// Only file headers and the `name` table are read while indexing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SYSTEM_DIRS = {
  darwin: ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')],
  win32: [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Windows\\Fonts')],
  linux: ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts')],
};

const FONT_EXT = /\.(ttf|otf|ttc)$/i;

/** Canonical key: lowercase alphanumerics without MT/PS vendor suffixes. */
export function normalizeFontName(name) {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/(PSMT|MT|PS)(?=$|[-,])/g, '')
    .replace(/[-,_\s]/g, '')
    .toLowerCase()
    .replace(/regular$|roman$|normal$|book$/, '')
    .replace(/oblique/g, 'italic');
}

function readSync(fd, pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

/** Reads PostScript + full names of every font in a file without loading it fully. */
function readFontNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readSync(fd, 0, 12);
    const offsets = [];
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const n = head.readUInt32BE(8);
      const tbl = readSync(fd, 12, 4 * n);
      for (let i = 0; i < n; i++) offsets.push(tbl.readUInt32BE(i * 4));
    } else offsets.push(0);
    return offsets.map((base, index) => {
      const dir = readSync(fd, base, 12);
      const numTables = dir.readUInt16BE(4);
      const recs = readSync(fd, base + 12, numTables * 16);
      let nameOff = -1, nameLen = 0;
      for (let i = 0; i < numTables; i++) {
        if (recs.toString('latin1', i * 16, i * 16 + 4) === 'name') {
          nameOff = recs.readUInt32BE(i * 16 + 8);
          nameLen = recs.readUInt32BE(i * 16 + 12);
        }
      }
      const names = {};
      let namesRank;
      if (nameOff >= 0) {
        const n = readSync(fd, nameOff, nameLen);
        const count = n.readUInt16BE(2);
        const strOff = n.readUInt16BE(4);
        for (let i = 0; i < count; i++) {
          const r = 6 + i * 12;
          const platform = n.readUInt16BE(r);
          const id = n.readUInt16BE(r + 6);
          if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
          const raw = n.subarray(strOff + n.readUInt16BE(r + 10), strOff + n.readUInt16BE(r + 10) + n.readUInt16BE(r + 8));
          let s = '';
          if (platform === 3 || platform === 0) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
          else s = raw.toString('latin1');
          // Prefer English: Windows en-US (0x409), then Mac English (0), then anything.
      const lang = n.readUInt16BE(r + 4);
      const rank = platform === 3 && lang === 0x409 ? 3 : platform === 1 && lang === 0 ? 2 : platform === 3 ? 1 : 0;
      namesRank ??= {};
      if (!names[id] || rank > (namesRank[id] ?? -1)) {
        names[id] = s;
        namesRank[id] = rank;
      }
        }
      }
      return { file, index, ps: names[6] || '', full: names[4] || '', family: names[16] || names[1] || '', style: names[17] || names[2] || '' };
    });
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(p, out, depth + 1);
    else if (FONT_EXT.test(e.name)) out.push(p);
  }
}

export class FontResolver {
  /**
   * @param {{ fontDirs?: string[], fonts?: Record<string,string>, useSystemFonts?: boolean }} [options]
   *   fonts: explicit mapping from PDF font name (e.g. "ArialMT") to a font file.
   */
  constructor(options = {}) {
    this.options = options;
    this.explicit = new Map(Object.entries(options.fonts || {}).map(([k, v]) => [normalizeFontName(k), v]));
    this.index = null;
  }

  /** All indexed fonts. */
  get entries() {
    return this.#buildIndex();
  }

  #buildIndex() {
    if (this.index) return this.index;
    const dirs = [...(this.options.fontDirs || [])];
    if (this.options.useSystemFonts !== false) dirs.push(...(SYSTEM_DIRS[process.platform] || SYSTEM_DIRS.linux));
    const files = [];
    for (const d of dirs) walk(d, files);
    const index = [];
    for (const f of files) {
      try {
        index.push(...readFontNames(f));
      } catch { /* unreadable font */ }
    }
    this.index = index;
    return index;
  }

  /**
   * Finds a font file for a PDF BaseFont name.
   * @returns {{ file: string, index: number, ps: string } | null}
   */
  resolve(baseFont) {
    const key = normalizeFontName(baseFont);
    if (this.explicit.has(key)) return { file: this.explicit.get(key), index: 0, ps: baseFont };
    const index = this.#buildIndex();
    const clean = baseFont.replace(/^[A-Z]{6}\+/, '');
    const exact = index.find((f) => f.ps === clean);
    if (exact) return exact;
    const byKey = index.find((f) => normalizeFontName(f.ps) === key || normalizeFontName(f.full) === key);
    if (byKey) return byKey;
    const byFamilyStyle = index.find((f) => normalizeFontName(f.family + f.style) === key);
    return byFamilyStyle || null;
  }
}

/** Preferred system fonts per script (family names), best first. */
const SCRIPT_FAMILIES = {
  deva: ['Noto Sans Devanagari', 'Mangal', 'Nirmala UI', 'Kohinoor Devanagari', 'Lohit Devanagari',
    'Devanagari Sangam MN', 'ITF Devanagari', 'Adobe Devanagari', 'Noto Serif Devanagari', 'Shree Devanagari 714'],
};

const COMMON_LATIN = ['Arial', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Times', 'Georgia', 'Verdana',
  'Calibri', 'Cambria', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Roboto', 'Open Sans', 'Noto Sans', 'Segoe UI'];

/** Candidate fonts for metric matching: script fonts plus common Latin families. */
FontResolver.prototype.candidates = function candidates() {
  const index = this.entries;
  const fams = new Set([...Object.values(SCRIPT_FAMILIES).flat(), ...COMMON_LATIN]);
  return index.filter((f) => fams.has(f.family));
};

FontResolver.prototype.resolveScript = function resolveScript(script, { bold = false } = {}) {
  const index = this.entries;
  const out = [];
  for (const fam of SCRIPT_FAMILIES[script] || []) {
    const members = index.filter((f) => f.family === fam || f.family.startsWith(fam + ' '));
    if (!members.length) continue;
    const isBold = (f) => /bold|black|heavy/i.test(f.style + ' ' + f.ps);
    const regular = (f) => /^(regular|book|normal|roman)$/i.test(f.style) || /-(Regular|Book)$/.test(f.ps);
    members.sort((a, b) => {
      const score = (f) => (bold ? (isBold(f) ? 0 : 2) : regular(f) ? 0 : isBold(f) ? 2 : 1) + (/Marathi|Nepali/.test(f.ps) ? 3 : 0);
      return score(a) - score(b);
    });
    out.push(...members);
  }
  return out;
};

let shared = null;
/** Process-wide resolver for system fonts (index is built once). */
export function defaultResolver() {
  if (!shared) shared = new FontResolver();
  return shared;
}
