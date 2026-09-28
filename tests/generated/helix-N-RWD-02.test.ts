// HELIX-GENERATED TEST — rule N-RWD-02 (consumer-neobank playbook)
// Invariant: BTC cashback earned on captured debit spend must be clawed back when that spend
// is fully reversed (merchant refund / won dispute). A member must never keep Bitcoin cashback
// for a purchase they were fully refunded on.
import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./../integration/support/harness.ts";

const [AVA] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store — N-RWD-02", (_n, h) => {
  let app: TestApp;
  const me = async () => body(await app.call(as(AVA), "GET", "/me"));
  const rewards = async () => body(await app.call(as(AVA), "GET", "/rewards"));

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z"));
  });
  afterAll(() => h.close());

  it("a fully refunded purchase claws back the BTC cashback it earned", async () => {
    const card = (await me()).cards[0];

    // Earn cashback on a $500 captured debit purchase.
    const a = body(
      await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
        amountCents: 50_000,
        mcc: "5411",
      }),
    );
    await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
      amountCents: 50_000,
    });

    const earned = (await rewards()).satsBalance;
    expect(earned).toBeGreaterThan(0); // cashback was actually earned

    // The merchant refunds the whole purchase.
    await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
      refundId: "rfnd-1",
      amountCents: 50_000,
    });

    // THE INVARIANT: money back in full => cashback fully clawed back.
    const afterRefund = (await rewards()).satsBalance;
    expect(afterRefund).toBe(0);
  });
});
