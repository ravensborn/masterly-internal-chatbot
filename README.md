# Masterly Internal Chatbot

Chat with a copy of the Masterly database in natural language. A sync job periodically copies the source Postgres into this stack's own Postgres instance; a basic-auth chat page answers questions ("how many users do I have?") by running read-only SQL against that copy via the Anthropic API.

## Quickstart

```bash
cp .env.example .env   # fill in passwords + ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f sync   # wait for the first "sync complete"
# open http://localhost:8090 and sign in with CHAT_USERNAME / CHAT_PASSWORD
```

### Chat history

Conversations are saved in a `chatbot_app` database on the same internal
Postgres — separate from the snapshot, which is dropped and recreated on every
sync. Set `HISTORY_DB_PASSWORD` in `.env`; the sync job creates the database and
its read/write role, and the app creates the tables. Leave it empty and the
chatbot still works, it just doesn't remember anything.

### Database credentials

The internal Postgres is one server with three roles, and the `.env` variables
are prefixed by role rather than by consumer:

| Prefix | Role | Privileges | Used by |
| --- | --- | --- | --- |
| `ADMIN_DB_*` | `chatbot_admin` | superuser | `sync` only |
| `SNAPSHOT_DB_*` | `chatbot` | `SELECT` on `masterly_snapshot`, read-only transactions, 15s timeout | `app` — the model's `run_sql` tool |
| `HISTORY_DB_*` | `chatbot_app` | owner of the chat-history database only | `app` — saved conversations |

Give each its own password. The privilege split is the security boundary around
model-generated SQL, so collapsing them defeats the point.

### Sign in

One account, `CHAT_USERNAME` / `CHAT_PASSWORD` from `.env`, entered on a login
page at `/login`. A successful sign-in sets a signed, HttpOnly session cookie
that lasts 12 hours; there is no session store, so restarts keep you signed in
and changing `CHAT_PASSWORD` signs you out. Set `SESSION_SECRET` if you want
sessions to survive a password change.

### Health check

The chat page shows a status strip for both app connections, and
`GET /api/health` returns the same thing as JSON (200 when both are reachable,
503 otherwise).
