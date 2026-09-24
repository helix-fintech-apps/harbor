#!/usr/bin/env bash
# Validate migrations against a throwaway local Postgres 16 and run scripts/ci/db_checks.sql.
# Usage: bash scripts/ci/db_validate.sh   (PG_BIN defaults to /usr/lib/postgresql/16/bin)
set -euo pipefail
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
PORT=${PGPORT_TEST:-54329}
RUN=()
if [ "$(id -u)" = "0" ]; then chown postgres "$TMP"; RUN=(runuser -u postgres --); fi
cleanup() { "${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"${RUN[@]}" "$PG_BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"${RUN[@]}" "$PG_BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=("${RUN[@]}" "$PG_BIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f "$ROOT/scripts/ci/auth_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "apply $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "run db_checks.sql"
"${PSQL[@]}" -f "$ROOT/scripts/ci/db_checks.sql"
echo "DB VALIDATION PASSED"
