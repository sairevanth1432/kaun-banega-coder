// Simulated players against a running server: log in, play FFF + a classic game with lifelines, record latency.
//   npm run loadtest -- --make-roster 500 data/lt-roster.csv     write a roster of test players (LT00001…)
//   npm run seed -- --roster data/lt-roster.csv                    load it into the server's database
//   npm run loadtest -- --url http://localhost:3000 --players 500 --games 2
// Start the server with MAX_GAMES_PER_HOUR / MOVES_PER_MINUTE high enough for the test.
import fs from 'node:fs';

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const roll = (i) => 'LT' + String(i + 1).padStart(5, '0');

if (args.includes('--make-roster')) {
  const n = Number(val('make-roster', 500)), out = args[args.indexOf('--make-roster') + 2] || 'data/lt-roster.csv';
  fs.writeFileSync(out, 'NIAT ID,Student Name,University\n' + Array.from({ length: n }, (_, i) => `${roll(i)},Load Tester ${i + 1},Load Test`).join('\n'));
  console.log(`Wrote ${n} test players to ${out}`);
  process.exit(0);
}

const URL0 = val('url', 'http://localhost:3000'), PLAYERS = Number(val('players', 100)), GAMES = Number(val('games', 1));
const lat = {}, errors = {};
async function call(jar, method, path, body, name) {
  const t = performance.now();
  const r = await fetch(URL0 + path, { method, headers: { 'content-type': 'application/json', origin: URL0, cookie: jar.c || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie();
  if (sc.length) jar.c = sc.map((c) => c.split(';')[0]).join('; ');
  const d = await r.json().catch(() => ({}));
  (lat[name] = lat[name] || []).push(performance.now() - t);
  if (!r.ok) { errors[name + ' ' + (d.error || r.status)] = (errors[name + ' ' + (d.error || r.status)] || 0) + 1; return null; }
  return d;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms * (0.5 + Math.random())));

async function player(i) {
  const jar = {};
  if (!(await call(jar, 'POST', '/api/auth/name-login', { rollNo: roll(i), name: 'Load Tester ' + (i + 1) }, 'login'))) return;
  await call(jar, 'GET', '/api/bootstrap', null, 'bootstrap');
  for (let k = 0; k < GAMES; k++) {
    const f = await call(jar, 'POST', '/api/fff/start', {}, 'fff.start');
    if (f) { await pause(800); await call(jar, 'POST', '/api/fff/submit', { runId: f.runId, order: [0, 1, 2, 3] }, 'fff.submit'); }
    const s = await call(jar, 'POST', '/api/game/start', { mode: 'classic' }, 'game.start');
    if (!s) continue;
    let g = s.game;
    await pause(2600);   // the intro card
    while (g && g.state === 'play') {
      if (g.level === 1 && Math.random() < 0.5) await call(jar, 'POST', `/api/game/${g.id}/lifeline`, { k: 'poll' }, 'lifeline');
      await pause(1500);
      const a = await call(jar, 'POST', `/api/game/${g.id}/answer`, { rung: g.level, pick: Math.floor(Math.random() * 4) }, 'answer');
      if (!a) break;
      g = a.game;
      if (g.state === 'play') { await pause(600); g = (await call(jar, 'POST', `/api/game/${g.id}/next`, {}, 'next'))?.game; await pause(2600); }
    }
    await call(jar, 'GET', '/api/leaderboard', null, 'leaderboard');
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: PLAYERS }, (_, i) => pause(i * 10).then(() => player(i))));
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(`\n${PLAYERS} players × ${GAMES} game(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
console.log('request'.padEnd(14), 'count'.padStart(7), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'max ms'.padStart(8));
for (const [k, a] of Object.entries(lat)) console.log(k.padEnd(14), String(a.length).padStart(7), pct(a, 0.5).toFixed(0).padStart(8), pct(a, 0.95).toFixed(0).padStart(8), Math.max(...a).toFixed(0).padStart(8));
console.log(Object.keys(errors).length ? '\nErrors: ' + JSON.stringify(errors) : '\nNo errors.');
process.exit(0);
