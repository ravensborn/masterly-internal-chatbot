# Masterly Internal Chatbot

Chat with a copy of the Masterly database in natural language. A sync job periodically copies the source Postgres into this stack's own Postgres instance; a basic-auth chat page answers questions ("how many users do I have?") by running read-only SQL against that copy via the Anthropic API.

## Quickstart

```bash
cp .env.example .env   # fill in passwords + ANTHROPIC_API_KEY
docker compose up -d --build
docker compose logs -f sync   # wait for the first "sync complete"
# open http://localhost:8080 (basic auth: CHAT_USERNAME / CHAT_PASSWORD)
```

See `PLAN.md` for the full architecture and implementation plan.
