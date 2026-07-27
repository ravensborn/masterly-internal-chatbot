// Chat history storage.
//
// Transcripts live in their own database (`chatbot_app`) — never in
// `masterly_snapshot`, which the sync job drops and recreates every cycle. The
// database and role come from sync/sync.sh; the tables are created here, lazily,
// because the app owns that database. Calls made before it exists throw
// HistoryUnavailableError so the caller can degrade instead of failing.
import pg from 'pg';

const MAX_TITLE_CHARS = 80;
const LIST_LIMIT = 200;
const RETRY_AFTER_MS = 5000;

export class HistoryUnavailableError extends Error {
  constructor(cause) {
    super('Chat history storage is unavailable.');
    this.name = 'HistoryUnavailableError';
    this.cause = cause;
  }
}

export const historyConfigured = Boolean(process.env.APP_DB_PASSWORD);

const pool = historyConfigured
  ? new pg.Pool({
      host: process.env.APP_DB_HOST || process.env.DB_HOST,
      port: Number(process.env.APP_DB_PORT || process.env.DB_PORT || 5432),
      database: process.env.APP_DB_DATABASE || 'chatbot_app',
      user: process.env.APP_DB_USERNAME || 'chatbot_app',
      password: process.env.APP_DB_PASSWORD,
      max: 5,
      options: '-c search_path=public',
      statement_timeout: 10000,
      connectionTimeoutMillis: 5000,
    })
  : null;

if (pool) pool.on('error', (err) => console.error('[history] idle client error:', err.message));

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner       text NOT NULL,
  title       text NOT NULL DEFAULT 'New chat',
  renamed     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_conversations_owner_idx
  ON chat_conversations (owner, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
  ON chat_messages (conversation_id, id);
`;

let schemaReady = null;
let lastFailureAt = 0;

// Resolves once the tables exist. A failure is remembered only briefly so the
// next request retries — the app usually boots before sync creates the database.
function ensureSchema() {
  if (!pool) return Promise.reject(new HistoryUnavailableError(new Error('APP_DB_PASSWORD is not set')));
  if (schemaReady) return schemaReady;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) {
    return Promise.reject(new HistoryUnavailableError(new Error('waiting before retrying')));
  }

  schemaReady = pool
    .query(SCHEMA_SQL)
    .then(() => console.log('[history] schema ready'))
    .catch((err) => {
      schemaReady = null;
      lastFailureAt = Date.now();
      console.error('[history] not ready:', err.message);
      throw new HistoryUnavailableError(err);
    });
  return schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Database gone or connection dropped: re-check the schema next time.
    if (err.code === '3D000' || err.code === '57P01' || err.code === 'ECONNREFUSED') {
      schemaReady = null;
      lastFailureAt = Date.now();
      throw new HistoryUnavailableError(err);
    }
    throw err;
  }
}

export function titleFrom(text) {
  const line = String(text).trim().replace(/\s+/g, ' ');
  if (!line) return 'New chat';
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS)}…` : line;
}

// node-postgres hands back timestamptz as a Date object.
function ms(value) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function shape(row) {
  const shaped = {
    id: row.id,
    title: row.title,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
  // Left out rather than guessed when the query did not count messages.
  if (row.question_count !== undefined) shaped.questionCount = Number(row.question_count);
  return shaped;
}

export async function listConversations(owner, search) {
  const needle = (search || '').trim();
  const { rows } = await query(
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT count(*) FROM chat_messages m
              WHERE m.conversation_id = c.id AND m.role = 'user') AS question_count
       FROM chat_conversations c
      WHERE c.owner = $1
        AND ($2::text IS NULL
             OR c.title ILIKE '%' || $2 || '%'
             OR EXISTS (SELECT 1 FROM chat_messages m
                         WHERE m.conversation_id = c.id AND m.content ILIKE '%' || $2 || '%'))
      ORDER BY c.updated_at DESC
      LIMIT ${LIST_LIMIT}`,
    [owner, needle || null],
  );
  return rows.map(shape);
}

// Returns null when the conversation does not exist or belongs to someone else —
// the caller turns that into a 404 either way, so ownership is never probeable.
export async function getConversation(owner, id) {
  if (!isUuid(id)) return null;
  const { rows } = await query(
    `SELECT id, title, renamed, created_at, updated_at
       FROM chat_conversations WHERE id = $1 AND owner = $2`,
    [id, owner],
  );
  if (!rows.length) return null;

  const messages = await query(
    `SELECT role, content, created_at FROM chat_messages
      WHERE conversation_id = $1 ORDER BY id`,
    [id],
  );
  return {
    ...shape(rows[0]),
    questionCount: messages.rows.filter((m) => m.role === 'user').length,
    renamed: rows[0].renamed,
    messages: messages.rows.map((m) => ({
      role: m.role,
      content: m.content,
      at: ms(m.created_at),
    })),
  };
}

export async function createConversation(owner, title) {
  const { rows } = await query(
    `INSERT INTO chat_conversations (owner, title) VALUES ($1, $2)
     RETURNING id, title, created_at, updated_at`,
    [owner, titleFrom(title)],
  );
  return { ...shape(rows[0]), renamed: false, messages: [] };
}

// Appends a message and bumps updated_at in one round trip. The INSERT selects
// through chat_conversations, so a mismatched owner writes nothing and this
// returns false.
export async function appendMessage(owner, conversationId, role, content) {
  if (!isUuid(conversationId)) return false;
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO chat_messages (conversation_id, role, content)
       SELECT $1, $3, $4 FROM chat_conversations WHERE id = $1 AND owner = $2
       RETURNING conversation_id
     )
     UPDATE chat_conversations c SET updated_at = now()
       FROM inserted
      WHERE c.id = inserted.conversation_id
      RETURNING c.id`,
    [conversationId, owner, role, content],
  );
  return rows.length > 0;
}

export async function renameConversation(owner, id, title) {
  if (!isUuid(id)) return null;
  const clean = String(title).trim().slice(0, MAX_TITLE_CHARS);
  if (!clean) return null;
  const { rows } = await query(
    // updated_at is deliberately left alone: renaming should not reorder the list.
    `UPDATE chat_conversations SET title = $3, renamed = true
      WHERE id = $1 AND owner = $2
      RETURNING id, title, created_at, updated_at`,
    [id, owner, clean],
  );
  return rows.length ? shape(rows[0]) : null;
}

export async function deleteConversation(owner, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM chat_conversations WHERE id = $1 AND owner = $2', [
    id,
    owner,
  ]);
  return rowCount > 0;
}

export async function deleteAllConversations(owner) {
  const { rowCount } = await query('DELETE FROM chat_conversations WHERE owner = $1', [owner]);
  return rowCount;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export async function close() {
  if (pool) await pool.end();
}
