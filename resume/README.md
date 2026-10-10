# Resume generator

Builds a resume PDF from JSON, in the same format as the reference resume (US Letter, Carlito, blue headings,
right-aligned dates). Pure Node built-ins, no dependencies. Independent of the PDF editing engine in `src/`.

```bash
node resume/cli.js resume/samples/fresher.json out.pdf
```
```js
import { buildResume } from './resume/index.js';
const { pdf, pages, layout, warnings } = buildResume(data, { output: 'resume.pdf' });
```

## Data

| key | notes |
|---|---|
| `name` (required), `title` | header |
| `contact` | `phone, email, location, linkedin, github, portfolio, website, other[]` (email/links are clickable) |
| `summary` | optional paragraph |
| `experience[]` | `role, company, location, start, end` (or `dates`), `duration`, `internship: true`, `bullets[]` |
| `projects[]` | `name, description, tech, link` |
| `skills` | `{ "Frontend": "React, CSS" }` or `[{label, items[]}]` |
| `education[]` | `degree, institution, status/year, grade, details[]` |
| `certifications[]`, `achievements[]`, `sections[]` | `sections`: `[{title, bullets[]}]` for anything else |
| `layout`, `order`, `titles` | optional overrides (`"fresher"`/`"experienced"`, section order, heading text) |

Empty sections are left out. **Experienced** (any non-internship job): Summary, Experience, Projects, Skills,
Education, ... **Fresher** (no job, or internships only): Summary, Education, Skills, Internship, Projects, ...

Content that does not fit on one page flows onto more pages with the same margins and spacing. Headings and
entry headers are never left alone at the bottom of a page, and bullets are not split into one-line widows.

## Spacing (`"spacing": "auto" | "normal"`)

`auto` (default): when the content fills under ~80% of one page, section/line gaps (and fonts, by up to 1pt) are
opened up until it fills about 85-88% of the page. Full or multi-page resumes are never changed, they keep the
reference spacing exactly. Very little data stays fairly empty on purpose (the stretch is capped so it never looks
bloated). `normal` always uses the reference spacing. `buildResume()` returns `spacing: {mode, stretch, fill}`.
