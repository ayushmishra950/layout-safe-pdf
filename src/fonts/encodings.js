// Simple-font encodings (ISO 32000-1, Annex D) and glyph-name -> Unicode lookup.

const ASCII_NAMES = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle',
  'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  'braceleft', 'bar', 'braceright', 'asciitilde',
]; // codes 32..126

const LATIN1_UPPER = [
  'space', 'exclamdown', 'cent', 'sterling', 'currency', 'yen', 'brokenbar', 'section', 'dieresis',
  'copyright', 'ordfeminine', 'guillemotleft', 'logicalnot', 'hyphen', 'registered', 'macron',
  'degree', 'plusminus', 'twosuperior', 'threesuperior', 'acute', 'mu', 'paragraph', 'periodcentered',
  'cedilla', 'onesuperior', 'ordmasculine', 'guillemotright', 'onequarter', 'onehalf', 'threequarters',
  'questiondown', 'Agrave', 'Aacute', 'Acircumflex', 'Atilde', 'Adieresis', 'Aring', 'AE', 'Ccedilla',
  'Egrave', 'Eacute', 'Ecircumflex', 'Edieresis', 'Igrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Eth',
  'Ntilde', 'Ograve', 'Oacute', 'Ocircumflex', 'Otilde', 'Odieresis', 'multiply', 'Oslash', 'Ugrave',
  'Uacute', 'Ucircumflex', 'Udieresis', 'Yacute', 'Thorn', 'germandbls', 'agrave', 'aacute',
  'acircumflex', 'atilde', 'adieresis', 'aring', 'ae', 'ccedilla', 'egrave', 'eacute', 'ecircumflex',
  'edieresis', 'igrave', 'iacute', 'icircumflex', 'idieresis', 'eth', 'ntilde', 'ograve', 'oacute',
  'ocircumflex', 'otilde', 'odieresis', 'divide', 'oslash', 'ugrave', 'uacute', 'ucircumflex',
  'udieresis', 'yacute', 'thorn', 'ydieresis',
]; // codes 160..255

function makeEncoding(fill) {
  const enc = new Array(256).fill(undefined);
  ASCII_NAMES.forEach((n, i) => (enc[32 + i] = n));
  fill(enc);
  return enc;
}

export const WinAnsiEncoding = makeEncoding((e) => {
  const hi = {
    128: 'Euro', 130: 'quotesinglbase', 131: 'florin', 132: 'quotedblbase', 133: 'ellipsis', 134: 'dagger',
    135: 'daggerdbl', 136: 'circumflex', 137: 'perthousand', 138: 'Scaron', 139: 'guilsinglleft', 140: 'OE',
    142: 'Zcaron', 145: 'quoteleft', 146: 'quoteright', 147: 'quotedblleft', 148: 'quotedblright',
    149: 'bullet', 150: 'endash', 151: 'emdash', 152: 'tilde', 153: 'trademark', 154: 'scaron',
    155: 'guilsinglright', 156: 'oe', 158: 'zcaron', 159: 'Ydieresis', 127: 'bullet',
  };
  for (const [k, v] of Object.entries(hi)) e[k] = v;
  LATIN1_UPPER.forEach((n, i) => (e[160 + i] = n));
});

export const StandardEncoding = makeEncoding((e) => {
  e[39] = 'quoteright';
  e[96] = 'quoteleft';
  const hi = {
    161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section',
    168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft',
    173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger', 179: 'daggerdbl',
    180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase',
    186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown',
    193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent',
    200: 'dieresis', 202: 'ring', 203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron',
    208: 'emdash', 225: 'AE', 227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine',
    241: 'ae', 245: 'dotlessi', 248: 'lslash', 249: 'oslash', 250: 'oe', 251: 'germandbls',
  };
  for (const [k, v] of Object.entries(hi)) e[k] = v;
});

export const MacRomanEncoding = makeEncoding((e) => {
  const names = (
    'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde ' +
    'aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ' +
    'ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling ' +
    'section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash ' +
    'infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ' +
    'ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta ' +
    'guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft ' +
    'quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft ' +
    'guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex ' +
    'Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple ' +
    'Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla ' +
    'hungarumlaut ogonek caron'
  ).split(' ');
  names.forEach((n, i) => (e[128 + i] = n));
});

export const ENCODINGS = { WinAnsiEncoding, StandardEncoding, MacRomanEncoding };

// ---- glyph names -> Unicode -----------------------------------------------------

const CP1252_HI = {
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6,
  137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c,
  148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a,
  156: 0x0153, 158: 0x017e, 159: 0x0178,
};

const GLYPH_TO_UNICODE = new Map();
ASCII_NAMES.forEach((n, i) => GLYPH_TO_UNICODE.set(n, 32 + i));
LATIN1_UPPER.forEach((n, i) => { if (!GLYPH_TO_UNICODE.has(n)) GLYPH_TO_UNICODE.set(n, 160 + i); });
for (const [code, uni] of Object.entries(CP1252_HI)) GLYPH_TO_UNICODE.set(WinAnsiEncoding[code], uni);
const EXTRA = {
  quoteleft: 0x2018, quoteright: 0x2019, fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04,
  dotlessi: 0x0131, Lslash: 0x0141, lslash: 0x0142, fraction: 0x2044, breve: 0x02d8, dotaccent: 0x02d9,
  ring: 0x02da, hungarumlaut: 0x02dd, ogonek: 0x02db, caron: 0x02c7, minus: 0x2212, notequal: 0x2260,
  infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265, partialdiff: 0x2202, summation: 0x2211,
  product: 0x220f, pi: 0x03c0, integral: 0x222b, Omega: 0x2126, radical: 0x221a, approxequal: 0x2248,
  Delta: 0x2206, lozenge: 0x25ca, apple: 0xf8ff, nbspace: 0x00a0, sfthyphen: 0x00ad, space: 0x20,
  hyphen: 0x2d, bullet: 0x2022, mu: 0x00b5, Euro: 0x20ac, rupee: 0x20b9, rupeeindian: 0x20b9,
  periodcentered: 0x00b7, middot: 0x00b7, dagger: 0x2020, Tcedilla: 0x0162, tcedilla: 0x0163,
  Gbreve: 0x011e, gbreve: 0x011f, Idotaccent: 0x0130, Scedilla: 0x015e, scedilla: 0x015f,
  checkmark: 0x2713, copyright: 0xa9, registered: 0xae, trademark: 0x2122,
};
for (const [k, v] of Object.entries(EXTRA)) GLYPH_TO_UNICODE.set(k, v);

/**
 * Returns the Unicode string for a glyph name, following the AGL rules for
 * uniXXXX, uXXXX[XX] and ligature/suffix forms ("f_i", "a.sc").
 */
export function glyphNameToUnicode(name) {
  if (!name) return undefined;
  const direct = GLYPH_TO_UNICODE.get(name);
  if (direct !== undefined) return String.fromCodePoint(direct);
  const base = name.split('.')[0];
  if (base !== name && base) return glyphNameToUnicode(base);
  if (name.includes('_')) {
    const parts = name.split('_').map(glyphNameToUnicode);
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i < m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return undefined;
}

/** Reverse lookup used when encoding text with a simple font. */
export function unicodeToGlyphName(ch) {
  const cp = ch.codePointAt(0);
  for (const [name, u] of GLYPH_TO_UNICODE) if (u === cp) return name;
  return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0');
}

// ---- Symbol font built-in encoding (code -> Unicode) ---------------------------------------

const SYMBOL_LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅' +
  'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ' +
  '[∴]⊥_' +
  'αβχδεφγηιϕκλμνοπθρστυϖωξψζ' +
  '{|}∼'; // codes 32..126
const SYMBOL_HIGH = {
  0xa0: '€', 0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣',
  0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔', 0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓',
  0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•',
  0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbd: '⏐', 0xbe: '⎯', 0xbf: '↵',
  0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘', 0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩',
  0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉',
  0xd0: '∠', 0xd1: '∇', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅',
  0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔', 0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓',
  0xe0: '◊', 0xe1: '〈', 0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xe6: '⎛', 0xe7: '⎜',
  0xe8: '⎝', 0xe9: '⎡', 0xea: '⎢', 0xeb: '⎣', 0xec: '⎧', 0xed: '⎨', 0xee: '⎩', 0xef: '⎪',
  0xf1: '〉', 0xf2: '∫', 0xf3: '⌠', 0xf4: '⎮', 0xf5: '⌡', 0xf6: '⎞', 0xf7: '⎟', 0xf8: '⎠',
  0xf9: '⎤', 0xfa: '⎥', 0xfb: '⎦', 0xfc: '⎫', 0xfd: '⎬', 0xfe: '⎭',
};

/** Unicode for a code in the Symbol font's built-in encoding. */
export function symbolUnicode(code) {
  if (code >= 32 && code <= 126) return [...SYMBOL_LOW][code - 32];
  return SYMBOL_HIGH[code];
}
