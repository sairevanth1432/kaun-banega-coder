// Grades every live hot-seat item in the bank with its own right answer (built from the item's key or, for code
// golf, found by trying every choice) and with a wrong one. Any item the server would mark wrongly is listed.
//   node scripts/check-path-bank.js [--type golf] [--limit 200]
import { ready, all, close, parseJSON } from '../db.js';
import { grade, HOTSEAT } from '../pathbank.js';
import { stop } from '../pyrun.js';

const args = process.argv.slice(2), val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
await ready();
const rows = await all("SELECT data FROM kbc_items WHERE status = 'live'" + (val('type') ? ' AND type = ?' : '') + ' ORDER BY id', ...(val('type') ? [val('type')] : []));
const items = rows.map((r) => parseJSON(r.data, {})).filter((q) => HOTSEAT.has(q.type)).slice(0, Number(val('limit') || 1e9));

function right(q) {
  const p = q.payload;
  switch (q.type) {
    case 'match': return { map: p.answer };
    case 'predict': return { text: p.expected };
    case 'hunt': return { picks: p.answer };
    case 'path2': return { path: p.answer };
    case 'timeline': case 'pseudo': case 'sort': return { order: p.answer };
    case 'group': return { groups: p.groups };
    case 'same': return { pick: p.answer };
    case 'gap': return { cells: Object.fromEntries(p.rows.map((r, i) => [i, { value: r.value, kind: r.kind }])) };
    case 'path': return { picks: Object.fromEntries(p.cases.map((c, i) => [i, c.answer])) };
    case 'bug': return { line: p.answer };
    case 'fill': return { text: p.sample };
    case 'parsons': { const lines = p.sample.split('\n'), used = new Set(); return { order: lines.map((l) => { const i = p.items.findIndex((x, k) => !used.has(k) && x === l); used.add(i); return i; }) }; }
    default: return { pick: p.options.findIndex((o) => o.correct) };
  }
}
function wrong(q) {
  const p = q.payload;
  switch (q.type) {
    case 'predict': return { text: p.expected + 'x' };
    case 'same': return { pick: p.answer === 'Same' ? 'Different' : 'Same' };
    case 'bug': return { line: p.answer === 1 ? 2 : 1 };
    case 'fill': return { text: '0' };
    default: { const g = right(q); if (g.pick != null) return { pick: p.options.findIndex((o) => !o.correct) }; if (g.order) return { order: g.order.slice().reverse() }; return {}; }
  }
}
async function golfRight(q) {
  const p = q.payload, combos = p.tokens.reduce((acc, t) => acc.flatMap((a) => t.choices.map((c) => a.concat([c]))), [[]]);
  combos.sort((a, b) => a.filter((c, i) => c !== p.tokens[i].now).length - b.filter((c, i) => c !== p.tokens[i].now).length);
  for (const c of combos) if ((await grade(q, { choices: c })).ok) return true;
  return false;
}

const bad = [], byType = {};
for (const q of items) {
  const t = byType[q.type] ||= { n: 0, bad: 0 };
  t.n++;
  let okRight, okWrong;
  if (q.type === 'golf') { okRight = await golfRight(q); okWrong = (await grade(q, { choices: q.payload.tokens.map((k) => k.now) })).ok; }
  else { okRight = (await grade(q, right(q))).ok; okWrong = (await grade(q, wrong(q))).ok; }
  if (!okRight || okWrong) { t.bad++; if (bad.length < 40) bad.push(`${q.id} (${q.type}): right answer ${okRight ? 'accepted' : 'REJECTED'}, wrong answer ${okWrong ? 'ACCEPTED' : 'rejected'}`); }
}
console.table(byType);
console.log(bad.length ? bad.join('\n') : 'Every item grades correctly.');
await stop(); await close(); process.exit(bad.length ? 1 : 0);
