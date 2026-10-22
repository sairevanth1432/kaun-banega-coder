// Postgres everywhere (pattern from saturday-sprint/server/db.js).
//   Production: DATABASE_URL → Neon/any Postgres through its connection pooler.
//   Local:      no DATABASE_URL → PGlite (real Postgres compiled to WASM) in data/pglite. Nothing to install.
// All timestamps are epoch milliseconds (BIGINT). Queries use "?" placeholders; they are converted to $1, $2…
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

const SCHEMA = `
-- ---------------------------------------------------------------- people
CREATE TABLE IF NOT EXISTS students_master (
  roll_no     TEXT PRIMARY KEY,              -- NIAT ID, normalised: trimmed, upper-case, no spaces
  name        TEXT NOT NULL DEFAULT '',
  batch       TEXT NOT NULL DEFAULT '',
  university  TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  roll_no        TEXT NOT NULL UNIQUE REFERENCES students_master(roll_no),
  display_name   TEXT NOT NULL DEFAULT '',   -- shown on the leaderboard; admins can moderate it
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);
CREATE TABLE IF NOT EXISTS student_logins (id BIGSERIAL PRIMARY KEY, roll_no TEXT NOT NULL, at BIGINT NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE IF NOT EXISTS admins (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'admin',   -- admin | super_admin
  password_hash   TEXT NOT NULL,
  must_change_pw  INTEGER NOT NULL DEFAULT 0,
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  last_login_at   BIGINT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  subject_id    BIGINT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'full',
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  ip            TEXT,
  ua            TEXT
);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(kind, subject_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, admin_id BIGINT, admin_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recycle_bin (id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', payload TEXT,
  deleted_at BIGINT NOT NULL, deleted_by TEXT, restored_at BIGINT, purged_at BIGINT);
CREATE INDEX IF NOT EXISTS recycle_bin_open ON recycle_bin(deleted_at) WHERE restored_at IS NULL AND purged_at IS NULL;

-- ---------------------------------------------------------------- question bank
CREATE TABLE IF NOT EXISTS kbc_questions (
  id           BIGSERIAL PRIMARY KEY,
  ext_id       TEXT NOT NULL UNIQUE,             -- the spreadsheet's id; imports upsert on it
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft | review | published | retired
  checkpoint   TEXT NOT NULL,                    -- C1 … C5
  skill        TEXT NOT NULL DEFAULT '',         -- e.g. K4
  type         TEXT NOT NULL DEFAULT '',         -- Concept, Predict the output, Spot the bug…
  difficulty   INTEGER NOT NULL,                 -- 1 (easiest) … 10
  q            TEXT NOT NULL,
  code         TEXT NOT NULL DEFAULT '',
  options      TEXT NOT NULL,                    -- JSON array of 4 strings
  correct      INTEGER NOT NULL,                 -- 0…3; never sent to players
  hint         TEXT NOT NULL DEFAULT '',
  why          TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',
  version      INTEGER NOT NULL DEFAULT 1,
  fingerprint  TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  updated_by   TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS kbc_questions_pool ON kbc_questions(status, checkpoint, difficulty);
CREATE INDEX IF NOT EXISTS kbc_questions_fp ON kbc_questions(fingerprint);
-- Every saved version of a question (games point at qid + version, so history never changes under them).
CREATE TABLE IF NOT EXISTS kbc_question_versions (
  question_id BIGINT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, by TEXT, at BIGINT NOT NULL,
  PRIMARY KEY (question_id, version)
);
CREATE TABLE IF NOT EXISTS kbc_imports (
  id BIGSERIAL PRIMARY KEY, filename TEXT, rows INTEGER NOT NULL, added INTEGER NOT NULL, updated INTEGER NOT NULL,
  unchanged INTEGER NOT NULL, errors TEXT, by TEXT, at BIGINT NOT NULL
);
-- Fastest Finger First puzzles: put 4 lines in order.
CREATE TABLE IF NOT EXISTS kbc_fff (
  id BIGSERIAL PRIMARY KEY, task TEXT NOT NULL, lines TEXT NOT NULL, answer TEXT NOT NULL,   -- answer: e.g. "BDCA"
  status TEXT NOT NULL DEFAULT 'published', updated_by TEXT, updated_at BIGINT NOT NULL
);

-- ---------------------------------------------------------------- events (Saturday Sprint)
CREATE TABLE IF NOT EXISTS kbc_events (
  id                   TEXT PRIMARY KEY,         -- e.g. sprint-2026-10-24
  title                TEXT NOT NULL,
  open_at              BIGINT NOT NULL,
  close_at             BIGINT NOT NULL,
  mode                 TEXT NOT NULL DEFAULT 'rules',   -- rules: draw from the ladder pools | fixed: frozen question per rung
  fixed                TEXT NOT NULL DEFAULT '[]',      -- fixed mode: [[qid, …] per rung]; one is drawn per rung, the rest power Flip
  attempts_allowed     INTEGER NOT NULL DEFAULT 1,
  leaderboard_visible  INTEGER NOT NULL DEFAULT 1,
  created_by           TEXT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);

-- ---------------------------------------------------------------- play
CREATE TABLE IF NOT EXISTS kbc_fff_runs (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, fff_id BIGINT NOT NULL, perm TEXT NOT NULL,
  started_at BIGINT NOT NULL, done_at BIGINT, ok INTEGER, secs REAL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kbc_games (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  event_id      TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL,                    -- classic | practice | event
  seed          TEXT NOT NULL,
  plan          TEXT NOT NULL,                    -- JSON [{qid, version, perm:[4]}] one per open rung
  level         INTEGER NOT NULL DEFAULT 0,
  used          TEXT NOT NULL DEFAULT '{}',       -- lifelines used: {fifty:1, poll:1…}
  removed       TEXT NOT NULL DEFAULT '[]',       -- options removed by 50:50 on the current question (shown positions)
  q_shown_at    BIGINT,
  deadline      BIGINT,
  state         TEXT NOT NULL DEFAULT 'play',     -- play | done
  reason        TEXT,                             -- win | wrong | timeout | quit
  amount        BIGINT NOT NULL DEFAULT 0,
  correct       INTEGER NOT NULL DEFAULT 0,
  coins         BIGINT NOT NULL DEFAULT 0,
  secs          INTEGER,
  fff_secs      REAL NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,       -- 1 = removed from leaderboards by an admin
  result_detail TEXT,                             -- JSON: coin breakdown, new badges, wallet, share code
  started_at    BIGINT NOT NULL,
  ended_at      BIGINT
);
CREATE INDEX IF NOT EXISTS kbc_games_user ON kbc_games(user_id, started_at);
CREATE INDEX IF NOT EXISTS kbc_games_board ON kbc_games(event_id, state, amount);
CREATE INDEX IF NOT EXISTS kbc_games_started ON kbc_games(started_at);
CREATE TABLE IF NOT EXISTS kbc_answers (
  game_id TEXT NOT NULL, rung INTEGER NOT NULL, qid BIGINT NOT NULL, version INTEGER NOT NULL,
  pick INTEGER NOT NULL,                  -- original option index, -1 = time ran out
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, lifelines TEXT NOT NULL DEFAULT '[]', at BIGINT NOT NULL,
  PRIMARY KEY (game_id, rung)
);
CREATE INDEX IF NOT EXISTS kbc_answers_q ON kbc_answers(qid);
-- Running totals per question, updated on every answer: the audience poll and analytics read one row.
CREATE TABLE IF NOT EXISTS kbc_qstats (
  qid BIGINT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, timeouts INTEGER NOT NULL DEFAULT 0,
  p0 INTEGER NOT NULL DEFAULT 0, p1 INTEGER NOT NULL DEFAULT 0, p2 INTEGER NOT NULL DEFAULT 0, p3 INTEGER NOT NULL DEFAULT 0,
  total_ms BIGINT NOT NULL DEFAULT 0, shown INTEGER NOT NULL DEFAULT 0,
  ll_fifty INTEGER NOT NULL DEFAULT 0, ll_poll INTEGER NOT NULL DEFAULT 0, ll_expert INTEGER NOT NULL DEFAULT 0, ll_flip INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kbc_profiles (
  user_id BIGINT PRIMARY KEY, coins BIGINT NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, best BIGINT NOT NULL DEFAULT 0,
  best_reached INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
  badges TEXT NOT NULL DEFAULT '[]', seen TEXT NOT NULL DEFAULT '[]', updated_at BIGINT NOT NULL
);
`;

// ---------- backend
let backend = null;
async function open() {
  if (config.databaseUrl) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // BIGINT → number (ms timestamps fit)
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC (AVG) → number
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false }
    });
    pool.on('error', (e) => console.error('[db] idle client error', e.message));
    return {
      kind: 'postgres',
      query: async (sql, params, client) => (await (client || pool).query(sql, params)).rows,
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end()
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = await PGlite.create(config.pgliteMemory ? undefined : path.join(config.dataDir, 'pglite'));
  return {
    kind: 'pglite',
    query: async (sql, params, client) => (await (client || lite).query(sql, params)).rows,
    exec: (sql) => lite.exec(sql),
    transaction: (fn) => lite.transaction((t) => fn(t)),
    close: () => lite.close()
  };
}

const txStore = new AsyncLocalStorage();
let readyPromise = null;

// Connect and create tables once per process. Safe with many serverless instances (advisory lock).
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      backend = await open();
      if (backend.kind === 'postgres') {
        await backend.transaction(async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(72631002)');
          await c.query(SCHEMA);
        });
      } else {
        await backend.exec(SCHEMA);
      }
      return backend;
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

export async function query(sql, params = []) {
  const b = backend || (await ready());
  return b.query(toPg(sql), params, txStore.getStore());
}
export const all = (sql, ...p) => query(sql, p);
export const one = async (sql, ...p) => (await query(sql, p))[0];
export const run = (sql, ...p) => query(sql, p);

// Runs fn inside one transaction; every one/all/run called inside it uses the same connection.
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const b = backend || (await ready());
  return b.transaction((client) => txStore.run(client, fn));
}

export async function close() { if (backend) await backend.close(); backend = null; readyPromise = null; }
export const dbKind = () => (backend ? backend.kind : config.databaseUrl ? 'postgres' : 'pglite');

// ---------- small helpers
const settingCache = new Map();
export async function getSetting(key, fallback = null) {
  const hit = settingCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.v ?? fallback;
  const r = await one('SELECT value FROM settings WHERE key = ?', key);
  const v = r ? JSON.parse(r.value) : null;
  settingCache.set(key, { at: Date.now(), v });
  return v ?? fallback;
}
export async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  settingCache.delete(key);
}
export const clearSettingCache = () => settingCache.clear();

export async function audit(req, action, target, detail) {
  const a = req && req.admin;
  await run('INSERT INTO audit_log (admin_id, admin_email, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    a ? a.id ?? null : null, a ? a.email ?? null : null, action, target == null ? null : String(target),
    detail == null ? null : JSON.stringify(detail), req ? req.ip || null : null, Date.now());
}

export const parseJSON = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
