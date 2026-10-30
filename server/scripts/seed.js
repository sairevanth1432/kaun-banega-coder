// Loads the starter content into an empty (or existing) database. Safe to run again: questions upsert by ext_id
// and puzzles are only added when there are none.
//   npm run seed                         starter questions + FFF puzzles
//   npm run seed -- --roster file.csv    also import a student roster (NIAT ID, Name, …)
//   npm run seed -- --questions file.csv import another question sheet (CSV or .xlsx) as published
//   npm run seed -- --path-bank G1/upload-G1.json   import a skill-path bundle (question-bank-format) into the live bank
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { ready, one, close } from '../db.js';
import { importBank } from '../importer.js';
import { addFff } from '../fff.js';
import { importRoster } from '../roster.js';
import { importBundle } from '../pathbank.js';

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const sheet = (file) => (/\.xlsx$/i.test(file) ? { xlsxBase64: fs.readFileSync(file).toString('base64') } : { csv: fs.readFileSync(file, 'utf8') });

await ready();
const qfile = val('questions') || path.join(ROOT, 'content', 'starter-questions.csv');
const r = await importBank(sheet(qfile), { dry: false, filename: path.basename(qfile), by: 'seed' });
if (!r.ok) { console.error(r.error); process.exit(1); }
console.log(`Questions from ${path.basename(qfile)}: ${r.add} added, ${r.update} updated, ${r.unchanged} unchanged, ${r.errors.length} rows with errors.`);
for (const e of r.errors.slice(0, 10)) console.log(`  row ${e.row}: ${e.msg}`);

if (!Number((await one('SELECT COUNT(*) AS n FROM kbc_fff')).n)) {
  const fff = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'starter-fff.json'), 'utf8'));
  for (const p of fff) await addFff(p, 'seed');
  console.log(`FFF puzzles: ${fff.length} added.`);
}
const roster = val('roster');
if (roster) {
  const s = await importRoster(sheet(roster), { dry: false });
  console.log(s.error ? s.error : `Roster: ${s.added} added, ${s.updated} updated, ${s.errors.length} rows with errors.`);
}
const bundle = val('path-bank');
if (bundle) {
  const b = await importBundle(JSON.parse(fs.readFileSync(bundle, 'utf8')), { dry: false, by: 'seed', filename: path.basename(bundle) });
  console.log(`Skill-path bank from ${path.basename(bundle)}: ${b.added} added, ${b.updated} updated, ${b.unchanged} unchanged, ${b.errorCount} with errors.`);
  for (const e of b.errors.slice(0, 10)) console.log(`  ${e.id || 'row ' + e.row}: ${e.errors.join(' ')}`);
}
await close();
process.exit(0);
