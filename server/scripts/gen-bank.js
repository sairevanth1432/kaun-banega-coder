// Generates a synthetic question sheet in the import template, for load tests and trying the admin with a full bank.
//   npm run gen-bank -- 1000 data/bank-1000.csv
// Questions are simple arithmetic so every row is valid; spread evenly over C1–C5 and difficulty 1–10.
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATE_COLUMNS } from '../importer.js';
import { CHECKPOINTS } from '../ladder.js';
import { toCSV } from '../sheets.js';

const n = Number(process.argv[2]) || 1000;
const out = process.argv[3] || path.join('data', `bank-${n}.csv`);
const rows = [];
for (let i = 0; i < n; i++) {
  const cp = CHECKPOINTS[i % CHECKPOINTS.length], skill = cp.skills[Math.floor(i / CHECKPOINTS.length) % cp.skills.length][0];
  const difficulty = (Math.floor(i / 5) % 10) + 1, x = 3 + (i % 17), y = 2 + (i % 11), right = x * y + difficulty;
  const opts = [right, right + 1, right - 2, right + y], correct = i % 4;
  [opts[0], opts[correct]] = [opts[correct], opts[0]];
  rows.push({ ext_id: `GEN-${String(i + 1).padStart(5, '0')}`, checkpoint: cp.id, skill, type: 'Predict the output', difficulty,
    question: `What does this print? (#${i + 1})`, code: `x = ${x}\ny = ${y}\nprint(x * y + ${difficulty})`,
    option_a: opts[0], option_b: opts[1], option_c: opts[2], option_d: opts[3], correct: 'ABCD'[correct],
    hint: 'Multiply first, then add.', explanation: `${x} × ${y} = ${x * y}, plus ${difficulty} is ${right}.`, tags: 'generated', status: 'published' });
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, toCSV(TEMPLATE_COLUMNS, rows));
console.log(`Wrote ${n} questions to ${out}`);
process.exit(0);
