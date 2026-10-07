# layout-safe-pdf

Edit the text of an existing PDF **without breaking its layout**. Pure Node.js, **zero dependencies**: it uses only the built-in `fs`, `zlib`, `crypto` and `Buffer`.

```js
import { editPdf } from 'layout-safe-pdf';

const { pdf, report } = await editPdf('invoice.pdf', [
  { search: 'Rahul Sharma', replace: 'Priyank Dadhich' },
  { search: '25,000', replace: '1,25,000' },
]);
```

## Contents

- [The problem it solves](#the-problem-it-solves)
- [When to use it (and when not)](#when-to-use-it-and-when-not)
- [Install](#install)
- [Quick start](#quick-start)
- [Ways to edit](#ways-to-edit)
- [How edits keep the layout intact](#how-edits-keep-the-layout-intact)
- [Other APIs](#other-apis)
- [CLI](#cli)
- [Options](#options)
- [Limits and file size](#limits-and-file-size)
- [Errors](#errors)
- [Production notes](#production-notes)
- [Supported features and known gaps](#supported-features-and-known-gaps)

## The problem it solves

A PDF does not store paragraphs or table cells. It stores positioned glyphs. Replacing a name with a longer one by hand-editing the content stream pushes text into its neighbours, breaks right-aligned numbers, loses fonts that were embedded as subsets, and corrupts Hindi/Devanagari text.

`layout-safe-pdf` handles those cases for you:

- Only the text operations that contain the match are rewritten. Graphics, images and every other byte of the page stay unchanged.
- The rest of the line moves with the new width. The text is condensed slightly when it would hit a table border or the next column.
- Right-aligned and centred table cells keep their alignment, so amounts grow to the left.
- Characters missing from an embedded font subset are added from a matching system font, and the PDF stays searchable and copyable.
- Paragraphs are re-wrapped (and re-justified) when an edit no longer fits on its line.
- Devanagari text is shaped correctly (conjuncts, matras, reph).
- Encrypted files are decrypted, edited and re-encrypted. Fillable form fields can be filled by name.

## When to use it (and when not)

**Good fit**
- Correcting or personalising generated PDFs: invoices, certificates, offer letters, receipts, forms.
- Template-style replacement across many files (names, dates, amounts, IDs, regex patterns).
- A "click a word, type a new one" editor, either in a web app or behind an HTTP API.
- Filling AcroForm fields and reading the list of fields.
- Extracting text with positions from a PDF.
- Server-side batch jobs where installing Python, Java or native binaries is not an option.

**Not a fit**
- **Scanned PDFs** whose text is only an image. There is nothing to edit and no OCR, so these report `notFound`.
- Editing images, drawings or page structure (adding, removing or reordering pages).
- Visual, drag-and-drop layout editing.
- Preserving a digital signature. Editing a signed PDF invalidates the signature, and `replace()` warns about it.
- Bengali, Gujarati, Tamil and other Indic scripts, and vertical writing. See [known gaps](#supported-features-and-known-gaps).

## Install

```bash
npm install layout-safe-pdf
```

Requires Node.js 18 or newer. ESM only (`import`). TypeScript types are included.

## Quick start

```js
import { editPdf } from 'layout-safe-pdf';

const { pdf, report } = await editPdf('input.pdf', [   // a path or a Buffer
  { search: 'Full Stack Developer', replace: 'Python Developer', pages: [1] },
  { search: /INV-\d{4}/.source, regex: true, replace: 'INV-2026' },
], { output: 'output.pdf' });                           // optional: also write to disk

if (!report.ok) console.log(report.edits);              // notFound / skipped reasons per edit
```

`pdf` is a `Buffer` with the edited file. `report` is:

```
{ ok, replaced, pageCount, warnings, edits: [{ search, replace, replaced, skipped, warnings, notFound? }] }
```

`report.ok` is `true` only when every edit replaced something and nothing was skipped. Nothing is skipped silently.

An edit takes: `search`, `replace`, `regex`, `ignoreCase`, `pages` (1-based), `maxCount`, `mode`, `align`, `wrap`. In `replace`, `$&` means the matched text.

## Ways to edit

**1. Find & Replace.** Replaces every occurrence, or limit it with `pages` or `maxCount`:

```js
await editPdf(pdf, [{ search: 'Rahul Sharma', replace: 'Priyank Dadhich', pages: [1, 2] }]);
```

**2. Select & Replace.** Changes only the occurrence at a given place, even if the same text appears elsewhere. This is the call behind a "click a word and edit it" UI:

```js
await editPdf(pdf, [{ search: selectedText, replace: newText, page: 2, bbox: [x0, y0, x1, y1] }]);
```

`page` is 1-based. `bbox` is in PDF points with the origin at the **bottom left**. With pdf.js in the browser, convert a selection rectangle like this:

```js
const [x0, y0] = viewport.convertToPdfPoint(rect.left - pageLeft, rect.bottom - pageTop);
const [x1, y1] = viewport.convertToPdfPoint(rect.right - pageLeft, rect.top - pageTop);
```

**3. Fill form fields.** `getFormFields(doc)` lists every field (name, type, value, options, read-only flag). Fill them by name:

```js
await editPdf(pdf, [], { fields: { name: 'Priyank Dadhich', agree: true, gender: 'Male', state: 'Delhi' } });
```

- Supported: text fields (including empty ones), checkboxes (`true`/`false`), radio groups (an option value), dropdowns and lists.
- Appearances are regenerated so every viewer shows the new values.
- Read-only fields, unknown options and values that are too long are refused. `report.fields` gives the reason for each.

## How edits keep the layout intact

1. **Exact glyph positions.** The content interpreter tracks the full graphics and text state, including `cm`, `q/Q`, `Tm`, `Td`, `TJ` kerning and Form XObjects. For every glyph it records its operation and exact page position.
2. **Surgical rewrite.** Only the operations that contain affected glyphs are re-emitted. Graphics, images, inline images and marked content are copied unchanged.
3. **Exact repositioning.** `TJ` displacements put every glyph outside the match at its planned position (checked to 1/1000 pt in tests).
4. **Layout decisions** (`mode: 'reflow'`, the default):
   - The rest of the line moves with the new width. Free space is bounded by table borders (detected from painted lines and rectangles), the next column and the page text area.
   - If the new text does not fit, it is condensed horizontally (`Tz`) down to `minScale` (default 50%).
   - Justified lines absorb the change in their word gaps, so both edges stay flush.
   - `align: 'auto'` detects right-aligned and centred cells.
   - Several matches on one line share that line's free space.
   - Other modes: `preserve` (nothing else moves) and `fit` (always squeeze the new text into the old width).
5. **Missing glyphs.** If the new text needs a character that an embedded subset lacks, the engine finds the same font on the system (or uses `fonts` / `fallbackFont`), subsets it, and embeds the glyphs with a `ToUnicode` map.
6. **Paragraph re-wrap.** When an edit does not fit on its line, the engine detects the paragraph (consistent leading, shared left edge, lines that ended because the next word did not fit) and lays it out again. It tries a barely visible condensing (down to 93%) first. It only adds lines where the page below is empty. Pass `wrap: false` to disable this.
7. **Devanagari.** A built-in OpenType layout engine (GDEF, GSUB, GPOS) and Indic shaper produce the glyph runs. Output is written with `ActualText`, so search and copy/paste return the logical text. Output matched Apple CoreText glyph-for-glyph on a test word set.
8. **Incremental save.** By default, changes are appended and the original bytes stay unchanged. `{ incremental: false }` writes a clean full rewrite and drops unused objects.

## Other APIs

The lower-level classes give you full control:

```js
import { PDFDocument, TextEditor, extractText, getFormFields } from 'layout-safe-pdf';

const doc = await PDFDocument.load('invoice.pdf', { password: 'open' }); // password only if encrypted
const editor = new TextEditor(doc);

const result = editor.replace({ search: 'Rahul Sharma', replace: 'Priyank Dadhich' });
// result: { replaced, skipped: [{ page, text, reason }], warnings, details }

editor.replaceAt({ page: 0 /* 0-based here */, bbox, search, replace }); // select & replace
console.log(extractText(doc, 0));                                         // text of page 0
console.log(getFormFields(doc));

const bytes = doc.save();              // Buffer; or: await doc.saveAs('out.pdf')

doc.encrypt({ userPassword: 'open', ownerPassword: 'owner', permissions: { copy: false } }); // AES-256
```

Also exported: `extractLines` (words with positions), `diagnose()` (environment check), `setFormFields`, `setLimits`, and the PDF object classes. See `src/index.d.ts` for every type.

## CLI

```bash
npx layout-safe-pdf info file.pdf
npx layout-safe-pdf text file.pdf --page 1 --positions
npx layout-safe-pdf find file.pdf "Rahul"
npx layout-safe-pdf replace in.pdf out.pdf --search "Rahul Sharma" --replace "Priyank Dadhich"
npx layout-safe-pdf replace in.pdf out.pdf --spec edits.json
npx layout-safe-pdf encrypt in.pdf out.pdf --user-password open --no-copy
npx layout-safe-pdf decrypt in.pdf out.pdf --password open
npx layout-safe-pdf doctor
```

`doctor` checks Node.js and the fonts available for English and Hindi edits. Run it on a new server first.

## Options

`new TextEditor(doc, options)` (or `editPdf(..., { editor: options })`):

| Option | Meaning |
|---|---|
| `fonts` | Maps PDF font names to font files, e.g. `{ ArialMT: '/path/arial.ttf' }`. |
| `fontDirs` | Extra folders to search for fonts. |
| `scriptFonts` | Font per script, e.g. `{ deva: '/path/NotoSansDevanagari.ttf' }`. |
| `fallbackFont` | Font file to use when nothing matches. |
| `useSystemFonts` | Set `false` to ignore installed fonts. |
| `substituteFonts` (default `true`) | When the PDF's font is not installed, use the most similar installed font and report a warning. |
| `embedMissingGlyphs` (default `true`) | Embed characters that the PDF's font subset lacks. |

`editPdf(input, edits, options)` also accepts `password`, `output` (a path to write), `incremental` (default `true`), `includeText` (adds the edited text to the report, handy for checks), `fields` (form values) and `allowReadOnly`.

## Limits and file size

There is **no fixed file-size cap** in the library. The whole PDF is read into memory, so the practical limit is your RAM and your time budget. These numbers were measured on Node 20 with a text-heavy synthetic PDF (45 lines per page, one replacement per line) and with image-heavy files, on a development Mac:

| Input | Result |
|---|---|
| 100 pages (0.5 MB) | about 0.3 s |
| 500 pages (2.3 MB, 22,500 replacements) | about 1.2 s |
| 2,000 pages (9.4 MB, 90,000 replacements) | about 4.8 s |
| 100 MB (one huge image) | 50 ms, about 600 MB RSS |
| 500 MB | under 1 s, about 2.2 GB RSS |
| 1 GB (10 pages) | about 1.4 s, about 2.8 GB RSS |

- **Time:** roughly 1 ms per page to extract text and a few ms per text-heavy page to edit. Images are copied, not decoded, so large image-only files are fast.
- **Memory:** plan for about **3–5 times the file size** in RAM (the input, the working copy and the output exist at the same time).
- **Hard ceiling:** Node's `Buffer` limit is 4 GB, so a single file above about 4 GB cannot be loaded.

**Recommended sizes**

| Use | Suggested maximum |
|---|---|
| Public web API with user uploads | **25–50 MB and about 500–1,000 pages** per file, with a request timeout |
| Internal or trusted batch jobs | Several hundred MB, as long as RAM allows |
| The bundled `examples/server.js` | 60 MB JSON body (about 45 MB PDF) |

**Built-in safety limits.** These protect the process from hostile files such as decompression bombs or pages with millions of glyphs. They throw a `PDFLimitError`:

| Limit | Default | Meaning |
|---|---|---|
| `maxStreamSize` | 256 MB | Largest **decoded** size of one stream |
| `maxGlyphsPerPage` | 2,000,000 | Most glyphs on one page |
| `maxNestingDepth` | 512 | Deepest nesting of arrays and dictionaries |
| `maxObjectsPerStream` | 1,000,000 | Most objects in one object stream |

A normal page has a few thousand glyphs, so real documents never get near these. Raise them only for trusted input:

```js
import { setLimits } from 'layout-safe-pdf';
setLimits({ maxStreamSize: 512 * 1024 * 1024 });
```

## Errors

| Error | When |
|---|---|
| `Error: Not a PDF file` | Empty input, or not a PDF (for example a gzip file). |
| `PDFPasswordError` | The file is encrypted and the password is missing or wrong. |
| `PDFLimitError` | A safety limit above was exceeded. The message names the limit to raise. |
| `PDFSyntaxError` | The file is structurally broken in a way that cannot be repaired. |
| `TypeError` | `edits` is not an array, or an edit has no string `search` / `replace`. |

Not errors, but reported in `report`:
- `notFound: true` means the text does not exist in the PDF. This happens with scanned PDFs, with text split by unusual encodings, and with typos. Check with `extractText` or `find`.
- `skipped` entries explain why a match was left unchanged (for example a missing glyph with no usable font, or a read-only form field).
- Damaged files (wrong offsets, missing `startxref`, truncated downloads) are repaired automatically, and `report.warnings` says what was fixed.

## Production notes

- **Event loop.** The work is synchronous and CPU-bound. For a busy API, run it in a `worker_threads` pool (for example Piscina) so requests do not block each other.
- **Memory.** Nothing is cached per document after a request, and interned PDF names are held weakly, so a long-running server stays flat. In one long synchronous batch, yield between files with `await new Promise((r) => setImmediate(r))`.
- **Fonts on servers.** New characters and Devanagari need fonts. On Linux, install fonts (for example `fonts-noto-core`, `fonts-liberation`) or pass `fonts`, `fontDirs` or `scriptFonts`. Run `doctor` to check.
- **Signed PDFs.** `doc.isSigned` and `doc.signatures` tell you whether a document is signed.
- **Untrusted uploads.** Keep the default limits, cap the upload size, and set a timeout.

### HTTP API example

The package ships `examples/server.js`, a small server with no dependencies:

```bash
node node_modules/layout-safe-pdf/examples/server.js
```

- `POST /edit` takes `{ "pdf": "<base64>", "edits": [...], "fields": {...}, "password": "..." }` and returns `{ "pdf": "<base64>", "report": {...} }`.
- `POST /edit?download=1` returns the PDF itself, with the report in the `X-Edit-Report` header.
- `POST /fields` lists the form fields of an uploaded PDF.

## Supported features and known gaps

| Area | Status |
|---|---|
| Classic xref, xref streams, object streams, hybrid files, damaged files | Supported (repaired automatically) |
| Filters: Flate, LZW, ASCII85, ASCIIHex, RunLength, PNG/TIFF predictors | Supported (image codecs are passed through) |
| Encryption: RC4 40/128, AES-128, AES-256 (R5/R6) | Read, edit and re-encrypt; create AES-256; remove encryption |
| Fonts: Type1, TrueType, Type3, Type0/CID, Standard-14, CFF/OpenType, `.ttc` | Supported |
| Find & replace (string or regex), select & replace, text inside Form XObjects | Supported |
| Paragraph re-wrap and re-justification | Supported (only into free space) |
| Devanagari (Hindi, Marathi, …) | Supported. Needs a Devanagari OpenType font such as Noto Sans Devanagari, Kohinoor, Mangal or Nirmala UI |
| Hindi PDFs without ActualText (for example from MS Word) | Supported (visual-to-logical repair of ि and reph) |
| Legacy Kruti Dev and DevLys 010 fonts | Read as Unicode, edits written in the original font |
| Fillable form fields (text, checkbox, radio, dropdown, list) | Supported |
| Text extraction with positions | Supported |
| Other legacy Hindi layouts (for example Chanakya) | Not supported |
| Other Indic scripts (Bengali, Gujarati, Tamil, …) | Not supported (the shaper is Devanagari-only) |
| Pulling words up into the previous line when text gets shorter | Not supported (shorter text leaves the line ragged) |
| Vertical writing, Type3 font substitution | Not supported |
| Scanned PDFs (text only as images) | Not supported (needs OCR) |
| Adding, removing or reordering pages; editing images | Not supported |

## Testing

```bash
npm test          # 90 unit, integration and regression tests
npm run fuzz -- 1000   # mutation fuzzing with corrupted files
```

CI runs both on Linux, macOS and Windows with Node 18, 20 and 22.

## License

[MIT](LICENSE)
