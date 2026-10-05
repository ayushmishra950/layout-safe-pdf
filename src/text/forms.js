// Text replacement in AcroForm text fields (values typed into fillable forms).
//
// The field value (/V) is updated and the widget appearance is regenerated
// from the field's default appearance (/DA) when the text can be drawn with
// its font; otherwise the appearance is dropped and /NeedAppearances asks the
// viewer to draw it.

import { PDFDict, PDFName, PDFRef, PDFStream, PDFString, num } from '../core/objects.js';
import { serialize } from '../core/writer.js';
import { loadFont } from '../fonts/font.js';

/** All terminal fields with their full names and inherited attributes. */
function collectFields(doc) {
  const form = doc.resolve(doc.catalog?.get('AcroForm'));
  if (!(form instanceof PDFDict)) return { form: null, fields: [] };
  const fields = [];
  const seen = new Set();
  const walk = (list, prefix, inherited) => {
    const items = doc.resolve(list);
    for (const ref of Array.isArray(items) ? items : []) {
      if (ref instanceof PDFRef) {
        if (seen.has(ref.num)) continue;
        seen.add(ref.num);
      }
      const f = doc.resolve(ref);
      if (!(f instanceof PDFDict)) continue;
      const t = doc.resolve(f.get('T'));
      const name = t instanceof PDFString ? prefix + t.toText() : prefix.replace(/\.$/, '');
      const inh = {
        FT: f.get('FT') ?? inherited.FT,
        DA: f.get('DA') ?? inherited.DA,
        Ff: f.get('Ff') ?? inherited.Ff,
        Q: f.get('Q') ?? inherited.Q,
        MaxLen: f.get('MaxLen') ?? inherited.MaxLen,
      };
      const kids = doc.resolve(f.get('Kids'));
      const childFields = Array.isArray(kids) ? kids.filter((k) => doc.resolve(doc.resolve(k)?.get?.('T')) !== undefined) : [];
      if (childFields.length) walk(childFields, name + '.', inh);
      else fields.push({ ref, dict: f, name, ...inh, widgets: Array.isArray(kids) && kids.length ? kids : [ref] });
    }
  };
  walk(form.get('Fields'), '', { FT: null, DA: form.get('DA'), Ff: null, Q: form.get('Q') });
  return { form, fields };
}

/** Parses "/Helv 12 Tf 0 g" -> { font: 'Helv', size: 12 }. */
function parseDA(da) {
  const m = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da || '');
  return m ? { font: m[1], size: Number(m[2]) } : null;
}

/** Can `text` be written with a simple (WinAnsi) font? */
const isWinAnsiText = (text) => /^[\x20-\x7e -ÿ€‘’“”–—•…]*$/.test(text);


const FF_READONLY = 1;
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_RADIO = 1 << 15;
const FF_PUSHBUTTON = 1 << 16;
const FF_COMBO = 1 << 17;
const FF_EDIT = 1 << 18;

function markForm(doc, form) {
  const formRef = doc.catalog.get('AcroForm');
  if (formRef instanceof PDFRef) doc.update(formRef, form);
  else doc.update(doc.trailer.get('Root'), doc.catalog);
}

/**
 * Rebuilds the normal appearance of a text/combo field's widgets for \`value\`.
 * Returns false when the viewer has to draw it instead (NeedAppearances).
 */
function refreshTextAppearance(doc, form, f, value) {
  const da = parseDA(doc.resolve(f.DA)?.toText?.() ?? '');
  const dr = doc.resolve(form.get('DR'));
  const fontRef = da && dr instanceof PDFDict ? doc.resolve(dr.get('Font'))?.get?.(da.font) : null;
  const fontDict = doc.resolve(fontRef);
  const simpleFont = fontDict instanceof PDFDict && doc.resolve(fontDict.get('Subtype'))?.name !== 'Type0';
  const ff = num(doc.resolve(f.Ff));
  let drawn = true;
  for (const wRef of f.widgets) {
    const w = doc.resolve(wRef);
    if (!(w instanceof PDFDict)) continue;
    if (da && simpleFont && isWinAnsiText(value) && !(ff & FF_MULTILINE) && !(ff & FF_PASSWORD)) {
      const rawRect = doc.resolve(w.get('Rect'));
      const rect = Array.isArray(rawRect) && rawRect.length >= 4 ? rawRect.map((x) => num(doc.resolve(x))) : [0, 0, 100, 20];
      const wd = Math.abs(rect[2] - rect[0]);
      const ht = Math.abs(rect[3] - rect[1]);
      const size = da.size || Math.min(12, ht * 0.7);
      const daText = doc.resolve(f.DA).toText().replace(/([\d.]+)\s+Tf/, `${size} Tf`);
      const q = num(doc.resolve(f.Q));
      let textW = value.length * size * 0.5;
      try {
        const font = loadFont(doc, fontRef);
        if (font) textW = [...Buffer.from(value, 'latin1')].reduce((s, c) => s + font.widthOf(c) * size, 0);
      } catch { /* keep the estimate */ }
      const x = q === 1 ? (wd - textW) / 2 : q === 2 ? wd - 2 - textW : 2;
      const y = (ht - size) / 2 + size * 0.22;
      const content = `/Tx BMC q 1 1 ${wd - 2} ${ht - 2} re W n BT ${daText} ${x.toFixed(2)} ${y.toFixed(2)} Td ${serialize(new PDFString(Buffer.from(value, 'latin1')))} Tj ET Q EMC`;
      const ap = new PDFStream(new PDFDict().set('Type', PDFName.of('XObject')).set('Subtype', PDFName.of('Form'))
        .set('BBox', [0, 0, wd, ht]).set('Resources', dr), Buffer.alloc(0));
      doc.setStreamData(ap, Buffer.from(content, 'latin1'));
      w.set('AP', new PDFDict().set('N', doc.register(ap)));
    } else {
      // Let the viewer draw the value.
      w.delete('AP');
      drawn = false;
    }
    if (wRef instanceof PDFRef) doc.update(wRef, w);
  }
  return drawn;
}

const NEED_APPEARANCES_NOTE = 'Some form fields will be drawn by the PDF viewer (NeedAppearances), because their font cannot show the new text.';

/**
 * Replaces text inside text-field values.
 * @param {import('../core/document.js').PDFDocument} doc
 * @param {(value:string) => {text:string, count:number}} transform
 * @returns {{ changed: Array<{ field: string, from: string, to: string }>, warnings: string[] }}
 */
export function replaceInFormFields(doc, transform) {
  const { form, fields } = collectFields(doc);
  const changed = [];
  const warnings = [];
  if (!form) return { changed, warnings };
  let needAppearances = false;

  for (const f of fields) {
    if (doc.resolve(f.FT)?.name !== 'Tx') continue;
    const v = doc.resolve(f.dict.get('V'));
    if (!(v instanceof PDFString)) continue;
    const before = v.toText();
    const { text: after, count } = transform(before);
    if (!count || after === before) continue;

    f.dict.set('V', PDFString.fromText(after));
    if (f.ref instanceof PDFRef) doc.update(f.ref, f.dict);
    changed.push({ field: f.name, from: before, to: after });
    if (!refreshTextAppearance(doc, form, f, after)) needAppearances = true;
  }
  if (needAppearances) {
    form.set('NeedAppearances', true);
    markForm(doc, form);
    warnings.push(NEED_APPEARANCES_NOTE);
  }
  return { changed, warnings };
}

// ---- reading and filling forms by field name ---------------------------------------------

/** On-state appearance names of a button widget (everything except /Off). */
function onStates(doc, widget) {
  const ap = doc.resolve(doc.resolve(widget)?.get?.('AP'));
  const n = doc.resolve(ap?.get?.('N'));
  return n instanceof PDFDict ? [...n.keys()].filter((k) => k !== 'Off') : [];
}

function fieldType(doc, f) {
  const ft = doc.resolve(f.FT)?.name;
  const ff = num(doc.resolve(f.Ff));
  if (ft === 'Tx') return 'text';
  if (ft === 'Ch') return ff & FF_COMBO ? 'dropdown' : 'list';
  if (ft === 'Sig') return 'signature';
  if (ft === 'Btn') return ff & FF_PUSHBUTTON ? 'button' : ff & FF_RADIO ? 'radio' : 'checkbox';
  return 'unknown';
}

function choiceOptions(doc, f) {
  const opt = doc.resolve(f.dict.get('Opt'));
  if (!Array.isArray(opt)) return [];
  return opt.map((o) => {
    const v = doc.resolve(o);
    if (Array.isArray(v)) return { value: doc.resolve(v[0])?.toText?.() ?? '', label: doc.resolve(v[1])?.toText?.() ?? '' };
    const t = v?.toText?.() ?? '';
    return { value: t, label: t };
  });
}

function pageOf(doc, widget) {
  const p = doc.resolve(widget)?.get?.('P');
  if (!(p instanceof PDFRef)) return null;
  const i = doc.getPages().findIndex((pg) => pg.ref && pg.ref.num === p.num);
  return i < 0 ? null : i;
}

/**
 * Lists the fillable fields of a document.
 * @returns {Array<{ name:string, type:string, value:any, options?:Array<{value:string,label:string}>,
 *   readOnly:boolean, multiline?:boolean, maxLength?:number, page:number|null }>}
 */
export function getFormFields(doc) {
  const { fields } = collectFields(doc);
  return fields.map((f) => {
    const type = fieldType(doc, f);
    const ff = num(doc.resolve(f.Ff));
    const v = doc.resolve(f.dict.get('V'));
    let value = null;
    if (v instanceof PDFString) value = v.toText();
    else if (v instanceof PDFName) value = type === 'checkbox' ? v.name !== 'Off' : v.name === 'Off' ? null : v.name;
    else if (Array.isArray(v)) value = v.map((x) => doc.resolve(x)?.toText?.() ?? '');
    if (type === 'checkbox' && value === null) value = false;
    const out = { name: f.name, type, value, readOnly: !!(ff & FF_READONLY), page: pageOf(doc, f.widgets[0]) };
    if (type === 'text') {
      out.multiline = !!(ff & FF_MULTILINE);
      const ml = num(doc.resolve(f.MaxLen), 0);
      if (ml) out.maxLength = ml;
    }
    if (type === 'dropdown' || type === 'list') out.options = choiceOptions(doc, f);
    if (type === 'radio') out.options = f.widgets.flatMap((w) => onStates(doc, w)).map((s) => ({ value: s, label: s }));
    if (type === 'checkbox') out.onValue = onStates(doc, f.widgets[0])[0] || 'Yes';
    return out;
  });
}

/**
 * Sets field values by full field name.
 *   text: string · checkbox: true/false (or its on-value) · radio: option value ·
 *   dropdown/list: option value (dropdowns that allow typing accept any text)
 * @param {Record<string, any>} values
 * @param {{ allowReadOnly?: boolean }} [options]
 * @returns {{ set: string[], notFound: string[], errors: Array<{ field:string, reason:string }>, warnings: string[] }}
 */
export function setFormFields(doc, values, options = {}) {
  const { form, fields } = collectFields(doc);
  const result = { set: [], notFound: [], errors: [], warnings: [] };
  if (!form) {
    result.notFound.push(...Object.keys(values));
    return result;
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  let needAppearances = false;

  for (const [name, raw] of Object.entries(values)) {
    const f = byName.get(name);
    if (!f) { result.notFound.push(name); continue; }
    const fail = (reason) => result.errors.push({ field: name, reason });
    const type = fieldType(doc, f);
    const ff = num(doc.resolve(f.Ff));
    if (ff & FF_READONLY && !options.allowReadOnly) { fail('field is read-only'); continue; }

    if (type === 'text' || type === 'dropdown' || type === 'list') {
      const value = raw === null || raw === undefined ? '' : String(raw);
      if (type === 'text') {
        const ml = num(doc.resolve(f.MaxLen), 0);
        if (ml && [...value].length > ml) { fail(`value is longer than the field allows (${ml} characters)`); continue; }
      } else {
        const opts = choiceOptions(doc, f);
        const ok = opts.some((o) => o.value === value) || (type === 'dropdown' && ff & FF_EDIT);
        if (!ok) { fail(`"${value}" is not one of the options: ${opts.map((o) => o.value).join(', ')}`); continue; }
      }
      f.dict.set('V', PDFString.fromText(value));
      if (f.ref instanceof PDFRef) doc.update(f.ref, f.dict);
      if (type === 'list') {
        for (const wRef of f.widgets) { const w = doc.resolve(wRef); w?.delete?.('AP'); if (wRef instanceof PDFRef) doc.update(wRef, w); }
        needAppearances = true;
      } else if (!refreshTextAppearance(doc, form, f, value)) needAppearances = true;
      result.set.push(name);
    } else if (type === 'checkbox') {
      const on = onStates(doc, f.widgets[0])[0] || 'Yes';
      const checked = raw === true || raw === on || raw === 'Yes' || raw === 'On' || raw === 1 || raw === 'true';
      const state = PDFName.of(checked ? on : 'Off');
      f.dict.set('V', state);
      if (f.ref instanceof PDFRef) doc.update(f.ref, f.dict);
      for (const wRef of f.widgets) {
        const w = doc.resolve(wRef);
        if (!(w instanceof PDFDict)) continue;
        w.set('AS', PDFName.of(checked && onStates(doc, w).includes(on) ? on : 'Off'));
        if (wRef instanceof PDFRef) doc.update(wRef, w);
      }
      result.set.push(name);
    } else if (type === 'radio') {
      const value = raw === null || raw === undefined || raw === false ? 'Off' : String(raw);
      const all = f.widgets.flatMap((w) => onStates(doc, w));
      if (value !== 'Off' && !all.includes(value)) { fail(`"${value}" is not one of the options: ${all.join(', ')}`); continue; }
      f.dict.set('V', PDFName.of(value));
      if (f.ref instanceof PDFRef) doc.update(f.ref, f.dict);
      for (const wRef of f.widgets) {
        const w = doc.resolve(wRef);
        if (!(w instanceof PDFDict)) continue;
        w.set('AS', PDFName.of(onStates(doc, w).includes(value) ? value : 'Off'));
        if (wRef instanceof PDFRef) doc.update(wRef, w);
      }
      result.set.push(name);
    } else {
      fail(`${type} fields cannot be filled`);
    }
  }
  if (needAppearances) {
    form.set('NeedAppearances', true);
    markForm(doc, form);
    result.warnings.push(NEED_APPEARANCES_NOTE);
  }
  return result;
}
