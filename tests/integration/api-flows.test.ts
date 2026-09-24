import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import {
  assertNoLiveKeys,
  selectProviders,
} from "../../supabase/functions/_shared/providers/index.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA, BEN, RITA, OLEG, NIA, ADMIN] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

// The same flows run on the in-memory store and, when HARBOR_PG_URL is set, on Postgres through
// SupabaseStore and the harbor_* SQL functions (scripts/ci/with_pg.sh): both must behave identically.
describe.each(harnesses().map((h) => [h.name, h] as const))("%s store", (_name, h) => {
  let app: TestApp;
  const me = async (u = AVA) => body(await app.call(as(u), "GET", "/me"));
  const checking = async (u = AVA) =>
    (await me(u)).accounts.find((a: any) => a.kind === "checking");

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z")); // Monday
  });
  afterAll(() => h.close());

  describe("seeded onboarding", () => {
    it("assigns KYC states from identity + sanctions", async () => {
      expect((await me(AVA)).profile.kycState).toBe("approved");
      expect((await me(RITA)).profile.kycState).toBe("needs_review");
      expect((await me(OLEG)).profile.kycState).toBe("frozen_legal");
      expect((await me(NIA)).profile.kycState).toBe("unverified");
    });
    it("vendor timeout leaves the customer pending, never approved", async () => {
      await app.addUser("00000000-0000-4000-8000-000000005100", "slow@harbor.test", "Sally Slow");
      const r = await app.call(
        { userId: "00000000-0000-4000-8000-000000005100", role: "customer" },
        "POST",
        "/kyc/start",
      );
      expect(body(r).state).toBe("pending");
      expect(body(r).identityStatus).toBe("timeout");
      await app.addUser("00000000-0000-4000-8000-000000005200", "w@harbor.test", "Wendy Weird");
      expect(
        body(
          await app.call(
            { userId: "00000000-0000-4000-8000-000000005200", role: "customer" },
            "POST",
            "/kyc/start",
          ),
        ).state,
      ).toBe("pending");
    });
    it("admin approves a needs_review customer and accounts open; customers can't use admin endpoints", async () => {
      expect(
        (
          await app.call(as(AVA), "POST", `/admin/users/${RITA.id}/kyc`, {
            state: "approved",
            reason: "docs ok",
          })
        ).status,
      ).toBe(403);
      const r = await app.call(as(ADMIN), "POST", `/admin/users/${RITA.id}/kyc`, {
        state: "approved",
        reason: "docs ok",
      });
      expect(r.status).toBe(200);
      expect((await me(RITA)).accounts).toHaveLength(2);
    });
    it("staff can't skip verification for unverified customers; support can't lift a legal freeze", async () => {
      expect(
        body(
          await app.call(as(ADMIN), "POST", `/admin/users/${NIA.id}/kyc`, {
            state: "approved",
            reason: "vip",
          }),
        ).error.code,
      ).toBe("manual_approval_not_allowed");
      const agent = DEMO_USERS.find((u) => u.role === "support_agent")!;
      expect(
        (
          await app.call(as(agent), "POST", `/admin/users/${OLEG.id}/kyc`, {
            state: "approved",
            reason: "x",
          })
        ).status,
      ).toBe(403);
      expect(
        body(
          await app.call(as(ADMIN), "POST", `/admin/users/${RITA.id}/kyc`, {
            state: "approved",
            reason: "",
          }),
        ).error.code,
      ).toBe("reason_required");
    });
  });

  describe("balances and ACH in", () => {
    it("settled deposit is available; new deposit is posted but held", async () => {
      const bank = (await me()).banks[0];
      const r = await app.call(as(AVA), "POST", "/transfers/ach-in", {
        bankId: bank.id,
        amountCents: 10_000,
      });
      expect(r.status).toBe(200);
      const chk = await checking();
      expect(chk.postedCents).toBe(260_000);
      expect(chk.availableCents).toBe(250_000);
      app.clock.advanceHours(24 * 5);
      await app.call(as(ADMIN), "POST", "/admin/jobs/settle-ach");
      expect((await checking()).availableCents).toBe(260_000);
    });
    it("R10 return after settlement claws back into a negative balance and blocks closure", async () => {
      const { transfers } = await me(BEN);
      const dep = transfers.find((t: any) => t.kind === "ach_in");
      await app.call(as(BEN), "POST", "/transfers/p2p", {
        recipientEmail: "ava@harbor.test",
        amountCents: 40_000,
        stepUpCode: "000000",
      });
      const r = await app.call(as(ADMIN), "POST", `/admin/transfers/${dep.id}/return`, {
        code: "R10",
      });
      expect(body(r).negativeBalanceCents).toBe(40_000);
      expect((await checking(BEN)).postedCents).toBe(-40_000);
      const again = await app.call(as(ADMIN), "POST", `/admin/transfers/${dep.id}/return`, {
        code: "R10",
      });
      expect(again.status).toBe(409);
      const close = await app.call(as(BEN), "POST", "/accounts/close", {});
      expect(close.status).toBe(409);
      expect(body(close).error.details).toContain("negative_balance");
    });
    it("name mismatch bank is linked but can't be used", async () => {
      const link = body(
        await app.call(as(AVA), "POST", "/banks/exchange", {
          publicToken: "public-fake-Other_Bank-Mallory_Smith",
        }),
      );
      expect(link.nameMatched).toBe(false);
      const r = await app.call(as(AVA), "POST", "/transfers/ach-in", {
        bankId: link.id,
        amountCents: 1_000,
      });
      expect(body(r).error.code).toBe("bank_name_mismatch");
    });
  });

  describe("money out", () => {
    it("instant withdrawal charges the published fee; cooling-off applies to a freshly linked bank", async () => {
      const bank = (await me()).banks[0];
      const r = await app.call(as(AVA), "POST", "/transfers/ach-out", {
        bankId: bank.id,
        amountCents: 10_000,
        speed: "instant",
      });
      expect(body(r).feeCents).toBe(150);
      expect((await checking()).postedCents).toBe(250_000 - 10_150);
      const fresh = body(
        await app.call(as(AVA), "POST", "/banks/exchange", {
          publicToken: "public-fake-New_Bank-Ava_Harbor",
        }),
      );
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/ach-out", {
            bankId: fresh.id,
            amountCents: 100,
            speed: "standard",
          }),
        ).error.code,
      ).toBe("cooling_off");
    });
    it("idempotent transfers: same key returns the first result and moves money once; different body conflicts", async () => {
      const bank = (await me()).banks[0];
      const b = { bankId: bank.id, amountCents: 5_000, speed: "standard" };
      const a1 = await app.call(as(AVA), "POST", "/transfers/ach-out", b, {
        idempotencyKey: "k-1",
      });
      const a2 = await app.call(as(AVA), "POST", "/transfers/ach-out", b, {
        idempotencyKey: "k-1",
      });
      expect(body(a2).id).toBe(body(a1).id);
      expect(a2.replayed).toBe(true);
      expect((await checking()).postedCents).toBe(245_000);
      const a3 = await app.call(
        as(AVA),
        "POST",
        "/transfers/ach-out",
        { ...b, amountCents: 6_000 },
        { idempotencyKey: "k-1" },
      );
      expect(body(a3).error.code).toBe("idempotency_conflict");
    });
    it("P2P new payee needs step-up; tier1 daily limit applies", async () => {
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 1_000,
          }),
        ).error.code,
      ).toBe("step_up_required");
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 1_000,
            stepUpCode: "123456",
          }),
        ).error.code,
      ).toBe("step_up_required");
      expect(
        (
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 1_000,
            stepUpCode: "000000",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 99_000,
          })
        ).status,
      ).toBe(200);
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 1,
          }),
        ).error.code,
      ).toBe("below_minimum");
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "ben@harbor.test",
            amountCents: 100,
          }),
        ).error.code,
      ).toBe("daily_limit");
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/p2p", {
            recipientEmail: "rita@harbor.test",
            amountCents: 100,
          }),
        ).error.code,
      ).toBe("recipient_unavailable");
    });
  });

  describe("cards", () => {
    it("auth holds available, partial capture releases the rest, refund posts once", async () => {
      const card = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 5_000,
          mcc: "5812",
          merchant: "Cafe",
        }),
      );
      expect(a.approved).toBe(true);
      expect((await checking()).availableCents).toBe(245_000);
      const cap = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
          amountCents: 5_900,
        }),
      );
      expect(cap.capturedCents).toBe(5_900); // tip within 20%
      const chk = await checking();
      expect([chk.postedCents, chk.availableCents]).toEqual([244_100, 244_100]);
      const r1 = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: "re_1",
          amountCents: 900,
        }),
      );
      const r2 = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: "re_1",
          amountCents: 900,
        }),
      );
      expect([r1.duplicate, r2.duplicate]).toEqual([false, true]);
      expect((await checking()).postedCents).toBe(245_000);
    });
    it("frozen card declines; auth expiry releases the hold", async () => {
      const card = (await me()).cards[0];
      await app.call(as(AVA), "POST", `/cards/${card.id}/freeze`);
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: 100,
            mcc: "5411",
          }),
        ).reason,
      ).toBe("card_frozen");
      await app.call(as(AVA), "POST", `/cards/${card.id}/unfreeze`);
      await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
        amountCents: 7_000,
        mcc: "5411",
      });
      expect((await checking()).availableCents).toBe(243_000);
      app.clock.advanceHours(24 * 7);
      expect((await checking()).availableCents).toBe(250_000);
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/expire-auths")).expired).toBe(1);
    });
    it("teen family card: guardian approval, allowance only, MCC block", async () => {
      const m = body(
        await app.call(as(AVA), "POST", "/family", {
          name: "Tia",
          kind: "teen",
          limits: { perTxnCents: 5_000, dailyCents: 10_000, monthlyCents: 40_000 },
        }),
      );
      expect(m.status).toBe("pending_guardian_approval");
      const card = body(
        await app.call(as(AVA), "POST", "/cards", { kind: "virtual", familyMemberId: m.id }),
      );
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: 100,
            mcc: "5411",
          }),
        ).reason,
      ).toBe("member_inactive");
      expect((await app.call(as(BEN), "POST", `/family/${m.id}/approve`)).status).toBe(404);
      await app.call(as(AVA), "POST", `/family/${m.id}/approve`);
      await app.call(as(AVA), "POST", `/family/${m.id}/allowance`, { amountCents: 2_000 });
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: 2_001,
            mcc: "5411",
          }),
        ).reason,
      ).toBe("allowance_exceeded");
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: 500,
            mcc: "7995",
          }),
        ).reason,
      ).toBe("mcc_blocked");
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: 2_000,
            mcc: "5411",
          }),
        ).approved,
      ).toBe(true);
      expect((await checking()).postedCents).toBe(248_000);
    });
  });

  describe("disputes, interest, statements, closure", () => {
    it("dispute -> provisional credit -> lost reverses", async () => {
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
      const d = body(
        await app.call(as(AVA), "POST", "/disputes", {
          authorizationId: a.authorizationId,
          amountCents: 3_000,
          reason: "not received",
        }),
      );
      expect(d.status).toBe("open");
      expect(
        body(
          await app.call(as(AVA), "POST", "/disputes", {
            authorizationId: a.authorizationId,
            amountCents: 1,
            reason: "x",
          }),
        ).error.code,
      ).toBe("dispute_rejected");
      await app.call(as(ADMIN), "POST", `/admin/disputes/${d.id}/provisional-credit`);
      expect((await checking()).postedCents).toBe(250_000);
      await app.call(as(ADMIN), "POST", `/admin/disputes/${d.id}/resolve`, { outcome: "lost" });
      expect((await checking()).postedCents).toBe(247_000);
    });
    it("savings interest accrues daily and posts monthly with banker's rounding", async () => {
      await app.call(as(AVA), "POST", "/transfers/pocket", {
        from: "checking",
        to: "savings",
        amountCents: 100_000,
      });
      const day0 = app.clock.now();
      for (let i = 0; i < 3; i++) {
        await app.call(as(ADMIN), "POST", "/admin/jobs/accrue-interest", {
          day: new Date(day0.getTime() + i * 86_400_000).toISOString().slice(0, 10),
        });
      }
      const period = day0.toISOString().slice(0, 7);
      const r = body(await app.call(as(ADMIN), "POST", "/admin/jobs/post-interest", { period }));
      const ava = r.postings.find((p: any) => p.postedCents > 0);
      expect(ava.postedCents).toBe(33); // 3 x 10.958904c = 32.876712 -> 33
      const sav = (await me()).accounts.find((a: any) => a.kind === "savings");
      expect(sav.postedCents).toBe(100_033);
    });
    it("statement reconciles with the ledger", async () => {
      const chk = await checking();
      const s = body(
        await app.call(as(AVA), "GET", `/statements?accountId=${chk.id}&period=2026-09`),
      );
      expect(s.openingCents).toBe(0);
      expect(s.closingCents).toBe(chk.postedCents);
      expect(
        body(await app.call(as(BEN), "GET", `/statements?accountId=${chk.id}&period=2026-09`)).error
          .code,
      ).toBe("not_found");
    });
    it("closure pays out, cancels cards; sanctions freeze blocks it", async () => {
      const r = body(await app.call(as(AVA), "POST", "/accounts/close", {}));
      expect(r.payoutCents).toBe(250_000);
      expect(r.cardsCanceled).toBe(1);
      const ledger = body(await app.call(as(ADMIN), "GET", "/admin/ledger"));
      expect(ledger.trialBalanceCents).toBe(0);
      await app.call(as(ADMIN), "POST", `/admin/users/${BEN.id}/kyc`, {
        state: "frozen_legal",
        reason: "OFAC hit",
      });
      expect(body(await app.call(as(BEN), "POST", "/accounts/close", {})).error.details).toContain(
        "payout_blocked",
      );
    });
  });
});

describe("providers", () => {
  it("refuses live keys and uses fakes without keys", () => {
    expect(() => assertNoLiveKeys({ STRIPE_SECRET_KEY: "sk_live_123" })).toThrow(/live/);
    expect(() => assertNoLiveKeys({ PLAID_ENV: "production" })).toThrow();
    expect(selectProviders({}).mode).toBe("fake");
    expect(selectProviders({ STRIPE_SECRET_KEY: "sk_test_x" }).identity.name).toBe(
      "stripe_identity",
    );
  });
});
