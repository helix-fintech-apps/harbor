import {
  DEFAULT_POLICY as P,
  DEFAULT_FEES as F,
  // accounts / envelopes
  validateNewAccount,
  envelopeShouldClose,
  planEnvelopeSweep,
  // households
  validateHouseholdName,
  validateMonthlyCap,
  canInvite,
  acceptInvite,
  withinHouseholdCap,
  type HouseholdMember,
  // zelle
  normalizeRecipient,
  validateZelleRequest,
  planZelleFunding,
  planZelleSend,
  planZelleReturn,
  nextRunDate,
  ZelleError,
  // cards: per-card limits + cashback
  authorize,
  checkCardLimits,
  cashbackEarned,
  cashbackReversal,
  cashbackTxn,
  cashbackReversalTxn,
  partyBalance,
  trialBalance,
  type Card,
  type AuthContext,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");

describe("on-demand accounts + envelopes", () => {
  it("validates on-demand account requests", () => {
    expect(validateNewAccount({ kind: "checking", openCount: 2, maxOpen: 20 })).toEqual([]);
    expect(
      validateNewAccount({
        kind: "envelope",
        startDate: "2026-09-24",
        endDate: "2026-10-24",
        openCount: 2,
        maxOpen: 20,
      }),
    ).toEqual([]);
    expect(validateNewAccount({ kind: "envelope", openCount: 2, maxOpen: 20 })).toContain(
      "envelope accounts need a start date and end date (YYYY-MM-DD)",
    );
    expect(
      validateNewAccount({
        kind: "envelope",
        startDate: "2026-10-24",
        endDate: "2026-09-24",
        openCount: 2,
        maxOpen: 20,
      }),
    ).toContain("envelope end date must be on or after the start date");
    expect(
      validateNewAccount({ kind: "checking", startDate: "2026-09-24", openCount: 2, maxOpen: 20 }),
    ).toContain("only envelope accounts have a start and end date");
    expect(validateNewAccount({ kind: "savings", openCount: 20, maxOpen: 20 })).toContain(
      "account limit reached",
    );
  });

  it("closes an envelope only after its end date (end date inclusive)", () => {
    expect(envelopeShouldClose("2026-09-24", T("2026-09-24T23:59:59Z"))).toBe(false);
    expect(envelopeShouldClose("2026-09-24", T("2026-09-25T00:00:00Z"))).toBe(true);
  });

  it("sweeps the whole envelope balance into checking, or nothing when empty", () => {
    const t = planEnvelopeSweep({
      transferId: "s1",
      envelopeAccountId: "env",
      checkingAccountId: "chk",
      remainingCents: 4_200,
    });
    expect(t).not.toBeNull();
    expect(partyBalance(t!.lines, "customer_deposits", "env")).toBe(-4_200);
    expect(partyBalance(t!.lines, "customer_deposits", "chk")).toBe(4_200);
    expect(trialBalance(t!.lines)).toBe(0);
    expect(
      planEnvelopeSweep({
        transferId: "s2",
        envelopeAccountId: "env",
        checkingAccountId: "chk",
        remainingCents: 0,
      }),
    ).toBeNull();
    expect(() =>
      planEnvelopeSweep({
        transferId: "s3",
        envelopeAccountId: "env",
        checkingAccountId: "chk",
        remainingCents: -1,
      }),
    ).toThrow();
  });
});

describe("households", () => {
  it("validates the name and the optional monthly cap", () => {
    expect(validateHouseholdName("Rivers Family")).toEqual([]);
    expect(validateHouseholdName("  ")).toContain("household name is required");
    expect(validateMonthlyCap(null)).toEqual([]);
    expect(validateMonthlyCap(500_00)).toEqual([]);
    expect(validateMonthlyCap(-1)).toHaveLength(1);
  });

  it("guards invitations: no self, no duplicates, member limit", () => {
    expect(
      canInvite({ activeOrInvitedCount: 1, alreadyMember: false, invitingSelf: true, policy: P })
        .ok,
    ).toBe(false);
    expect(
      canInvite({ activeOrInvitedCount: 1, alreadyMember: true, invitingSelf: false, policy: P })
        .ok,
    ).toBe(false);
    expect(
      canInvite({
        activeOrInvitedCount: P.household.maxMembers,
        alreadyMember: false,
        invitingSelf: false,
        policy: P,
      }).ok,
    ).toBe(false);
    expect(
      canInvite({ activeOrInvitedCount: 1, alreadyMember: false, invitingSelf: false, policy: P })
        .ok,
    ).toBe(true);
  });

  it("accepts only a pending invitation, and only by the invited member", () => {
    const m: HouseholdMember = {
      id: "hm1",
      householdId: "h1",
      userId: "u2",
      email: "ben@harbor.test",
      status: "invited",
      isOwner: false,
    };
    expect(acceptInvite(m, "u2").status).toBe("active");
    expect(() => acceptInvite(m, "u3")).toThrow(/invited member/);
    expect(() => acceptInvite({ ...m, status: "active" }, "u2")).toThrow(/pending/);
  });

  it("household cap is inclusive and null means no cap", () => {
    expect(withinHouseholdCap(null, 999_999, 1_000_000)).toBe(true);
    expect(withinHouseholdCap(10_000, 7_000, 3_000)).toBe(true); // exactly the cap
    expect(withinHouseholdCap(10_000, 7_000, 3_001)).toBe(false); // one cent over
  });
});

describe("Zelle bill pay", () => {
  it("normalizes recipients (email / phone) and rejects junk", () => {
    expect(normalizeRecipient("Bill@Example.COM")).toBe("bill@example.com");
    expect(normalizeRecipient("(415) 555-0100")).toBe("4155550100");
    expect(normalizeRecipient("nope")).toBeNull();
  });

  it("validates amount, recipient and frequency", () => {
    expect(() =>
      validateZelleRequest({ amountCents: 0, recipient: "a@b.co", frequency: "once" }),
    ).toThrow(ZelleError);
    expect(() =>
      validateZelleRequest({ amountCents: 100, recipient: "nope", frequency: "once" }),
    ).toThrow(/invalid_recipient/);
    expect(() =>
      // @ts-expect-error exercising an invalid frequency
      validateZelleRequest({ amountCents: 100, recipient: "a@b.co", frequency: "daily" }),
    ).toThrow(/invalid_frequency/);
    expect(() =>
      validateZelleRequest({ amountCents: 100, recipient: "a@b.co", frequency: "weekly" }),
    ).not.toThrow();
  });

  it("funds from the source first, then the shortfall from the most-flush other accounts", () => {
    const legs = planZelleFunding({
      amountCents: 5_000,
      source: { accountId: "chk", availableCents: 500 },
      others: [
        { accountId: "sav", availableCents: 4_000 },
        { accountId: "env", availableCents: 10_000 },
      ],
    });
    // 500 from source, then the biggest other (env) covers the rest.
    expect(legs).toEqual([
      { accountId: "chk", cents: 500 },
      { accountId: "env", cents: 4_500 },
    ]);
  });

  it("uses the source alone when it can cover the send", () => {
    const legs = planZelleFunding({
      amountCents: 1_000,
      source: { accountId: "chk", availableCents: 5_000 },
      others: [{ accountId: "sav", availableCents: 9_999 }],
    });
    expect(legs).toEqual([{ accountId: "chk", cents: 1_000 }]);
  });

  it("throws insufficient_funds when the accounts together fall short", () => {
    let code = "";
    try {
      planZelleFunding({
        amountCents: 5_000,
        source: { accountId: "chk", availableCents: 500 },
        others: [{ accountId: "sav", availableCents: 1_000 }],
      });
    } catch (e) {
      code = (e as ZelleError).code;
    }
    expect(code).toBe("insufficient_funds");
  });

  it("builds a balanced send ledger and a reversing return ledger", () => {
    const { funding, ledger } = planZelleSend({
      paymentId: "z1",
      amountCents: 5_000,
      source: { accountId: "chk", availableCents: 500 },
      others: [{ accountId: "sav", availableCents: 9_000 }],
    });
    expect(partyBalance(ledger.lines, "customer_deposits", "chk")).toBe(-500);
    expect(partyBalance(ledger.lines, "customer_deposits", "sav")).toBe(-4_500);
    expect(trialBalance(ledger.lines)).toBe(0);
    const ret = planZelleReturn({ paymentId: "z1", amountCents: 5_000, funding });
    expect(partyBalance(ret.lines, "customer_deposits", "chk")).toBe(500);
    expect(partyBalance(ret.lines, "customer_deposits", "sav")).toBe(4_500);
    expect(trialBalance(ret.lines)).toBe(0);
  });

  it("advances recurring dates (weekly / monthly, month length clamped)", () => {
    expect(nextRunDate(T("2026-01-31T12:00:00Z"), "weekly").toISOString()).toBe(
      "2026-02-07T12:00:00.000Z",
    );
    expect(nextRunDate(T("2026-01-31T12:00:00Z"), "monthly").toISOString()).toBe(
      "2026-02-28T12:00:00.000Z", // clamped from the 31st
    );
    expect(nextRunDate(T("2026-09-15T00:00:00Z"), "monthly").toISOString()).toBe(
      "2026-10-15T00:00:00.000Z",
    );
  });
});

describe("per-card limits", () => {
  const limits = { perTxnCents: 1_000, dailyCents: 2_000, monthlyCents: 5_000 };
  it("enforces per-transaction, daily and monthly card limits (inclusive)", () => {
    expect(checkCardLimits(limits, 1_000, [], now).ok).toBe(true);
    expect(checkCardLimits(limits, 1_001, [], now).ok).toBe(false);
    const today = [
      { at: T("2026-09-24T01:00:00Z"), amountCents: 1_500, kind: "card_spend" as const },
    ];
    expect(checkCardLimits(limits, 500, today, now).ok).toBe(true); // 1_500 + 500 = 2_000
    const overDay = checkCardLimits(limits, 501, today, now);
    expect(overDay.ok === false && overDay.reason).toBe("card_daily_limit");
    const month = [
      { at: T("2026-09-02T01:00:00Z"), amountCents: 4_500, kind: "card_spend" as const },
    ];
    const overMonth = checkCardLimits(limits, 600, month, now);
    expect(overMonth.ok === false && overMonth.reason).toBe("card_monthly_limit");
  });
});

describe("authorize with card limits and the household cap", () => {
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
  const req = (amountCents: number) => ({
    amountCents,
    mcc: "5411",
    merchant: "Shop",
    foreign: false,
  });
  const reason = (d: ReturnType<typeof authorize>) => (d.approved ? "approved" : d.reason);

  it("declines when the per-card limit is exceeded", () => {
    const limits = { perTxnCents: 1_000, dailyCents: 2_000, monthlyCents: 5_000 };
    expect(reason(authorize(req(1_000), ctx({ cardLimits: limits, cardSpend: [] }), P, F))).toBe(
      "approved",
    );
    expect(reason(authorize(req(1_001), ctx({ cardLimits: limits, cardSpend: [] }), P, F))).toBe(
      "card_per_txn_limit",
    );
  });

  it("declines when the household monthly cap would be exceeded (inclusive)", () => {
    expect(
      reason(
        authorize(req(3_000), ctx({ householdCapCents: 10_000, householdSpendCents: 7_000 }), P, F),
      ),
    ).toBe("approved"); // 7_000 + 3_000 = 10_000
    expect(
      reason(
        authorize(req(3_001), ctx({ householdCapCents: 10_000, householdSpendCents: 7_000 }), P, F),
      ),
    ).toBe("household_monthly_cap");
    // A null cap never blocks (within the usual tier limits).
    expect(
      reason(
        authorize(req(5_000), ctx({ householdCapCents: null, householdSpendCents: 999_999 }), P, F),
      ),
    ).toBe("approved");
  });
});

describe("cashback (1% of settled debit spend)", () => {
  it("earns 1% on capture, half-up", () => {
    expect(cashbackEarned(10_000, P)).toBe(100);
    expect(cashbackEarned(5_900, P)).toBe(59);
    expect(cashbackEarned(50, P)).toBe(1); // 0.5 -> 1
    expect(cashbackEarned(0, P)).toBe(0);
  });

  it("reverses proportionally and never more than was earned", () => {
    // Full refund reverses exactly the earned cashback.
    expect(cashbackReversal(0, 10_000, P)).toBe(100);
    // Two partial refunds of a 100c purchase (earned 1c) never reverse more than 1c total.
    const first = cashbackReversal(0, 50, P);
    const second = cashbackReversal(50, 50, P);
    expect(first + second).toBe(cashbackEarned(100, P));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
  });

  it("builds balanced cashback ledgers to and from the card's account", () => {
    const credit = cashbackTxn("chk", 100, "auth1");
    expect(partyBalance(credit.lines, "customer_deposits", "chk")).toBe(100);
    expect(trialBalance(credit.lines)).toBe(0);
    const reversal = cashbackReversalTxn("chk", 100, "re1");
    expect(partyBalance(reversal.lines, "customer_deposits", "chk")).toBe(-100);
    expect(trialBalance(reversal.lines)).toBe(0);
  });
});
