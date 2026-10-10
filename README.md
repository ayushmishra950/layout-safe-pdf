# layout-safe-pdf

A zero-dependency PDF toolkit for Node.js. It does two jobs:

1. **Edit the text of an existing PDF without breaking its layout** (find & replace, click-and-edit, form filling).
2. **Generate a professional resume PDF from JSON** in one fixed, consistent format.

Pure Node.js. No npm dependencies, no Python, no Java, no native binaries. It only uses the built-in `fs`, `zlib`, `crypto`, `http` and `Buffer`.

```js
import { editPdf } from 'layout-safe-pdf';
import { buildResume } from 'layout-safe-pdf/resume';

await editPdf('invoice.pdf', [{ search: 'Rahul Sharma', replace: 'Priyank Dadhich' }], { output: 'out.pdf' });
const { pdf } = buildResume({ name: 'Rohan Mehta', skills: { Languages: 'JavaScript, Python' } });
```

## Contents

- [The problem it solves](#the-problem-it-solves)
- [Features](#features)
- [Install](#install)
- [How to use, step by step](#how-to-use-step-by-step)
- [HTTP API (Postman, any language)](#http-api-postman-any-language)
- [Command line](#command-line)
- [Good to know](#good-to-know)
- [Testing](#testing)
- [License](#license)

## The problem it solves

**Editing PDFs.** A PDF does not store paragraphs or table cells, only positioned glyphs. Changing "Rahul" to "Priyank Dadhich" by hand-editing the file pushes text into its neighbours, breaks right-aligned amounts, loses fonts that were embedded as subsets, and corrupts Hindi text. Developers usually work around this with a Python script, a Java library or a paid service. This library does it in plain Node.js and keeps the page looking like the original.

**Generating resumes.** Apps that collect user details (job portals, career sites, college tools) need to turn that data into a clean, consistent resume. Rendering HTML to PDF needs a headless browser, which is heavy. This library writes the PDF directly from JSON, in the same format every time, with proper page breaks.

## Features

### Edit existing PDFs
- **Find & replace** text, as plain strings or regular expressions, on all pages or selected ones.
- **Select & replace**: change only the occurrence at a given place on the page (the call behind a "click a word and edit it" editor).
- **Layout-safe**: the rest of the line moves with the new width, right-aligned and centred cells stay aligned, long text is condensed slightly instead of hitting a border, and paragraphs are re-wrapped when needed.
- **Fonts**: embedded subset fonts keep working. Characters the subset lacks are added from a matching font, and the PDF stays searchable and copyable.
- **Hindi (Devanagari)** is shaped correctly (conjuncts, matras, reph).
- **Form filling**: list the fields of an AcroForm PDF and fill text fields, checkboxes, radio buttons and dropdowns by name.
- **Encryption**: open encrypted PDFs, edit them and save them encrypted again. Add or remove AES-256 encryption.
- **Text extraction** with positions, and an environment check (`doctor`).
- Only the edited text operations are rewritten. Images, graphics and everything else stay byte-for-byte unchanged, and the original file can be kept intact (incremental save).

### Generate resumes
- **One professional format**: US Letter, Carlito (Calibri-compatible) font, blue section headings, right-aligned dates, bullet lists. Text is selectable and copyable, and email and profile links are clickable.
- **Fresher and experienced layouts, chosen automatically.** Someone with a job gets Summary → Experience → Projects → Skills → Education. A fresher (no job, or internships only) gets Summary → Education → Skills → Internship → Projects.
- **Automatic extra pages.** If the content is more than one page, it flows onto page 2, 3 and so on with the same margins and spacing. Headings and job titles are never left alone at the bottom of a page.
- **Sparse resumes look full.** When there is little data, spacing (and font size, a little) opens up so the page looks balanced. Full resumes keep the reference spacing.
- **Nothing is stored.** The PDF is built in memory and returned to you. The library never writes files unless you ask for an output path.

## Install

```bash
npm install layout-safe-pdf
```

Needs Node.js 18 or newer. ESM only (`import`). TypeScript types are included.

## How to use, step by step

### 1. Edit text in a PDF

```js
import { editPdf } from 'layout-safe-pdf';

const { pdf, report } = await editPdf('input.pdf', [   // a file path or a Buffer
  { search: 'Rahul Sharma', replace: 'Priyank Dadhich' },
  { search: /INV-\d{4}/.source, regex: true, replace: 'INV-2026' },
], { output: 'output.pdf' });                           // optional: also save to disk

if (!report.ok) console.log(report.edits);              // see which edit was not found or skipped and why
```

- `pdf` is a `Buffer` with the edited file.
- `report.ok` is `true` only if every edit replaced something and nothing was skipped. Nothing is skipped silently.
- An edit accepts `search`, `replace`, `regex`, `ignoreCase`, `pages` (1-based list), `maxCount`, `mode` (`'reflow'`, `'preserve'`, `'fit'`), `align` and `wrap`.
- If the PDF is encrypted, pass `{ password: '...' }` as an option.

### 2. Change only one specific word (select & replace)

Use this when the same text appears more than once and you want to change just one of them:

```js
await editPdf(pdf, [{ search: 'Rahul', replace: 'Priyank', page: 2, bbox: [x0, y0, x1, y1] }]);
```

`page` is 1-based. `bbox` is in PDF points with the origin at the **bottom left**.

### 3. Fill a form

```js
import { PDFDocument, getFormFields, editPdf } from 'layout-safe-pdf';

const doc = await PDFDocument.load('form.pdf');
console.log(getFormFields(doc));           // names, types, current values, options

await editPdf('form.pdf', [], {
  fields: { name: 'Priyank Dadhich', agree: true, gender: 'Male', state: 'Delhi' },
  output: 'filled.pdf',
});
```

Read-only fields, unknown options and values that are too long are refused, and `report.fields` tells you why.

### 4. Generate a resume

```js
import { buildResume } from 'layout-safe-pdf/resume';

const { pdf, pages, layout, warnings } = buildResume({
  name: 'Rohan Mehta',
  title: 'Software Developer',
  contact: { phone: '+91 90000 00000', email: 'rohan@example.com', location: 'Pune', github: 'github.com/rohan' },
  summary: 'Developer with 2 years of experience building web applications.',
  experience: [
    { role: 'Software Developer', company: 'Example Pvt. Ltd.', location: 'Pune',
      start: 'Jan 2024', end: 'Present', bullets: ['Built REST APIs with Node.js.', 'Reduced page load time by 30%.'] },
  ],
  projects: [{ name: 'Task Tracker', description: 'Kanban-style task manager', tech: 'MERN Stack' }],
  skills: { Frontend: 'React, HTML, CSS', Backend: 'Node.js, Express' },
  education: [{ degree: 'B.Tech in Computer Science', institution: 'Example University', status: '2023', grade: 'CGPA: 8.1' }],
}, { output: 'resume.pdf' });   // output is optional; pdf is also returned as a Buffer
```

Only `name` is required. Anything you leave out simply does not appear.

| Key | What it takes |
|---|---|
| `name`, `title` | Header. |
| `contact` | `phone, email, location, linkedin, github, portfolio, website, other[]`. Email and links become clickable. |
| `summary` | A short paragraph. |
| `experience[]` | `role, company, location, start, end` (or `dates`), `duration`, `internship: true`, `bullets[]`. |
| `projects[]` | `name, description, tech, link`. |
| `skills` | `{ "Frontend": "React, CSS" }` or `[{ label, items[] }]`. |
| `education[]` | `degree, institution, status` (year), `grade`, `details[]`. |
| `certifications[]`, `achievements[]` | Lists of strings. |
| `sections[]` | `[{ title, bullets[] }]` for any extra section (Languages, Volunteering, ...). |
| `layout`, `order`, `titles` | Optional: force `"fresher"` or `"experienced"`, set the section order, rename headings. |
| `spacing` | `"auto"` (default) or `"normal"`. See below. |

**Fresher vs experienced.** Chosen automatically. A candidate with only internships, or no experience at all, is laid out as a fresher (education first). Set `layout` to override.

**More than one page.** Just pass more data. The extra content moves to the next page by itself. `pages` in the result tells you how many pages were produced.

**Little data.** With `spacing: "auto"`, a sparse resume is spaced out so the page does not look empty. Very little data still leaves some empty space, on purpose, so it never looks bloated. Use `spacing: "normal"` to always keep the reference spacing. The result's `spacing` field shows what was applied.

**Warnings.** Characters that the font cannot show (for example Chinese) are replaced with `?` and listed in `warnings`.

Ready-made example data is in [`resume/samples/`](resume/samples) (fresher, experienced, a Class 12 student, and a very long resume).

### 5. Lower-level control (edit API)

```js
import { PDFDocument, TextEditor, extractText } from 'layout-safe-pdf';

const doc = await PDFDocument.load('invoice.pdf', { password: 'open' }); // password only if encrypted
const editor = new TextEditor(doc);
editor.replace({ search: 'Rahul Sharma', replace: 'Priyank Dadhich' });
console.log(extractText(doc, 0));                                        // text of page 0

const bytes = doc.save();                                                // Buffer
doc.encrypt({ userPassword: 'open', ownerPassword: 'owner', permissions: { copy: false } }); // AES-256
```

Also exported: `extractLines` (words with positions), `getFormFields`, `setFormFields`, `diagnose`, `setLimits`. See `src/index.d.ts` for all types.

## HTTP API (Postman, any language)

Two small servers with no dependencies are included. Neither stores anything on disk.

**Resume API**

```bash
node node_modules/layout-safe-pdf/resume/server.js     # http://localhost:3001
```

- `POST /resume` with the resume JSON as the body returns the PDF. The page count and layout are in the `X-Resume-Pages` and `X-Resume-Layout` headers.
- `POST /resume?format=json` returns `{ pdf: "<base64>", pages, layout, warnings }`.
- In Postman: **Body → raw → JSON**, paste the data, press **Send** (use **Send and Download** to save the PDF).

**Edit API**

```bash
node node_modules/layout-safe-pdf/examples/server.js   # http://localhost:3000
```

- `POST /edit` takes `{ "pdf": "<base64>", "edits": [...], "fields": {...}, "password": "..." }` and returns `{ "pdf": "<base64>", "report": {...} }`.
- `POST /edit?download=1` returns the PDF itself, with the report in the `X-Edit-Report` header.
- `POST /fields` lists the form fields of an uploaded PDF.

Set the port with `PORT=4000`.

## Command line

```bash
# edit
npx layout-safe-pdf text file.pdf --page 1
npx layout-safe-pdf find file.pdf "Rahul"
npx layout-safe-pdf replace in.pdf out.pdf --search "Rahul Sharma" --replace "Priyank Dadhich"
npx layout-safe-pdf replace in.pdf out.pdf --spec edits.json
npx layout-safe-pdf encrypt in.pdf out.pdf --user-password open --no-copy
npx layout-safe-pdf decrypt in.pdf out.pdf --password open
npx layout-safe-pdf doctor           # checks Node.js and the fonts available for edits

# resume (the output path is required)
npx layout-safe-resume data.json resume.pdf
```

## Good to know

**Not a fit**
- Scanned PDFs where the text is only an image (no OCR, so edits report `notFound`).
- Editing images or drawings, or adding, removing and reordering pages of an existing PDF.
- Keeping a digital signature valid: editing a signed PDF invalidates the signature (`replace()` warns about it).
- Bengali, Gujarati, Tamil and other Indic scripts, and vertical writing.
- Resume text in scripts that Carlito does not contain (such as Chinese or Arabic).

**Size and safety**
- The whole PDF is read into memory, so plan for roughly 3 to 5 times the file size in RAM. For a public upload API, keep files around 25 to 50 MB and set a request timeout.
- Built-in limits stop decompression bombs and hostile files with a `PDFLimitError`. You can raise them for trusted input with `setLimits(...)`.
- The work is synchronous and CPU-bound. For a busy server, run it in a `worker_threads` pool.
- New characters and Devanagari in edits need a font. On Linux, install fonts such as `fonts-noto-core` and `fonts-liberation`, or pass `fonts`, `fontDirs` or `scriptFonts`. Run `doctor` to check.

**Errors you may see**
- `PDFPasswordError`: the file is encrypted and the password is missing or wrong.
- `PDFLimitError`: a safety limit was exceeded (the message names it).
- `PDFSyntaxError`: the file is broken beyond repair.
- `report.edits[].notFound`: the text does not exist in the PDF.
- `resume data needs a "name"`: `buildResume` was called without a name.

## Testing

```bash
npm test                 # unit, integration and regression tests, including the resume generator
npm run fuzz -- 1000     # mutation fuzzing with corrupted files
```

CI runs the tests on Linux, macOS and Windows with Node 18, 20 and 22.

## License

[MIT](LICENSE). The resume generator bundles the Carlito font, which is licensed under the SIL Open Font License 1.1. See [resume/fonts/OFL.txt](resume/fonts/OFL.txt).
