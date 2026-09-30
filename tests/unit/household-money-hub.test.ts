import {
  DEFAULT_POLICY as P,
  DEFAULT_FEES as F,
  planZelleSend,
  planZelleReturn,
  nextZelleRun,
  validateRecipient,
  isValidFrequency,
  ZelleError,
  cashbackForCapture,
  cashbackReversal,
  cashbackLedger,
  cashbackReversalLedger,
  withinHouseholdCap,
  householdMonthSpend,
  validateHouseholdName,
  validateMonthlyCap,
  validateEnvelopeDates,
  envelopeReachedEnd,
  authorize,
  partyBalance,
  trialBalance,
  type AuthContext,
  type Card,
  type SpendablePocket,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");
const reason = (d: ReturnType<typeof authorize>) => (d.approved ? "approved" : d.reason);

describe("Zelle send funding plan", () => {
  const pocket = (
    accountId: string,
    availableCents: number,
    kind = "checking",
  ): SpendablePocket => ({
    accountId,
    kind: kind as SpendablePocket["kind"],
    availableCents,
  });
  const recipient = { email: "friend@example.com" };

  it("draws from the source alone when it covers the amount; no shortfall", () => {
    const plan = planZelleSend({
      transferId: "z1",
      fromAccountId: "chk",
      amountCents: 5_000,
      recipient,
      spendable: [pocket("chk", 20_000), pocket("sav", 5_000, "savings")],
      now,
    });
    expect(plan.funding).toEqual([{ accountId: "chk", amountCents: 5_000 }]);
    expect(plan.shortfallCents).toBe(0);
    expect(partyBalance(plan.ledger.lines, "customer_deposits", "chk")).toBe(-5_000);
    expect(plan.ledger.lines.find((l) => l.account === "zelle_clearing")!.credit).toBe(5_000);
    expect(trialBalance(plan.ledger.lines)).toBe(0);
  });

  it("pulls the shortfall from other pockets in order, taking each pocket's available", () => {
    const plan = planZelleSend({
      transferId: "z2",
      fromAccountId: "chk",
      amountCents: 12_000,
      recipient,
      spendable: [pocket("chk", 10_000), pocket("sav", 5_000, "savings")],
      now,
    });
    expect(plan.funding).toEqual([
      { accountId: "chk", amountCents: 10_000 },
      { accountId: "sav", amountCents: 2_000 },
    ]);
    expect(plan.shortfallCents).toBe(2_000);
    expect(partyBalance(plan.ledger.lines, "customer_deposits", "sav")).toBe(-2_000);
    expect(trialBalance(plan.ledger.lines)).toBe(0);
  });

  it("can fund entirely from other pockets when the source is empty", () => {
    const plan = planZelleSend({
      transferId: "z3",
      fromAccountId: "chk",
      amountCents: 3_000,
      recipient,
      spendable: [pocket("chk", 0), pocket("sav", 5_000, "savings")],
      now,
    });
    expect(plan.funding).toEqual([{ accountId: "sav", amountCents: 3_000 }]);
    expect(plan.shortfallCents).toBe(3_000); // nothing came from the source
  });

  it("never overdraws: skips overdrawn pockets and rejects when the total is short", () => {
    expect(() =>
      planZelleSend({
        transferId: "z4",
        fromAccountId: "chk",
        amountCents: 20_000,
        recipient,
        spendable: [pocket("chk", 10_000), pocket("sav", 5_000, "savings")],
        now,
      }),
    ).toThrow(ZelleError);
    // an overdrawn pocket contributes nothing
    const plan = planZelleSend({
      transferId: "z5",
      fromAccountId: "chk",
      amountCents: 1_000,
      recipient,
      spendable: [pocket("chk", -500), pocket("sav", 5_000, "savings")],
      now,
    });
    expect(plan.funding).toEqual([{ accountId: "sav", amountCents: 1_000 }]);
  });

  it("validates amount and recipient", () => {
    const spend = [pocket("chk", 5_000)];
    expect(() =>
      planZelleSend({
        transferId: "z",
        fromAccountId: "chk",
        amountCents: 0,
        recipient,
        spendable: spend,
        now,
      }),
    ).toThrow(/invalid_amount/);
    expect(() =>
      planZelleSend({
        transferId: "z",
        fromAccountId: "chk",
        amountCents: 100,
        recipient: { email: "nope" },
        spendable: spend,
        now,
      }),
    ).toThrow(/invalid_recipient/);
    expect(validateRecipient({ email: "a@b.co" })).toBe(true);
    expect(validateRecipient({ phone: "+1 (415) 555-0100" })).toBe(true);
    expect(validateRecipient({ phone: "12" })).toBe(false);
    expect(validateRecipient({})).toBe(false);
  });

  it("returns/refunds credit the money back to the source pocket", () => {
    const r = planZelleReturn({ transferId: "z2", toAccountId: "chk", amountCents: 12_000 });
    expect(partyBalance(r.ledger.lines, "customer_deposits", "chk")).toBe(12_000);
    expect(r.ledger.lines.find((l) => l.account === "zelle_clearing")!.debit).toBe(12_000);
    expect(trialBalance(r.ledger.lines)).toBe(0);
  });
});

describe("Zelle recurrence", () => {
  it("weekly advances 7 days; once never recurs", () => {
    expect(nextZelleRun(T("2026-09-24T18:00:00Z"), "weekly")!.toISOString()).toBe(
      "2026-10-01T18:00:00.000Z",
    );
    expect(nextZelleRun(now, "once")).toBeNull();
    expect(isValidFrequency("monthly")).toBe(true);
    expect(isValidFrequency("daily")).toBe(false);
  });
  it("monthly advances one month and clamps to the last day", () => {
    expect(nextZelleRun(T("2026-09-15T12:00:00Z"), "monthly")!.toISOString()).toBe(
      "2026-10-15T12:00:00.000Z",
    );
    // Jan 31 -> Feb 28 (2026 is not a leap year)
    expect(nextZelleRun(T("2026-01-31T09:00:00Z"), "monthly")!.toISOString()).toBe(
      "2026-02-28T09:00:00.000Z",
    );
  });
});

describe("cashback", () => {
  it("earns 1% of the captured amount, rounded half-up", () => {
    expect(cashbackForCapture(5_000, P)).toBe(50);
    expect(cashbackForCapture(5_900, P)).toBe(59);
    expect(cashbackForCapture(49, P)).toBe(0); // < half a cent
    expect(cashbackForCapture(50, P)).toBe(1); // exactly half a cent rounds up
    expect(cashbackForCapture(0, P)).toBe(0);
  });
  it("reverses pro-rata; a full refund reverses exactly the cashback earned", () => {
    // capture 5,000 -> cashback 50; refund 3,000 then 2,000 reverses 30 then 20 (total 50)
    expect(
      cashbackReversal({
        cashbackCents: 50,
        capturedCents: 5_000,
        refundedSoFarCents: 0,
        refundAmountCents: 3_000,
      }),
    ).toBe(30);
    expect(
      cashbackReversal({
        cashbackCents: 50,
        capturedCents: 5_000,
        refundedSoFarCents: 3_000,
        refundAmountCents: 2_000,
      }),
    ).toBe(20);
    // one full refund
    expect(
      cashbackReversal({
        cashbackCents: 59,
        capturedCents: 5_900,
        refundedSoFarCents: 0,
        refundAmountCents: 5_900,
      }),
    ).toBe(59);
    // partial refund of a purchase that earned no cashback
    expect(
      cashbackReversal({
        cashbackCents: 0,
        capturedCents: 100,
        refundedSoFarCents: 0,
        refundAmountCents: 100,
      }),
    ).toBe(0);
  });
  it("cashback ledgers balance and credit the card's account", () => {
    const cb = cashbackLedger("a1", "chk", 59);
    expect(partyBalance(cb.lines, "customer_deposits", "chk")).toBe(59);
    expect(cb.lines.find((l) => l.account === "cashback_expense")!.debit).toBe(59);
    const rev = cashbackReversalLedger("re_1", "chk", 9);
    expect(partyBalance(rev.lines, "customer_deposits", "chk")).toBe(-9);
    expect(trialBalance(cb.lines)).toBe(0);
    expect(trialBalance(rev.lines)).toBe(0);
  });
});

describe("household cap", () => {
  it("is inclusive and a null cap means no limit", () => {
    expect(withinHouseholdCap(10_000, 9_500, 500)).toBe(true); // exactly the cap
    expect(withinHouseholdCap(10_000, 9_500, 501)).toBe(false);
    expect(withinHouseholdCap(null, 1e9, 1e9)).toBe(true);
  });
  it("sums only this month's card spend", () => {
    const spend = [
      { at: T("2026-08-31T23:00:00Z"), amountCents: 1_000, kind: "card_spend" as const },
      { at: T("2026-09-02T00:00:00Z"), amountCents: 4_000, kind: "card_spend" as const },
      { at: T("2026-09-20T00:00:00Z"), amountCents: 2_000, kind: "card_spend" as const },
    ];
    expect(householdMonthSpend(spend, now)).toBe(6_000);
  });
  it("validates name and cap", () => {
    expect(validateHouseholdName("")).toHaveLength(1);
    expect(validateHouseholdName("Ours")).toEqual([]);
    expect(validateMonthlyCap(-1)).toHaveLength(1);
    expect(validateMonthlyCap(null)).toEqual([]);
    expect(validateMonthlyCap(50_000)).toEqual([]);
  });
});

describe("envelope accounts", () => {
  it("validates dates and detects the end date", () => {
    expect(validateEnvelopeDates("2026-09-01", "2026-10-01")).toEqual([]);
    expect(validateEnvelopeDates("2026-10-01", "2026-09-01")).toContain(
      "endDate must be after startDate",
    );
    expect(validateEnvelopeDates("bad", "2026-10-01")).toHaveLength(1);
    expect(envelopeReachedEnd("2026-09-25", now)).toBe(false); // now is 2026-09-24
    expect(envelopeReachedEnd("2026-09-24", now)).toBe(true); // inclusive
    expect(envelopeReachedEnd(null, now)).toBe(false);
  });
});

describe("authorize: per-card limits and household cap", () => {
  const card = (over: Partial<Card> = {}): Card => ({
    id: "c1",
    accountId: "chk",
    holderUserId: "u1",
    kind: "virtual",
    status: "active",
    last4: "4242",
    ...over,
  });
  const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
    card: card(),
    ownerKyc: "approved",
    ownerTier: "tier1",
    ownerUsage: [],
    availableCents: 1_000_000,
    recentAuthAttempts: [],
    now,
    ...over,
  });
  const req = (amountCents: number, mcc = "5411") => ({
    amountCents,
    mcc,
    merchant: "Shop",
    foreign: false,
  });

  it("enforces per-card per-txn / daily / monthly limits", () => {
    const limits = { perTxnCents: 1_000, dailyCents: 2_000, monthlyCents: 5_000 };
    expect(reason(authorize(req(1_001), ctx({ cardLimits: limits }), P, F))).toBe(
      "card_per_txn_limit",
    );
    expect(reason(authorize(req(1_000), ctx({ cardLimits: limits }), P, F))).toBe("approved");
    const today = [
      { at: T("2026-09-24T01:00:00Z"), amountCents: 1_500, kind: "card_spend" as const },
    ];
    expect(reason(authorize(req(600), ctx({ cardLimits: limits, cardSpend: today }), P, F))).toBe(
      "card_daily_limit",
    );
    expect(reason(authorize(req(500), ctx({ cardLimits: limits, cardSpend: today }), P, F))).toBe(
      "approved",
    );
    const month = [
      { at: T("2026-09-02T01:00:00Z"), amountCents: 4_800, kind: "card_spend" as const },
    ];
    expect(reason(authorize(req(300), ctx({ cardLimits: limits, cardSpend: month }), P, F))).toBe(
      "card_monthly_limit",
    );
  });

  it("enforces the household-wide monthly cap across all cards (inclusive)", () => {
    const spend = [
      { at: T("2026-09-10T00:00:00Z"), amountCents: 9_500, kind: "card_spend" as const },
    ];
    expect(
      reason(authorize(req(500), ctx({ householdCapCents: 10_000, householdSpend: spend }), P, F)),
    ).toBe("approved");
    expect(
      reason(authorize(req(501), ctx({ householdCapCents: 10_000, householdSpend: spend }), P, F)),
    ).toBe("household_monthly_cap");
    // no household (null cap) imposes no limit
    expect(reason(authorize(req(50_000), ctx({ householdCapCents: null }), P, F))).toBe("approved");
  });
});
