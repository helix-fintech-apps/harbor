// HELIX-GENERATED TEST — rule K-SCREEN-01 (KYC / onboarding / sanctions playbook)
// Invariant: a family/teen member's card must NOT be issuable or active unless THAT MEMBER has
// passed KYC/sanctions screening. Card issuance must screen the member — not merely rely on the
// account owner's KYC. A member whose name is on the sanctions list must never hold an active card.
import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./../integration/support/harness.ts";

const [AVA] = DEMO_USERS; // account owner — KYC-approved in the demo seed
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

// On Harbor's FAKE_SANCTIONS_LIST → a confirmed sanctions match → frozen_legal if screened.
const SANCTIONED_NAME = "Ivan Blocked Testperson";

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store — K-SCREEN-01", (_n, h) => {
  let app: TestApp;
  const me = async () => body(await app.call(as(AVA), "GET", "/me"));

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z"));
  });
  afterAll(() => h.close());

  it("a family member on the sanctions list cannot hold an active card", async () => {
    // Owner (Ava) is KYC-approved. Add a spouse member whose name is on the sanctions list —
    // the member is added with no screening of the member.
    const added = body(
      await app.call(as(AVA), "POST", "/family", {
        name: SANCTIONED_NAME,
        kind: "spouse",
        limits: { perTxnCents: 10_000, dailyCents: 20_000, monthlyCents: 50_000 },
      }),
    );
    const memberId: string = added.id;
    expect(added.status).toBe("active"); // member created (no member-level screening ran)

    // Issue a card for that member. Correct behavior: the member is screened and, being a
    // sanctions match, cannot get an active card. (Response intentionally not asserted — under a
    // correct implementation this call is a decline.)
    await app.call(as(AVA), "POST", "/cards", { kind: "virtual", familyMemberId: memberId });

    // THE INVARIANT: a member who cannot pass sanctions screening holds no active card.
    // (`/me` returns raw card rows: the member link is `family_member_id`.)
    const activeMemberCards = (await me()).cards.filter(
      (cd: { family_member_id?: string; familyMemberId?: string; status: string }) =>
        (cd.family_member_id ?? cd.familyMemberId) === memberId && cd.status === "active",
    );
    expect(activeMemberCards.length).toBe(0);
  });
});
