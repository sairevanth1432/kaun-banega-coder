// The game engine. The server owns every game: it deals the questions, keeps the clock, checks each answer and
// runs the lifelines. Players only ever receive the question text and the 4 options in a shuffled order; the
// correct option, hint and explanation stay here until the answer is locked in.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, all, run, tx, parseJSON } from './db.js';
import * as kv from './kv.js';
import { getLadder, publicLadder } from './ladder.js';
import { poolFor, skillPool, questionAt } from './bank.js';
import { getEvent, phaseOf } from './events.js';

export class GameError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

// ---------- seeded randomness (pattern from saturday-sprint's attemptOrder): reproducible from the game's seed
function rng(seed) {
  let n = 0;
  return () => {
    const h = crypto.createHash('sha256').update(seed + ':' + n++).digest();
    return h.readUInt32BE(0) / 2 ** 32;
  };
}
const shuffle = (arr, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickOne = (arr, r) => arr[Math.floor(r() * arr.length)];

const SEEN_KEEP = 200;            // a player's recently seen questions are skipped while the pool has others
const FFF_SECONDS = 30;
export const BADGES = {
  speed: ['Fastest Finger', 'Qualified in under 10 s'],
  pure: ['No Lifelines', 'Cleared every open rung without a lifeline'],
  quick: ['Quick Thinker', 'Cleared every open rung in under 3 minutes'],
  regular: ['Regular', 'Played 5 games']
};

// ---------- profile
export async function profile(userId) {
  const p = await one('SELECT * FROM kbc_profiles WHERE user_id = ?', userId);
  return {
    coins: Number(p?.coins || 0), games: Number(p?.games || 0), best: Number(p?.best || 0), bestReached: Number(p?.best_reached || 0),
    correct: Number(p?.correct || 0), answered: Number(p?.answered || 0), badges: parseJSON(p?.badges, []) || [], seen: parseJSON(p?.seen, []) || []
  };
}
export async function history(userId, limit = 20) {
  return (await all(`SELECT id, mode, event_id, amount, coins, correct, reason, secs, started_at, ended_at FROM kbc_games
                     WHERE user_id = ? AND state = 'done' ORDER BY started_at DESC LIMIT ?`, userId, limit))
    .map((g) => ({ id: g.id, mode: g.mode, eventId: g.event_id, amount: Number(g.amount), coins: Number(g.coins), reached: g.correct, reason: g.reason, secs: g.secs, at: Number(g.ended_at || g.started_at) }));
}

// ---------- views sent to the player
async function publicQuestion(entry, rung) {
  const q = await questionAt(entry.qid, entry.version);
  return { rung, id: entry.qid, checkpoint: q.checkpoint, skill: q.skill, type: q.type, q: q.q, code: q.code, options: entry.perm.map((i) => q.options[i]) };
}

async function view(g, ladder) {
  const plan = parseJSON(g.plan, []);
  const v = {
    id: g.id, mode: g.mode, eventId: g.event_id, state: g.state, level: g.level, length: plan.length,
    used: parseJSON(g.used, {}), removed: parseJSON(g.removed, []), serverNow: Date.now(), deadline: g.deadline ? Number(g.deadline) : null,
    shownAt: g.q_shown_at ? Number(g.q_shown_at) : null, timeSec: ladder.rungs[g.level] ? ladder.rungs[g.level].timeSec : null,
    question: null, result: null
  };
  if (g.state === 'play' && g.q_shown_at) v.question = await publicQuestion(plan[g.level], g.level);
  if (g.state === 'done') v.result = await resultOf(g, ladder);
  return v;
}

async function loadOwn(userId, gameId) {
  const g = await one('SELECT * FROM kbc_games WHERE id = ?', String(gameId || ''));
  if (!g || Number(g.user_id) !== userId) throw new GameError('NOT_FOUND', 'Game not found.', 404);
  return g;
}

// One request at a time per game: a double-click or a retried request cannot answer twice.
async function withLock(gameId, fn) {
  const key = 'lock:game:' + gameId;
  if (!(await kv.setNX(key, 1, 10))) throw new GameError('BUSY', 'Still working on your last move.', 409);
  try { return await fn(); } finally { await kv.del(key).catch(() => {}); }
}

// ---------- amounts, coins, badges
const banked = (ladder, level) => (level > 0 ? ladder.rungs[level - 1].amount : 0);
function safeAmount(ladder, level) {
  let amt = 0;
  for (let i = 0; i < level; i++) if (ladder.rungs[i].checkpoint) amt = ladder.rungs[i].amount;
  return amt;
}

async function resultOf(g, ladder) {
  const log = (await all('SELECT rung, qid, version, ok FROM kbc_answers WHERE game_id = ? ORDER BY rung', g.id));
  const skills = [];
  for (const a of log) skills.push({ rung: a.rung, skill: (await questionAt(Number(a.qid), a.version)).skill, ok: !!a.ok });
  const d = parseJSON(g.result_detail, null);
  return { amount: Number(g.amount), coins: Number(g.coins), correct: g.correct, reason: g.reason, secs: g.secs, length: parseJSON(g.plan, []).length,
    lifelinesUsed: Object.keys(parseJSON(g.used, {})).length, log: skills, ...(d || {}) };
}

// Ends a game: amount, coins, badges and the player's profile, in one transaction.
async function finish(g, reason, ladder) {
  const plan = parseJSON(g.plan, []), used = Object.keys(parseJSON(g.used, {})), now = Date.now();
  const correct = reason === 'win' ? plan.length : g.level;
  const amount = reason === 'win' ? ladder.rungs[plan.length - 1].amount : reason === 'quit' ? banked(ladder, g.level) : safeAmount(ladder, g.level);
  const secs = Math.round((now - Number(g.started_at)) / 1000);
  const ranked = g.mode !== 'practice';
  const fffBonus = ranked && g.fff_secs && g.fff_secs <= 15 ? 2000 : 0;
  const saveBonus = ranked && correct > 2 ? Math.max(0, ladder.lifelines.length - used.length) * 1000 : 0;
  const coins = ranked ? amount + fffBonus + saveBonus : 0;
  return tx(async () => {
    const won = await one("UPDATE kbc_games SET state = 'done', reason = ?, amount = ?, correct = ?, coins = ?, secs = ?, ended_at = ?, q_shown_at = NULL, deadline = NULL WHERE id = ? AND state = 'play' RETURNING id",
      reason, amount, correct, coins, secs, now, g.id);
    if (!won) return;   // already finished by another request
    const p = await profile(g.user_id), newBadges = [];
    const add = (k) => { if (!p.badges.includes(k)) { p.badges.push(k); newBadges.push(k); } };
    if (ranked) {
      ladder.rungs.forEach((r, i) => { if (r.checkpoint && correct > i) add(r.checkpoint.toLowerCase()); });
      if (g.fff_secs && g.fff_secs <= 10) add('speed');
      if (correct >= plan.length && !used.length) add('pure');
      if (correct >= plan.length && secs < 180) add('quick');
      if (p.games + 1 >= 5) add('regular');
    }
    const answers = await one('SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM kbc_answers WHERE game_id = ?', g.id);
    const seen = [...p.seen.filter((q) => !plan.some((e) => e.qid === q)), ...plan.map((e) => e.qid)].slice(-SEEN_KEEP);
    await run(`INSERT INTO kbc_profiles (user_id, coins, games, best, best_reached, correct, answered, badges, seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id) DO UPDATE SET coins = excluded.coins, games = excluded.games, best = excluded.best, best_reached = excluded.best_reached,
               correct = excluded.correct, answered = excluded.answered, badges = excluded.badges, seen = excluded.seen, updated_at = excluded.updated_at`,
      g.user_id, p.coins + coins, p.games + (ranked ? 1 : 0), ranked ? Math.max(p.best, amount) : p.best, ranked ? Math.max(p.bestReached, correct) : p.bestReached,
      p.correct + Number(answers.ok), p.answered + Number(answers.n), JSON.stringify(p.badges), JSON.stringify(seen), now);
    const detail = { breakdown: { amount, fff: fffBonus, save: saveBonus }, newBadges, wallet: p.coins + coins,
      code: crypto.createHash('sha256').update(g.id + '|' + amount).digest('hex').slice(0, 6).toUpperCase() };
    await run('UPDATE kbc_games SET result_detail = ? WHERE id = ?', JSON.stringify(detail), g.id);
    await kv.invalidate('kbc:board:' + (g.event_id || '')).catch(() => {});
  });
}

// A question whose clock ran out while the player was away counts as a time-out.
async function expireIfLate(g, ladder) {
  if (g.state !== 'play' || !g.deadline || Date.now() <= Number(g.deadline) + config.game.graceMs) return g;
  const entry = parseJSON(g.plan, [])[g.level];
  await tx(async () => {
    const ins = await one('INSERT INTO kbc_answers (game_id, rung, qid, version, pick, ok, ms, lifelines, at) VALUES (?, ?, ?, ?, -1, 0, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING rung',
      g.id, g.level, entry.qid, entry.version, ladder.rungs[g.level].timeSec * 1000, '[]', Date.now());
    if (ins) await run('INSERT INTO kbc_qstats (qid, n, timeouts, total_ms) VALUES (?, 1, 1, ?) ON CONFLICT (qid) DO UPDATE SET n = kbc_qstats.n + 1, timeouts = kbc_qstats.timeouts + 1, total_ms = kbc_qstats.total_ms + excluded.total_ms',
      entry.qid, ladder.rungs[g.level].timeSec * 1000);
  });
  await finish(g, 'timeout', ladder);
  return one('SELECT * FROM kbc_games WHERE id = ?', g.id);
}

// ---------- dealing
async function candidatesFor(g, ladder, event, rung, skill) {
  if (event && event.mode === 'fixed') {
    const out = [];
    for (const qid of event.fixed[rung] || []) {
      const r = await one("SELECT version FROM kbc_questions WHERE id = ? AND status = 'published'", qid);
      if (r) out.push([qid, Number(r.version)]);
    }
    return out;
  }
  if (g.mode === 'practice') return skill;   // pre-split bands, see startGame
  return poolFor(ladder.rungs[rung].rule);
}

const markShown = (qid) => run('INSERT INTO kbc_qstats (qid, shown) VALUES (?, 1) ON CONFLICT (qid) DO UPDATE SET shown = kbc_qstats.shown + 1', qid);

export async function startGame(user, { mode = 'classic', eventId = '', fffRunId = '', skill = '' } = {}) {
  const ladder = await getLadder();
  const lim = await kv.rateLimit('game-start:' + user.id, config.game.maxGamesPerHour, 3600000);
  if (!lim.ok) throw new GameError('RATE_LIMIT', 'You have started a lot of games this hour. Take a short break and come back.', 429);
  if (!['classic', 'practice', 'event'].includes(mode)) throw new GameError('BAD_MODE', 'Unknown game mode.');
  let event = null;
  if (mode === 'event') {
    event = await getEvent(eventId);
    if (!event) throw new GameError('NO_EVENT', 'That event does not exist.', 404);
    const ph = phaseOf({ open_at: event.openAt, close_at: event.closeAt });
    if (ph === 'upcoming') throw new GameError('NOT_OPEN', 'This event has not opened yet.', 409, { openAt: event.openAt });
    if (ph === 'ended') throw new GameError('CLOSED', 'This event has ended.', 409);
    const n = Number((await one('SELECT COUNT(*) AS n FROM kbc_games WHERE user_id = ? AND event_id = ?', user.id, event.id)).n);
    if (event.attemptsAllowed && n >= event.attemptsAllowed) throw new GameError('NO_ATTEMPTS', event.attemptsAllowed === 1 ? 'You have already played this event.' : `You have used all ${event.attemptsAllowed} attempts for this event.`, 409);
  }

  // Close any game left open (closed tab, lost connection): it ends as if the clock ran out.
  for (const old of await all("SELECT * FROM kbc_games WHERE user_id = ? AND state = 'play'", user.id)) await finish(old, 'abandoned', ladder);

  const seed = crypto.randomBytes(16).toString('hex'), r = rng(seed);
  const seen = new Set((await profile(user.id)).seen);
  const g = { id: crypto.randomBytes(12).toString('base64url'), mode, user_id: user.id };
  let length = ladder.openRungs, bands = null;
  if (mode === 'practice') {
    const pool = await skillPool(String(skill || '').toUpperCase());
    if (!pool.length) throw new GameError('POOL_EMPTY', 'There are no questions for that skill yet.', 409);
    length = Math.min(ladder.openRungs, pool.length);
    bands = Array.from({ length }, (_, i) => pool.slice(Math.floor((i * pool.length) / length), Math.floor(((i + 1) * pool.length) / length)).map((p) => [p[0], p[1]]));
  }
  const plan = [], taken = new Set();
  for (let i = 0; i < length; i++) {
    const cands = await candidatesFor(g, ladder, event, i, bands && bands[i]);
    const free = cands.filter((c) => !taken.has(c[0]));
    if (!free.length) throw new GameError('POOL_EMPTY', `Rung ${i + 1} has no questions to play yet. Ask an admin to publish more.`, 503);
    const fresh = free.filter((c) => !seen.has(c[0]));
    const [qid, version] = pickOne(fresh.length ? fresh : free, r);
    taken.add(qid);
    plan.push({ qid, version, perm: shuffle([0, 1, 2, 3], r) });
  }

  let fffSecs = 0;
  if (fffRunId && mode !== 'practice') {
    const f = await one('UPDATE kbc_fff_runs SET used = 1 WHERE id = ? AND user_id = ? AND ok = 1 AND used = 0 RETURNING secs', String(fffRunId), user.id);
    if (f) fffSecs = Number(f.secs);
  }
  const now = Date.now(), shownAt = now + config.game.introMs;
  await run(`INSERT INTO kbc_games (id, user_id, event_id, mode, seed, plan, level, q_shown_at, deadline, fff_secs, started_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    g.id, user.id, event ? event.id : '', mode, seed, JSON.stringify(plan), shownAt, shownAt + ladder.rungs[0].timeSec * 1000, fffSecs, now);
  await markShown(plan[0].qid);
  return { game: await view(await one('SELECT * FROM kbc_games WHERE id = ?', g.id), ladder), ladder: publicLadder(ladder) };
}

export async function getGame(user, gameId) {
  const ladder = await getLadder();
  let g = await loadOwn(user.id, gameId);
  g = await expireIfLate(g, ladder);
  return { game: await view(g, ladder), ladder: publicLadder(ladder) };
}

// The player locks in an option (its position on screen), or pick = null when their clock runs out.
export async function answer(user, gameId, { rung, pick }) {
  return withLock(gameId, async () => {
    const ladder = await getLadder();
    let g = await loadOwn(user.id, gameId);
    g = await expireIfLate(g, ladder);
    if (g.state !== 'play') return { timeUp: g.reason === 'timeout', game: await view(g, ladder) };
    if (Number(rung) !== g.level || !g.q_shown_at) throw new GameError('STALE', 'That question is no longer on screen.', 409);
    const plan = parseJSON(g.plan, []), entry = plan[g.level], q = await questionAt(entry.qid, entry.version);
    const now = Date.now(), ms = Math.max(0, Math.min(now - Number(g.q_shown_at), ladder.rungs[g.level].timeSec * 1000));
    const timeout = pick == null;
    const shown = timeout ? -1 : Number(pick);
    if (!timeout && (!Number.isInteger(shown) || shown < 0 || shown > 3 || parseJSON(g.removed, []).includes(shown)))
      throw new GameError('BAD_PICK', 'Pick one of the options on screen.');
    if (timeout && now < Number(g.deadline) - 2000) throw new GameError('TOO_EARLY', 'There is still time on the clock.', 409);
    const orig = timeout ? -1 : entry.perm[shown];
    const ok = orig === q.correct;
    const usedHere = Object.entries(parseJSON(g.used, {})).filter(([, v]) => v === g.level).map(([k]) => k);
    await tx(async () => {
      await run('INSERT INTO kbc_answers (game_id, rung, qid, version, pick, ok, ms, lifelines, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        g.id, g.level, entry.qid, entry.version, orig, ok ? 1 : 0, ms, JSON.stringify(usedHere), now);
      const p = [0, 1, 2, 3].map((i) => (orig === i ? 1 : 0));
      await run(`INSERT INTO kbc_qstats (qid, n, ok, timeouts, p0, p1, p2, p3, total_ms) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (qid) DO UPDATE SET n = kbc_qstats.n + 1, ok = kbc_qstats.ok + excluded.ok, timeouts = kbc_qstats.timeouts + excluded.timeouts,
                 p0 = kbc_qstats.p0 + excluded.p0, p1 = kbc_qstats.p1 + excluded.p1, p2 = kbc_qstats.p2 + excluded.p2, p3 = kbc_qstats.p3 + excluded.p3,
                 total_ms = kbc_qstats.total_ms + excluded.total_ms`, entry.qid, ok ? 1 : 0, timeout ? 1 : 0, ...p, ms);
      if (ok) await run('UPDATE kbc_games SET level = level + 1, removed = ?, q_shown_at = NULL, deadline = NULL WHERE id = ?', '[]', g.id);
    });
    const reveal = { ok, pick: shown, correct: entry.perm.indexOf(q.correct), why: q.why, timeUp: timeout };
    g = await one('SELECT * FROM kbc_games WHERE id = ?', g.id);
    if (!ok) await finish(g, timeout ? 'timeout' : 'wrong', ladder);
    else if (g.level >= plan.length) await finish(g, 'win', ladder);
    else {
      const ci = g.level - 1;
      reveal.safePoint = ladder.rungs[ci].checkpoint ? { checkpoint: ladder.rungs[ci].checkpoint, amount: ladder.rungs[ci].amount } : null;
    }
    return { reveal, game: await view(await one('SELECT * FROM kbc_games WHERE id = ?', g.id), ladder) };
  });
}

// "Agla sawaal": shows the next question and starts its clock.
export async function nextQuestion(user, gameId) {
  return withLock(gameId, async () => {
    const ladder = await getLadder();
    const g = await loadOwn(user.id, gameId);
    if (g.state !== 'play') throw new GameError('OVER', 'This game is over.', 409);
    if (!g.q_shown_at) {
      const shownAt = Date.now() + config.game.introMs;
      await run('UPDATE kbc_games SET q_shown_at = ?, deadline = ? WHERE id = ?', shownAt, shownAt + ladder.rungs[g.level].timeSec * 1000, g.id);
      await markShown(parseJSON(g.plan, [])[g.level].qid);
    }
    return { game: await view(await one('SELECT * FROM kbc_games WHERE id = ?', g.id), ladder) };
  });
}

// Audience poll when too few players have answered this question: a believable spread that leans to the right answer.
function estimatePoll(level, correctShown, r) {
  const t = level < 3 ? 0 : level < 5 ? 1 : 2, base = [[55, 75], [42, 60], [32, 50]][t];
  const right = base[0] + r() * (base[1] - base[0]);
  const rest = [r(), r(), r()], sum = rest.reduce((a, b) => a + b, 0) || 1;
  const out = [0, 0, 0, 0];
  let k = 0;
  for (let i = 0; i < 4; i++) out[i] = i === correctShown ? right : ((100 - right) * rest[k++]) / sum;
  return out.map((v) => Math.round(v));
}

export async function lifeline(user, gameId, k) {
  return withLock(gameId, async () => {
    const ladder = await getLadder();
    let g = await loadOwn(user.id, gameId);
    g = await expireIfLate(g, ladder);
    if (g.state !== 'play' || !g.q_shown_at) throw new GameError('NO_QUESTION', 'There is no question on screen.', 409);
    if (!ladder.lifelines.includes(k)) throw new GameError('BAD_LIFELINE', 'That lifeline is not available.');
    const used = parseJSON(g.used, {});
    if (used[k] != null) throw new GameError('USED', 'You have already used that lifeline.', 409);
    const plan = parseJSON(g.plan, []), entry = plan[g.level], q = await questionAt(entry.qid, entry.version);
    const correctShown = entry.perm.indexOf(q.correct), r = rng(g.seed + ':ll:' + k + ':' + g.level);
    let removed = parseJSON(g.removed, []), data = {};
    if (k === 'fifty') {
      removed = shuffle([0, 1, 2, 3].filter((i) => i !== correctShown && !removed.includes(i)), r).slice(0, 2);
      data = { removed };
    } else if (k === 'poll') {
      const s = await one('SELECT * FROM kbc_qstats WHERE qid = ?', entry.qid);
      const picks = s ? [s.p0, s.p1, s.p2, s.p3].map(Number) : [0, 0, 0, 0], n = picks.reduce((a, b) => a + b, 0);
      data = n >= 5 ? { live: true, n, raw: entry.perm.map((o) => picks[o]) } : { live: false, raw: estimatePoll(g.level, correctShown, r) };
      data.raw = data.raw.map((v, i) => (removed.includes(i) ? 0 : v));
    } else if (k === 'expert') {
      data = { hint: q.hint || 'Read every option slowly and rule out the ones that cannot be true.' };
    } else if (k === 'flip') {
      const event = g.event_id ? await getEvent(g.event_id) : null;
      let cands;
      if (g.mode === 'practice') cands = (await skillPool(q.skill)).map((p) => [p[0], p[1]]);
      else cands = await candidatesFor(g, ladder, event, g.level, null);
      const free = cands.filter((c) => !plan.some((e) => e.qid === c[0]));
      if (!free.length) throw new GameError('NO_FLIP', 'There is no other question at this rung to flip to.', 409);
      const [qid, version] = pickOne(free, r);
      plan[g.level] = { qid, version, perm: shuffle([0, 1, 2, 3], r), flippedFrom: entry.qid };
      removed = [];
    }
    used[k] = g.level;
    const now = Date.now();
    await tx(async () => {
      await run(`INSERT INTO kbc_qstats (qid, ll_${k}) VALUES (?, 1) ON CONFLICT (qid) DO UPDATE SET ll_${k} = kbc_qstats.ll_${k} + 1`, entry.qid);
      if (k === 'flip') {
        const shownAt = now + config.game.introMs;
        await run('UPDATE kbc_games SET used = ?, removed = ?, plan = ?, q_shown_at = ?, deadline = ? WHERE id = ?',
          JSON.stringify(used), '[]', JSON.stringify(plan), shownAt, shownAt + ladder.rungs[g.level].timeSec * 1000, g.id);
        await markShown(plan[g.level].qid);
      } else await run('UPDATE kbc_games SET used = ?, removed = ? WHERE id = ?', JSON.stringify(used), JSON.stringify(removed), g.id);
    });
    return { lifeline: k, data, game: await view(await one('SELECT * FROM kbc_games WHERE id = ?', g.id), ladder) };
  });
}

// Walk away with the amount already won (only between locking answers).
export async function quit(user, gameId) {
  return withLock(gameId, async () => {
    const ladder = await getLadder();
    let g = await loadOwn(user.id, gameId);
    g = await expireIfLate(g, ladder);
    if (g.state === 'play') { await finish(g, 'quit', ladder); g = await one('SELECT * FROM kbc_games WHERE id = ?', g.id); }
    return { game: await view(g, ladder) };
  });
}

// ---------- Fastest Finger First
export async function fffStart(user) {
  const rows = await all("SELECT id, task, lines FROM kbc_fff WHERE status = 'published'");
  if (!rows.length) throw new GameError('NO_FFF', 'No Fastest Finger puzzles yet.', 409);
  const r = rng(crypto.randomBytes(8).toString('hex'));
  const p = pickOne(rows, r), perm = shuffle([0, 1, 2, 3], r), lines = parseJSON(p.lines, []);
  const id = crypto.randomBytes(12).toString('base64url'), now = Date.now();
  await run('INSERT INTO kbc_fff_runs (id, user_id, fff_id, perm, started_at) VALUES (?, ?, ?, ?, ?)', id, user.id, p.id, JSON.stringify(perm), now);
  return { runId: id, task: p.task, lines: perm.map((i) => lines[i]), timeSec: FFF_SECONDS, serverNow: now, deadline: now + FFF_SECONDS * 1000 };
}

// order: the shown line positions in the order the player put them.
export async function fffSubmit(user, runId, order) {
  const run1 = await one('SELECT * FROM kbc_fff_runs WHERE id = ? AND user_id = ?', String(runId || ''), user.id);
  if (!run1) throw new GameError('NOT_FOUND', 'Puzzle not found.', 404);
  if (run1.done_at) throw new GameError('DONE', 'You already answered this puzzle.', 409);
  const p = await one('SELECT answer FROM kbc_fff WHERE id = ?', run1.fff_id);
  const perm = parseJSON(run1.perm, []), now = Date.now(), secs = (now - Number(run1.started_at)) / 1000;
  const want = [...String(p.answer)].map((c) => c.charCodeAt(0) - 65);           // original line indices, in order
  const valid = Array.isArray(order) && order.length === 4 && new Set(order).size === 4 && order.every((i) => Number.isInteger(i) && i >= 0 && i < 4);
  const timeUp = secs > FFF_SECONDS + config.game.graceMs / 1000;
  const ok = valid && !timeUp && order.every((s, k) => perm[s] === want[k]);
  await run('UPDATE kbc_fff_runs SET done_at = ?, ok = ?, secs = ? WHERE id = ?', now, ok ? 1 : 0, secs, run1.id);
  return { ok, timeUp, secs: Math.round(secs * 10) / 10, answer: want.map((o) => perm.indexOf(o)), bonus: ok && secs <= 15 ? 2000 : 0 };
}

// ---------- leaderboards: each player's best game, ranked by amount, then rungs, then time.
const BOARD_SQL = `
  WITH best AS (
    SELECT DISTINCT ON (g.user_id) g.user_id, g.amount, g.correct, g.secs, g.ended_at
    FROM kbc_games g WHERE g.event_id = ? AND g.mode <> 'practice' AND g.state = 'done' AND g.hidden = 0
    ORDER BY g.user_id, g.amount DESC, g.correct DESC, g.secs ASC
  )
  SELECT b.*, u.roll_no, COALESCE(NULLIF(u.display_name, ''), m.name, u.roll_no) AS name, m.university,
         RANK() OVER (ORDER BY b.amount DESC, b.correct DESC, b.secs ASC) AS rank
  FROM best b JOIN users u ON u.id = b.user_id JOIN students_master m ON m.roll_no = u.roll_no`;

export async function boardRows(eventId = '', limit = 100) {
  return (await all(BOARD_SQL + ' ORDER BY rank, b.ended_at LIMIT ?', String(eventId || ''), limit))
    .map((r) => ({ userId: Number(r.user_id), rollNo: r.roll_no, name: r.name, university: r.university, amount: Number(r.amount), reached: r.correct, secs: r.secs, rank: Number(r.rank), at: Number(r.ended_at) }));
}
export async function leaderboard(user, eventId = '') {
  const top = await kv.cached('kbc:board:' + (eventId || ''), 5, () => boardRows(eventId, 50));
  let me = top.find((r) => r.userId === user.id) || null;
  if (!me) {
    const all1 = await all(`SELECT * FROM (${BOARD_SQL}) t WHERE t.user_id = ?`, String(eventId || ''), user.id);
    if (all1[0]) me = { userId: user.id, name: all1[0].name, amount: Number(all1[0].amount), reached: all1[0].correct, secs: all1[0].secs, rank: Number(all1[0].rank) };
  }
  const strip = (r) => r && ({ name: r.name, university: r.university, amount: r.amount, reached: r.reached, secs: r.secs, rank: r.rank, me: r.userId === user.id });
  return { rows: top.map(strip), me: strip(me) };
}
