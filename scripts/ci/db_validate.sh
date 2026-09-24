#!/usr/bin/env bash
# Validate the migrations against a throwaway local Postgres 16 with a stub `auth` schema, then run
# the SQL invariants in scripts/ci/db_checks.sql (constraints, ledger, RLS, atomic money operations).
#
#   bash scripts/ci/db_validate.sh          (PG_BIN defaults to /usr/lib/postgresql/16/bin)
set -euo pipefail
# shellcheck source=scripts/ci/pg_lib.sh
source "$(dirname "$0")/pg_lib.sh"

pg_start
pg_create_migrated harbor_checks
echo "run db_checks.sql"
pg_psql -d harbor_checks -f "$PG_ROOT/scripts/ci/db_checks.sql"
echo "DB VALIDATION PASSED"
