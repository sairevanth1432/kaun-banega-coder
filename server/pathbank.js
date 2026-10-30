// The skill-path question bank: items in the question-bank-format (question-bank-format/AUTHORING.md), one per id
// C{cp}-G{group}-S{skill}-L{level}-T{n}-R{r}-V{variant}. Admins upload bundles ({bank_version, skill_meta, questions});
// the server keeps every item, sends players a copy with the answer stripped out, and grades every answer itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { one, all, run, tx, parseJSON, getSetting, setSetting } from './db.js';
import * as kv from './kv.js';
import { runPython } from './pyrun.js';

export const GRAPH = JSON.parse(fs.readFileSync(new URL('./content/skill-graph.json', import.meta.url), 'utf8'));
export const QTYPES = JSON.parse(fs.readFileSync(new URL('./content/question-types.json', import.meta.url), 'utf8'));
export const TYPE = Object.fromEntries(QTYPES.types.map((t) => [t.key, t]));
export const SKILL = Object.fromEntries(GRAPH.skills.map((s) => [s.id, s]));
// The types the hot seat can play: answer-key types plus the code types the server runs (fill, parsons, golf).
export const HOTSEAT = new Set(QTYPES.types.filter((t) => t.modes.includes('hotseat')).map((t) => t.key));
export const RUN_TYPES = new Set(['fill', 'parsons', 'golf']);
const CHOICE = new Set(QTYPES.types.filter((t) => t.ui === 'choice').map((t) => t.key));

export class PathBankError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.code = 'BAD_ITEM'; this.status = status; this.extra = extra; }
}

const ID_RE = /^C(\d+)-G(\d+)-S(\d+)-L([1-4])-T(\d+)-R([1-3])-V(\d+)$/;
const isStr = (v) => typeof v === 'string';
const arr = (v) => Array.isArray(v);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001');

// ---------------------------------------------------------------- validation of one uploaded item
export function checkItem(q) {
  const errs = [];
  if (!q || typeof q !== 'object') return ['Not an object.'];
  const m = ID_RE.exec(String(q.id || ''));
  if (!m) errs.push('id must look like C1-G1-S1-L1-T1-R1-V1.');
  const S = SKILL[q.skill], T = TYPE[q.type];
  if (!S) errs.push(`Unknown skill "${q.skill}" (not in skill-graph.json).`);
  if (!T) errs.push(`Unknown type "${q.type}".`);
  if (m && S && (`C${m[1]}` !== S.cp || `G${m[2]}` !== S.group || `S${m[3]}` !== S.id)) errs.push(`id ${q.id} does not match skill ${S.id} (${S.cp}, ${S.group}).`);
  if (T && Number(q.level) !== T.level) errs.push(`Type ${q.type} belongs to level ${T.level}, not ${q.level}.`);
  if (m && T && `T${m[5]}` !== T.T) errs.push(`Type ${q.type} is ${T.T}, but the id says T${m[5]}.`);
  if (![1, 2, 3].includes(Number(q.difficulty))) errs.push('difficulty must be 1, 2 or 3.');
  if (m && Number(m[6]) !== Number(q.difficulty)) errs.push('The id\'s R does not match difficulty.');
  if (!(Number(q.variant) >= 1)) errs.push('variant must be 1 or more.');
  if (m && Number(m[7]) !== Number(q.variant)) errs.push('The id\'s V does not match variant.');
  if (!isStr(q.task) || !q.task.trim()) errs.push('task is missing.');
  const p = q.payload;
  if (!p || typeof p !== 'object') return errs.concat('payload is missing.');
  if (T) for (const k of T.payload.required) if (p[k] == null) errs.push(`payload.${k} is required for ${q.type}.`);
  if (errs.length) return errs;
  const t = q.type;
  if (CHOICE.has(t)) {
    if (!arr(p.options) || p.options.length < 2) errs.push('options needs at least 2 entries.');
    else if (p.options.filter((o) => o && o.correct === true).length !== 1) errs.push('Exactly one option must have correct: true.');
  } else if (t === 'match') {
    if (!arr(p.left) || !arr(p.right) || !sameSet(Object.keys(p.answer), p.left) || !Object.values(p.answer).every((v) => p.right.includes(v))) errs.push('match: answer must pair every left item with a right item.');
  } else if (t === 'predict') {
    if (!isStr(p.expected)) errs.push('predict: expected must be text.');
  } else if (t === 'hunt') {
    if (!arr(p.values) || !arr(p.answer) || !p.answer.every((v) => p.values.includes(v))) errs.push('hunt: every answer must be one of the values.');
  } else if (t === 'path2') {
    if (!arr(p.lines) || !arr(p.answer) || !p.answer.every((n) => Number.isInteger(n) && n >= 1 && n <= p.lines.length)) errs.push('path2: answer must be line numbers (1-based).');
  } else if (t === 'timeline' || t === 'pseudo' || t === 'sort') {
    const items = t === 'sort' ? p.pieces : p.items;
    if (!arr(items) || !arr(p.answer) || !sameSet(items, p.answer)) errs.push(`${t}: answer must use every item exactly once.`);
  } else if (t === 'group') {
    const all1 = Object.values(p.groups || {}).flat();
    if (!arr(p.pieces) || !sameSet(all1, p.pieces)) errs.push('group: the groups must use every piece exactly once.');
  } else if (t === 'same') {
    if (!['Same', 'Different'].includes(p.answer)) errs.push('same: answer must be "Same" or "Different".');
  } else if (t === 'gap') {
    if (!arr(p.rows) || !p.rows.some((r) => !r.given)) errs.push('gap: rows need at least one cell to fill.');
  } else if (t === 'path') {
    const ids = (p.branches || []).map((b) => b.id);
    if (!arr(p.cases) || !p.cases.length || !p.cases.every((c) => ids.includes(c.answer))) errs.push('path: every case answer must be a branch id.');
  } else if (t === 'bug') {
    if (!arr(p.lines) || !Number.isInteger(p.answer) || p.answer < 1 || p.answer > p.lines.length) errs.push('bug: answer must be a line number (1-based).');
  } else if (t === 'fill') {
    if (!isStr(q.code) || !q.code.includes('____')) errs.push('fill: code needs a ____ blank.');
  } else if (t === 'parsons') {
    if (!arr(p.items) || !isStr(p.target)) errs.push('parsons: items and target are required.');
  } else if (t === 'golf') {
    const lines = String(q.code || '').split('\n');
    if (!arr(p.tokens) || !p.tokens.every((k) => lines[k.line] != null && lines[k.line].includes(k.now) && arr(k.choices) && k.choices.includes(k.now))) errs.push('golf: each token needs a line, its current text and choices that include it.');
  }
  return errs;
}

const fingerprint = (q) => crypto.createHash('sha1').update(JSON.stringify([q.task, q.code, q.payload, q.ok, q.hint, q.status])).digest('hex');

// ---------------------------------------------------------------- import (dry run first, then save)
export async function importBundle(bundle, { dry = true, by = null, filename = '' } = {}) {
  const qs = bundle && arr(bundle.questions) ? bundle.questions : null;
  if (!qs) throw new PathBankError('The file must be a JSON bundle with a "questions" list.');
  const existing = new Map((await all('SELECT id, fingerprint, version FROM kbc_items')).map((r) => [r.id, r]));
  const out = { rows: qs.length, added: 0, updated: 0, unchanged: 0, errors: [], bySkill: {} }, ok = [], seen = new Set();
  qs.forEach((q, i) => {
    const errs = checkItem(q);
    if (q && seen.has(q.id)) errs.push('Duplicate id in this file.');
    if (errs.length) { if (out.errors.length < 200) out.errors.push({ row: i + 1, id: q && q.id, errors: errs }); return; }
    seen.add(q.id);
    const fp = fingerprint(q), e = existing.get(q.id);
    if (!e) out.added++; else if (e.fingerprint === fp) { out.unchanged++; return; } else out.updated++;
    out.bySkill[q.skill] = (out.bySkill[q.skill] || 0) + 1;
    ok.push({ q, fp, version: e ? Number(e.version) + 1 : 1 });
  });
  out.errorCount = qs.length - seen.size;
  if (dry) return out;
  const now = Date.now();
  await tx(async () => {
    for (const { q, fp, version } of ok) {
      const S = SKILL[q.skill], status = q.status === 'retired' ? 'retired' : 'live';
      await run(`INSERT INTO kbc_items (id, skill, grp, cp, level, type, r, variant, status, version, fingerprint, data, bank_version, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET skill = excluded.skill, grp = excluded.grp, cp = excluded.cp, level = excluded.level, type = excluded.type,
                 r = excluded.r, variant = excluded.variant, status = excluded.status, version = excluded.version, fingerprint = excluded.fingerprint,
                 data = excluded.data, bank_version = excluded.bank_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        q.id, q.skill, S.group, S.cp, Number(q.level), q.type, Number(q.difficulty), Number(q.variant), status, version, fp, JSON.stringify(q), String(bundle.bank_version || ''), by, now);
    }
    for (const [skill, meta] of Object.entries(bundle.skill_meta || {})) {
      if (!SKILL[skill]) continue;
      await run('INSERT INTO kbc_skill_meta (skill, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (skill) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', skill, JSON.stringify(meta), now);
    }
    await run('INSERT INTO kbc_imports (filename, rows, added, updated, unchanged, errors, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'path:' + (filename || 'bundle.json'), out.rows, out.added, out.updated, out.unchanged, JSON.stringify(out.errors.slice(0, 50)), by, now);
  });
  await bumpBank();
  return out;
}

export async function setItemStatus(ids, status) {
  if (!['live', 'retired'].includes(status)) throw new PathBankError('status must be live or retired.');
  for (const id of ids.slice(0, 2000)) await run('UPDATE kbc_items SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), String(id));
  await bumpBank();
}

// ---------------------------------------------------------------- the live index: which (skill, level, r, type) have which variants
let INDEX = null, INDEX_REV = -1;
async function bankRev() { return Number(await getSetting('kbc_path_bank_rev', 0)) || 0; }
async function bumpBank() {
  await setSetting('kbc_path_bank_rev', (await bankRev()) + 1);
  INDEX = null;
  await kv.invalidate('kbc:path:rev').catch(() => {});
}
// index[skill][level][r][type] = sorted variant list (live, hot-seat types only)
export async function bankIndex() {
  const rev = await kv.cached('kbc:path:rev', 5, bankRev);
  if (INDEX && INDEX_REV === rev) return INDEX;
  const idx = {};
  for (const r of await all("SELECT skill, level, r, type, variant FROM kbc_items WHERE status = 'live'")) {
    if (!HOTSEAT.has(r.type)) continue;
    const a = (((idx[r.skill] ||= {})[r.level] ||= {})[r.r] ||= {});
    (a[r.type] ||= []).push(Number(r.variant));
  }
  for (const s of Object.values(idx)) for (const l of Object.values(s)) for (const rr of Object.values(l)) for (const t of Object.keys(rr)) rr[t].sort((a, b) => a - b);
  INDEX = idx; INDEX_REV = rev;
  return idx;
}

export async function getItem(id) {
  const r = await one('SELECT data, version, status FROM kbc_items WHERE id = ?', String(id));
  return r ? { ...parseJSON(r.data, {}), version: Number(r.version), _status: r.status } : null;
}
export async function itemAt(skill, level, r, type, variant) {
  const row = await one('SELECT data, version FROM kbc_items WHERE skill = ? AND level = ? AND r = ? AND type = ? AND variant = ? AND status = \'live\'', skill, level, r, type, variant);
  return row ? { ...parseJSON(row.data, {}), version: Number(row.version) } : null;
}
export async function skillMeta(skill) {
  const r = await one('SELECT data FROM kbc_skill_meta WHERE skill = ?', skill);
  return r ? parseJSON(r.data, {}) : {};
}

// ---------------------------------------------------------------- what players see before answering (no answers)
export function publicItem(q, removed = []) {
  const p = q.payload || {}, t = q.type, T = TYPE[t];
  const base = { id: q.id, skill: q.skill, level: q.level, type: t, typeName: T.name, ui: T.ui, task: q.task, code: q.code || null, fifty: !!T.lifeline_5050 };
  let v = {};
  if (CHOICE.has(t)) v = { options: p.options.map((o, i) => (removed.includes(i) ? null : o.text)), spec: p.spec || null, printed: t === 'explain' ? p.printed || null : null };
  else if (t === 'match') v = { left: p.left, right: p.right };
  else if (t === 'predict') v = { stdin: p.stdin || null };
  else if (t === 'hunt') v = { values: p.values };
  else if (t === 'path2') v = { lines: p.lines, stdin: p.stdin || null };
  else if (t === 'timeline' || t === 'pseudo') v = { items: p.items };
  else if (t === 'group') v = { pieces: p.pieces, groups: Object.keys(p.groups), size: Object.values(p.groups)[0].length };
  else if (t === 'same') v = { codeA: p.codeA, codeB: p.codeB, stdin: p.stdin || null };
  else if (t === 'gap') { const ask = gapAsk(p); v = { ask, rows: p.rows.map((r) => ({ line: r.line, var: r.var, given: !!r.given, ...(r.given ? Object.fromEntries(['value', 'kind'].filter((k) => r[k] != null).map((k) => [k, r[k]])) : Object.fromEntries(['value', 'kind'].filter((k) => r[k] != null && !ask.includes(k)).map((k) => [k, r[k]]))) })) }; }
  else if (t === 'path') v = { branches: p.branches, cases: p.cases.map((c) => ({ input: c.input })) };
  else if (t === 'sort') v = { pieces: p.pieces };
  else if (t === 'bug') v = { lines: p.lines };
  else if (t === 'fill') v = { target: p.target, stdin: p.stdin || null };
  else if (t === 'parsons') v = { items: p.items, target: p.target };
  else if (t === 'golf') v = { tokens: p.tokens.map((k) => ({ line: k.line, now: k.now, choices: k.choices })), target: p.target, par: p.par };
  return { ...base, payload: v };
}
const gapAsk = (p) => (arr(p.ask) && p.ask.length ? p.ask : p.rows.some((r) => r.kind != null) ? ['kind'] : ['value']);

// ---------------------------------------------------------------- grading
const normOut = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
const normQ = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').replace(/^"(.*)"$/, "'$1'");
const eqArr = (a, b) => arr(a) && arr(b) && a.length === b.length && a.every((x, i) => x === b[i]);

async function runs(code, p) {
  const tests = arr(p.tests) && p.tests.length ? p.tests : [{ stdin: p.stdin || '', expected: p.target }];
  let last = null;
  for (const t of tests) {
    const r = await runPython(code, t.stdin || '');
    last = { stdin: t.stdin || '', out: r.out, err: r.err, timeout: r.timeout, expected: t.expected };
    if (r.timeout || r.err || normOut(r.out) !== normOut(t.expected)) return { ok: false, run: last };
  }
  return { ok: true, run: last };
}

// given: what the player sent. Returns { ok, note, picked } — note explains a wrong answer using the bank's own "why".
export async function grade(q, given) {
  const p = q.payload, t = q.type, g = given && typeof given === 'object' ? given : {};
  if (CHOICE.has(t)) {
    const i = Number(g.pick), o = p.options[i];
    if (!Number.isInteger(i) || !o) return { ok: false, note: null };
    return { ok: o.correct === true, note: o.correct ? null : o.why || null, picked: i };
  }
  if (t === 'match') {
    const m = g.map || {};
    const wrong = p.left.filter((l) => m[l] !== p.answer[l]);
    return { ok: !wrong.length, wrongLeft: wrong };
  }
  if (t === 'predict') {
    const text = String(g.text == null ? '' : g.text).slice(0, 2000), ok = normOut(text) === normOut(p.expected);
    const w = p.wrong && Object.entries(p.wrong).find(([k]) => normOut(k) === normOut(text));
    return { ok, note: ok ? null : (w ? w[1] : null) };
  }
  if (t === 'hunt') {
    const picks = arr(g.picks) ? g.picks.map(String) : [], ok = sameSet([...new Set(picks)], p.answer);
    const notes = ok ? [] : (p.wrong_sets || []).filter((w) => (w.if != null && picks.includes(w.if)) || (w.miss != null && !picks.includes(w.miss))).map((w) => w.why);
    return { ok, note: notes[0] || null, notes };
  }
  if (t === 'path2') {
    const path = arr(g.path) ? g.path.map(Number) : [], ok = eqArr(path, p.answer);
    const w = !ok && (p.wrong_paths || []).find((x) => eqArr(x.path, path));
    return { ok, note: w ? w.why : null };
  }
  if (t === 'timeline' || t === 'pseudo' || t === 'sort') {
    const order = arr(g.order) ? g.order.map(String) : [], ok = eqArr(order, p.answer);
    let note = null;
    if (!ok && t === 'sort') { const w = (p.wrong_pairs || []).find((x) => order.indexOf(x.before) > -1 && order.indexOf(x.before) < order.indexOf(x.after)); note = w ? w.why : null; }
    return { ok, note };
  }
  if (t === 'group') {
    const gg = g.groups || {};
    const wrong = Object.keys(p.groups).filter((k) => !sameSet(arr(gg[k]) ? gg[k].map(String) : [], p.groups[k]));
    return { ok: !wrong.length, wrongGroups: wrong };
  }
  if (t === 'same') return { ok: g.pick === p.answer };
  if (t === 'gap') {
    const ask = gapAsk(p), cells = g.cells || {}, wrong = [];
    p.rows.forEach((r, i) => { if (r.given) return; for (const k of ask) { const v = cells[i] && cells[i][k]; if (k === 'kind' ? String(v || '').trim().toLowerCase() !== String(r.kind).toLowerCase() : normQ(v) !== normQ(r.value)) wrong.push(i + ':' + k); } });
    return { ok: !wrong.length, wrongCells: wrong };
  }
  if (t === 'path') {
    const picks = g.picks || {}, wrong = p.cases.map((c, i) => (picks[i] === c.answer ? null : i)).filter((x) => x != null);
    return { ok: !wrong.length, wrongCases: wrong, note: wrong.length ? p.cases[wrong[0]].why || null : null };
  }
  if (t === 'bug') return { ok: Number(g.line) === p.answer };
  if (t === 'fill') {
    const text = String(g.text == null ? '' : g.text);
    if (!text.trim() || text.length > 80 || /[\n\r]/.test(text) || text.includes('__')) return { ok: false, note: 'Type one short piece of code for the blank.' };
    if ((p.forbid || []).some((f) => text.includes(f))) return { ok: false, note: 'That answer types the result directly. Build it the way the task asks.' };
    const code = q.code.split('____').join(text);
    if ((p.require || []).some((r) => !code.includes(r))) return { ok: false, note: 'Something the task asks for is missing.' };
    const r = await runs(code, p);
    return { ok: r.ok, run: r.run };
  }
  if (t === 'parsons') {
    const order = arr(g.order) ? g.order.map(Number) : [];
    if (order.length !== p.items.length || new Set(order).size !== order.length || order.some((i) => !p.items[i] && p.items[i] !== '')) return { ok: false, note: 'Use every line exactly once.' };
    const r = await runs(order.map((i) => p.items[i]).join('\n'), p);
    return { ok: r.ok, run: r.run };
  }
  if (t === 'golf') {
    const picks = arr(g.choices) ? g.choices.map(String) : [];
    if (picks.length !== p.tokens.length || picks.some((c, i) => !p.tokens[i].choices.includes(c))) return { ok: false, note: 'Pick one choice for every highlighted value.' };
    const lines = q.code.split('\n'), from = {};
    p.tokens.forEach((k, i) => { const at = lines[k.line].indexOf(k.now, from[k.line] || 0); lines[k.line] = lines[k.line].slice(0, at) + picks[i] + lines[k.line].slice(at + k.now.length); from[k.line] = at + picks[i].length; });
    const edits = picks.filter((c, i) => c !== p.tokens[i].now).length, r = await runs(lines.join('\n'), p);
    return { ok: r.ok && edits <= p.par, edits, run: r.run, note: r.ok && edits > p.par ? `That works, but it takes ${edits} changes. Par is ${p.par}.` : null };
  }
  return { ok: false, note: 'This question type is not playable in the hot seat yet.' };
}
