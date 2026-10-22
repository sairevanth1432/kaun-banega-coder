// The question bank: validation, CRUD, status workflow, versions and the per-rung pools the game draws from.
//   draft → review → published → retired. Only published questions are played.
//   Every content change saves a new version; a game keeps the qid + version it was dealt, so edits never
//   rewrite history (unlike saturday-sprint's "lock the set once anyone has started").
import crypto from 'node:crypto';
import { one, all, run, tx, getSetting, setSetting, parseJSON } from './db.js';
import * as kv from './kv.js';
import { getLadder, skillIds, checkpointIds } from './ladder.js';
import { binPut } from './recycle.js';

export const STATUSES = ['draft', 'review', 'published', 'retired'];
export const LIMITS = { q: 600, code: 1500, option: 200, hint: 400, why: 800, type: 40, tag: 40, tags: 10, extId: 64 };

export class BankError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

const s = (v) => (v == null ? '' : String(v)).replace(/\r\n?/g, '\n');
export const fingerprint = (q, code) => (s(q) + ' ' + s(code)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const autoExtId = (q, code) => 'auto-' + crypto.createHash('sha256').update(fingerprint(q, code)).digest('hex').slice(0, 12);

// Normalises one question. Returns { value, errors:[{field, msg}] }; never throws.
export function check(input, ladder) {
  const errors = [], err = (field, msg) => errors.push({ field, msg });
  const v = {};
  v.ext_id = s(input.ext_id).trim();
  if (v.ext_id.length > LIMITS.extId) err('ext_id', `ID is longer than ${LIMITS.extId} characters.`);
  if (v.ext_id && !/^[A-Za-z0-9_.:\-]+$/.test(v.ext_id)) err('ext_id', 'ID may only use letters, digits and _ . : -');
  v.checkpoint = s(input.checkpoint).trim().toUpperCase();
  if (!checkpointIds(ladder).has(v.checkpoint)) err('checkpoint', `Unknown checkpoint "${input.checkpoint ?? ''}". Use one of ${[...checkpointIds(ladder)].join(', ')}.`);
  v.skill = s(input.skill).trim().toUpperCase();
  if (v.skill && !skillIds(ladder).has(v.skill)) err('skill', `Unknown skill "${v.skill}".`);
  v.type = s(input.type).trim().slice(0, LIMITS.type);
  v.difficulty = Number(input.difficulty);
  if (!Number.isInteger(v.difficulty) || v.difficulty < 1 || v.difficulty > 10) err('difficulty', 'Difficulty must be a whole number from 1 to 10.');
  v.q = s(input.q).trim();
  if (!v.q) err('q', 'The question is empty.');
  else if (v.q.length > LIMITS.q) err('q', `The question is longer than ${LIMITS.q} characters.`);
  v.code = s(input.code).replace(/\s+$/, '');
  if (v.code.length > LIMITS.code) err('code', `The code is longer than ${LIMITS.code} characters.`);
  const opts = Array.isArray(input.options) ? input.options.map((o) => s(o).trim()) : [];
  if (opts.length !== 4 || opts.some((o) => !o)) err('options', 'Give exactly 4 non-empty options.');
  else if (new Set(opts.map((o) => o.toLowerCase())).size !== 4) err('options', 'The 4 options must all be different.');
  else if (opts.some((o) => o.length > LIMITS.option)) err('options', `An option is longer than ${LIMITS.option} characters.`);
  v.options = opts;
  v.correct = Number(input.correct);
  if (!Number.isInteger(v.correct) || v.correct < 0 || v.correct > 3) err('correct', 'Mark which option is correct (A, B, C or D).');
  v.hint = s(input.hint).trim();
  if (v.hint.length > LIMITS.hint) err('hint', `The hint is longer than ${LIMITS.hint} characters.`);
  v.why = s(input.why).trim();
  if (v.why.length > LIMITS.why) err('why', `The explanation is longer than ${LIMITS.why} characters.`);
  const tags = Array.isArray(input.tags) ? input.tags : s(input.tags).split(/[,;|]/);
  v.tags = [...new Set(tags.map((t) => s(t).trim().toLowerCase()).filter(Boolean))].slice(0, LIMITS.tags).map((t) => t.slice(0, LIMITS.tag));
  if (input.status != null && input.status !== '') {
    v.status = s(input.status).trim().toLowerCase();
    if (!STATUSES.includes(v.status)) err('status', `Status must be one of ${STATUSES.join(', ')}.`);
  }
  if (!v.ext_id && v.q) v.ext_id = autoExtId(v.q, v.code);
  return { value: v, errors };
}

const CONTENT = ['checkpoint', 'skill', 'type', 'difficulty', 'q', 'code', 'options', 'correct', 'hint', 'why', 'tags'];
export const contentOf = (row) => ({
  checkpoint: row.checkpoint, skill: row.skill, type: row.type, difficulty: Number(row.difficulty), q: row.q, code: row.code,
  options: Array.isArray(row.options) ? row.options : parseJSON(row.options, []), correct: Number(row.correct), hint: row.hint, why: row.why,
  tags: Array.isArray(row.tags) ? row.tags : parseJSON(row.tags, [])
});
export const sameContent = (a, b) => CONTENT.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

export const rowOut = (r) => r && ({
  id: Number(r.id), extId: r.ext_id, status: r.status, ...contentOf(r), version: Number(r.version),
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  ...(r.n != null ? { stats: { n: Number(r.n), ok: Number(r.ok) } } : {})
});

// ---------- pools: published questions, cached until the bank changes (bankRev)
export async function bankRev() { return Number(await getSetting('kbc_bank_rev', 0)) || 0; }
export async function bumpRev() {
  await setSetting('kbc_bank_rev', (await bankRev()) + 1);
  kv.clearLocal();
}

export async function publishedIndex() {
  const rev = await bankRev();
  return kv.cached('kbc:pub:' + rev, 3600, async () =>
    (await all("SELECT id, version, checkpoint, skill, difficulty FROM kbc_questions WHERE status = 'published' ORDER BY id"))
      .map((r) => [Number(r.id), Number(r.version), r.checkpoint, r.skill, Number(r.difficulty)]), { localMs: 5000 });
}
const matches = (rule, [, , cp, skill, d]) => cp === rule.checkpoint && d >= rule.diffMin && d <= rule.diffMax && (!rule.skills || !rule.skills.length || rule.skills.includes(skill));
// [[qid, version], …] for one rung.
export async function poolFor(rule) {
  return (await publishedIndex()).filter((p) => matches(rule, p)).map((p) => [p[0], p[1]]);
}
export async function poolSizes(ladder) {
  const idx = await publishedIndex();
  return ladder.rungs.map((r) => idx.filter((p) => matches(r.rule, p)).length);
}
// Practice by skill: every published question of that skill, easiest first.
export async function skillPool(skill) {
  return (await publishedIndex()).filter((p) => p[3] === skill).sort((a, b) => a[4] - b[4] || a[0] - b[0]).map((p) => [p[0], p[1], p[4]]);
}

// Exact content of one version (immutable, so cached hard).
const versionCache = new Map();
export async function questionAt(qid, version) {
  const k = qid + ':' + version;
  if (versionCache.has(k)) return versionCache.get(k);
  const r = await one('SELECT data FROM kbc_question_versions WHERE question_id = ? AND version = ?', qid, version);
  if (!r) throw new BankError('NO_QUESTION', 'Question not found.', 404);
  const v = parseJSON(r.data);
  if (versionCache.size > 20000) versionCache.clear();
  versionCache.set(k, v);
  return v;
}
export async function currentVersion(qid) {
  const r = await one('SELECT version FROM kbc_questions WHERE id = ?', qid);
  return r ? Number(r.version) : null;
}

// ---------- CRUD
const snapshot = (id, version, content, by) =>
  run('INSERT INTO kbc_question_versions (question_id, version, data, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', id, version, JSON.stringify(content), by || null, Date.now());

export async function insertQuestion(v, by, { status } = {}) {
  const now = Date.now(), c = contentOf(v);
  const r = await one(`INSERT INTO kbc_questions (ext_id, status, checkpoint, skill, type, difficulty, q, code, options, correct, hint, why, tags, version, fingerprint, created_by, updated_by, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id`,
    v.ext_id, status || v.status || 'draft', c.checkpoint, c.skill, c.type, c.difficulty, c.q, c.code, JSON.stringify(c.options), c.correct, c.hint, c.why,
    JSON.stringify(c.tags), fingerprint(c.q, c.code), by || null, by || null, now, now);
  await snapshot(Number(r.id), 1, c, by);
  return Number(r.id);
}

// Applies new content (and/or status) to an existing row. Returns 'updated' | 'unchanged'.
export async function applyUpdate(row, v, by, { status } = {}) {
  const c = contentOf(v), changed = !sameContent(contentOf(row), c);
  const nextStatus = status || v.status || row.status;
  if (!changed && nextStatus === row.status) return 'unchanged';
  const version = changed ? Number(row.version) + 1 : Number(row.version);
  await run(`UPDATE kbc_questions SET status = ?, checkpoint = ?, skill = ?, type = ?, difficulty = ?, q = ?, code = ?, options = ?, correct = ?, hint = ?, why = ?, tags = ?,
             version = ?, fingerprint = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    nextStatus, c.checkpoint, c.skill, c.type, c.difficulty, c.q, c.code, JSON.stringify(c.options), c.correct, c.hint, c.why, JSON.stringify(c.tags),
    version, fingerprint(c.q, c.code), by || null, Date.now(), row.id);
  if (changed) await snapshot(Number(row.id), version, c, by);
  return 'updated';
}

async function duplicateOf(v, exceptId) {
  const d = await one('SELECT id, ext_id FROM kbc_questions WHERE fingerprint = ? AND id <> ? LIMIT 1', fingerprint(v.q, v.code), exceptId || 0);
  return d ? { id: Number(d.id), extId: d.ext_id } : null;
}

export async function addQuestion(input, by) {
  const { value, errors } = check(input, await getLadder());
  if (errors.length) throw new BankError('INVALID', errors[0].msg, 400, { errors });
  if (await one('SELECT 1 AS x FROM kbc_questions WHERE ext_id = ?', value.ext_id)) throw new BankError('EXISTS', `A question with ID "${value.ext_id}" already exists.`, 409);
  const id = await tx(() => insertQuestion(value, by));
  await bumpRev();
  return { id, duplicateOf: await duplicateOf(value, id) };
}

export async function updateQuestion(id, input, by) {
  const row = await one('SELECT * FROM kbc_questions WHERE id = ?', Number(id));
  if (!row) throw new BankError('NOT_FOUND', 'Question not found.', 404);
  const { value, errors } = check({ ...input, ext_id: input.ext_id || row.ext_id }, await getLadder());
  if (errors.length) throw new BankError('INVALID', errors[0].msg, 400, { errors });
  if (value.ext_id !== row.ext_id) {
    if (await one('SELECT 1 AS x FROM kbc_questions WHERE ext_id = ? AND id <> ?', value.ext_id, row.id)) throw new BankError('EXISTS', `ID "${value.ext_id}" is used by another question.`, 409);
    await run('UPDATE kbc_questions SET ext_id = ? WHERE id = ?', value.ext_id, row.id);
  }
  const r = await tx(() => applyUpdate(row, value, by));
  if (r === 'updated') await bumpRev();
  return { result: r, duplicateOf: await duplicateOf(value, row.id) };
}

export async function setStatus(ids, status, by) {
  if (!STATUSES.includes(status)) throw new BankError('BAD_STATUS', 'Unknown status.');
  ids = [...new Set((ids || []).map(Number).filter(Number.isInteger))].slice(0, 5000);
  if (!ids.length) return 0;
  const rows = await all(`UPDATE kbc_questions SET status = ?, updated_by = ?, updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND status <> ? RETURNING id`,
    status, by || null, Date.now(), ...ids, status);
  if (rows.length) await bumpRev();
  return rows.length;
}

// Deleting moves the row to the recycle bin. Played questions keep their saved versions, so old games still replay.
export async function deleteQuestion(id, by) {
  const row = await one('SELECT * FROM kbc_questions WHERE id = ?', Number(id));
  if (!row) throw new BankError('NOT_FOUND', 'Question not found.', 404);
  await tx(async () => {
    await binPut('question', row.ext_id, row.q.slice(0, 120), { row }, by);
    await run('DELETE FROM kbc_questions WHERE id = ?', row.id);
  });
  await bumpRev();
}

export async function getQuestion(id) {
  const r = await one('SELECT q.*, s.n, s.ok FROM kbc_questions q LEFT JOIN kbc_qstats s ON s.qid = q.id WHERE q.id = ?', Number(id));
  if (!r) throw new BankError('NOT_FOUND', 'Question not found.', 404);
  return rowOut(r);
}

export async function versions(id) {
  return (await all('SELECT version, data, by, at FROM kbc_question_versions WHERE question_id = ? ORDER BY version DESC', Number(id)))
    .map((r) => ({ version: Number(r.version), data: parseJSON(r.data), by: r.by, at: Number(r.at) }));
}

// Search + filters + paging, all in SQL so 10,000 questions stay fast.
export async function listQuestions(f = {}) {
  const where = [], p = [];
  if (f.q) { where.push('(q.q ILIKE ? OR q.code ILIKE ? OR q.ext_id ILIKE ? OR q.tags ILIKE ?)'); const like = '%' + String(f.q).replace(/[%_\\]/g, '\\$&') + '%'; p.push(like, like, like, like); }
  if (f.checkpoint) { where.push('q.checkpoint = ?'); p.push(String(f.checkpoint)); }
  if (f.skill) { where.push('q.skill = ?'); p.push(String(f.skill)); }
  if (f.status) { where.push('q.status = ?'); p.push(String(f.status)); }
  if (f.diff) { const [a, b] = String(f.diff).split('-').map(Number); where.push('q.difficulty BETWEEN ? AND ?'); p.push(a || 1, b || a || 10); }
  if (f.ids) { const ids = String(f.ids).split(',').map(Number).filter(Number.isInteger).slice(0, 500); if (ids.length) { where.push(`q.id IN (${ids.map(() => '?').join(',')})`); p.push(...ids); } }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const SORTS = { recent: 'q.updated_at DESC', id: 'q.id ASC', diff: 'q.checkpoint, q.difficulty, q.id', played: 'COALESCE(s.n,0) DESC, q.id' };
  const order = SORTS[f.sort] || SORTS.recent;
  const size = Math.min(200, Math.max(1, Number(f.size) || 50)), page = Math.max(1, Number(f.page) || 1);
  const total = Number((await one(`SELECT COUNT(*) AS n FROM kbc_questions q ${W}`, ...p)).n);
  const rows = await all(`SELECT q.*, s.n, s.ok FROM kbc_questions q LEFT JOIN kbc_qstats s ON s.qid = q.id ${W} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size);
  return { total, page, size, rows: rows.map(rowOut) };
}

export async function counts() {
  const rows = await all('SELECT checkpoint, status, COUNT(*) AS n FROM kbc_questions GROUP BY checkpoint, status');
  const out = { total: 0, byStatus: {}, byCheckpoint: {} };
  for (const r of rows) {
    const n = Number(r.n);
    out.total += n;
    out.byStatus[r.status] = (out.byStatus[r.status] || 0) + n;
    out.byCheckpoint[r.checkpoint] = out.byCheckpoint[r.checkpoint] || {};
    out.byCheckpoint[r.checkpoint][r.status] = n;
  }
  return out;
}
