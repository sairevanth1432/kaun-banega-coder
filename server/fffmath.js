// Fastest Finger First for the student game: quick maths puzzles made and checked on the server.
//   sprint: solve 5 of 15 quick sums · maze: in 2 grids, connect 3 touching numbers that add up to the target
//   cross: fill the 2 blanks of a 2×2 cross-sum. A round won inside its time limit unlocks one hot-seat game.
import crypto from 'node:crypto';
import { one, run, parseJSON } from './db.js';

export const FFF_MODES = { sprint: { secs: 45, need: 5 }, maze: { secs: 40, need: 2 }, cross: { secs: 50, need: 1 } };
const GRACE_S = 4;
const rint = (a, b) => a + crypto.randomInt(b - a + 1);
const shuf = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function sprintQ() {
  const k = rint(0, 7);
  if (k === 0) { const x = rint(3, 12), y = rint(3, 12); return { q: `${x} × ${y}`, a: x * y }; }
  if (k === 1) { const x = rint(12, 79), y = rint(11, 49); return { q: `${x} + ${y}`, a: x + y }; }
  if (k === 2) { const x = rint(40, 99), y = rint(11, 39); return { q: `${x} − ${y}`, a: x - y }; }
  if (k === 3) { const y = rint(2, 9), z = rint(3, 12); return { q: `${y * z} ÷ ${y}`, a: z }; }
  if (k === 4) { const x = rint(2, 9), y = rint(2, 9), z = rint(2, 9); return { q: `${x} + ${y} × ${z}`, a: x + y * z }; }
  if (k === 5) { const p = [10, 20, 25, 50][rint(0, 3)], n = [20, 40, 60, 80, 120, 200][rint(0, 5)]; return { q: `${p}% of ${n}`, a: (p * n) / 100 }; }
  if (k === 6) { const x = rint(4, 15); return { q: `${x}²`, a: x * x }; }
  const x = rint(3, 9), y = rint(3, 9), z = rint(1, x * y - 1); return { q: `${x} × ${y} − ${z}`, a: x * y - z };
}
export const mzNb = (c, N) => { const r = Math.floor(c / N), k = c % N, o = []; if (r > 0) o.push(c - N); if (r < N - 1) o.push(c + N); if (k > 0) o.push(c - 1); if (k < N - 1) o.push(c + 1); return o; };
function mazeGrid() {
  const N = 4, g = Array.from({ length: N * N }, () => rint(1, 9));
  let path = [];
  while (path.length < 3) { path = [rint(0, N * N - 1)]; while (path.length < 3) { const nb = mzNb(path[path.length - 1], N).filter((x) => !path.includes(x)); if (!nb.length) break; path.push(nb[rint(0, nb.length - 1)]); } }
  return { N, g, path, target: path.reduce((a, i) => a + g[i], 0) };
}
export const XOP = (a, o, b) => (o === '+' ? a + b : o === '−' ? a - b : a * b);
const crossOk = (w, o, R) => XOP(w[0], o[0], w[1]) === R[0] && XOP(w[2], o[1], w[3]) === R[1] && XOP(w[0], o[2], w[2]) === R[2] && XOP(w[1], o[3], w[3]) === R[3];
function crossGen() {
  const OPS = ['+', '−', '×'];
  for (let t = 0; t < 500; t++) {
    const v = [0, 1, 2, 3].map(() => rint(1, 9)), o = [0, 1, 2, 3].map(() => OPS[rint(0, 2)]);
    const R = [XOP(v[0], o[0], v[1]), XOP(v[2], o[1], v[3]), XOP(v[0], o[2], v[2]), XOP(v[1], o[3], v[3])];
    if (R.some((x) => x < 0 || x > 99)) continue;
    const bl = shuf([0, 1, 2, 3]).slice(0, 2).sort();
    if (v[bl[0]] === v[bl[1]]) continue;
    const dec = [];
    for (let n = 0; dec.length < 2 && n < 50; n++) { const d = rint(1, 9); if (!bl.some((k) => v[k] === d) && !dec.includes(d)) dec.push(d); }
    if (dec.length < 2) continue;
    const tiles = shuf([v[bl[0]], v[bl[1]], ...dec]);
    let n = 0;
    for (const x of tiles) for (const y of tiles) { if (x === y) continue; const w = v.slice(); w[bl[0]] = x; w[bl[1]] = y; if (crossOk(w, o, R)) n++; }
    if (n === 1) return { v, o, R, blanks: bl, tiles };
  }
  return { v: [3, 5, 2, 4], o: ['+', '+', '×', '+'], R: [8, 6, 6, 9], blanks: [1, 2], tiles: [5, 2, 7, 1] };
}

// What the player gets: everything needed to play (maths puzzles have no secret worth hiding); the server still
// checks the submitted solution and the time.
function publicPuzzle(mode, p) {
  if (mode === 'sprint') return { qs: p.qs.map((x) => ({ q: x.q, a: String(x.a) })) };
  if (mode === 'maze') return { grids: p.grids.map((m) => ({ N: m.N, g: m.g, target: m.target })) };
  return { v: p.v.map((x, k) => (p.blanks.includes(k) ? null : x)), o: p.o, R: p.R, blanks: p.blanks, tiles: p.tiles };
}

export async function fffStart(user, mode) {
  if (!FFF_MODES[mode]) mode = Object.keys(FFF_MODES)[crypto.randomInt(3)];
  const p = mode === 'sprint' ? { qs: Array.from({ length: 15 }, sprintQ) } : mode === 'maze' ? { grids: [mazeGrid(), mazeGrid()] } : crossGen();
  const id = crypto.randomBytes(12).toString('base64url'), now = Date.now();
  await run('INSERT INTO kbc_r1_fff (id, user_id, mode, puzzle, started_at) VALUES (?, ?, ?, ?, ?)', id, user.id, mode, JSON.stringify(p), now);
  return { id, mode, secs: FFF_MODES[mode].secs, puzzle: publicPuzzle(mode, p), serverNow: now };
}

// answer: sprint {answers: {index: value}} · maze {paths: [[i, j, k], [i, j, k]]} · cross {fill: {cell: value}}
export function checkFff(mode, p, answer) {
  const a = answer || {};
  if (mode === 'sprint') {
    const got = Object.entries(a.answers || {}).filter(([i, v]) => p.qs[i] && String(v).trim() === String(p.qs[i].a)).length;
    return got >= FFF_MODES.sprint.need;
  }
  if (mode === 'maze') {
    const paths = Array.isArray(a.paths) ? a.paths : [];
    return p.grids.every((m, gi) => {
      const path = (paths[gi] || []).map(Number);
      return path.length === 3 && new Set(path).size === 3 && path.every((c) => c >= 0 && c < m.g.length)
        && path.every((c, i) => i === 0 || mzNb(path[i - 1], m.N).includes(c)) && path.reduce((s, c) => s + m.g[c], 0) === m.target;
    });
  }
  const fill = a.fill || {}, w = p.v.slice(), left = p.tiles.slice();
  for (const k of p.blanks) { const v = Number(fill[k]), at = left.indexOf(v); if (at < 0) return false; left.splice(at, 1); w[k] = v; }
  return crossOk(w, p.o, p.R);
}

export async function fffSubmit(user, id, answer) {
  const r = await one('SELECT * FROM kbc_r1_fff WHERE id = ? AND user_id = ?', String(id || ''), user.id);
  if (!r) return { ok: false, error: 'NOT_FOUND' };
  if (r.done_at) return { ok: !!r.ok, secs: Number(r.secs), already: true };
  const p = parseJSON(r.puzzle, {}), now = Date.now(), secs = (now - Number(r.started_at)) / 1000;
  const timeUp = secs > FFF_MODES[r.mode].secs + GRACE_S, ok = !timeUp && checkFff(r.mode, p, answer);
  await run('UPDATE kbc_r1_fff SET done_at = ?, ok = ?, secs = ? WHERE id = ?', now, ok ? 1 : 0, secs, r.id);
  const solution = r.mode === 'sprint' ? null : r.mode === 'maze' ? { paths: p.grids.map((m) => m.path) } : { v: p.v };
  return { ok, timeUp, secs: Math.round(secs * 10) / 10, solution };
}
