// Type definitions for layout-safe-pdf.

/// <reference types="node" />

export interface LoadOptions {
  /** User or owner password for encrypted documents. */
  password?: string;
}

export interface SaveOptions {
  /** Append changes to the original bytes (default true). */
  incremental?: boolean;
  /** Flate-compress uncompressed streams on a full rewrite. */
  compress?: boolean;
}

export type Permission =
  | 'print' | 'modify' | 'copy' | 'annotate' | 'fillForms'
  | 'extractForAccessibility' | 'assemble' | 'printHighQuality';

export interface EncryptOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: Partial<Record<Permission, boolean>>;
}

export class PDFPage {
  readonly index: number;
  readonly mediaBox: [number, number, number, number];
  readonly cropBox: [number, number, number, number];
  readonly rotate: number;
  readonly width: number;
  readonly height: number;
  getContentBytes(): Buffer;
  setContentBytes(bytes: Buffer): void;
}

export class PDFDocument {
  constructor(buffer: Buffer, options?: LoadOptions);
  static load(input: string | Buffer | Uint8Array, options?: LoadOptions): Promise<PDFDocument>;
  readonly version: string;
  readonly pageCount: number;
  readonly isEncrypted: boolean;
  readonly isSigned: boolean;
  readonly signatures: Array<{ name: string; signer: string | null }>;
  /** Non-fatal problems found while reading (e.g. a repaired cross-reference table). */
  readonly warnings: string[];
  readonly repaired: boolean;
  getPages(): PDFPage[];
  getPage(index: number): PDFPage;
  encrypt(options?: EncryptOptions): void;
  removeEncryption(): void;
  save(options?: SaveOptions): Buffer;
  saveAs(path: string, options?: SaveOptions): Promise<Buffer>;
}

export interface EditorOptions {
  /** Map PDF font names to font files, e.g. { ArialMT: './arial.ttf' }. */
  fonts?: Record<string, string>;
  /** Fonts for complex scripts, e.g. { deva: './NotoSansDevanagari.ttf' }. */
  scriptFonts?: { deva?: string };
  /** Extra directories to search for fonts. */
  fontDirs?: string[];
  /** Search the operating system's font folders (default true). */
  useSystemFonts?: boolean;
  /** Font file used when nothing matches. */
  fallbackFont?: string;
  /** Use the most similar installed font when the PDF's font is not installed (default true). */
  substituteFonts?: boolean;
  /** Embed a font when the PDF's subset font lacks a character (default true). */
  embedMissingGlyphs?: boolean;
}

export interface ReplaceOptions {
  search: string | RegExp;
  /** Replacement text; "$&" inserts the matched text. */
  replace: string | ((match: string) => string);
  /** 0-based page indexes (default: all pages). */
  pages?: number[];
  /** reflow (default): the rest of the line/paragraph adapts; preserve: nothing else moves; fit: condense into the old width. */
  mode?: 'reflow' | 'preserve' | 'fit';
  align?: 'auto' | 'left' | 'right' | 'center';
  /** Re-wrap paragraphs when the new text does not fit (default true). */
  wrap?: boolean;
  caseSensitive?: boolean;
  /** Maximum number of successful replacements. */
  maxCount?: number;
  /** Smallest horizontal condensing allowed (default 0.5). */
  minScale?: number;
  /** Also replace text in fillable form-field values (default true; ignored when `pages` is set). */
  formFields?: boolean;
}

export interface ReplaceReport {
  replaced: number;
  skipped: Array<{ page: number; text: string; reason: string }>;
  warnings: string[];
  details: Array<{
    page: number;
    from: string;
    to: string;
    align: string;
    scale: number;
    font: string;
    embeddedFont: boolean;
    rewrapped?: boolean;
    lines?: number;
    /** Set for form-field replacements (page is -1). */
    field?: string;
  }>;
}

export interface FoundText {
  page: number;
  text: string;
  bbox: [number, number, number, number];
  fontName: string;
  fontSize: number;
}

export class TextEditor {
  constructor(doc: PDFDocument, options?: EditorOptions);
  find(search: string | RegExp, options?: { pages?: number[]; caseSensitive?: boolean }): FoundText[];
  replace(options: ReplaceOptions): ReplaceReport;
  /**
   * Select & replace: replaces only the occurrence of `search` inside `bbox`
   * on `page` (0-based), e.g. the text a user selected in a viewer.
   * bbox is [x0, y0, x1, y1] in PDF points, origin bottom-left.
   */
  replaceAt(options: Omit<ReplaceOptions, 'pages' | 'maxCount' | 'formFields'> & { page: number; bbox: [number, number, number, number] }): ReplaceReport;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontName: string;
  bbox: [number, number, number, number];
}

export function extractText(doc: PDFDocument, pageIndex?: number): string;
export function extractLines(doc: PDFDocument, pageIndex: number): TextLine[];

export interface Limits {
  maxStreamSize: number;
  maxNestingDepth: number;
  maxGlyphsPerPage: number;
  maxObjectsPerStream: number;
}
export const limits: Limits;
export function setLimits(overrides: Partial<Limits>): void;

export class PDFLimitError extends Error {}
export class PDFPasswordError extends Error {}
export class PDFSyntaxError extends Error {}
export class UnsupportedFilterError extends Error {}

// Low-level building blocks (advanced use).
export class PDFName { readonly name: string; static of(name: string): PDFName; }
export class PDFRef { readonly num: number; readonly gen: number; }
export class PDFDict { get(key: string): unknown; set(key: string, value: unknown): this; has(key: string): boolean; }
export class PDFStream { dict: PDFDict; data: Buffer; }
export class PDFString { bytes: Buffer; static fromText(text: string): PDFString; toText(): string; }
export class PDFNumber { readonly value: number; }
export function N(name: string): PDFName;
export class ContentInterpreter { constructor(doc: PDFDocument); runPage(page: PDFPage): unknown[]; }
export function parseOperations(bytes: Buffer): Array<{ op: string; operands: unknown[] }>;
export function rebuildContent(source: Buffer, ops: unknown[], replacements: Map<number, unknown[]>): Buffer;
export class PDFFont {}
export function loadFont(doc: PDFDocument, ref: unknown): PDFFont | null;

// ---- one-call API ---------------------------------------------------------------------

export interface Edit {
  search: string;
  replace: string;
  /** Treat `search` as a regular expression. */
  regex?: boolean;
  /** Select & replace: 1-based page of the selection (use with bbox). */
  page?: number;
  /** Select & replace: selected area [x0, y0, x1, y1] in PDF points (origin bottom-left). */
  bbox?: [number, number, number, number];
  ignoreCase?: boolean;
  /** 1-based page numbers (default: all pages). */
  pages?: number[];
  mode?: 'reflow' | 'preserve' | 'fit';
  align?: 'auto' | 'left' | 'right' | 'center';
  wrap?: boolean;
  maxCount?: number;
}

export interface EditReport {
  /** true when every edit replaced something and nothing was skipped. */
  ok: boolean;
  replaced: number;
  edits: Array<{ search: string; replace: string; replaced: number; skipped: Array<{ page: number; reason: string }>; warnings: string[]; notFound?: boolean }>;
  warnings: string[];
  pageCount: number;
  text?: string;
  /** Present when `fields` was passed to editPdf. */
  fields?: SetFieldsResult;
}

export function editPdf(
  input: string | Buffer | Uint8Array,
  edits: Edit[],
  options?: {
    password?: string;
    output?: string;
    incremental?: boolean;
    includeText?: boolean;
    editor?: EditorOptions;
    /** Fill form fields by full name, e.g. { name: 'Priyank', agree: true }. */
    fields?: Record<string, FieldValue>;
    /** Allow setting read-only fields. */
    allowReadOnly?: boolean;
  },
): Promise<{ pdf: Buffer; report: EditReport }>;

export function diagnose(options?: { scriptFonts?: { deva?: string } }): {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }>;
  limits: Limits;
};

// ---- form fields ------------------------------------------------------------------------

export type FieldValue = string | boolean | number | null;

export interface FormField {
  /** Full (dotted) field name. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'signature' | 'unknown';
  value: string | boolean | string[] | null;
  readOnly: boolean;
  /** 0-based page of the field's first widget. */
  page: number | null;
  multiline?: boolean;
  maxLength?: number;
  /** Choices for radio / dropdown / list fields. */
  options?: Array<{ value: string; label: string }>;
  /** Checkbox on-state name. */
  onValue?: string;
}

export interface SetFieldsResult {
  set: string[];
  notFound: string[];
  errors: Array<{ field: string; reason: string }>;
  warnings: string[];
}

export function getFormFields(doc: PDFDocument): FormField[];
export function setFormFields(doc: PDFDocument, values: Record<string, FieldValue>, options?: { allowReadOnly?: boolean }): SetFieldsResult;
