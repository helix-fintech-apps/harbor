import {
  DEFAULT_POLICY as P,
  DEFAULT_FEES as F,
  ownerNameMatches,
  inCoolingOff,
  planAchPull,
  planAchReturn,
  canSettle,
  validateDirectDepositForm,
  instantFee,
  transferFee,
  planAchPush,
  planP2P,
  planPocketMove,
  TransferError,
  partyBalance,
  trialBalance,
  type LinkedBank,
  type SenderCtx,
  type Line,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z"); // Thursday
const bank = (over: Partial<LinkedBank> = {}): LinkedBank => ({
  id: "b1",
  userId: "u1",
  institution: "First Platypus Bank",
  mask: "0000",
  ownerNames: ["Ava Harbor"],
  nameMatched: true,
  linkedAt: T("2026-09-01T00:00:00Z"),
  status: "active",
  ...over,
});
const sender = (over: Partial<SenderCtx> = {}): SenderCtx => ({
  kyc: "approved",
  tier: "tier1",
  accountId: "chk",
  accountStatus: "open",
  availableCents: 50_000,
  usage: [],
  ...over,
});
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof TransferError ? e.code : (e as Error).message;
  }
};

describe("owner name match", () => {
  it("matches ignoring case, accents, middle names, suffixes and ordering", () => {
    expect(ownerNameMatches("Ava Harbor", ["AVA M HARBOR"])).toBe(true);
    expect(ownerNameMatches("José Álvarez", ["jose alvarez jr"])).toBe(true);
    expect(ownerNameMatches("Ava Harbor", ["Harbor, Ava"])).toBe(true);
    expect(ownerNameMatches("Ava Harbor", ["Ben Harbor", "Joint Account Ava Harbor"])).toBe(true);
  });
  it("rejects different people or single-token names", () => {
    expect(ownerNameMatches("Ava Harbor", ["Ben Harbor"])).toBe(false);
    expect(ownerNameMatches("Ava Harbor", ["Harbor"])).toBe(false);
    expect(ownerNameMatches("Ava", ["Ava"])).toBe(false);
  });
});

describe("ACH pull (money in)", () => {
  it("posts immediately but holds the full amount for 3 business days", () => {
    const plan = planAchPull(
      { transferId: "t1", accountId: "chk", amountCents: 25_000, bank: bank(), now },
      P,
    );
    expect(plan.holdCents).toBe(25_000);
    expect(plan.settleAt.toISOString()).toBe("2026-09-29T18:00:00.000Z"); // Thu + 3 bd = Tue
    expect(partyBalance(plan.ledger.lines, "customer_deposits", "chk")).toBe(25_000);
    expect(canSettle(plan.settleAt, T("2026-09-29T17:59:59Z"))).toBe(false);
    expect(canSettle(plan.settleAt, plan.settleAt)).toBe(true);
  });
  it("hold days are configurable", () => {
    const plan = planAchPull(
      { transferId: "t", accountId: "chk", amountCents: 100, bank: bank(), now },
      { ...P, achIn: { ...P.achIn, holdBusinessDays: 0 } },
    );
    expect(plan.settleAt.getTime()).toBe(now.getTime());
  });
  it("requires the owner name to match and the bank to be active", () => {
    expect(() =>
      planAchPull(
        {
          transferId: "t",
          accountId: "chk",
          amountCents: 100,
          bank: bank({ nameMatched: false }),
          now,
        },
        P,
      ),
    ).toThrow(/name/);
    expect(() =>
      planAchPull(
        {
          transferId: "t",
          accountId: "chk",
          amountCents: 100,
          bank: bank({ status: "removed" }),
          now,
        },
        P,
      ),
    ).toThrow();
    expect(() =>
      planAchPull({ transferId: "t", accountId: "chk", amountCents: 0, bank: bank(), now }, P),
    ).toThrow();
  });
  it("R01 before settlement reverses the credit and releases the hold with no negative balance", () => {
    const r = planAchReturn(
      {
        transferId: "t1",
        accountId: "chk",
        amountCents: 25_000,
        returnCode: "R01",
        status: "pending",
        postedBalanceCents: 25_000,
      },
      P,
    );
    expect(r.reverses).toBe(true);
    expect(r.releaseHold).toBe(true);
    expect(r.negativeBalanceCents).toBe(0);
    expect(partyBalance(r.ledger!.lines, "customer_deposits", "chk")).toBe(-25_000);
  });
  it("R10 after settlement claws back and can leave a negative balance", () => {
    const r = planAchReturn(
      {
        transferId: "t1",
        accountId: "chk",
        amountCents: 25_000,
        returnCode: "R10",
        status: "settled",
        postedBalanceCents: 5_000,
      },
      P,
    );
    expect(r.releaseHold).toBe(false);
    expect(r.negativeBalanceCents).toBe(20_000);
  });
  it("a transfer can only be returned once; non-reversing codes do nothing", () => {
    expect(() =>
      planAchReturn(
        {
          transferId: "t1",
          accountId: "chk",
          amountCents: 1,
          returnCode: "R01",
          status: "returned",
          postedBalanceCents: 0,
        },
        P,
      ),
    ).toThrow();
    expect(
      planAchReturn(
        {
          transferId: "t1",
          accountId: "chk",
          amountCents: 1,
          returnCode: "R99",
          status: "settled",
          postedBalanceCents: 0,
        },
        P,
      ).reverses,
    ).toBe(false);
  });
  it("validates the direct deposit switch form", () => {
    const ok = {
      employerName: "Acme",
      allocation: { kind: "percent" as const, percent: 100 },
      accountNumber: "880012345678",
      routingNumber: "091000019",
      accountType: "checking" as const,
      signatureName: "Ava Harbor",
    };
    expect(validateDirectDepositForm(ok, "Ava Harbor")).toEqual([]);
    expect(
      validateDirectDepositForm(
        { ...ok, allocation: { kind: "percent", percent: 101 } },
        "Ava Harbor",
      ),
    ).toContain("percent must be 1-100");
    expect(validateDirectDepositForm({ ...ok, signatureName: "Ben" }, "Ava Harbor")).toContain(
      "signature must match legal name",
    );
  });
});

describe("fees", () => {
  it("instant fee = 1.5% clamped to [$0.25, $15.00]; standard is free", () => {
    expect(instantFee(10_000, F)).toBe(150);
    expect(instantFee(1_000, F)).toBe(25); // 15c -> min 25c
    expect(instantFee(1_666, F)).toBe(25); // 24.99 -> 25
    expect(instantFee(100_000, F)).toBe(1_500); // exactly the max
    expect(instantFee(200_000, F)).toBe(1_500); // capped
    expect(transferFee(200_000, "standard", F)).toBe(0);
  });
});

describe("ACH push (money out)", () => {
  const base = { transferId: "o1", bank: bank(), now };
  it("standard push debits amount only; instant adds the fee to revenue", () => {
    const s = planAchPush(
      { ...base, amountCents: 10_000, speed: "standard", sender: sender() },
      P,
      F,
    );
    expect(s.feeCents).toBe(0);
    const i = planAchPush(
      { ...base, amountCents: 10_000, speed: "instant", sender: sender() },
      P,
      F,
    );
    expect(i.totalDebitCents).toBe(10_150);
    expect(i.ledger.lines.find((l) => l.account === "fee_revenue")!.credit).toBe(150);
  });
  it("amount + fee must fit in available balance (boundary)", () => {
    expect(
      code(() =>
        planAchPush(
          {
            ...base,
            amountCents: 10_000,
            speed: "instant",
            sender: sender({ availableCents: 10_150 }),
          },
          P,
          F,
        ),
      ),
    ).toBe("ok");
    expect(
      code(() =>
        planAchPush(
          {
            ...base,
            amountCents: 10_000,
            speed: "instant",
            sender: sender({ availableCents: 10_149 }),
          },
          P,
          F,
        ),
      ),
    ).toBe("insufficient_funds");
  });
  it("blocks withdrawals during the 72h cooling-off after linking", () => {
    const fresh = bank({ linkedAt: T("2026-09-22T18:00:00Z") });
    expect(inCoolingOff(fresh, now, P)).toBe(true);
    expect(
      code(() =>
        planAchPush(
          { ...base, bank: fresh, amountCents: 100, speed: "standard", sender: sender() },
          P,
          F,
        ),
      ),
    ).toBe("cooling_off");
    expect(inCoolingOff(fresh, T("2026-09-25T18:00:00Z"), P)).toBe(false); // exactly 72h
  });
  it("rejects when KYC not approved, frozen legally, account frozen, name mismatch, or over limit", () => {
    expect(
      code(() =>
        planAchPush(
          { ...base, amountCents: 100, speed: "standard", sender: sender({ kyc: "pending" }) },
          P,
          F,
        ),
      ),
    ).toBe("kyc_not_approved");
    expect(
      code(() =>
        planAchPush(
          { ...base, amountCents: 100, speed: "standard", sender: sender({ kyc: "frozen_legal" }) },
          P,
          F,
        ),
      ),
    ).toBe("payout_blocked");
    expect(
      code(() =>
        planAchPush(
          {
            ...base,
            amountCents: 100,
            speed: "standard",
            sender: sender({ accountStatus: "frozen" }),
          },
          P,
          F,
        ),
      ),
    ).toBe("account_frozen");
    expect(
      code(() =>
        planAchPush(
          {
            ...base,
            bank: bank({ nameMatched: false }),
            amountCents: 100,
            speed: "standard",
            sender: sender(),
          },
          P,
          F,
        ),
      ),
    ).toBe("bank_name_mismatch");
    expect(
      code(() =>
        planAchPush(
          {
            ...base,
            amountCents: 100_001,
            speed: "standard",
            sender: sender({ availableCents: 1_000_000 }),
          },
          P,
          F,
        ),
      ),
    ).toBe("daily_limit");
    expect(
      code(() =>
        planAchPush({ ...base, amountCents: 1.5, speed: "standard", sender: sender() }, P, F),
      ),
    ).toBe("invalid_amount");
  });
});

describe("P2P", () => {
  const recipient = {
    userId: "u2",
    kyc: "approved" as const,
    accountId: "chk2",
    accountStatus: "open",
  };
  const base = { transferId: "p1", senderUserId: "u1", sender: sender(), recipient, now };
  it("moves money between customers and balances", () => {
    const r = planP2P(
      { ...base, amountCents: 2_500, knownPayee: true, stepUpVerified: false },
      P,
      F,
    );
    const lines: Line[] = r.ledger.lines;
    expect(partyBalance(lines, "customer_deposits", "chk")).toBe(-2_500);
    expect(partyBalance(lines, "customer_deposits", "chk2")).toBe(2_500);
    expect(trialBalance(lines)).toBe(0);
  });
  it("requires step-up for a new payee", () => {
    expect(
      code(() =>
        planP2P({ ...base, amountCents: 2_500, knownPayee: false, stepUpVerified: false }, P, F),
      ),
    ).toBe("step_up_required");
    expect(
      planP2P({ ...base, amountCents: 2_500, knownPayee: false, stepUpVerified: true }, P, F)
        .newPayee,
    ).toBe(true);
  });
  it("rejects self-transfers, unverified recipients, tiny amounts, and limit breaches", () => {
    expect(
      code(() =>
        planP2P(
          {
            ...base,
            recipient: { ...recipient, userId: "u1" },
            amountCents: 500,
            knownPayee: true,
            stepUpVerified: true,
          },
          P,
          F,
        ),
      ),
    ).toBe("self_transfer");
    expect(
      code(() =>
        planP2P(
          {
            ...base,
            recipient: { ...recipient, kyc: "pending" },
            amountCents: 500,
            knownPayee: true,
            stepUpVerified: true,
          },
          P,
          F,
        ),
      ),
    ).toBe("recipient_unavailable");
    expect(
      code(() =>
        planP2P(
          { ...base, recipient: null, amountCents: 500, knownPayee: true, stepUpVerified: true },
          P,
          F,
        ),
      ),
    ).toBe("recipient_unavailable");
    expect(
      code(() =>
        planP2P({ ...base, amountCents: 99, knownPayee: true, stepUpVerified: true }, P, F),
      ),
    ).toBe("below_minimum");
    const used = [
      { at: T("2026-09-24T01:00:00Z"), amountCents: 99_000, kind: "transfer_out" as const },
    ];
    expect(
      code(() =>
        planP2P(
          {
            ...base,
            sender: sender({ usage: used }),
            amountCents: 1_001,
            knownPayee: true,
            stepUpVerified: true,
          },
          P,
          F,
        ),
      ),
    ).toBe("daily_limit");
  });
});

describe("pocket moves", () => {
  it("moves checking to savings within available", () => {
    const t = planPocketMove({
      transferId: "m",
      fromAccountId: "chk",
      toAccountId: "sav",
      amountCents: 1_000,
      availableCents: 1_000,
      kyc: "approved",
    });
    expect(partyBalance(t.lines, "customer_deposits", "sav")).toBe(1_000);
    expect(
      code(() =>
        planPocketMove({
          transferId: "m",
          fromAccountId: "chk",
          toAccountId: "sav",
          amountCents: 1_001,
          availableCents: 1_000,
          kyc: "approved",
        }),
      ),
    ).toBe("insufficient_funds");
  });
});
