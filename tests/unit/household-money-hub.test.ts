import {
  DEFAULT_POLICY as P,
  DEFAULT_FEES as F,
  // accounts / envelopes
  validateOpenAccount,
  envelopeExpired,
  planEnvelopeSweep,
  // cards: cashback + limits + household cap
  cashbackFor,
  planCashback,
  planCashbackReversal,
  validateCardLimits,
  checkCardLimits,
  authorize,
  // zelle
  planZelleSend,
  planZelleReturn,
  ZelleError,
  isValidFrequency,
  nextRunAt,
  scheduleDue,
  // household
  validateHouseholdName,
  validateMonthlyCap,
  validateInvite,
  acceptInvite,
  // ledger helpers
  partyBalance,
  trialBalance,
  type Card,
  type AuthContext,
} from "../../supabase/functions/_shared/domain/index.ts";
import { isValidZelleHandle } from "../../supabase/functions/_shared/providers/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");

describe("on-demand accounts", () => {
  it("validates envelope dates and rejects dates on non-envelopes", () => {
    expect(validateOpenAccount({ kind: "checking" })).toEqual([]);
    expect(validateOpenAccount({ kind: "savings", nickname: "Rainy day" })).toEqual([]);
    expect(
      validateOpenAccount({ kind: "envelope", startDate: "2026-10-01", endDate: "2026-12-31" }),
    ).toEqual([]);
    expect(validateOpenAccount({ kind: "envelope", startDate: "2026-10-01" })).toContain(
      "envelope needs a valid end date",
    );
    expect(
      validateOpenAccount({ kind: "envelope", startDate: "2026-12-31", endDate: "2026-10-01" }),
    ).toContain("envelope end date must be after the start date");
    expect(validateOpenAccount({ kind: "checking", startDate: "2026-10-01" })).toContain(
      "only envelope accounts have a start and end date",
    );
  });

  it("an envelope expires at end-of-day UTC on its end date (inclusive)", () => {
    expect(envelopeExpired("2026-09-30", T("2026-09-30T12:00:00Z"))).toBe(false);
    expect(envelopeExpired("2026-09-30", T("2026-10-01T00:00:00Z"))).toBe(true);
    expect(envelopeExpired(null, now)).toBe(false);
  });

  it("sweeps a positive envelope balance into checking; zero sweeps nothing; negative is refused", () => {
    const s = planEnvelopeSweep({
      sweepId: "s1",
      envelopeAccountId: "env",
      checkingAccountId: "chk",
      postedCents: 4_200,
    });
    expect(s.payoutCents).toBe(4_200);
    expect(partyBalance(s.ledger!.lines, "customer_deposits", "env")).toBe(-4_200);
    expect(partyBalance(s.ledger!.lines, "customer_deposits", "chk")).toBe(4_200);
    expect(trialBalance(s.ledger!.lines)).toBe(0);
    expect(
      planEnvelopeSweep({
        sweepId: "s",
        envelopeAccountId: "env",
        checkingAccountId: "chk",
        postedCents: 0,
      }).ledger,
    ).toBeUndefined();
    expect(() =>
      planEnvelopeSweep({
        sweepId: "s",
        envelopeAccountId: "env",
        checkingAccountId: "chk",
        postedCents: -1,
      }),
    ).toThrow();
  });
});

describe("cashback", () => {
  it("is 1% of captured spend, half-up rounded", () => {
    expect(cashbackFor(5_900, P)).toBe(59);
    expect(cashbackFor(3_000, P)).toBe(30);
    expect(cashbackFor(50, P)).toBe(1); // 0.5c -> 1c
    expect(cashbackFor(49, P)).toBe(0); // 0.49c -> 0c
    expect(cashbackFor(0, P)).toBe(0);
  });

  it("is credited to the card's account (not the funding pocket)", () => {
    const cb = planCashback({ cashbackId: "cb1", cardAccountId: "chk", capturedCents: 5_900 }, P);
    expect(cb.cashbackCents).toBe(59);
    expect(partyBalance(cb.ledger!.lines, "customer_deposits", "chk")).toBe(59);
    expect(trialBalance(cb.ledger!.lines)).toBe(0);
    expect(
      planCashback({ cashbackId: "cb", cardAccountId: "chk", capturedCents: 10 }, P).ledger,
    ).toBeUndefined();
  });

  it("reverses proportionally on refund, never more than earned; a full refund reverses it all", () => {
    // Earned 59 on a 5,900 purchase. A full refund reverses all 59.
    const full = planCashbackReversal(
      {
        reversalId: "r",
        cardAccountId: "chk",
        refundAmountCents: 5_900,
        cashbackEarnedCents: 59,
        cashbackReversedCents: 0,
      },
      P,
    );
    expect(full.reverseCents).toBe(59);
    expect(partyBalance(full.ledger!.lines, "customer_deposits", "chk")).toBe(-59);
    // A $9 partial refund reverses 9c.
    expect(
      planCashbackReversal(
        {
          reversalId: "r",
          cardAccountId: "chk",
          refundAmountCents: 900,
          cashbackEarnedCents: 59,
          cashbackReversedCents: 0,
        },
        P,
      ).reverseCents,
    ).toBe(9);
    // Never reverse more than what is still standing.
    expect(
      planCashbackReversal(
        {
          reversalId: "r",
          cardAccountId: "chk",
          refundAmountCents: 5_900,
          cashbackEarnedCents: 59,
          cashbackReversedCents: 55,
        },
        P,
      ).reverseCents,
    ).toBe(4);
  });
});

describe("per-card limits", () => {
  const card = (): Card => ({
    id: "c1",
    accountId: "chk",
    holderUserId: "u1",
    kind: "virtual",
    status: "active",
    last4: "4242",
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
  const limits = { perTxnCents: 5_000, dailyCents: 10_000, monthlyCents: 40_000 };

  it("validates limit ordering", () => {
    expect(
      validateCardLimits({ perTxnCents: 200, dailyCents: 100, monthlyCents: 1_000 }),
    ).toContain("perTxn cannot exceed daily");
    expect(validateCardLimits(limits)).toEqual([]);
  });

  it("enforces per-transaction, daily and monthly card limits (inclusive)", () => {
    expect(checkCardLimits(limits, 5_000, [], now).ok).toBe(true);
    expect(checkCardLimits(limits, 5_001, [], now)).toEqual({
      ok: false,
      reason: "card_per_txn_limit",
    });
    const today = [
      { at: T("2026-09-24T02:00:00Z"), amountCents: 6_000, kind: "card_spend" as const },
    ];
    expect(checkCardLimits(limits, 4_001, today, now)).toEqual({
      ok: false,
      reason: "card_daily_limit",
    });
    const month = [
      { at: T("2026-09-02T02:00:00Z"), amountCents: 38_000, kind: "card_spend" as const },
    ];
    expect(checkCardLimits(limits, 2_001, month, now)).toEqual({
      ok: false,
      reason: "card_monthly_limit",
    });
  });

  it("authorize honours card limits when set", () => {
    expect(reason(authorize(req(5_000), ctx({ cardLimits: limits, cardSpend: [] }), P, F))).toBe(
      "approved",
    );
    expect(reason(authorize(req(5_001), ctx({ cardLimits: limits, cardSpend: [] }), P, F))).toBe(
      "card_per_txn_limit",
    );
  });
});

describe("household monthly cap", () => {
  const card = (): Card => ({
    id: "c1",
    accountId: "chk",
    holderUserId: "u1",
    kind: "virtual",
    status: "active",
    last4: "4242",
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

  it("declines a purchase that would push household spend over the cap (inclusive boundary)", () => {
    expect(
      reason(
        authorize(
          req(20_000),
          ctx({ householdCapCents: 100_000, householdMonthCents: 80_000 }),
          P,
          F,
        ),
      ),
    ).toBe("approved"); // exactly at the cap
    expect(
      reason(
        authorize(
          req(20_001),
          ctx({ householdCapCents: 100_000, householdMonthCents: 80_000 }),
          P,
          F,
        ),
      ),
    ).toBe("household_cap");
    // no cap set -> no household check
    expect(reason(authorize(req(1_000), ctx(), P, F))).toBe("approved");
  });
});

describe("zelle send", () => {
  const src = (availableCents: number) => ({ accountId: "chk", availableCents });
  it("sends from a single source when it has the funds; no fee", () => {
    const plan = planZelleSend(
      { transferId: "z1", amountCents: 3_000, source: src(10_000), others: [] },
      P,
    );
    expect(plan.feeCents).toBe(0);
    expect(plan.pulledCents).toBe(0);
    expect(plan.contributions).toEqual([{ accountId: "chk", amountCents: 3_000 }]);
    expect(partyBalance(plan.ledger.lines, "customer_deposits", "chk")).toBe(-3_000);
    expect(plan.ledger.lines.find((l) => l.account === "zelle_clearing")!.credit).toBe(3_000);
    expect(trialBalance(plan.ledger.lines)).toBe(0);
  });

  it("pulls the shortfall from other accounts in order", () => {
    const plan = planZelleSend(
      {
        transferId: "z2",
        amountCents: 12_000,
        source: src(5_000),
        others: [
          { accountId: "sav", availableCents: 6_000 },
          { accountId: "chk2", availableCents: 10_000 },
        ],
      },
      P,
    );
    expect(plan.pulledCents).toBe(7_000);
    expect(plan.contributions).toEqual([
      { accountId: "chk", amountCents: 5_000 },
      { accountId: "sav", amountCents: 6_000 },
      { accountId: "chk2", amountCents: 1_000 },
    ]);
    expect(partyBalance(plan.ledger.lines, "customer_deposits", "chk2")).toBe(-1_000);
    expect(trialBalance(plan.ledger.lines)).toBe(0);
  });

  it("rejects amounts below the minimum, invalid amounts, and totals that can't be covered", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return "ok";
      } catch (e) {
        return e instanceof ZelleError ? e.code : (e as Error).message;
      }
    };
    expect(
      code(() =>
        planZelleSend({ transferId: "z", amountCents: 50, source: src(10_000), others: [] }, P),
      ),
    ).toBe("below_minimum");
    expect(
      code(() =>
        planZelleSend({ transferId: "z", amountCents: 0, source: src(10_000), others: [] }, P),
      ),
    ).toBe("invalid_amount");
    expect(
      code(() =>
        planZelleSend(
          {
            transferId: "z",
            amountCents: 20_000,
            source: src(5_000),
            others: [{ accountId: "s", availableCents: 5_000 }],
          },
          P,
        ),
      ),
    ).toBe("insufficient_funds");
  });

  it("plans a return that credits the source account", () => {
    const r = planZelleReturn({
      returnId: "r1",
      destinationAccountId: "chk",
      amountCents: 3_000,
      returnCode: "R01",
    });
    expect(partyBalance(r.ledger.lines, "customer_deposits", "chk")).toBe(3_000);
    expect(trialBalance(r.ledger.lines)).toBe(0);
  });
});

describe("zelle scheduling + handles", () => {
  it("validates frequency and computes the next run date", () => {
    expect(isValidFrequency("weekly")).toBe(true);
    expect(isValidFrequency("daily")).toBe(false);
    expect(nextRunAt("once", now)).toBeNull();
    expect(nextRunAt("weekly", now)!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(nextRunAt("monthly", T("2026-01-31T10:00:00Z"))!.toISOString()).toBe(
      "2026-02-28T00:00:00.000Z", // clamped to Feb
    );
    expect(scheduleDue("2026-09-24T00:00:00Z", now)).toBe(true);
    expect(scheduleDue("2026-09-25T00:00:00Z", now)).toBe(false);
  });

  it("accepts email and US phone handles, rejects junk", () => {
    expect(isValidZelleHandle("pat@example.com")).toBe(true);
    expect(isValidZelleHandle("+1 (415) 555-0100")).toBe(true);
    expect(isValidZelleHandle("5105550100")).toBe(true);
    expect(isValidZelleHandle("not-a-handle")).toBe(false);
  });
});

describe("household", () => {
  it("validates the name, cap and invites", () => {
    expect(validateHouseholdName("")).toContain("household name is required");
    expect(validateHouseholdName("Rivers Family")).toEqual([]);
    expect(validateMonthlyCap(null)).toEqual([]);
    expect(validateMonthlyCap(0)).toContain(
      "monthly cap must be a positive integer number of cents",
    );
    expect(validateMonthlyCap(500_000)).toEqual([]);
    expect(validateInvite({ name: "Sam", email: "sam@x.com" }, 0, P)).toEqual([]);
    expect(validateInvite({ name: "", email: "bad" }, 0, P)).toEqual([
      "member name is required",
      "a valid member email is required",
    ]);
    expect(
      validateInvite({ name: "Sam", email: "sam@x.com" }, P.household.maxMembers, P),
    ).toContain(`a household can have at most ${P.household.maxMembers} members`);
  });

  it("accepts an invite only from the invited state", () => {
    expect(acceptInvite("invited")).toBe("active");
    expect(() => acceptInvite("active")).toThrow();
    expect(() => acceptInvite("removed")).toThrow();
  });
});
