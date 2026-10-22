// Bulk import of questions from the content team's CSV / Excel sheet.
//   1. Dry run: every row is checked and compared with the bank → add / update / unchanged counts + row errors.
//   2. Commit: rows without errors are upserted by ext_id in one transaction (rows with errors are skipped).
// Same preview-then-commit flow as saturday-sprint's practice import, but for spreadsheets.
import { one, all, run, tx, parseJSON } from './db.js';
import { getLadder } from './ladder.js';
import { check, contentOf, sameContent, insertQuestion, applyUpdate, bumpRev, fingerprint } from './bank.js';
import { rowsFrom, headerKey, toCSV } from './sheets.js';

export const TEMPLATE_COLUMNS = ['ext_id', 'checkpoint', 'skill', 'type', 'difficulty', 'question', 'code', 'option_a', 'option_b', 'option_c', 'option_d', 'correct', 'hint', 'explanation', 'tags', 'status'];
const ALIASES = {
  ext_id: ['extid', 'id', 'questionid', 'qid', 'externalid'],
  checkpoint: ['checkpoint', 'cp', 'level', 'stage'],
  skill: ['skill', 'skillid', 'skillcode'],
  type: ['type', 'questiontype', 'format'],
  difficulty: ['difficulty', 'diff', 'difficultylevel'],
  q: ['question', 'questiontext', 'q', 'stem'],
  code: ['code', 'codesnippet', 'snippet'],
  a: ['optiona', 'a', 'option1'], b: ['optionb', 'b', 'option2'], c: ['optionc', 'c', 'option3'], d: ['optiond', 'd', 'option4'],
  correct: ['correct', 'answer', 'correctoption', 'correctanswer', 'key'],
  hint: ['hint', 'experthint', 'expert'],
  why: ['explanation', 'why', 'reason', 'solution'],
  tags: ['tags', 'tag', 'topics'],
  status: ['status']
};
const fieldOf = (h) => { const k = headerKey(h); for (const [f, n] of Object.entries(ALIASES)) if (n.includes(k)) return f; return null; };

// "A" / "b" / "2" / "Option C" → 0–3; also accepts the text of the correct option.
function correctIndex(raw, options) {
  const t = String(raw ?? '').trim();
  const m = t.match(/^(?:option\s*)?([a-d])$/i);
  if (m) return m[1].toUpperCase().charCodeAt(0) - 65;
  if (/^[1-4]$/.test(t)) return Number(t) - 1;
  const i = options.findIndex((o) => o && o.trim().toLowerCase() === t.toLowerCase());
  return i >= 0 ? i : NaN;
}
// Code cells keep real line breaks (Alt+Enter in Excel); tabs become 4 spaces so indentation survives.
const codeCell = (v) => String(v ?? '').replace(/\t/g, '    ');

export async function readSheet(input) {
  const rows = await rowsFrom(input);
  if (!rows.length) return { error: 'The file is empty.' };
  const head = rows[0].map(fieldOf), col = (f) => head.indexOf(f);
  const missing = ['q', 'a', 'b', 'c', 'd', 'correct', 'checkpoint', 'difficulty'].filter((f) => col(f) < 0);
  if (missing.length) return { error: 'Missing column(s): ' + missing.map((f) => ({ q: 'question', a: 'option_a', b: 'option_b', c: 'option_c', d: 'option_d' })[f] || f).join(', ') + '. Download the template to see the expected header row.' };
  return {
    items: rows.slice(1).map((r, i) => {
      const get = (f) => (col(f) >= 0 ? r[col(f)] ?? '' : '');
      const options = ['a', 'b', 'c', 'd'].map((k) => String(get(k)).trim());
      return { row: i + 2, input: { ext_id: get('ext_id'), checkpoint: get('checkpoint'), skill: get('skill'), type: get('type'), difficulty: String(get('difficulty')).trim(),
        q: get('q'), code: codeCell(get('code')), options, correct: correctIndex(get('correct'), options), hint: get('hint'), why: get('why'), tags: get('tags'), status: get('status') } };
    })
  };
}

const MAX_ROWS = 20000;

export async function importBank(input, { dry = true, asDraft = false, filename = '', by = null } = {}) {
  const sheet = await readSheet(input);
  if (sheet.error) return { ok: false, error: sheet.error };
  if (sheet.items.length > MAX_ROWS) return { ok: false, error: `Too many rows (${sheet.items.length}). Split the file into parts of ${MAX_ROWS} rows or fewer.` };
  const ladder = await getLadder();
  const existing = new Map((await all('SELECT * FROM kbc_questions')).map((r) => [r.ext_id, r]));
  const byPrint = new Map();
  for (const r of existing.values()) byPrint.set(r.fingerprint, r.ext_id);
  const errors = [], warnings = [], plan = [], seenIds = new Map();
  let add = 0, update = 0, unchanged = 0;
  for (const it of sheet.items) {
    const { value, errors: errs } = check(it.input, ladder);
    if (seenIds.has(value.ext_id)) errs.push({ field: 'ext_id', msg: `Same ID as row ${seenIds.get(value.ext_id)}.` });
    if (errs.length) { for (const e of errs) errors.push({ row: it.row, extId: value.ext_id, ...e }); continue; }
    seenIds.set(value.ext_id, it.row);
    const status = value.status || (asDraft ? 'draft' : 'published');
    const fp = fingerprint(value.q, value.code), other = byPrint.get(fp);
    if (other && other !== value.ext_id) warnings.push({ row: it.row, extId: value.ext_id, msg: `Looks like a duplicate of ${other}.` });
    byPrint.set(fp, value.ext_id);
    const row = existing.get(value.ext_id);
    let action;
    if (!row) { action = 'add'; add++; }
    else if (sameContent(contentOf(row), contentOf(value)) && (row.status === status || !value.status)) { action = 'unchanged'; unchanged++; }
    else { action = 'update'; update++; }
    plan.push({ row: it.row, action, value, status, existing: row });
  }
  const preview = plan.filter((p) => p.action !== 'unchanged').slice(0, 25).map((p) => ({ row: p.row, action: p.action, extId: p.value.ext_id, checkpoint: p.value.checkpoint, difficulty: p.value.difficulty, q: p.value.q.slice(0, 140), status: p.status }));
  const summary = { rows: sheet.items.length, add, update, unchanged, errors, warnings, preview };
  if (dry) return { ok: true, dry: true, ...summary };
  await tx(async () => {
    for (const p of plan) {
      if (p.action === 'add') await insertQuestion(p.value, by, { status: p.status });
      // An existing question keeps its status unless the sheet sets one.
      else if (p.action === 'update') await applyUpdate(p.existing, p.value, by, { status: p.value.status || p.existing.status });
    }
    await run('INSERT INTO kbc_imports (filename, rows, added, updated, unchanged, errors, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      String(filename || '').slice(0, 200), sheet.items.length, add, update, unchanged, JSON.stringify(errors.slice(0, 500)), by, Date.now());
  });
  if (add || update) await bumpRev();
  return { ok: true, dry: false, ...summary };
}

export async function listImports() {
  return (await all('SELECT * FROM kbc_imports ORDER BY id DESC LIMIT 100')).map((r) => ({
    id: Number(r.id), filename: r.filename, rows: r.rows, added: r.added, updated: r.updated, unchanged: r.unchanged,
    errors: (parseJSON(r.errors, []) || []).length, by: r.by, at: Number(r.at)
  }));
}

export function templateCSV() {
  return toCSV(TEMPLATE_COLUMNS, [
    { ext_id: 'C1-K1-001', checkpoint: 'C1', skill: 'K1', type: 'Concept', difficulty: 1, question: 'An algorithm is best described as…', code: '',
      option_a: 'A step-by-step set of instructions to solve a problem', option_b: 'A programming language', option_c: "A part of the computer's hardware", option_d: 'A maths formula only',
      correct: 'A', hint: 'Think of a recipe.', explanation: 'An algorithm is a clear sequence of steps.', tags: 'algorithms', status: 'published' },
    { ext_id: 'C2-P6-001', checkpoint: 'C2', skill: 'P6', type: 'Predict the output', difficulty: 7, question: 'What does this print?', code: 'for i in range(3):\n    print(i, end="")',
      option_a: '012', option_b: '123', option_c: '0 1 2', option_d: '3', correct: 'A', hint: 'range(3) starts at 0.', explanation: 'range(3) gives 0, 1, 2 and end="" keeps them on one line.', tags: 'loops,range', status: 'draft' }
  ]);
}

// Full bank as CSV in the template's columns (round-trips through the importer).
export async function exportBankCSV() {
  const rows = await all('SELECT * FROM kbc_questions ORDER BY checkpoint, difficulty, id');
  return toCSV(TEMPLATE_COLUMNS, rows.map((r) => {
    const o = parseJSON(r.options, []);
    return { ext_id: r.ext_id, checkpoint: r.checkpoint, skill: r.skill, type: r.type, difficulty: r.difficulty, question: r.q, code: r.code,
      option_a: o[0], option_b: o[1], option_c: o[2], option_d: o[3], correct: 'ABCD'[r.correct], hint: r.hint, explanation: r.why,
      tags: (parseJSON(r.tags, []) || []).join(','), status: r.status };
  }));
}

export const importCount = async () => Number((await one('SELECT COUNT(*) AS n FROM kbc_imports')).n);
