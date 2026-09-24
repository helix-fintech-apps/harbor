// Regenerates supabase/migrations/*_policy_seed.sql from DEFAULT_POLICY / DEFAULT_FEES.
// Run: node --experimental-strip-types scripts/gen-policy-seed.ts
import { writeFileSync } from "node:fs";
import { DEFAULT_POLICY, DEFAULT_FEES } from "../supabase/functions/_shared/domain/config.ts";

const q = (o: unknown) => JSON.stringify(o).replaceAll("'", "''");
const sql = `-- Money policy v1 + fee schedule v1. GENERATED from supabase/functions/_shared/domain/config.ts
-- by scripts/gen-policy-seed.ts — do not edit by hand (a unit test checks they match).
insert into money_policies (version, policy, effective_from) values
  (${DEFAULT_POLICY.version}, '${q(DEFAULT_POLICY)}'::jsonb, '2026-09-01T00:00:00Z');

insert into fee_schedules (version, schedule, effective_from, published_at) values
  (${DEFAULT_FEES.version}, '${q(DEFAULT_FEES)}'::jsonb, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
`;
writeFileSync(new URL("../supabase/migrations/20260924000003_policy_seed.sql", import.meta.url), sql);
console.log("wrote policy seed");
