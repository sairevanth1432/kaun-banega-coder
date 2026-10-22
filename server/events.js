// Events: a Saturday-Sprint-style window with its own leaderboard.
//   mode "rules": each rung draws from the ladder pools, as in a normal game.
//   mode "fixed": the admin freezes the questions per rung (one per rung = everyone gets the same set;
//                 more than one = one is drawn and the rest power Flip).
import { one, all, run, tx, parseJSON } from './db.js';
import { getLadder } from './ladder.js';
import { binPut } from './recycle.js';

export class EventError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export const phaseOf = (e, now = Date.now()) => (now < Number(e.open_at) ? 'upcoming' : now >= Number(e.close_at) ? 'ended' : 'live');
const out = (e) => e && ({
  id: e.id, title: e.title, openAt: Number(e.open_at), closeAt: Number(e.close_at), mode: e.mode, fixed: parseJSON(e.fixed, []),
  attemptsAllowed: Number(e.attempts_allowed), leaderboardVisible: !!e.leaderboard_visible, phase: phaseOf(e),
  createdBy: e.created_by, createdAt: Number(e.created_at), updatedAt: Number(e.updated_at),
  ...(e.players != null ? { players: Number(e.players), games: Number(e.games) } : {})
});

export async function listEvents() {
  return (await all(`SELECT e.*, (SELECT COUNT(DISTINCT user_id) FROM kbc_games g WHERE g.event_id = e.id) AS players,
                       (SELECT COUNT(*) FROM kbc_games g WHERE g.event_id = e.id) AS games
                     FROM kbc_events e ORDER BY e.open_at DESC`)).map(out);
}
export async function getEvent(id) {
  const e = await one('SELECT * FROM kbc_events WHERE id = ?', String(id || ''));
  return out(e);
}
// Live and upcoming events for the player home screen.
export async function playerEvents() {
  const now = Date.now();
  return (await all('SELECT * FROM kbc_events WHERE close_at > ? ORDER BY open_at LIMIT 5', now - 86400000))
    .map(out).map((e) => ({ id: e.id, title: e.title, openAt: e.openAt, closeAt: e.closeAt, phase: e.phase, attemptsAllowed: e.attemptsAllowed, leaderboardVisible: e.leaderboardVisible }));
}

async function clean(input, existing) {
  const ladder = await getLadder();
  const id = String(input.id ?? existing?.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(id)) throw new EventError('BAD_ID', 'Event ID: 3–50 lower-case letters, digits or dashes (e.g. sprint-2026-10-24).');
  const title = String(input.title ?? existing?.title ?? '').trim().slice(0, 100);
  if (!title) throw new EventError('BAD_TITLE', 'Give the event a title.');
  const openAt = Date.parse(input.openAt ?? '') || Number(input.openAt) || existing?.openAt;
  const closeAt = Date.parse(input.closeAt ?? '') || Number(input.closeAt) || existing?.closeAt;
  if (!openAt || !closeAt || closeAt <= openAt) throw new EventError('BAD_WINDOW', 'The event must close after it opens.');
  const mode = (input.mode ?? existing?.mode) === 'fixed' ? 'fixed' : 'rules';
  let fixed = input.fixed ?? existing?.fixed ?? [];
  if (mode === 'fixed') {
    if (!Array.isArray(fixed) || fixed.length < ladder.openRungs) throw new EventError('BAD_SET', `Fixed mode needs questions for all ${ladder.openRungs} open rungs.`);
    fixed = fixed.slice(0, ladder.openRungs).map((r) => [...new Set((Array.isArray(r) ? r : [r]).map(Number).filter(Number.isInteger))]);
    const ids = fixed.flat();
    if (fixed.some((r) => !r.length)) throw new EventError('BAD_SET', 'Every open rung needs at least one question.');
    const found = new Set((await all(`SELECT id FROM kbc_questions WHERE status = 'published' AND id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((r) => Number(r.id)));
    const miss = ids.filter((i) => !found.has(i));
    if (miss.length) throw new EventError('BAD_SET', 'These questions are not published (or do not exist): ' + miss.slice(0, 10).join(', '));
  } else fixed = [];
  const attemptsAllowed = Math.max(0, Math.min(100, Math.round(Number(input.attemptsAllowed ?? existing?.attemptsAllowed ?? 1))));
  const leaderboardVisible = input.leaderboardVisible ?? existing?.leaderboardVisible ?? true;
  return { id, title, openAt, closeAt, mode, fixed, attemptsAllowed, leaderboardVisible: leaderboardVisible ? 1 : 0 };
}

export async function createEvent(input, by) {
  const e = await clean(input);
  if (await one('SELECT 1 AS x FROM kbc_events WHERE id = ?', e.id)) throw new EventError('EXISTS', `An event "${e.id}" already exists.`, 409);
  const now = Date.now();
  await run(`INSERT INTO kbc_events (id, title, open_at, close_at, mode, fixed, attempts_allowed, leaderboard_visible, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.id, e.title, e.openAt, e.closeAt, e.mode, JSON.stringify(e.fixed), e.attemptsAllowed, e.leaderboardVisible, by || null, now, now);
  return getEvent(e.id);
}

export async function updateEvent(id, input) {
  const cur = await getEvent(id);
  if (!cur) throw new EventError('NOT_FOUND', 'Event not found.', 404);
  const played = Number((await one('SELECT COUNT(*) AS n FROM kbc_games WHERE event_id = ?', cur.id)).n) > 0;
  const e = await clean({ ...input, id: cur.id }, cur);
  // Once anyone has played, the question set and rules are frozen so every player was ranked on the same terms.
  if (played && (e.mode !== cur.mode || JSON.stringify(e.fixed) !== JSON.stringify(cur.fixed) || e.openAt !== cur.openAt))
    throw new EventError('LOCKED', 'Players have already started this event: its questions and start time can no longer change. You can still change the title, close time, attempts and leaderboard visibility.', 409);
  await run(`UPDATE kbc_events SET title = ?, open_at = ?, close_at = ?, mode = ?, fixed = ?, attempts_allowed = ?, leaderboard_visible = ?, updated_at = ? WHERE id = ?`,
    e.title, e.openAt, e.closeAt, e.mode, JSON.stringify(e.fixed), e.attemptsAllowed, e.leaderboardVisible, Date.now(), cur.id);
  return getEvent(cur.id);
}

export async function endEventNow(id) {
  const cur = await getEvent(id);
  if (!cur) throw new EventError('NOT_FOUND', 'Event not found.', 404);
  await run('UPDATE kbc_events SET close_at = ?, updated_at = ? WHERE id = ?', Math.min(cur.closeAt, Date.now()), Date.now(), cur.id);
  return getEvent(cur.id);
}

export async function deleteEvent(id, by) {
  const row = await one('SELECT * FROM kbc_events WHERE id = ?', String(id));
  if (!row) throw new EventError('NOT_FOUND', 'Event not found.', 404);
  if (Number((await one('SELECT COUNT(*) AS n FROM kbc_games WHERE event_id = ?', row.id)).n) > 0)
    throw new EventError('PLAYED', 'This event has been played; end it instead of deleting it, so its results stay.', 409);
  await tx(async () => {
    await binPut('event', row.id, row.title, { row }, by);
    await run('DELETE FROM kbc_events WHERE id = ?', row.id);
  });
}
