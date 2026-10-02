// Safety limits that protect a process from hostile or broken files
// (decompression bombs, absurd nesting, pages with millions of glyphs).
// They can be raised for trusted input with setLimits().

export class PDFLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PDFLimitError';
  }
}

export const limits = {
  /** Largest decoded size of a single stream, in bytes. */
  maxStreamSize: 256 * 1024 * 1024,
  /** Deepest nesting of arrays/dictionaries. */
  maxNestingDepth: 512,
  /** Most glyphs interpreted on one page. */
  maxGlyphsPerPage: 2_000_000,
  /** Most objects declared in one object stream. */
  maxObjectsPerStream: 1_000_000,
};

/** Overrides limits, e.g. setLimits({ maxStreamSize: 1024 ** 3 }). */
export function setLimits(overrides) {
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in limits)) throw new Error(`Unknown limit: ${k}`);
    limits[k] = v;
  }
}
