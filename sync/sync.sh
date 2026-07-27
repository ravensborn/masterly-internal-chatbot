#!/usr/bin/env bash
# Periodically copies the source masterly database into this stack's internal
# Postgres. Runs inside a postgres:18 container so pg_dump/pg_restore match the
# PG18 servers on both sides (no client/server version mismatch).
#
# Flow per cycle:
#   1. pg_dump -Fc from the source DB (data of infra tables excluded)
#   2. restore into a staging database (masterly_snapshot_next)
#   3. atomic-ish swap: drop masterly_snapshot, rename staging into its place
#   4. re-create/grant the read-only `chatbot` role (grants die with the drop)
#
# A failure at any step leaves the previous snapshot intact; the cycle simply
# retries after SYNC_INTERVAL_SECONDS.

set -u

: "${SOURCE_DB_HOST:?}" "${SOURCE_DB_PORT:?}" "${SOURCE_DB_DATABASE:?}"
: "${SOURCE_DB_USERNAME:?}" "${SOURCE_DB_PASSWORD:?}"
: "${INTERNAL_DB_HOST:?}" "${INTERNAL_DB_PORT:?}"
: "${INTERNAL_DB_USERNAME:?}" "${INTERNAL_DB_PASSWORD:?}" "${CHATBOT_DB_PASSWORD:?}"

INTERVAL="${SYNC_INTERVAL_SECONDS:-3600}"
SNAPSHOT_DB="masterly_snapshot"
STAGING_DB="masterly_snapshot_next"
DUMP_FILE="/tmp/masterly.dump"

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

internal_psql() {
    PGPASSWORD="$INTERNAL_DB_PASSWORD" psql -q -v ON_ERROR_STOP=1 \
        -h "$INTERNAL_DB_HOST" -p "$INTERNAL_DB_PORT" -U "$INTERNAL_DB_USERNAME" "$@"
}

restore_and_swap() {
    internal_psql -d postgres -c "DROP DATABASE IF EXISTS ${STAGING_DB} WITH (FORCE);" &&
    internal_psql -d postgres -c "CREATE DATABASE ${STAGING_DB};" &&
    PGPASSWORD="$INTERNAL_DB_PASSWORD" pg_restore \
        -h "$INTERNAL_DB_HOST" -p "$INTERNAL_DB_PORT" -U "$INTERNAL_DB_USERNAME" \
        -d "$STAGING_DB" --no-owner --no-acl --exit-on-error "$DUMP_FILE" &&
    internal_psql -d postgres -c "DROP DATABASE IF EXISTS ${SNAPSHOT_DB} WITH (FORCE);" &&
    internal_psql -d postgres -c "ALTER DATABASE ${STAGING_DB} RENAME TO ${SNAPSHOT_DB};"
}

grant_chatbot_role() {
    internal_psql -d postgres <<SQL &&
DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chatbot') THEN
        CREATE ROLE chatbot LOGIN;
    END IF;
END \$\$;
ALTER ROLE chatbot LOGIN PASSWORD '${CHATBOT_DB_PASSWORD}';
ALTER ROLE chatbot SET default_transaction_read_only = on;
ALTER ROLE chatbot SET statement_timeout = '15s';
GRANT CONNECT ON DATABASE ${SNAPSHOT_DB} TO chatbot;
SQL
    internal_psql -d "$SNAPSHOT_DB" <<SQL
GRANT USAGE ON SCHEMA public TO chatbot;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot;
SQL
}

while true; do
    log "starting sync from ${SOURCE_DB_HOST}:${SOURCE_DB_PORT}/${SOURCE_DB_DATABASE}"
    if dump_source; then
        if restore_and_swap && grant_chatbot_role; then
            log "sync complete — ${SNAPSHOT_DB} refreshed"
        else
            log "ERROR: restore/swap failed; previous snapshot (if any) left intact" >&2
        fi
    else
        log "ERROR: pg_dump from source failed; retrying in ${INTERVAL}s" >&2
    fi
    rm -f "$DUMP_FILE"
    sleep "$INTERVAL"
done
