// HELIX-GENERATED TEST — rule N-CHGBK-05 (consumer-neobank playbook)
// Invariant: the total customer recovery on one captured purchase (refunds + dispute
// provisional/final credits) never exceeds the captured amount. A resolved (won) dispute
// must not be re-disputable for the same money.
//
// This is the executable form of the #15 finding: opening a second recovery on an auth that
// was already made whole double-credits the customer. It fails RED on the buggy code and is
// expected to pass GREEN once the recovery cap is enforced.

import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./../integration/support/harness.ts";

const [AVA] = DEMO_USERS;
const ADMIN = DEMO_USERS.find((u) => u.role === "admin")!;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store — N-CHGBK-05", (_n, h) => {
  let app: TestApp;
  const me = async () => body(await app.call(as(AVA), "GET", "/me"));
  const checking = async () => (await me()).accounts.find((a: any) => a.kind === "checking");

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z"));
  });
  afterAll(() => h.close());

  it("a won dispute cannot be re-disputed for the same money (Σ recoveries ≤ captured)", async () => {
    const card = (await me()).cards[0];
    const a = body(
      await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
        amountCents: 3_000,
        mcc: "5411",
      }),
    );
    await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
      amountCents: 3_000,
    });
    const start = (await checking()).postedCents;

    // Dispute #1: open -> provisional credit -> resolve WON. Customer keeps +3000.
    const d1 = body(
      await app.call(as(AVA), "POST", "/disputes", {
        authorizationId: a.authorizationId,
        amountCents: 3_000,
        reason: "not received",
      }),
    );
    await app.call(as(ADMIN), "POST", `/admin/disputes/${d1.id}/provisional-credit`);
    await app.call(as(ADMIN), "POST", `/admin/disputes/${d1.id}/resolve`, { outcome: "won" });
    expect((await checking()).postedCents).toBe(start + 3_000);

    // Dispute #2 on the SAME auth: the money was already recovered, so this must be rejected.
    const d2 = body(
      await app.call(as(AVA), "POST", "/disputes", {
        authorizationId: a.authorizationId,
        amountCents: 3_000,
        reason: "again",
      }),
    );
    if (d2?.id) {
      // Buggy path allowed a second dispute; carry it through to expose the double credit.
      await app.call(as(ADMIN), "POST", `/admin/disputes/${d2.id}/provisional-credit`);
    }

    // THE INVARIANT: cumulative dispute credit on one 3000c purchase never exceeds 3000c.
    expect((await checking()).postedCents).toBeLessThanOrEqual(start + 3_000);
    // And a second dispute on an already-recovered auth is rejected outright.
    expect(d2?.error?.code).toBe("dispute_rejected");
  });
});
