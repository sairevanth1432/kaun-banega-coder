// The skill-path engine and the hot seat. The server decides every move: which question comes next (KBC Progression
// Engine rules over content/skill-graph.json), whether an answer is right (pathbank.grade), energy, prizes and the
// leaderboard numbers. Players only ever see a question without its answer until they have locked one in.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, all, run, tx, parseJSON } from './db.js';
import * as kv from './kv.js';
import { GRAPH, SKILL, TYPE, QTYPES, RUN_TYPES, bankIndex, itemAt, getItem, skillMeta, publicItem, grade } from './pathbank.js';

export class PathError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------- the money board: one prize per skill group
export const LADDER = [100, 200, 500, 1000, 5000, 10000, 1e5, 1e6, 5e6, 1e7, 3e7, 7e7];
const GROUPS = GRAPH.groups.map((g, i) => ({ ...g, prize: LADDER[i] || 0, idx: i }));
const CP_LAST = Object.fromEntries(GRAPH.checkpoints.map((c) => [c.id, c.groups[c.groups.length - 1]]));   // checkpoint → its last group
const ORDER = GROUPS.flatMap((g) => g.skills);                       // path order: group by group, skills in graph order
const STARTERS = GRAPH.skills.filter((s) => s.starter).map((s) => s.id);
const CPS = GRAPH.checkpoints.map((c) => c.id);
const TORDER = Object.fromEntries(QTYPES.types.map((t, i) => [t.key, i]));
const ENERGY = { wrong: 20, timeout: 25, combo: 3, back: 10 };
const STREAK_TO_LEVEL = 2, VARIANTS_SEEN = 25;
const secsFor = (q) => (RUN_TYPES.has(q.type) || q.level >= 3 ? 90 : 60);

// ---------------------------------------------------------------- per-student state
const blank = () => ({ sk: {}, paid: [] });
function skState(st, sid) {
  const S = SKILL[sid];
  return st.sk[sid] ||= { d: 0, l: 1, r: Math.min(2, S.rmax), t: { 1: 0, 2: 0, 3: 0, 4: 0 }, k: null, kc: 0, rs: 0, v: {} };
}
async function loadState(userId) {
  const r = await one('SELECT state FROM kbc_path WHERE user_id = ?', userId);
  return r ? { ...blank(), ...parseJSON(r.state, {}) } : blank();
}

// types with live questions at (skill, level, r), in T order
const typesAt = (idx, sid, l, r) => Object.keys(((idx[sid] || {})[l] || {})[r] || {}).sort((a, b) => TORDER[a] - TORDER[b]);
const playable = (idx, sid) => !!idx[sid] && Object.keys(idx[sid]).length > 0;

// Moves a skill's (level, r) onto a cell that has questions: same level at a nearby R first, then the next level.
function settle(idx, sid, s) {
  for (let l = s.l; l <= 4; l++) {
    const S = SKILL[sid], want = l === s.l ? s.r : S.rmax;
    for (const r of [want, ...[3, 2, 1].filter((x) => x !== want)]) {
      if (typesAt(idx, sid, l, r).length) { if (l !== s.l) s.rs = 0; s.l = l; s.r = r; return true; }
    }
  }
  s.d = 1;   // nothing left to play in this skill
  return false;
}

// Skill status for every skill: done | open | locked | soon (no questions yet).
export function statuses(idx, st) {
  const sat = (sid) => (st.sk[sid] && st.sk[sid].d) || !playable(idx, sid);
  const cpStarted = (cp) => CPS.slice(0, CPS.indexOf(cp)).every((c) => GRAPH.skills.filter((s) => s.cp === c).every((s) => sat(s.id)));
  const out = {};
  for (const sid of ORDER) {
    const S = SKILL[sid];
    if (st.sk[sid] && st.sk[sid].d) out[sid] = 'done';
    else if (!playable(idx, sid)) out[sid] = 'soon';
    else if (cpStarted(S.cp) && (S.cp !== CPS[0] || S.starter || STARTERS.every(sat)) && S.req.every((alts) => alts.some(sat))) out[sid] = 'open';
    else out[sid] = 'locked';
  }
  return out;
}
const activeSkill = (idx, st) => { const s = statuses(idx, st); return ORDER.find((sid) => s[sid] === 'open') || null; };

// The next question address for a skill.
function address(idx, sid, s) {
  if (!settle(idx, sid, s)) return null;
  const types = typesAt(idx, sid, s.l, s.r), type = types[s.t[s.l] % types.length];
  const vs = idx[sid][s.l][s.r][type], key = `${s.l}-${type}-${s.r}`;
  return { skill: sid, level: s.l, r: s.r, type, variant: vs[(s.v[key] || 0) % vs.length], key };
}

// KBC Progression Engine: two right in a row moves up a level, a miss gives the next variant, two misses on the
// same cell switch to the next question type; at L1 the first right climbs R, the first miss at the start R drops to R1.
function apply(idx, sid, s, addr, ok) {
  const S = SKILL[sid], l = s.l, r = s.r, start = Math.min(2, S.rmax), ck = `${l}-${r}`;
  s.v[addr.key] = Math.min(VARIANTS_SEEN * 4, (s.v[addr.key] || 0) + 1);
  let msg;
  if (ok) {
    s.k = null; s.kc = 0;
    if (l === 1 && r < S.rmax && typesAt(idx, sid, 1, r + 1).length) { s.r = r + 1; msg = 'Up one difficulty.'; }
    else if (s.rs + 1 < STREAK_TO_LEVEL) { s.rs++; msg = l < 4 ? 'One more right to reach the next level.' : 'One more right to finish this topic.'; }
    else if (l === 4) { s.d = 1; msg = 'Topic cleared!'; }
    else { s.l = l + 1; s.r = S.rmax; s.rs = 0; s.t[s.l] = s.t[s.l] || 0; msg = 'Level up!'; if (!settle(idx, sid, s)) msg = 'Topic cleared!'; }
  } else {
    s.rs = 0;
    if (s.k === ck) s.kc++; else { s.k = ck; s.kc = 1; }
    if (l === 1 && r === start && r > 1 && typesAt(idx, sid, 1, 1).length) { s.r = 1; s.k = null; s.kc = 0; msg = 'Back to an easier one.'; }
    else if (s.kc >= 2) { s.t[l] = (s.t[l] || 0) + 1; s.k = null; s.kc = 0; msg = 'Two misses. Here is a different kind of question.'; }
    else msg = 'Here is a fresh version of the same idea.';
  }
  return { msg, skillDone: !!s.d };
}

// Groups whose playable skills are all done and whose prize is not paid yet.
function newPrizes(idx, st) {
  const out = [];
  for (const g of GROUPS) {
    if (st.paid.includes(g.id)) continue;
    const play = g.skills.filter((sid) => playable(idx, sid));
    if (play.length && play.every((sid) => st.sk[sid] && st.sk[sid].d)) out.push(g);
  }
  return out;
}

// ---------------------------------------------------------------- what the player sees of their path
export async function pathView(user) {
  const idx = await bankIndex(), st = await loadState(user.id), s = statuses(idx, st), act = activeSkill(idx, st);
  const agg = await one('SELECT coins, correct, answered, skills_done, groups_done, runs FROM kbc_path WHERE user_id = ?', user.id) || {};
  const prog = (sid) => { const x = st.sk[sid]; if (!x) return 0; if (x.d) return 1; return Math.min(.95, ((x.l - 1) + x.rs / STREAK_TO_LEVEL * .9) / 4); };
  const open = await one("SELECT id FROM kbc_path_runs WHERE user_id = ? AND state = 'play' ORDER BY started_at DESC LIMIT 1", user.id);
  return {
    ladder: LADDER, checkpoints: GRAPH.checkpoints.map((c) => ({ id: c.id, name: c.name, lastGroup: CP_LAST[c.id] })),
    groups: GROUPS.map((g) => ({ id: g.id, cp: g.checkpoint, name: g.name, prize: g.prize, paid: st.paid.includes(g.id), skills: g.skills })),
    skills: ORDER.map((sid) => ({ id: sid, name: SKILL[sid].name, group: SKILL[sid].group, cp: SKILL[sid].cp, status: s[sid], progress: prog(sid) })),
    active: act, wallet: Number(agg.coins || 0), correct: Number(agg.correct || 0), answered: Number(agg.answered || 0),
    skillsDone: Number(agg.skills_done || 0), groupsDone: Number(agg.groups_done || 0), runs: Number(agg.runs || 0), openRunId: open ? open.id : null
  };
}

// ---------------------------------------------------------------- runs (one hot-seat game, or a practice round)
async function loadRun(userId, id) {
  const r = await one('SELECT * FROM kbc_path_runs WHERE id = ?', String(id || ''));
  if (!r || Number(r.user_id) !== userId) throw new PathError('NOT_FOUND', 'Game not found.', 404);
  return r;
}
async function withLock(id, fn) {
  const key = 'lock:path:' + id;
  if (!(await kv.setNX(key, 1, 15))) throw new PathError('BUSY', 'Still working on your last move.', 409);
  try { return await fn(); } finally { await kv.del(key).catch(() => {}); }
}

async function runView(r, extra = {}) {
  const v = { id: r.id, mode: r.mode, state: r.state, reason: r.reason || null, energy: Number(r.energy), combo: Number(r.combo), answered: Number(r.answered),
    correct: Number(r.correct), earned: Number(r.earned), used: parseJSON(r.used, {}), removed: parseJSON(r.removed, []), hint: r.hint || null,
    serverNow: Date.now(), shownAt: r.shown_at ? Number(r.shown_at) : null, deadline: r.deadline ? Number(r.deadline) : null, question: null, ...extra };
  if (r.state === 'play' && r.item_id) { const q = await getItem(r.item_id); if (q) { v.question = publicItem(q, v.removed); v.secs = secsFor(q); } }
  return v;
}

// Picks and shows the next question (hot seat: the engine's address; practice: any cleared or current topic).
async function deal(r, idx, st) {
  let addr = null;
  if (r.mode === 'practice') {
    const s = statuses(idx, st), pool = ORDER.filter((sid) => s[sid] === 'done' || s[sid] === 'open');
    const sid = pool[crypto.randomInt(pool.length || 1)];
    if (sid) {
      const cells = [];
      for (const [l, rs] of Object.entries(idx[sid])) for (const [rr, ts] of Object.entries(rs)) for (const [t, vs] of Object.entries(ts)) cells.push([+l, +rr, t, vs]);
      const c = cells[crypto.randomInt(cells.length)];
      if (c) addr = { skill: sid, level: c[0], r: c[1], type: c[2], variant: c[3][crypto.randomInt(c[3].length)] };
    }
  } else {
    const sid = activeSkill(idx, st);
    if (sid) addr = address(idx, sid, skState(st, sid));
  }
  const q = addr && await itemAt(addr.skill, addr.level, addr.r, addr.type, addr.variant);
  if (!q) return null;
  const now = Date.now(), shown = now + config.game.introMs;
  await run('UPDATE kbc_path_runs SET item_id = ?, item_version = ?, shown_at = ?, deadline = ?, removed = ?, hint = NULL WHERE id = ?',
    q.id, q.version, shown, shown + secsFor(q) * 1000, '[]', r.id);
  await run('INSERT INTO kbc_item_stats (id, shown) VALUES (?, 1) ON CONFLICT (id) DO UPDATE SET shown = kbc_item_stats.shown + 1', q.id);
  return q;
}

async function finishRun(r, reason) {
  const now = Date.now();
  const done = await one("UPDATE kbc_path_runs SET state = 'done', reason = ?, ended_at = ?, item_id = NULL, deadline = NULL WHERE id = ? AND state = 'play' RETURNING id", reason, now, r.id);
  if (done && r.mode !== 'practice') await run('UPDATE kbc_path SET runs = runs + 1, updated_at = ? WHERE user_id = ?', now, r.user_id);
}

export async function startRun(user, { mode = 'hotseat', fffId = '' } = {}) {
  if (!['hotseat', 'practice'].includes(mode)) throw new PathError('BAD_MODE', 'Unknown game mode.');
  const lim = await kv.rateLimit('path-start:' + user.id, config.game.maxGamesPerHour, 3600000);
  if (!lim.ok) throw new PathError('RATE_LIMIT', 'You have started a lot of games this hour. Take a short break and come back.', 429);
  if (mode === 'hotseat') {
    const f = await one("UPDATE kbc_r1_fff SET used = 1 WHERE id = ? AND user_id = ? AND ok = 1 AND used = 0 AND done_at > ? RETURNING id", String(fffId || ''), user.id, Date.now() - 15 * 60000);
    if (!f) throw new PathError('NEED_FFF', 'Win Fastest Finger First to take the hot seat.', 403);
  }
  for (const old of await all("SELECT * FROM kbc_path_runs WHERE user_id = ? AND state = 'play'", user.id)) await finishRun(old, 'abandoned');
  const id = crypto.randomBytes(12).toString('base64url'), now = Date.now();
  await run(`INSERT INTO kbc_path (user_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING`, user.id, JSON.stringify(blank()), now);
  await run(`INSERT INTO kbc_path_runs (id, user_id, mode, state, energy, combo, answered, correct, earned, used, removed, fff_id, started_at)
             VALUES (?, ?, ?, 'play', 100, 0, 0, 0, 0, '{}', '[]', ?, ?)`, id, user.id, mode, String(fffId || ''), now);
  const r = await one('SELECT * FROM kbc_path_runs WHERE id = ?', id);
  const q = await deal(r, await bankIndex(), await loadState(user.id));
  if (!q) { await finishRun(r, 'complete'); return { run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', id)), path: await pathView(user) }; }
  return { run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', id)) };
}

export async function getRun(user, id) { return { run: await runView(await loadRun(user.id, id)) }; }

// The player locks in an answer (given = null when their clock ran out).
export async function answerRun(user, id, { itemId, given }) {
  return withLock(id, async () => {
    const r = await loadRun(user.id, id);
    if (r.state !== 'play') throw new PathError('OVER', 'This game is over.', 409);
    if (!r.item_id || String(itemId) !== r.item_id) throw new PathError('STALE', 'That question is no longer on screen.', 409);
    const q = await getItem(r.item_id), now = Date.now(), late = now > Number(r.deadline) + config.game.graceMs;
    if (given == null && now < Number(r.deadline) - 2000) throw new PathError('TOO_EARLY', 'There is still time on the clock.', 409);
    const removed = parseJSON(r.removed, []);
    if (given && given.pick != null && removed.includes(Number(given.pick))) throw new PathError('BAD_PICK', 'That option was removed by 50:50.');
    const timeout = late || given == null;
    const g = timeout ? { ok: false } : await grade(q, given);
    const ok = !!g.ok, ms = Math.max(0, Math.min(now - Number(r.shown_at), secsFor(q) * 1000));
    const idx = await bankIndex(), st = await loadState(user.id);
    let prog = null, prizes = [], energy = Number(r.energy), combo = Number(r.combo), gain = 0;
    if (r.mode === 'hotseat') {
      const s = skState(st, q.skill);
      prog = apply(idx, q.skill, s, { key: `${q.level}-${q.type}-${q.difficulty}` }, ok);
      prizes = newPrizes(idx, st);
      st.paid.push(...prizes.map((p) => p.id));
      gain = prizes.reduce((a, p) => a + p.prize, 0);
      if (ok) { combo++; if (combo % ENERGY.combo === 0 && energy < 100) energy = Math.min(100, energy + ENERGY.back); }
      else { combo = 0; energy = Math.max(0, energy - (timeout ? ENERGY.timeout : ENERGY.wrong)); }
    }
    await tx(async () => {
      await run('INSERT INTO kbc_path_answers (run_id, user_id, item_id, version, skill, level, type, r, mode, ok, ms, given, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        r.id, user.id, q.id, q.version, q.skill, q.level, q.type, q.difficulty, r.mode, ok ? 1 : 0, ms, JSON.stringify(given == null ? null : given).slice(0, 4000), now);
      await run('INSERT INTO kbc_item_stats (id, n, ok, total_ms) VALUES (?, 1, ?, ?) ON CONFLICT (id) DO UPDATE SET n = kbc_item_stats.n + 1, ok = kbc_item_stats.ok + excluded.ok, total_ms = kbc_item_stats.total_ms + excluded.total_ms', q.id, ok ? 1 : 0, ms);
      await run(`UPDATE kbc_path_runs SET item_id = NULL, deadline = NULL, answered = answered + 1, correct = correct + ?, energy = ?, combo = ?, earned = earned + ? WHERE id = ?`,
        ok ? 1 : 0, energy, combo, gain, r.id);
      if (r.mode === 'hotseat') {
        const skillsDone = Object.values(st.sk).filter((x) => x.d).length;
        await run(`UPDATE kbc_path SET state = ?, coins = coins + ?, correct = correct + ?, answered = answered + 1, skills_done = ?, groups_done = ?, updated_at = ? WHERE user_id = ?`,
          JSON.stringify(st), gain, ok ? 1 : 0, skillsDone, st.paid.length, now, user.id);
      }
    });
    let after = await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id);
    if (r.mode === 'hotseat' && energy <= 0) { await finishRun(after, 'energy'); after = await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id); }
    const solution = { ...q }; delete solution._status;
    return {
      reveal: { ok, timeout, note: g.note || null, notes: g.notes || null, detail: { wrongLeft: g.wrongLeft, wrongGroups: g.wrongGroups, wrongCells: g.wrongCells, wrongCases: g.wrongCases, picked: g.picked, edits: g.edits, run: g.run || null },
        item: solution, msg: prog ? prog.msg : null, skillDone: prog ? prog.skillDone : false, prizes: prizes.map((p) => ({ group: p.id, name: p.name, amount: p.prize, checkpoint: CP_LAST[p.checkpoint] === p.id ? p.checkpoint : null })) },
      run: await runView(after)
    };
  });
}

export async function nextRun(user, id) {
  return withLock(id, async () => {
    const r = await loadRun(user.id, id);
    if (r.state !== 'play') throw new PathError('OVER', 'This game is over.', 409);
    if (!r.item_id) {
      const q = await deal(r, await bankIndex(), await loadState(user.id));
      if (!q) { await finishRun(r, 'complete'); return { run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id)), path: await pathView(user) }; }
    }
    return { run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id)) };
  });
}

export async function lifelineRun(user, id, k) {
  return withLock(id, async () => {
    const r = await loadRun(user.id, id);
    if (r.state !== 'play' || !r.item_id) throw new PathError('NO_QUESTION', 'There is no question on screen.', 409);
    if (!['fifty', 'hint', 'flip'].includes(k)) throw new PathError('BAD_LIFELINE', 'That lifeline is not available.');
    const used = parseJSON(r.used, {});
    if (used[k]) throw new PathError('USED', 'You have already used that lifeline.', 409);
    const q = await getItem(r.item_id);
    used[k] = 1;
    if (k === 'fifty') {
      if (!TYPE[q.type].lifeline_5050) throw new PathError('NO_FIFTY', '50:50 only works on four-option questions.', 409);
      const wrong = q.payload.options.map((o, i) => (o.correct ? -1 : i)).filter((i) => i >= 0);
      const removed = wrong.sort(() => crypto.randomInt(3) - 1).slice(0, Math.max(0, wrong.length - 1)).slice(0, 2);
      await run('UPDATE kbc_path_runs SET used = ?, removed = ? WHERE id = ?', JSON.stringify(used), JSON.stringify(removed), r.id);
    } else if (k === 'hint') {
      const meta = await skillMeta(q.skill), kp = (q.kps || []).map((x) => meta.kps && meta.kps[x]).find(Boolean);
      const hint = q.hint || (kp ? kp.replace(/^[^:]+:\s*/, '') : 'Read the code one line at a time and keep track of every value.');
      await run('UPDATE kbc_path_runs SET used = ?, hint = ? WHERE id = ?', JSON.stringify(used), hint, r.id);
    } else {
      // flip: another variant of the same kind of question; it does not count as a miss
      const idx = await bankIndex(), vs = (((idx[q.skill] || {})[q.level] || {})[q.difficulty] || {})[q.type] || [];
      const others = vs.filter((v) => v !== q.variant);
      if (!others.length) throw new PathError('NO_FLIP', 'There is no other version of this question to flip to.', 409);
      const n = await itemAt(q.skill, q.level, q.difficulty, q.type, others[crypto.randomInt(others.length)]);
      const st = await loadState(user.id), s = st.sk[q.skill];
      if (s && r.mode === 'hotseat') { const key = `${q.level}-${q.type}-${q.difficulty}`; s.v[key] = (s.v[key] || 0) + 1; await run('UPDATE kbc_path SET state = ? WHERE user_id = ?', JSON.stringify(st), user.id); }
      const shown = Date.now() + config.game.introMs;
      await run('UPDATE kbc_path_runs SET used = ?, removed = ?, hint = NULL, item_id = ?, item_version = ?, shown_at = ?, deadline = ? WHERE id = ?',
        JSON.stringify(used), '[]', n.id, n.version, shown, shown + secsFor(n) * 1000, r.id);
    }
    return { lifeline: k, run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id)) };
  });
}

export async function quitRun(user, id) {
  return withLock(id, async () => {
    const r = await loadRun(user.id, id);
    if (r.state === 'play') await finishRun(r, 'stop');
    return { run: await runView(await one('SELECT * FROM kbc_path_runs WHERE id = ?', r.id)), path: await pathView(user) };
  });
}

// ---------------------------------------------------------------- admin views
export async function bankSummary() {
  const rows = await all("SELECT skill, type, status, COUNT(*) AS n FROM kbc_items GROUP BY skill, type, status");
  const stats = await all('SELECT i.skill, SUM(s.n) AS n, SUM(s.ok) AS ok FROM kbc_item_stats s JOIN kbc_items i ON i.id = s.id GROUP BY i.skill');
  return { rows: rows.map((r) => ({ skill: r.skill, type: r.type, status: r.status, n: Number(r.n) })), stats: stats.map((s) => ({ skill: s.skill, n: Number(s.n || 0), ok: Number(s.ok || 0) })),
    graph: { checkpoints: GRAPH.checkpoints, groups: GRAPH.groups, skills: GRAPH.skills.map((s) => ({ id: s.id, name: s.name, group: s.group, cp: s.cp, rmax: s.rmax })) }, types: QTYPES.types };
}
export async function listItems({ skill = '', type = '', status = '', q = '', page = 1, size = 50 } = {}) {
  const where = [], args = [];
  if (skill) { where.push('skill = ?'); args.push(skill); }
  if (type) { where.push('type = ?'); args.push(type); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(id ILIKE ? OR data ILIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = Number((await one('SELECT COUNT(*) AS n FROM kbc_items' + w, ...args)).n);
  page = Math.max(1, Number(page) || 1);
  const rows = await all(`SELECT i.id, i.skill, i.level, i.type, i.r, i.variant, i.status, i.version, i.updated_at, i.data, s.n, s.ok, s.shown FROM kbc_items i LEFT JOIN kbc_item_stats s ON s.id = i.id${w.replace(/\b(skill|type|status|id|data) /g, 'i.$1 ')}
                          ORDER BY i.skill, i.level, i.type, i.r, i.variant LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size);
  return { total, page, size, rows: rows.map((r) => ({ id: r.id, skill: r.skill, level: r.level, type: r.type, r: r.r, variant: r.variant, status: r.status, version: r.version, updatedAt: Number(r.updated_at),
    task: (parseJSON(r.data, {}).task || '').slice(0, 160), n: Number(r.n || 0), ok: Number(r.ok || 0), shown: Number(r.shown || 0) })) };
}
