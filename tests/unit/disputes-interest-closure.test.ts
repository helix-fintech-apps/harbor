import {
  DEFAULT_POLICY as P, disputeTimeline, openDispute, planProvisionalCredit, provisionalCreditOverdue, resolveDispute,
  dailyAccrualMicro, accrueMonth, planMonthlyInterest, closureBlocks, planClosure, buildStatement, periodBounds,
  partyBalance, type ClosureInput, type LinkedBank,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");

describe("disputes (Reg E style)", () => {
  const base = { id: "d1", authId: "a1", accountId: "chk", amountCents: 4_000, capturedCents: 5_000, refundedCents: 0, postedAt: T("2026-09-10T00:00:00Z"), now, accountOpenedAt: T("2026-01-01T00:00:00Z"), existingOpen: false };
  it("provisional credit due in 10 business days; resolution in 45 days (90 for new accounts)", () => {
    const tl = disputeTimeline(now, T("2026-01-01T00:00:00Z"), P);
    expect(tl.provisionalCreditDueAt.toISOString().slice(0, 10)).toBe("2026-10-08"); // Thu + 10 business days, skipping two weekends
    expect(tl.resolutionDueAt.toISOString().slice(0, 10)).toBe("2026-11-08");
    expect(disputeTimeline(now, T("2026-09-10T00:00:00Z"), P).resolutionDueAt.toISOString().slice(0, 10)).toBe("2026-12-23");
  });
  it("validates window, amount and duplicates", () => {
    expect(() => openDispute({ ...base, amountCents: 5_001 }, P)).toThrow(/exceeds/);
    expect(() => openDispute({ ...base, refundedCents: 2_000 }, P)).toThrow(/exceeds/);
    expect(() => openDispute({ ...base, existingOpen: true }, P)).toThrow();
    expect(() => openDispute({ ...base, postedAt: T("2026-07-01T00:00:00Z") }, P)).toThrow(/window/);
    expect(openDispute({ ...base, postedAt: T("2026-07-26T18:00:00Z") }, P).status).toBe("open"); // exactly 60 days
  });
  it("provisional credit then won keeps the credit; lost reverses it", () => {
    const d = openDispute(base, P);
    const pc = planProvisionalCredit(d);
    expect(partyBalance(pc.ledger.lines, "customer_deposits", "chk")).toBe(4_000);
    expect(() => planProvisionalCredit(pc.dispute)).toThrow();
    const won = resolveDispute(pc.dispute, "won");
    expect(won.dispute.status).toBe("won");
    expect(partyBalance(won.ledger!.lines, "customer_deposits", "chk")).toBe(0);
    const lost = resolveDispute(pc.dispute, "lost");
    expect(partyBalance(lost.ledger!.lines, "customer_deposits", "chk")).toBe(-4_000);
    expect(() => resolveDispute(lost.dispute, "won")).toThrow();
  });
  it("won without provisional credit credits the customer; lost without credit posts nothing", () => {
    const d = openDispute(base, P);
    expect(partyBalance(resolveDispute(d, "won").ledger!.lines, "customer_deposits", "chk")).toBe(4_000);
    expect(resolveDispute(d, "lost").ledger).toBeUndefined();
  });
  it("flags overdue provisional credit", () => {
    const d = openDispute(base, P);
    expect(provisionalCreditOverdue(d, T("2026-10-08T18:00:00Z"))).toBe(false);
    expect(provisionalCreditOverdue(d, T("2026-10-08T18:00:01Z"))).toBe(true);
    expect(provisionalCreditOverdue(planProvisionalCredit(d).dispute, T("2026-12-01T00:00:00Z"))).toBe(false);
  });
});

describe("savings interest", () => {
  it("accrues daily in integer micro-cents (floor), nothing on zero/negative balances", () => {
    // $10,000.00 at 4% APY: 1,000,000c * 400 / 10000 / 365 = 109.589041...c
    expect(dailyAccrualMicro(1_000_000, P)).toBe(109_589_041n);
    expect(dailyAccrualMicro(0, P)).toBe(0n);
    expect(dailyAccrualMicro(-500, P)).toBe(0n);
    expect(dailyAccrualMicro(1, P)).toBe(109n);
  });
  it("posts monthly with banker's rounding and carries the remainder", () => {
    const accrued = accrueMonth(Array(30).fill(1_000_000), P); // 3,287,671,230 micro
    expect(accrued).toBe(3_287_671_230n);
    const m = planMonthlyInterest({ accountId: "sav", period: "2026-09", accruedMicro: accrued, carryInMicro: 0n });
    expect(m.postCents).toBe(3_288);
    expect(m.carryMicro).toBe(-328_770n);
    expect(partyBalance(m.ledger!.lines, "customer_deposits", "sav")).toBe(3_288);
  });
  it("exact half cents round to even", () => {
    expect(planMonthlyInterest({ accountId: "s", period: "p", accruedMicro: 2_500_000n, carryInMicro: 0n }).postCents).toBe(2);
    expect(planMonthlyInterest({ accountId: "s", period: "p", accruedMicro: 3_500_000n, carryInMicro: 0n }).postCents).toBe(4);
  });
  it("sub-cent months post nothing and carry everything forward", () => {
    const m = planMonthlyInterest({ accountId: "s", period: "p", accruedMicro: 400_000n, carryInMicro: 0n });
    expect(m.postCents).toBe(0);
    expect(m.carryMicro).toBe(400_000n);
    expect(m.ledger).toBeUndefined();
    expect(planMonthlyInterest({ accountId: "s", period: "p", accruedMicro: 400_000n, carryInMicro: m.carryMicro }).postCents).toBe(1);
  });
});

describe("account closure", () => {
  const bank: LinkedBank = { id: "b", userId: "u", institution: "x", mask: "0000", ownerNames: [], nameMatched: true, linkedAt: T("2026-01-01"), status: "active" };
  const input = (over: Partial<ClosureInput> = {}): ClosureInput => ({
    kyc: "approved", accountStatus: "open", pockets: [{ accountId: "chk", postedCents: 7_000 }, { accountId: "sav", postedCents: 3_000 }],
    activeHoldsCents: 0, openDisputes: 0, linkedBank: bank,
    cards: [{ id: "c1", accountId: "chk", holderUserId: "u", kind: "virtual", status: "active", last4: "1" }, { id: "c2", accountId: "chk", holderUserId: "u", kind: "virtual", status: "canceled", last4: "2" }],
    ...over,
  });
  it("pays out all pockets and cancels live cards", () => {
    const p = planClosure(input(), "cl1");
    expect(p.payoutCents).toBe(10_000);
    expect(p.cardsToCancel).toEqual(["c1"]);
    expect(partyBalance(p.ledger!.lines, "customer_deposits", "chk")).toBe(-7_000);
  });
  it("blocks on pending holds, negative balance, open disputes, sanctions freeze, missing bank", () => {
    expect(closureBlocks(input({ activeHoldsCents: 1 }))).toContain("pending_holds");
    expect(closureBlocks(input({ pockets: [{ accountId: "chk", postedCents: -1 }, { accountId: "sav", postedCents: 5_000 }] }))).toContain("negative_balance");
    expect(closureBlocks(input({ openDisputes: 1 }))).toContain("open_disputes");
    expect(closureBlocks(input({ kyc: "frozen_legal" }))).toContain("payout_blocked");
    expect(closureBlocks(input({ linkedBank: null }))).toContain("no_linked_bank");
    expect(() => planClosure(input({ kyc: "frozen_legal" }), "x")).toThrow(/payout_blocked/);
  });
  it("zero balance closes without a bank or payout", () => {
    const p = planClosure(input({ linkedBank: null, pockets: [{ accountId: "chk", postedCents: 0 }] }), "x");
    expect(p.payoutCents).toBe(0);
    expect(p.ledger).toBeUndefined();
  });
  it("includes teen allowance pockets in the payout", () => {
    expect(planClosure(input({ allowancePockets: [{ memberId: "m1", postedCents: 500 }] }), "x").payoutCents).toBe(10_500);
  });
});

describe("statements", () => {
  it("opening + credits - debits = closing, entries within the month only", () => {
    const s = buildStatement("chk", "2026-09", [
      { at: T("2026-08-20T00:00:00Z"), kind: "ach_in", debit: 0, credit: 10_000 },
      { at: T("2026-09-01T00:00:00Z"), kind: "card_capture", debit: 2_500, credit: 0 },
      { at: T("2026-09-15T00:00:00Z"), kind: "p2p", debit: 0, credit: 1_000 },
      { at: T("2026-10-01T00:00:00Z"), kind: "ach_out_standard", debit: 5_000, credit: 0 },
    ]);
    expect(s.openingCents).toBe(10_000);
    expect(s.debitsCents).toBe(2_500);
    expect(s.creditsCents).toBe(1_000);
    expect(s.closingCents).toBe(8_500);
    expect(s.entries.map((e) => e.runningCents)).toEqual([7_500, 8_500]);
  });
  it("validates the period", () => {
    expect(periodBounds("2026-12").to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(() => periodBounds("2026-13")).toThrow();
  });
});
