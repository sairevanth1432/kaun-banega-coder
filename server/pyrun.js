// Runs Python for the question types that are graded by running code (fill, parsons, golf).
// One warm worker (pyworker.js) takes one run at a time; a run that passes its time limit gets the worker killed and
// reported as "never stops", and the next run starts a fresh worker.
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./pyworker.js', import.meta.url);
let worker = null, ready = null, seq = 0, chain = Promise.resolve();
const waiting = new Map();

function spawn() {
  worker = new Worker(WORKER);
  ready = new Promise((resolve, reject) => {
    const onMsg = (m) => {
      if (m && m.ready) return resolve();
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    };
    worker.on('message', onMsg);
    worker.once('error', (e) => { reject(e); for (const w of waiting.values()) w({ out: '', err: 'RunnerError: ' + e.message }); waiting.clear(); worker = null; });
  });
  worker.unref();
  return ready;
}

// Warm the runner up in the background (loading Pyodide takes a couple of seconds).
export function warm() { if (!worker) spawn().catch(() => {}); }

async function runOne(code, stdin, timeoutMs) {
  if (!worker) spawn();
  worker.ref();
  await ready;
  const id = ++seq, w = worker;
  w.ref();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting.delete(id);
      if (worker === w) { worker = null; w.terminate().catch(() => {}); }
      resolve({ out: '', err: null, timeout: true });
    }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); w.unref(); resolve({ out: m.out, err: m.err, timeout: false }); });
    w.postMessage({ id, code, stdin });
  });
}

// Runs are queued so one slow program cannot overlap another.
export function runPython(code, stdin = '', timeoutMs = 2500) {
  const p = chain.then(() => runOne(code, stdin, timeoutMs), () => runOne(code, stdin, timeoutMs));
  chain = p.catch(() => {});
  return p;
}

export async function stop() { if (worker) { const w = worker; worker = null; await w.terminate().catch(() => {}); } }
