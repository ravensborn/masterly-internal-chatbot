# Implementation Plan — Masterly Internal DB Chatbot

## What already exists (bootstrap commit)

- `docker-compose.yml` with three services:
  - **`db`** — `postgres:18`, the stack's own internal Postgres (named volume `db-data`, host port `2010` for debugging). Holds database `masterly_snapshot`.
  - **`sync`** — `postgres:18` running `sync/sync.sh`: every `SYNC_INTERVAL_SECONDS` (default 1h) it `pg_dump`s the source masterly DB (infra table **data** excluded: `cache`, `cache_locks`, `jobs`, `job_batches`, `failed_jobs`, `personal_access_tokens`), restores into staging DB `masterly_snapshot_next`, atomically swaps it to `masterly_snapshot` (`DROP ... WITH (FORCE)` + `ALTER DATABASE ... RENAME`), then re-creates/grants the read-only `chatbot` role (SELECT-only, `default_transaction_read_only = on`, 15s statement timeout). A failed cycle leaves the previous snapshot intact.
  - **`app`** — built from `Dockerfile` (`node:22-bookworm-slim`, Claude Code preinstalled), repo volume-mounted at `/app`, port `8080:8080`. Idles until `package.json` exists, then `npm install && npm start`.
- `.env.example` — copy to `.env` and fill in. The app receives `DB_HOST=db`, `DB_DATABASE=masterly_snapshot`, `DB_USERNAME=chatbot`, `DB_PASSWORD=$CHATBOT_DB_PASSWORD` plus `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `CHAT_USERNAME`, `CHAT_PASSWORD`, `PORT`.

## What to build (this repo, next sessions)

A single-page, basic-auth-protected chatbot that answers natural-language questions about the Masterly LMS database ("how many users do I have?", "how many users have at least one order?") by letting the model run SQL against the internal snapshot via a tool.

### 1. `package.json`

- `"type": "module"`, `"scripts": {"start": "node server.js"}`.
- Dependencies: **only** `@anthropic-ai/sdk` and `pg`. No framework, no build step, plain JS.

### 2. `server.js` — plain `node:http` server

**Postgres pool** (`pg.Pool`): host/port/db/user/password from `DB_*` env, `max: 3`, `options: '-c search_path=public'`, `statement_timeout: 15000`, `connectionTimeoutMillis: 5000`. The `chatbot` role is the security boundary (SELECT-only + read-only transactions enforced server-side) — no SQL parsing/filtering needed in JS.

**Basic auth middleware** applied to every route:
- If `CHAT_USERNAME`/`CHAT_PASSWORD` env are empty → respond `503` "chat auth not configured".
- Parse `Authorization: Basic`, compare both values with `crypto.timingSafeEqual` (length-pad before comparing to avoid throw on length mismatch).
- On failure → `401` with `WWW-Authenticate: Basic realm="Masterly DB Chat"`.

**`GET /`** → serve `public/index.html`.

**`POST /api/chat`**:
- Body `{ messages: [{role: 'user'|'assistant', content: string}, ...] }` — the browser keeps the full conversation and sends it each time (server is stateless). Reject bodies > 1 MB or > 40 turns with a friendly "start a new conversation" error.
- Call the Anthropic SDK **tool runner**:

```js
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';

const runSql = betaTool({
  name: 'run_sql',
  description: 'Run a read-only SQL query against the masterly_snapshot Postgres database (hourly copy of production). Returns rows as JSON.',
  inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  run: async ({ sql }) => {
    try {
      const { rows } = await pool.query(sql);
      return capResult(rows); // max 200 rows / ~50KB, append '[truncated: showing X of Y rows]'
    } catch (e) {
      return `SQL error: ${e.message}`; // model reads this and self-corrects
    }
  },
});

const final = await client.beta.messages.toolRunner({
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  max_tokens: 16000,
  system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
  tools: [runSql],
  messages,
  max_iterations: 10,
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
});
```

- **Check `final.stop_reason` before reading content** — on `'refusal'` return `{ error: 'The model declined this request.' }`; on `'max_tokens'` append a truncation note. Otherwise join the `text` blocks and respond `{ reply, stop_reason }`.
- Do **not** send `temperature`, `top_p`, `top_k`, or a `thinking` param (removed / on-by-default on claude-opus-5).
- Map SDK errors to HTTP, most-specific first: `AuthenticationError` → 502 "API key invalid", `RateLimitError` → 429, `APIConnectionError` → 502 (check before `APIError` — it's a subclass in the TS SDK), `APIError` → 502, anything else → 500.

**System prompt** (`buildSystemPrompt()`), cached in memory and rebuilt when source files' mtimes change:
1. Static guidelines: you answer questions about the Masterly LMS database via `run_sql`; Postgres 18; the data is an hourly snapshot (may be up to 1h stale — say so when asked about "now"); always `LIMIT` exploratory queries; answer in plain language with the numbers, not raw SQL dumps.
2. Contents of `schema-notes.md` (curated, committed).
3. Contents of `schema.generated.md` (generated, gitignored) — if missing, a placeholder saying the schema doc hasn't been generated yet.

### 3. `scripts/generate-schema-doc.js`

Connects to the internal DB (same `DB_*` env) and writes `schema.generated.md`: for every `public` base table — columns (name, type, nullable; omit `nextval(...)` defaults), PK, FK relationships (`learner_id → learners.id`), and row count. Compact markdown tables, one section per table, timestamp header. The server runs this at boot and re-runs it lazily when the cached copy is older than ~15 minutes (cheap; keeps the doc in step with the hourly sync without coordinating with the sync container).

### 4. `schema-notes.md` (hand-written, committed)

Things introspection can't tell the model:
- **Translatable columns** (spatie/laravel-translatable): many text columns (`courses.title`, `courses.description`, category names, …) are JSON maps like `{"en": "...", "ar": "...", "ckb": "..."}` — query with `title->>'en'` or `ILIKE` on the raw text; a plain `WHERE title = 'x'` will never match.
- **Domain map**: users → learners/instructors/admins profiles; learners buy courses/bundles via orders + payments (FIB/FastPay gateways) → enrollments; lessons grouped in lesson_groups with videos (Cloudflare Stream) and lesson_watches; quizzes with attempts/answers; ratings, favorites; support chat in conversations/messages.
- **Enum values** for `orders.status`, `payments.status`, etc. (read them from the masterly repo's `app/Enums` when writing this file).
- **Polymorphic tables**: `taggables`, `interactions`/`learner_interactions`.
- Common joins (users→learners→orders→enrollments→courses).

### 5. `public/index.html` — self-contained chat page

Single file, no external assets. Dark theme CSS vars (`--bg:#0f172a; --card:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#6366f1`). Transcript pane + textarea + Send + "New conversation" button. Keeps `messages[]` in a JS array (optionally `sessionStorage`); POSTs to `/api/chat` with `credentials: 'same-origin'` (browser replays basic auth); escapes all model output via a `esc()` text-node helper before rendering; shows a "thinking…" indicator while waiting; on `{error}` renders it inline.

## Verification

```bash
cp .env.example .env   # fill passwords + ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f sync        # wait for "sync complete — masterly_snapshot refreshed"
curl -i http://localhost:8080/                      # 401 + WWW-Authenticate
curl -u "$CHAT_USERNAME:$CHAT_PASSWORD" http://localhost:8080/   # HTML page
curl -u "$CHAT_USERNAME:$CHAT_PASSWORD" -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"How many users do I have?"}]}'
```

Negative checks:
- Ask the bot to "delete all users" → SQL permission error surfaces as a tool result; bot explains it's read-only.
- `psql -h localhost -p 2010 -U chatbot masterly_snapshot` → `SELECT` works, `INSERT`/`UPDATE`/`DELETE` fail.
- Stop the `sync` container mid-cycle → previous snapshot keeps serving.

## Accepted trade-offs

- Data is up to `SYNC_INTERVAL_SECONDS` stale by design.
- The snapshot swap kills in-flight chat queries for a few milliseconds; the error returns to the model as a tool result and it retries.
- First boot before the first sync completes: `masterly_snapshot` doesn't exist yet; SQL errors surface to the model. Wait for the first "sync complete" log line.
- Restore recreates any Postgres extensions from the dump; the internal superuser (`chatbot_admin`) can do that.
