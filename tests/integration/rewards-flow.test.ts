// End-to-end: BTC cashback accrues on captured debit spend, converts to spendable USD at the
// live rate, and the realised USD can be swept into checking — but BTC itself can never be spent.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store — BTC rewards", (_n, h) => {
  let app: TestApp;
  const me = async () => body(await app.call(as(AVA), "GET", "/me"));
  const acct = async (kind: string) => (await me()).accounts.find((a: any) => a.kind === kind);
  const rewards = async () => body(await app.call(as(AVA), "GET", "/rewards"));

  const spend = async (cents: number) => {
    const card = (await me()).cards[0];
    const a = body(
      await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
        amountCents: cents,
        mcc: "5411",
      }),
    );
    await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
      amountCents: cents,
    });
  };

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z"));
  });
  afterAll(() => h.close());

  it("earns Bitcoin at the first-band rate on captured spend", async () => {
    await spend(3_000); // $30 -> 2% = 60c -> at $60k/BTC = 1,000 sats
    const r = await rewards();
    expect(r.satsBalance).toBe(1_000);
    expect(r.eligibleCents).toBe(3_000);
    expect(r.estimatedUsdCents).toBe(60);
    expect(r.walletUsdCents).toBe(0);
  });

  it("converts BTC to spendable USD, and the same key never pays out twice", async () => {
    await spend(3_000);
    await spend(3_000); // 2,000 sats total

    const before = (await acct("checking")).postedCents;

    // Convert half; then replay the exact same request — the wallet must not double.
    const c1 = body(
      await app.call(
        as(AVA),
        "POST",
        "/rewards/convert",
        { sats: 1_000 },
        { idempotencyKey: "K1" },
      ),
    );
    expect(c1.usdCents).toBe(60);
    expect(c1.remainingSats).toBe(1_000);
    expect((await acct("rewards")).postedCents).toBe(60);

    await app.call(as(AVA), "POST", "/rewards/convert", { sats: 1_000 }, { idempotencyKey: "K1" });
    expect((await acct("rewards")).postedCents).toBe(60); // still 60, not 120
    expect((await rewards()).satsBalance).toBe(1_000); // second 1,000 still unconverted

    // Convert the rest under a fresh key, then sweep the realised USD into checking to spend it.
    await app.call(as(AVA), "POST", "/rewards/convert", { sats: 1_000 }, { idempotencyKey: "K2" });
    expect((await acct("rewards")).postedCents).toBe(120);
    expect((await rewards()).satsBalance).toBe(0);

    await app.call(
      as(AVA),
      "POST",
      "/transfers/pocket",
      { from: "rewards", to: "checking", amountCents: 120 },
      { idempotencyKey: "S1" },
    );
    expect((await acct("rewards")).postedCents).toBe(0);
    expect((await acct("checking")).postedCents).toBe(before + 120);
  });

  it("cannot convert more BTC than earned", async () => {
    await spend(3_000); // 1,000 sats
    const res = await app.call(
      as(AVA),
      "POST",
      "/rewards/convert",
      { sats: 5_000 },
      { idempotencyKey: "OVER" },
    );
    expect(res.status).toBe(409);
    expect(body(res).error.code).toBe("insufficient_btc_balance");
  });

  it("BTC is not spendable: funds can never be moved INTO the rewards wallet", async () => {
    await spend(3_000);
    await app.call(as(AVA), "POST", "/rewards/convert", { sats: 1_000 }, { idempotencyKey: "K1" });
    const res = await app.call(
      as(AVA),
      "POST",
      "/transfers/pocket",
      { from: "checking", to: "rewards", amountCents: 50 },
      { idempotencyKey: "BAD" },
    );
    expect(res.status).toBe(422);
    expect(body(res).error.code).toBe("invalid_destination");
  });
});
