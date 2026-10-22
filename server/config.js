// Central configuration. Values come from environment variables (Vercel → Project → Settings → Environment Variables)
// or, locally, from server/.env (see .env.example). Trimmed from saturday-sprint/server/config.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const isVercel = !!env.VERCEL;
const isProd = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
// On Vercel the deployment folder is read-only; only /tmp is writable.
const dataDir = isVercel ? path.join('/tmp', 'kbc-data') : path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

function appSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (isProd || isVercel) throw new Error('APP_SECRET must be set (32+ random characters).');
  const f = path.join(dataDir, '.dev-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
}

export const config = {
  isProd, isVercel,
  appName: env.APP_NAME || 'Kaun Banega Coder',
  port: Number(env.PORT || 3000),
  host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  trustProxy: isVercel ? true : env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY) : false,
  cookieSecure: bool(env.COOKIE_SECURE, isProd || isVercel),
  secret: appSecret(),

  // ---- data stores
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  dbPoolMax: Number(env.DB_POOL_MAX || (isVercel ? 5 : 10)),
  pgliteMemory: bool(env.PGLITE_MEMORY, false),
  redisTcpUrl: /^rediss?:\/\//.test(env.REDIS_URL || '') && !(isVercel && (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL)) ? env.REDIS_URL : '',
  redisUrl: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
  redisToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
  cronSecret: env.CRON_SECRET || '',
  dataDir,

  session: {
    studentMs: Number(env.STUDENT_SESSION_DAYS || 7) * 86400000,
    adminMs: Number(env.ADMIN_SESSION_HOURS || 8) * 3600000
  },

  admin: {
    requireTotp: bool(env.ADMIN_REQUIRE_TOTP, true),
    maxFailedLogins: 5,
    lockMs: 15 * 60000
  },

  game: {
    graceMs: Number(env.ANSWER_GRACE_MS || 3000),   // network slack after a question's timer runs out
    introMs: 2500,                                  // the "Q1 for ₹1,000" card shown before the timer starts
    maxGamesPerHour: Number(env.MAX_GAMES_PER_HOUR || 60),
    movesPerMinute: Number(env.MOVES_PER_MINUTE || 120)   // answers, lifelines, next… per player
  }
};

// Vercel functions have no permanent disk: without DATABASE_URL every data change would be lost.
if (isVercel && !config.databaseUrl) {
  throw new Error('DATABASE_URL is not set. Connect a Postgres database (e.g. Neon in Vercel → Storage) to this project.');
}
