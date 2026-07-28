// Introspects the snapshot database and writes schema.generated.md — the
// machine-generated half of the chatbot's system prompt (the hand-written half
// is schema-notes.md). Run standalone with `npm run schema-doc`; the server
// also calls generateSchemaDoc() at boot and refreshes it periodically.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.generated.md');

const COLUMNS_SQL = `
  SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
         c.character_maximum_length, c.numeric_precision, c.numeric_scale,
         c.is_nullable, c.column_default, c.ordinal_position
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   ORDER BY c.table_name, c.ordinal_position`;

// Primary key and foreign key columns, read from the catalog rather than
// information_schema.key_column_usage (which is markedly slower).
const KEYS_SQL = `
  SELECT con.contype,
         src.relname       AS table_name,
         src_col.attname   AS column_name,
         tgt.relname       AS target_table,
         tgt_col.attname   AS target_column
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = src.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute src_col
      ON src_col.attrelid = src.oid AND src_col.attnum = k.attnum
    LEFT JOIN pg_class tgt ON tgt.oid = con.confrelid
    LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord)
      ON fk.ord = k.ord
    LEFT JOIN pg_attribute tgt_col
      ON tgt_col.attrelid = tgt.oid AND tgt_col.attnum = fk.attnum
   WHERE ns.nspname = 'public' AND con.contype IN ('p', 'f')
   ORDER BY src.relname, k.ord`;

// Planner estimate — instant even on large tables. Exact counts would need a
// seq scan per table and can trip the chatbot role's 15s statement timeout.
const ROW_COUNTS_SQL = `
  SELECT c.relname AS table_name, GREATEST(c.reltuples, 0)::bigint AS estimate
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r'`;

function formatType(col) {
  const { data_type: type, udt_name: udt } = col;
  if (type === 'character varying') {
    return col.character_maximum_length ? `varchar(${col.character_maximum_length})` : 'varchar';
  }
  if (type === 'character') return `char(${col.character_maximum_length})`;
  if (type === 'numeric' && col.numeric_precision !== null) {
    return `numeric(${col.numeric_precision},${col.numeric_scale})`;
  }
  if (type === 'timestamp without time zone') return 'timestamp';
  if (type === 'timestamp with time zone') return 'timestamptz';
  if (type === 'double precision') return 'float8';
  if (type === 'USER-DEFINED' || type === 'ARRAY') return udt;
  return type;
}

// Serial/identity defaults say nothing useful to the model; everything else
// (enum-ish defaults, false, 0, now()) is worth keeping.
function formatDefault(value) {
  if (!value) return '';
  if (/^nextval\(/i.test(value)) return '';
  return value.replace(/::[a-z_ ]+(\[\])?$/i, '').trim();
}

function formatCount(estimate) {
  const n = Number(estimate);
  if (n <= 0) return '0 (or unanalyzed)';
  return `~${n.toLocaleString('en-US')}`;
}

export async function buildSchemaDoc(pool) {
  const [columns, keys, counts] = await Promise.all([
    pool.query(COLUMNS_SQL),
    pool.query(KEYS_SQL),
    pool.query(ROW_COUNTS_SQL),
  ]);

  const byTable = new Map();
  for (const row of columns.rows) {
    if (!byTable.has(row.table_name)) {
      byTable.set(row.table_name, { columns: [], primaryKey: [], foreignKeys: [] });
    }
    byTable.get(row.table_name).columns.push(row);
  }
  for (const row of keys.rows) {
    const table = byTable.get(row.table_name);
    if (!table) continue;
    if (row.contype === 'p') table.primaryKey.push(row.column_name);
    else table.foreignKeys.push(`${row.column_name} → ${row.target_table}.${row.target_column}`);
  }
  const rowCounts = new Map(counts.rows.map((r) => [r.table_name, r.estimate]));

  const lines = [
    '# Generated schema — `masterly_snapshot`',
    '',
    `Introspected ${new Date().toISOString()}. Row counts are planner estimates.`,
    '',
  ];

  for (const name of [...byTable.keys()].sort()) {
    const table = byTable.get(name);
    lines.push(`## ${name} (${formatCount(rowCounts.get(name) ?? 0)} rows)`, '');
    lines.push('| column | type | null | default |', '| --- | --- | --- | --- |');
    for (const col of table.columns) {
      lines.push(
        `| ${col.column_name} | ${formatType(col)} | ${col.is_nullable === 'YES' ? 'yes' : 'no'} | ${formatDefault(col.column_default)} |`,
      );
    }
    lines.push('');
    if (table.primaryKey.length) lines.push(`PK: ${table.primaryKey.join(', ')}`, '');
    if (table.foreignKeys.length) {
      lines.push('FK:', ...table.foreignKeys.map((fk) => `- ${fk}`), '');
    }
  }

  return lines.join('\n');
}

export async function generateSchemaDoc(pool) {
  const markdown = await buildSchemaDoc(pool);
  await writeFile(OUTPUT_PATH, markdown, 'utf8');
  return OUTPUT_PATH;
}

// Standalone entrypoint: `node scripts/generate-schema-doc.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({
    host: process.env.SNAPSHOT_DB_HOST,
    port: Number(process.env.SNAPSHOT_DB_PORT || 5432),
    database: process.env.SNAPSHOT_DB_DATABASE,
    user: process.env.SNAPSHOT_DB_USERNAME,
    password: process.env.SNAPSHOT_DB_PASSWORD,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    console.log(`wrote ${await generateSchemaDoc(pool)}`);
  } finally {
    await pool.end();
  }
}
