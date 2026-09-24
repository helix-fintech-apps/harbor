// Builds the Harbor app (real service + router, fake providers, controllable clock) over each
// store the integration suite runs against:
//   - memory:   MemoryStore (always)
//   - postgres: SupabaseStore -> harbor_* SQL functions, when HARBOR_PG_URL points at a database
//               with scripts/ci/auth_stub.sql + supabase/migrations applied (scripts/ci/with_pg.sh).
import pg from "pg";
import {
  createApp,
  createMemoryApp,
  demoClock,
  seedDemo,
  DEMO_USERS,
  type App,
} from "../../../supabase/functions/_shared/app/demo.ts";
import { SupabaseStore } from "../../../supabase/functions/_shared/app/store.ts";
import { PgSupabase } from "./pg-supabase.ts";

export interface TestApp extends App {
  /** Sign up a customer (Supabase Auth user + profile), unverified. */
  addUser(id: string, email: string, legalName: string): Promise<void>;
}

export interface Harness {
  name: "memory" | "postgres";
  /** Fresh app at `start`, seeded with the demo users (see seedDemo). */
  create(start: Date): Promise<TestApp>;
  close(): Promise<void>;
}

const memoryHarness: Harness = {
  name: "memory",
  async create(start) {
    const app = createMemoryApp(start, { kycTimeoutMs: 20 });
    await seedDemo(app);
    return {
      ...app,
      addUser: async (id, email, legalName) => {
        await app.service.createProfile(id, email, legalName);
      },
    };
  },
  async close() {},
};

function postgresHarness(url: string): Harness {
  let pool: pg.Pool | undefined;
  return {
    name: "postgres",
    async create(start) {
      pool ??= new pg.Pool({ connectionString: url, max: 6 });
      const db = pool;
      const tables = (
        await db.query(
          "select tablename from pg_tables where schemaname = 'public' and tablename not in ('money_policies', 'fee_schedules')",
        )
      ).rows.map((r) => `public."${r.tablename}"`);
      await db.query(`truncate ${tables.join(", ")}, auth.users restart identity cascade`);
      // Signup = an auth.users row; the on_auth_user_created trigger creates the customer profile.
      const addUser = async (id: string, email: string, legalName: string, role = "customer") => {
        await db.query(
          "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)",
          [id, email, JSON.stringify({ legal_name: legalName })],
        );
        if (role !== "customer")
          await db.query("update public.profiles set role = $2 where id = $1", [id, role]);
      };
      for (const u of DEMO_USERS) await addUser(u.id, u.email, u.legalName, u.role);
      const clock = demoClock(start);
      const app = createApp(new SupabaseStore(new PgSupabase(db)), clock, { kycTimeoutMs: 20 });
      await seedDemo(app);
      return { ...app, addUser: (id, email, legalName) => addUser(id, email, legalName) };
    },
    async close() {
      await pool?.end();
      pool = undefined;
    },
  };
}

export function harnesses(): Harness[] {
  const url = process.env.HARBOR_PG_URL;
  return url ? [memoryHarness, postgresHarness(url)] : [memoryHarness];
}
