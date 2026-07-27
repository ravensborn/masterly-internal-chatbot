# Masterly Internal Chatbot

Chat with a copy of the Masterly database in natural language. A sync job periodically copies the source Postgres into this stack's own Postgres instance; a basic-auth chat page answers questions ("how many users do I have?") by running read-only SQL against that copy via the Anthropic API.

## Quickstart

```bash
cp .env.example .env   # fill in passwords + ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f sync   # wait for the first "sync complete"
# open http://localhost:8090 (basic auth: CHAT_USERNAME / CHAT_PASSWORD)
```

### No live source database?

Set `SOURCE_DUMP_FILE` in `.env` to a `pg_dump` backup on disk (custom-format
archive or plain SQL — the extension doesn't matter) and the sync job restores
that instead of dumping `SOURCE_DB_*`:

```bash
SOURCE_DUMP_FILE=./masterly-backup.sql
```

It is re-restored only when the file's mtime changes. Never commit the dump —
`*.sql` and `*.dump` are gitignored.

### Chat history

Conversations are saved in a `chatbot_app` database on the same internal
Postgres — separate from the snapshot, which is dropped and recreated on every
sync. Set `APP_DB_PASSWORD` in `.env`; the sync job creates the database and its
read/write role, and the app creates the tables. Leave it empty and the chatbot
still works, it just doesn't remember anything.
