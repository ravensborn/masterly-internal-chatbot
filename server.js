// Masterly internal DB chatbot.
//
// Serves a basic-auth chat page and answers questions by letting the model run
// read-only SQL against the local snapshot through a single `run_sql` tool.
// The security boundary is the Postgres role this connects as — SNAPSHOT_DB_*,
// SELECT-only, default_transaction_read_only, 15s statement timeout — so there
// is deliberately no SQL parsing or allow-listing in here.
//
// Two database connections, on purpose: this one (SNAPSHOT_DB_*) is read-only
// against `masterly_snapshot`; chat transcripts are read/written through
// history.js as HISTORY_DB_*, against a database the sync job never touches.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import pg from 'pg';
import { generateSchemaDoc } from './scripts/generate-schema-doc.js';
import * as history from './history.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const LOGIN_HTML = path.join(ROOT, 'public', 'login.html');
const SCHEMA_NOTES = path.join(ROOT, 'schema-notes.md');
const SCHEMA_GENERATED = path.join(ROOT, 'schema.generated.md');

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// Server-side refusal fallbacks exist only on the models with elevated safety
// classifiers. Sending the parameter to any other model is a 400 on every
// request, so the option has to follow the configured model.
const SUPPORTS_FALLBACKS = new Set(['claude-opus-5', 'claude-fable-5', 'claude-mythos-5']).has(
  MODEL,
);
const MAX_BODY_BYTES = 1_000_000;
const MAX_TURNS = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_RESULT_ROWS = 200;
const MAX_RESULT_BYTES = 50_000;
const SCHEMA_DOC_MAX_AGE_MS = 15 * 60 * 1000;

const pool = new pg.Pool({
  host: process.env.SNAPSHOT_DB_HOST,
  port: Number(process.env.SNAPSHOT_DB_PORT || 5432),
  database: process.env.SNAPSHOT_DB_DATABASE,
  user: process.env.SNAPSHOT_DB_USERNAME,
  password: process.env.SNAPSHOT_DB_PASSWORD,
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

const GUIDELINES = `You are the Masterly internal data assistant. Staff ask you questions in plain
language about the Masterly business — learners, courses, sales, support — and
you answer them by querying the database with the \`run_sql\` tool.

Assume the person asking is NOT technical. They work in marketing, support,
finance or management. They know the business; they do not know the database,
and they should never have to.

How to work:
- The database is PostgreSQL 18. It is a periodic copy of production, so it can
  be up to an hour stale. When someone asks about "right now", tell them the
  figures can be up to an hour behind, and never claim to see live activity.
- The connection is read-only and enforced by the database, so writes fail. If
  someone asks you to change something, explain that you can look information up
  but cannot edit it, and that the change has to be made in Masterly itself.
- Query before you answer. Do not guess at numbers, and do not answer from the
  schema alone when a count would settle it.
- Put a LIMIT on exploratory queries. When you need a total, aggregate in SQL
  (COUNT/SUM/GROUP BY) rather than pulling rows back and counting them yourself.
- If a query errors, read the message, fix the SQL, and try again.
- Several queries in a row are fine when a question needs them.

How to answer:
- Lead with the number or the finding in one sentence. Supporting detail after.
  Keep it short — a headline plus a few lines, not an essay.
- Write in business language, never database language. Say "learners",
  "enrolments", "paid orders", "support conversations". Do not mention tables,
  columns, joins, rows, NULLs, locales, or the query you ran.
- Never show SQL unless the person explicitly asks to see it. If they do, show
  it and explain in one line what it does.
- Format numbers for reading: thousands separators (12,480 learners) and money
  as Iraqi dinar (1,250,000 IQD). Write dates as "12 March 2026" rather than
  timestamps, and round percentages to one decimal.
- Prefer names over internal IDs. Include an ID only when someone would need it
  to look the record up themselves.
- When a question could be read more than one way, pick the most reasonable
  reading, answer it, and state the definition you used in one plain sentence —
  for example "counting anyone who has bought at least one course, including
  free ones". Do not ask a clarifying question when a sensible default exists.
- Use a short markdown table for lists of results, limited to the columns that
  answer the question.
- If a query fails, fix it and retry without commentary. Never show database
  error text. If you genuinely cannot get there, say what you were unable to
  work out in plain language.
- If the data cannot answer the question, say so plainly and suggest the closest
  question it can answer. Never substitute a proxy metric without flagging it.`;

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

// --- health ------------------------------------------------------------------

// Confirms the snapshot connection works AND that it is still the locked-down
// one: a `chatbot` role that lost default_transaction_read_only would answer
// queries fine while silently giving the model write access, so the page shows
// that as a failure rather than a healthy tick.
async function checkSnapshot() {
  try {
    const { rows } = await pool.query(
      `SELECT current_database() AS "database",
              current_user      AS "role",
              current_setting('transaction_read_only') AS read_only,
              (SELECT count(*)::int FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables`,
    );
    const row = rows[0];
    const readOnly = row.read_only === 'on';
    return {
      ok: readOnly && row.tables > 0,
      database: row.database,
      role: row.role,
      readOnly,
      tables: row.tables,
      detail: !readOnly
        ? 'Connected, but the session is NOT read-only — check the role grants.'
        : row.tables === 0
          ? 'Connected, but the snapshot is empty — the first sync has not finished.'
          : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      database: process.env.SNAPSHOT_DB_DATABASE,
      role: process.env.SNAPSHOT_DB_USERNAME,
      detail:
        err.code === '3D000'
          ? 'Database does not exist yet — waiting for the first sync to finish.'
          : err.message,
    };
  }
}

async function handleHealth(res) {
  const [snapshot, chatHistory] = await Promise.all([checkSnapshot(), history.checkHealth()]);
  // A missing history password is a deliberate configuration, not an outage —
  // unconfigured history does not make the stack unhealthy.
  const ok = snapshot.ok && (chatHistory.ok || !chatHistory.configured);
  sendJson(res, ok ? 200 : 503, {
    ok,
    checkedAt: new Date().toISOString(),
    checks: [
      {
        key: 'snapshot',
        label: 'Snapshot database',
        note: 'read-only copy the answers are queried from',
        ...snapshot,
      },
      {
        key: 'history',
        label: 'Chat history database',
        note: 'saved conversations',
        ...chatHistory,
      },
      {
        key: 'anthropic',
        label: 'Anthropic API',
        note: `model ${MODEL}`,
        ok: HAS_API_CREDENTIALS,
        detail: HAS_API_CREDENTIALS ? undefined : 'ANTHROPIC_API_KEY is not set.',
      },
    ],
  });
}

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

// --- session auth ------------------------------------------------------------
//
// One account, taken from CHAT_USERNAME / CHAT_PASSWORD, exchanged at /login for
// a signed cookie. Nothing is stored server-side: with a single user there is no
// session table to look up, so the cookie carries its own expiry and an HMAC
// over it. Restarting the app keeps people logged in; changing CHAT_PASSWORD
// signs everyone out, which is what you want from a password change.

const SESSION_COOKIE = 'masterly_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_PATH = '/login';

const CHAT_USERNAME = process.env.CHAT_USERNAME || '';
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || '';
const AUTH_CONFIGURED = Boolean(CHAT_USERNAME && CHAT_PASSWORD);

// A random fallback would invalidate every cookie on restart, so derive the key
// from the password unless SESSION_SECRET pins it explicitly.
const SESSION_KEY =
  process.env.SESSION_SECRET ||
  (AUTH_CONFIGURED ? `masterly-chat.v1.${CHAT_PASSWORD}` : randomBytes(32).toString('hex'));

function sign(value) {
  return createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
}

function cookiesOf(req) {
  const jar = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

// True when the request reached us over TLS, directly or via a proxy — the
// Secure flag has to stay off for plain-http internal use or the cookie is
// silently dropped.
function isSecure(req) {
  return (
    Boolean(req.socket.encrypted) ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  );
}

function setSessionCookie(res, req, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

function startSession(req, res) {
  const expires = String(Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, req, `${expires}.${sign(expires)}`, Math.floor(SESSION_TTL_MS / 1000));
}

function endSession(req, res) {
  setSessionCookie(res, req, '', 0);
}

// Returns the authenticated username (conversations are stored per user, ready
// for per-user credentials later) or null when the cookie is missing, forged or
// expired. The signature covers only the expiry because there is exactly one
// account — add the username to the signed payload before adding a second.
function sessionUser(req) {
  const token = cookiesOf(req)[SESSION_COOKIE];
  if (!token || !AUTH_CONFIGURED) return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const expires = token.slice(0, dot);
  if (!equals(token.slice(dot + 1), sign(expires))) return null;
  if (!(Number(expires) > Date.now())) return null;
  return CHAT_USERNAME;
}

// Small brute-force brake. One user and an internal audience, so an in-memory
// counter per address is enough — it resets on restart, which is acceptable.
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map();

function attemptKey(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function lockedOut(key) {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.at > LOCKOUT_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.at > LOCKOUT_MS) attempts.set(key, { count: 1, at: Date.now() });
  else attempts.set(key, { count: record.count + 1, at: Date.now() });
}

async function handleLoginRequest(req, res) {
  if (!AUTH_CONFIGURED) {
    sendJson(res, 503, { error: 'Login is not configured — set CHAT_USERNAME and CHAT_PASSWORD.' });
    return;
  }

  const key = attemptKey(req);
  if (lockedOut(key)) {
    sendJson(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
    return;
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid request.' });
    return;
  }

  const ok =
    equals(String(body.username ?? ''), CHAT_USERNAME) &&
    equals(String(body.password ?? ''), CHAT_PASSWORD);

  if (!ok) {
    noteFailure(key);
    // Same message either way: which half was wrong is not the client's business.
    sendJson(res, 401, { error: 'Incorrect username or password.' });
    return;
  }

  attempts.delete(key);
  startSession(req, res);
  sendJson(res, 200, { ok: true, username: CHAT_USERNAME });
}

function requireSession(req, res, url) {
  const owner = sessionUser(req);
  if (owner) return owner;

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Your session has expired — sign in again.', unauthenticated: true });
  } else {
    res.writeHead(302, { location: LOGIN_PATH, 'cache-control': 'no-store' });
    res.end();
  }
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
      ...(SUPPORTS_FALLBACKS
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
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

async function sendPage(res, file, missingMessage) {
  try {
    const html = await readFile(file);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${missingMessage}\n`);
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // The only routes reachable without a session.
    if (req.method === 'GET' && url.pathname === LOGIN_PATH) {
      if (sessionUser(req)) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      await sendPage(res, LOGIN_HTML, 'Login page is missing (public/login.html).');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      await handleLoginRequest(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      endSession(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    const owner = requireSession(req, res, url);
    if (!owner) return;

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      await sendPage(res, INDEX_HTML, 'Chat page is missing (public/index.html).');
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      await handleHealth(res);
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
  console.warn('[history] HISTORY_DB_PASSWORD is not set — chats will not be saved.');
}
if (!AUTH_CONFIGURED) {
  console.warn('[auth] CHAT_USERNAME / CHAT_PASSWORD are not set — nobody can sign in.');
}

server.listen(PORT, () => console.log(`[http] listening on :${PORT} (model ${MODEL})`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() =>
      Promise.allSettled([pool.end(), history.close()]).finally(() => process.exit(0)),
    );
  });
}
