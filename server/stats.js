// Admin analytics: per-question health (read from the kbc_qstats running totals), plays over time, the ladder
// funnel and per-skill accuracy.
import { one, all, parseJSON } from './db.js';
import { getLadder } from './ladder.js';
import { poolSizes, counts } from './bank.js';

export const MIN_SAMPLE = 20;   // fewer answers than this: too early to flag a question
const flagsOf = (s) => {
  const f = [];
  if (s.n < MIN_SAMPLE) return f;
  const answered = s.n - s.timeouts;
  if (s.pct >= 95) f.push('too_easy');
  if (s.pct <= 15) f.push('too_hard');
  if (answered >= MIN_SAMPLE && s.picks.some((p, i) => i !== s.correct && p / answered < 0.03)) f.push('dead_distractor');
  if (s.correct != null && s.picks.some((p, i) => i !== s.correct && p > s.picks[s.correct])) f.push('popular_wrong');
  if (s.timeouts / s.n >= 0.2) f.push('slow');
  return f;
};
export const FLAG_LABELS = { too_easy: 'Too easy (≥95% right)', too_hard: 'Too hard (≤15% right)', dead_distractor: 'An option almost nobody picks', popular_wrong: 'A wrong option beats the right one', slow: '20%+ run out of time' };

export async function questionStats({ checkpoint = '', flag = '', sort = 'n', page = 1, size = 50 } = {}) {
  const where = ['s.n > 0'], p = [];
  if (checkpoint) { where.push('q.checkpoint = ?'); p.push(checkpoint); }
  const rows = await all(`SELECT q.id, q.ext_id, q.status, q.checkpoint, q.skill, q.difficulty, q.q, q.correct, q.options,
                                 s.n, s.ok, s.timeouts, s.p0, s.p1, s.p2, s.p3, s.total_ms, s.shown, s.ll_fifty, s.ll_poll, s.ll_expert, s.ll_flip
                          FROM kbc_qstats s JOIN kbc_questions q ON q.id = s.qid WHERE ${where.join(' AND ')}`, ...p);
  let out = rows.map((r) => {
    const n = Number(r.n), s = {
      id: Number(r.id), extId: r.ext_id, status: r.status, checkpoint: r.checkpoint, skill: r.skill, difficulty: Number(r.difficulty), q: r.q.slice(0, 160),
      options: parseJSON(r.options, []), correct: Number(r.correct), n, ok: Number(r.ok), timeouts: Number(r.timeouts),
      picks: [r.p0, r.p1, r.p2, r.p3].map(Number), pct: n ? Math.round((Number(r.ok) * 1000) / n) / 10 : 0,
      avgSec: n ? Math.round(Number(r.total_ms) / n / 100) / 10 : 0, shown: Number(r.shown),
      lifelines: { fifty: Number(r.ll_fifty), poll: Number(r.ll_poll), expert: Number(r.ll_expert), flip: Number(r.ll_flip) }
    };
    s.flags = flagsOf(s);
    return s;
  });
  if (flag) out = out.filter((s) => s.flags.includes(flag));
  const SORT = { n: (a, b) => b.n - a.n, hardest: (a, b) => a.pct - b.pct, easiest: (a, b) => b.pct - a.pct, slowest: (a, b) => b.avgSec - a.avgSec, flipped: (a, b) => b.lifelines.flip - a.lifelines.flip };
  out.sort(SORT[sort] || SORT.n);
  size = Math.min(200, Math.max(1, Number(size) || 50)); page = Math.max(1, Number(page) || 1);
  const flagCounts = {};
  for (const s of out) for (const f of s.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  return { total: out.length, page, size, rows: out.slice((page - 1) * size, page * size), flagCounts, minSample: MIN_SAMPLE };
}

const DAY = 86400000;
const istDay = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

export async function overview() {
  const ladder = await getLadder(), now = Date.now();
  const [bank, sizes] = await Promise.all([counts(), poolSizes(ladder)]);
  const since = now - 14 * DAY;
  const games = await all('SELECT started_at, mode, correct, state, reason, user_id FROM kbc_games WHERE started_at >= ?', since);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push({ day: istDay(now - i * DAY), games: 0, players: new Set() });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const g of games) { const d = byDay.get(istDay(Number(g.started_at))); if (d) { d.games++; d.players.add(Number(g.user_id)); } }
  const today = days[days.length - 1];
  // Funnel: of finished ranked games in the last 14 days, how many cleared each open rung.
  const done = games.filter((g) => g.state === 'done' && g.mode !== 'practice');
  const funnel = ladder.rungs.slice(0, ladder.openRungs).map((r, i) => ({ rung: i + 1, amount: r.amount, checkpoint: r.checkpoint, reached: done.filter((g) => g.correct >= i).length, cleared: done.filter((g) => g.correct > i).length }));
  const skills = await all(`SELECT q.skill, COUNT(*) AS n, SUM(a.ok) AS ok FROM kbc_answers a JOIN kbc_questions q ON q.id = a.qid
                            WHERE a.at >= ? GROUP BY q.skill ORDER BY q.skill`, now - 30 * DAY);
  const totals = await one(`SELECT (SELECT COUNT(*) FROM kbc_games) AS games, (SELECT COUNT(DISTINCT user_id) FROM kbc_games) AS players,
                                   (SELECT COUNT(*) FROM users) AS accounts, (SELECT COUNT(*) FROM students_master WHERE active = 1) AS roster`);
  return {
    bank, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
    today: { games: today.games, players: today.players.size },
    daily: days.map((d) => ({ day: d.day, games: d.games, players: d.players.size })),
    pools: ladder.rungs.map((r, i) => ({ rung: i + 1, amount: r.amount, open: i < ladder.openRungs, rule: r.rule, size: sizes[i] })),
    funnel, skills: skills.map((s) => ({ skill: s.skill, n: Number(s.n), pct: Number(s.n) ? Math.round((Number(s.ok) * 100) / Number(s.n)) : 0 }))
  };
}
