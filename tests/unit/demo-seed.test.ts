// supabase/seed.sql must create exactly the demo-mode users (same ids, emails, legal names, roles and
// password), so the live app and demo mode start from the same people. scripts/ci/seed_checks.sql
// checks the seeded database itself (sign-in shape, KYC states, balances).
import { readFileSync } from "node:fs";
import { DEMO_PASSWORD, DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";

const sql = readFileSync(new URL("../../supabase/seed.sql", import.meta.url), "utf8");
const seeded = [...sql.matchAll(/\('([0-9a-f-]{36})'::uuid, '([^']+@harbor\.test)',\s*'([^']+)'\)/g)].map(([, id, email, legalName]) => ({ id, email, legalName }));

describe("supabase/seed.sql mirrors the demo-mode users", () => {
  it("seeds every demo user with the same id, email and legal name", () => {
    expect(seeded).toEqual(DEMO_USERS.map(({ id, email, legalName }) => ({ id, email, legalName })));
  });
  it("uses the demo password, hashed with bcrypt", () => {
    expect(sql).toContain(`extensions.crypt('${DEMO_PASSWORD}', extensions.gen_salt('bf'))`);
  });
  it("grants exactly the demo staff roles", () => {
    const grants = [...sql.matchAll(/update public\.profiles set role = '(\w+)' where id = '([0-9a-f-]{36})'/g)].map(([, role, id]) => ({ id, role }));
    expect(grants).toEqual(DEMO_USERS.filter((u) => u.role !== "customer").map(({ id, role }) => ({ id, role })));
  });
});
