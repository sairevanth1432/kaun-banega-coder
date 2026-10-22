// The money board: 15 rungs, a checkpoint every 3 rungs (C1–C5), and the rule that fills each rung's question pool.
// Stored in the settings table (key kbc_ladder) and edited in Admin → Ladder & pools. The default reproduces the
// original single-file game: rungs 1–6 open, drawing from C1/C2 levels in prerequisite order.
import { getSetting, setSetting } from './db.js';

export const CHECKPOINTS = [
  { id: 'C1', title: 'Think Like a Coder', tag: 'Logic, steps and patterns. No code yet.',
    skills: [['K1', 'Algorithms & steps'], ['K2', 'Data & variables'], ['K3', 'Operators'], ['K4', 'Decisions'], ['K5', 'Repetition']] },
  { id: 'C2', title: 'Python in Action', tag: 'Read, trace and fix real Python.',
    skills: [['P1', 'print & variables'], ['P2', 'Data types'], ['P3', 'Operators'], ['P4', 'Strings'], ['P5', 'Conditions'], ['P6', 'Loops']] },
  { id: 'C3', title: 'Strings & Lists', tag: 'Slicing, methods and list tricks.',
    skills: [['L1', 'Indexing'], ['L2', 'Slicing'], ['L3', 'String methods'], ['L4', 'Lists']] },
  { id: 'C4', title: 'Functions', tag: 'Write and reuse your own code.',
    skills: [['F1', 'def & return'], ['F2', 'Parameters'], ['F3', 'Scope']] },
  { id: 'C5', title: 'Problem Solving', tag: 'Put it all together, against the clock.',
    skills: [['X1', 'Dry runs'], ['X2', 'Patterns'], ['X3', 'Debugging']] }
];

const AMOUNTS = [1000, 2000, 5000, 10000, 20000, 40000, 80000, 160000, 320000, 640000, 1250000, 2500000, 5000000, 7500000, 10000000];
const TIMES = [30, 30, 45, 60, 60, 75, 75, 90, 90, 90, 120, 120, 120, 150, 180];
const BANDS = [[1, 2], [3, 5], [6, 10]]; // the original game split C1's 10 levels 2/3/5 across its rungs and C2's 3/3/4
const BANDS3 = [[1, 3], [4, 6], [7, 10]];

export const DEFAULT_LADDER = {
  openRungs: 6,
  lifelines: ['fifty', 'poll', 'expert', 'flip'],
  rungs: AMOUNTS.map((amount, i) => {
    const cp = Math.floor(i / 3), band = (cp === 0 ? BANDS : BANDS3)[i % 3];
    return { amount, timeSec: TIMES[i], checkpoint: i % 3 === 2 ? 'C' + (cp + 1) : '', rule: { checkpoint: 'C' + (cp + 1), diffMin: band[0], diffMax: band[1], skills: [] } };
  }),
  checkpoints: CHECKPOINTS
};

export const LIFELINES = { fifty: '50:50', poll: 'Audience poll', expert: 'Ask the expert', flip: 'Flip' };

export class LadderError extends Error {
  constructor(message) { super(message); this.code = 'BAD_LADDER'; this.status = 400; }
}

export async function getLadder() {
  return (await getSetting('kbc_ladder', null)) || DEFAULT_LADDER;
}

export const skillIds = (ladder) => new Set(ladder.checkpoints.flatMap((c) => c.skills.map((s) => s[0])));
export const checkpointIds = (ladder) => new Set(ladder.checkpoints.map((c) => c.id));

export function cleanLadder(input) {
  const L = input || {};
  const checkpoints = Array.isArray(L.checkpoints) && L.checkpoints.length ? L.checkpoints.map((c) => ({
    id: String(c.id || '').trim().toUpperCase(), title: String(c.title || '').trim().slice(0, 80), tag: String(c.tag || '').trim().slice(0, 160),
    skills: (Array.isArray(c.skills) ? c.skills : []).map((s) => [String(s[0] || '').trim().toUpperCase(), String(s[1] || '').trim().slice(0, 60)]).filter((s) => s[0])
  })) : CHECKPOINTS;
  const cps = new Set(checkpoints.map((c) => c.id));
  if (!Array.isArray(L.rungs) || L.rungs.length < 1 || L.rungs.length > 20) throw new LadderError('The ladder needs 1–20 rungs.');
  let prev = 0;
  const rungs = L.rungs.map((r, i) => {
    const amount = Math.round(Number(r.amount)), timeSec = Math.round(Number(r.timeSec));
    const rule = r.rule || {}, diffMin = Math.round(Number(rule.diffMin)), diffMax = Math.round(Number(rule.diffMax));
    if (!(amount > prev)) throw new LadderError(`Rung ${i + 1}: each amount must be bigger than the one below it.`);
    if (!(timeSec >= 10 && timeSec <= 600)) throw new LadderError(`Rung ${i + 1}: the timer must be 10–600 seconds.`);
    if (!cps.has(String(rule.checkpoint || ''))) throw new LadderError(`Rung ${i + 1}: unknown checkpoint "${rule.checkpoint}".`);
    if (!(diffMin >= 1 && diffMax <= 10 && diffMin <= diffMax)) throw new LadderError(`Rung ${i + 1}: difficulty must be a range within 1–10.`);
    prev = amount;
    return { amount, timeSec, checkpoint: r.checkpoint ? String(r.checkpoint) : '',
      rule: { checkpoint: String(rule.checkpoint), diffMin, diffMax, skills: (Array.isArray(rule.skills) ? rule.skills : []).map(String).filter(Boolean) } };
  });
  const openRungs = Math.round(Number(L.openRungs));
  if (!(openRungs >= 1 && openRungs <= rungs.length)) throw new LadderError('Open rungs must be between 1 and the number of rungs.');
  const lifelines = (Array.isArray(L.lifelines) ? L.lifelines : []).filter((k) => LIFELINES[k]);
  return { openRungs, lifelines, rungs, checkpoints };
}

export async function saveLadder(input) {
  const L = cleanLadder(input);
  await setSetting('kbc_ladder', L);
  return L;
}

// What players see: amounts, timers, checkpoints. Pool rules stay on the server.
export const publicLadder = (L) => ({
  openRungs: L.openRungs, lifelines: L.lifelines,
  rungs: L.rungs.map((r) => ({ amount: r.amount, timeSec: r.timeSec, checkpoint: r.checkpoint })),
  checkpoints: L.checkpoints
});
