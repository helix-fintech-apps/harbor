#!/usr/bin/env bash
# Throwaway local Postgres 16 cluster for CI and local checks. Source it, then:
#   pg_start                  initdb + start (unix socket in a temp dir, TCP on 127.0.0.1:$PG_PORT)
#   pg_create_migrated <db>   create <db> with scripts/ci/auth_stub.sql + every supabase/migrations/*.sql
#   pg_psql -d <db> ...       psql as postgres (ON_ERROR_STOP)
#   pg_url <db>               postgresql:// URL for Node clients
# The cluster is stopped and deleted on exit. PG_BIN defaults to /usr/lib/postgresql/16/bin
# (preinstalled on GitHub's ubuntu-24.04 runners; `apt-get install postgresql-16` elsewhere).
# PGPORT_TEST overrides the port (default 54329).

PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
PG_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PG_PORT=${PGPORT_TEST:-54329}
PG_TMP=$(mktemp -d)
PG_RUN=()
# Postgres refuses to run as root: in root containers run the server and psql as `postgres`.
if [ "$(id -u)" = "0" ]; then
  chown postgres "$PG_TMP"
  PG_RUN=(runuser -u postgres --)
fi

pg_stop() {
  "${PG_RUN[@]}" "$PG_BIN/pg_ctl" -D "$PG_TMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$PG_TMP"
}
trap pg_stop EXIT

pg_start() {
  if [ ! -x "$PG_BIN/initdb" ]; then
    echo "Postgres 16 binaries not found in $PG_BIN (set PG_BIN or install postgresql-16)" >&2
    return 1
  fi
  "${PG_RUN[@]}" "$PG_BIN/initdb" -D "$PG_TMP/data" -U postgres -A trust >/dev/null
  "${PG_RUN[@]}" "$PG_BIN/pg_ctl" -D "$PG_TMP/data" \
    -o "-p $PG_PORT -k $PG_TMP -c listen_addresses=127.0.0.1 -c timezone=UTC" \
    -l "$PG_TMP/log" -w start >/dev/null
}

pg_psql() {
  "${PG_RUN[@]}" "$PG_BIN/psql" -h "$PG_TMP" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"
}

pg_create_migrated() {
  local db="$1" f
  pg_psql -d postgres -c "create database $db"
  pg_psql -d "$db" -f "$PG_ROOT/scripts/ci/auth_stub.sql"
  for f in "$PG_ROOT"/supabase/migrations/*.sql; do
    echo "[$db] apply $(basename "$f")"
    pg_psql -d "$db" -f "$f"
  done
}

pg_url() {
  echo "postgresql://postgres@127.0.0.1:$PG_PORT/$1"
}
