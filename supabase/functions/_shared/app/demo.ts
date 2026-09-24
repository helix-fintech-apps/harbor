// In-memory Harbor (fake providers) with a controllable clock and demo seed data.
// Used by integration tests and by the web UI's demo mode (no Supabase project required).
// `createApp` builds the same app over any Store (tests also run it on Postgres).

import { fakeProviders } from "../providers/index.ts";
import { MemoryStore, type Store } from "./store.ts";
import { HarborService, type Caller } from "./service.ts";
import { route, type ApiRequest } from "./router.ts";

export interface DemoClock {
  now: () => Date;
  advanceHours: (h: number) => void;
  set: (d: Date) => void;
  offsetMs: number;
}

export interface App<S extends Store = Store> {
  store: S;
  service: HarborService;
  clock: DemoClock;
  call: (
    caller: Caller | null,
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotencyKey?: string; query?: Record<string, string> },
  ) => ReturnType<typeof route>;
}

export type MemoryApp = App<MemoryStore>;

/** A clock that starts at `start` and moves with real time, plus manual jumps. */
export function demoClock(start = new Date()): DemoClock {
  const clock: DemoClock = {
    offsetMs: start.getTime() - Date.now(),
    now() {
      return new Date(Date.now() + clock.offsetMs);
    },
    advanceHours(h: number) {
      clock.offsetMs += h * 3_600_000;
    },
    set(d: Date) {
      clock.offsetMs = d.getTime() - Date.now();
    },
  };
  return clock;
}

export function createApp<S extends Store>(
  store: S,
  clock: DemoClock,
  opts: { kycTimeoutMs?: number } = {},
): App<S> {
  const service = new HarborService({
    store,
    providers: fakeProviders(),
    clock: () => clock.now(),
    kycTimeoutMs: opts.kycTimeoutMs ?? 2_000,
  });
  const call: App["call"] = (caller, method, path, body, o = {}) => {
    const [p, qs] = path.split("?");
    const query = { ...Object.fromEntries(new URLSearchParams(qs ?? "")), ...(o.query ?? {}) };
    const req: ApiRequest = {
      method,
      path: p,
      body: body ?? {},
      caller,
      idempotencyKey: o.idempotencyKey,
      query,
    };
    return route(service, req);
  };
  return { store, service, clock, call };
}

export function createMemoryApp(
  start = new Date(),
  opts: { kycTimeoutMs?: number } = {},
): MemoryApp {
  const clock = demoClock(start);
  return createApp(new MemoryStore(() => clock.now()), clock, opts);
}

/** Password of every demo user (demo mode and supabase/seed.sql). Test only. */
export const DEMO_PASSWORD = "Harbor!2026";

export const DEMO_USERS = [
  {
    id: "00000000-0000-4000-8000-00000000a0a0",
    email: "ava@harbor.test",
    legalName: "Ava Harbor",
    role: "customer" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000b0b0",
    email: "ben@harbor.test",
    legalName: "Ben Rivers",
    role: "customer" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000c0c0",
    email: "rita@harbor.test",
    legalName: "Rita Review",
    role: "customer" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000d0d0",
    email: "oleg@harbor.test",
    legalName: "Oleg Embargo",
    role: "customer" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000e0e0",
    email: "nia@harbor.test",
    legalName: "Nia New",
    role: "customer" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000ad00",
    email: "admin@harbor.test",
    legalName: "Ada Admin",
    role: "admin" as const,
  },
  {
    id: "00000000-0000-4000-8000-00000000ae00",
    email: "agent@harbor.test",
    legalName: "Sam Support",
    role: "support_agent" as const,
  },
];

/**
 * Seed: Ava (approved, tier1, $2,500 settled + linked bank past cooling-off, virtual card),
 * Ben (approved, $500), Rita (needs_review), Oleg (frozen_legal via sanctions), Nia (unverified), staff.
 */
export async function seedDemo(app: Pick<App, "service" | "clock">) {
  const { service: s, clock } = app;
  for (const u of DEMO_USERS) await s.createProfile(u.id, u.email, u.legalName, u.role);
  const c = (id: string) => ({ userId: id, role: "customer" as const });
  const [ava, ben, rita, oleg] = DEMO_USERS;
  for (const u of [ava, ben, rita, oleg]) await s.runKyc(c(u.id));
  const avaBank = await s.exchange(c(ava.id), "public-fake-First_Platypus_Bank-Ava_Harbor");
  const benBank = await s.exchange(c(ben.id), "public-fake-Tattersall_Credit_Union-Ben_Rivers");
  await s.achIn(c(ava.id), { bankId: avaBank.id, amountCents: 250_000 });
  await s.achIn(c(ben.id), { bankId: benBank.id, amountCents: 50_000 });
  clock.advanceHours(24 * 7); // past the ACH hold and the 72h cooling-off
  await s.settleAch(null);
  await s.issueCard(c(ava.id), { kind: "virtual" });
}
