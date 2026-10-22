// Fastest Finger First puzzles: a task and 4 lines; the answer is the right order as letters, e.g. "BDCA".
import { one, all, run, tx, parseJSON } from './db.js';
import { binPut } from './recycle.js';

export class FffError extends Error {
  constructor(message, status = 400) { super(message); this.code = 'BAD_FFF'; this.status = status; }
}

function clean(input) {
  const task = String(input.task || '').trim().slice(0, 200);
  const lines = (Array.isArray(input.lines) ? input.lines : []).map((l) => String(l || '').trim().slice(0, 120));
  const answer = String(input.answer || '').trim().toUpperCase();
  if (!task) throw new FffError('Write the task, e.g. "Put the steps in order to…".');
  if (lines.length !== 4 || lines.some((l) => !l)) throw new FffError('Give exactly 4 lines.');
  if (new Set(lines.map((l) => l.toLowerCase())).size !== 4) throw new FffError('The 4 lines must all be different.');
  if (!/^[ABCD]{4}$/.test(answer) || new Set(answer).size !== 4) throw new FffError('The answer must use each of A, B, C and D once, e.g. BDCA.');
  const status = input.status === 'draft' ? 'draft' : 'published';
  return { task, lines, answer, status };
}
const out = (r) => ({ id: Number(r.id), task: r.task, lines: parseJSON(r.lines, []), answer: r.answer, status: r.status, updatedBy: r.updated_by, updatedAt: Number(r.updated_at) });

export const listFff = async () => (await all('SELECT * FROM kbc_fff ORDER BY id')).map(out);
export async function addFff(input, by) {
  const f = clean(input);
  const r = await one('INSERT INTO kbc_fff (task, lines, answer, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', f.task, JSON.stringify(f.lines), f.answer, f.status, by || null, Date.now());
  return Number(r.id);
}
export async function updateFff(id, input, by) {
  const f = clean(input);
  const r = await one('UPDATE kbc_fff SET task = ?, lines = ?, answer = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ? RETURNING id', f.task, JSON.stringify(f.lines), f.answer, f.status, by || null, Date.now(), Number(id));
  if (!r) throw new FffError('Puzzle not found.', 404);
}
export async function deleteFff(id, by) {
  const row = await one('SELECT * FROM kbc_fff WHERE id = ?', Number(id));
  if (!row) throw new FffError('Puzzle not found.', 404);
  await tx(async () => {
    await binPut('fff', row.id, row.task, { row }, by);
    await run('DELETE FROM kbc_fff WHERE id = ?', row.id);
  });
}
