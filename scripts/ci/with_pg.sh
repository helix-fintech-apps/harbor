#!/usr/bin/env bash
# Run a command against a throwaway Postgres 16 that has the auth stub + all migrations applied.
# Exports HARBOR_PG_URL for the command (the integration suite then also runs on Postgres).
#
#   bash scripts/ci/with_pg.sh npx vitest run tests/integration
set -euo pipefail
# shellcheck source=scripts/ci/pg_lib.sh
source "$(dirname "$0")/pg_lib.sh"

pg_start
pg_create_migrated harbor_it
HARBOR_PG_URL="$(pg_url harbor_it)"
export HARBOR_PG_URL
echo "HARBOR_PG_URL=$HARBOR_PG_URL"
"$@"
