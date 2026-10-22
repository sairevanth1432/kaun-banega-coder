// Student roster (who may log in): CSV or Excel with a NIAT ID column; name, batch and university are optional.
import { all, run, tx } from './db.js';
import { normRoll, validRoll } from './security.js';
import { rowsFrom, headerKey } from './sheets.js';
import { forgetSessions } from './auth.js';

const ALIASES = {
  roll_no: ['niatid', 'niat', 'rollno', 'rollnumber', 'roll', 'studentid', 'id', 'regno', 'uid'],
  name: ['name', 'studentname', 'fullname', 'student'],
  batch: ['batch', 'section', 'class', 'cohort', 'group'],
  university: ['university', 'universityname', 'college', 'collegename', 'institute', 'campus']
};
const fieldOf = (h) => { const k = headerKey(h); for (const [f, n] of Object.entries(ALIASES)) if (n.includes(k)) return f; return null; };

export async function readRoster(input) {
  const rows = await rowsFrom(input);
  if (!rows.length) return { error: 'The file is empty.', students: [], errors: [] };
  const head = rows[0].map(fieldOf), col = (f) => head.indexOf(f);
  if (col('roll_no') < 0) return { error: 'Header row must include a "NIAT ID" column. Found: ' + rows[0].join(', '), students: [], errors: [] };
  const seen = new Set(), students = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    const get = (f) => (col(f) >= 0 ? String(r[col(f)] ?? '').trim() : '');
    const roll = normRoll(get('roll_no'));
    if (!validRoll(roll)) return errors.push({ row: i + 2, msg: 'Invalid NIAT ID "' + get('roll_no') + '"' });
    if (seen.has(roll)) return errors.push({ row: i + 2, msg: 'Duplicate NIAT ID ' + roll });
    seen.add(roll);
    students.push({ roll_no: roll, name: get('name').slice(0, 120), batch: get('batch').slice(0, 60), university: get('university').slice(0, 120) });
  });
  return { students, errors };
}

// mode "merge": add/update listed students. "replace": also deactivate everyone not in the file.
export async function importRoster(input, { mode = 'merge', dry = false } = {}) {
  const r = await readRoster(input);
  if (r.error) return r;
  const existing = new Map((await all('SELECT roll_no, name, batch, university, active FROM students_master')).map((s) => [s.roll_no, s]));
  let added = 0, updated = 0, deactivated = 0;
  for (const s of r.students) {
    const e = existing.get(s.roll_no);
    if (!e) added++;
    else if (e.name !== s.name || e.batch !== s.batch || e.university !== s.university || !e.active) updated++;
  }
  const keep = new Set(r.students.map((s) => s.roll_no));
  if (mode === 'replace') for (const [roll, e] of existing) if (e.active && !keep.has(roll)) deactivated++;
  if (!dry) {
    const now = Date.now();
    await tx(async () => {
      for (const s of r.students)
        await run(`INSERT INTO students_master (roll_no, name, batch, university, active, updated_at) VALUES (?, ?, ?, ?, 1, ?)
                   ON CONFLICT (roll_no) DO UPDATE SET name = excluded.name, batch = excluded.batch, university = excluded.university, active = 1, updated_at = excluded.updated_at`,
          s.roll_no, s.name, s.batch, s.university, now);
      if (mode === 'replace') for (const [roll, e] of existing) if (e.active && !keep.has(roll)) await run('UPDATE students_master SET active = 0, updated_at = ? WHERE roll_no = ?', now, roll);
    });
    forgetSessions();
  }
  return { ok: true, dry, total: r.students.length, added, updated, deactivated, errors: r.errors };
}
