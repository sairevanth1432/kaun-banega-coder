// Shared fast state: rate limits, caches, autosave drafts, locks.
//   REDIS_URL=redis://…          any standard Redis (Docker container, self-hosted, Redis Cloud…)
//   KV_REST_API_URL/TOKEN        Upstash Redis over HTTP (serverless platforms such as Vercel)
//   neither                      in-process memory (one server process only)
import { config } from './config.js';

let redis = null;
if (config.redisTcpUrl) {
  const { createClient } = await import('redis');
  const c = createClient({ url: config.redisTcpUrl, socket: { reconnectStrategy: (n) => Math.min(n * 200, 3000) } });
  c.on('error', (e) => console.error('[kv] redis error:', e.message));
  await c.connect();
  const parse = (v) => { if (v == null) return null; try { return JSON.parse(v); } catch { return v; } };
  // Same small interface as the Upstash client below.
  redis = {
    get: async (k) => parse(await c.get(k)),
    set: async (k, v, o) => {
      const opts = {};
      if (o && o.ex) opts.EX = o.ex;
      if (o && o.nx) opts.NX = true;
      return c.set(k, JSON.stringify(v), opts);
    },
    del: (k) => c.del(k),
    pipeline: () => {
      const m = c.multi();
      return { incr: (k) => m.incr(k), expire: (k, s, mode) => m.expire(k, s, mode), exec: () => m.exec() };
    }
  };
} else if (config.redisUrl && config.redisToken) {
  const { Redis } = await import('@upstash/redis');
  redis = new Redis({ url: config.redisUrl, token: config.redisToken, automaticDeserialization: true });
}
export const kvShared = !!redis;
export const kvKind = config.redisTcpUrl ? 'redis' : redis ? 'upstash' : 'memory';

const mem = new Map(); // key → { v, exp }
const memGet = (k) => { const e = mem.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; } return e.v; };
setInterval(() => { const now = Date.now(); for (const [k, e] of mem) if (e.exp && e.exp < now) mem.delete(k); }, 60000).unref();

export async function get(key) {
  if (redis) return (await redis.get(key)) ?? null;
  return memGet(key);
}
export async function set(key, value, ttlSec) {
  if (redis) return redis.set(key, value, ttlSec ? { ex: ttlSec } : undefined);
  mem.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}
export async function del(key) {
  if (redis) return redis.del(key);
  mem.delete(key);
}
// Set only if absent (a simple lock). Returns true when this caller got it.
export async function setNX(key, value, ttlSec) {
  if (redis) return (await redis.set(key, value, { nx: true, ex: ttlSec })) === 'OK';
  if (memGet(key) !== null) return false;
  mem.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  return true;
}
export async function incr(key, ttlSec) {
  if (redis) {
    const p = redis.pipeline();
    p.incr(key);
    p.expire(key, ttlSec, 'NX');
    const [n] = await p.exec();
    return Number(n);
  }
  const n = (Number(memGet(key)) || 0) + 1;
  const e = mem.get(key);
  mem.set(key, { v: n, exp: e && e.exp > Date.now() ? e.exp : Date.now() + ttlSec * 1000 });
  return n;
}

// Fixed-window rate limit shared across instances.
export async function rateLimit(key, limit, windowMs) {
  const now = Date.now(), win = Math.floor(now / windowMs);
  try {
    const n = await incr(`rl:${key}:${win}`, Math.ceil(windowMs / 1000) + 1);
    return n <= limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: (win + 1) * windowMs - now };
  } catch (e) {
    console.error('[kv] rate limit unavailable:', e.message);
    return { ok: true, retryAfterMs: 0 }; // fail open rather than lock everyone out
  }
}

// Read-through cache: a short in-process layer in front of Redis, so hot keys cost ~nothing per request.
const local = new Map();
export async function cached(key, ttlSec, loader, { localMs = 2000 } = {}) {
  const l = local.get(key);
  if (l && Date.now() - l.at < Math.min(localMs, ttlSec * 1000)) return l.v;
  let v = redis ? await get(key).catch(() => null) : null;
  if (v === null || v === undefined) {
    v = await loader();
    if (redis) await set(key, v, ttlSec).catch(() => {});
  }
  local.set(key, { at: Date.now(), v });
  if (local.size > 5000) local.clear();
  return v;
}
export async function invalidate(key) {
  local.delete(key);
  if (redis) await del(key).catch(() => {});
  else mem.delete(key);
}
export function clearLocal() { local.clear(); }
