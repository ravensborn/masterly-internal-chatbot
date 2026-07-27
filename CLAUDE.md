# Masterly Internal Chatbot

Standalone Docker stack that lets internal staff chat with a **copy** of the Masterly LMS database in natural language. It never touches the live database beyond a periodic read: a sync job copies the source Postgres into this stack's own Postgres instance, and a small Node.js app serves a basic-auth chat page whose AI answers questions by running read-only SQL against the copy (Anthropic API).

**Read `PLAN.md` first** — it is the authoritative implementation plan and describes exactly what is built and what remains.

## Architecture

| Service | Image | Role |
|---|---|---|
| `db` | `postgres:18` | Internal Postgres; holds `masterly_snapshot` (host port 2010) |
| `sync` | `postgres:18` | `sync/sync.sh` loop: pg_dump source → restore to staging DB → atomic swap → grant read-only `chatbot` role |
| `app` | `Dockerfile` (node:22) | Chat server on port 8080; idles until `package.json` exists |

The source database is reached via `SOURCE_DB_*` env only (locally: masterly's published host port 2001 through `host.docker.internal`). No dependency on the masterly repo or its compose network.

## Running

```bash
cp .env.example .env   # fill in passwords + ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f sync   # first sync must complete before the chatbot has data
```

## Conventions

- Plain JavaScript (ESM, `"type": "module"`), plain `node:http` — no framework, no TypeScript, no build step.
- Runtime dependencies are **only** `@anthropic-ai/sdk` and `pg`. Do not add dependencies without approval.
- Anthropic calls go through the official SDK (tool runner with a single `run_sql` tool). Default model `claude-opus-5` via `ANTHROPIC_MODEL`.
- Security boundary is the Postgres `chatbot` role (SELECT-only, `default_transaction_read_only = on`, 15s statement timeout) — never "fix" access problems by connecting the app as the superuser.
- All configuration comes from environment variables declared in `docker-compose.yml` / `.env.example`. Keep the two files in sync when adding variables.

## Repo hygiene (public repo!)

- Never commit `.env`, dumps, or `schema.generated.md` (all gitignored) — no credentials, no real data, no schema dumps.
- Keep example values in `.env.example` empty for every secret.

## Domain notes

The source is a Laravel LMS ("Masterly"): users (learner/instructor/admin profiles), courses/bundles/lessons/videos, orders + payments (Iraqi gateways FIB/FastPay) → enrollments, quizzes, ratings, support chat. Many text columns are spatie/laravel-translatable JSON maps (`{"en": ..., "ar": ..., "ckb": ...}`) — SQL against them needs `->>'en'` or `ILIKE`, and the chatbot's schema notes must say so.
