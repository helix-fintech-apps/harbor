import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA, BEN, , , , ADMIN] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

// The Household Money Hub flows run on the in-memory store and, when HARBOR_PG_URL is set, on
// Postgres through SupabaseStore and the harbor_* SQL functions: both must behave identically.
describe.each(harnesses().map((h) => [h.name, h] as const))("%s store", (_name, h) => {
  let app: TestApp;
  const me = async (u = AVA) => body(await app.call(as(u), "GET", "/me"));
  const acct = async (kind: string, u = AVA) =>
    (await me(u)).accounts.find((a: any) => a.kind === kind && a.isPrimary);

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z")); // Monday
  });
  afterAll(() => h.close());

  describe("on-demand accounts + envelopes", () => {
    it("opens an envelope, funds it, and auto-closes it on the end date, sweeping to checking", async () => {
      const chk = await acct("checking");
      const env = body(
        await app.call(as(AVA), "POST", "/accounts", {
          kind: "envelope",
          nickname: "Vacation",
          startDate: "2026-09-20",
          endDate: "2026-09-30",
        }),
      );
      expect(env.kind).toBe("envelope");
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: env.id,
        amountCents: 40_000,
      });
      expect((await me()).accounts.find((a: any) => a.id === env.id).postedCents).toBe(40_000);
      expect((await acct("checking")).postedCents).toBe(210_000);

      // Not yet due.
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/sweep-envelopes")).swept).toBe(0);
      // Past the end date: it auto-closes and sweeps the balance back to checking.
      app.clock.advanceHours(24 * 11); // -> 2026-10-02
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/sweep-envelopes")).swept).toBe(1);
      expect((await me()).accounts.find((a: any) => a.id === env.id)).toBeUndefined();
      expect((await acct("checking")).postedCents).toBe(250_000);
    });

    it("validates envelope dates and refuses over the open-account limit path", async () => {
      expect(
        body(
          await app.call(as(AVA), "POST", "/accounts", {
            kind: "envelope",
            startDate: "2026-09-30",
          }),
        ).error.code,
      ).toBe("invalid_request");
      const extra = body(
        await app.call(as(AVA), "POST", "/accounts", { kind: "savings", nickname: "Rainy" }),
      );
      expect(extra.kind).toBe("savings");
      expect(extra.isPrimary).toBeUndefined(); // response omits it; it is a non-primary pocket
      // The extra savings pocket shows up alongside the primary one.
      expect((await me()).accounts.filter((a: any) => a.kind === "savings").length).toBe(2);
    });
  });

  describe("instant internal transfers", () => {
    it("moves money instantly between any two of the user's own accounts", async () => {
      const chk = await acct("checking");
      const sav = await acct("savings");
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 30_000,
      });
      expect((await acct("savings")).postedCents).toBe(30_000);
      expect((await acct("checking")).postedCents).toBe(220_000);

      const benChk = (await me(BEN)).accounts.find((a: any) => a.kind === "checking");
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/internal", {
            fromAccountId: chk.id,
            toAccountId: benChk.id,
            amountCents: 100,
          }),
        ).error.code,
      ).toBe("not_found");
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/internal", {
            fromAccountId: sav.id,
            toAccountId: chk.id,
            amountCents: 30_001,
          }),
        ).error.code,
      ).toBe("insufficient_funds");
    });
  });

  describe("debit cards on demand: per-card limits", () => {
    it("issues a card with per-transaction/daily/monthly limits and enforces them; limits can be raised", async () => {
      const card = body(
        await app.call(as(AVA), "POST", "/cards", {
          kind: "virtual",
          limits: { perTxnCents: 5_000, dailyCents: 10_000, monthlyCents: 40_000 },
        }),
      );
      const auth = async (cents: number) =>
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: cents,
            mcc: "5411",
          }),
        );
      expect((await auth(5_001)).reason).toBe("card_per_txn_limit");
      expect((await auth(5_000)).approved).toBe(true);
      expect((await auth(5_000)).approved).toBe(true); // today 10,000 = daily limit
      expect((await auth(100)).reason).toBe("card_daily_limit");

      await app.call(as(AVA), "POST", `/cards/${card.id}/limits`, {
        limits: { perTxnCents: 10_000, dailyCents: 100_000, monthlyCents: 100_000 },
      });
      expect((await auth(100)).approved).toBe(true);
    });
  });

  describe("household + shared monthly cap", () => {
    it("invites a member, they accept, and the household monthly cap spans every member and card", async () => {
      await app.call(as(AVA), "POST", "/household", {
        name: "Harbor Home",
        monthlyCapCents: 15_000,
      });
      const inv = body(
        await app.call(as(AVA), "POST", "/household/members", {
          name: "Ben",
          email: "ben@harbor.test",
          relationship: "partner",
        }),
      );
      expect(inv.status).toBe("invited");
      expect((await app.call(as(BEN), "POST", `/household/members/${inv.id}/accept`)).status).toBe(
        200,
      );
      expect((await me(BEN)).household.memberOf[0].name).toBe("Harbor Home");

      // Ava's card spends $100 of the $150 household cap.
      const avaCard = (await me()).cards[0];
      expect(
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${avaCard.id}/authorize`, {
            amountCents: 10_000,
            mcc: "5411",
          }),
        ).approved,
      ).toBe(true);
      // Ben's own new card: $60 would push the household to $160 (> cap) and is declined...
      const benCard = body(await app.call(as(BEN), "POST", "/cards", { kind: "virtual" }));
      expect(
        body(
          await app.call(as(BEN), "POST", `/sim/cards/${benCard.id}/authorize`, {
            amountCents: 6_000,
            mcc: "5411",
          }),
        ).reason,
      ).toBe("household_cap");
      // ...but $50 fits exactly at the $150 cap.
      expect(
        body(
          await app.call(as(BEN), "POST", `/sim/cards/${benCard.id}/authorize`, {
            amountCents: 5_000,
            mcc: "5411",
          }),
        ).approved,
      ).toBe(true);
    });
  });

  describe("zelle bill pay", () => {
    it("sends a one-time Zelle from checking (no fee)", async () => {
      const r = body(
        await app.call(as(AVA), "POST", "/zelle/send", {
          recipient: "friend@example.com",
          amountCents: 5_000,
        }),
      );
      expect(r.status).toBe("completed");
      expect(r.pulledCents).toBe(0);
      expect((await acct("checking")).postedCents).toBe(245_000);
    });

    it("pulls the shortfall from other accounts before sending", async () => {
      const chk = await acct("checking");
      const sav = await acct("savings");
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 200_000,
      });
      // checking $500 left, savings $2,000. A $900 Zelle drains checking then pulls $400 from savings.
      const r = body(
        await app.call(as(AVA), "POST", "/zelle/send", {
          recipient: "landlord@example.com",
          amountCents: 90_000,
        }),
      );
      expect(r.pulledCents).toBe(40_000);
      expect((await acct("checking")).postedCents).toBe(0);
      expect((await acct("savings")).postedCents).toBe(160_000);
    });

    it("insufficient combined balance is declined; below the minimum is declined", async () => {
      expect(
        body(
          await app.call(as(AVA), "POST", "/zelle/send", {
            recipient: "x@example.com",
            amountCents: 50,
          }),
        ).error.code,
      ).toBe("below_minimum");
      expect(
        body(
          await app.call(as(BEN), "POST", "/zelle/send", {
            recipient: "x@example.com",
            amountCents: 60_000,
          }),
        ).error.code,
      ).toBe("insufficient_funds");
    });

    it("runs a recurring weekly schedule when it comes due", async () => {
      const s = body(
        await app.call(as(AVA), "POST", "/zelle/schedules", {
          recipient: "gym@example.com",
          amountCents: 3_000,
          frequency: "weekly",
        }),
      );
      expect(s.frequency).toBe("weekly");
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/run-zelle")).ran).toBe(0);
      app.clock.advanceHours(24 * 8);
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/run-zelle")).ran).toBe(1);
      expect((await me()).transfers.filter((t: any) => t.kind === "zelle").length).toBe(1);
    });

    it("credits a Zelle return and a partial refund back to the source account", async () => {
      const full = body(
        await app.call(as(AVA), "POST", "/zelle/send", {
          recipient: "refundme@example.com",
          amountCents: 5_000,
        }),
      );
      const w = body(
        await app.call(null, "POST", "/sim/zelle/webhook", {
          type: "return",
          providerPaymentId: full.providerPaymentId,
          returnCode: "R01",
        }),
      );
      expect(w.fullyReturned).toBe(true);
      expect((await acct("checking")).postedCents).toBe(250_000);

      const partial = body(
        await app.call(as(AVA), "POST", "/zelle/send", {
          recipient: "shop@example.com",
          amountCents: 5_000,
        }),
      );
      const pw = body(
        await app.call(null, "POST", "/sim/zelle/webhook", {
          type: "refund",
          providerPaymentId: partial.providerPaymentId,
          amountCents: 2_000,
        }),
      );
      expect(pw.fullyReturned).toBe(false);
      expect(pw.returnedCents).toBe(2_000);
      expect((await acct("checking")).postedCents).toBe(247_000); // -5,000 +2,000
    });
  });

  describe("cashback", () => {
    it("credits 1% on captured spend and reverses it on a full refund", async () => {
      const card = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 10_000,
          mcc: "5411",
        }),
      );
      const cap = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
          amountCents: 10_000,
        }),
      );
      expect(cap.cashbackCents).toBe(100); // 1% of $100
      expect((await acct("checking")).postedCents).toBe(240_100);
      const rf = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: "rz1",
          amountCents: 10_000,
        }),
      );
      expect(rf.cashbackReversedCents).toBe(100);
      expect((await acct("checking")).postedCents).toBe(250_000);
    });
  });
});
