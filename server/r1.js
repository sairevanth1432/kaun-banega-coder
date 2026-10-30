// The student game (public/play.html) runs its question engine and skill path in the browser. The server keeps what
// has to outlive a browser or be shared between students: each player's saved progress, the Hall of Fame (overall
// and per university), who is online right now, and feedback/usage events.
import { one, all, run } from './db.js';
import * as kv from './kv.js';

const LADDER_TOP = 7e7, RUNGS = 15;      // must match LADDER in play.html
const LIVE_MS = 75000;                    // a player counts as live if their page pinged in the last 75 s
const MAX_STATE = 200000;                 // bytes of saved progress per player

export class R1Error extends Error {
  constructor(message, status = 400) { super(message); this.code = 'BAD_R1'; this.status = status; }
}

const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

// Leaderboard numbers come from the browser, so keep them inside what real games can produce:
// right <= answered, best <= 15 rungs, wallet <= right answers x (7 crore / 15).
function fameFields(p) {
  const answered = int(p.answered, 1e6), correct = Math.min(int(p.correct, 1e6), answered);
  const best = int(p.best, RUNGS), coins = Math.min(int(p.coins, 1e12), Math.ceil((correct * LADDER_TOP) / RUNGS));
  return { coins, best, correct, answered, runs: int(p.runs, 1e6) };
}

export async function getState(userId) {
  const r = await one('SELECT data, updated_at FROM kbc_r1_state WHERE user_id = ?', userId);
  return r ? { data: r.data, t: Number(r.updated_at) } : null;
}

export async function saveState(userId, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data || {});
  if (text.length > MAX_STATE) throw new R1Error('Progress is too large to save.', 413);
  let p;
  try { p = JSON.parse(text); } catch { throw new R1Error('Progress must be JSON.'); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new R1Error('Progress must be an object.');
  const f = fameFields(p), now = Date.now();
  await run(`INSERT INTO kbc_r1_state (user_id, data, coins, best, correct, answered, runs, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, coins = excluded.coins, best = excluded.best, correct = excluded.correct,
             answered = excluded.answered, runs = excluded.runs, updated_at = excluded.updated_at, last_seen = excluded.last_seen`,
    userId, text, f.coins, f.best, f.correct, f.answered, f.runs, now, now);
  return { t: now };
}

export async function ping(userId) {
  const now = Date.now();
  await run(`INSERT INTO kbc_r1_state (user_id, updated_at, last_seen) VALUES (?, 0, ?)
             ON CONFLICT (user_id) DO UPDATE SET last_seen = excluded.last_seen`, userId, now);
  return { live: await liveCount() };
}

export const liveCount = () => kv.cached('kbc:r1:live', 5, async () =>
  Number((await one('SELECT COUNT(*) AS n FROM kbc_r1_state WHERE last_seen > ?', Date.now() - LIVE_MS)).n));

const FAME_SQL = `
  SELECT s.user_id, s.coins, s.best, s.correct, s.answered, s.updated_at,
         COALESCE(NULLIF(u.display_name, ''), m.name, u.roll_no) AS name, m.university
  FROM kbc_r1_state s JOIN users u ON u.id = s.user_id JOIN students_master m ON m.roll_no = u.roll_no
  WHERE s.answered > 0 AND u.status = 'active'`;
const ORDER = ' ORDER BY s.coins DESC, s.best DESC, s.correct DESC, s.updated_at ASC';
const shape = (r, me) => ({ name: r.name, university: r.university || '', coins: Number(r.coins), best: Number(r.best),
  correct: Number(r.correct), answered: Number(r.answered), me: Number(r.user_id) === me });

// scope 'all': everyone; scope 'uni': only players from `uni` (defaults to the viewer's own university).
export async function fame(user, scope, uni) {
  const wantUni = scope === 'uni' ? String(uni || user.university || '') : '';
  const rows = await kv.cached('kbc:r1:fame:' + (wantUni || '*'), 5, async () =>
    wantUni ? all(FAME_SQL + ' AND m.university = ?' + ORDER + ' LIMIT 50', wantUni) : all(FAME_SQL + ORDER + ' LIMIT 50'));
  const universities = await kv.cached('kbc:r1:unis', 60, async () =>
    (await all("SELECT university, COUNT(*) AS n FROM students_master WHERE active = 1 AND university <> '' GROUP BY university ORDER BY university"))
      .map((r) => r.university));
  const out = rows.map((r) => shape(r, user.id));
  let mine = out.findIndex((r) => r.me), me = null;
  if (mine < 0) {
    const r = await one(FAME_SQL + ' AND s.user_id = ?', user.id);
    if (r && (!wantUni || r.university === wantUni)) {
      const ahead = await one(`SELECT COUNT(*) AS n FROM (${FAME_SQL}${wantUni ? ' AND m.university = ?' : ''}) t
                               WHERE t.coins > ? OR (t.coins = ? AND t.best > ?)`, ...(wantUni ? [wantUni] : []), r.coins, r.coins, r.best);
      me = { ...shape(r, user.id), rank: Number(ahead.n) + 1 };
    }
  }
  return { scope: wantUni ? 'uni' : 'all', university: wantUni, universities, rows: out.map((r, i) => ({ ...r, rank: i + 1 })), me, live: await liveCount() };
}

const KINDS = new Set(['feedback', 'run_start', 'run_end', 'answer', 'fff', 'practice_start', 'practice_end', 'lifeline', 'tour']);
export async function logEvents(userId, events) {
  const list = (Array.isArray(events) ? events : []).slice(0, 50).filter((e) => e && KINDS.has(e.kind));
  const now = Date.now();
  for (const e of list) {
    const data = JSON.stringify(e).slice(0, 4000);
    await run('INSERT INTO kbc_r1_log (user_id, kind, data, at) VALUES (?, ?, ?, ?)', userId, String(e.kind), data, now);
  }
  return { saved: list.length };
}

export async function feedbackRows(limit = 200) {
  return (await all(`SELECT l.data, l.at, u.roll_no, COALESCE(NULLIF(u.display_name, ''), m.name, u.roll_no) AS name, m.university
                     FROM kbc_r1_log l JOIN users u ON u.id = l.user_id JOIN students_master m ON m.roll_no = u.roll_no
                     WHERE l.kind = 'feedback' ORDER BY l.at DESC LIMIT ?`, limit))
    .map((r) => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { name: r.name, rollNo: r.roll_no, university: r.university, stars: d.stars, text: d.text, at: Number(r.at) }; });
}
