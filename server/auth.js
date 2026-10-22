// Sessions (httpOnly cookies), student NIAT ID + name login and admin password → authenticator login.
// Adapted from saturday-sprint/server/auth.js (the OTP/phone registration flow is not used here).
import { config } from './config.js';
import { one, all, run } from './db.js';
import * as kv from './kv.js';
import { randomToken, sha256, normRoll, validRoll, verifyPassword, verifyTotp } from './security.js';

export const STUDENT_COOKIE = 'kbc_session';
export const ADMIN_COOKIE = 'kbc_admin';

export class AuthError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

// ---------- cookies & sessions
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) bits.push('Max-Age=' + Math.max(0, Math.floor(maxAgeMs / 1000)));
  if (config.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// Resolved student sessions are cached per instance for 30 s, so most game requests skip the sessions table.
const SESSION_CACHE_MS = 30000;
const sessionCache = new Map();
function cacheSet(k, v) { if (sessionCache.size > 50000) sessionCache.clear(); sessionCache.set(k, { at: Date.now(), v }); }
export const forgetSessions = () => sessionCache.clear();

export async function createSession(req, res, kind, subjectId, { stage = 'full', ttlMs } = {}) {
  const token = randomToken(), now = Date.now();
  const ttl = ttlMs || (kind === 'admin' ? config.session.adminMs : config.session.studentMs);
  await run('INSERT INTO sessions (token_hash, kind, subject_id, stage, created_at, expires_at, last_seen_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token), kind, subjectId, stage, now, now + ttl, now, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(res, kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE, token, ttl);
  return token;
}

async function readSession(req, kind) {
  const token = parseCookies(req)[kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = await one('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', hash, kind);
  if (!s) return null;
  const now = Date.now();
  if (Number(s.expires_at) < now) { await run('DELETE FROM sessions WHERE token_hash = ?', hash); return null; }
  if (now - Number(s.last_seen_at) > 600000) await run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, hash);
  return s;
}

export async function endSession(req, res, kind) {
  const name = kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE;
  const token = parseCookies(req)[name];
  if (token) {
    const hash = sha256(token);
    await run('DELETE FROM sessions WHERE token_hash = ?', hash);
    sessionCache.delete('student:' + hash);
  }
  setCookie(res, name, '', 0);
}

export async function revokeSessions(kind, subjectId) {
  await run('DELETE FROM sessions WHERE kind = ? AND subject_id = ?', kind, subjectId);
  forgetSessions();
}

export const cleanupExpired = () => run('DELETE FROM sessions WHERE expires_at < ?', Date.now());

export async function loadStudent(req) {
  const token = parseCookies(req)[STUDENT_COOKIE];
  if (!token) return null;
  const k = 'student:' + sha256(token);
  const hit = sessionCache.get(k);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.v;
  const s = await readSession(req, 'student');
  let v = null;
  if (s) {
    const u = await one(`SELECT u.*, m.name, m.batch, m.university, m.active AS master_active FROM users u
                         JOIN students_master m ON m.roll_no = u.roll_no WHERE u.id = ?`, s.subject_id);
    if (u && u.status === 'active' && u.master_active)
      v = { kind: 'student', id: Number(u.id), roll_no: u.roll_no, name: u.display_name || u.name, batch: u.batch, university: u.university };
  }
  cacheSet(k, v);
  return v;
}

// Admin sessions are never cached: every admin request is checked against the database.
export async function loadAdmin(req, { allowStage } = {}) {
  const s = await readSession(req, 'admin');
  if (!s) return null;
  if (s.stage !== 'full' && s.stage !== allowStage) return null;
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  if (!a || a.status !== 'active') return null;
  return { kind: 'admin', id: Number(a.id), email: a.email, name: a.name, role: a.role, stage: s.stage,
    totpEnabled: !!a.totp_enabled, mustChangePw: !!a.must_change_pw, session: s.token_hash };
}

async function limitOrThrow(key, limit, windowMs, message) {
  const r = await kv.rateLimit(key, limit, windowMs);
  if (!r.ok) throw new AuthError('RATE_LIMIT', message, 429, { retryAfterMs: r.retryAfterMs });
}

// ---------- students: NIAT ID + name as in the roster (saturday-sprint "simple" login mode)
// "Asha  K. Kumar" ≈ "asha k kumar" ≈ "Kumar Asha K": case, dots, extra spaces and word order do not matter.
export function nameKey(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}
export async function nameLogin(req, res, rawRoll, rawName) {
  const roll = normRoll(rawRoll);
  if (!validRoll(roll)) throw new AuthError('BAD_ROLL', 'Enter your NIAT ID.', 400);
  // generous per network (a whole campus can share one address), strict per NIAT ID
  await limitOrThrow('name-ip:' + req.ip, 3000, 15 * 60000, 'Too many log-ins from this network. Try again in a few minutes.');
  await limitOrThrow('name-roll:' + roll, 10, 15 * 60000, 'Too many attempts for this NIAT ID. Try again in 15 minutes.');
  const m = await one('SELECT * FROM students_master WHERE roll_no = ?', roll);
  const given = nameKey(rawName);
  if (!given) throw new AuthError('BAD_NAME', 'Enter your name as it is in the student list.', 400);
  if (!m || !m.active || (nameKey(m.name) && nameKey(m.name) !== given))
    throw new AuthError('BAD_LOGIN', 'That NIAT ID and name do not match the student list. Check the spelling, or ask your mentor.', 401);
  const now = Date.now();
  await run('INSERT INTO users (roll_no, status, created_at) VALUES (?, ?, ?) ON CONFLICT (roll_no) DO NOTHING', roll, 'active', now);
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  if (u.status !== 'active') throw new AuthError('ACCOUNT_DISABLED', 'This account is disabled. Contact your mentor.', 403);
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', now, u.id);
  await createSession(req, res, 'student', u.id);
  await run('INSERT INTO student_logins (roll_no, at, ip, ua) VALUES (?, ?, ?, ?)', roll, now, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200)).catch(() => {});
  return u;
}

// ---------- admins: password, then authenticator code (TOTP)
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

export async function adminPasswordLogin(req, res, rawEmail, password) {
  const email = String(rawEmail || '').trim().toLowerCase();
  await limitOrThrow('admin-ip:' + req.ip, 20, 900000, 'Too many login attempts. Try again in 15 minutes.');
  const a = await one('SELECT * FROM admins WHERE email = ?', email);
  const now = Date.now();
  if (a && Number(a.locked_until) > now) throw new AuthError('LOCKED', 'Account temporarily locked after failed attempts. Try again later.', 429);
  const ok = verifyPassword(String(password || ''), a ? a.password_hash : DUMMY_HASH);
  if (!a || !ok || a.status !== 'active') {
    if (a) {
      const fails = a.failed_logins + 1, lock = fails >= config.admin.maxFailedLogins;
      await run('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock ? now + config.admin.lockMs : 0, a.id);
    }
    throw new AuthError('BAD_LOGIN', 'Wrong email or password.', 401);
  }
  await run('UPDATE admins SET failed_logins = 0, locked_until = 0 WHERE id = ?', a.id);
  if (a.totp_enabled) { await createSession(req, res, 'admin', a.id, { stage: 'totp', ttlMs: 5 * 60000 }); return { next: 'totp' }; }
  if (config.admin.requireTotp) { await createSession(req, res, 'admin', a.id, { stage: 'setup', ttlMs: 15 * 60000 }); return { next: 'setup' }; }
  await run('UPDATE admins SET last_login_at = ? WHERE id = ?', now, a.id);
  await createSession(req, res, 'admin', a.id);
  return { next: 'done' };
}

export async function adminTotpLogin(req, res, code) {
  const s = await readSession(req, 'admin');
  if (!s || s.stage !== 'totp') throw new AuthError('SESSION', 'Your login expired. Start again.', 401);
  await limitOrThrow('admin-totp:' + s.subject_id, 10, 900000, 'Too many attempts. Try again in 15 minutes.');
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  const step = a && a.status === 'active' ? verifyTotp(a.totp_secret, code, Number(a.totp_last_step)) : 0;
  if (!step) throw new AuthError('BAD_CODE', 'Wrong or expired authenticator code.', 401);
  await run('UPDATE admins SET totp_last_step = ?, last_login_at = ? WHERE id = ?', step, Date.now(), a.id);
  await run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
  await createSession(req, res, 'admin', a.id);
}

export async function finishTotpSetup(req, res, code) {
  const s = await readSession(req, 'admin');
  if (!s || (s.stage !== 'setup' && s.stage !== 'full')) throw new AuthError('SESSION', 'Your login expired. Start again.', 401);
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  if (!a || !a.totp_secret) throw new AuthError('NO_SECRET', 'Start the authenticator setup first.', 400);
  const step = verifyTotp(a.totp_secret, code, Number(a.totp_last_step));
  if (!step) throw new AuthError('BAD_CODE', 'That code did not match. Check the time on your phone and try again.', 401);
  await run('UPDATE admins SET totp_enabled = 1, totp_last_step = ?, last_login_at = ? WHERE id = ?', step, Date.now(), a.id);
  await run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
  await createSession(req, res, 'admin', a.id);
  return { id: Number(a.id), email: a.email };
}

export const listSessions = (kind, id) => all('SELECT created_at, last_seen_at, ip, ua FROM sessions WHERE kind = ? AND subject_id = ?', kind, id);
