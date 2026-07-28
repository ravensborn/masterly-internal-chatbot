#!/usr/bin/env bash
# Periodically copies the source masterly database into this stack's internal
# Postgres. Runs inside a postgres:18 container so pg_dump/pg_restore match the
# PG18 servers on both sides (no client/server version mismatch).
#
# Flow per cycle:
#   1. pg_dump -Fc from the source DB (data of infra tables excluded)
#   2. restore into a staging database (masterly_snapshot_next)
#   3. atomic-ish swap: drop masterly_snapshot, rename staging into its place
#   4. re-create/grant the read-only snapshot role (grants die with the drop)
#
# A failure at any step leaves the previous snapshot intact; the cycle simply
# retries after SYNC_INTERVAL_SECONDS.

set -u

: "${SOURCE_DB_HOST:?}" "${SOURCE_DB_PORT:?}" "${SOURCE_DB_DATABASE:?}"
: "${SOURCE_DB_USERNAME:?}" "${SOURCE_DB_PASSWORD:?}"
: "${ADMIN_DB_HOST:?}" "${ADMIN_DB_PORT:?}"
: "${ADMIN_DB_USERNAME:?}" "${ADMIN_DB_PASSWORD:?}" "${SNAPSHOT_DB_PASSWORD:?}"

# Three roles on this one Postgres, on purpose — see .env.example:
#   ADMIN_*     superuser, used only here
#   SNAPSHOT_*  SELECT-only, what the app's model-generated SQL runs as
#   HISTORY_*   read/write, chat transcripts only

INTERVAL="${SYNC_INTERVAL_SECONDS:-3600}"
SNAPSHOT_DB="masterly_snapshot"
STAGING_DB="masterly_snapshot_next"
SNAPSHOT_ROLE="${SNAPSHOT_DB_USERNAME:-chatbot}"
DUMP_FILE="/tmp/masterly.dump"

# Chat history lives in its OWN database, never in the snapshot: the snapshot is
# dropped and recreated on every cycle, which would take the transcripts with it.
HISTORY_DB="${HISTORY_DB_DATABASE:-chatbot_app}"
HISTORY_ROLE="${HISTORY_DB_USERNAME:-chatbot_app}"

# Structure is copied for every table; DATA is skipped for these (queue/cache
# noise and API tokens have no analytics value and personal_access_tokens is
# sensitive).
EXCLUDED_DATA_TABLES=(cache cache_locks jobs job_batches failed_jobs personal_access_tokens)

export PGCONNECT_TIMEOUT=10

log() { echo "[sync] $(date -u +%FT%TZ) $*"; }

dump_source() {
    local args=()
    local t
    for t in "${EXCLUDED_DATA_TABLES[@]}"; do
        args+=(--exclude-table-data="public.${t}")
    done
    PGPASSWORD="$SOURCE_DB_PASSWORD" pg_dump \
        -h "$SOURCE_DB_HOST" -p "$SOURCE_DB_PORT" \
        -U "$SOURCE_DB_USERNAME" -d "$SOURCE_DB_DATABASE" \
        -Fc --no-owner --no-acl "${args[@]}" -f "$DUMP_FILE"
}

admin_psql() {
    PGPASSWORD="$ADMIN_DB_PASSWORD" psql -q -v ON_ERROR_STOP=1 \
        -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$ADMIN_DB_USERNAME" "$@"
}

# dump_source always writes a custom-format archive (-Fc), so pg_restore is
# always the right reader.
restore_into_staging() {
    PGPASSWORD="$ADMIN_DB_PASSWORD" pg_restore \
        -h "$ADMIN_DB_HOST" -p "$ADMIN_DB_PORT" -U "$ADMIN_DB_USERNAME" \
        -d "$STAGING_DB" --no-owner --no-acl --exit-on-error "$DUMP_FILE"
}

restore_and_swap() {
    admin_psql -d postgres -c "DROP DATABASE IF EXISTS ${STAGING_DB} WITH (FORCE);" &&
    admin_psql -d postgres -c "CREATE DATABASE ${STAGING_DB};" &&
    restore_into_staging &&
    admin_psql -d postgres -c "DROP DATABASE IF EXISTS ${SNAPSHOT_DB} WITH (FORCE);" &&
    admin_psql -d postgres -c "ALTER DATABASE ${STAGING_DB} RENAME TO ${SNAPSHOT_DB};"
}

grant_snapshot_role() {
    admin_psql -d postgres <<SQL &&
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${SNAPSHOT_ROLE}') THEN
        CREATE ROLE ${SNAPSHOT_ROLE} LOGIN;
    END IF;
END \$\$;
ALTER ROLE ${SNAPSHOT_ROLE} LOGIN PASSWORD '${SNAPSHOT_DB_PASSWORD}';
ALTER ROLE ${SNAPSHOT_ROLE} SET default_transaction_read_only = on;
ALTER ROLE ${SNAPSHOT_ROLE} SET statement_timeout = '15s';
GRANT CONNECT ON DATABASE ${SNAPSHOT_DB} TO ${SNAPSHOT_ROLE};
SQL
    admin_psql -d "$SNAPSHOT_DB" <<SQL
GRANT USAGE ON SCHEMA public TO ${SNAPSHOT_ROLE};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${SNAPSHOT_ROLE};
SQL
}

# Creates the chat-history database and the read/write role the app owns it
# with. Idempotent, and deliberately separate from the read-only snapshot role:
# the app connects twice, read-only to the snapshot and read/write to this one.
# The app itself creates the tables inside it (it is the database owner).
bootstrap_history_db() {
    [ -n "${HISTORY_DB_PASSWORD:-}" ] || { log "HISTORY_DB_PASSWORD unset — chat history disabled"; return 0; }

    admin_psql -d postgres <<SQL || return 1
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${HISTORY_ROLE}') THEN
        CREATE ROLE ${HISTORY_ROLE} LOGIN;
    END IF;
END \$\$;
ALTER ROLE ${HISTORY_ROLE} LOGIN PASSWORD '${HISTORY_DB_PASSWORD}';
SQL

    if [ "$(admin_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${HISTORY_DB}'")" != "1" ]; then
        admin_psql -d postgres -c "CREATE DATABASE ${HISTORY_DB} OWNER ${HISTORY_ROLE};" || return 1
        log "created chat history database ${HISTORY_DB}"
    fi

    # Postgres grants CONNECT to PUBLIC by default; keep the read-only snapshot
    # role (and anything else) out of the history database.
    admin_psql -d postgres <<SQL || return 1
REVOKE CONNECT ON DATABASE ${HISTORY_DB} FROM PUBLIC;
ALTER DATABASE ${HISTORY_DB} OWNER TO ${HISTORY_ROLE};
GRANT CONNECT ON DATABASE ${HISTORY_DB} TO ${HISTORY_ROLE};
SQL
}

apply_snapshot() {
    if restore_and_swap && grant_snapshot_role; then
        log "sync complete — ${SNAPSHOT_DB} refreshed"
    else
        log "ERROR: restore/swap failed; previous snapshot (if any) left intact" >&2
        return 1
    fi
}

while true; do
    # Cheap and idempotent; retried every cycle so a database that was not ready
    # (or a password that changed) heals without a restart.
    bootstrap_history_db || log "ERROR: could not bootstrap ${HISTORY_DB}; chat history will be unavailable" >&2

    log "starting sync from ${SOURCE_DB_HOST}:${SOURCE_DB_PORT}/${SOURCE_DB_DATABASE}"
    if dump_source; then
        apply_snapshot
    else
        log "ERROR: pg_dump from source failed; retrying in ${INTERVAL}s" >&2
    fi
    rm -f "$DUMP_FILE"

    sleep "$INTERVAL"
done
