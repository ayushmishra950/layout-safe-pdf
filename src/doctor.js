// Environment check: which fonts can the editor use on this machine?

import { defaultResolver } from './fonts/resolver.js';
import { EmbeddedFont } from './fonts/embedder.js';
import { PDFDocument } from './core/document.js';
import { limits } from './core/limits.js';

const LATIN = [
  ['Sans (Arial/Helvetica)', ['ArialMT', 'Helvetica', 'LiberationSans', 'DejaVuSans', 'NotoSans-Regular']],
  ['Serif (Times)', ['TimesNewRomanPSMT', 'Times-Roman', 'LiberationSerif', 'DejaVuSerif', 'NotoSerif-Regular']],
  ['Monospace (Courier)', ['CourierNewPSMT', 'Courier', 'LiberationMono', 'DejaVuSansMono']],
];

/**
 * Reports what the editor can do with the fonts available here.
 * @param {{ fonts?: Record<string,string>, fontDirs?: string[], scriptFonts?: {deva?: string} }} [options]
 */
export function diagnose(options = {}) {
  const resolver = defaultResolver();
  const entries = resolver.entries;
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix: ok ? undefined : fix });

  const [major] = process.versions.node.split('.').map(Number);
  add('Node.js version', major >= 18, process.versions.node, 'Install Node.js 18 or newer.');
  add('System fonts found', entries.length > 0, `${entries.length} fonts`, 'Install fonts (Linux: apt install fonts-noto-core fonts-liberation).');

  for (const [label, names] of LATIN) {
    const hit = names.map((n) => entries.find((e) => e.ps === n)).find(Boolean);
    add(`Latin font: ${label}`, !!hit, hit ? `${hit.ps} (${hit.file})` : 'none',
      'Install fonts-liberation (Linux) or pass { fonts: { ArialMT: "/path/arial.ttf" } }.');
  }

  // Devanagari: must shape (OpenType layout) to edit Hindi text.
  let deva = null;
  const doc = new PDFDocument(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n'));
  const candidates = options.scriptFonts?.deva ? [{ file: options.scriptFonts.deva, index: 0, ps: options.scriptFonts.deva }] : resolver.resolveScript('deva');
  for (const c of candidates) {
    try {
      const f = new EmbeddedFont(doc, c.file, c.index ?? 0, { register: false });
      if (f.canShapeDevanagari) { deva = `${f.baseFont} (${c.file})`; break; }
    } catch { /* try next */ }
  }
  add('Hindi (Devanagari) font with shaping', !!deva, deva || 'none',
    'Install Noto Sans Devanagari (Linux: apt install fonts-noto-core) or pass { scriptFonts: { deva: "/path/NotoSansDevanagari-Regular.ttf" } }.');

  return {
    ok: checks.every((c) => c.ok),
    checks,
    limits: { ...limits },
  };
}
