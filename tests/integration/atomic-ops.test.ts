// Atomic money operations: races, rollback and replay. Runs on the memory store and, with
// HARBOR_PG_URL set, on Postgres (SupabaseStore -> harbor_* SQL functions under row locks).
// Races are made deterministic with `race()`: the store operation is gated until every request
// has finished planning on the same state, so only the guards inside the atomic operation can
// stop the second write.
import { DEMO_USERS } from "../../supabase/functions/_shared/app/demo.ts";
import {
  MoneyOpError,
  uuid,
  type MoneyOps,
  type Store,
} from "../../supabase/functions/_shared/app/store.ts";
import { harnesses, type TestApp } from "./support/harness.ts";

const [AVA, BEN, , , , ADMIN] = DEMO_USERS;
const as = (u: { id: string; role: string }) => ({
  userId: u.id,
  role: u.role as "customer" | "admin" | "support_agent",
});
const body = (r: { body: unknown }) => r.body as any;

/** Hold calls to `store[op]` until `n` requests have planned, then release them together. */
function race(store: Store, op: keyof MoneyOps, n = 2) {
  const s = store as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = s[op];
  let queued: (() => void)[] = [];
  s[op] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      queued.push(() => {
        original.apply(store, args).then(resolve, reject);
      });
      if (queued.length === n) {
        const go = queued;
        queued = [];
        go.forEach((f) => f());
      }
    });
  return () => {
    s[op] = original;
  };
}

describe.each(harnesses().map((h) => [h.name, h] as const))("%s store", (_name, h) => {
  let app: TestApp;
  const me = async (u = AVA) => body(await app.call(as(u), "GET", "/me"));
  const pocket = async (u = AVA, kind = "checking") =>
    (await me(u)).accounts.find((a: any) => a.kind === kind);
  const trialBalance = async () =>
    (await app.store.ledger()).reduce((s, l) => s + l.debit - l.credit, 0);
  const codes = (rs: { status: number; body: unknown }[]) =>
    rs.map((r) => (r.status === 200 ? "ok" : body(r).error.code)).sort();
  const rejectsWith = async (p: Promise<unknown>, code: string) => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(MoneyOpError);
    expect((e as MoneyOpError).code).toBe(code);
  };

  beforeEach(async () => {
    app = await h.create(new Date("2026-09-21T15:00:00Z"));
  });
  afterAll(() => h.close());

  describe("races are decided under the account lock", () => {
    it("two withdrawals racing for the same money: exactly one posts", async () => {
      const bank = (await me(BEN)).banks[0];
      const w = (key: string) =>
        app.call(
          as(BEN),
          "POST",
          "/transfers/ach-out",
          { bankId: bank.id, amountCents: 30_000, speed: "standard" },
          { idempotencyKey: key },
        );
      const done = race(app.store, "achPush");
      const rs = await Promise.all([w("race-a"), w("race-b")]);
      done();
      expect(codes(rs)).toEqual(["insufficient_funds", "ok"]);
      expect((await pocket(BEN)).postedCents).toBe(20_000);
      expect(await trialBalance()).toBe(0);
    });

    it("two withdrawals racing for the daily limit: exactly one posts", async () => {
      const bank = (await me()).banks[0];
      const w = () =>
        app.call(as(AVA), "POST", "/transfers/ach-out", {
          bankId: bank.id,
          amountCents: 60_000,
          speed: "standard",
        });
      const done = race(app.store, "achPush");
      const rs = await Promise.all([w(), w()]);
      done();
      expect(codes(rs)).toEqual(["daily_limit", "ok"]);
      expect((await pocket()).postedCents).toBe(190_000);
    });

    it("two card authorizations racing for the same balance: one hold, one decline", async () => {
      const card = body(await app.call(as(BEN), "POST", "/cards", { kind: "virtual" }));
      const auth = () =>
        app.call(as(BEN), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 40_000,
          mcc: "5411",
          merchant: "Grocer",
        });
      const done = race(app.store, "cardAuthorize");
      const rs = (await Promise.all([auth(), auth()])).map(body);
      done();
      expect(rs.map((r) => r.approved).sort()).toEqual([false, true]);
      expect(rs.find((r) => !r.approved).reason).toBe("insufficient_funds");
      const chk = await pocket(BEN);
      expect([chk.postedCents, chk.holdsCents, chk.availableCents]).toEqual([
        50_000, 40_000, 10_000,
      ]);
    });

    it("double capture: one wins and the ledger matches what the auth says was captured", async () => {
      const card = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 5_000,
          mcc: "5812",
          merchant: "Cafe",
        }),
      );
      const cap = (cents: number) =>
        app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
          amountCents: cents,
        });
      const done = race(app.store, "cardCapture");
      const rs = await Promise.all([cap(5_000), cap(5_900)]);
      done();
      expect(codes(rs)).toEqual(["capture_rejected", "ok"]);
      const auth = (await me()).authorizations.find((x: any) => x.id === a.authorizationId);
      expect(auth.status).toBe("captured");
      expect((await pocket()).postedCents).toBe(250_000 - Number(auth.captured_cents));
      expect((await pocket()).holdsCents).toBe(0);
    });

    it("concurrent merchant refunds never exceed the captured amount", async () => {
      const card = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 5_000,
          mcc: "5411",
          merchant: "Shop",
        }),
      );
      await app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/capture`, {
        amountCents: 5_000,
      });
      const refund = (id: string) =>
        app.call(as(AVA), "POST", `/sim/authorizations/${a.authorizationId}/refund`, {
          refundId: id,
          amountCents: 3_000,
        });
      const done = race(app.store, "cardRefund");
      const rs = await Promise.all([refund("re_a"), refund("re_b")]);
      done();
      expect(codes(rs)).toEqual(["ok", "refund_rejected"]);
      expect((await pocket()).postedCents).toBe(250_000 - 5_000 + 3_000);
      expect(await trialBalance()).toBe(0);
    });
  });

  describe("an operation that fails writes nothing", () => {
    it("closure whose payout would leave a cent behind rolls back every step (cards, ledger, transfer, accounts)", async () => {
      const before = await me();
      const chk = before.accounts.find((a: any) => a.kind === "checking");
      const sav = before.accounts.find((a: any) => a.kind === "savings");
      const lines = (await app.store.ledger()).length;
      const short = chk.postedCents - 1;
      const closureId = uuid();
      const at = app.clock.now().toISOString();
      await rejectsWith(
        app.store.closeAccount({
          userId: AVA.id,
          closure: {
            id: closureId,
            user_id: AVA.id,
            payout_cents: short,
            linked_bank_id: before.banks[0].id,
            status: "completed",
            blocks: [],
          },
          expected: {
            accounts: [
              { id: chk.id, postedCents: chk.postedCents },
              { id: sav.id, postedCents: 0 },
            ],
            members: [],
          },
          ledger: {
            kind: "closure_payout",
            ref: closureId,
            idem: `closure:${closureId}`,
            lines: [
              { account: "customer_deposits", party: chk.id, debit: short, credit: 0 },
              { account: "closure_payout", debit: 0, credit: short },
            ],
          },
          payoutTransfer: {
            id: uuid(),
            user_id: AVA.id,
            kind: "closure_payout",
            speed: null,
            from_account_id: chk.id,
            to_account_id: null,
            linked_bank_id: before.banks[0].id,
            counterparty_user_id: null,
            family_member_id: null,
            amount_cents: short,
            fee_cents: 0,
            status: "pending",
            settle_at: null,
            return_code: null,
            new_payee: false,
            policy_version: 1,
            fee_version: 1,
            idempotency_key: null,
            created_at: at,
            settled_at: null,
          },
          at,
          actorId: AVA.id,
          audit: { payoutCents: short },
        }),
        "payload_mismatch",
      );
      const after = await me();
      expect(after.cards.map((c: any) => c.status)).toEqual(["active"]);
      expect(after.accounts.map((a: any) => a.status)).toEqual(["open", "open"]);
      expect(after.accounts.find((a: any) => a.kind === "checking").postedCents).toBe(
        chk.postedCents,
      );
      expect(after.transfers.some((t: any) => t.kind === "closure_payout")).toBe(false);
      expect((await app.store.ledger()).length).toBe(lines);
      // The real closure still works afterwards.
      expect(body(await app.call(as(AVA), "POST", "/accounts/close", {})).payoutCents).toBe(
        250_000,
      );
    });

    it("closure planned before money moved is refused (closure_state_changed) and changes nothing", async () => {
      const before = await me(BEN);
      const chk = before.accounts.find((a: any) => a.kind === "checking");
      const sav = before.accounts.find((a: any) => a.kind === "savings");
      const closureId = uuid();
      await rejectsWith(
        app.store.closeAccount({
          userId: BEN.id,
          closure: {
            id: closureId,
            user_id: BEN.id,
            payout_cents: 40_000,
            linked_bank_id: before.banks[0].id,
            status: "completed",
            blocks: [],
          },
          expected: {
            accounts: [
              { id: chk.id, postedCents: 40_000 },
              { id: sav.id, postedCents: 0 },
            ],
            members: [],
          }, // stale: Ben has 50,000
          ledger: null,
          payoutTransfer: null,
          at: app.clock.now().toISOString(),
          actorId: BEN.id,
          audit: {},
        }),
        "closure_state_changed",
      );
      expect((await pocket(BEN)).status).toBe("open");
    });

    it("dispute resolution planned on a stale status is refused", async () => {
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
          reason: "never arrived",
        }),
      );
      await app.call(as(ADMIN), "POST", `/admin/disputes/${d.id}/provisional-credit`);
      // A "won" plan made while the dispute was still open would credit the customer a second time.
      await rejectsWith(
        app.store.disputeResolve({
          disputeId: d.id,
          outcome: "won",
          expectedStatus: "open",
          provisionalCreditCents: 0,
          ledger: {
            kind: "dispute_won",
            ref: d.id,
            idem: `dispute_resolve:${d.id}`,
            lines: [
              { account: "card_settlement", debit: 3_000, credit: 0 },
              { account: "customer_deposits", party: (await pocket()).id, debit: 0, credit: 3_000 },
            ],
          },
          at: app.clock.now().toISOString(),
          actorId: ADMIN.id,
        }),
        "invalid_state",
      );
      expect((await pocket()).postedCents).toBe(250_000);
      expect(
        body(
          await app.call(as(ADMIN), "POST", `/admin/disputes/${d.id}/resolve`, { outcome: "won" }),
        ).status,
      ).toBe("won");
      expect((await pocket()).postedCents).toBe(250_000);
      expect(await trialBalance()).toBe(0);
    });
  });

  describe("replays post once", () => {
    it("the same withdrawal (same transfer id) replayed posts one debit", async () => {
      const chk = await pocket();
      const bank = (await me()).banks[0];
      const at = app.clock.now().toISOString();
      const id = uuid();
      const op = () =>
        app.store.achPush({
          transfer: {
            id,
            user_id: AVA.id,
            kind: "ach_out",
            speed: "instant",
            from_account_id: chk.id,
            to_account_id: null,
            linked_bank_id: bank.id,
            counterparty_user_id: null,
            family_member_id: null,
            amount_cents: 10_000,
            fee_cents: 150,
            status: "completed",
            settle_at: null,
            return_code: null,
            new_payee: false,
            policy_version: 1,
            fee_version: 1,
            idempotency_key: null,
            created_at: at,
            settled_at: null,
          },
          ledger: {
            kind: "ach_out_instant",
            ref: id,
            idem: `transfer:${id}`,
            lines: [
              { account: "customer_deposits", party: chk.id, debit: 10_150, credit: 0 },
              { account: "ach_clearing", debit: 0, credit: 10_000 },
              { account: "fee_revenue", debit: 0, credit: 150 },
            ],
          },
          limit: null,
          at,
        });
      expect(await op()).toEqual({ replayed: false });
      expect(await op()).toEqual({ replayed: true });
      expect((await pocket()).postedCents).toBe(250_000 - 10_150);
    });

    it("settle, expire, refund and interest posting are no-ops the second time", async () => {
      const at = app.clock.now().toISOString();
      const bank = (await me()).banks[0];
      const dep = body(
        await app.call(as(AVA), "POST", "/transfers/ach-in", {
          bankId: bank.id,
          amountCents: 1_000,
        }),
      );
      app.clock.advanceHours(24 * 5);
      const later = app.clock.now().toISOString();
      expect(await app.store.achSettle({ transferId: dep.id, at: later })).toBe(true);
      expect(await app.store.achSettle({ transferId: dep.id, at: later })).toBe(false);

      const card = (await me()).cards[0];
      const a = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 2_000,
          mcc: "5411",
        }),
      );
      expect(await app.store.cardExpireAuth({ authId: a.authorizationId, at: later })).toBe(false); // still valid
      app.clock.advanceHours(24 * 8);
      const expiredAt = app.clock.now().toISOString();
      expect(await app.store.cardExpireAuth({ authId: a.authorizationId, at: expiredAt })).toBe(
        true,
      );
      expect(await app.store.cardExpireAuth({ authId: a.authorizationId, at: expiredAt })).toBe(
        false,
      );

      const b = body(
        await app.call(as(AVA), "POST", `/sim/cards/${card.id}/authorize`, {
          amountCents: 2_000,
          mcc: "5411",
        }),
      );
      await app.call(as(AVA), "POST", `/sim/authorizations/${b.authorizationId}/capture`, {
        amountCents: 2_000,
      });
      const chk = await pocket();
      const refund = () =>
        app.store.cardRefund({
          refundId: "re_once",
          authId: b.authorizationId,
          amountCents: 500,
          at: expiredAt,
          ledger: {
            kind: "card_refund",
            ref: "re_once",
            idem: "refund:re_once",
            lines: [
              { account: "card_settlement", debit: 500, credit: 0 },
              { account: "customer_deposits", party: chk.id, debit: 0, credit: 500 },
            ],
          },
        });
      expect(await refund()).toEqual({ duplicate: false, refundedCents: 500 });
      expect(await refund()).toEqual({ duplicate: true, refundedCents: 500 });
      expect((await pocket()).postedCents).toBe(chk.postedCents + 500);

      const sav = await pocket(AVA, "savings");
      const posting = {
        account_id: sav.id,
        period: "2026-09",
        accrued_micro: 0,
        carry_in_micro: 0,
        posted_cents: 0,
        carry_out_micro: 0,
      };
      expect(await app.store.postInterest({ posting, ledger: null, at })).toBe(true);
      expect(await app.store.postInterest({ posting, ledger: null, at })).toBe(false);
      expect(await trialBalance()).toBe(0);
    });
  });
});
