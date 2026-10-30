# Kaun Banega Coder

A KBC-style coding quiz for NIAT students, with a question bank of 1,000+ questions, a server that checks every answer, and an admin portal for the content team. The backend follows the patterns of [saturday-sprint](https://github.com/sairevanth1432/saturday-sprint): Express 5, Postgres (PGlite locally), optional Redis, cookie sessions, and admin login with an authenticator app.

```
server/
  index.js        routes: player API (/api), admin API (/api/admin), pages
  game.js         the game engine: deals questions, keeps the clock, checks answers, runs lifelines, leaderboards
  bank.js         question bank: validation, versions, draft → review → published → retired, cached pools per rung
  importer.js     CSV / Excel import with a dry-run preview (rows matched on ext_id)
  ladder.js       money board, checkpoints, skills, and the rule that fills each rung's pool
  events.js       Saturday-Sprint-style events (time window, attempts, fixed or rule-based question sets)
  stats.js        question health (too easy/hard, dead options, slow), funnel, skill accuracy
  fff.js          Fastest Finger First puzzles
  r1.js           the student game's saved progress, Hall of Fame (overall + per university), live player count, feedback
  auth.js, security.js, db.js, kv.js, recycle.js, roster.js   adapted from saturday-sprint
  public/play.html    the student game: skill path, hot seat, maths Fastest Finger First, Hall of Fame, product tour
  public/admin.html   the admin portal, styled to match the game
  public/login.html   player login: NIAT ID + name from the roster
  content/        starter questions (from the original game) and FFF puzzles
  legacy/         the original single-file game, kept for reference
  test/e2e.test.js
```

## Run it locally

```bash
cd server
npm install
npm run seed -- --roster path/to/roster.csv        # 40 starter questions, 7 FFF puzzles, your students
npm run create-admin -- --email you@nxtwave.co.in --name "Your Name" --super
npm run dev                                          # http://localhost:3000  (players: /login, admin: /admin)
```

No database or Redis is needed locally: PGlite stores data in `server/data/`. For a full bank to try things with, run `npm run gen-bank -- 1000 data/bank.csv`, then `npm run seed -- --questions data/bank.csv`.

## How the question bank works

- **One sheet format.** Download the template from Admin → Import. The columns are `ext_id, checkpoint, skill, type, difficulty (1–10), question, code, option_a…option_d, correct (A–D), hint, explanation, tags, status`. CSV and `.xlsx` both work.
- **Check before saving.** The import first checks every row and shows add / update / unchanged counts, row-level errors and possible duplicates. Nothing is saved until you press Import. Rows are matched on `ext_id`, so re-uploading an edited sheet updates questions instead of duplicating them.
- **Pools come from rules.** Each rung on the ladder draws from published questions of one checkpoint within a difficulty range, and can optionally be limited to some skills. Admin → Ladder & pools shows the size of each pool. Publishing a question puts it into the right pools; nobody has to hand-pick lists.
- **Versions, not locks.** Editing a published question saves a new version. Each game stores the question and version it was dealt, so history and replays never change.
- **Answers stay on the server.** Players receive only the question and the options, shuffled differently for each game. The correct option, the hint and the explanation arrive only after locking in an answer or using a lifeline. Timers, lifelines, coins and leaderboards are all worked out on the server.
- **Fast at scale.** Pools are a cached index of published questions, refreshed when the bank changes. The audience poll reads one row of per-question counters instead of every vote. Leaderboards are cached for 5 seconds.
- **No repeats.** Each player's last 200 questions are skipped while the pool still has others.

## The student game (play.html)

The question engine and the skill path run in the browser. The server keeps what must outlive a browser or be shared:

- `GET/PUT /api/r1/state`: each student's progress, so it follows them across devices. A shared laptop never mixes two students.
- `GET /api/r1/fame?scope=all|uni&uni=…`: the Hall of Fame, overall or for one university (from the roster's university column). Wallet numbers sent by the browser are capped at what real games can produce.
- `POST /api/r1/ping`: the "N live" count (students whose page pinged in the last 75 s).
- `POST /api/r1/log`: feedback and usage events. Admins read feedback at `GET /api/admin/feedback`.

## Admin portal

The admin portal has these sections:

- Overview
- Question bank, with search, filters, bulk publish or retire, an editor with a live preview, and version history
- Import
- Question analytics
- Fastest finger
- Ladder & pools
- Events (Saturday Sprint)
- Games, with a replay of each game
- Leaderboard
- Players & roster
- Settings, Admins, Recycle bin, Audit log

Admins draft questions and send them to review. Super admins publish questions, change the ladder, run events, upload the roster and manage admins. Settings has a switch that also lets admins publish.

## Tests

```bash
cd server && npm test
```

The end-to-end suite runs the real server on PGlite. It covers the following:

- The import's dry run and upserts.
- Every player response is checked to make sure no answer leaks.
- Shuffled options map back to the right answer.
- Double submits are blocked, and late answers count as a time-out.
- Every lifeline.
- Question versioning.
- Retired questions leave the pools.
- Events allow one ranked attempt, and their leaderboards rank in the right order.
- Fastest Finger First.
- Practice mode.
- The recycle bin.
- Admin roles.

## Deploy

The same options as saturday-sprint:

- **Vercel:** use `vercel.json` with Neon Postgres and Upstash Redis, and set `APP_SECRET`, `DATABASE_URL`, `KV_REST_API_*` and `CRON_SECRET`.
- **Docker:** use the `Dockerfile` in `server/`.

See `server/.env.example` for all the settings.
