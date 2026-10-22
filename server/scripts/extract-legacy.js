// One-off: turns the questions hard-coded in the original single-file game (legacy/kaun-banega-coder.html, the CP
// array) into the import template, so the starter set goes through the same importer as the content team's sheets.
//   node scripts/extract-legacy.js  →  content/starter-questions.csv + content/starter-fff.json
// Difficulty = the question's level within its checkpoint (1–10), which reproduces the original rung pools under
// the default ladder (rung 1 = C1 difficulty 1–2, rung 2 = C1 3–5, …).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../config.js';
import { TEMPLATE_COLUMNS } from '../importer.js';
import { toCSV } from '../sheets.js';

const html = fs.readFileSync(path.join(ROOT, 'legacy', 'kaun-banega-coder.html'), 'utf8');
const a = html.indexOf('const CP=['), b = html.indexOf('/* ===== One money board');
const CP = vm.runInNewContext('(' + html.slice(a + 'const CP='.length, b).trim().replace(/;$/, '') + ')');

const rows = [], fff = [];
for (const cp of CP) {
  for (const p of cp.fff || []) fff.push({ task: p.task, lines: p.lines, answer: p.order });
  (cp.qs || []).forEach((level, li) => level.forEach((q, j) => rows.push({
    ext_id: `${cp.id}-${li + 1}${'ab'[j]}`, checkpoint: cp.n, skill: q.sk, type: q.ty, difficulty: li + 1, question: q.q, code: q.code || '',
    option_a: q.o[0], option_b: q.o[1], option_c: q.o[2], option_d: q.o[3], correct: 'ABCD'[q.a], hint: q.hint, explanation: q.why, tags: 'starter', status: 'published'
  })));
}
fs.writeFileSync(path.join(ROOT, 'content', 'starter-questions.csv'), '﻿' + toCSV(TEMPLATE_COLUMNS, rows));
fs.writeFileSync(path.join(ROOT, 'content', 'starter-fff.json'), JSON.stringify(fff, null, 2) + '\n');
console.log(`Wrote ${rows.length} questions and ${fff.length} FFF puzzles to content/.`);
process.exit(0);
