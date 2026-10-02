# libr-pdf

A PDF parsing and **layout-preserving text editing** engine written in pure Node.js. It has **zero dependencies**: it uses only the built-in `fs`, `zlib`, `crypto` and `Buffer`.

```js
import { PDFDocument, TextEditor, extractText } from './src/index.js';

const doc = await PDFDocument.load('invoice.pdf');           // { password } for encrypted files
const editor = new TextEditor(doc);

editor.replace({ search: 'Rahul Sharma', replace: 'Priyank Dadhich' });
editor.replace({ search: '25,000', replace: '1,25,000' });   // auto right-aligned in its table cell
editor.replace({ search: /INV-\d{4}/, replace: 'INV-2026' });

editor.replace({ search: 'राम कुमार शर्मा', replace: 'प्रियंक दाधीच' }); // Devanagari is shaped (OpenType)

await doc.saveAs('invoice-edited.pdf');                       // incremental update by default
console.log(extractText(doc, 0));

doc.encrypt({ userPassword: 'open', ownerPassword: 'owner', permissions: { copy: false } }); // AES-256
```

## Quickest integration: `editPdf`

```js
import { editPdf } from 'libr-pdf';

const { pdf, report } = await editPdf('input.pdf', [          // path or Buffer
  { search: 'Full Stack Developer', replace: 'Python Developer', pages: [1] },
  { search: 'Rahul Sharma', replace: 'Priyank Dadhich' },
], { output: 'output.pdf' });                                  // optional: also write to disk

if (!report.ok) console.log(report.edits);                    // notFound / skipped reasons per edit
```

**HTTP API, callable from any language or frontend.** Start it with `node examples/server.js`, then send `POST /edit` with the JSON body `{ "pdf": "<base64>", "edits": [...], "password"?: "..." }`.
- The response is `{ pdf: "<base64>", report }`.
- `POST /edit?download=1` returns the PDF file itself, with the report in the `X-Edit-Report` header.

## CLI

```bash
node bin/libr-pdf.js info file.pdf
node bin/libr-pdf.js text file.pdf --page 1 --positions
node bin/libr-pdf.js find file.pdf "Rahul"
node bin/libr-pdf.js replace in.pdf out.pdf --search "Rahul Sharma" --replace "Priyank Dadhich"
node bin/libr-pdf.js replace in.pdf out.pdf --spec edits.json
node bin/libr-pdf.js encrypt in.pdf out.pdf --user-password open --no-copy
node bin/libr-pdf.js decrypt in.pdf out.pdf --password open
```

Demos: `node examples/demo.js` (invoice) and `node examples/demo-advanced.js` (Hindi, paragraph re-wrap, AES-256).

## How edits keep the layout intact

1. **Exact glyph positions.** The content interpreter tracks the full graphics and text state (`cm`, `q/Q`, `Tm`, `Td`, `TD`, `T*`, `Tc`, `Tw`, `Tz`, `TL`, `Ts`, `'`, `"`, `TJ` kerning, Form XObjects). For every glyph it records its operation and its exact page position.
2. **Surgical rewrite.** Only the text operations that contain affected glyphs are re-emitted. Every other byte of the content stream is copied unchanged, including graphics, images, inline images and marked content.
3. **Exact repositioning.** `TJ` displacements put every glyph that is not part of the match at exactly the planned position. This is checked in tests to 1/1000 pt.
4. **Layout decisions** (`mode: 'reflow'`, the default):
   - The rest of the line moves with the new width.
   - The free space is limited by table borders (detected from painted lines and rectangles), the next column, and the page text area. If the new text does not fit, it is condensed horizontally (`Tz`). The `minScale` option sets the limit (default 50%).
   - Justified lines: the change is absorbed by the word gaps, so both edges stay flush.
   - `align: 'auto'` detects right-aligned and centred table cells and columns. For example, amounts grow to the left.
   - Several matches on one line share the line's free space.
   - The other modes: `preserve` (nothing else moves) and `fit` (always squeeze the new text into the old width).
5. **Missing glyphs.** Embedded fonts are usually subsets. If the new text needs a character the subset lacks, the engine finds the same font on the system (or uses `fonts` / `fallbackFont`). It subsets that font to just the needed glyphs and embeds it as a Type0/Identity-H font with a `ToUnicode` map, so the result stays searchable and copyable.
6. **Paragraph re-wrap.** When an edit does not fit on its line, the engine detects the paragraph. It checks consistent leading and a shared left edge, and requires that each line ended because the next word did not fit. It then lays the paragraph out again with greedy line breaking: justified paragraphs are re-justified, and bold/coloured words, rise and render mode are kept. It first tries a barely visible condensing (down to 93%). It only adds lines where the page below is empty, and only while the spacing to the next block stays intact. Pass `wrap: false` to disable this.
7. **Complex scripts (Devanagari).** The engine has its own OpenType layout engine (GDEF, GSUB types 1–8, GPOS types 1, 2, 4–9) and an Indic shaper. The shaper finds syllables, reph, base consonants, half and below forms, reorders pre-base matras, and applies the presentation and mark-positioning features. On a test set of words, its output matched Apple CoreText glyph-for-glyph. Shaped runs are written with `ActualText`, so search and copy/paste return the logical text. Hindi produced by Chrome/Skia (Type3 fonts with ActualText) is extracted correctly. Nameless fonts are identified by **metric matching** (glyph widths compared with candidate system fonts).
8. **Incremental save.** By default, changes are appended to the end of the file and the original bytes stay unchanged. `save({ incremental: false })` writes a clean full rewrite instead.

## Options worth knowing

`new TextEditor(doc, options)`:
- `fonts: { ArialMT: '/path/arial.ttf' }` maps PDF font names to font files.
- `scriptFonts: { deva: '/path/NotoSansDevanagari.ttf' }` sets the font used for Devanagari text.
- `fallbackFont`: the font file to use when nothing matches.
- `substituteFonts` (default `true`): when the PDF's font is not installed, use the most similar installed font. Similarity is judged by serif/sans/mono, bold, italic and glyph widths, and a warning is reported.
- `embedMissingGlyphs` (default `true`).

`editor.replace({ search, replace, ... })`:
- `mode`: `'reflow' | 'preserve' | 'fit'`
- `align`: `'auto' | 'left' | 'right' | 'center'`
- `wrap` (default `true`)
- `pages`, `maxCount` (counts successful replacements), `caseSensitive`, `minScale`

Every call returns `{ replaced, skipped: [{page, text, reason}], warnings, details }`. Nothing is skipped silently.

## Verification

- 64 automated tests (`npm test`). They include regression tests for every bug found in the code audit, and for hostile input.
- Mutation fuzzing: thousands of corrupted files, with no crash, hang or programming error.
- Performance on a 500-page document: extract all text in 0.45 s, 26,400 replacements in about 4.4 s, peak memory about 220 MB.
- A real-world sweep over 1,570 PDFs found on macOS. 1,565 load, extract, edit and save correctly. The other 5 are gzip files, not PDFs, and are rejected with a clear error.
- A stress sweep made longer replacements in 266 text PDFs. All 266 edits succeeded, and every output opened in Apple PDFKit.
- 60 AES-256 files made with random passwords all opened in Apple PDFKit.
- Devanagari shaping matched Apple CoreText glyph-for-glyph.

## Using it in production

**Security limits.** These protect the process from hostile files such as decompression bombs, extreme nesting and pages with millions of glyphs. When a limit is exceeded, a `PDFLimitError` is thrown. Raise the limits only for trusted input:

```js
import { setLimits, limits } from 'libr-pdf';
setLimits({ maxStreamSize: 512 * 1024 * 1024 }); // defaults: 256 MB stream, nesting 512, 2M glyphs/page, 1M objects/object stream
```

**Errors.** Errors are `PDFPasswordError` (wrong or missing password), `PDFLimitError`, `PDFSyntaxError`, or a plain `Error` such as "Not a PDF file". Damaged files are repaired automatically, and `doc.warnings` says what was fixed. Every `replace()` returns `skipped` with reasons and `warnings`, so you can show them to users.

**Servers.** The work is synchronous and CPU-bound, roughly 1 ms per page for extraction and 10 ms per page for editing. For a busy API, run it in a `worker_threads` pool, such as Piscina, so the event loop stays free. Keep the default limits for files that users upload.

**Fonts on servers.** Run `node bin/libr-pdf.js doctor` on the server first. New characters and Devanagari need fonts. On Linux, install fonts (for example `fonts-noto-core`, `fonts-liberation`) or pass `fonts`, `fontDirs` or `scriptFonts`.

**Signed PDFs.** `doc.isSigned` and `doc.signatures` show whether a document is signed. Editing a signed document invalidates the signature, and `replace()` warns about it.

**TypeScript.** Types ship in `src/index.d.ts`.

**Quality gates.** `npm test` runs the unit, integration and regression tests. `npm run fuzz -- 1000` runs mutation fuzzing. `.github/workflows/test.yml` runs both on Linux, macOS and Windows with Node 18, 20 and 22.

## Feature status

| Area | Status |
|---|---|
| Lexer/parser, all object types, indirect objects | ✅ |
| Classic xref tables, xref streams, object streams, hybrid files, `Prev` chains | ✅ |
| Damaged files: wrong offsets, missing `startxref`, bad `/Length`, missing objects | ✅ repaired |
| Filters: Flate (including truncated streams), LZW, ASCII85, ASCIIHex, RunLength, PNG/TIFF predictors | ✅ (image codecs are passed through) |
| Encryption: RC4 40/128, AES-128, AES-256 (R5/R6). Edits are re-encrypted on save | ✅ |
| Creating AES-256 encryption with permissions, and removing encryption | ✅ (verified with Apple PDFKit) |
| Incremental and full save, garbage collection on full save | ✅ |
| Fonts: Type1, TrueType, Type3, Type0/CID, Standard-14 metrics, encodings and `Differences`, ToUnicode and embedded CMaps | ✅ |
| Text extraction with positions, reading order | ✅ |
| Find and replace (string or regex), spanning operations and kerning, inside Form XObjects | ✅ |
| TrueType parser and subsetter (glyf, composites, .ttc collections), font embedding | ✅ |
| CFF/OpenType (.otf, .ttc) fonts: subset into a CID-keyed CFF (CIDFontType0C) | ✅ |
| Paragraph re-wrapping, re-justification, extra lines only into free space | ✅ |
| ActualText (extraction and writing) | ✅ |
| Devanagari (Hindi, Marathi, …) shaping and editing | ✅ (needs a Devanagari OpenType font: Kohinoor, Noto Sans Devanagari, Mangal, Nirmala UI…) |
| Hindi PDFs without ActualText (e.g. MS Word): visual-to-logical repair of ि and reph | ✅ |
| Legacy Kruti Dev / DevLys 010 fonts: read as Unicode, edits written in the original font | ✅ (other legacy layouts such as Chanakya are not supported) |
| Fillable form fields (text field values and appearances) | ✅ |
| Environment check: `libr-pdf doctor` / `diagnose()` | ✅ |
| Other Indic scripts (Bengali, Gujarati, Tamil…) | ❌ shaper is Devanagari-only for now |
| Pulling words up into the previous line when text gets shorter | ❌ (shorter text leaves the line ragged) |
| Vertical writing, Type3 font substitution | ❌ |
| Scanned PDFs (text only as images) | ❌ needs OCR |

## Project layout

```
src/core/      objects, lexer, parser, xref, filters, crypt, document, page, writer
src/content/   content-stream operations, interpreter, matrices
src/fonts/     encodings, CMaps, font model, Standard-14 metrics, TrueType parser/subsetter, CFF subsetter,
               OpenType layout engine (opentype.js), Devanagari shaper (shaper.js), embedder, resolver
src/text/      layout (lines/words), extraction, editor, paragraph re-wrap
bin/           CLI
test/          node:test suites, synthetic PDF builder, real-world fixtures
```

## Tests

```bash
npm test
```

The fixtures were generated locally with Chrome (Skia), macOS Quartz and PDFKit (encrypted), plus Apple's Xcode license PDF. The dev-only macOS tools in `test/tools/` are not part of the library: `pdfkit-check.js`, `render.js` (PDFKit) and `coretext-shape.swift` (the CoreText reference shaper).
