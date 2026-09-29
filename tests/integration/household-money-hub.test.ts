import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA, BEN] = DEMO_USERS;
const ADMIN = DEMO_USERS.find((u) => u.role === "admin")!;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// The household money hub, end to end, on each store the suite runs against (memory always; Postgres
// through SupabaseStore + the harbor_* SQL functions when HARBOR_PG_URL is set).
describe.each(harnesses().map((h) => [h.name, h] as const))(
  "%s store — household money hub",
  (_n, h) => {
    let app: TestApp;
    const me = async (u = AVA) => body(await app.call(as(u), "GET", "/me"));
    const checking = async (u = AVA) =>
      (await me(u)).accounts.find((a: any) => a.kind === "checking");
    const accountById = async (id: string, u = AVA) =>
      (await me(u)).accounts.find((a: any) => a.id === id);
    const trialBalance = async () =>
      body(await app.call(as(ADMIN), "GET", "/admin/ledger")).trialBalanceCents;

    beforeEach(async () => {
      app = await h.create(new Date("2026-09-21T15:00:00Z")); // Monday; seed then advances the clock 7d
    });
    afterAll(() => h.close());

    it("opens accounts on demand, moves money instantly between them, and auto-closes an envelope", async () => {
      const today = app.clock.now();
      const env = body(
        await app.call(as(AVA), "POST", "/accounts", {
          kind: "envelope",
          nickname: "Vacation",
          startDate: iso(today),
          endDate: iso(today),
        }),
      );
      expect(env.kind).toBe("envelope");

      const chk = await checking();
      // Instant internal transfer checking -> envelope.
      const t = body(
        await app.call(as(AVA), "POST", "/transfers/internal", {
          fromAccountId: chk.id,
          toAccountId: env.id,
          amountCents: 10_000,
        }),
      );
      expect(t.status).toBe("completed");
      expect((await accountById(env.id))!.availableCents).toBe(10_000);
      expect((await checking()).availableCents).toBe(240_000);

      // Before the end date passes, the sweep job leaves it open.
      await app.call(as(ADMIN), "POST", "/admin/jobs/sweep-envelopes");
      expect((await accountById(env.id))!.status).toBe("open");

      // After the end date, the envelope auto-closes and its balance sweeps back to checking.
      app.clock.advanceHours(48);
      const r = body(await app.call(as(ADMIN), "POST", "/admin/jobs/sweep-envelopes"));
      expect(r.closed).toBeGreaterThanOrEqual(1);
      expect(r.sweptCents).toBe(10_000);
      expect(await accountById(env.id)).toBeUndefined(); // closed pockets drop out
      expect((await checking()).availableCents).toBe(250_000);
      expect(await trialBalance()).toBe(0);
    });

    it("instant internal transfer moves funds between the user's own pockets immediately", async () => {
      const chk = await checking();
      const sav = (await me()).accounts.find((a: any) => a.kind === "savings");
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 5_000,
      });
      expect((await checking()).availableCents).toBe(245_000);
      expect((await accountById(sav.id))!.availableCents).toBe(5_000);
      // Cannot move to an account that isn't yours.
      const benSav = (await me(BEN)).accounts.find((a: any) => a.kind === "savings");
      expect(
        (
          await app.call(as(AVA), "POST", "/transfers/internal", {
            fromAccountId: chk.id,
            toAccountId: benSav.id,
            amountCents: 100,
          })
        ).status,
      ).toBe(404);
    });

    it("Zelle send pulls the shortfall from other accounts, and a return reverses it", async () => {
      const chk = await checking();
      const sav = (await me()).accounts.find((a: any) => a.kind === "savings");
      // Leave only 500 in checking so a 5,000 send must pull 4,500 from savings.
      await app.call(as(AVA), "POST", "/transfers/internal", {
        fromAccountId: chk.id,
        toAccountId: sav.id,
        amountCents: 249_500,
      });
      const pay = body(
        await app.call(as(AVA), "POST", "/transfers/zelle", {
          recipient: "landlord@example.com",
          amountCents: 5_000,
        }),
      );
      expect(pay.frequency).toBe("once");
      expect(pay.payment.pulledFromOtherAccounts).toBe(true);
      expect(pay.payment.fundedFrom).toEqual([
        { accountId: chk.id, cents: 500 },
        { accountId: sav.id, cents: 4_500 },
      ]);
      expect((await checking()).postedCents).toBe(0);
      expect((await accountById(sav.id))!.postedCents).toBe(245_000);
      expect(await trialBalance()).toBe(0);

      // A Zelle return webhook (admin/simulated) reverses each contribution to its account.
      await app.call(as(ADMIN), "POST", `/admin/zelle/${pay.payment.id}/return`, { reason: "R01" });
      expect((await checking()).postedCents).toBe(500);
      expect((await accountById(sav.id))!.postedCents).toBe(249_500);
      expect(await trialBalance()).toBe(0);
      // Returning twice is refused.
      expect(
        (
          await app.call(as(ADMIN), "POST", `/admin/zelle/${pay.payment.id}/return`, {
            reason: "R01",
          })
        ).status,
      ).toBe(409);
    });

    it("recurring Zelle sends the first payment now and the next when the job runs", async () => {
      const r = body(
        await app.call(as(AVA), "POST", "/transfers/zelle", {
          recipient: "gym@example.com",
          amountCents: 1_000,
          frequency: "weekly",
        }),
      );
      expect(r.scheduleId).toBeTruthy();
      expect((await me()).zellePayments).toHaveLength(1); // first one goes out immediately

      // Not due yet: the job sends nothing.
      await app.call(as(ADMIN), "POST", "/admin/jobs/zelle-recurring");
      expect((await me()).zellePayments).toHaveLength(1);

      // A week later the schedule is due and the job sends the next one.
      app.clock.advanceHours(24 * 7);
      const j = body(await app.call(as(ADMIN), "POST", "/admin/jobs/zelle-recurring"));
      expect(j.ran).toBeGreaterThanOrEqual(1);
      expect((await me()).zellePayments).toHaveLength(2);
    });

    it("invites a household member, issues a card on the shared account, and enforces the household cap", async () => {
      await app.call(as(AVA), "POST", "/household", { name: "Harbor House" });
      await app.call(as(AVA), "POST", "/household/invite", { email: "ben@harbor.test" });
      await app.call(as(BEN), "POST", "/household/accept", {});
      const households = (await me(BEN)).households;
      expect(
        households.some((x: any) => x.name === "Harbor House" && x.myStatus === "active"),
      ).toBe(true);

      // Ben gets a card on Ava's shared checking account (held by Ben, funded from Ava's pocket).
      const avaChk = await checking(AVA);
      const shared = body(
        await app.call(as(BEN), "POST", "/cards", { kind: "virtual", accountId: avaChk.id }),
      );
      expect(shared.holder_user_id).toBe(BEN.id);
      expect(shared.account_id).toBe(avaChk.id);

      // A 5,000 household cap: spend across all members' cards can't exceed it.
      await app.call(as(AVA), "POST", "/household/cap", { monthlyCapCents: 5_000 });
      const avaCard = (await me(AVA)).cards.find(
        (c: any) => c.holder_user_id === AVA.id && c.family_member_id == null,
      );
      const a1 = body(
        await app.call(as(BEN), "POST", `/sim/cards/${shared.id}/authorize`, {
          amountCents: 3_000,
          mcc: "5411",
        }),
      );
      expect(a1.approved).toBe(true);
      // Household spend is now 3,000; another 3,000 would reach 6,000 > 5,000.
      const a2 = body(
        await app.call(as(AVA), `POST`, `/sim/cards/${avaCard.id}/authorize`, {
          amountCents: 3_000,
          mcc: "5411",
        }),
      );
      expect(a2.approved).toBe(false);
      expect(a2.reason).toBe("household_monthly_cap");
    });

    it("applies per-card spend limits set at issuance", async () => {
      const card = body(
        await app.call(as(AVA), "POST", "/cards", {
          kind: "virtual",
          limits: { perTxnCents: 1_000, dailyCents: 2_000, monthlyCents: 5_000 },
        }),
      );
      const auth = async (amountCents: number) =>
        body(
          await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
            amountCents,
            mcc: "5411",
          }),
        );
      expect((await auth(1_001)).reason).toBe("card_per_txn_limit");
      expect((await auth(1_000)).approved).toBe(true);
      expect((await auth(1_000)).approved).toBe(true); // daily total now exactly 2,000
      expect((await auth(1)).reason).toBe("card_daily_limit");
    });

    it("credits 1% cashback on capture and reverses it on refund", async () => {
      const card = (await me()).cards.find(
        (c: any) => c.holder_user_id === AVA.id && c.family_member_id == null,
      );
      const before = (await checking()).postedCents; // 250,000
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
      expect((await checking()).postedCents).toBe(before - 10_000 + 100);

      const r = body(
        await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: "rf_1",
          amountCents: 10_000,
        }),
      );
      expect(r.cashbackReversedCents).toBe(100);
      // Fully refunded: the 10,000 comes back and the 100 cashback is reversed out.
      expect((await checking()).postedCents).toBe(before);
      expect(await trialBalance()).toBe(0);
    });
  },
);
