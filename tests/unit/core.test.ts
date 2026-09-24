import {
  DEFAULT_POLICY as P, DEFAULT_FEES as F, divRoundHalfUp, divRoundHalfEven, applyBps, assertCents,
  addBusinessDays, txn, dr, cr, assertBalanced, partyBalance, trialBalance,
  mapIdentityStatus, decideKyc, screenSanctions, canTransitionKyc, transitionKyc, canMoveMoney, canPayout, withVendorTimeout,
  checkLimit, usage, abaChecksumValid, HARBOR_ROUTING_NUMBER, fakeAccountNumber, maskAccountNumber, balances,
  withIdempotency, MemoryIdemStore, IdempotencyConflict, stableHash, type Hold, type Line,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);

describe("money helpers", () => {
  it("rounds half up and half even", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(1_500_000n, 1_000_000n)).toBe(2n);
    expect(divRoundHalfEven(2_500_000n, 1_000_000n)).toBe(2n);
    expect(divRoundHalfEven(2_500_001n, 1_000_000n)).toBe(3n);
    expect(divRoundHalfEven(-2_500_000n, 1_000_000n)).toBe(-2n);
  });
  it("applies basis points and rejects floats", () => {
    expect(applyBps(10_000, 150)).toBe(150);
    expect(applyBps(3_333, 300)).toBe(100); // 99.99 -> 100
    expect(() => assertCents(1.5)).toThrow();
  });
  it("adds business days skipping weekends and holidays", () => {
    // Fri 2026-09-25 + 3 business days = Wed 2026-09-30
    expect(addBusinessDays(T("2026-09-25T15:00:00Z"), 3).toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // Thu 2026-11-25 + 1 skips Thanksgiving (26th) -> Fri 27th
    expect(addBusinessDays(T("2026-11-25T12:00:00Z"), 1, P.holidays).toISOString().slice(0, 10)).toBe("2026-11-27");
    expect(() => addBusinessDays(T("2026-01-01"), -1)).toThrow();
  });
});

describe("ledger", () => {
  it("rejects unbalanced and non-integer txns", () => {
    expect(() => txn("x", [dr("ach_clearing", 100), cr("customer_deposits", 99, "a")])).toThrow(/unbalanced/);
    expect(() => assertBalanced({ kind: "x", lines: [{ account: "fee_revenue", debit: 1.5, credit: 0 }] })).toThrow();
    expect(() => txn("x", [dr("ach_clearing", 0), cr("customer_deposits", 0, "a")])).toThrow(/empty/);
  });
  it("derives party balances and a zero trial balance", () => {
    const lines: Line[] = [
      ...txn("in", [dr("ach_clearing", 5000), cr("customer_deposits", 5000, "acct")]).lines,
      ...txn("out", [dr("customer_deposits", 1200, "acct"), cr("ach_clearing", 1000), cr("fee_revenue", 200)]).lines,
    ];
    expect(partyBalance(lines, "customer_deposits", "acct")).toBe(3800);
    expect(trialBalance(lines)).toBe(0);
  });
});

describe("KYC", () => {
  const clear = { kind: "clear" } as const;
  it("approves only when identity verified AND sanctions clear", () => {
    expect(decideKyc({ kind: "verified" }, clear).state).toBe("approved");
    expect(decideKyc({ kind: "verified" }, null).state).toBe("pending");
    expect(decideKyc({ kind: "verified" }, { kind: "error" }).state).toBe("pending");
  });
  it("never approves on vendor timeout or unknown status", () => {
    expect(decideKyc({ kind: "timeout" }, clear).state).toBe("pending");
    expect(decideKyc(mapIdentityStatus("approved_maybe"), clear).state).toBe("pending");
    expect(decideKyc(mapIdentityStatus(undefined), clear).state).toBe("pending");
    expect(decideKyc(mapIdentityStatus("processing"), clear).state).toBe("pending");
  });
  it("routes requires_input to review, failures to rejected, sanctions hits to review/freeze", () => {
    expect(decideKyc(mapIdentityStatus("requires_input"), clear).state).toBe("needs_review");
    expect(decideKyc(mapIdentityStatus("canceled"), clear).state).toBe("rejected");
    expect(decideKyc({ kind: "verified" }, { kind: "potential_match", entry: "x", scoreBps: 9000 }).state).toBe("needs_review");
    expect(decideKyc({ kind: "verified" }, { kind: "confirmed_match", entry: "x" }).state).toBe("frozen_legal");
    expect(decideKyc({ kind: "timeout" }, { kind: "confirmed_match", entry: "x" }).state).toBe("frozen_legal");
  });
  it("screens the fake sanctions list with normalization and fuzzy matching", () => {
    expect(screenSanctions("OLEG embargo", P).kind).toBe("confirmed_match");
    expect(screenSanctions("Oleg Émbargo Jr.", P).kind).toBe("confirmed_match");
    expect(screenSanctions("Maria Sanctioned", P).kind).toBe("potential_match");
    expect(screenSanctions("Maria Lopez", P).kind).toBe("clear");
    expect(screenSanctions("Ava Harbor", P).kind).toBe("clear");
  });
  it("enforces the state machine", () => {
    expect(canTransitionKyc("approved", "frozen_legal")).toBe(true);
    expect(canTransitionKyc("rejected", "approved")).toBe(false);
    expect(canTransitionKyc("approved", "pending")).toBe(false);
    expect(() => transitionKyc("suspended", "unverified")).toThrow();
    expect(canMoveMoney("approved")).toBe(true);
    for (const s of ["unverified", "pending", "needs_review", "rejected", "suspended", "frozen_legal"] as const) expect(canMoveMoney(s)).toBe(false);
    expect(canPayout("frozen_legal")).toBe(false);
  });
  it("turns a slow vendor into a timeout", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("verified"), 50));
    expect(await withVendorTimeout(slow, 5)).toBe("timeout");
    expect(await withVendorTimeout(Promise.resolve("verified"), 50)).toBe("verified");
  });
});

describe("tier limits", () => {
  const now = T("2026-09-24T18:00:00Z");
  const ev = (iso: string, amountCents: number) => ({ at: T(iso), amountCents, kind: "transfer_out" as const });
  it("allows exactly the daily limit and declines one cent over (tier1 $1,000/day)", () => {
    const used = [ev("2026-09-24T01:00:00Z", 60_000)];
    expect(checkLimit("tier1", "transfer_out", 40_000, used, now, P).ok).toBe(true);
    const r = checkLimit("tier1", "transfer_out", 40_001, used, now, P);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("daily_limit");
  });
  it("resets daily at UTC midnight but counts toward the month", () => {
    const used = [ev("2026-09-23T23:59:59Z", 100_000)];
    expect(usage(used, "transfer_out", now)).toEqual({ today: 0, month: 100_000 });
    expect(checkLimit("tier1", "transfer_out", 100_000, used, now, P).ok).toBe(true);
  });
  it("enforces the monthly limit ($5,000 tier1) and tier2 is higher", () => {
    const used = [1, 2, 3, 4, 5].map((d) => ev(`2026-09-0${d}T12:00:00Z`, 99_000));
    expect(checkLimit("tier1", "transfer_out", 5_001, used, now, P).reason).toBe("monthly_limit");
    expect(checkLimit("tier1", "transfer_out", 5_000, used, now, P).ok).toBe(true);
    expect(checkLimit("tier2", "transfer_out", 400_000, used, now, P).ok).toBe(true);
  });
  it("tracks card spend separately from transfers", () => {
    const used = [ev("2026-09-24T01:00:00Z", 100_000)];
    expect(checkLimit("tier1", "card_spend", 200_000, used, now, P).ok).toBe(true);
    expect(checkLimit("tier1", "card_spend", 200_001, used, now, P).ok).toBe(false);
  });
});

describe("accounts and balances", () => {
  it("uses a checksum-valid fake routing number and deterministic account numbers", () => {
    expect(abaChecksumValid(HARBOR_ROUTING_NUMBER)).toBe(true);
    expect(abaChecksumValid("123456789")).toBe(false);
    expect(fakeAccountNumber("abc")).toBe(fakeAccountNumber("abc"));
    expect(fakeAccountNumber("abc")).toMatch(/^8800\d{8}$/);
    expect(maskAccountNumber("880012345678")).toBe("••••5678");
  });
  it("available = posted - active holds; expired holds don't count", () => {
    const now = T("2026-09-24T00:00:00Z");
    const lines = txn("in", [dr("ach_clearing", 10_000), cr("customer_deposits", 10_000, "a")]).lines;
    const holds: Hold[] = [
      { id: "h1", accountId: "a", kind: "ach_in", amountCents: 6_000, status: "active", createdAt: now },
      { id: "h2", accountId: "a", kind: "card_auth", amountCents: 1_000, status: "active", createdAt: now, expiresAt: T("2026-09-23T00:00:00Z") },
      { id: "h3", accountId: "a", kind: "card_auth", amountCents: 500, status: "released", createdAt: now },
      { id: "h4", accountId: "b", kind: "card_auth", amountCents: 700, status: "active", createdAt: now },
    ];
    expect(balances(lines, holds, "a", now)).toEqual({ postedCents: 10_000, holdsCents: 6_000, availableCents: 4_000 });
  });
});

describe("idempotency", () => {
  it("returns the first result on replay and runs the effect once", async () => {
    const store = new MemoryIdemStore();
    let runs = 0;
    const fn = async () => ({ status: 201, body: { id: ++runs } });
    const a = await withIdempotency(store, "k1", { amount: 100 }, fn);
    const b = await withIdempotency(store, "k1", { amount: 100 }, fn);
    expect(a.body).toEqual({ id: 1 });
    expect(b.body).toEqual({ id: 1 });
    expect(b.replayed).toBe(true);
    expect(runs).toBe(1);
  });
  it("rejects key reuse with a different body; key order does not matter", async () => {
    const store = new MemoryIdemStore();
    await withIdempotency(store, "k", { a: 1, b: 2 }, async () => ({ status: 200, body: 1 }));
    await expect(withIdempotency(store, "k", { a: 1, b: 3 }, async () => ({ status: 200, body: 2 }))).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
  it("does not cache 5xx failures", async () => {
    const store = new MemoryIdemStore();
    await withIdempotency(store, "k", {}, async () => ({ status: 503, body: "x" }));
    const r = await withIdempotency(store, "k", {}, async () => ({ status: 200, body: "ok" }));
    expect(r.body).toBe("ok");
  });
});

void F;
