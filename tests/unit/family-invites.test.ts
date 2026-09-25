import {
  DEFAULT_POLICY as P,
  DEFAULT_FEES as F,
  validateInviteInput,
  validateCardStartDate,
  newFamilyInvite,
  acceptInvite,
  inviteState,
  ageYears,
  INVITE_TTL_DAYS,
  CARD_MAX_SCHEDULE_DAYS,
  authorize,
  addDays,
  type InviteInput,
  type FamilyInvite,
  type AuthContext,
  type Card,
} from "../../supabase/functions/_shared/domain/index.ts";

const T = (s: string) => new Date(s);
const now = T("2026-09-24T18:00:00Z");

const input = (over: Partial<InviteInput> = {}): InviteInput => ({
  firstName: "Sam",
  lastName: "Rivera",
  dob: "1990-05-01",
  email: "sam@example.com",
  kind: "spouse",
  limits: { perTxnCents: 20_000, dailyCents: 50_000, monthlyCents: 200_000 },
  cardKind: "virtual",
  ...over,
});

describe("invite input validation", () => {
  it("accepts a well-formed spouse invite", () => {
    expect(validateInviteInput(input(), now)).toEqual([]);
  });
  it("requires first name, last name, and a valid email", () => {
    expect(validateInviteInput(input({ firstName: "  " }), now)).toContain("firstName is required");
    expect(validateInviteInput(input({ lastName: "" }), now)).toContain("lastName is required");
    expect(validateInviteInput(input({ email: "not-an-email" }), now)).toContain(
      "a valid email is required",
    );
  });
  it("rejects a future or malformed date of birth", () => {
    expect(validateInviteInput(input({ dob: "2100-01-01" }), now)).toContain(
      "dob must be a valid date in the past",
    );
    expect(validateInviteInput(input({ dob: "05/01/1990" }), now)).toContain(
      "dob must be an ISO date (YYYY-MM-DD)",
    );
  });
  it("enforces minimum ages: 13 for a teen, 18 for a spouse", () => {
    // born 2015 -> age ~11 at `now`
    expect(validateInviteInput(input({ kind: "teen", dob: "2015-01-01" }), now)).toContain(
      "member must be at least 13 years old",
    );
    // born 2010 -> age ~16: fine for a teen, too young for a spouse
    expect(validateInviteInput(input({ kind: "teen", dob: "2010-01-01" }), now)).toEqual([]);
    expect(validateInviteInput(input({ kind: "spouse", dob: "2010-01-01" }), now)).toContain(
      "a spouse member must be at least 18",
    );
  });
  it("propagates the family spend-limit ordering rule", () => {
    expect(
      validateInviteInput(
        input({ limits: { perTxnCents: 60_000, dailyCents: 50_000, monthlyCents: 200_000 } }),
        now,
      ),
    ).toContain("perTxn cannot exceed daily");
  });

  it("ageYears counts whole years and flags future/invalid dates", () => {
    expect(ageYears("1990-05-01", now)).toBe(36);
    expect(ageYears("1990-09-25", now)).toBe(35); // birthday not yet reached in the year
    expect(ageYears("2100-01-01", now)).toBe(-1);
    expect(Number.isNaN(ageYears("garbage", now))).toBe(true);
  });
});

describe("card start date validation", () => {
  it("treats an empty start date as immediate", () => {
    expect(validateCardStartDate(undefined, now)).toEqual([]);
    expect(validateCardStartDate("", now)).toEqual([]);
  });
  it("allows a date within the scheduling window", () => {
    expect(validateCardStartDate(addDays(now, 30).toISOString(), now)).toEqual([]);
    // today, earlier in the day than `now`, is still allowed
    expect(validateCardStartDate("2026-09-24T06:00:00Z", now)).toEqual([]);
  });
  it("rejects a past date and a date beyond the window", () => {
    expect(validateCardStartDate("2026-09-20T00:00:00Z", now)).toContain(
      "cardStartAt cannot be in the past",
    );
    expect(
      validateCardStartDate(addDays(now, CARD_MAX_SCHEDULE_DAYS + 1).toISOString(), now),
    ).toContain(`cardStartAt cannot be more than ${CARD_MAX_SCHEDULE_DAYS} days ahead`);
    expect(validateCardStartDate("nonsense", now)).toContain("cardStartAt is not a valid date");
  });
});

describe("invite lifecycle", () => {
  const make = (over: Partial<InviteInput> = {}): FamilyInvite =>
    newFamilyInvite(
      { id: "inv1", ownerUserId: "owner", token: "tok_abc", input: input(over) },
      P,
      now,
    );

  it("creates a sent invite with a token and a 14-day expiry, email lower-cased", () => {
    const inv = make({ email: "SAM@Example.com", cardStartAt: addDays(now, 7).toISOString() });
    expect(inv.status).toBe("sent");
    expect(inv.token).toBe("tok_abc");
    expect(inv.email).toBe("sam@example.com");
    expect(inv.expiresAt.toISOString()).toBe(addDays(now, INVITE_TTL_DAYS).toISOString());
    expect(inv.cardActivateAt?.toISOString()).toBe(addDays(now, 7).toISOString());
  });
  it("throws on invalid input rather than creating a bad invite", () => {
    expect(() => make({ email: "bad" })).toThrow();
  });
  it("a sent invite past expiry reads as expired without a write", () => {
    const inv = make();
    expect(inviteState(inv, now)).toBe("sent");
    expect(inviteState(inv, addDays(now, INVITE_TTL_DAYS + 1))).toBe("expired");
  });

  it("accept returns a member+card plan for a pending invite", () => {
    const inv = make({ cardStartAt: addDays(now, 3).toISOString() });
    const res = acceptInvite(inv, addDays(now, 1));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.displayName).toBe("Sam Rivera");
      expect(res.plan.kind).toBe("spouse");
      expect(res.plan.cardActivateAt?.toISOString()).toBe(addDays(now, 3).toISOString());
    }
  });
  it("accept fails once expired or no longer pending", () => {
    const inv = make();
    const late = acceptInvite(inv, addDays(now, INVITE_TTL_DAYS + 2));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("invite_expired");
    const already = acceptInvite({ ...inv, status: "accepted" }, addDays(now, 1));
    expect(already.ok).toBe(false);
    if (!already.ok) expect(already.reason).toBe("invite_not_pending");
  });
});

describe("card start date gates authorizations", () => {
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
    availableCents: 100_000,
    recentAuthAttempts: [],
    now,
    ...over,
  });
  const req = { amountCents: 2_500, mcc: "5411", merchant: "Shop", foreign: false };
  const reason = (d: ReturnType<typeof authorize>) => (d.approved ? "approved" : d.reason);

  it("declines a card whose start date is still in the future", () => {
    const scheduled = card({ activateAt: addDays(now, 5) });
    expect(reason(authorize(req, ctx({ card: scheduled }), P, F))).toBe("card_not_active_yet");
  });
  it("approves once the start date has arrived, and for an immediate card", () => {
    const scheduled = card({ activateAt: addDays(now, 5) });
    expect(reason(authorize(req, ctx({ card: scheduled, now: addDays(now, 5) }), P, F))).toBe(
      "approved",
    );
    expect(reason(authorize(req, ctx(), P, F))).toBe("approved"); // no activateAt = immediate
  });

  it("a started spouse family card draws from the owner's shared checking", () => {
    const member = {
      id: "m1",
      ownerUserId: "u1",
      name: "Sam Rivera",
      kind: "spouse" as const,
      status: "active" as const,
      limits: { perTxnCents: 20_000, dailyCents: 50_000, monthlyCents: 200_000 },
      blockedMccGroups: [],
      blockedMccs: [],
    };
    const famCard = card({ familyMemberId: "m1", activateAt: undefined });
    const d = authorize(req, ctx({ card: famCard, member, memberSpend: [] }), P, F);
    expect(d.approved).toBe(true);
    if (d.approved) {
      // spouse spend funds from the owner's deposits (same pool the owner's own card uses)
      expect(d.funding.account).toBe("customer_deposits");
      expect(d.funding.party).toBe("chk");
    }
  });
});
