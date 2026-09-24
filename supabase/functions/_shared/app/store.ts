// Persistence port used by the service. Rows are snake_case and match the SQL tables 1:1,
// so the same service runs on Postgres (SupabaseStore, api Edge Function) and in memory
// (MemoryStore: unit/integration tests and the browser demo mode).
//
// Money operations that write more than one row go through `MoneyOps`: each is ONE Postgres
// function (migration 20260924000004_atomic_money_ops.sql) called via RPC, so it commits or
// rolls back as a whole, and it re-checks under row locks the guards that a concurrent request
// could invalidate (state compare-and-set, available balance, refund bounds, closure
// preconditions). MemoryStore implements the same operations with the same guards and rolls
// back every write of an operation that throws.

import { assertBalanced, type LedgerAccount, type Txn } from "../domain/ledger.ts";
import type { LimitWindow } from "../domain/limits.ts";

export type Row = Record<string, any>;

export interface LedgerRow { txn_id: string; kind: string; ref: string | null; at: string; account: string; party: string | null; debit: number; credit: number }

/** A ledger txn plus the idempotency key it posts under (the same key posts at most once). */
export interface LedgerPost extends Txn { idem: string }

export type MoneyOpCode =
  | "not_found" | "invalid_state" | "insufficient_funds" | "already_returned" | "auth_expired"
  | "refund_exceeds_captured" | "refund_id_conflict" | "dispute_already_open" | "dispute_exceeds_amount"
  | "already_closed" | "closure_state_changed" | "daily_limit" | "monthly_limit" | "unbalanced_ledger" | "payload_mismatch";

/** A guard inside an atomic money operation failed. Nothing was written. */
export class MoneyOpError extends Error {
  constructor(public code: MoneyOpCode, message?: string) { super(message ?? code); }
}

export interface ClosureExpectation { accounts: { id: string; postedCents: number }[]; members: { id: string; postedCents: number }[] }

export interface MoneyOps {
  /** ACH pull: pending transfer + immediate credit + deposit hold until settlement (daily deposit limit re-checked). */
  achPullCreate(p: { transfer: Row; ledger: LedgerPost; hold: Row; limit: LimitWindow | null; at: string }): Promise<{ replayed: boolean }>;
  /** Settle one due pending transfer and release its deposit hold. false = nothing to settle. */
  achSettle(p: { transferId: string; at: string }): Promise<boolean>;
  /** ACH return: reversal/claw-back txn, release an active deposit hold, transfer -> returned, audit. */
  achReturn(p: { transferId: string; code: string; ledger: LedgerPost; at: string; actorId: string | null; audit: Row }): Promise<{ releasedHolds: number }>;
  /** Withdrawal to a linked bank (standard, or instant + fee), guarded by available >= amount + fee and the transfer-out limit. */
  achPush(p: { transfer: Row; ledger: LedgerPost; limit: LimitWindow | null; at: string }): Promise<{ replayed: boolean }>;
  /** P2P: transfer + ledger + first-payment payee record, guarded by the sender's available balance and limit. */
  p2pTransfer(p: { transfer: Row; ledger: LedgerPost; payee: Row | null; limit: LimitWindow | null; at: string }): Promise<{ replayed: boolean }>;
  /** Checking <-> savings. */
  pocketMove(p: { transfer: Row; ledger: LedgerPost; at: string }): Promise<{ replayed: boolean }>;
  /** Owner checking -> teen allowance pocket. */
  allowanceTopUp(p: { transfer: Row; ledger: LedgerPost; at: string }): Promise<{ replayed: boolean }>;
  /** Record an authorization; with a hold, re-check the funding pocket (else record a decline). */
  cardAuthorize(p: { auth: Row; hold: Row | null; at: string }): Promise<{ approved: boolean; reason: string | null; holdId: string | null; replayed: boolean }>;
  /** Capture (partial / over-capture within tolerance): ledger + hold consumed + auth captured. */
  cardCapture(p: { authId: string; capturedCents: number; feeCents: number; ledger: LedgerPost; at: string }): Promise<void>;
  /** Expire an uncaptured auth past its validity and release its hold. false = not expirable. */
  cardExpireAuth(p: { authId: string; at: string }): Promise<boolean>;
  /** Merchant refund, once per refund id, never above captured - refunded. */
  cardRefund(p: { refundId: string; authId: string; amountCents: number; ledger: LedgerPost; at: string }): Promise<{ duplicate: boolean; refundedCents: number }>;
  /** Open a dispute on a captured purchase (one open dispute per purchase). Returns the row. */
  disputeOpen(p: { dispute: Row; at: string }): Promise<Row>;
  /** Provisional credit: ledger + dispute -> provisional_credited. */
  disputeProvisionalCredit(p: { disputeId: string; ledger: LedgerPost; at: string }): Promise<void>;
  /** Resolve won/lost from the status the plan was computed on; lost reverses provisional credit. */
  disputeResolve(p: { disputeId: string; outcome: "won" | "lost"; expectedStatus: string; provisionalCreditCents: number; ledger: LedgerPost | null; at: string; actorId: string | null }): Promise<void>;
  /** Monthly savings interest: posting row + ledger, once per account and period. false = already posted. */
  postInterest(p: { posting: Row; ledger: LedgerPost | null; at: string }): Promise<boolean>;
  /** Close: cancel cards, pay out all pockets in one txn, payout transfer, close accounts, remove members, closure row, audit. */
  closeAccount(p: { userId: string; closure: Row; expected: ClosureExpectation; ledger: LedgerPost | null; payoutTransfer: Row | null; at: string; actorId: string | null; audit: Row }): Promise<{ canceledCardIds: string[] }>;
}

export interface Store extends MoneyOps {
  insert(table: string, row: Row): Promise<Row>;
  update(table: string, match: Row, patch: Row): Promise<void>;
  one(table: string, match: Row): Promise<Row | undefined>;
  list(table: string, match?: Row): Promise<Row[]>;
  /** Post a balanced txn atomically. Same idempotency key => same txn id, no new lines. */
  postLedger(t: Txn, idempotencyKey?: string): Promise<string>;
  ledger(filter?: { account?: string; party?: string; limit?: number }): Promise<LedgerRow[]>;
}

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

const matches = (r: Row, m?: Row) => !m || Object.entries(m).every(([k, v]) => r[k] === v);

/** Net debit (debits - credits) a ledger payload posts to one (account, party). */
export function netDebit(t: Txn | null | undefined, account: LedgerAccount, party: string | null): number {
  let n = 0;
  for (const l of t?.lines ?? []) if (l.account === account && (l.party ?? null) === party) n += l.debit - l.credit;
  return n;
}

const fail = (code: MoneyOpCode, message?: string): never => { throw new MoneyOpError(code, message); };

type TxnRec = { id: string; kind: string; ref: string | null; idempotency_key: string | null; created_at: string };
type LineRec = { txn_id: string; account: string; party: string | null; debit: number; credit: number };

export class MemoryStore implements Store {
  tables: Record<string, Row[]> = {};
  txns: TxnRec[] = [];
  lines: LineRec[] = [];
  constructor(private clock: () => Date = () => new Date()) {}

  // ---------- synchronous primitives (an operation never awaits, so it can't interleave) ----------
  private t(name: string) { return (this.tables[name] ??= []); }

  private put(table: string, row: Row): Row {
    const r: Row = { id: uuid(), created_at: this.clock().toISOString(), ...row };
    const rows = this.t(table);
    if (rows.some((x) => x.id === r.id)) throw new Error(`duplicate key value violates unique constraint "${table}_pkey"`);
    if (table === "transfers" && r.idempotency_key != null && rows.some((x) => x.idempotency_key === r.idempotency_key)) {
      throw new Error('duplicate key value violates unique constraint "transfers_idempotency_key_key"');
    }
    rows.push(r);
    return r;
  }

  private patch(table: string, match: Row, patch: Row): number {
    let n = 0;
    for (const r of this.t(table)) if (matches(r, match)) { Object.assign(r, patch); n++; }
    return n;
  }

  /** Live row (not a copy): only for use inside `tx`. */
  private row(table: string, match: Row): Row | undefined {
    return this.t(table).find((x) => matches(x, match));
  }

  private post(t: LedgerPost, at: string): string {
    const prev = this.txns.find((x) => x.idempotency_key === t.idem);
    if (prev) return prev.id;
    if (!t.lines.length) fail("unbalanced_ledger", `ledger txn ${t.kind} has no lines`);
    try { assertBalanced(t); } catch (e) { fail("unbalanced_ledger", (e as Error).message); }
    const id = uuid();
    this.txns.push({ id, kind: t.kind, ref: t.ref ?? null, idempotency_key: t.idem, created_at: at });
    for (const l of t.lines) this.lines.push({ txn_id: id, account: l.account, party: l.party ?? null, debit: l.debit, credit: l.credit });
    return id;
  }

  private posted(account: "customer_deposits" | "family_allowance", party: string): number {
    let b = 0;
    for (const l of this.lines) if (l.account === account && l.party === party) b += l.credit - l.debit;
    return b;
  }

  private activeHolds(pred: (h: Row) => boolean, at: string): number {
    const now = new Date(at).getTime();
    let s = 0;
    for (const h of this.t("holds")) {
      if (h.status === "active" && (!h.expires_at || new Date(h.expires_at).getTime() > now) && pred(h)) s += Number(h.amount_cents);
    }
    return s;
  }

  private available(accountId: string, at: string): number {
    return this.posted("customer_deposits", accountId) - this.activeHolds((h) => h.account_id === accountId, at);
  }

  private allowanceAvailable(memberId: string, at: string): number {
    return this.posted("family_allowance", memberId) - this.activeHolds((h) => h.account_id == null && h.family_member_id === memberId, at);
  }

  /** Re-check a tier limit window (mirrors harbor__check_limit and domain/limits.ts usage). */
  private checkLimit(userId: string, limit: LimitWindow | null, amount: number, at: string) {
    if (!limit) return;
    const kinds = limit.kind === "transfer_out" ? ["ach_out", "p2p"] : limit.kind === "ach_in" ? ["ach_in"] : fail("payload_mismatch", `unknown limit kind ${limit.kind}`);
    const now = new Date(at).getTime(), day = limit.dayStart.getTime(), month = limit.monthStart.getTime();
    let today = 0, mon = 0;
    for (const t of this.t("transfers")) {
      if (t.user_id !== userId || !kinds.includes(t.kind) || t.status === "failed" || (t.kind === "ach_in" && t.status === "returned")) continue;
      const ts = new Date(t.created_at).getTime();
      if (ts > now) continue;
      if (ts >= day) today += Number(t.amount_cents);
      if (ts >= month) mon += Number(t.amount_cents);
    }
    if (today + amount > limit.dailyCents) fail("daily_limit", `daily limit ${limit.dailyCents}: used ${today}, requested ${amount}`);
    if (mon + amount > limit.monthlyCents) fail("monthly_limit", `monthly limit ${limit.monthlyCents}: used ${mon}, requested ${amount}`);
  }

  /** Run one operation all-or-nothing: any throw restores every table, txn and line. */
  private tx<T>(fn: () => T): Promise<T> {
    const snap = structuredClone({ tables: this.tables, txns: this.txns, lines: this.lines });
    try {
      return Promise.resolve(fn());
    } catch (e) {
      this.tables = snap.tables; this.txns = snap.txns; this.lines = snap.lines;
      return Promise.reject(e);
    }
  }

  // ---------- generic Store ----------
  async insert(table: string, row: Row) {
    return { ...this.put(table, row) };
  }
  async update(table: string, match: Row, patch: Row) {
    this.patch(table, match, patch);
  }
  async one(table: string, match: Row) {
    const r = this.row(table, match);
    return r ? { ...r } : undefined;
  }
  async list(table: string, match?: Row) {
    return this.t(table).filter((x) => matches(x, match)).map((x) => ({ ...x }));
  }
  async postLedger(t: Txn, idempotencyKey?: string) {
    if (idempotencyKey) {
      const prev = this.txns.find((x) => x.idempotency_key === idempotencyKey);
      if (prev) return prev.id;
    }
    assertBalanced(t);
    const id = uuid();
    this.txns.push({ id, kind: t.kind, ref: t.ref ?? null, idempotency_key: idempotencyKey ?? null, created_at: this.clock().toISOString() });
    for (const l of t.lines) this.lines.push({ txn_id: id, account: l.account, party: l.party ?? null, debit: l.debit, credit: l.credit });
    return id;
  }
  async ledger(filter: { account?: string; party?: string; limit?: number } = {}) {
    const byId = new Map(this.txns.map((t) => [t.id, t]));
    const out = this.lines
      .filter((l) => (!filter.account || l.account === filter.account) && (!filter.party || l.party === filter.party))
      .map((l) => { const t = byId.get(l.txn_id)!; return { ...l, kind: t.kind, ref: t.ref, at: t.created_at }; });
    return filter.limit ? out.slice(-filter.limit) : out;
  }
  toJSON() { return { tables: this.tables, txns: this.txns, lines: this.lines }; }
  load(data: { tables: Record<string, Row[]>; txns: MemoryStore["txns"]; lines: MemoryStore["lines"] }) {
    this.tables = data.tables; this.txns = data.txns; this.lines = data.lines;
  }

  // ---------- atomic money operations (mirror the SQL functions guard for guard) ----------
  private transferOut(kind: string, transfer: Row, ledger: LedgerPost, limit: LimitWindow | null, at: string): { replayed: boolean } {
    if (transfer.kind !== kind) fail("payload_mismatch", `expected a ${kind} transfer, got ${transfer.kind}`);
    if (this.row("transfers", { id: transfer.id })) return { replayed: true };
    const need = Number(transfer.amount_cents) + Number(transfer.fee_cents ?? 0);
    const debited = netDebit(ledger, "customer_deposits", transfer.from_account_id);
    if (debited !== need) fail("payload_mismatch", `ledger debits ${debited} from the source account, transfer amount + fee is ${need}`);
    if (!this.row("accounts", { id: transfer.from_account_id })) fail("not_found", "source account not found");
    this.checkLimit(transfer.user_id, limit, Number(transfer.amount_cents), at);
    const avail = this.available(transfer.from_account_id, at);
    if (need > avail) fail("insufficient_funds", `available ${avail}, needed ${need}`);
    this.put("transfers", { fee_cents: 0, new_payee: false, created_at: at, ...transfer });
    this.post(ledger, at);
    return { replayed: false };
  }

  achPullCreate(p: { transfer: Row; ledger: LedgerPost; hold: Row; limit: LimitWindow | null; at: string }) {
    return this.tx(() => {
      const { transfer: t, hold } = p;
      if (t.kind !== "ach_in") fail("payload_mismatch", "not an ACH pull");
      if (this.row("transfers", { id: t.id })) return { replayed: true };
      const amount = Number(t.amount_cents);
      if (netDebit(p.ledger, "customer_deposits", t.to_account_id) !== -amount || Number(hold.amount_cents) !== amount || hold.ref_id !== t.id || hold.account_id !== t.to_account_id) {
        fail("payload_mismatch", "ACH pull credit, deposit hold and transfer must agree");
      }
      if (!this.row("accounts", { id: t.to_account_id })) fail("not_found", "destination account not found");
      this.checkLimit(t.user_id, p.limit, amount, p.at);
      this.put("transfers", { fee_cents: 0, new_payee: false, created_at: p.at, ...t });
      this.post(p.ledger, p.at);
      this.put("holds", { status: "active", created_at: p.at, ...hold });
      return { replayed: false };
    });
  }

  achSettle(p: { transferId: string; at: string }) {
    return this.tx(() => {
      const t = this.row("transfers", { id: p.transferId, status: "pending" });
      if (!t || !t.settle_at || new Date(t.settle_at).getTime() > new Date(p.at).getTime()) return false;
      Object.assign(t, { status: "settled", settled_at: p.at });
      this.patch("holds", { ref_id: p.transferId, status: "active" }, { status: "released", released_at: p.at });
      return true;
    });
  }

  achReturn(p: { transferId: string; code: string; ledger: LedgerPost; at: string; actorId: string | null; audit: Row }) {
    return this.tx(() => {
      const t = this.row("transfers", { id: p.transferId });
      if (!t || t.kind !== "ach_in") return fail("not_found", "ACH deposit not found");
      if (t.status === "returned") fail("already_returned", `already returned (${t.return_code})`);
      if (netDebit(p.ledger, "customer_deposits", t.to_account_id) !== Number(t.amount_cents)) fail("payload_mismatch", "a return reverses exactly the deposited amount");
      this.post(p.ledger, p.at);
      const releasedHolds = this.patch("holds", { ref_id: p.transferId, status: "active" }, { status: "released", released_at: p.at });
      Object.assign(t, { status: "returned", return_code: p.code });
      this.put("audit_log", { actor_id: p.actorId, action: "ach_return", entity: "transfer", entity_id: p.transferId, reason: p.code, data: p.audit, created_at: p.at });
      return { releasedHolds };
    });
  }

  achPush(p: { transfer: Row; ledger: LedgerPost; limit: LimitWindow | null; at: string }) {
    return this.tx(() => {
      if (netDebit(p.ledger, "fee_revenue", null) !== -Number(p.transfer.fee_cents ?? 0)) fail("payload_mismatch", "fee revenue must equal the transfer fee");
      return this.transferOut("ach_out", p.transfer, p.ledger, p.limit, p.at);
    });
  }

  p2pTransfer(p: { transfer: Row; ledger: LedgerPost; payee: Row | null; limit: LimitWindow | null; at: string }) {
    return this.tx(() => {
      if (netDebit(p.ledger, "customer_deposits", p.transfer.to_account_id) !== -Number(p.transfer.amount_cents)) fail("payload_mismatch", "recipient must be credited the transfer amount");
      const r = this.transferOut("p2p", p.transfer, p.ledger, p.limit, p.at);
      if (p.payee && !r.replayed && !this.row("payees", { user_id: p.payee.user_id, payee_user_id: p.payee.payee_user_id })) {
        this.put("payees", { first_paid_at: p.at, ...p.payee });
      }
      return r;
    });
  }

  pocketMove(p: { transfer: Row; ledger: LedgerPost; at: string }) {
    return this.tx(() => {
      if (netDebit(p.ledger, "customer_deposits", p.transfer.to_account_id) !== -Number(p.transfer.amount_cents)) fail("payload_mismatch", "destination pocket must be credited the amount");
      return this.transferOut("pocket", p.transfer, p.ledger, null, p.at);
    });
  }

  allowanceTopUp(p: { transfer: Row; ledger: LedgerPost; at: string }) {
    return this.tx(() => {
      if (netDebit(p.ledger, "family_allowance", p.transfer.family_member_id) !== -Number(p.transfer.amount_cents)) fail("payload_mismatch", "allowance pocket must be credited the amount");
      return this.transferOut("allowance_topup", p.transfer, p.ledger, null, p.at);
    });
  }

  cardAuthorize(p: { auth: Row; hold: Row | null; at: string }) {
    return this.tx(() => {
      const { auth, hold } = p;
      const prev = this.t("card_authorizations").find((a) => a.id === auth.id || (auth.provider_auth_id != null && a.provider_auth_id === auth.provider_auth_id));
      if (prev) return { approved: prev.status !== "declined", reason: prev.decline_reason ?? null, holdId: prev.hold_id ?? null, replayed: true };
      const defaults = { fee_cents: 0, foreign_txn: false, atm_out_of_network: false, captured_cents: 0, refunded_cents: 0, created_at: p.at };
      if (!hold) {
        if (auth.status !== "declined") fail("payload_mismatch", "an approved authorization needs a hold");
        const a = this.put("card_authorizations", { ...defaults, ...auth });
        return { approved: false, reason: a.decline_reason ?? null, holdId: null, replayed: false };
      }
      const need = Number(hold.amount_cents);
      if (need !== Number(auth.amount_cents) + Number(auth.fee_cents ?? 0) || hold.ref_id !== auth.id) fail("payload_mismatch", "the hold must cover amount + fees of this authorization");
      let avail: number, reason: string;
      if (auth.funding_account === "family_allowance") {
        if (hold.family_member_id !== auth.funding_party || hold.account_id != null) fail("payload_mismatch", "allowance holds sit on the member pocket");
        avail = this.allowanceAvailable(auth.funding_party, p.at);
        reason = "allowance_exceeded";
      } else {
        if (hold.account_id !== auth.funding_party) fail("payload_mismatch", "card holds sit on the funding account");
        avail = this.available(auth.funding_party, p.at);
        reason = "insufficient_funds";
      }
      if (need > avail) {
        this.put("card_authorizations", { ...defaults, ...auth, status: "declined", decline_reason: reason, fee_cents: 0, hold_id: null, expires_at: p.at });
        return { approved: false, reason, holdId: null, replayed: false };
      }
      const h = this.put("holds", { status: "active", created_at: p.at, ...hold });
      this.put("card_authorizations", { ...defaults, ...auth, hold_id: h.id });
      return { approved: true, reason: null, holdId: h.id as string, replayed: false };
    });
  }

  cardCapture(p: { authId: string; capturedCents: number; feeCents: number; ledger: LedgerPost; at: string }) {
    return this.tx(() => {
      const a = this.row("card_authorizations", { id: p.authId });
      if (!a) return fail("not_found", "authorization not found");
      if (a.status !== "authorized") fail("invalid_state", `cannot capture a ${a.status} authorization`);
      if (new Date(a.expires_at).getTime() <= new Date(p.at).getTime()) fail("auth_expired", "authorization expired");
      if (p.capturedCents <= 0 || p.feeCents < 0 || netDebit(p.ledger, a.funding_account, a.funding_party) !== p.capturedCents + p.feeCents) {
        fail("payload_mismatch", "capture must debit the funding pocket captured + fees");
      }
      this.post(p.ledger, p.at);
      this.patch("holds", { id: a.hold_id }, { status: "captured", released_at: p.at });
      Object.assign(a, { status: "captured", captured_cents: p.capturedCents, fee_cents: p.feeCents, captured_at: p.at });
    });
  }

  cardExpireAuth(p: { authId: string; at: string }) {
    return this.tx(() => {
      const a = this.row("card_authorizations", { id: p.authId, status: "authorized" });
      if (!a || new Date(a.expires_at).getTime() > new Date(p.at).getTime()) return false;
      a.status = "expired";
      this.patch("holds", { id: a.hold_id }, { status: "expired", released_at: p.at });
      return true;
    });
  }

  cardRefund(p: { refundId: string; authId: string; amountCents: number; ledger: LedgerPost; at: string }) {
    return this.tx(() => {
      const a = this.row("card_authorizations", { id: p.authId });
      if (!a) return fail("not_found", "authorization not found");
      const prev = this.row("card_refunds", { id: p.refundId });
      if (prev) {
        if (prev.auth_id !== p.authId) fail("refund_id_conflict", "refund id already used for another purchase");
        return { duplicate: true, refundedCents: Number(a.refunded_cents) };
      }
      if (a.status !== "captured") fail("invalid_state", "refund requires a captured purchase");
      if (p.amountCents <= 0 || Number(a.refunded_cents) + p.amountCents > Number(a.captured_cents)) {
        fail("refund_exceeds_captured", `captured ${a.captured_cents}, refunded ${a.refunded_cents}, requested ${p.amountCents}`);
      }
      if (netDebit(p.ledger, a.funding_account, a.funding_party) !== -p.amountCents) fail("payload_mismatch", "refund must credit the funding pocket the refund amount");
      this.put("card_refunds", { id: p.refundId, auth_id: p.authId, amount_cents: p.amountCents, created_at: p.at });
      this.post(p.ledger, p.at);
      a.refunded_cents = Number(a.refunded_cents) + p.amountCents;
      return { duplicate: false, refundedCents: a.refunded_cents as number };
    });
  }

  disputeOpen(p: { dispute: Row; at: string }) {
    return this.tx(() => {
      const d = p.dispute;
      const prev = this.row("disputes", { id: d.id });
      if (prev) return { ...prev };
      const a = this.row("card_authorizations", { id: d.auth_id });
      if (!a) return fail("not_found", "transaction not found");
      if (a.status !== "captured") fail("invalid_state", "only posted (captured) purchases can be disputed");
      if (d.credit_account !== a.funding_account || d.credit_party !== a.funding_party) fail("payload_mismatch", "a dispute credits the pocket that paid");
      if (this.t("disputes").some((x) => x.auth_id === a.id && (x.status === "open" || x.status === "provisional_credited"))) {
        fail("dispute_already_open", "a dispute is already open for this transaction");
      }
      if (Number(d.amount_cents) > Number(a.captured_cents) - Number(a.refunded_cents)) fail("dispute_exceeds_amount", "dispute exceeds the unrefunded purchase amount");
      return { ...this.put("disputes", { status: "open", provisional_credit_cents: 0, opened_at: p.at, ...d }) };
    });
  }

  disputeProvisionalCredit(p: { disputeId: string; ledger: LedgerPost; at: string }) {
    return this.tx(() => {
      const d = this.row("disputes", { id: p.disputeId });
      if (!d) return fail("not_found", "dispute not found");
      if (d.status !== "open") fail("invalid_state", `provisional credit not allowed in ${d.status}`);
      if (netDebit(p.ledger, d.credit_account, d.credit_party) !== -Number(d.amount_cents)) fail("payload_mismatch", "provisional credit must equal the disputed amount");
      this.post(p.ledger, p.at);
      Object.assign(d, { status: "provisional_credited", provisional_credit_cents: d.amount_cents });
    });
  }

  disputeResolve(p: { disputeId: string; outcome: "won" | "lost"; expectedStatus: string; provisionalCreditCents: number; ledger: LedgerPost | null; at: string; actorId: string | null }) {
    return this.tx(() => {
      if (p.outcome !== "won" && p.outcome !== "lost") fail("payload_mismatch", "outcome must be won or lost");
      const d = this.row("disputes", { id: p.disputeId });
      if (!d) return fail("not_found", "dispute not found");
      if (d.status !== "open" && d.status !== "provisional_credited") fail("invalid_state", `dispute already ${d.status}`);
      if (d.status !== p.expectedStatus) fail("invalid_state", `dispute moved to ${d.status} while resolving`);
      if (p.ledger) this.post(p.ledger, p.at);
      Object.assign(d, { status: p.outcome, provisional_credit_cents: p.provisionalCreditCents, resolved_at: p.at });
      this.put("audit_log", { actor_id: p.actorId, action: "dispute_resolved", entity: "dispute", entity_id: p.disputeId, reason: p.outcome, data: null, created_at: p.at });
    });
  }

  postInterest(p: { posting: Row; ledger: LedgerPost | null; at: string }) {
    return this.tx(() => {
      if (this.row("interest_postings", { account_id: p.posting.account_id, period: p.posting.period })) return false;
      this.put("interest_postings", { created_at: p.at, ...p.posting });
      if (p.ledger) {
        if (netDebit(p.ledger, "customer_deposits", p.posting.account_id) !== -Number(p.posting.posted_cents)) fail("payload_mismatch", "interest ledger must credit posted_cents");
        this.post(p.ledger, p.at);
      } else if (Number(p.posting.posted_cents) !== 0) {
        fail("payload_mismatch", "posted interest needs a ledger txn");
      }
      return true;
    });
  }

  closeAccount(p: { userId: string; closure: Row; expected: ClosureExpectation; ledger: LedgerPost | null; payoutTransfer: Row | null; at: string; actorId: string | null; audit: Row }) {
    return this.tx(() => {
      const accountIds = p.expected.accounts.map((a) => a.id);
      const memberIds = p.expected.members.map((m) => m.id);
      if (!accountIds.length) fail("already_closed", "no open accounts to close");
      const accounts = accountIds.map((id) => this.row("accounts", { id }));
      for (const a of accounts) {
        if (a && a.user_id !== p.userId) fail("payload_mismatch", "account belongs to another customer");
        if (a?.status === "closed") fail("already_closed", "account already closed");
      }
      if (accounts.some((a) => !a) || this.t("accounts").some((a) => a.user_id === p.userId && a.status !== "closed" && !accountIds.includes(a.id))) {
        fail("closure_state_changed", "the set of open pockets changed");
      }
      for (const e of p.expected.accounts) if (this.posted("customer_deposits", e.id) !== e.postedCents) fail("closure_state_changed", "a pocket balance changed while closing");
      for (const e of p.expected.members) if (this.posted("family_allowance", e.id) !== e.postedCents) fail("closure_state_changed", "an allowance balance changed while closing");
      if (this.activeHolds((h) => accountIds.includes(h.account_id) || memberIds.includes(h.family_member_id), p.at) > 0) fail("closure_state_changed", "pending holds");
      if (this.t("disputes").some((d) => d.user_id === p.userId && (d.status === "open" || d.status === "provisional_credited"))) fail("closure_state_changed", "open disputes");

      const canceledCardIds: string[] = [];
      for (const c of this.t("cards")) {
        if (accountIds.includes(c.account_id) && c.status !== "canceled" && c.status !== "replaced") {
          Object.assign(c, { status: "canceled", canceled_at: p.at });
          canceledCardIds.push(c.id);
        }
      }
      if (p.ledger) {
        this.post(p.ledger, p.at);
        this.put("transfers", { fee_cents: 0, new_payee: false, created_at: p.at, ...p.payoutTransfer });
      }
      if (accountIds.some((id) => this.posted("customer_deposits", id) !== 0) || memberIds.some((id) => this.posted("family_allowance", id) !== 0)) {
        fail("payload_mismatch", "closure payout must leave every pocket at zero");
      }
      for (const id of accountIds) this.patch("accounts", { id }, { status: "closed", closed_at: p.at });
      for (const id of memberIds) this.patch("family_members", { id }, { status: "removed" });
      this.put("closures", { status: "completed", blocks: [], created_at: p.at, ...p.closure });
      this.put("audit_log", { actor_id: p.actorId, action: "account_closed", entity: "profile", entity_id: p.userId, reason: null, data: p.audit, created_at: p.at });
      return { canceledCardIds: canceledCardIds.sort() };
    });
  }
}

/**
 * Postgres store via supabase-js (service role). `client` is a SupabaseClient; typed loosely so the
 * shared code has no npm/esm import. Ledger posts go through `post_ledger_txn`; every multi-row
 * money operation is one `harbor_*` SQL function (atomic, guarded, idempotent) called via RPC.
 */
export class SupabaseStore implements Store {
  constructor(private client: any) {}
  private check<T>(r: { data: T; error: any }): T {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
  /** Call a harbor_* operation; `harbor:<code>` errors become MoneyOpError (the call rolled back). */
  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.client.rpc(fn, args);
    if (r.error) {
      const m = /^harbor:([a-z_]+)/.exec(String(r.error.message ?? ""));
      if (m) throw new MoneyOpError(m[1] as MoneyOpCode, r.error.details || m[1]);
      throw new Error(r.error.message);
    }
    return r.data as T;
  }
  async insert(table: string, row: Row) {
    return this.check(await this.client.from(table).insert(row).select().single()) as Row;
  }
  async update(table: string, match: Row, patch: Row) {
    this.check(await this.client.from(table).update(patch).match(match));
  }
  async one(table: string, match: Row) {
    return (this.check(await this.client.from(table).select("*").match(match).limit(1)) as Row[])[0];
  }
  async list(table: string, match: Row = {}) {
    return this.check(await this.client.from(table).select("*").match(match)) as Row[];
  }
  async postLedger(t: Txn, idempotencyKey?: string) {
    assertBalanced(t);
    return this.check(await this.client.rpc("post_ledger_txn", { p_kind: t.kind, p_ref: t.ref ?? null, p_idem: idempotencyKey ?? null, p_lines: t.lines })) as string;
  }
  async ledger(filter: { account?: string; party?: string; limit?: number } = {}) {
    let q = this.client.from("ledger_lines").select("txn_id, account, party, debit, credit, ledger_txns(kind, ref, created_at)");
    if (filter.account) q = q.eq("account", filter.account);
    if (filter.party) q = q.eq("party", filter.party);
    // With a limit, return the LATEST lines (like MemoryStore), still in posting order.
    q = q.order("id", { ascending: !filter.limit });
    if (filter.limit) q = q.limit(filter.limit);
    const rows = this.check(await q) as any[];
    if (filter.limit) rows.reverse();
    return rows.map((r) => ({ txn_id: r.txn_id, account: r.account, party: r.party, debit: Number(r.debit), credit: Number(r.credit), kind: r.ledger_txns.kind, ref: r.ledger_txns.ref, at: r.ledger_txns.created_at }));
  }

  // ---------- atomic money operations: one SQL function each ----------
  private static limitArg(l: LimitWindow | null) {
    if (!l) return null;
    return { kind: l.kind, daily_cents: l.dailyCents, monthly_cents: l.monthlyCents, day_start: l.dayStart.toISOString(), month_start: l.monthStart.toISOString() };
  }
  private static ledgerArg(t: LedgerPost | null) {
    if (!t) return null;
    assertBalanced(t);
    return { kind: t.kind, ref: t.ref ?? null, idem: t.idem, lines: t.lines.map((l) => ({ account: l.account, party: l.party ?? null, debit: l.debit, credit: l.credit })) };
  }
  async achPullCreate(p: { transfer: Row; ledger: LedgerPost; hold: Row; limit: LimitWindow | null; at: string }) {
    const r = await this.rpc<{ replayed: boolean }>("harbor_ach_pull_create", { p_transfer: p.transfer, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_hold: p.hold, p_limit: SupabaseStore.limitArg(p.limit), p_at: p.at });
    return { replayed: !!r.replayed };
  }
  achSettle(p: { transferId: string; at: string }) {
    return this.rpc<boolean>("harbor_ach_settle", { p_transfer_id: p.transferId, p_at: p.at });
  }
  async achReturn(p: { transferId: string; code: string; ledger: LedgerPost; at: string; actorId: string | null; audit: Row }) {
    const r = await this.rpc<{ released_holds: number }>("harbor_ach_return", { p_transfer_id: p.transferId, p_code: p.code, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at, p_actor: p.actorId, p_audit: p.audit });
    return { releasedHolds: Number(r.released_holds) };
  }
  private async transferOut(fn: string, p: { transfer: Row; ledger: LedgerPost; at: string }, extra: Record<string, unknown> = {}) {
    const r = await this.rpc<{ replayed: boolean }>(fn, { p_transfer: p.transfer, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at, ...extra });
    return { replayed: !!r.replayed };
  }
  achPush(p: { transfer: Row; ledger: LedgerPost; limit: LimitWindow | null; at: string }) { return this.transferOut("harbor_ach_push", p, { p_limit: SupabaseStore.limitArg(p.limit) }); }
  p2pTransfer(p: { transfer: Row; ledger: LedgerPost; payee: Row | null; limit: LimitWindow | null; at: string }) {
    return this.transferOut("harbor_p2p_transfer", p, { p_payee: p.payee, p_limit: SupabaseStore.limitArg(p.limit) });
  }
  pocketMove(p: { transfer: Row; ledger: LedgerPost; at: string }) { return this.transferOut("harbor_pocket_move", p); }
  allowanceTopUp(p: { transfer: Row; ledger: LedgerPost; at: string }) { return this.transferOut("harbor_allowance_topup", p); }
  async cardAuthorize(p: { auth: Row; hold: Row | null; at: string }) {
    const r = await this.rpc<{ approved: boolean; reason: string | null; hold_id: string | null; replayed: boolean }>("harbor_card_authorize", { p_auth: p.auth, p_hold: p.hold, p_at: p.at });
    return { approved: !!r.approved, reason: r.reason ?? null, holdId: r.hold_id ?? null, replayed: !!r.replayed };
  }
  async cardCapture(p: { authId: string; capturedCents: number; feeCents: number; ledger: LedgerPost; at: string }) {
    await this.rpc("harbor_card_capture", { p_auth_id: p.authId, p_captured_cents: p.capturedCents, p_fee_cents: p.feeCents, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at });
  }
  cardExpireAuth(p: { authId: string; at: string }) {
    return this.rpc<boolean>("harbor_card_expire_auth", { p_auth_id: p.authId, p_at: p.at });
  }
  async cardRefund(p: { refundId: string; authId: string; amountCents: number; ledger: LedgerPost; at: string }) {
    const r = await this.rpc<{ duplicate: boolean; refunded_cents: number }>("harbor_card_refund", { p_refund_id: p.refundId, p_auth_id: p.authId, p_amount_cents: p.amountCents, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at });
    return { duplicate: !!r.duplicate, refundedCents: Number(r.refunded_cents) };
  }
  disputeOpen(p: { dispute: Row; at: string }) {
    return this.rpc<Row>("harbor_dispute_open", { p_dispute: p.dispute, p_at: p.at });
  }
  async disputeProvisionalCredit(p: { disputeId: string; ledger: LedgerPost; at: string }) {
    await this.rpc("harbor_dispute_provisional_credit", { p_dispute_id: p.disputeId, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at });
  }
  async disputeResolve(p: { disputeId: string; outcome: "won" | "lost"; expectedStatus: string; provisionalCreditCents: number; ledger: LedgerPost | null; at: string; actorId: string | null }) {
    await this.rpc("harbor_dispute_resolve", {
      p_dispute_id: p.disputeId, p_outcome: p.outcome, p_expected_status: p.expectedStatus, p_provisional_credit_cents: p.provisionalCreditCents,
      p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at, p_actor: p.actorId,
    });
  }
  postInterest(p: { posting: Row; ledger: LedgerPost | null; at: string }) {
    return this.rpc<boolean>("harbor_post_interest", { p_posting: p.posting, p_ledger: SupabaseStore.ledgerArg(p.ledger), p_at: p.at });
  }
  async closeAccount(p: { userId: string; closure: Row; expected: ClosureExpectation; ledger: LedgerPost | null; payoutTransfer: Row | null; at: string; actorId: string | null; audit: Row }) {
    const expected = {
      accounts: p.expected.accounts.map((a) => ({ id: a.id, posted_cents: a.postedCents })),
      members: p.expected.members.map((m) => ({ id: m.id, posted_cents: m.postedCents })),
    };
    const r = await this.rpc<{ canceled_card_ids: string[] }>("harbor_close_account", {
      p_user_id: p.userId, p_closure: p.closure, p_expected: expected, p_ledger: SupabaseStore.ledgerArg(p.ledger),
      p_payout_transfer: p.payoutTransfer, p_at: p.at, p_actor: p.actorId, p_audit: p.audit,
    });
    return { canceledCardIds: r.canceled_card_ids ?? [] };
  }
}
