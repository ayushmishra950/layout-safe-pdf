// A page in the page tree with inherited attributes resolved.

import { PDFDict, PDFRef, PDFStream, num, N } from './objects.js';

export class PDFPage {
  /**
   * @param {import('./document.js').PDFDocument} doc
   * @param {PDFDict} dict
   * @param {PDFRef|null} ref
   * @param {Record<string, any>} inherited
   * @param {number} index
   */
  constructor(doc, dict, ref, inherited, index) {
    this.doc = doc;
    this.dict = dict;
    this.ref = ref;
    this.inherited = inherited;
    this.index = index;
  }

  #box(key) {
    const v = this.doc.resolve(this.dict.get(key) ?? this.inherited[key]);
    if (!Array.isArray(v) || v.length < 4) return null;
    const [a, b, c, d] = v.map((x) => num(this.doc.resolve(x)));
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }

  get mediaBox() {
    return this.#box('MediaBox') || [0, 0, 612, 792];
  }

  get cropBox() {
    return this.#box('CropBox') || this.mediaBox;
  }

  get rotate() {
    return num(this.doc.resolve(this.dict.get('Rotate') ?? this.inherited.Rotate), 0);
  }

  get width() {
    const [x0, , x1] = this.cropBox;
    return x1 - x0;
  }

  get height() {
    const [, y0, , y1] = this.cropBox;
    return y1 - y0;
  }

  /** Resolved resources dictionary (possibly inherited). */
  get resources() {
    const r = this.doc.resolve(this.dict.get('Resources') ?? this.inherited.Resources);
    return r instanceof PDFDict ? r : new PDFDict();
  }

  /** The content streams of the page, in order. */
  getContentStreams() {
    const contents = this.dict.get('Contents');
    const list = [];
    const refs = Array.isArray(this.doc.resolve(contents)) ? this.doc.resolve(contents) : [contents];
    for (const r of refs) {
      const s = this.doc.resolve(r);
      if (s instanceof PDFStream) list.push({ ref: r instanceof PDFRef ? r : null, stream: s });
    }
    return list;
  }

  /**
   * Decoded page content: all content streams joined. Streams are separated by
   * a newline because the spec treats them as one stream split at token
   * boundaries.
   */
  getContentBytes() {
    const parts = [];
    for (const { stream } of this.getContentStreams()) {
      parts.push(this.doc.decodeStream(stream));
      parts.push(Buffer.from('\n'));
    }
    return Buffer.concat(parts);
  }

  /** Replaces the page content with a single new (compressed) stream. */
  setContentBytes(bytes) {
    const stream = new PDFStream(new PDFDict(), Buffer.alloc(0));
    this.doc.setStreamData(stream, bytes);
    const ref = this.doc.register(stream);
    this.dict.set('Contents', ref);
    this.#markDirty();
    return ref;
  }

  /**
   * Makes sure the page has its own /Resources dict (not inherited from the
   * tree or shared with other pages) so it can be modified safely.
   */
  ownResources() {
    const raw = this.dict.get('Resources') ?? this.inherited.Resources;
    const resolved = this.doc.resolve(raw);
    const copy = resolved instanceof PDFDict ? cloneShallow(resolved) : new PDFDict();
    this.dict.set('Resources', copy);
    this.#markDirty();
    return copy;
  }

  #markDirty() {
    if (this.ref) this.doc.update(this.ref, this.dict);
  }

  markDirty() {
    this.#markDirty();
  }
}

/** Clones a dict one level deep, also cloning direct sub-dicts (Font, XObject...). */
function cloneShallow(dict) {
  const out = new PDFDict();
  for (const [k, v] of dict.entries()) out.set(k, v instanceof PDFDict ? v.clone() : v);
  return out;
}

export { N };
