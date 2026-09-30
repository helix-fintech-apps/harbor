// Household Money Hub end-to-end flows. Runs on the in-memory store and, with HARBOR_PG_URL set,
// on Postgres through SupabaseStore and the harbor_* SQL functions (both must behave identically):
// on-demand accounts + envelope auto-close, instant internal transfers, households + monthly cap,
// per-card limits, 1% cashback, and Zelle bill pay (one-time, recurring, shortfall pull, returns).
import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA, BEN, , , , ADMIN] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store", (_name, h) => {
  let app: TestApp;
  const me = async (u = AVA) => body(await app.call(as(u), "GET", "/me"));
  const acct = async (u = AVA, kind = "checking") =>
    (await me(u)).accounts.find((a: any) => a.kind === kind);
  const trialBalance = async () =>
    (await app.store.ledger()).reduce((s, l) => s + l.debit - l.credit, 0);

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z")); // Monday
  });
  afterAll(() => h.close());

  describe("on-demand accounts + instant internal transfers", () => {
    it("opens extra pockets and moves money instantly between any two of them", async () => {
      const chk = await acct();
      const env = body(
        await app.call(as(AVA), "POST", "/accounts", {
          kind: "envelope",
          nickname: "Vacation",
          endDate: "2026-12-01",
        }),
      );
      expect([env.kind, env.status, env.endDate]).toEqual(["envelope", "open", "2026-12-01"]);
      // envelopes require an end date
      expect(
        body(await app.call(as(AVA), "POST", "/accounts", { kind: "envelope" })).error.code,
      ).toBe("invalid_envelope");
      // move checking -> envelope, instantly
      const t = await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: env.id,
        amountCents: 30_000,
      });
      expect(t.status).toBe(200);
      const after = await me();
      expect(after.accounts.find((a: any) => a.id === env.id).postedCents).toBe(30_000);
      expect(after.accounts.find((a: any) => a.kind === "checking").postedCents).toBe(220_000);
      // can't overdraw the envelope, and can't move to a foreign account
      expect(
        body(
          await app.call(as(AVA), "POST", "/transfers/internal", {
            fromAccountId: env.id,
            toAccountId: chk.id,
            amountCents: 30_001,
          }),
        ).error.code,
      ).toBe("insufficient_funds");
      const benChk = await acct(BEN);
      expect(
        (
          await app.call(as(AVA), "POST", "/transfers/internal", {
            fromAccountId: chk.id,
            toAccountId: benChk.id,
            amountCents: 100,
          })
        ).status,
      ).toBe(404);
      expect(await trialBalance()).toBe(0);
    });

    it("auto-closes an envelope on its end date and sweeps the balance to primary checking", async () => {
      const chk = await acct();
      // the seed advances the demo clock 7 days, so "now" is ~2026-09-28; end a week out.
      const env = body(
        await app.call(as(AVA), "POST", "/accounts", {
          kind: "envelope",
          endDate: "2026-10-05",
        }),
      );
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: env.id,
        amountCents: 40_000,
      });
      // before the end date nothing closes
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/close-envelopes")).closed).toBe(0);
      app.clock.advanceHours(24 * 10); // past the end date
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/close-envelopes")).closed).toBe(1);
      const after = await me();
      expect(after.accounts.find((a: any) => a.id === env.id)).toBeUndefined(); // closed
      expect(after.accounts.find((a: any) => a.kind === "checking").postedCents).toBe(250_000); // swept back
      // idempotent: a second run closes nothing
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/close-envelopes")).closed).toBe(0);
      expect(await trialBalance()).toBe(0);
    });
  });

  describe("households and the shared monthly cap", () => {
    it("creates a household, invites and accepts a member, and caps spend across all members and cards", async () => {
      const hh = body(
        await app.call(as(AVA), "POST", "/households", {
          name: "Harbors",
          monthlyCapCents: 10_000,
        }),
      );
      const inv = body(
        await app.call(as(AVA), "POST", `/households/${hh.id}/invite`, {
          email: "ben@harbor.test",
        }),
      );
      expect(inv.status).toBe("invited");
      // only the invited email may accept
      expect((await app.call(as(AVA), "POST", `/households/invites/${inv.id}/accept`)).status).toBe(
        403,
      );
      expect(
        body(await app.call(as(BEN), "POST", `/households/invites/${inv.id}/accept`)).status,
      ).toBe("active");

      // Ava spends 8,000 on her card; the household has 2,000 of cap left across everyone.
      const avaCard = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${avaCard.id}/authorize`, {
          amountCents: 8_000,
          mcc: "5411",
          merchant: "Grocer",
        }),
      );
      expect(a.approved).toBe(true);
      const benCard = body(await app.call(as(BEN), "POST", "/cards", { kind: "virtual" }));
      // 2,001 breaches the household cap (8,000 + 2,001 > 10,000); 2,000 is exactly the cap
      expect(
        body(
          await app.call(as(BEN), "POST", `/sim/cards/${benCard.id}/authorize`, {
            amountCents: 2_001,
            mcc: "5411",
          }),
        ).reason,
      ).toBe("household_monthly_cap");
      expect(
        body(
          await app.call(as(BEN), "POST", `/sim/cards/${benCard.id}/authorize`, {
            amountCents: 2_000,
            mcc: "5411",
          }),
        ).approved,
      ).toBe(true);
      // the /me household view reflects the cap and month-to-date spend
      const mine = await me();
      expect(mine.household.monthlyCapCents).toBe(10_000);
      expect(mine.household.monthSpendCents).toBe(10_000);
    });
  });

  describe("per-card limits", () => {
    it("enforces a card's per-transaction and daily limits independently of the tier limit", async () => {
      const card = body(
        await app.call(as(AVA), "POST", "/cards", {
          kind: "virtual",
          limits: { perTxnCents: 1_000, dailyCents: 2_000, monthlyCents: 5_000 },
        }),
      );
      const auth = async (cents: number) =>
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents: cents,
            mcc: "5411",
          }),
        );
      expect((await auth(1_001)).reason).toBe("card_per_txn_limit");
      expect((await auth(1_000)).approved).toBe(true); // day total 1,000
      expect((await auth(1_000)).approved).toBe(true); // day total 2,000 (the daily limit)
      expect((await auth(1)).reason).toBe("card_daily_limit");
    });

    it("issues a card funded by a chosen account; envelopes cannot fund cards", async () => {
      const chk = await acct();
      const sav = await acct(AVA, "savings");
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 20_000,
      });
      const card = body(
        await app.call(as(AVA), "POST", "/cards", { kind: "virtual", accountId: sav.id }),
      );
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 5_000,
          mcc: "5411",
        }),
      );
      expect(a.approved).toBe(true);
      expect((await me()).accounts.find((x: any) => x.id === sav.id).availableCents).toBe(15_000);
      const env = body(
        await app.call(as(AVA), "POST", "/accounts", { kind: "envelope", endDate: "2026-12-01" }),
      );
      expect(
        body(await app.call(as(AVA), "POST", "/cards", { kind: "virtual", accountId: env.id }))
          .error.code,
      ).toBe("invalid_funding_account");
    });
  });

  describe("cashback", () => {
    it("credits 1% on capture and reverses it pro-rata on refund", async () => {
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
      expect(cap.cashbackCents).toBe(100); // 1% of 10,000
      expect((await acct()).postedCents).toBe(250_000 - 10_000 + 100);
      // full refund reverses the whole cashback
      const r = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: "cb_full",
          amountCents: 10_000,
        }),
      );
      expect(r.cashbackReversedCents).toBe(100);
      expect((await acct()).postedCents).toBe(250_000);
      expect(await trialBalance()).toBe(0);
    });
  });

  describe("Zelle bill pay", () => {
    it("sends one-time, pulling the shortfall from other pockets, and respects the transfer limit", async () => {
      const chk = await acct();
      const sav = await acct(AVA, "savings");
      // leave the source short: checking 50,000, savings 200,000
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 200_000,
      });
      const z = body(
        await app.call(as(AVA), "POST", "/zelle/payments", {
          fromAccountId: chk.id,
          recipient: { email: "landlord@example.com" },
          amountCents: 80_000,
        }),
      );
      expect(z.status).toBe("completed");
      expect(z.shortfallCents).toBe(30_000); // 50,000 from checking, 30,000 pulled from savings
      const after = await me();
      expect(after.accounts.find((a: any) => a.kind === "checking").postedCents).toBe(0);
      expect(after.accounts.find((a: any) => a.kind === "savings").postedCents).toBe(170_000);
      // a further 30,000 today breaches the tier1 daily transfer-out limit ($1,000 = 100,000c already 80,000)
      expect(
        body(
          await app.call(as(AVA), "POST", "/zelle/payments", {
            fromAccountId: chk.id,
            recipient: { email: "x@example.com" },
            amountCents: 30_000,
          }),
        ).error.code,
      ).toBe("daily_limit");
      expect(await trialBalance()).toBe(0);
    });

    it("rejects a send that exceeds every spendable pocket", async () => {
      const chk = await acct(BEN); // Ben has 50,000
      expect(
        body(
          await app.call(as(BEN), "POST", "/zelle/payments", {
            fromAccountId: chk.id,
            recipient: { email: "x@example.com" },
            amountCents: 50_001,
          }),
        ).error.code,
      ).toBe("insufficient_funds");
    });

    it("returns/refunds arrive as webhooks and reverse the credit into the source, once", async () => {
      const chk = await acct();
      const z = body(
        await app.call(as(AVA), "POST", "/zelle/payments", {
          fromAccountId: chk.id,
          recipient: { email: "landlord@example.com" },
          amountCents: 20_000,
        }),
      );
      expect((await acct()).postedCents).toBe(230_000);
      await app.call(as(ADMIN), "POST", `/admin/transfers/${z.id}/zelle-return`, {
        reason: "recipient_declined",
      });
      expect((await acct()).postedCents).toBe(250_000);
      expect(
        body(
          await app.call(as(ADMIN), "POST", `/admin/transfers/${z.id}/zelle-return`, {
            reason: "x",
          }),
        ).error.code,
      ).toBe("already_returned");
      expect(await trialBalance()).toBe(0);
    });

    it("recurring schedules send now and again when the job runs on the due date", async () => {
      const chk = await acct();
      const z = body(
        await app.call(as(AVA), "POST", "/zelle/payments", {
          fromAccountId: chk.id,
          recipient: { email: "gym@example.com" },
          amountCents: 5_000,
          frequency: "weekly",
        }),
      );
      expect(z.status).toBe("scheduled");
      expect(z.firstPaymentId).toBeTruthy();
      expect((await acct()).postedCents).toBe(245_000); // first payment sent immediately
      // not due yet
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/run-zelle")).sent).toBe(0);
      app.clock.advanceHours(24 * 7);
      expect(body(await app.call(as(ADMIN), "POST", "/admin/jobs/run-zelle")).sent).toBe(1);
      expect((await acct()).postedCents).toBe(240_000);
      expect((await me()).zelleSchedules).toHaveLength(1);
      expect(await trialBalance()).toBe(0);
    });
  });
});
