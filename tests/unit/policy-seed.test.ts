import { readFileSync } from "node:fs";
import { DEFAULT_POLICY, DEFAULT_FEES } from "../../supabase/functions/_shared/domain/index.ts";

describe("policy seed migration mirrors config.ts", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20260924000003_policy_seed.sql", import.meta.url), "utf8");
  const jsons = [...sql.matchAll(/'(\{.*?\})'::jsonb/g)].map((m) => JSON.parse(m[1].replaceAll("''", "'")));
  it("money_policies v1 = DEFAULT_POLICY", () => expect(jsons[0]).toEqual(DEFAULT_POLICY));
  it("fee_schedules v1 = DEFAULT_FEES", () => expect(jsons[1]).toEqual(DEFAULT_FEES));
});
