// End-to-end tests against the real server (harness pattern from saturday-sprint/server/test/e2e.test.js):
// PGlite in a temp DATA_DIR, the app on a random port, and a fetch client with a cookie jar per user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-test-'));
process.env.DATA_DIR = DATA;
process.env.PGLITE_MEMORY = 'true';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.MOVES_PER_MINUTE = '100000';
process.env.MAX_GAMES_PER_HOUR = '100000';

let mod, db, sec, server, base;
before(async () => {
  mod = await import('../index.js');
  db = await import('../db.js');
  sec = await import('../security.js');
  server = await mod.start();
  await new Promise((r) => (server.listening ? r() : server.on('listening', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

function client() {
  const jar = new Map();
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), patch: (u, b = {}) => call('PATCH', u, b), del: (u) => call('DELETE', u) };
}

// Player responses before an answer is locked must never reveal it.
function assertNoAnswerLeak(obj, where) {
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (['correct', 'why', 'answer', 'hint'].includes(k) && p.includes('question')) assert.fail(`${where}: "${k}" leaked at ${p}.${k}`);
      if (k === 'question' && v) for (const bad of ['correct', 'why', 'hint']) assert.ok(!(bad in v), `${where}: question.${bad} leaked`);
      walk(v, p + '.' + k);
    }
  };
  walk(obj, '$');
}

const STARTER = fs.readFileSync(new URL('../content/starter-questions.csv', import.meta.url), 'utf8');
let admin, student;

async function makeAdmin(email, role) {
  await db.run('INSERT INTO admins (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', email, 'Test', role, sec.hashPassword('correct-horse-42'), Date.now());
  const c = client();
  const l = await c.post('/api/admin/login', { email, password: 'correct-horse-42' });
  assert.equal(l.json.next, 'setup');
  const s = await c.get('/api/admin/totp/setup');
  assert.equal(s.status, 200);
  const e = await c.post('/api/admin/totp/enable', { code: sec.totpAt(s.json.secret, sec.totpStep()) });
  assert.equal(e.status, 200, e.text);
  return c;
}

// Finds the shown position of the right answer by reading the bank (what a cheater could NOT do).
async function rightShown(q) {
  const row = await db.one('SELECT options, correct FROM kbc_questions WHERE id = ?', q.id);
  const opts = JSON.parse(row.options);
  return q.options.indexOf(opts[row.correct]);
}

test('health and pages', async () => {
  const c = client();
  assert.equal((await c.get('/api/health')).json.ok, true);
  assert.equal((await c.get('/')).status, 302);
  assert.equal((await c.get('/admin')).status, 200);
});

test('admin login with authenticator, roles enforced', async () => {
  admin = await makeAdmin('super@kbc.test', 'super_admin');
  assert.equal((await admin.get('/api/admin/me')).json.role, 'super_admin');
  const plain = await makeAdmin('plain@kbc.test', 'admin');
  assert.equal((await plain.put('/api/admin/ladder', { ladder: {} })).status, 403);
  assert.equal((await client().get('/api/admin/questions')).status, 401);
});

test('import: dry run reports row errors and saves nothing; commit upserts by ext_id', async () => {
  const bad = 'ext_id,checkpoint,difficulty,question,option_a,option_b,option_c,option_d,correct\n' +
    'x1,C1,1,Ok question?,a,b,c,d,A\n' +
    'x2,C9,1,Bad checkpoint,a,b,c,d,A\n' +
    'x3,C1,11,Bad difficulty,a,b,c,d,B\n' +
    'x4,C1,2,Same options,a,a,c,d,A\n' +
    'x5,C1,2,No answer,a,b,c,d,E\n' +
    'x1,C1,1,Duplicate id,a,b,c,d,A\n';
  const dry = await admin.post('/api/admin/import/questions', { csv: bad, dry: true });
  assert.equal(dry.json.add, 1);
  assert.deepEqual(dry.json.errors.map((e) => e.row), [3, 4, 5, 6, 7]);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM kbc_questions')).n), 0);
  const missing = await admin.post('/api/admin/import/questions', { csv: 'question,option_a\nq,a', dry: true });
  assert.match(missing.json.error, /Missing column/);

  const r = await admin.post('/api/admin/import/questions', { csv: STARTER, dry: false, filename: 'starter.csv' });
  assert.equal(r.json.add, 40);
  const again = await admin.post('/api/admin/import/questions', { csv: STARTER, dry: false });
  assert.equal(again.json.unchanged, 40);
  assert.equal(again.json.add + again.json.update, 0);
  const tpl = await admin.get('/api/admin/import/template.csv');
  assert.match(tpl.text, /ext_id,checkpoint,skill/);
  const pools = (await admin.get('/api/admin/ladder')).json.poolSizes.slice(0, 6);
  assert.deepEqual(pools, [4, 6, 10, 6, 6, 8]);   // the original game's pools
  for (const p of JSON.parse(fs.readFileSync(new URL('../content/starter-fff.json', import.meta.url), 'utf8')))
    assert.equal((await admin.post('/api/admin/fff', p)).status, 200);
});

test('roster import and player login', async () => {
  const csv = 'NIAT ID,Student Name,University\nN26T0001,Asha Kumar,Test U\n' + Array.from({ length: 12 }, (_, i) => `N26T01${String(i).padStart(2, '0')},Player ${i},Test U`).join('\n');
  const dry = await admin.post('/api/admin/roster/import', { csv, dry: true });
  assert.equal(dry.json.added, 13);
  await admin.post('/api/admin/roster/import', { csv, dry: false });
  student = client();
  assert.equal((await student.post('/api/auth/name-login', { rollNo: 'n26t0001', name: 'Wrong Name' })).status, 401);
  assert.equal((await student.post('/api/auth/name-login', { rollNo: 'n26t0001', name: 'kumar asha' })).status, 200);
  const b = await student.get('/api/bootstrap');
  assert.equal(b.json.me.rollNo, 'N26T0001');
  assert.equal(b.json.ladder.rungs.length, 15);
  assert.ok(!('rule' in b.json.ladder.rungs[0]), 'pool rules stay on the server');
  assert.equal((await student.get('/api/admin/overview')).status, 401);
});

test('a full game: answers checked on the server, safe point, no answer leaks', async () => {
  const s = await student.post('/api/game/start', { mode: 'classic' });
  assert.equal(s.status, 200, s.text);
  assertNoAnswerLeak(s.json, 'start');
  let g = s.json.game;
  for (let i = 0; i < 3; i++) {
    const right = await rightShown(g.question);
    const a = await student.post(`/api/game/${g.id}/answer`, { rung: i, pick: right });
    assert.equal(a.json.reveal.ok, true);
    assert.equal(a.json.reveal.correct, right);
    if (i === 2) assert.equal(a.json.reveal.safePoint.checkpoint, 'C1');
    const n = await student.post(`/api/game/${g.id}/next`);
    assertNoAnswerLeak(n.json, 'next');
    g = n.json.game;
  }
  const right = await rightShown(g.question);
  const wrong = [0, 1, 2, 3].find((i) => i !== right);
  const a = await student.post(`/api/game/${g.id}/answer`, { rung: 3, pick: wrong });
  assert.equal(a.json.reveal.ok, false);
  assert.equal(a.json.game.state, 'done');
  assert.equal(a.json.game.result.amount, 5000);   // C1 safe point
  assert.equal(a.json.game.result.reason, 'wrong');
  assert.ok(a.json.game.result.newBadges.includes('c1'));
  const p = (await student.get('/api/profile')).json.profile;
  assert.equal(p.games, 1);
  assert.ok(p.coins >= 5000);
  const st = await db.one('SELECT n, ok FROM kbc_qstats WHERE qid = ?', g.question.id);
  assert.equal(Number(st.n), 1);
});

test('the option order is shuffled per game and mapped back correctly', async () => {
  const orders = new Set();
  for (let i = 0; i < 6; i++) {
    const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
    orders.add(g.question.id + ':' + g.question.options.join('|'));
    const right = await rightShown(g.question);
    const a = await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: right });
    assert.equal(a.json.reveal.ok, true);
    await student.post(`/api/game/${g.id}/quit`);
  }
  assert.ok(orders.size > 1);
});

test('double submit is blocked; stale rung rejected', async () => {
  const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
  const right = await rightShown(g.question);
  const [x, y] = await Promise.all([
    student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: right }),
    student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: right })
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const again = await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: right });
  assert.equal(again.json.error, 'STALE');
  await student.post(`/api/game/${g.id}/quit`);
});

test('answer after the clock runs out is a time-out', async () => {
  const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
  await db.run('UPDATE kbc_games SET deadline = ? WHERE id = ?', Date.now() - 60000, g.id);
  const a = await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: 0 });
  assert.equal(a.json.game.state, 'done');
  assert.equal(a.json.game.result.reason, 'timeout');
  const t = await student.post('/api/game/start', { mode: 'classic' });
  const early = await student.post(`/api/game/${t.json.game.id}/answer`, { rung: 0, pick: null });
  assert.equal(early.json.error, 'TOO_EARLY');
  await student.post(`/api/game/${t.json.game.id}/quit`);
});

test('lifelines: 50:50 keeps the right answer, flip swaps the question, poll goes live, each once', async () => {
  for (let i = 0; i < 8; i++) {
    const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
    const right = await rightShown(g.question);
    const f = await student.post(`/api/game/${g.id}/lifeline`, { k: 'fifty' });
    assert.equal(f.json.data.removed.length, 2);
    assert.ok(!f.json.data.removed.includes(right));
    const removedPick = await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: f.json.data.removed[0] });
    assert.equal(removedPick.json.error, 'BAD_PICK');
    assert.equal((await student.post(`/api/game/${g.id}/lifeline`, { k: 'fifty' })).json.error, 'USED');
    await student.post(`/api/game/${g.id}/quit`);
  }
  const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
  const fl = await student.post(`/api/game/${g.id}/lifeline`, { k: 'flip' });
  assertNoAnswerLeak(fl.json, 'flip');
  assert.notEqual(fl.json.game.question.id, g.question.id);
  const q = fl.json.game.question;
  await db.run('INSERT INTO kbc_qstats (qid, n, p0, p1, p2, p3) VALUES (?, 40, 10, 10, 10, 10) ON CONFLICT (qid) DO UPDATE SET p0 = 10, p1 = 10, p2 = 10, p3 = 10', q.id);
  const p = await student.post(`/api/game/${g.id}/lifeline`, { k: 'poll' });
  assert.equal(p.json.data.live, true);
  assert.equal(p.json.data.n, 40);
  const e = await student.post(`/api/game/${g.id}/lifeline`, { k: 'expert' });
  assert.ok(e.json.data.hint.length > 3);
  await student.post(`/api/game/${g.id}/quit`);
});

test('editing a published question makes a new version; old games keep theirs', async () => {
  const g = (await student.post('/api/game/start', { mode: 'classic' })).json.game;
  const qid = g.question.id, oldText = g.question.q;
  await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: await rightShown(g.question) });
  await student.post(`/api/game/${g.id}/quit`);
  const cur = (await admin.get(`/api/admin/questions/${qid}`)).json.question;
  const u = await admin.put(`/api/admin/questions/${qid}`, { ...cur, ext_id: cur.extId, q: cur.q + ' (edited)' });
  assert.equal(u.json.result, 'updated');
  const after1 = (await admin.get(`/api/admin/questions/${qid}`)).json;
  assert.equal(after1.question.version, 2);
  assert.equal(after1.versions.length, 2);
  const detail = (await admin.get(`/api/admin/games/${g.id}`)).json;
  assert.equal(detail.answers[0].q, oldText);
  const same = await admin.put(`/api/admin/questions/${qid}`, { ...after1.question, ext_id: cur.extId });
  assert.equal(same.json.result, 'unchanged');
});

test('retired questions leave the pools; empty pool is reported', async () => {
  const rung1 = (await admin.get('/api/admin/questions?checkpoint=C1&diff=1-2&size=50')).json.rows.map((r) => r.id);
  assert.equal(rung1.length, 4);
  await admin.post('/api/admin/questions/bulk-status', { ids: rung1, status: 'retired' });
  const s = await student.post('/api/game/start', { mode: 'classic' });
  assert.equal(s.json.error, 'POOL_EMPTY');
  await admin.post('/api/admin/questions/bulk-status', { ids: rung1, status: 'published' });
  assert.equal((await student.post('/api/game/start', { mode: 'classic' })).status, 200);
});

test('events: one ranked attempt, fixed set, leaderboard order', async () => {
  const ids = [];
  for (const [cp, d] of [['C1', '1-2'], ['C1', '3-5'], ['C1', '6-10'], ['C2', '1-3'], ['C2', '4-6'], ['C2', '7-10']])
    ids.push([(await admin.get(`/api/admin/questions?checkpoint=${cp}&diff=${d}&sort=id`)).json.rows[0].id]);
  const ev = await admin.post('/api/admin/events', { id: 'sprint-test', title: 'Saturday Sprint test', openAt: Date.now() - 1000, closeAt: Date.now() + 3600000, mode: 'fixed', fixed: ids, attemptsAllowed: 1 });
  assert.equal(ev.status, 200, ev.text);
  const results = [];
  for (const [n, correctN] of [['00', 6], ['01', 3], ['02', 1]]) {
    const c = client();
    await c.post('/api/auth/name-login', { rollNo: 'N26T01' + n, name: 'Player ' + Number(n) });
    let g = (await c.post('/api/game/start', { mode: 'event', eventId: 'sprint-test' })).json.game;
    assert.equal(g.question.id, ids[0][0]);   // everyone gets the frozen question
    for (let i = 0; i < 6 && g.state === 'play'; i++) {
      const right = await rightShown(g.question);
      const a = await c.post(`/api/game/${g.id}/answer`, { rung: i, pick: i < correctN ? right : (right + 1) % 4 });
      g = a.json.game;
      if (g.state === 'play') g = (await c.post(`/api/game/${g.id}/next`)).json.game;
    }
    results.push(g.result.amount);
    assert.equal((await c.post('/api/game/start', { mode: 'event', eventId: 'sprint-test' })).json.error, 'NO_ATTEMPTS');
    if (n === '00') {
      const board = (await c.get('/api/leaderboard?event=sprint-test')).json;
      assert.equal(board.me.rank, 1);
    }
  }
  assert.deepEqual(results, [40000, 5000, 0]);
  const board = (await admin.get('/api/admin/leaderboard?event=sprint-test')).json.rows;
  assert.deepEqual(board.map((r) => r.amount), [40000, 5000, 0]);
  const locked = await admin.put('/api/admin/events/sprint-test', { fixed: ids.slice().reverse() });
  assert.equal(locked.json.error, 'LOCKED');
});

test('fastest finger first is timed and checked on the server', async () => {
  const f = await student.post('/api/fff/start');
  assert.ok(!('answer' in f.json));
  const runRow = await db.one('SELECT r.perm, p.answer FROM kbc_fff_runs r JOIN kbc_fff p ON p.id = r.fff_id WHERE r.id = ?', f.json.runId);
  const perm = JSON.parse(runRow.perm), want = [...runRow.answer].map((c) => c.charCodeAt(0) - 65);
  const order = want.map((o) => perm.indexOf(o));
  const s = await student.post('/api/fff/submit', { runId: f.json.runId, order });
  assert.equal(s.json.ok, true);
  assert.equal(s.json.bonus, 2000);
  assert.equal((await student.post('/api/fff/submit', { runId: f.json.runId, order })).json.error, 'DONE');
  const g = (await student.post('/api/game/start', { mode: 'classic', fffRunId: f.json.runId })).json.game;
  assert.ok(g.id);
  assert.ok(Number((await db.one('SELECT fff_secs FROM kbc_games WHERE id = ?', g.id)).fff_secs) > 0);
  await student.post(`/api/game/${g.id}/quit`);
});

test('practice by skill is unranked', async () => {
  const before1 = (await student.get('/api/profile')).json.profile;
  const g = (await student.post('/api/game/start', { mode: 'practice', skill: 'P6' })).json.game;
  assert.equal(g.mode, 'practice');
  const right = await rightShown(g.question);
  await student.post(`/api/game/${g.id}/answer`, { rung: 0, pick: right });
  const q = await student.post(`/api/game/${g.id}/quit`);
  assert.equal(q.json.game.result.coins, 0);
  assert.equal((await student.get('/api/profile')).json.profile.games, before1.games);
});

test('delete goes to the recycle bin and restores', async () => {
  const add = await admin.post('/api/admin/questions', { ext_id: 'tmp-1', checkpoint: 'C3', skill: 'L1', difficulty: 2, q: 'Temp?', options: ['a', 'b', 'c', 'd'], correct: 1 });
  assert.equal(add.status, 200, add.text);
  await admin.del(`/api/admin/questions/${add.json.id}`);
  const bin = (await admin.get('/api/admin/bin')).json.rows;
  const item = bin.find((b) => b.ref === 'tmp-1');
  assert.ok(item);
  assert.equal((await admin.post(`/api/admin/bin/${item.id}/restore`)).status, 200);
  assert.equal((await admin.get(`/api/admin/questions/${add.json.id}`)).json.question.extId, 'tmp-1');
});

test('analytics and exports respond', async () => {
  const o = (await admin.get('/api/admin/overview')).json;
  assert.ok(o.bank.total >= 40);
  assert.ok(o.totals.games > 0);
  assert.equal(o.funnel.length, 6);
  const s = (await admin.get('/api/admin/stats/questions?sort=hardest')).json;
  assert.ok(s.rows.length > 0);
  const csv = await admin.get('/api/admin/export/bank.csv');
  assert.match(csv.text, /c1-1a/);
  const audit = (await admin.get('/api/admin/audit')).json.rows;
  assert.ok(audit.some((a) => a.action === 'import.questions'));
});
