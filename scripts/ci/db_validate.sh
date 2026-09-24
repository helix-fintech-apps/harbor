#!/usr/bin/env bash
# Validate the database layer against a throwaway local Postgres 16 with a stub `auth` schema:
#   1. harbor_checks: auth stub + every migration, then scripts/ci/db_checks.sql
#      (constraints, ledger, RLS, atomic money operations).
#   2. harbor_seed:   auth stub + every migration + supabase/seed.sql applied TWICE (idempotent),
#      then scripts/ci/seed_checks.sql (demo users sign-in shape, roles, KYC, balances).
#
#   bash scripts/ci/db_validate.sh          (PG_BIN defaults to /usr/lib/postgresql/16/bin)
set -euo pipefail
# shellcheck source=pg_lib.sh source-path=SCRIPTDIR
source "$(dirname "$0")/pg_lib.sh"

pg_start

pg_create_migrated harbor_checks
echo "run db_checks.sql"
pg_psql -d harbor_checks -f "$PG_ROOT/scripts/ci/db_checks.sql"

pg_create_migrated harbor_seed
echo "apply supabase/seed.sql (twice)"
pg_psql -d harbor_seed -f "$PG_ROOT/supabase/seed.sql"
pg_psql -d harbor_seed -f "$PG_ROOT/supabase/seed.sql"
echo "run seed_checks.sql"
pg_psql -d harbor_seed -f "$PG_ROOT/scripts/ci/seed_checks.sql"

echo "DB VALIDATION PASSED"
