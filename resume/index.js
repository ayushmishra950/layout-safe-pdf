// Resume generator: JSON data -> PDF in the reference resume format.
// Pure Node (built-ins only). Fresher and experienced layouts, automatic page breaks.

import fs from 'node:fs';
import { loadFaces } from './font.js';
import { writePdf } from './pdf.js';

// ---- page geometry & style (measured from the reference resume) ------------------------
const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 45.1;
const RIGHT = PAGE_W - 45.1;
const DATE_RIGHT = 511.5; // right edge of right-aligned dates in the reference
const BULLET_X = 50.1;
const TEXT_X = 63.1;
const TOP = 737.95; // baseline of the first line on every page
const BOTTOM = 52; // lowest allowed baseline

// auto spacing: stretch only when the content fills less than this share of the page, up to the target
const STRETCH_BELOW = 0.8;
const FILL_TARGET = 0.88;

const BLUE = '0.1216 0.3059 0.4745';
const DARK = '0.1333 0.1333 0.1333';
const GREY = '0.3333 0.3333 0.3333';
const BLACK = '0 0 0';

const SEP = '   |   ';

// ---- text helpers -------------------------------------------------------------------------
const str = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

class Builder {
  constructor(faces, t = 0) {
    this.faces = faces;
    this.t = t; // 0 = reference spacing, 1 = most open
    this.boost = Math.round(t * 1.0 * 4) / 4; // extra pt on every font size
    this.gap = { sec: 1 + 0.8 * t, item: 1 + 0.45 * t, mid: 1 + 0.3 * t };
    this.lines = [];
    this.warnings = [];
  }

  sz(size) {
    return size + this.boost;
  }

  run(text, font, size, color, url) {
    return { text: this.faces[font].clean(text), font, size: this.sz(size), color, url };
  }

  /** Vertical distance after scaling: 'tight' follows the font size, the others also open up with t. */
  dyOf(dy, kind) {
    const r = this.sz(10) / 10;
    return dy * r * (kind === 'tight' ? 1 : this.gap[kind]);
  }

  width(runs) {
    return runs.reduce((w, r) => w + this.faces[r.font].width(r.text, r.size), 0);
  }

  /** Greedy word wrap of plain text. */
  wrap(text, font, rawSize, maxW) {
    const size = this.sz(rawSize);
    const face = this.faces[font];
    const t = face.clean(str(text));
    if (!t) return [];
    const out = [];
    let cur = '';
    for (const word of t.split(' ')) {
      const trial = cur ? `${cur} ${word}` : word;
      if (face.width(trial, size) <= maxW) { cur = trial; continue; }
      if (cur) out.push(cur);
      cur = word;
      while (face.width(cur, size) > maxW) { // single over-long word: hard split
        let i = cur.length;
        while (i > 1 && face.width(cur.slice(0, i), size) > maxW) i--;
        out.push(cur.slice(0, i));
        cur = cur.slice(i);
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  push(dy, segs, keep = false, kind = 'mid') {
    this.lines.push({ dy: this.dyOf(dy, kind), segs, keep });
    return this.lines[this.lines.length - 1];
  }

  /** Keep rule for wrapped paragraphs: no orphan first line, no widow last line. */
  static keepFor(i, n) {
    if (n <= 3) return i < n - 1;
    return i === 0 || i === n - 2;
  }

  paragraph(text, dyFirst, dyNext, size, color, font = 'regular') {
    const ls = this.wrap(text, font, size, RIGHT - LEFT);
    ls.forEach((t, i) => this.push(i ? dyNext : dyFirst, [{ x: LEFT, runs: [this.run(t, font, size, color)] }], Builder.keepFor(i, ls.length), i ? 'tight' : 'mid'));
    return ls.length;
  }

  heading(title, dyBefore) {
    this.push(dyBefore, [{ x: LEFT, runs: [this.run(title, 'bold', 11, BLUE)] }], true, 'sec');
  }

  bullet(text, dyFirst, kind = 'mid') {
    const t = str(text);
    if (!t) return 0;
    const ls = this.wrap(t, 'regular', 10, RIGHT - TEXT_X);
    ls.forEach((l, i) => {
      const segs = [{ x: TEXT_X, runs: [this.run(l, 'regular', 10, DARK)] }];
      if (i === 0) segs.unshift({ x: BULLET_X, runs: [this.run('•', 'regular', 10, BLACK)] });
      this.push(i ? 12.2 : dyFirst, segs, Builder.keepFor(i, ls.length), i ? 'tight' : kind);
    });
    return ls.length;
  }

  /** "left … right" line, the right part right-aligned to the margin. */
  splitLine(dy, leftRuns, rightRuns, keep, kind = 'mid') {
    const gap = 12;
    if (rightRuns.length && this.width(leftRuns) + this.width(rightRuns) + gap > DATE_RIGHT - LEFT) {
      this.push(dy, [{ x: LEFT, runs: leftRuns }], true, kind);
      this.push(12.5, [{ x: LEFT, runs: rightRuns }], keep, 'tight');
      return;
    }
    const segs = [{ x: LEFT, runs: leftRuns }];
    if (rightRuns.length) segs.push({ right: DATE_RIGHT, runs: rightRuns });
    this.push(dy, segs, keep, kind);
  }

  entryHeader(left, right, location, firstDy, kind, hasBody) {
    const hasLoc = !!location;
    this.splitLine(firstDy, left, right, hasLoc || hasBody, kind);
    if (hasLoc) this.push(12.5, [{ x: LEFT, runs: [this.run(location, 'italic', 9.5, GREY)] }], hasBody, 'tight');
    return hasLoc;
  }
}

// ---- data -> lines --------------------------------------------------------------------------
const TITLES = {
  summary: 'PROFILE SUMMARY',
  experience: 'WORK EXPERIENCE',
  internship: 'INTERNSHIP EXPERIENCE',
  projects: 'KEY PROJECTS',
  skills: 'TECHNICAL SKILLS',
  education: 'EDUCATION',
  certifications: 'CERTIFICATIONS',
  achievements: 'ACHIEVEMENTS',
};

const ORDER = {
  experienced: ['summary', 'experience', 'projects', 'skills', 'education', 'certifications', 'achievements', 'custom'],
  fresher: ['summary', 'education', 'skills', 'experience', 'projects', 'certifications', 'achievements', 'custom'],
};

function normalizeExperience(data) {
  return list(data.experience)
    .map((e) => ({
      role: str(e.role ?? e.title ?? e.position),
      company: str(e.company ?? e.organization),
      location: str(e.location),
      dates: str(e.dates) || [str(e.start), str(e.end) || (e.start ? 'Present' : '')].filter(Boolean).join(' – '),
      duration: str(e.duration),
      internship: !!e.internship,
      bullets: list(e.bullets ?? e.points ?? e.description).map(str).filter(Boolean),
    }))
    .filter((e) => e.role || e.company);
}

function normalizeProjects(data) {
  return list(data.projects)
    .map((p) => (typeof p === 'string' ? { name: '', description: str(p) } : p))
    .map((p) => ({ name: str(p.name ?? p.title), description: str(p.description), tech: str(Array.isArray(p.tech) ? p.tech.join(', ') : p.tech), link: str(p.link ?? p.url) }))
    .filter((p) => p.name || p.description);
}

function normalizeSkills(data) {
  const s = data.skills;
  if (!s) return [];
  const rows = Array.isArray(s) ? s : Object.entries(s).map(([label, items]) => ({ label, items }));
  return rows
    .map((r) => (typeof r === 'string' ? { label: '', items: r } : r))
    .map((r) => ({ label: str(r.label ?? r.name ?? r.category), items: Array.isArray(r.items) ? r.items.map(str).filter(Boolean).join(', ') : str(r.items) }))
    .filter((r) => r.items);
}

function normalizeEducation(data) {
  return list(data.education)
    .map((e) => ({
      degree: str(e.degree ?? e.course),
      institution: str(e.institution ?? e.school ?? e.college ?? e.university),
      status: str(e.status ?? e.year ?? e.dates),
      grade: str(e.grade ?? e.cgpa ?? e.percentage),
      details: list(e.details ?? e.bullets).map(str).filter(Boolean),
    }))
    .filter((e) => e.degree || e.institution);
}

/**
 * @param {object} data resume data (see resume/README.md)
 * @returns {{lines: object[], warnings: string[], layout: string}}
 */
export function layoutResume(data, faces, t = 0) {
  const name = str(data.name);
  if (!name) throw new Error('resume data needs a "name"');
  const b = new Builder(faces, t);
  const titles = { ...TITLES, ...(data.titles || {}) };

  const experience = normalizeExperience(data);
  const projects = normalizeProjects(data);
  const skills = normalizeSkills(data);
  const education = normalizeEducation(data);
  const summary = str(data.summary);
  const certifications = list(data.certifications).map(str).filter(Boolean);
  const achievements = list(data.achievements).map(str).filter(Boolean);
  const custom = list(data.sections).filter((s) => s && str(s.title) && list(s.bullets).length);

  const hasRealJob = experience.some((e) => !e.internship);
  const layout = data.layout && ORDER[data.layout] ? data.layout : hasRealJob ? 'experienced' : 'fresher';
  const order = Array.isArray(data.order) ? data.order : ORDER[layout];

  // ---- header ----
  const c = data.contact || {};
  const items = [];
  const add = (text, url) => { if (str(text)) items.push({ text: str(text), url }); };
  add(c.phone);
  add(c.email, c.email && `mailto:${str(c.email)}`);
  add(c.location);
  for (const k of ['linkedin', 'github', 'portfolio', 'website']) if (str(c[k])) add(shortUrl(str(c[k])), withScheme(str(c[k])));
  for (const x of list(c.other)) add(typeof x === 'string' ? x : x.text, x.url);

  b.push(0, [{ center: true, runs: [b.run(name.toUpperCase(), 'bold', 20, BLUE)] }], true);
  const title = str(data.title ?? data.headline);
  let lastDy = 19;
  if (title) b.push(18.8, [{ center: true, runs: [b.run(title, 'bold', 12, DARK)] }], true), (lastDy = 17.25);
  // contact items -> centered lines
  const maxW = RIGHT - LEFT;
  let row = [];
  const rows = [];
  const rowWidth = (r) => r.reduce((w, it, i) => w + faces.regular.width(faces.regular.clean(it.text), b.sz(9.5)) + (i ? faces.regular.width(SEP, b.sz(9.5)) : 0), 0);
  for (const it of items) {
    if (row.length && rowWidth([...row, it]) > maxW) { rows.push(row); row = []; }
    row.push(it);
  }
  if (row.length) rows.push(row);
  rows.forEach((r, i) => {
    const runs = [];
    r.forEach((it, j) => {
      if (j) runs.push(b.run(SEP, 'regular', 9.5, GREY));
      runs.push(b.run(it.text, 'regular', 9.5, GREY, it.url));
    });
    b.push(i ? 12.5 : lastDy, [{ center: true, runs }], true, i ? 'tight' : 'mid');
  });
  let firstSection = true;
  const sectionGap = () => { const g = firstSection ? 22.05 : 22.15; firstSection = false; return g; };

  // ---- sections ----
  const sections = {
    summary() {
      if (!summary) return;
      b.heading(titles.summary, sectionGap());
      b.paragraph(summary, 20, 12.8, 10.5, DARK);
    },
    experience() {
      if (!experience.length) return;
      const allIntern = experience.every((e) => e.internship);
      b.heading(allIntern ? titles.internship : titles.experience, sectionGap());
      experience.forEach((e, i) => {
        const left = [b.run(e.role, 'bold', 11, DARK)];
        if (e.company) left.push(b.run(`${e.role ? '  |  ' : ''}${e.company}`, 'bold', 11, BLUE));
        const dates = [e.dates, e.duration && `(${e.duration})`].filter(Boolean).join(' ');
        const right = dates ? [b.run(dates, 'italic', 10, GREY)] : [];
        const hasBody = e.bullets.length > 0;
        const hasLoc = b.entryHeader(left, right, e.location, i ? 18.65 : 22, i ? 'item' : 'mid', hasBody);
        e.bullets.forEach((t, k) => b.bullet(t, k ? 14.2 : hasLoc ? 16.1 : 13, k ? 'item' : 'mid'));
      });
    },
    projects() {
      if (!projects.length) return;
      b.heading(titles.projects, sectionGap());
      projects.forEach((p, i) => {
        let t = p.name && p.description ? `${p.name} — ${p.description}` : p.name || p.description;
        if (p.tech) t += ` (${p.tech})`;
        if (p.link) t += ` — ${shortUrl(p.link)}`;
        b.bullet(t, i ? 14.2 : 19.5, i ? 'item' : 'mid');
      });
    },
    skills() {
      if (!skills.length) return;
      b.heading(titles.skills, sectionGap());
      skills.forEach((s, i) => b.bullet(s.label ? `${s.label}: ${s.items}` : s.items, i ? 14.2 : 19.5, i ? 'item' : 'mid'));
    },
    education() {
      if (!education.length) return;
      b.heading(titles.education, sectionGap());
      education.forEach((e, i) => {
        const inst = [e.institution, e.grade].filter(Boolean).join('  |  ');
        const hasBody = !!inst || e.details.length > 0;
        const right = e.status ? [b.run(e.status, 'italic', 10, GREY)] : [];
        b.splitLine(i ? 18.65 : 21, [b.run(e.degree || e.institution, 'bold', 10.5, DARK)], right, hasBody, i ? 'item' : 'mid');
        if (e.degree && inst) b.push(12.85, [{ x: LEFT, runs: [b.run(inst, 'italic', 9.5, GREY)] }], e.details.length > 0, 'tight');
        e.details.forEach((t, k) => b.bullet(t, k ? 14.2 : 16.1, k ? 'item' : 'mid'));
      });
    },
    certifications() {
      if (!certifications.length) return;
      b.heading(titles.certifications, sectionGap());
      certifications.forEach((t, i) => b.bullet(t, i ? 14.2 : 19.5, i ? 'item' : 'mid'));
    },
    achievements() {
      if (!achievements.length) return;
      b.heading(titles.achievements, sectionGap());
      achievements.forEach((t, i) => b.bullet(t, i ? 14.2 : 19.5, i ? 'item' : 'mid'));
    },
    custom() {
      for (const s of custom) {
        b.heading(str(s.title).toUpperCase(), sectionGap());
        list(s.bullets).forEach((t, i) => b.bullet(t, i ? 14.2 : 19.5, i ? 'item' : 'mid'));
      }
    },
  };
  for (const key of order) if (sections[key]) sections[key]();
  if (b.lines.length) b.lines[b.lines.length - 1].keep = false;
  if (b.lines.length === 1) b.warnings.push('resume has only a name; add summary/skills/education etc.');

  for (const [k, f] of Object.entries(faces)) {
    if (f.missing.size) b.warnings.push(`characters not in the font were replaced by "?": ${[...f.missing].join(' ')} (${k})`);
  }
  const height = b.lines.reduce((h, l, i) => h + (i ? l.dy : 0), 0);
  return { lines: b.lines, warnings: b.warnings, layout, builder: b, height };
}

// ---- pagination ------------------------------------------------------------------------------
export function paginate(lines) {
  const pages = [];
  let cur = [];
  let y = TOP;
  const place = (arr) => { let yy = TOP; arr.forEach((l, i) => { if (i) yy -= l.dy; }); return yy; };
  for (const line of lines) {
    const ny = cur.length ? y - line.dy : TOP;
    if (cur.length && ny < BOTTOM) {
      let k = cur.length;
      while (k > 0 && cur[k - 1].keep) k--;
      if (k === 0) k = cur.length; // block taller than a page: split anyway
      const carry = cur.splice(k);
      pages.push(cur);
      cur = carry;
      y = place(cur);
      y = cur.length ? y - line.dy : TOP;
    } else y = ny;
    cur.push(line);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

// ---- rendering -------------------------------------------------------------------------------
const FONT_RES = { regular: 'F1', bold: 'F2', italic: 'F3' };
const f2 = (n) => (Math.round(n * 100) / 100).toString();

function render(pageLines, b) {
  const faces = b.faces;
  let ops = '';
  const links = [];
  let y = TOP;
  pageLines.forEach((line, i) => {
    if (i) y -= line.dy;
    for (const seg of line.segs) {
      const w = b.width(seg.runs);
      let x = seg.x;
      if (seg.center) x = (PAGE_W - w) / 2;
      if (seg.right !== undefined) x = seg.right - w;
      for (const r of seg.runs) {
        const rw = faces[r.font].width(r.text, r.size);
        if (r.text) ops += `BT /${FONT_RES[r.font]} ${f2(r.size)} Tf ${r.color} rg ${f2(x)} ${f2(y)} Td <${faces[r.font].encode(r.text)}> Tj ET\n`;
        if (r.url) links.push({ rect: [x, y - 2.5, x + rw, y + r.size * 0.85], url: r.url });
        x += rw;
      }
    }
  });
  return { ops, links };
}

/**
 * Builds the resume PDF.
 * @param {object} data resume data
 * @param {{output?: string}} [opts]
 * @returns {{pdf: Buffer, pages: number, layout: string, warnings: string[], spacing: {mode: string, stretch: number, fill: number}}}
 */
export function buildResume(data, opts = {}) {
  const faces = loadFaces();
  const usable = TOP - BOTTOM;
  const mode = data.spacing === 'normal' ? 'normal' : 'auto';
  let t = 0;
  let res = layoutResume(data, faces, 0);
  // Sparse content: open the spacing (and fonts a little) so a single page looks filled, never past the target.
  if (mode === 'auto' && paginate(res.lines).length === 1 && res.height / usable < STRETCH_BELOW) {
    for (let k = 1; k <= 20; k++) {
      const trial = layoutResume(data, faces, k / 20);
      if (paginate(trial.lines).length !== 1 || trial.height / usable > FILL_TARGET) break;
      t = k / 20;
      res = trial;
    }
  }
  const paged = paginate(res.lines);
  const pages = paged.map((p) => render(p, res.builder));
  const pdf = writePdf({
    pages,
    faces,
    width: PAGE_W,
    height: PAGE_H,
    info: { title: `${str(data.name)} - Resume`, author: str(data.name), subject: str(data.title ?? data.headline) },
  });
  if (opts.output) fs.writeFileSync(opts.output, pdf);
  return { pdf, pages: pages.length, layout: res.layout, warnings: res.warnings, spacing: { mode, stretch: t, fill: Math.round((res.height / usable) * 100) / 100 } };
}
