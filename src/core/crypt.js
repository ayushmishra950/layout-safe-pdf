// Standard Security Handler (ISO 32000-1 section 7.6.3, ISO 32000-2 section 7.6.4).
// Supports RC4 40/128-bit (R2-R4), AES-128 (AESV2) and AES-256 (R5/R6, AESV3).

import crypto from 'node:crypto';
import { PDFDict, PDFName, PDFString, num } from './objects.js';

export class PDFPasswordError extends Error {}

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** RC4 – implemented here because OpenSSL 3 (Node 17+) disables it by default. */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = Buffer.allocUnsafe(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const sha = (alg, ...parts) => crypto.createHash(alg).update(Buffer.concat(parts)).digest();

function padPassword(pw) {
  const b = Buffer.alloc(32);
  const src = pw.subarray(0, 32);
  src.copy(b);
  PAD.copy(b, src.length, 0, 32 - src.length);
  return b;
}

function aesDecrypt(key, data) {
  if (data.length < 16) return Buffer.alloc(0);
  const iv = data.subarray(0, 16);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  if (body.length === 0) return Buffer.alloc(0);
  const alg = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const d = crypto.createDecipheriv(alg, key, iv);
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(body), d.final()]);
  // Remove PKCS#5 padding leniently.
  const p = out[out.length - 1];
  if (p >= 1 && p <= 16 && out.length >= p) {
    let ok = true;
    for (let i = out.length - p; i < out.length; i++) if (out[i] !== p) ok = false;
    if (ok) return out.subarray(0, out.length - p);
  }
  return out;
}

function aesEncrypt(key, data) {
  const iv = crypto.randomBytes(16);
  const alg = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = crypto.createCipheriv(alg, key, iv);
  return Buffer.concat([iv, c.update(data), c.final()]);
}

function aesNoPad(key, data, decrypt, iv = Buffer.alloc(16)) {
  const alg = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = decrypt ? crypto.createDecipheriv(alg, key, iv) : crypto.createCipheriv(alg, key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** Algorithm 2.B (ISO 32000-2) – hash used by revision 6. */
function hashR6(password, salt, udata) {
  let k = sha('sha256', password, salt, udata);
  for (let i = 0; ; i++) {
    const k1 = Buffer.concat([password, k, udata]);
    const block = Buffer.concat(Array(64).fill(k1));
    const e = aesNoPad(k.subarray(0, 16), block, false, k.subarray(16, 32));
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    const alg = ['sha256', 'sha384', 'sha512'][sum % 3];
    k = sha(alg, e);
    // The round number is the count of rounds done so far (i + 1).
    if (i >= 63 && e[e.length - 1] <= i + 1 - 32) break;
  }
  return k.subarray(0, 32);
}

const bytesOf = (v) => (v instanceof PDFString ? v.bytes : Buffer.alloc(0));

export class SecurityHandler {
  /**
   * @param {PDFDict} encrypt resolved /Encrypt dictionary
   * @param {Buffer} id0 first element of the trailer /ID
   * @param {string} password user or owner password
   * @param {(v:any)=>any} resolve
   */
  constructor(encrypt, id0, password, resolve = (v) => v) {
    this.dict = encrypt;
    const filter = resolve(encrypt.get('Filter'));
    if (!(filter instanceof PDFName) || filter.name !== 'Standard') {
      throw new PDFPasswordError(`Unsupported security handler: ${filter && filter.name}`);
    }
    this.V = num(resolve(encrypt.get('V')), 0);
    this.R = num(resolve(encrypt.get('R')), 2);
    this.O = bytesOf(resolve(encrypt.get('O')));
    this.U = bytesOf(resolve(encrypt.get('U')));
    this.P = num(resolve(encrypt.get('P')), 0) | 0;
    this.id0 = id0 || Buffer.alloc(0);
    const em = resolve(encrypt.get('EncryptMetadata'));
    this.encryptMetadata = em !== false;
    this.keyLength = this.V === 1 ? 5 : num(resolve(encrypt.get('Length')), this.V >= 4 ? 128 : 40) / 8;

    // Crypt filters (V4/V5).
    this.stmMethod = 'V2';
    this.strMethod = 'V2';
    if (this.V >= 4) {
      const cf = resolve(encrypt.get('CF'));
      const methodOf = (name) => {
        if (!name || name.name === 'Identity') return 'None';
        const f = cf instanceof PDFDict ? resolve(cf.get(name.name)) : null;
        if (!(f instanceof PDFDict)) return 'None';
        const cfm = resolve(f.get('CFM'));
        const len = num(resolve(f.get('Length')), 0);
        if (len) this.keyLength = len > 32 ? len / 8 : len; // Length is bytes in CF dicts (sometimes bits)
        if (cfm instanceof PDFName && cfm.name === 'AESV2') this.keyLength = 16;
        return cfm instanceof PDFName ? cfm.name : 'None';
      };
      this.stmMethod = methodOf(resolve(encrypt.get('StmF')));
      this.strMethod = methodOf(resolve(encrypt.get('StrF')));
    }
    if (this.V === 5 || this.R >= 5) this.keyLength = 32;

    const pw = Buffer.from(password || '', this.R >= 5 ? 'utf8' : 'latin1');
    const key = this.R >= 5 ? this.#authenticateR6(pw) : this.#authenticateLegacy(pw);
    if (!key) throw new PDFPasswordError('Incorrect password');
    this.key = key;
  }

  // ---- key derivation --------------------------------------------------------

  #computeKey(pw) {
    const p = Buffer.alloc(4);
    p.writeInt32LE(this.P);
    const parts = [padPassword(pw), this.O.subarray(0, 32), p, this.id0];
    if (this.R >= 4 && !this.encryptMetadata) parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    let h = md5(...parts);
    const n = this.R === 2 ? 5 : this.keyLength;
    if (this.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    return h.subarray(0, n);
  }

  #checkUser(key) {
    if (this.R === 2) {
      return rc4(key, PAD).equals(this.U.subarray(0, 32));
    }
    let x = rc4(key, md5(PAD, this.id0));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return x.subarray(0, 16).equals(this.U.subarray(0, 16));
  }

  #authenticateLegacy(pw) {
    // Try as user password.
    let key = this.#computeKey(pw);
    if (this.#checkUser(key)) {
      this.isOwner = false;
      return key;
    }
    // Try as owner password: recover the user password from /O.
    let h = md5(padPassword(pw));
    const n = this.R === 2 ? 5 : this.keyLength;
    if (this.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const okey = h.subarray(0, n);
    let user;
    if (this.R === 2) user = rc4(okey, this.O.subarray(0, 32));
    else {
      user = Buffer.from(this.O.subarray(0, 32));
      for (let i = 19; i >= 0; i--) user = rc4(okey.map((b) => b ^ i), user);
    }
    key = this.#computeKey(user);
    if (this.#checkUser(key)) {
      this.isOwner = true;
      return key;
    }
    return null;
  }

  #authenticateR6(pw) {
    pw = pw.subarray(0, 127);
    const hash = (p, salt, u) => (this.R === 5 ? sha('sha256', p, salt, u) : hashR6(p, salt, u));
    const U = this.U, O = this.O;
    const OE = bytesOf(this.dict.get('OE'));
    const UE = bytesOf(this.dict.get('UE'));
    const u48 = U.subarray(0, 48);
    // Owner?
    if (hash(pw, O.subarray(32, 40), u48).equals(O.subarray(0, 32))) {
      this.isOwner = true;
      return aesNoPad(hash(pw, O.subarray(40, 48), u48), OE.subarray(0, 32), true);
    }
    if (hash(pw, U.subarray(32, 40), Buffer.alloc(0)).equals(U.subarray(0, 32))) {
      this.isOwner = false;
      return aesNoPad(hash(pw, U.subarray(40, 48), Buffer.alloc(0)), UE.subarray(0, 32), true);
    }
    return null;
  }

  // ---- per-object encryption ---------------------------------------------------

  #objectKey(n, g, aes) {
    if (this.R >= 5) return this.key;
    const parts = [
      this.key,
      Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff]),
    ];
    if (aes) parts.push(Buffer.from('sAlT', 'latin1'));
    return md5(...parts).subarray(0, Math.min(this.key.length + 5, 16));
  }

  #apply(method, n, g, data, decrypt) {
    switch (method) {
      case 'None':
      case 'Identity':
        return data;
      case 'AESV2':
      case 'AESV3': {
        const k = this.#objectKey(n, g, true);
        return decrypt ? aesDecrypt(k, data) : aesEncrypt(k, data);
      }
      default: // V2 / RC4
        return rc4(this.#objectKey(n, g, false), data);
    }
  }

  decryptString(n, g, bytes) {
    return this.#apply(this.strMethod, n, g, bytes, true);
  }

  decryptStream(n, g, bytes) {
    return this.#apply(this.stmMethod, n, g, bytes, true);
  }

  encryptString(n, g, bytes) {
    return this.#apply(this.strMethod, n, g, bytes, false);
  }

  encryptStream(n, g, bytes) {
    return this.#apply(this.stmMethod, n, g, bytes, false);
  }
}

// ---- creating encryption (AES-256, revision 6) ---------------------------------------------

/** Permission flags for createEncryption (ISO 32000-2, Table 22). */
export const PERMISSIONS = {
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  extractForAccessibility: 1 << 9,
  assemble: 1 << 10,
  printHighQuality: 1 << 11,
};

/**
 * Builds a Standard security handler dictionary for AES-256 (V5/R6).
 * @param {{ userPassword?: string, ownerPassword?: string, permissions?: Partial<Record<keyof PERMISSIONS, boolean>> }} opts
 * @returns {PDFDict}
 */
export function createEncryptionDict({ userPassword = '', ownerPassword, permissions = {} } = {}) {
  const upw = Buffer.from(userPassword, 'utf8').subarray(0, 127);
  const opw = Buffer.from(ownerPassword ?? crypto.randomBytes(16).toString('hex'), 'utf8').subarray(0, 127);
  const fileKey = crypto.randomBytes(32);

  const uVal = crypto.randomBytes(8), uKey = crypto.randomBytes(8);
  const U = Buffer.concat([hashR6(upw, uVal, Buffer.alloc(0)), uVal, uKey]);
  const UE = aesNoPad(hashR6(upw, uKey, Buffer.alloc(0)), fileKey, false);
  const oVal = crypto.randomBytes(8), oKey = crypto.randomBytes(8);
  const O = Buffer.concat([hashR6(opw, oVal, U), oVal, oKey]);
  const OE = aesNoPad(hashR6(opw, oKey, U), fileKey, false);

  let P = 0xfffff0c0 | 0; // reserved bits set
  for (const [name, bit] of Object.entries(PERMISSIONS)) if (permissions[name] !== false) P |= bit;
  P |= 0;
  const perms = Buffer.alloc(16);
  perms.writeInt32LE(P, 0);
  perms.writeUInt32LE(0xffffffff, 4);
  perms.write('Tadb', 8, 'latin1');
  crypto.randomBytes(4).copy(perms, 12);
  const c = crypto.createCipheriv('aes-256-ecb', fileKey, null);
  c.setAutoPadding(false);
  const Perms = Buffer.concat([c.update(perms), c.final()]);

  const name = (n) => PDFName.of(n);
  const stdCF = new PDFDict().set('AuthEvent', name('DocOpen')).set('CFM', name('AESV3')).set('Length', 32);
  return new PDFDict()
    .set('Filter', name('Standard'))
    .set('V', 5)
    .set('R', 6)
    .set('Length', 256)
    .set('CF', new PDFDict().set('StdCF', stdCF))
    .set('StmF', name('StdCF'))
    .set('StrF', name('StdCF'))
    .set('O', new PDFString(O, true))
    .set('U', new PDFString(U, true))
    .set('OE', new PDFString(OE, true))
    .set('UE', new PDFString(UE, true))
    .set('P', P)
    .set('Perms', new PDFString(Perms, true))
    .set('EncryptMetadata', true);
}
