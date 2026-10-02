// Builds test/fixtures/form-fields.pdf: text (filled + empty), checkbox, radio group, dropdown, read-only.
import fs from 'node:fs';
import { buildPdf } from '../../helpers.js';
const box = (on) => [
  { dict: '/Type /XObject /Subtype /Form /BBox [0 0 14 14]', stream: on ? '0 g 2 2 10 10 re f' : '' },
];
fs.writeFileSync(new URL('../form-fields.pdf', import.meta.url), buildPdf([
  /* 1 */ '<</Type /Catalog /Pages 2 0 R /AcroForm <</Fields [6 0 R 7 0 R 8 0 R 11 0 R 14 0 R 15 0 R] /DR <</Font <</Helv 5 0 R>>>> /DA (/Helv 11 Tf 0 g)>>>>',
  /* 2 */ '<</Type /Pages /Kids [3 0 R] /Count 1>>',
  /* 3 */ '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R 12 0 R 13 0 R 14 0 R 15 0 R]>>',
  /* 4 */ { dict: '', stream: 'BT /F1 12 Tf 72 720 Td (Name:) Tj 0 -40 Td (City:) Tj 0 -40 Td (Agree:) Tj 0 -40 Td (Gender:) Tj 0 -40 Td (State:) Tj 0 -40 Td (ID:) Tj ET' },
  /* 5 */ '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
  /* 6 */ '<</FT /Tx /T (name) /V (Rahul Sharma) /DA (/Helv 11 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [160 712 420 732] /P 3 0 R /F 4>>',
  /* 7 */ '<</FT /Tx /T (city) /DA (/Helv 11 Tf 0 g) /MaxLen 20 /Type /Annot /Subtype /Widget /Rect [160 672 420 692] /P 3 0 R /F 4>>',
  /* 8 */ '<</FT /Btn /T (agree) /V /Off /AS /Off /Type /Annot /Subtype /Widget /Rect [160 632 174 646] /P 3 0 R /F 4 /AP <</N <</Yes 9 0 R /Off 10 0 R>>>>>>',
  /* 9 */ ...box(true), /* 10 */ ...box(false),
  /* 11 */ '<</FT /Btn /T (gender) /Ff 49152 /V /Off /Kids [12 0 R 13 0 R]>>',
  /* 12 */ '<</Parent 11 0 R /AS /Off /Type /Annot /Subtype /Widget /Rect [160 592 174 606] /P 3 0 R /F 4 /AP <</N <</Male 9 0 R /Off 10 0 R>>>>>>',
  /* 13 */ '<</Parent 11 0 R /AS /Off /Type /Annot /Subtype /Widget /Rect [220 592 234 606] /P 3 0 R /F 4 /AP <</N <</Female 9 0 R /Off 10 0 R>>>>>>',
  /* 14 */ '<</FT /Ch /T (state) /Ff 131072 /Opt [(Rajasthan) (Gujarat) (Delhi)] /V (Rajasthan) /DA (/Helv 11 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [160 552 300 572] /P 3 0 R /F 4>>',
  /* 15 */ '<</FT /Tx /T (id) /Ff 1 /V (A-100) /DA (/Helv 11 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [160 512 300 532] /P 3 0 R /F 4>>',
]));
