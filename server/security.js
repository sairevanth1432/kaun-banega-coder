// Hashing, tokens, TOTP (authenticator apps) and NIAT ID normalisation. Copied from saturday-sprint/server/security.js.
import crypto from 'node:crypto';
import { config } from './config.js';

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- passwords (scrypt)
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), h.toString('base64')].join('$');
}
export function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(want, got);
}
export function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  return null;
}
export function generatePassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += A[crypto.randomInt(A.length)];
  return s.replace(/(.{4})(?!$)/g, '$1-') + crypto.randomInt(10);
}

// ---------- TOTP, RFC 6238 (Google Authenticator, Microsoft Authenticator, Authy…)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    val = (val << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
export const totpStep = (t = Date.now()) => Math.floor(t / 30000);
export const totpAt = (secret, step) => hotp(secret, step);
// Returns the matched time step (to block replays) or 0 when the code is wrong. Allows ±1 step of clock drift.
export function verifyTotp(secret, code, lastStep = 0) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 0;
  const now = totpStep();
  for (const s of [now, now - 1, now + 1]) if (s > lastStep && safeEqual(hotp(secret, s), code)) return s;
  return 0;
}
export const otpauthUri = (secret, email) =>
  'otpauth://totp/' + encodeURIComponent(config.appName + ' Admin:' + email) +
  '?secret=' + secret + '&issuer=' + encodeURIComponent(config.appName + ' Admin') + '&algorithm=SHA1&digits=6&period=30';

// ---------- normalisation
export const normRoll = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
export const validRoll = (s) => /^[A-Z0-9][A-Z0-9_\-/.]{1,39}$/.test(s);

export function maskRoll(roll) {
  const r = String(roll || '');
  if (r.length <= 5) return r.slice(0, 1) + '•••' + r.slice(-1);
  if (r.length >= 10) return r.slice(0, 4) + '•••' + r.slice(-4); // NIAT IDs: N26P•••0001 (last 4 tell students apart)
  return r.slice(0, 4) + '•••' + r.slice(-2);
}

