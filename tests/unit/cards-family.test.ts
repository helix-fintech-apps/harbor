import {
  DEFAULT_POLICY as P, DEFAULT_FEES as F, authorize, planCapture, maxCapture, isAuthExpired, planMerchantRefund,
  velocityExceeded, canIssueCard, initialCardStatus, transitionCard, canTransitionCard, cardFees,
  newFamilyMember, guardianApprove, isMccBlocked, checkFamilySpend, planAllowanceTopUp, validateLimits, partyBalance,
  type Card, type AuthContext, type Authorization, type FamilyMember,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");
const card = (over: Partial<Card> = {}): Card => ({ id: "c1", accountId: "chk", holderUserId: "u1", kind: "virtual", status: "active", last4: "4242", ...over });
const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  card: card(), ownerKyc: "approved", ownerTier: "tier1", ownerUsage: [], availableCents: 10_000, recentAuthAttempts: [], now, ...over,
});
const req = (amountCents: number, mcc = "5411", foreign = false) => ({ amountCents, mcc, merchant: "Shop", foreign });
const reason = (d: ReturnType<typeof authorize>) => (d.approved ? "approved" : d.reason);

describe("card lifecycle", () => {
  it("virtual cards are active instantly, physical cards are requested", () => {
    expect(initialCardStatus("virtual")).toBe("active");
    expect(initialCardStatus("physical")).toBe("requested");
  });
  it("freeze/unfreeze/replace/cancel transitions", () => {
    const f = transitionCard(card(), "frozen");
    expect(transitionCard(f, "active").status).toBe("active");
    expect(canTransitionCard("canceled", "active")).toBe(false);
    expect(canTransitionCard("replaced", "active")).toBe(false);
    expect(() => transitionCard(card({ status: "canceled" }), "frozen")).toThrow();
  });
  it("issuance requires KYC and caps virtual cards / one physical", () => {
    expect(canIssueCard("pending", "virtual", [], P).reason).toBe("kyc_not_approved");
    const three = [1, 2, 3].map((i) => card({ id: `c${i}` }));
    expect(canIssueCard("approved", "virtual", three, P).reason).toBe("too_many_virtual_cards");
    expect(canIssueCard("approved", "virtual", [...three.slice(0, 2), card({ id: "x", status: "canceled" })], P).ok).toBe(true);
    expect(canIssueCard("approved", "physical", [card({ kind: "physical", status: "requested" })], P).reason).toBe("physical_card_exists");
  });
});

describe("authorizations", () => {
  it("approves within available and places a hold that expires in 7 days", () => {
    const d = authorize(req(2_500), ctx(), P, F);
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.holdCents).toBe(2_500);
      expect(d.expiresAt.toISOString()).toBe("2026-10-01T18:00:00.000Z");
    }
  });
  it("available balance boundary: exact amount ok, one cent over declined", () => {
    expect(reason(authorize(req(10_000), ctx(), P, F))).toBe("approved");
    expect(reason(authorize(req(10_001), ctx(), P, F))).toBe("insufficient_funds");
  });
  it("declines frozen, canceled, replaced, not-yet-activated cards and unapproved owners", () => {
    expect(reason(authorize(req(100), ctx({ card: card({ status: "frozen" }) }), P, F))).toBe("card_frozen");
    expect(reason(authorize(req(100), ctx({ card: card({ status: "canceled" }) }), P, F))).toBe("card_canceled");
    expect(reason(authorize(req(100), ctx({ card: card({ status: "replaced" }) }), P, F))).toBe("card_canceled");
    expect(reason(authorize(req(100), ctx({ card: card({ status: "requested" }) }), P, F))).toBe("card_inactive");
    expect(reason(authorize(req(100), ctx({ ownerKyc: "suspended" }), P, F))).toBe("kyc_not_approved");
    expect(reason(authorize(req(0), ctx(), P, F))).toBe("invalid_amount");
  });
  it("foreign transactions add 3% to the hold and must fit the balance", () => {
    const d = authorize(req(10_000, "5411", true), ctx({ availableCents: 10_300 }), P, F);
    expect(d.approved && d.feeCents).toBe(300);
    expect(reason(authorize(req(10_000, "5411", true), ctx({ availableCents: 10_299 }), P, F))).toBe("insufficient_funds");
    expect(cardFees({ ...req(2_000, "6011"), atmOutOfNetwork: true }, F)).toBe(250);
  });
  it("velocity: 5 auths in 10 minutes blocks the 6th", () => {
    const five = [1, 2, 3, 4, 5].map((m) => new Date(now.getTime() - m * 60_000));
    expect(velocityExceeded(five, now, P)).toBe(true);
    expect(reason(authorize(req(100), ctx({ recentAuthAttempts: five }), P, F))).toBe("velocity");
    const old = [1, 2, 3, 4, 10].map((m) => new Date(now.getTime() - m * 60_000));
    expect(velocityExceeded(old, now, P)).toBe(false);
  });
  it("tier card-spend limit applies across the owner's cards", () => {
    const used = [{ at: T("2026-09-24T01:00:00Z"), amountCents: 199_000, kind: "card_spend" as const }];
    expect(reason(authorize(req(1_001), ctx({ ownerUsage: used, availableCents: 1e6 }), P, F))).toBe("daily_limit");
    expect(reason(authorize(req(1_000), ctx({ ownerUsage: used, availableCents: 1e6 }), P, F))).toBe("approved");
  });
});

describe("capture / expiry / refunds", () => {
  const auth = (over: Partial<Authorization> = {}): Authorization => ({
    id: "a1", cardId: "c1", amountCents: 5_000, feeCents: 0, mcc: "5411", foreign: false, status: "authorized",
    expiresAt: T("2026-10-01T18:00:00Z"), funding: { account: "customer_deposits", party: "chk" }, ...over,
  });
  it("partial capture releases the remainder", () => {
    const c = planCapture(auth(), 4_200, now, P, F);
    expect(c.capturedCents).toBe(4_200);
    expect(c.releasedCents).toBe(800);
    expect(partyBalance(c.ledger.lines, "customer_deposits", "chk")).toBe(-4_200);
  });
  it("restaurant over-capture (tip) allowed up to 20%, not beyond", () => {
    expect(maxCapture(5_000, "5812", P)).toBe(6_000);
    expect(planCapture(auth({ mcc: "5812" }), 6_000, now, P, F).capturedCents).toBe(6_000);
    expect(() => planCapture(auth({ mcc: "5812" }), 6_001, now, P, F)).toThrow(/tolerance/);
    expect(() => planCapture(auth(), 5_001, now, P, F)).toThrow(/tolerance/);
  });
  it("fuel pre-auth can capture up to the fuel max", () => {
    expect(maxCapture(100, "5542", P)).toBe(17_500);
    expect(planCapture(auth({ mcc: "5542", amountCents: 100 }), 8_734, now, P, F).capturedCents).toBe(8_734);
    expect(() => planCapture(auth({ mcc: "5542", amountCents: 100 }), 17_501, now, P, F)).toThrow();
  });
  it("foreign fee is recomputed on the captured amount", () => {
    const c = planCapture(auth({ foreign: true, feeCents: 150 }), 4_000, now, P, F);
    expect(c.feeCents).toBe(120);
    expect(c.releasedCents).toBe(5_150 - 4_120);
  });
  it("expired auths release and cannot be captured", () => {
    expect(isAuthExpired(auth(), T("2026-10-01T17:59:59Z"))).toBe(false);
    expect(isAuthExpired(auth(), T("2026-10-01T18:00:00Z"))).toBe(true);
    expect(() => planCapture(auth(), 100, T("2026-10-02T00:00:00Z"), P, F)).toThrow(/expired/);
    expect(() => planCapture(auth({ status: "captured" }), 100, now, P, F)).toThrow();
  });
  it("merchant refunds post once and never exceed the captured amount", () => {
    const a = auth({ status: "captured" });
    const r = planMerchantRefund({ refundId: "r1", auth: a, capturedCents: 5_000, refundedSoFarCents: 0, amountCents: 2_000, postedRefundIds: [] });
    expect(r.duplicate).toBe(false);
    if (!r.duplicate) expect(partyBalance(r.ledger.lines, "customer_deposits", "chk")).toBe(2_000);
    expect(planMerchantRefund({ refundId: "r1", auth: a, capturedCents: 5_000, refundedSoFarCents: 2_000, amountCents: 2_000, postedRefundIds: ["r1"] }).duplicate).toBe(true);
    expect(() => planMerchantRefund({ refundId: "r2", auth: a, capturedCents: 5_000, refundedSoFarCents: 2_000, amountCents: 3_001, postedRefundIds: ["r1"] })).toThrow();
    expect(() => planMerchantRefund({ refundId: "r3", auth: auth(), capturedCents: 0, refundedSoFarCents: 0, amountCents: 1, postedRefundIds: [] })).toThrow();
  });
});

describe("family cards", () => {
  const limits = { perTxnCents: 5_000, dailyCents: 10_000, monthlyCents: 50_000 };
  const teen = (): FamilyMember => ({ ...newFamilyMember({ id: "m1", ownerUserId: "u1", name: "Tia", kind: "teen", limits, existingCount: 0 }, P), status: "active" });
  const spouse = (): FamilyMember => newFamilyMember({ id: "m2", ownerUserId: "u1", name: "Sam", kind: "spouse", limits, existingCount: 0 }, P);
  it("teen requires guardian approval by the owner only; spouse is active immediately", () => {
    const t = newFamilyMember({ id: "m1", ownerUserId: "u1", name: "Tia", kind: "teen", limits, existingCount: 0 }, P);
    expect(t.status).toBe("pending_guardian_approval");
    expect(() => guardianApprove(t, "someone-else")).toThrow(/guardian/);
    expect(guardianApprove(t, "u1").status).toBe("active");
    expect(spouse().status).toBe("active");
    expect(() => newFamilyMember({ id: "x", ownerUserId: "u1", name: "X", kind: "spouse", limits, existingCount: 5 }, P)).toThrow();
  });
  it("validates limit ordering", () => {
    expect(validateLimits({ perTxnCents: 200, dailyCents: 100, monthlyCents: 1_000 })).toContain("perTxn cannot exceed daily");
    expect(validateLimits({ perTxnCents: 100, dailyCents: 2_000, monthlyCents: 1_000 })).toContain("daily cannot exceed monthly");
  });
  it("teens have default MCC blocks (gambling, alcohol, ...)", () => {
    expect(isMccBlocked(teen(), "7995")).toBe(true);
    expect(isMccBlocked(teen(), "5411")).toBe(false);
    expect(isMccBlocked(spouse(), "7995")).toBe(false);
  });
  it("enforces per-txn, daily and monthly member limits (inclusive)", () => {
    const m = spouse();
    expect(checkFamilySpend(m, "5411", 5_000, [], now).ok).toBe(true);
    expect(checkFamilySpend(m, "5411", 5_001, [], now).reason).toBe("per_txn_limit");
    const today = [{ at: T("2026-09-24T02:00:00Z"), amountCents: 6_000, kind: "card_spend" as const }];
    expect(checkFamilySpend(m, "5411", 4_000, today, now).ok).toBe(true);
    expect(checkFamilySpend(m, "5411", 4_001, today, now).reason).toBe("member_daily_limit");
    const month = [{ at: T("2026-09-02T02:00:00Z"), amountCents: 48_000, kind: "card_spend" as const }];
    expect(checkFamilySpend(m, "5411", 2_001, month, now).reason).toBe("member_monthly_limit");
  });
  it("teen card spends only from the allowance and can't exceed it", () => {
    const m = teen();
    const c = ctx({ card: card({ familyMemberId: "m1", holderUserId: "u-teen" }), member: m, memberSpend: [], allowanceAvailableCents: 3_000, availableCents: 1e6 });
    const ok = authorize(req(3_000), c, P, F);
    expect(ok.approved && ok.funding).toEqual({ account: "family_allowance", party: "m1" });
    expect(reason(authorize(req(3_001), c, P, F))).toBe("allowance_exceeded");
    expect(reason(authorize(req(100, "5921"), c, P, F))).toBe("mcc_blocked");
    expect(reason(authorize(req(100), { ...c, member: { ...m, status: "pending_guardian_approval" } }, P, F))).toBe("member_inactive");
  });
  it("spouse card spends from the owner's checking within member limits", () => {
    const c = ctx({ card: card({ familyMemberId: "m2" }), member: spouse(), memberSpend: [], availableCents: 20_000 });
    const d = authorize(req(5_000), c, P, F);
    expect(d.approved && d.funding.account).toBe("customer_deposits");
    expect(reason(authorize(req(5_001), c, P, F))).toBe("per_txn_limit");
  });
  it("allowance top-up moves owner funds into the teen pocket", () => {
    const t = planAllowanceTopUp({ id: "tu", ownerAccountId: "chk", member: teen(), amountCents: 2_000, ownerAvailableCents: 2_000 });
    expect(partyBalance(t.lines, "family_allowance", "m1")).toBe(2_000);
    expect(() => planAllowanceTopUp({ id: "tu", ownerAccountId: "chk", member: teen(), amountCents: 2_001, ownerAvailableCents: 2_000 })).toThrow();
    expect(() => planAllowanceTopUp({ id: "tu", ownerAccountId: "chk", member: spouse(), amountCents: 1, ownerAvailableCents: 2_000 })).toThrow();
  });
});
