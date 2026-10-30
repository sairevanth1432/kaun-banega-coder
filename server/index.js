// Kaun Banega Coder server: player API (server-checked game), admin API (question bank, imports, ladder, events,
// analytics) and the pages. Structure follows saturday-sprint/server/index.js.
import path from 'node:path';
import express from 'express';
import compression from 'compression';
import QRCode from 'qrcode';
import { config, ROOT } from './config.js';
import { ready, one, all, run, audit, parseJSON, dbKind } from './db.js';
import * as kv from './kv.js';
import {
  AuthError, loadStudent, loadAdmin, endSession, revokeSessions, cleanupExpired, nameLogin, forgetSessions,
  adminPasswordLogin, adminTotpLogin, finishTotpSetup
} from './auth.js';
import { hashPassword, verifyPassword, passwordProblem, generatePassword, newTotpSecret, otpauthUri } from './security.js';
import { getLadder, saveLadder, publicLadder, LadderError, LIFELINES } from './ladder.js';
import { BankError, listQuestions, getQuestion, addQuestion, updateQuestion, deleteQuestion, setStatus, versions, poolSizes, bumpRev, questionAt } from './bank.js';
import { importBank, listImports, templateCSV, exportBankCSV } from './importer.js';
import { GameError, BADGES, startGame, getGame, answer, nextQuestion, lifeline, quit, fffStart, fffSubmit, profile, history, leaderboard, boardRows } from './game.js';
import { EventError, listEvents, getEvent, createEvent, updateEvent, endEventNow, deleteEvent, playerEvents } from './events.js';
import { FffError, listFff, addFff, updateFff, deleteFff } from './fff.js';
import { questionStats, overview, FLAG_LABELS } from './stats.js';
import { importRoster } from './roster.js';
import { BinError, listBin, restoreItem, purgeItem } from './recycle.js';
import { toCSV } from './sheets.js';
import { R1Error, getState, saveState, ping, fame, logEvents, feedbackRows } from './r1.js';

const PUBLIC = path.join(ROOT, 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(compression({ threshold: 1024 }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
app.use(express.json({ limit: '12mb' }));   // a 20,000-row Excel import, base64-encoded, fits

// CSRF defence: state-changing requests must come from this site (cookies are also SameSite=Lax).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: 'BAD_ORIGIN', message: 'Cross-site request blocked.' });
  }
  if (Number(req.headers['content-length'] || 0) > 0 && !req.is('application/json')) return res.status(415).json({ error: 'JSON_ONLY', message: 'Send JSON.' });
  next();
});
app.use(async (req, res, next) => { await ready(); next(); });
const noStore = (res) => res.set('Cache-Control', 'no-store');

// ===================================================================== pages
const sendPage = (file) => (req, res) => { noStore(res); res.sendFile(path.join(PUBLIC, file)); };
app.get('/', async (req, res) => ((await loadStudent(req)) ? sendPage('play.html')(req, res) : res.redirect('/login')));
app.get('/login', async (req, res) => ((await loadStudent(req)) ? res.redirect('/') : sendPage('login.html')(req, res)));
app.get('/admin', sendPage('admin.html'));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(PUBLIC, { index: false, extensions: [], setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// ===================================================================== player API
const api = express.Router();
app.use('/api', api);

api.get('/health', async (req, res) => {
  noStore(res);
  await one('SELECT 1 AS ok');
  res.json({ ok: true, db: dbKind(), redis: kv.kvKind });
});

api.post('/auth/name-login', async (req, res) => {
  const u = await nameLogin(req, res, req.body && req.body.rollNo, req.body && req.body.name);
  res.json({ ok: true, rollNo: u.roll_no });
});
api.post('/auth/logout', async (req, res) => { await endSession(req, res, 'student'); res.json({ ok: true }); });

async function player(req, res, next) {
  req.user = await loadStudent(req);
  if (!req.user) return res.status(401).json({ error: 'AUTH', message: 'Please log in.' });
  noStore(res);
  next();
}

api.get('/bootstrap', player, async (req, res) => {
  const ladder = await getLadder();
  const p = await profile(req.user.id);
  delete p.seen;
  const open = await one("SELECT id FROM kbc_games WHERE user_id = ? AND state = 'play' ORDER BY started_at DESC LIMIT 1", req.user.id);
  res.json({
    me: { rollNo: req.user.roll_no, name: req.user.name, university: req.user.university },
    profile: p, history: await history(req.user.id), ladder: publicLadder(ladder), lifelines: LIFELINES, badges: BADGES,
    events: await playerEvents(), openGameId: open ? open.id : null, serverNow: Date.now()
  });
});
api.get('/profile', player, async (req, res) => {
  const p = await profile(req.user.id);
  delete p.seen;
  res.json({ profile: p, history: await history(req.user.id) });
});

// Per-player rate limit on game moves (a human needs a few seconds per question).
async function moveLimit(req, res, next) {
  const r = await kv.rateLimit('move:' + req.user.id, config.game.movesPerMinute, 60000);
  if (!r.ok) return res.status(429).json({ error: 'RATE_LIMIT', message: 'Slow down a little.' });
  next();
}
api.post('/fff/start', player, moveLimit, async (req, res) => res.json(await fffStart(req.user)));
api.post('/fff/submit', player, moveLimit, async (req, res) => res.json(await fffSubmit(req.user, req.body.runId, req.body.order)));
api.post('/game/start', player, moveLimit, async (req, res) => {
  const b = req.body || {};
  res.json(await startGame(req.user, { mode: b.mode, eventId: b.eventId, fffRunId: b.fffRunId, skill: b.skill }));
});
api.get('/game/:id', player, async (req, res) => res.json(await getGame(req.user, req.params.id)));
api.post('/game/:id/answer', player, moveLimit, async (req, res) => res.json(await answer(req.user, req.params.id, { rung: req.body.rung, pick: req.body.pick })));
api.post('/game/:id/next', player, moveLimit, async (req, res) => res.json(await nextQuestion(req.user, req.params.id)));
api.post('/game/:id/lifeline', player, moveLimit, async (req, res) => res.json(await lifeline(req.user, req.params.id, String(req.body.k || ''))));
api.post('/game/:id/quit', player, moveLimit, async (req, res) => res.json(await quit(req.user, req.params.id)));
api.get('/leaderboard', player, async (req, res) => {
  const eventId = String(req.query.event || '');
  if (eventId) {
    const e = await getEvent(eventId);
    if (!e) throw new EventError('NOT_FOUND', 'Event not found.', 404);
    if (!e.leaderboardVisible) return res.json({ hidden: true, rows: [], me: null, event: { id: e.id, title: e.title } });
    return res.json({ ...(await leaderboard(req.user, eventId)), event: { id: e.id, title: e.title, phase: e.phase } });
  }
  res.json(await leaderboard(req.user, ''));
});

// The student game (play.html): saved progress, live count, Hall of Fame, feedback and usage events.
api.get('/r1/state', player, async (req, res) => {
  const u = req.user;
  res.json({ me: { rollNo: u.roll_no, name: u.name, university: u.university || '' }, state: await getState(u.id), ...(await ping(u.id)) });
});
api.put('/r1/state', player, async (req, res) => res.json(await saveState(req.user.id, req.body && req.body.data)));
api.post('/r1/ping', player, async (req, res) => res.json(await ping(req.user.id)));
api.get('/r1/fame', player, async (req, res) => res.json(await fame(req.user, String(req.query.scope || 'all'), String(req.query.uni || ''))));
api.post('/r1/log', player, async (req, res) => {
  const r = await kv.rateLimit('r1log:' + req.user.id, 60, 60000);
  if (!r.ok) return res.status(429).json({ error: 'RATE_LIMIT', message: 'Slow down a little.' });
  res.json(await logEvents(req.user.id, req.body && req.body.events));
});

api.get('/cron/cleanup', async (req, res) => {
  if (config.cronSecret && req.get('authorization') !== 'Bearer ' + config.cronSecret) return res.status(401).json({ error: 'AUTH' });
  await cleanupExpired();
  res.json({ ok: true });
});

// ===================================================================== admin auth (from saturday-sprint)
const adm = express.Router();
api.use('/admin', adm);
adm.use((req, res, next) => { noStore(res); next(); });

adm.post('/login', async (req, res) => res.json(await adminPasswordLogin(req, res, req.body.email, req.body.password)));
adm.post('/login/totp', async (req, res) => { await adminTotpLogin(req, res, req.body.code); res.json({ ok: true }); });
adm.post('/logout', async (req, res) => { await endSession(req, res, 'admin'); res.json({ ok: true }); });
adm.get('/totp/setup', async (req, res) => {
  const a = await loadAdmin(req, { allowStage: 'setup' });
  if (!a) throw new AuthError('AUTH', 'Please log in.', 401);
  const row = await one('SELECT totp_secret, totp_enabled FROM admins WHERE id = ?', a.id);
  if (row.totp_enabled) throw new AuthError('ALREADY', 'Authenticator already set up.', 409);
  let secret = row.totp_secret;
  if (!secret) { secret = newTotpSecret(); await run('UPDATE admins SET totp_secret = ? WHERE id = ?', secret, a.id); }
  const uri = otpauthUri(secret, a.email);
  res.json({ secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) });
});
adm.post('/totp/enable', async (req, res) => {
  const a = await finishTotpSetup(req, res, req.body.code);
  await audit({ admin: a, ip: req.ip }, 'admin.totp_enabled', a.email, null);
  res.json({ ok: true });
});

async function requireAdmin(req, res, next) {
  const a = await loadAdmin(req);
  if (!a) return res.status(401).json({ error: 'AUTH', message: 'Please log in.' });
  req.admin = a;
  next();
}
const requireSuper = (req, res, next) => (req.admin.role === 'super_admin' ? next() : res.status(403).json({ error: 'FORBIDDEN', message: 'Super admin only.' }));

adm.get('/me', requireAdmin, (req, res) => {
  const a = req.admin;
  res.json({ id: a.id, email: a.email, name: a.name, role: a.role, mustChangePw: a.mustChangePw, totpEnabled: a.totpEnabled, totpRequired: config.admin.requireTotp });
});
adm.post('/password', requireAdmin, async (req, res) => {
  const row = await one('SELECT password_hash FROM admins WHERE id = ?', req.admin.id);
  if (!verifyPassword(String(req.body.current || ''), row.password_hash)) throw new AuthError('BAD_LOGIN', 'Current password is wrong.', 400);
  const p = passwordProblem(req.body.next);
  if (p) throw new AuthError('WEAK_PASSWORD', p, 400);
  await run('UPDATE admins SET password_hash = ?, must_change_pw = 0 WHERE id = ?', hashPassword(req.body.next), req.admin.id);
  await run("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ? AND token_hash != ?", req.admin.id, req.admin.session);
  await audit(req, 'admin.password_changed', req.admin.email);
  res.json({ ok: true });
});

adm.use(requireAdmin);
const who = (req) => req.admin.email;

// ---------- overview
adm.get('/feedback', async (req, res) => res.json({ rows: await feedbackRows() }));
adm.get('/overview', async (req, res) => {
  const [o, events] = await Promise.all([overview(), listEvents()]);
  res.json({ ...o, events: events.filter((e) => e.phase !== 'ended').slice(0, 5) });
});

// ---------- question bank
adm.get('/questions', async (req, res) => res.json(await listQuestions(req.query)));
adm.get('/questions/:id', async (req, res) => res.json({ question: await getQuestion(req.params.id), versions: await versions(req.params.id) }));
adm.post('/questions', async (req, res) => {
  const r = await addQuestion(req.body || {}, who(req));
  await audit(req, 'question.created', r.id, { extId: req.body.ext_id });
  res.json({ ok: true, ...r });
});
adm.put('/questions/:id', async (req, res) => {
  const r = await updateQuestion(req.params.id, req.body || {}, who(req));
  await audit(req, 'question.updated', req.params.id, { result: r.result });
  res.json({ ok: true, ...r });
});
adm.post('/questions/bulk-status', async (req, res) => {
  const status = String(req.body.status || '');
  if ((status === 'published' || status === 'retired') && req.admin.role !== 'super_admin' && !(await reviewersMayPublish()))
    throw new AuthError('FORBIDDEN', 'Only a super admin can publish or retire questions.', 403);
  const n = await setStatus(req.body.ids, status, who(req));
  await audit(req, 'question.status', status, { ids: (req.body.ids || []).slice(0, 200), changed: n });
  res.json({ ok: true, changed: n });
});
adm.delete('/questions/:id', async (req, res) => {
  await deleteQuestion(req.params.id, who(req));
  await audit(req, 'question.deleted', req.params.id);
  res.json({ ok: true });
});
async function reviewersMayPublish() { return !!(await one("SELECT value FROM settings WHERE key = 'admins_may_publish' AND value = 'true'")); }

// ---------- import
adm.get('/import/template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kbc-question-template.csv"' });
  res.send('﻿' + templateCSV());
});
adm.post('/import/questions', async (req, res) => {
  const b = req.body || {};
  const dry = b.dry !== false;
  if (!dry && b.asDraft !== true && req.admin.role !== 'super_admin' && !(await reviewersMayPublish()))
    throw new AuthError('FORBIDDEN', 'Import as drafts, or ask a super admin to publish directly.', 403);
  const r = await importBank(b.xlsxBase64 ? { xlsxBase64: b.xlsxBase64 } : { csv: b.csv || '' }, { dry, asDraft: !!b.asDraft, filename: b.filename, by: who(req) });
  if (!dry && r.ok) await audit(req, 'import.questions', b.filename, { add: r.add, update: r.update, errors: r.errors.length });
  res.json(r);
});
adm.get('/imports', async (req, res) => res.json({ rows: await listImports() }));

// ---------- FFF puzzles
adm.get('/fff', async (req, res) => res.json({ rows: await listFff() }));
adm.post('/fff', async (req, res) => { const id = await addFff(req.body || {}, who(req)); await audit(req, 'fff.created', id); res.json({ ok: true, id }); });
adm.put('/fff/:id', async (req, res) => { await updateFff(req.params.id, req.body || {}, who(req)); await audit(req, 'fff.updated', req.params.id); res.json({ ok: true }); });
adm.delete('/fff/:id', async (req, res) => { await deleteFff(req.params.id, who(req)); await audit(req, 'fff.deleted', req.params.id); res.json({ ok: true }); });

// ---------- ladder & pools
adm.get('/ladder', async (req, res) => {
  const ladder = await getLadder();
  res.json({ ladder, poolSizes: await poolSizes(ladder), lifelines: LIFELINES });
});
adm.put('/ladder', requireSuper, async (req, res) => {
  const ladder = await saveLadder(req.body && req.body.ladder);
  await bumpRev();
  await audit(req, 'ladder.updated', null, { openRungs: ladder.openRungs });
  res.json({ ok: true, ladder, poolSizes: await poolSizes(ladder) });
});

// ---------- events
adm.get('/events', async (req, res) => res.json({ rows: await listEvents() }));
adm.get('/events/:id', async (req, res) => {
  const e = await getEvent(req.params.id);
  if (!e) throw new EventError('NOT_FOUND', 'Event not found.', 404);
  const games = Number((await one('SELECT COUNT(*) AS n FROM kbc_games WHERE event_id = ?', e.id)).n);
  res.json({ event: { ...e, games }, board: await boardRows(e.id, 500) });
});
adm.post('/events', requireSuper, async (req, res) => { const e = await createEvent(req.body || {}, who(req)); await audit(req, 'event.created', e.id); res.json({ ok: true, event: e }); });
adm.put('/events/:id', requireSuper, async (req, res) => { const e = await updateEvent(req.params.id, req.body || {}); await audit(req, 'event.updated', e.id); res.json({ ok: true, event: e }); });
adm.post('/events/:id/end', requireSuper, async (req, res) => { const e = await endEventNow(req.params.id); await audit(req, 'event.ended', e.id); res.json({ ok: true, event: e }); });
adm.delete('/events/:id', requireSuper, async (req, res) => { await deleteEvent(req.params.id, who(req)); await audit(req, 'event.deleted', req.params.id); res.json({ ok: true }); });

// ---------- games & leaderboards
adm.get('/games', async (req, res) => {
  const where = [], p = [];
  if (req.query.event != null && req.query.event !== 'all') { where.push('g.event_id = ?'); p.push(String(req.query.event)); }
  if (req.query.q) { where.push('(u.roll_no ILIKE ? OR m.name ILIKE ?)'); p.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  if (req.query.mode) { where.push('g.mode = ?'); p.push(String(req.query.mode)); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const size = Math.min(200, Number(req.query.size) || 50), page = Math.max(1, Number(req.query.page) || 1);
  const total = Number((await one(`SELECT COUNT(*) AS n FROM kbc_games g JOIN users u ON u.id = g.user_id JOIN students_master m ON m.roll_no = u.roll_no ${W}`, ...p)).n);
  const rows = await all(`SELECT g.id, g.mode, g.event_id, g.state, g.reason, g.amount, g.correct, g.coins, g.secs, g.fff_secs, g.used, g.hidden, g.started_at, g.ended_at,
                                 u.roll_no, m.name, m.university FROM kbc_games g JOIN users u ON u.id = g.user_id JOIN students_master m ON m.roll_no = u.roll_no
                          ${W} ORDER BY g.started_at DESC LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  res.json({ total, page, size, rows: rows.map((r) => ({ ...r, amount: Number(r.amount), coins: Number(r.coins), used: Object.keys(parseJSON(r.used, {})), started_at: Number(r.started_at), ended_at: r.ended_at && Number(r.ended_at) })) });
});
adm.get('/games/:id', async (req, res) => {
  const g = await one('SELECT g.*, u.roll_no, m.name FROM kbc_games g JOIN users u ON u.id = g.user_id JOIN students_master m ON m.roll_no = u.roll_no WHERE g.id = ?', req.params.id);
  if (!g) throw new GameError('NOT_FOUND', 'Game not found.', 404);
  const answers = [];
  for (const a of await all('SELECT * FROM kbc_answers WHERE game_id = ? ORDER BY rung', g.id)) {
    const q = await questionAt(Number(a.qid), a.version);
    answers.push({ rung: a.rung, qid: Number(a.qid), version: a.version, q: q.q, code: q.code, options: q.options, correct: q.correct, pick: a.pick, ok: !!a.ok, ms: a.ms, lifelines: parseJSON(a.lifelines, []) });
  }
  res.json({ game: { id: g.id, rollNo: g.roll_no, name: g.name, mode: g.mode, eventId: g.event_id, state: g.state, reason: g.reason, amount: Number(g.amount), correct: g.correct,
    coins: Number(g.coins), secs: g.secs, fffSecs: g.fff_secs, used: parseJSON(g.used, {}), hidden: !!g.hidden, startedAt: Number(g.started_at), endedAt: g.ended_at && Number(g.ended_at) }, answers });
});
adm.patch('/games/:id', requireSuper, async (req, res) => {
  const g = await one('UPDATE kbc_games SET hidden = ? WHERE id = ? RETURNING event_id', req.body.hidden ? 1 : 0, req.params.id);
  if (!g) throw new GameError('NOT_FOUND', 'Game not found.', 404);
  await kv.invalidate('kbc:board:' + (g.event_id || ''));
  await audit(req, req.body.hidden ? 'game.hidden' : 'game.unhidden', req.params.id);
  res.json({ ok: true });
});
adm.get('/leaderboard', async (req, res) => res.json({ rows: await boardRows(String(req.query.event || ''), 200) }));

// ---------- analytics
adm.get('/stats/questions', async (req, res) => res.json({ ...(await questionStats(req.query)), labels: FLAG_LABELS }));

// ---------- players & roster
adm.get('/players', async (req, res) => {
  const q = String(req.query.q || '').trim(), p = [];
  let W = '';
  if (q) { W = 'WHERE m.roll_no ILIKE ? OR m.name ILIKE ? OR u.display_name ILIKE ?'; p.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const size = Math.min(200, Number(req.query.size) || 50), page = Math.max(1, Number(req.query.page) || 1);
  const total = Number((await one(`SELECT COUNT(*) AS n FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no ${W}`, ...p)).n);
  const rows = await all(`SELECT m.roll_no, m.name, m.batch, m.university, m.active, u.id AS user_id, u.display_name, u.status, u.last_login_at,
                                 pr.coins, pr.games, pr.best, pr.best_reached
                          FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no LEFT JOIN kbc_profiles pr ON pr.user_id = u.id
                          ${W} ORDER BY COALESCE(pr.coins, -1) DESC, m.roll_no LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  res.json({ total, page, size, rows: rows.map((r) => ({ ...r, user_id: r.user_id && Number(r.user_id), coins: Number(r.coins || 0), best: Number(r.best || 0), last_login_at: r.last_login_at && Number(r.last_login_at) })) });
});
adm.patch('/players/:userId', async (req, res) => {
  const id = Number(req.params.userId), u = await one('SELECT * FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'NOT_FOUND', message: 'Player not found.' });
  const b = req.body || {};
  if (b.displayName != null) await run('UPDATE users SET display_name = ? WHERE id = ?', String(b.displayName).trim().slice(0, 40), id);
  if (b.status) {
    if (req.admin.role !== 'super_admin') throw new AuthError('FORBIDDEN', 'Super admin only.', 403);
    await run('UPDATE users SET status = ? WHERE id = ?', b.status === 'disabled' ? 'disabled' : 'active', id);
    if (b.status === 'disabled') await revokeSessions('student', id);
  }
  if (b.resetProfile) {
    if (req.admin.role !== 'super_admin') throw new AuthError('FORBIDDEN', 'Super admin only.', 403);
    await run('DELETE FROM kbc_profiles WHERE user_id = ?', id);
  }
  forgetSessions();
  for (const k of ['kbc:board:', ...(await all('SELECT id FROM kbc_events')).map((e) => 'kbc:board:' + e.id)]) await kv.invalidate(k);
  await audit(req, 'player.updated', u.roll_no, b);
  res.json({ ok: true });
});
adm.post('/roster/import', requireSuper, async (req, res) => {
  const b = req.body || {};
  const r = await importRoster(b.xlsxBase64 ? { xlsxBase64: b.xlsxBase64 } : { csv: b.csv || '' }, { mode: b.mode === 'replace' ? 'replace' : 'merge', dry: b.dry !== false });
  if (r.ok && !r.dry) await audit(req, 'roster.imported', b.filename, { added: r.added, updated: r.updated, deactivated: r.deactivated });
  res.json(r);
});

// ---------- exports (CSV)
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : '');
adm.get('/export/:what', async (req, res) => {
  let name, body;
  if (req.params.what === 'bank.csv') { name = 'kbc-question-bank.csv'; body = await exportBankCSV(); }
  else if (req.params.what === 'leaderboard.csv') {
    const ev = String(req.query.event || '');
    name = `kbc-leaderboard-${ev || 'classic'}.csv`;
    body = toCSV(['rank', 'niat_id', 'name', 'university', 'amount', 'reached', 'secs', 'at'], (await boardRows(ev, 100000)).map((r) => ({ ...r, niat_id: r.rollNo, at: iso(r.at) })));
  } else if (req.params.what === 'questions-stats.csv') {
    name = 'kbc-question-stats.csv';
    const s = await questionStats({ size: 200000 });
    body = toCSV(['ext_id', 'checkpoint', 'skill', 'difficulty', 'n', 'pct', 'avg_sec', 'pick_a', 'pick_b', 'pick_c', 'pick_d', 'correct', 'flags'],
      s.rows.map((r) => ({ ext_id: r.extId, checkpoint: r.checkpoint, skill: r.skill, difficulty: r.difficulty, n: r.n, pct: r.pct, avg_sec: r.avgSec,
        pick_a: r.picks[0], pick_b: r.picks[1], pick_c: r.picks[2], pick_d: r.picks[3], correct: 'ABCD'[r.correct], flags: r.flags.join(' ') })));
  } else return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown export.' });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  res.send('﻿' + body);
});

// ---------- recycle bin, audit
adm.get('/bin', async (req, res) => res.json({ rows: await listBin() }));
adm.post('/bin/:id/restore', requireSuper, async (req, res) => {
  const r = await restoreItem(req.params.id, { changed: async (kind) => { if (kind === 'question') await bumpRev(); } });
  await audit(req, 'bin.restored', req.params.id, r);
  res.json({ ok: true, ...r });
});
adm.delete('/bin/:id', requireSuper, async (req, res) => {
  const r = await purgeItem(req.params.id);
  await audit(req, 'bin.deleted_forever', req.params.id, r);
  res.json({ ok: true, ...r });
});
adm.get('/audit', async (req, res) => {
  res.json({ rows: (await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500')).map((r) => ({ ...r, created_at: Number(r.created_at), detail: parseJSON(r.detail) })) });
});

// ---------- settings & admins (super admin)
adm.get('/settings', async (req, res) => res.json({ adminsMayPublish: await reviewersMayPublish() }));
adm.patch('/settings', requireSuper, async (req, res) => {
  if (req.body.adminsMayPublish != null)
    await run("INSERT INTO settings (key, value) VALUES ('admins_may_publish', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", req.body.adminsMayPublish ? 'true' : 'false');
  await audit(req, 'settings.updated', null, req.body);
  res.json({ ok: true });
});
adm.get('/admins', requireSuper, async (req, res) => {
  res.json({ rows: await all('SELECT id, email, name, role, status, totp_enabled, must_change_pw, created_at, last_login_at, locked_until FROM admins ORDER BY id') });
});
adm.post('/admins', requireSuper, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('BAD_EMAIL', 'Enter a valid email.', 400);
  if (await one('SELECT 1 AS x FROM admins WHERE email = ?', email)) throw new AuthError('EXISTS', 'An admin with that email exists.', 409);
  const role = req.body.role === 'super_admin' ? 'super_admin' : 'admin';
  const temp = generatePassword();
  await run('INSERT INTO admins (email, name, role, password_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    email, String(req.body.name || '').trim().slice(0, 80), role, hashPassword(temp), Date.now());
  await audit(req, 'admin.created', email, { role });
  res.json({ ok: true, tempPassword: temp });
});
adm.patch('/admins/:id', requireSuper, async (req, res) => {
  const id = Number(req.params.id), a = await one('SELECT * FROM admins WHERE id = ?', id);
  if (!a) return res.status(404).json({ error: 'NOT_FOUND', message: 'Admin not found.' });
  const out = { ok: true };
  if (id === req.admin.id && (req.body.status === 'disabled' || req.body.role === 'admin')) throw new AuthError('SELF', 'You cannot disable or demote yourself.', 400);
  if (req.body.role) await run('UPDATE admins SET role = ? WHERE id = ?', req.body.role === 'super_admin' ? 'super_admin' : 'admin', id);
  if (req.body.status) {
    await run('UPDATE admins SET status = ? WHERE id = ?', req.body.status === 'disabled' ? 'disabled' : 'active', id);
    if (req.body.status === 'disabled') await revokeSessions('admin', id);
  }
  if (req.body.resetPassword) {
    out.tempPassword = generatePassword();
    await run('UPDATE admins SET password_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = 0 WHERE id = ?', hashPassword(out.tempPassword), id);
    await revokeSessions('admin', id);
  }
  if (req.body.resetTotp) { await run('UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?', id); await revokeSessions('admin', id); }
  if (req.body.unlock) await run('UPDATE admins SET failed_logins = 0, locked_until = 0 WHERE id = ?', id);
  await audit(req, 'admin.updated', a.email, { role: req.body.role, status: req.body.status, resetPassword: !!req.body.resetPassword, resetTotp: !!req.body.resetTotp, unlock: !!req.body.unlock });
  res.json(out);
});

// ===================================================================== errors
api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such API route.' }));
const KNOWN = [AuthError, BankError, GameError, EventError, FffError, LadderError, BinError, R1Error];
app.use((err, req, res, next) => {
  if (KNOWN.some((K) => err instanceof K)) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: 'Invalid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: 'Upload too large.' });
  const ref = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  console.error('[http]', ref, req.method, req.originalUrl, err);
  res.status(500).json({ error: 'SERVER', message: 'Something went wrong. Please try again.', ref });
});

// ===================================================================== local server
export async function start() {
  await ready();
  const c = setInterval(() => cleanupExpired().catch(() => {}), 3600000);
  c.unref();
  const server = app.listen(config.port, config.host);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Stop the other server or set PORT in server/.env.\n`);
    else console.error('[server]', e.message);
    process.exit(1);
  });
  server.on('listening', async () => {
    const admins = Number((await one('SELECT COUNT(*) AS n FROM admins')).n);
    const qs = Number((await one("SELECT COUNT(*) AS n FROM kbc_questions WHERE status = 'published'")).n);
    console.log(`\n  ${config.appName} running at http://localhost:${server.address().port}`);
    console.log(`  Players: /login   Admin: /admin   Database: ${dbKind()}   Redis: ${kv.kvKind}   Published questions: ${qs}`);
    if (!admins) console.log('  No admin yet. Create one:  npm run create-admin -- --email you@example.com --name "Your Name" --super');
    if (!qs) console.log('  No questions yet. Load the starter set:  npm run seed');
    console.log('');
  });
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

export { app };
export default app;
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'index.js')) start();
