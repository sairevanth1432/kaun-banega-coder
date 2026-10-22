// Recycle bin (Admin → Recycle bin): whatever an admin deletes lands here first with a full snapshot, and can be
// restored. Pattern from saturday-sprint/server/recycle.js.
//   question   a bank question (kbc_questions; its saved versions stay in kbc_question_versions)
//   fff        a Fastest Finger First puzzle
//   event      an event that nobody had played yet
import { one, all, run } from './db.js';

export class BinError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export const BIN_KINDS = { question: 'Question', fff: 'FFF puzzle', event: 'Event' };
const TABLE = { question: 'kbc_questions', fff: 'kbc_fff', event: 'kbc_events' };

export async function binPut(kind, ref, label, payload, by) {
  if (!BIN_KINDS[kind]) throw new Error('unknown recycle bin kind ' + kind);
  const r = await one('INSERT INTO recycle_bin (kind, ref, label, payload, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    kind, String(ref || ''), String(label || '').slice(0, 300), JSON.stringify(payload ?? null), Date.now(), by || null);
  return Number(r.id);
}

export async function listBin() {
  const rows = await all('SELECT id, kind, ref, label, deleted_at, deleted_by FROM recycle_bin WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY deleted_at DESC LIMIT 1000');
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, kindLabel: BIN_KINDS[r.kind] || r.kind, ref: r.ref, label: r.label, deletedAt: Number(r.deleted_at), deletedBy: r.deleted_by }));
}

const itemOf = async (id) => {
  const it = await one('SELECT * FROM recycle_bin WHERE id = ? AND restored_at IS NULL AND purged_at IS NULL', Number(id));
  if (!it) throw new BinError('NOT_FOUND', 'This item is no longer in the recycle bin.', 404);
  return { ...it, payload: JSON.parse(it.payload || 'null') };
};

// Re-insert a snapshot row as it was (same id), skipping columns the table no longer has.
async function reinsert(table, row) {
  const cols = (await all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', table)).map((c) => c.column_name);
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  await run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
}

export async function restoreItem(id, hooks) {
  const it = await itemOf(id), row = it.payload && it.payload.row;
  const table = TABLE[it.kind];
  if (!row || !table) throw new BinError('EMPTY', 'Nothing to restore.');
  if (await one(`SELECT 1 AS x FROM ${table} WHERE id = ?`, row.id)) throw new BinError('EXISTS', 'It is already back.');
  if (it.kind === 'question' && (await one('SELECT 1 AS x FROM kbc_questions WHERE ext_id = ?', row.ext_id)))
    throw new BinError('ID_TAKEN', `Another question now uses the ID "${row.ext_id}". Change that one's ID first.`);
  if (it.kind === 'event') row.id = String(row.id);
  await reinsert(table, row);
  await run('UPDATE recycle_bin SET restored_at = ? WHERE id = ?', Date.now(), it.id);
  if (hooks && hooks.changed) await hooks.changed(it.kind);
  return { kind: it.kind, label: it.label };
}

export async function purgeItem(id) {
  const it = await itemOf(id);
  await run('UPDATE recycle_bin SET purged_at = ?, payload = ? WHERE id = ?', Date.now(), JSON.stringify(null), it.id);
  return { kind: it.kind, label: it.label };
}
