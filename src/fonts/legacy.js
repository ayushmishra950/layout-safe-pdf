// Legacy (non-Unicode) Hindi fonts: Kruti Dev / DevLys 010 keyboard layout.
//
// These fonts draw Devanagari glyphs on Latin code points ("jke" shows as
// राम), so a PDF made with them contains ASCII text. We convert that text to
// Unicode for search/extraction, and Unicode replacements back to the font's
// codes so edits keep the original look.

/** Does this font name use the Kruti Dev 010 layout? */
export function isKrutiFont(baseFont) {
  return /kruti\s*-?\s*dev|devlys/i.test((baseFont || '').replace(/^[A-Z]{6}\+/, ''));
}

// The reph key Z becomes this placeholder until it has been moved into place.
const REPH = '\ue000';

// Kruti -> Unicode pairs. Longest keys win; order matters only for equal length.
const PAIRS = [
  // conjuncts and special ligatures
  ['{k', 'क्ष'], ['{', 'क्ष्'], ['=', 'त्र'], ['K', 'ज्ञ'], ['J', 'श्र'], ['|', 'द्य'], [')', 'द्ध'], ['}', 'द्व'],
  ['Ø', 'क्र'], ['Ùk', 'त्त'], ['Ù', 'त्त्'], ['í', 'द्द'], ['ã', 'ह्म'], ['à', 'ह्न'], ['á', 'ह्य'], ['â', 'हृ'],
  ['Vª', 'ट्र'], ['Mª', 'ड्र'], ['Nª', 'छ्र'], ['ê', 'ट्ट'], ['ë', 'ट्ठ'], ['ì', 'ड्ड'], ['ï', 'ड्ढ'],
  ['Dr', 'क्त'], ['–', 'दृ'], ['—', 'कृ'], ['é', 'न्न'], ['™', 'न्न्'], ['#', 'रु'], [':', 'रू'],
  // vowels
  ['vkS', 'औ'], ['vks', 'ओ'], ['v‚', 'ऑ'], ['vk', 'आ'], ['v', 'अ'], ['bZ', 'ई'], ['b', 'इ'], ['m', 'उ'], ['Å', 'ऊ'],
  [',s', 'ऐ'], [',', 'ए'], ['_', 'ऋ'],
  // consonants: full forms (letter + k) and half forms
  ['Dk', 'क'], ['d', 'क'], ['D', 'क्'], ['[k', 'ख'], ['[', 'ख्'], ['Xk', 'ग'], ['x', 'ग'], ['X', 'ग्'],
  ['?k', 'घ'], ['?', 'घ्'], ['³', 'ङ'], ['Pk', 'च'], ['p', 'च'], ['P', 'च्'], ['N', 'छ'],
  ['Tk', 'ज'], ['t', 'ज'], ['T', 'ज्'], ['>', 'झ'], ['÷', 'झ्'], ['¥', 'ञ'],
  ['V', 'ट'], ['B', 'ठ'], ['M', 'ड'], ['<', 'ढ'], ['.k', 'ण'], ['.', 'ण्'],
  ['Rk', 'त'], ['r', 'त'], ['R', 'त्'], ['Fk', 'थ'], ['F', 'थ्'], ['n', 'द'], ['/k', 'ध'], ['èk', 'ध'], ['/', 'ध्'], ['è', 'ध्'],
  ['Uk', 'न'], ['u', 'न'], ['U', 'न्'], ['Ik', 'प'], ['i', 'प'], ['I', 'प्'], ['Q', 'फ'], ['¶', 'फ्'],
  ['Ck', 'ब'], ['c', 'ब'], ['C', 'ब्'], ['Hk', 'भ'], ['H', 'भ्'], ['Ek', 'म'], ['e', 'म'], ['E', 'म्'],
  [';', 'य'], ['¸', 'य्'], ['j', 'र'], ['Yk', 'ल'], ['y', 'ल'], ['Y', 'ल्'], ['G', 'ळ'], ['Ok', 'व'], ['o', 'व'], ['O', 'व्'],
  ["'k", 'श'], ["'", 'श्'], ['"k', 'ष'], ['"', 'ष्'], ['Lk', 'स'], ['l', 'स'], ['L', 'स्'], ['g', 'ह'],
  // nukta forms
  ['d+', 'क़'], ['[+k', 'ख़'], ['x+', 'ग़'], ['t+', 'ज़'], ['M+', 'ड़'], ['<+', 'ढ़'], ['Q+', 'फ़'],
  // matras and signs
  ['ks', 'ो'], ['kS', 'ौ'], ['k', 'ा'], ['f', 'ि'], ['h', 'ी'], ['q', 'ु'], ['w', 'ू'], ['`', 'ृ'],
  ['s', 'े'], ['S', 'ै'], ['a', 'ं'], ['¡', 'ँ'], ['%', 'ः'], ['‚', 'ॉ'], ['W', 'ॅ'], ['+', '़'],
  ['z', '्र'], ['~', '्'], ['Z', REPH],
  // digits (Devanagari) and punctuation
  ['å', '०'], ['ƒ', '१'], ['„', '२'], ['…', '३'], ['†', '४'], ['‡', '५'], ['ˆ', '६'], ['‰', '७'], ['Š', '८'], ['‹', '९'],
  ['A', '।'], ['-', '.'], ['&', '-'], [']', ','], ['@', '/'], ['¼', '('], ['½', ')'], ['¿', '{'], ['À', '}'], ['¾', '='],
  ['^', '‘'], ['*', '’'], ['Þ', '“'], ['ß', '”'], ['\\', '?'],
];


const K2U = new Map(PAIRS);
const MAX_KEY = Math.max(...PAIRS.map(([k]) => k.length));

// Unicode -> Kruti: prefer the shortest key for each Unicode string.
const U2K = new Map();
for (const [k, u] of PAIRS) {
  const prev = U2K.get(u);
  if (prev === undefined || k.length < prev.length) U2K.set(u, k);
}
// Preferred spellings where several keys exist.
for (const [u, k] of [['क', 'd'], ['ग', 'x'], ['च', 'p'], ['ज', 't'], ['त', 'r'], ['न', 'u'], ['प', 'i'], ['ब', 'c'],
  ['म', 'e'], ['ल', 'y'], ['व', 'o'], ['स', 'l'], ['ध', '/k'], ['ध्', '/']]) U2K.set(u, k);
U2K.delete('क्र'); // written as d + z (rakar), like other consonants
const MAX_U = Math.max(...[...U2K.keys()].map((u) => u.length));

const CONS = (c) => (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095f);
const SIGN = (c) => (c >= 0x093e && c <= 0x094c) || (c >= 0x0900 && c <= 0x0903);
const cp = (s, i) => (i >= 0 && i < s.length ? s.charCodeAt(i) : 0);
const CLUSTER = '(?:[\\u0915-\\u0939\\u0958-\\u095f]\\u093c?\\u094d)*[\\u0915-\\u0939\\u0958-\\u095f]\\u093c?';

/** Converts Kruti Dev text to Unicode. */
export function krutiToUnicode(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    let hit = null;
    for (let n = Math.min(MAX_KEY, text.length - i); n > 0; n--) {
      const u = K2U.get(text.slice(i, i + n));
      if (u !== undefined) { hit = [n, u]; break; }
    }
    if (hit) { out += hit[1]; i += hit[0]; } else { out += text[i]; i++; }
  }
  // ि is typed before its consonant cluster: move it after the cluster.
  out = out.replace(new RegExp('\\u093f(' + CLUSTER + '(?:\\u094d\\u0930)?)', 'g'), '$1\u093f');
  // The reph (Z) is typed after its syllable: move it before the syllable's consonants.
  let s = out;
  for (let i = s.indexOf(REPH); i >= 0; i = s.indexOf(REPH, i + 1)) {
    let j = i - 1;
    while (j >= 0 && (SIGN(cp(s, j)) || cp(s, j) === 0x093c)) j--;
    if (j < 0 || !CONS(cp(s, j))) continue;
    while (j >= 2 && cp(s, j - 1) === 0x094d && CONS(cp(s, j - 2))) j -= 2;
    s = s.slice(0, j) + REPH + s.slice(j, i) + s.slice(i + 1);
  }
  return s.replaceAll(REPH, 'र्');
}

/** Converts Unicode Hindi to Kruti Dev codes (inverse of krutiToUnicode). */
export function unicodeToKruti(text) {
  let s = text.normalize('NFC');
  // Reph: र् before a consonant cluster goes after the syllable (before ं ँ ः).
  s = s.replace(new RegExp('\\u0930\\u094d(' + CLUSTER + '[\\u093e-\\u094c]*)', 'g'), '$1' + REPH);
  // ि goes before its consonant cluster (including a rakar: प्रि -> f + iz).
  s = s.replace(new RegExp('(' + CLUSTER + '(?:\\u094d\\u0930)?)\\u093f', 'g'), '\u093f$1');
  let out = '';
  for (let i = 0; i < s.length; ) {
    // Consonant + rakar (्र) is written as the consonant followed by z.
    const c = s.charCodeAt(i);
    if (CONS(c) && s.charCodeAt(i + 1) === 0x094d && s[i + 2] === 'र' && U2K.has(s[i]) && !U2K.has(s.slice(i, i + 3))) {
      out += U2K.get(s[i]) + 'z';
      i += 3;
      continue;
    }
    let hit = null;
    for (let n = Math.min(MAX_U, s.length - i); n > 0; n--) {
      const k = U2K.get(s.slice(i, i + n));
      if (k !== undefined) { hit = [n, k]; break; }
    }
    if (hit) { out += hit[1]; i += hit[0]; } else { out += s[i]; i++; }
  }
  return out;
}
