// Masterly internal DB chatbot.
//
// Serves a basic-auth chat page and answers questions by letting the model run
// read-only SQL against the local snapshot through a single `run_sql` tool.
// The security boundary is the Postgres `chatbot` role (SELECT-only,
// default_transaction_read_only, 15s statement timeout) — there is deliberately
// no SQL parsing or allow-listing in here.
//
// Two database connections, on purpose: this one is read-only against
// `masterly_snapshot`; chat transcripts are read/written through history.js
// against a separate `chatbot_app` database that the sync job never touches.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import pg from 'pg';
import { generateSchemaDoc } from './scripts/generate-schema-doc.js';
import * as history from './history.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const SCHEMA_NOTES = path.join(ROOT, 'schema-notes.md');
const SCHEMA_GENERATED = path.join(ROOT, 'schema.generated.md');

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const MAX_BODY_BYTES = 1_000_000;
const MAX_TURNS = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_RESULT_ROWS = 200;
const MAX_RESULT_BYTES = 50_000;
const SCHEMA_DOC_MAX_AGE_MS = 15 * 60 * 1000;

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  max: 3,
  options: '-c search_path=public',
  statement_timeout: 15000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const anthropic = new Anthropic();
// The SDK resolves credentials lazily and throws a plain Error at request time
// when none are configured, which would surface as an opaque 500. Check once.
const HAS_API_CREDENTIALS = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// --- system prompt -----------------------------------------------------------

const GUIDELINES = `You are the Masterly internal database assistant. Staff ask you questions in
plain language about the Masterly LMS, and you answer them by querying the
database with the \`run_sql\` tool.

How to work:
- The database is PostgreSQL 18. It is a periodic copy of production, so it can
  be up to an hour stale — say so when someone asks about "right now", and never
  claim to see live activity.
- The connection is read-only and enforced by the database, so writes fail. If
  someone asks you to change data, explain that this is a read-only copy.
- Query before you answer. Do not guess at numbers, and do not answer from the
  schema alone when a count would settle it.
- Put a LIMIT on exploratory queries. When you need a total, aggregate in SQL
  (COUNT/SUM/GROUP BY) rather than pulling rows back and counting them yourself.
- If a query errors, read the message, fix the SQL, and try again.
- Several queries in a row are fine when a question needs them.

How to answer:
- Lead with the number or the finding, in plain language. Supporting detail after.
- Do not paste raw result dumps or the SQL you ran unless you are asked for it,
  or unless showing it is the clearest way to explain a caveat.
- Format lists of results as a short markdown table when that reads better.
- Say which locale or filter you used when the choice could change the answer
  (for example reading only the English title, or excluding hidden courses).
- If the data cannot answer the question, say so plainly instead of
  substituting a proxy metric without flagging it.`;

let promptCache = { text: null, signature: null };
let schemaDocRefresh = null;

async function fileInfo(file) {
  try {
    const info = await stat(file);
    return info.mtimeMs;
  } catch {
    return null;
  }
}

// Keep schema.generated.md roughly in step with the hourly sync without having
// to coordinate with the sync container: regenerate it whenever the copy on
// disk has gone stale. Failures are non-fatal — the previous doc keeps serving.
async function refreshSchemaDocIfStale() {
  if (schemaDocRefresh) return schemaDocRefresh;
  const mtime = await fileInfo(SCHEMA_GENERATED);
  if (mtime !== null && Date.now() - mtime < SCHEMA_DOC_MAX_AGE_MS) return null;

  schemaDocRefresh = generateSchemaDoc(pool)
    .catch((err) => console.error('[schema] regeneration failed:', err.message))
    .finally(() => {
      schemaDocRefresh = null;
    });
  return schemaDocRefresh;
}

async function buildSystemPrompt() {
  await refreshSchemaDocIfStale();

  const [notesMtime, schemaMtime] = await Promise.all([
    fileInfo(SCHEMA_NOTES),
    fileInfo(SCHEMA_GENERATED),
  ]);
  const signature = `${notesMtime}:${schemaMtime}`;
  if (promptCache.text && promptCache.signature === signature) return promptCache.text;

  const notes = await readFile(SCHEMA_NOTES, 'utf8').catch(() => null);
  const schema = await readFile(SCHEMA_GENERATED, 'utf8').catch(() => null);

  const text = [
    GUIDELINES,
    '',
    '# Curated schema notes',
    '',
    notes ?? '(schema-notes.md is missing — rely on the generated schema below.)',
    '',
    schema ??
      '# Generated schema\n\n(The schema document has not been generated yet. Introspect the database with run_sql — for example against information_schema.columns — before answering questions about structure.)',
  ].join('\n');

  promptCache = { text, signature };
  return text;
}

// --- run_sql tool ------------------------------------------------------------

function capResult(rows) {
  if (!Array.isArray(rows)) return JSON.stringify(rows);
  if (rows.length === 0) return '(0 rows)';

  const shown = rows.slice(0, MAX_RESULT_ROWS);
  let payload = JSON.stringify(shown);

  // Byte cap as well as a row cap: 200 rows of wide JSON columns can still be
  // enormous, so shrink until the payload fits.
  while (payload.length > MAX_RESULT_BYTES && shown.length > 1) {
    shown.length = Math.max(1, Math.floor(shown.length / 2));
    payload = JSON.stringify(shown);
  }
  if (shown.length < rows.length) {
    return `${payload}\n[truncated: showing ${shown.length} of ${rows.length} rows]`;
  }
  return payload;
}

const runSql = betaTool({
  name: 'run_sql',
  description:
    'Run a read-only SQL query against the masterly_snapshot PostgreSQL database (a periodic copy of the Masterly production database). Returns rows as JSON. Writes are rejected by the database.',
  inputSchema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description: 'A single SQL statement. Use LIMIT on exploratory queries.',
      },
    },
    required: ['sql'],
  },
  run: async ({ sql }) => {
    const started = Date.now();
    try {
      const { rows } = await pool.query(sql);
      console.log(`[sql] ${Date.now() - started}ms ${rows.length} rows :: ${sql.replace(/\s+/g, ' ').slice(0, 200)}`);
      return capResult(rows);
    } catch (err) {
      // Hand the error back to the model so it can correct itself.
      console.log(`[sql] error :: ${err.message}`);
      return `SQL error: ${err.message}`;
    }
  },
});

// --- http helpers ------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function equals(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // Pad to equal length so timingSafeEqual never throws; the length check is
  // folded into the result rather than short-circuiting.
  const size = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(size);
  const paddedRight = Buffer.alloc(size);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

// Returns the authenticated username (conversations are stored per user, ready
// for per-user credentials later) or null once a response has been sent.
function authorize(req, res) {
  const user = process.env.CHAT_USERNAME || '';
  const password = process.env.CHAT_PASSWORD || '';
  if (!user || !password) {
    sendJson(res, 503, { error: 'chat auth not configured' });
    return null;
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const ok =
        equals(decoded.slice(0, separator), user) && equals(decoded.slice(separator + 1), password);
      if (ok) return user;
    }
  }

  res.writeHead(401, {
    'www-authenticate': 'Basic realm="Masterly Internal Chatbot", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required.\n');
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Send a `messages` array with at least one message.';
  }
  if (messages.length > MAX_TURNS) {
    return 'This conversation has grown too long — start a new conversation.';
  }
  for (const message of messages) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
      return 'Each message needs a role of "user" or "assistant".';
    }
    if (typeof message.content !== 'string' || message.content.trim() === '') {
      return 'Each message needs non-empty string content.';
    }
  }
  if (messages[messages.length - 1].role !== 'user') {
    return 'The last message must be from the user.';
  }
  return null;
}

// --- routes ------------------------------------------------------------------

async function parseBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.tooLarge) {
      sendJson(res, 413, { error: 'That request is too large — start a new conversation.' });
      return undefined;
    }
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Request body must be JSON.' });
    return undefined;
  }
}

// Works out which transcript to send to the model. The conversation lives in
// Postgres and the browser only sends the new question; if history storage is
// unreachable we fall back to the transcript the browser kept, so the chatbot
// does not go down with it.
async function resolveConversation(owner, body, res) {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length > MAX_MESSAGE_CHARS) {
    sendJson(res, 400, { error: 'That message is too long — split it into smaller questions.' });
    return null;
  }
  if (!message && !body.retry && !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: 'Send a `message` to ask, or `retry: true` to try again.' });
    return null;
  }

  try {
    if (body.conversationId !== undefined && body.conversationId !== null) {
      const conversation = await history.getConversation(owner, body.conversationId);
      if (!conversation) {
        sendJson(res, 404, { error: 'That conversation no longer exists.' });
        return null;
      }
      if (message) {
        if (conversation.messages.length >= MAX_TURNS) {
          sendJson(res, 400, { error: 'This conversation has grown too long — start a new one.' });
          return null;
        }
        await history.appendMessage(owner, conversation.id, 'user', message);
        conversation.messages.push({ role: 'user', content: message });
      }
      if (!conversation.messages.length) {
        sendJson(res, 400, { error: 'Send a message first.' });
        return null;
      }
      if (conversation.messages[conversation.messages.length - 1].role !== 'user') {
        sendJson(res, 400, { error: 'There is nothing to answer in that conversation.' });
        return null;
      }
      return { id: conversation.id, title: conversation.title, messages: conversation.messages };
    }

    if (!message) {
      sendJson(res, 400, { error: 'Send a message first.' });
      return null;
    }
    const created = await history.createConversation(owner, message);
    await history.appendMessage(owner, created.id, 'user', message);
    return { id: created.id, title: created.title, messages: [{ role: 'user', content: message }] };
  } catch (err) {
    if (!(err instanceof history.HistoryUnavailableError)) throw err;

    // Degraded mode: answer from the transcript the browser is holding.
    const messages = Array.isArray(body.messages)
      ? body.messages.map(({ role, content }) => ({ role, content }))
      : message
        ? [{ role: 'user', content: message }]
        : [];
    const problem = validateMessages(messages);
    if (problem) {
      sendJson(res, 503, { error: 'Chat history storage is unavailable — reload the page.' });
      return null;
    }
    console.warn('[chat] answering without history storage:', err.cause?.message ?? err.message);
    return { id: null, title: null, messages, historyUnavailable: true };
  }
}

async function handleChat(req, res, owner) {
  if (!HAS_API_CREDENTIALS) {
    sendJson(res, 503, { error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    return;
  }

  const body = await parseBody(req, res);
  if (body === undefined) return;

  const conversation = await resolveConversation(owner, body, res);
  if (!conversation) return;

  const messages = conversation.messages.map(({ role, content }) => ({ role, content }));

  try {
    const final = await anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: await buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: [runSql],
      messages,
      max_iterations: 10,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    // Check why generation stopped before touching content.
    if (final.stop_reason === 'refusal') {
      sendJson(res, 200, {
        error: 'The model declined this request.',
        conversationId: conversation.id,
      });
      return;
    }

    let reply = final.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (final.stop_reason === 'max_tokens') {
      reply += '\n\n_(Response was cut off at the length limit — ask for a narrower slice.)_';
    }
    if (!reply) {
      reply =
        'I stopped without producing an answer. Try rephrasing the question, or ask for a smaller slice of the data.';
    }

    if (conversation.id) {
      // Log a storage failure, but still return the answer — losing it here
      // would waste a model call the user already waited for.
      await history
        .appendMessage(owner, conversation.id, 'assistant', reply)
        .catch((err) => console.error('[history] could not store reply:', err.message));
    }

    sendJson(res, 200, {
      reply,
      stop_reason: final.stop_reason,
      conversationId: conversation.id,
      title: conversation.title,
      historyUnavailable: conversation.historyUnavailable === true,
    });
  } catch (err) {
    // The question is already stored, so hand the id back: the browser's Retry
    // button re-runs the model against the saved conversation.
    const fail = (status, error) => sendJson(res, status, { error, conversationId: conversation.id });

    // Most specific first: APIConnectionError extends APIError in this SDK.
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('[chat] anthropic auth failed:', err.message);
      fail(502, 'The Anthropic API key is invalid or missing.');
    } else if (err instanceof Anthropic.RateLimitError) {
      fail(429, 'Rate limited by the Anthropic API — try again in a moment.');
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.error('[chat] anthropic connection error:', err.message);
      fail(502, 'Could not reach the Anthropic API.');
    } else if (err instanceof Anthropic.APIError) {
      console.error('[chat] anthropic api error:', err.status, err.message);
      fail(502, `The Anthropic API returned an error (${err.status ?? 'unknown'}).`);
    } else {
      console.error('[chat] unexpected error:', err);
      fail(500, 'Something went wrong handling that message.');
    }
  }
}

// --- conversation routes -----------------------------------------------------

async function handleConversations(req, res, owner, url) {
  const [, , , id] = url.pathname.split('/'); // /api/conversations/:id
  const method = req.method;

  if (method === 'GET' && !id) {
    sendJson(res, 200, {
      conversations: await history.listConversations(owner, url.searchParams.get('q')),
    });
    return;
  }

  if (method === 'GET' && id) {
    const conversation = await history.getConversation(owner, id);
    if (!conversation) {
      sendJson(res, 404, { error: 'That conversation no longer exists.' });
      return;
    }
    sendJson(res, 200, { conversation });
    return;
  }

  if (method === 'PATCH' && id) {
    const body = await parseBody(req, res);
    if (body === undefined) return;
    if (typeof body.title !== 'string' || !body.title.trim()) {
      sendJson(res, 400, { error: 'Send a non-empty `title`.' });
      return;
    }
    const updated = await history.renameConversation(owner, id, body.title);
    if (!updated) {
      sendJson(res, 404, { error: 'That conversation no longer exists.' });
      return;
    }
    sendJson(res, 200, { conversation: updated });
    return;
  }

  if (method === 'DELETE' && id) {
    const removed = await history.deleteConversation(owner, id);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'That conversation no longer exists.' });
    return;
  }

  if (method === 'DELETE' && !id) {
    sendJson(res, 200, { deleted: await history.deleteAllConversations(owner) });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
}

async function handleIndex(res) {
  try {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Chat page is missing (public/index.html).\n');
  }
}

const server = createServer(async (req, res) => {
  try {
    const owner = authorize(req, res);
    if (!owner) return;

    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      await handleIndex(res);
    } else if (req.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(req, res, owner);
    } else if (url.pathname === '/api/conversations' || url.pathname.startsWith('/api/conversations/')) {
      await handleConversations(req, res, owner, url);
    } else {
      sendJson(res, 404, { error: 'Not found.' });
    }
  } catch (err) {
    if (err instanceof history.HistoryUnavailableError) {
      // Expected while the sync job has not created the history database yet.
      if (!res.headersSent) {
        sendJson(res, 503, {
          error: 'Chat history storage is unavailable — the database may still be starting.',
          historyUnavailable: true,
        });
      }
      return;
    }
    console.error('[http] unhandled error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
    else res.end();
  }
});

// Generate the schema doc at boot so the first question already has it, but
// never block startup on the database being ready.
generateSchemaDoc(pool)
  .then((file) => console.log(`[schema] wrote ${file}`))
  .catch((err) => console.error('[schema] initial generation failed:', err.message));

if (!HAS_API_CREDENTIALS) {
  console.warn('[chat] ANTHROPIC_API_KEY is not set — /api/chat will return 503 until it is.');
}
if (!history.historyConfigured) {
  console.warn('[history] APP_DB_PASSWORD is not set — chats will not be saved.');
}

server.listen(PORT, () => console.log(`[http] listening on :${PORT} (model ${MODEL})`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() =>
      Promise.allSettled([pool.end(), history.close()]).finally(() => process.exit(0)),
    );
  });
}
