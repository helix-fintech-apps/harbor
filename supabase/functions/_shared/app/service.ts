// Harbor application service: orchestrates domain rules + providers + store.
// Used by the `api` Edge Function (SupabaseStore) and the browser demo / tests (MemoryStore).
// All money rules live in ../domain; this file only loads state, calls the domain, and persists.

import {
  DEFAULT_FEES, DEFAULT_POLICY, type FeeSchedule, type MoneyPolicy, type Tier,
  mapIdentityStatus, decideKyc, screenSanctions, canTransitionKyc, canMoveMoney, withVendorTimeout, requiresStaff, type KycState,
  fakeAccountNumber, HARBOR_ROUTING_NUMBER, balances, holdIsActive, type Hold,
  ownerNameMatches, planAchPull, planAchReturn, canSettle, validateDirectDepositForm, type LinkedBank, type DirectDepositForm,
  planAchPush, planP2P, planPocketMove, TransferError, transferFee, type SenderCtx, type Speed,
  authorize, planCapture, planMerchantRefund, canIssueCard, initialCardStatus, canTransitionCard, type Card, type CardStatus, type Authorization,
  newFamilyMember, guardianApprove, planAllowanceTopUp, validateLimits, type FamilyMember, type SpendLimits,
  openDispute, planProvisionalCredit, resolveDispute, type Dispute,
  dailyAccrualMicro, planMonthlyInterest,
  closureBlocks, planClosure,
  buildStatement, periodBounds,
  withIdempotency, IdempotencyConflict, type IdemStore, type UsageEvent, type Line, type LedgerAccount,
  isoDate, addHours, addBusinessDays, checkLimit,
} from "../domain/index.ts";
import type { Providers } from "../providers/index.ts";
import { uuid, type Row, type Store } from "./store.ts";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) { super(message ?? code); }
}

export interface Caller { userId: string; role: "customer" | "admin" | "support_agent" }

export interface ServiceOptions {
  store: Store;
  providers: Providers;
  clock?: () => Date;
  policy?: MoneyPolicy;
  fees?: FeeSchedule;
  kycTimeoutMs?: number;
  /** Step-up (2FA) verifier for new-payee P2P. Fake mode accepts "000000". */
  verifyStepUp?: (userId: string, code: string) => Promise<boolean>;
}

const d = (s: string | null | undefined) => (s ? new Date(s) : undefined);

export class HarborService {
  store: Store;
  providers: Providers;
  clock: () => Date;
  policy: MoneyPolicy;
  fees: FeeSchedule;
  kycTimeoutMs: number;
  verifyStepUp: (userId: string, code: string) => Promise<boolean>;

  constructor(o: ServiceOptions) {
    this.store = o.store;
    this.providers = o.providers;
    this.clock = o.clock ?? (() => new Date());
    this.policy = o.policy ?? DEFAULT_POLICY;
    this.fees = o.fees ?? DEFAULT_FEES;
    this.kycTimeoutMs = o.kycTimeoutMs ?? this.policy.kyc.vendorTimeoutMs;
    this.verifyStepUp = o.verifyStepUp ?? (async (_u, code) => code === "000000");
  }

  // ---------- helpers ----------
  now() { return this.clock(); }

  async audit(actor: string | null, action: string, entity: string, entityId: string | null, reason?: string, data?: unknown) {
    await this.store.insert("audit_log", { actor_id: actor, action, entity, entity_id: entityId, reason: reason ?? null, data: data ?? null, created_at: this.now().toISOString() });
  }

  async profile(userId: string): Promise<Row> {
    const p = await this.store.one("profiles", { id: userId });
    if (!p) throw new ApiError(404, "not_found", "profile not found");
    return p;
  }

  requireStaff(c: Caller) {
    if (c.role !== "admin" && c.role !== "support_agent") throw new ApiError(403, "forbidden", "staff only");
  }
  requireAdmin(c: Caller) {
    if (c.role !== "admin") throw new ApiError(403, "forbidden", "admin only");
  }

  async pockets(userId: string): Promise<Row[]> {
    return (await this.store.list("accounts", { user_id: userId })).filter((a) => a.status !== "closed");
  }

  async pocket(userId: string, kind: "checking" | "savings"): Promise<Row> {
    const a = (await this.pockets(userId)).find((x) => x.kind === kind);
    if (!a) throw new ApiError(409, "no_account", `no open ${kind} account (complete KYC first)`);
    return a;
  }

  async holds(): Promise<Hold[]> {
    return (await this.store.list("holds")).map((h) => ({
      id: h.id, accountId: h.account_id ?? `member:${h.family_member_id}`, kind: h.kind, amountCents: Number(h.amount_cents),
      status: h.status, createdAt: new Date(h.created_at), expiresAt: d(h.expires_at), releaseAt: d(h.release_at),
    }));
  }

  async lines(account: LedgerAccount, party: string): Promise<Line[]> {
    return (await this.store.ledger({ account, party })).map((l) => ({ account: l.account as LedgerAccount, party: l.party ?? undefined, debit: Number(l.debit), credit: Number(l.credit) }));
  }

  async balanceOf(accountId: string) {
    return balances(await this.lines("customer_deposits", accountId), await this.holds(), accountId, this.now());
  }

  async allowanceOf(memberId: string) {
    const lines = (await this.lines("family_allowance", memberId)).map((l) => ({ ...l, account: "customer_deposits" as const, party: `member:${memberId}` }));
    return balances(lines, await this.holds(), `member:${memberId}`, this.now());
  }

  async usage(userId: string): Promise<UsageEvent[]> {
    const ev: UsageEvent[] = [];
    for (const t of await this.store.list("transfers", { user_id: userId })) {
      if (t.status === "failed") continue;
      if (t.kind === "ach_out" || t.kind === "p2p") ev.push({ at: new Date(t.created_at), amountCents: Number(t.amount_cents), kind: "transfer_out" });
      if (t.kind === "ach_in" && t.status !== "returned") ev.push({ at: new Date(t.created_at), amountCents: Number(t.amount_cents), kind: "ach_in" });
    }
    const accountIds = new Set((await this.store.list("accounts", { user_id: userId })).map((a) => a.id));
    const cards = (await this.store.list("cards")).filter((c) => accountIds.has(c.account_id));
    const cardIds = new Set(cards.map((c) => c.id));
    for (const a of await this.store.list("card_authorizations")) {
      if (!cardIds.has(a.card_id)) continue;
      const amt = a.status === "captured" ? Number(a.captured_cents) : a.status === "authorized" ? Number(a.amount_cents) : 0;
      if (amt > 0) ev.push({ at: new Date(a.created_at), amountCents: amt, kind: "card_spend" });
    }
    return ev;
  }

  async memberSpend(memberId: string): Promise<UsageEvent[]> {
    const cardIds = new Set((await this.store.list("cards", { family_member_id: memberId })).map((c) => c.id));
    return (await this.store.list("card_authorizations"))
      .filter((a) => cardIds.has(a.card_id) && (a.status === "authorized" || a.status === "captured"))
      .map((a) => ({ at: new Date(a.created_at), amountCents: Number(a.status === "captured" ? a.captured_cents : a.amount_cents) + Number(a.fee_cents), kind: "card_spend" as const }));
  }

  async senderCtx(userId: string): Promise<SenderCtx> {
    const p = await this.profile(userId);
    const chk = await this.pocket(userId, "checking");
    return {
      kyc: p.kyc_state, tier: p.tier as Tier, accountId: chk.id, accountStatus: chk.status,
      availableCents: (await this.balanceOf(chk.id)).availableCents, usage: await this.usage(userId),
    };
  }

  toBank(r: Row): LinkedBank {
    return { id: r.id, userId: r.user_id, institution: r.institution, mask: r.mask, ownerNames: r.owner_names, nameMatched: r.name_matched, linkedAt: new Date(r.linked_at), status: r.status };
  }

  async bankOf(userId: string, bankId: string): Promise<LinkedBank> {
    const b = await this.store.one("linked_banks", { id: bankId, user_id: userId });
    if (!b) throw new ApiError(404, "not_found", "linked bank not found");
    return this.toBank(b);
  }

  toCard(r: Row): Card {
    return { id: r.id, accountId: r.account_id, holderUserId: r.holder_user_id, familyMemberId: r.family_member_id ?? undefined, kind: r.kind, status: r.status, last4: r.last4 };
  }

  toMember(r: Row): FamilyMember {
    return {
      id: r.id, ownerUserId: r.owner_user_id, name: r.name, kind: r.kind, status: r.status,
      limits: { perTxnCents: Number(r.per_txn_cents), dailyCents: Number(r.daily_cents), monthlyCents: Number(r.monthly_cents) },
      blockedMccGroups: r.blocked_mcc_groups ?? [], blockedMccs: r.blocked_mccs ?? [],
    };
  }

  toAuth(r: Row): Authorization {
    return {
      id: r.id, cardId: r.card_id, amountCents: Number(r.amount_cents), feeCents: Number(r.fee_cents), mcc: r.mcc, foreign: r.foreign_txn,
      atmOutOfNetwork: r.atm_out_of_network ?? false, status: r.status, expiresAt: new Date(r.expires_at),
      funding: { account: r.funding_account, party: r.funding_party },
    };
  }

  /** Card visible to caller: owner of the funding account or the family member holder. */
  async cardFor(c: Caller, cardId: string): Promise<Row> {
    const card = await this.store.one("cards", { id: cardId });
    if (!card) throw new ApiError(404, "not_found", "card not found");
    const acct = await this.store.one("accounts", { id: card.account_id });
    if (acct?.user_id !== c.userId && card.holder_user_id !== c.userId && c.role === "customer") throw new ApiError(404, "not_found", "card not found");
    return card;
  }

  async ownedCard(c: Caller, cardId: string): Promise<Row> {
    const card = await this.cardFor(c, cardId);
    const acct = await this.store.one("accounts", { id: card.account_id });
    if (acct?.user_id !== c.userId && c.role === "customer") throw new ApiError(403, "forbidden", "only the account owner can manage this card");
    return card;
  }

  // ---------- onboarding / KYC ----------
  async createProfile(userId: string, email: string, legalName: string, role: Caller["role"] = "customer") {
    const existing = await this.store.one("profiles", { id: userId });
    if (existing) return existing;
    return this.store.insert("profiles", { id: userId, email: email.toLowerCase(), legal_name: legalName, role, kyc_state: "unverified", tier: "tier1", step_up_enrolled: false, created_at: this.now().toISOString() });
  }

  async ensureAccounts(userId: string) {
    const existing = await this.pockets(userId);
    for (const kind of ["checking", "savings"] as const) {
      if (existing.some((a) => a.kind === kind)) continue;
      const id = uuid();
      await this.store.insert("accounts", {
        id, user_id: userId, kind, status: "open", account_number: fakeAccountNumber(id), routing_number: HARBOR_ROUTING_NUMBER,
        nickname: kind === "checking" ? "Everyday" : "Savings", policy_version: this.policy.version, opened_at: this.now().toISOString(), closed_at: null,
      });
    }
  }

  async setKyc(userId: string, to: KycState, reason: string, by: string | null, extra: Row = {}) {
    const p = await this.profile(userId);
    const from = p.kyc_state as KycState;
    if (from !== to && !canTransitionKyc(from, to)) throw new ApiError(409, "invalid_transition", `KYC cannot go from ${from} to ${to}`);
    await this.store.update("profiles", { id: userId }, { kyc_state: to });
    await this.store.insert("kyc_checks", { user_id: userId, provider: extra.provider ?? "manual", session_id: extra.session_id ?? null, identity_status: extra.identity_status ?? null, sanctions: extra.sanctions ?? null, decision: to, reason, decided_by: by, created_at: this.now().toISOString() });
    if (to === "approved") await this.ensureAccounts(userId);
    if (to === "frozen_legal") for (const a of await this.pockets(userId)) await this.store.update("accounts", { id: a.id }, { status: "frozen" });
    if (to === "approved" && from === "frozen_legal") for (const a of await this.pockets(userId)) await this.store.update("accounts", { id: a.id }, { status: "open" });
    await this.audit(by, "kyc_transition", "profile", userId, reason, { from, to });
  }

  async runKyc(c: Caller, sessionId?: string) {
    const p = await this.profile(c.userId);
    if (!["unverified", "pending"].includes(p.kyc_state)) throw new ApiError(409, "kyc_already_decided", `KYC is ${p.kyc_state}`);
    const session = sessionId ? { sessionId } : await this.providers.identity.start(c.userId, p.legal_name);
    let raw: string;
    try {
      const r = await withVendorTimeout(this.providers.identity.status(session.sessionId), this.kycTimeoutMs);
      raw = r === "timeout" ? "timeout" : r;
    } catch {
      raw = "timeout"; // vendor errors are treated like timeouts: never approve
    }
    const identity = mapIdentityStatus(raw);
    const sanctions = screenSanctions(p.legal_name, this.policy);
    const decision = decideKyc(identity, sanctions);
    await this.setKyc(c.userId, decision.state, decision.reason, null, { provider: this.providers.identity.name, session_id: session.sessionId, identity_status: raw, sanctions });
    return { state: decision.state, reason: decision.reason, sessionId: session.sessionId, identityStatus: raw, sanctions: sanctions.kind };
  }

  async adminSetKyc(c: Caller, userId: string, to: KycState, reason: string) {
    this.requireStaff(c);
    if (!reason?.trim()) throw new ApiError(422, "reason_required", "a reason is required");
    const p = await this.profile(userId);
    if ((to === "approved" && p.kyc_state === "frozen_legal") || to === "frozen_legal") this.requireAdmin(c);
    void requiresStaff;
    await this.setKyc(userId, to, reason, c.userId);
    return { userId, state: to };
  }

  async adminSetTier(c: Caller, userId: string, tier: Tier) {
    this.requireAdmin(c);
    if (tier !== "tier1" && tier !== "tier2") throw new ApiError(422, "invalid_tier");
    await this.store.update("profiles", { id: userId }, { tier });
    await this.audit(c.userId, "set_tier", "profile", userId, undefined, { tier });
    return { userId, tier };
  }

  // ---------- overview ----------
  async me(c: Caller) {
    const p = await this.profile(c.userId);
    const accounts = [];
    for (const a of await this.pockets(c.userId)) {
      accounts.push({ id: a.id, kind: a.kind, status: a.status, nickname: a.nickname, accountNumber: a.account_number, routingNumber: a.routing_number, ...(await this.balanceOf(a.id)) });
    }
    const banks = (await this.store.list("linked_banks", { user_id: c.userId })).filter((b) => b.status === "active").map((b) => {
      const bank = this.toBank(b);
      return { id: b.id, institution: b.institution, mask: b.mask, ownerNames: b.owner_names, nameMatched: b.name_matched, linkedAt: b.linked_at,
        coolingOffUntil: addHours(bank.linkedAt, this.policy.achOut.coolingOffHours).toISOString() };
    });
    const accountIds = new Set(accounts.map((a) => a.id));
    const cards = (await this.store.list("cards")).filter((x) => accountIds.has(x.account_id) || x.holder_user_id === c.userId);
    const family = [];
    for (const m of await this.store.list("family_members", { owner_user_id: c.userId })) {
      if (m.status === "removed") continue;
      family.push({ ...this.toMember(m), allowance: m.kind === "teen" ? await this.allowanceOf(m.id) : null });
    }
    const transfers = (await this.store.list("transfers", { user_id: c.userId })).concat(await this.store.list("transfers", { counterparty_user_id: c.userId }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
    const cardIds = new Set(cards.map((x) => x.id));
    const authorizations = (await this.store.list("card_authorizations")).filter((a) => cardIds.has(a.card_id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
    const disputes = await this.store.list("disputes", { user_id: c.userId });
    const u = await this.usage(c.userId);
    return {
      profile: { id: p.id, email: p.email, legalName: p.legal_name, role: p.role, kycState: p.kyc_state, tier: p.tier },
      limits: this.policy.tiers[p.tier as Tier], usage: u.map((e) => ({ ...e, at: e.at.toISOString() })),
      accounts, banks, cards, family, transfers, authorizations, disputes, now: this.now().toISOString(),
    };
  }

  publishedTerms() {
    return { fees: this.fees, policy: this.policy };
  }

  // ---------- banks ----------
  async linkToken(c: Caller) {
    await this.profile(c.userId);
    return { linkToken: await this.providers.bank.createLinkToken(c.userId), provider: this.providers.bank.name };
  }

  async exchange(c: Caller, publicToken: string) {
    const p = await this.profile(c.userId);
    if (!publicToken) throw new ApiError(422, "public_token_required");
    let ex, acct;
    try {
      ex = await this.providers.bank.exchangePublicToken(publicToken);
      acct = await this.providers.bank.getAccount(ex.accessToken);
    } catch (e) {
      throw new ApiError(422, "bank_link_failed", (e as Error).message);
    }
    const nameMatched = ownerNameMatches(p.legal_name, acct.ownerNames);
    const row = await this.store.insert("linked_banks", {
      user_id: c.userId, provider: this.providers.bank.name, provider_item_id: ex.itemId, provider_account_id: acct.accountId,
      institution: acct.institution, mask: acct.mask, owner_names: acct.ownerNames, name_matched: nameMatched, status: "active", linked_at: this.now().toISOString(),
    });
    await this.store.insert("bank_access_tokens", { linked_bank_id: row.id, access_token: ex.accessToken });
    await this.audit(c.userId, "bank_linked", "linked_bank", row.id, undefined, { nameMatched });
    return { id: row.id, institution: row.institution, mask: row.mask, nameMatched, ownerNames: acct.ownerNames };
  }

  async removeBank(c: Caller, bankId: string) {
    await this.bankOf(c.userId, bankId);
    await this.store.update("linked_banks", { id: bankId }, { status: "removed" });
    return { id: bankId, status: "removed" };
  }

  async directDeposit(c: Caller, f: DirectDepositForm & { accountKind?: "checking" | "savings" }) {
    const p = await this.profile(c.userId);
    const acct = await this.pocket(c.userId, f.accountKind ?? "checking");
    const form = { ...f, accountNumber: acct.account_number, routingNumber: acct.routing_number, accountType: acct.kind };
    const errors = validateDirectDepositForm(form, p.legal_name);
    if (errors.length) throw new ApiError(422, "invalid_form", errors.join("; "), errors);
    const row = await this.store.insert("direct_deposit_forms", { user_id: c.userId, account_id: acct.id, employer_name: f.employerName, allocation: f.allocation, signature_name: f.signatureName });
    return { id: row.id, recorded: true, accountNumber: acct.account_number, routingNumber: acct.routing_number };
  }

  // ---------- money in ----------
  async achIn(c: Caller, body: { bankId: string; amountCents: number; idempotencyKey?: string }) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved", "complete verification first");
    const chk = await this.pocket(c.userId, "checking");
    if (chk.status !== "open") throw new ApiError(409, "account_frozen");
    const bank = await this.bankOf(c.userId, body.bankId);
    const lim = checkLimit(p.tier, "ach_in", body.amountCents, await this.usage(c.userId), this.now(), this.policy);
    if (!lim.ok) throw new ApiError(422, lim.reason!, `deposit limit: remaining today ${lim.remainingDaily}`);
    const id = uuid();
    let plan;
    try { plan = planAchPull({ transferId: id, accountId: chk.id, amountCents: body.amountCents, bank, now: this.now() }, this.policy); }
    catch (e) { throw new ApiError(422, /name/.test((e as Error).message) ? "bank_name_mismatch" : "invalid_request", (e as Error).message); }
    await this.store.insert("transfers", {
      id, user_id: c.userId, kind: "ach_in", speed: null, to_account_id: chk.id, from_account_id: null, linked_bank_id: bank.id, counterparty_user_id: null,
      amount_cents: body.amountCents, fee_cents: 0, status: "pending", settle_at: plan.settleAt.toISOString(), return_code: null, new_payee: false,
      policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: body.idempotencyKey ?? null, created_at: this.now().toISOString(),
    });
    await this.store.postLedger(plan.ledger, `transfer:${id}`);
    await this.store.insert("holds", { account_id: chk.id, family_member_id: null, kind: "ach_in", amount_cents: plan.holdCents, status: "active", ref_id: id, expires_at: null, release_at: plan.settleAt.toISOString(), created_at: this.now().toISOString(), released_at: null });
    return { id, status: "pending", amountCents: body.amountCents, settleAt: plan.settleAt.toISOString(), holdCents: plan.holdCents };
  }

  async settleAch(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let settled = 0;
    for (const t of await this.store.list("transfers", { status: "pending" })) {
      if (!t.settle_at || !canSettle(new Date(t.settle_at), now)) continue;
      await this.store.update("transfers", { id: t.id }, { status: "settled", settled_at: now.toISOString() });
      await this.store.update("holds", { ref_id: t.id, status: "active" }, { status: "released", released_at: now.toISOString() });
      settled++;
    }
    return { settled };
  }

  async achReturn(c: Caller, transferId: string, code: string) {
    this.requireStaff(c);
    const t = await this.store.one("transfers", { id: transferId });
    if (!t || t.kind !== "ach_in") throw new ApiError(404, "not_found", "ACH deposit not found");
    const posted = (await this.balanceOf(t.to_account_id)).postedCents;
    let plan;
    try { plan = planAchReturn({ transferId, accountId: t.to_account_id, amountCents: Number(t.amount_cents), returnCode: code, status: t.status, postedBalanceCents: posted }, this.policy); }
    catch (e) { throw new ApiError(409, "already_returned", (e as Error).message); }
    if (!plan.reverses) return { reversed: false, code };
    await this.store.postLedger(plan.ledger!, `return:${transferId}`);
    await this.store.update("holds", { ref_id: transferId, status: "active" }, { status: "released", released_at: this.now().toISOString() });
    await this.store.update("transfers", { id: transferId }, { status: "returned", return_code: code });
    await this.audit(c.userId, "ach_return", "transfer", transferId, code, { negativeBalanceCents: plan.negativeBalanceCents });
    return { reversed: true, code, negativeBalanceCents: plan.negativeBalanceCents, heldBeforeSettlement: plan.releaseHold };
  }

  // ---------- money out ----------
  mapTransferError(e: unknown): never {
    if (e instanceof TransferError) throw new ApiError(e.code === "kyc_not_approved" || e.code === "payout_blocked" ? 403 : 422, e.code, e.message);
    throw e;
  }

  quoteFee(amountCents: number, speed: Speed) {
    return { amountCents, speed, feeCents: transferFee(amountCents, speed, this.fees), feeVersion: this.fees.version };
  }

  async achOut(c: Caller, body: { bankId: string; amountCents: number; speed: Speed; idempotencyKey?: string }) {
    const bank = await this.bankOf(c.userId, body.bankId);
    const sender = await this.senderCtx(c.userId);
    const id = uuid();
    let plan;
    try { plan = planAchPush({ transferId: id, amountCents: body.amountCents, speed: body.speed === "instant" ? "instant" : "standard", bank, sender, now: this.now() }, this.policy, this.fees); }
    catch (e) { this.mapTransferError(e); }
    const instant = body.speed === "instant";
    await this.store.insert("transfers", {
      id, user_id: c.userId, kind: "ach_out", speed: instant ? "instant" : "standard", from_account_id: sender.accountId, to_account_id: null, linked_bank_id: bank.id,
      counterparty_user_id: null, amount_cents: body.amountCents, fee_cents: plan!.feeCents, status: instant ? "completed" : "pending",
      settle_at: instant ? null : addBusinessDays(this.now(), 1, this.policy.holidays).toISOString(),
      return_code: null, new_payee: false, policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: body.idempotencyKey ?? null, created_at: this.now().toISOString(),
    });
    await this.store.postLedger(plan!.ledger, `transfer:${id}`);
    return { id, status: instant ? "completed" : "pending", amountCents: body.amountCents, feeCents: plan!.feeCents, totalDebitCents: plan!.totalDebitCents };
  }

  async p2p(c: Caller, body: { recipientEmail: string; amountCents: number; stepUpCode?: string; memo?: string; idempotencyKey?: string }) {
    const sender = await this.senderCtx(c.userId);
    const rp = await this.store.one("profiles", { email: String(body.recipientEmail ?? "").toLowerCase() });
    let recipient = null;
    if (rp) {
      const rchk = (await this.pockets(rp.id)).find((a) => a.kind === "checking");
      if (rchk) recipient = { userId: rp.id, kyc: rp.kyc_state, accountId: rchk.id, accountStatus: rchk.status };
    }
    const known = rp ? !!(await this.store.one("payees", { user_id: c.userId, payee_user_id: rp.id })) : false;
    const stepUpVerified = body.stepUpCode ? await this.verifyStepUp(c.userId, body.stepUpCode) : false;
    const id = uuid();
    let plan;
    try { plan = planP2P({ transferId: id, amountCents: body.amountCents, senderUserId: c.userId, sender, recipient, knownPayee: known, stepUpVerified, now: this.now() }, this.policy, this.fees); }
    catch (e) { this.mapTransferError(e); }
    await this.store.insert("transfers", {
      id, user_id: c.userId, kind: "p2p", speed: null, from_account_id: sender.accountId, to_account_id: recipient!.accountId, linked_bank_id: null,
      counterparty_user_id: recipient!.userId, amount_cents: body.amountCents, fee_cents: plan!.feeCents, status: "completed", settle_at: null, return_code: null,
      new_payee: plan!.newPayee, policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: body.idempotencyKey ?? null, created_at: this.now().toISOString(),
    });
    await this.store.postLedger(plan!.ledger, `transfer:${id}`);
    if (!known) await this.store.insert("payees", { user_id: c.userId, payee_user_id: recipient!.userId, first_paid_at: this.now().toISOString() });
    return { id, status: "completed", amountCents: body.amountCents, newPayee: plan!.newPayee };
  }

  async pocketMove(c: Caller, body: { from: "checking" | "savings"; to: "checking" | "savings"; amountCents: number; idempotencyKey?: string }) {
    const p = await this.profile(c.userId);
    const from = await this.pocket(c.userId, body.from);
    const to = await this.pocket(c.userId, body.to);
    if (from.status !== "open" || to.status !== "open") throw new ApiError(409, "account_frozen");
    const id = uuid();
    let t;
    try { t = planPocketMove({ transferId: id, fromAccountId: from.id, toAccountId: to.id, amountCents: body.amountCents, availableCents: (await this.balanceOf(from.id)).availableCents, kyc: p.kyc_state }); }
    catch (e) { this.mapTransferError(e); }
    await this.store.insert("transfers", {
      id, user_id: c.userId, kind: "pocket", speed: null, from_account_id: from.id, to_account_id: to.id, linked_bank_id: null, counterparty_user_id: null,
      amount_cents: body.amountCents, fee_cents: 0, status: "completed", settle_at: null, return_code: null, new_payee: false,
      policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: body.idempotencyKey ?? null, created_at: this.now().toISOString(),
    });
    await this.store.postLedger(t!, `transfer:${id}`);
    return { id, status: "completed" };
  }

  // ---------- cards ----------
  async issueCard(c: Caller, body: { kind: "virtual" | "physical"; familyMemberId?: string }) {
    const p = await this.profile(c.userId);
    const chk = await this.pocket(c.userId, "checking");
    const existing = (await this.store.list("cards", { account_id: chk.id })).map((r) => this.toCard(r));
    let holder = c.userId;
    if (body.familyMemberId) {
      const m = await this.store.one("family_members", { id: body.familyMemberId, owner_user_id: c.userId });
      if (!m || m.status === "removed") throw new ApiError(404, "not_found", "family member not found");
      if (existing.some((x) => x.familyMemberId === m.id && ["active", "frozen", "requested"].includes(x.status))) throw new ApiError(409, "member_has_card");
      holder = m.member_user_id ?? c.userId;
      if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved");
    } else {
      const ok = canIssueCard(p.kyc_state, body.kind, existing, this.policy);
      if (!ok.ok) throw new ApiError(ok.reason === "kyc_not_approved" ? 403 : 409, ok.reason!);
    }
    const id = uuid();
    const prov = await this.providers.issuer.createCard({ userId: c.userId, legalName: p.legal_name, kind: body.kind, cardId: id });
    const row = await this.store.insert("cards", {
      id, account_id: chk.id, holder_user_id: holder, family_member_id: body.familyMemberId ?? null, kind: body.kind, status: initialCardStatus(body.kind),
      last4: prov.last4, provider: this.providers.issuer.name, provider_card_id: prov.providerCardId, replaces_card_id: null, created_at: this.now().toISOString(), canceled_at: null,
    });
    return row;
  }

  async setCardStatus(c: Caller, cardId: string, to: CardStatus) {
    const card = await this.ownedCard(c, cardId);
    if (!canTransitionCard(card.status, to)) throw new ApiError(409, "invalid_transition", `card cannot go from ${card.status} to ${to}`);
    await this.providers.issuer.setStatus(card.provider_card_id, to === "active" ? "active" : to === "frozen" ? "inactive" : "canceled");
    await this.store.update("cards", { id: cardId }, { status: to, canceled_at: to === "canceled" || to === "replaced" ? this.now().toISOString() : card.canceled_at ?? null });
    return { ...card, status: to };
  }

  async replaceCard(c: Caller, cardId: string) {
    const card = await this.ownedCard(c, cardId);
    await this.setCardStatus(c, cardId, "replaced");
    const p = await this.profile(c.userId);
    const id = uuid();
    const prov = await this.providers.issuer.createCard({ userId: c.userId, legalName: p.legal_name, kind: card.kind, cardId: id });
    return this.store.insert("cards", {
      id, account_id: card.account_id, holder_user_id: card.holder_user_id, family_member_id: card.family_member_id, kind: card.kind, status: initialCardStatus(card.kind),
      last4: prov.last4, provider: this.providers.issuer.name, provider_card_id: prov.providerCardId, replaces_card_id: card.id, created_at: this.now().toISOString(), canceled_at: null,
    });
  }

  /** Card network authorization request (fake issuer test hook; Stripe Issuing webhook maps here too). */
  async authorizeCard(cardId: string, req: { amountCents: number; mcc: string; merchant: string; foreign?: boolean; atmOutOfNetwork?: boolean; providerAuthId?: string }) {
    const card = await this.store.one("cards", { id: cardId });
    if (!card) throw new ApiError(404, "not_found", "card not found");
    const acct = await this.store.one("accounts", { id: card.account_id });
    const owner = await this.profile(acct!.user_id);
    const memberRow = card.family_member_id ? await this.store.one("family_members", { id: card.family_member_id }) : undefined;
    const member = memberRow ? this.toMember(memberRow) : undefined;
    const attempts = (await this.store.list("card_authorizations", { card_id: cardId })).map((a) => new Date(a.created_at));
    const now = this.now();
    const decision = authorize(
      { amountCents: req.amountCents, mcc: String(req.mcc), merchant: req.merchant ?? "Merchant", foreign: !!req.foreign, atmOutOfNetwork: !!req.atmOutOfNetwork },
      {
        card: this.toCard(card), accountStatus: acct!.status, ownerKyc: owner.kyc_state, ownerTier: owner.tier, ownerUsage: await this.usage(owner.id),
        availableCents: (await this.balanceOf(card.account_id)).availableCents, recentAuthAttempts: attempts, member,
        memberSpend: member ? await this.memberSpend(member.id) : undefined,
        allowanceAvailableCents: member?.kind === "teen" ? (await this.allowanceOf(member.id)).availableCents : undefined, now,
      }, this.policy, this.fees);
    const id = uuid();
    const base = {
      id, card_id: cardId, provider_auth_id: req.providerAuthId ?? null, amount_cents: Number.isSafeInteger(req.amountCents) && req.amountCents > 0 ? req.amountCents : 1,
      mcc: String(req.mcc).padStart(4, "0").slice(0, 4), merchant: req.merchant ?? "Merchant", foreign_txn: !!req.foreign, atm_out_of_network: !!req.atmOutOfNetwork,
      captured_cents: 0, refunded_cents: 0, created_at: now.toISOString(), captured_at: null,
    };
    if (!decision.approved) {
      await this.store.insert("card_authorizations", { ...base, fee_cents: 0, status: "declined", decline_reason: decision.reason, hold_id: null, funding_account: "customer_deposits", funding_party: card.account_id, expires_at: now.toISOString() });
      return { authorizationId: id, approved: false, reason: decision.reason };
    }
    const teen = decision.funding.account === "family_allowance";
    const hold = await this.store.insert("holds", {
      account_id: teen ? null : card.account_id, family_member_id: teen ? decision.funding.party : null, kind: "card_auth", amount_cents: decision.holdCents,
      status: "active", ref_id: id, expires_at: decision.expiresAt.toISOString(), release_at: null, created_at: now.toISOString(), released_at: null,
    });
    await this.store.insert("card_authorizations", { ...base, fee_cents: decision.feeCents, status: "authorized", decline_reason: null, hold_id: hold.id, funding_account: decision.funding.account, funding_party: decision.funding.party, expires_at: decision.expiresAt.toISOString() });
    return { authorizationId: id, approved: true, holdCents: decision.holdCents, feeCents: decision.feeCents, expiresAt: decision.expiresAt.toISOString() };
  }

  async capture(authId: string, amountCents: number) {
    const a = await this.store.one("card_authorizations", { id: authId });
    if (!a) throw new ApiError(404, "not_found", "authorization not found");
    let plan;
    try { plan = planCapture(this.toAuth(a), amountCents, this.now(), this.policy, this.fees); }
    catch (e) { throw new ApiError(422, "capture_rejected", (e as Error).message); }
    await this.store.postLedger(plan.ledger, `capture:${authId}`);
    await this.store.update("holds", { id: a.hold_id }, { status: "captured", released_at: this.now().toISOString() });
    await this.store.update("card_authorizations", { id: authId }, { status: "captured", captured_cents: plan.capturedCents, fee_cents: plan.feeCents, captured_at: this.now().toISOString() });
    return { authorizationId: authId, capturedCents: plan.capturedCents, feeCents: plan.feeCents, releasedCents: plan.releasedCents };
  }

  async merchantRefund(authId: string, refundId: string, amountCents: number) {
    const a = await this.store.one("card_authorizations", { id: authId });
    if (!a) throw new ApiError(404, "not_found", "authorization not found");
    const posted = (await this.store.list("card_refunds", { auth_id: authId })).map((r) => r.id);
    const existing = await this.store.one("card_refunds", { id: refundId });
    if (existing && existing.auth_id !== authId) throw new ApiError(409, "refund_id_conflict");
    let plan;
    try { plan = planMerchantRefund({ refundId, auth: this.toAuth(a), capturedCents: Number(a.captured_cents), refundedSoFarCents: Number(a.refunded_cents), amountCents, postedRefundIds: posted }); }
    catch (e) { throw new ApiError(422, "refund_rejected", (e as Error).message); }
    if (plan.duplicate) return { refundId, duplicate: true, refundedCents: Number(a.refunded_cents) };
    await this.store.insert("card_refunds", { id: refundId, auth_id: authId, amount_cents: amountCents });
    await this.store.postLedger(plan.ledger, `refund:${refundId}`);
    const refunded = Number(a.refunded_cents) + amountCents;
    await this.store.update("card_authorizations", { id: authId }, { refunded_cents: refunded });
    return { refundId, duplicate: false, refundedCents: refunded };
  }

  async expireAuths(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let expired = 0;
    for (const a of await this.store.list("card_authorizations", { status: "authorized" })) {
      if (new Date(a.expires_at).getTime() > now.getTime()) continue;
      await this.store.update("card_authorizations", { id: a.id }, { status: "expired" });
      await this.store.update("holds", { id: a.hold_id }, { status: "expired", released_at: now.toISOString() });
      expired++;
    }
    return { expired };
  }

  // ---------- family ----------
  async addFamilyMember(c: Caller, body: { name: string; kind: "spouse" | "teen"; limits: SpendLimits; blockedMccGroups?: string[]; memberEmail?: string }) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved");
    const count = (await this.store.list("family_members", { owner_user_id: c.userId })).filter((m) => m.status !== "removed").length;
    let m;
    try { m = newFamilyMember({ id: uuid(), ownerUserId: c.userId, name: body.name, kind: body.kind, limits: body.limits, blockedMccGroups: body.blockedMccGroups, existingCount: count }, this.policy); }
    catch (e) { throw new ApiError(422, "invalid_member", (e as Error).message); }
    const memberUser = body.memberEmail ? await this.store.one("profiles", { email: body.memberEmail.toLowerCase() }) : undefined;
    return this.store.insert("family_members", {
      id: m.id, owner_user_id: c.userId, member_user_id: memberUser?.id ?? null, name: m.name, kind: m.kind, status: m.status,
      per_txn_cents: m.limits.perTxnCents, daily_cents: m.limits.dailyCents, monthly_cents: m.limits.monthlyCents,
      blocked_mcc_groups: m.blockedMccGroups, blocked_mccs: m.blockedMccs, approved_at: m.status === "active" && m.kind === "teen" ? this.now().toISOString() : null,
    });
  }

  async memberFor(c: Caller, id: string) {
    const m = await this.store.one("family_members", { id });
    if (!m || (m.owner_user_id !== c.userId && m.member_user_id !== c.userId)) throw new ApiError(404, "not_found", "family member not found");
    return m;
  }

  async approveMember(c: Caller, id: string) {
    const m = await this.memberFor(c, id);
    try { guardianApprove(this.toMember(m), c.userId); }
    catch (e) { throw new ApiError(403, "guardian_required", (e as Error).message); }
    await this.store.update("family_members", { id }, { status: "active", approved_at: this.now().toISOString() });
    return { id, status: "active" };
  }

  async updateMemberLimits(c: Caller, id: string, body: { limits?: SpendLimits; blockedMccGroups?: string[] }) {
    const m = await this.memberFor(c, id);
    if (m.owner_user_id !== c.userId) throw new ApiError(403, "forbidden", "only the owner can change limits");
    const patch: Row = {};
    if (body.limits) {
      const errs = validateLimits(body.limits);
      if (errs.length) throw new ApiError(422, "invalid_limits", errs.join("; "));
      Object.assign(patch, { per_txn_cents: body.limits.perTxnCents, daily_cents: body.limits.dailyCents, monthly_cents: body.limits.monthlyCents });
    }
    if (body.blockedMccGroups) patch.blocked_mcc_groups = m.kind === "teen" ? [...new Set([...body.blockedMccGroups, "gambling", "alcohol", "tobacco", "adult"])] : body.blockedMccGroups;
    await this.store.update("family_members", { id }, patch);
    return { id, ...patch };
  }

  async allowanceTopUp(c: Caller, id: string, amountCents: number, idempotencyKey?: string) {
    const m = await this.memberFor(c, id);
    if (m.owner_user_id !== c.userId) throw new ApiError(403, "forbidden", "only the owner can fund an allowance");
    const chk = await this.pocket(c.userId, "checking");
    const tid = uuid();
    let t;
    try { t = planAllowanceTopUp({ id: tid, ownerAccountId: chk.id, member: this.toMember(m), amountCents, ownerAvailableCents: (await this.balanceOf(chk.id)).availableCents }); }
    catch (e) { throw new ApiError(422, "allowance_rejected", (e as Error).message); }
    await this.store.insert("transfers", {
      id: tid, user_id: c.userId, kind: "allowance_topup", speed: null, from_account_id: chk.id, to_account_id: null, family_member_id: id, linked_bank_id: null, counterparty_user_id: null,
      amount_cents: amountCents, fee_cents: 0, status: "completed", settle_at: null, return_code: null, new_payee: false,
      policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: idempotencyKey ?? null, created_at: this.now().toISOString(),
    });
    await this.store.postLedger(t, `transfer:${tid}`);
    return { id: tid, memberId: id, allowance: await this.allowanceOf(id) };
  }

  // ---------- disputes ----------
  async openDispute(c: Caller, body: { authorizationId: string; amountCents: number; reason: string }) {
    const a = await this.store.one("card_authorizations", { id: body.authorizationId });
    if (!a) throw new ApiError(404, "not_found", "transaction not found");
    await this.cardFor(c, a.card_id);
    if (a.status !== "captured") throw new ApiError(422, "not_disputable", "only posted (captured) purchases can be disputed");
    if (!body.reason?.trim()) throw new ApiError(422, "reason_required");
    const card = await this.store.one("cards", { id: a.card_id });
    const acct = await this.store.one("accounts", { id: card!.account_id });
    const existingOpen = (await this.store.list("disputes", { auth_id: a.id })).some((x) => x.status === "open" || x.status === "provisional_credited");
    let dsp: Dispute;
    try {
      dsp = openDispute({
        id: uuid(), authId: a.id, accountId: a.funding_party, creditAccount: a.funding_account, amountCents: body.amountCents,
        capturedCents: Number(a.captured_cents), refundedCents: Number(a.refunded_cents), postedAt: new Date(a.captured_at ?? a.created_at),
        now: this.now(), accountOpenedAt: new Date(acct!.opened_at), existingOpen,
      }, this.policy);
    } catch (e) { throw new ApiError(422, "dispute_rejected", (e as Error).message); }
    return this.store.insert("disputes", {
      id: dsp.id, auth_id: a.id, user_id: acct!.user_id, credit_account: dsp.creditAccount, credit_party: dsp.accountId, amount_cents: dsp.amountCents,
      reason: body.reason, status: "open", provisional_credit_cents: 0, provisional_credit_due_at: dsp.provisionalCreditDueAt.toISOString(),
      resolution_due_at: dsp.resolutionDueAt.toISOString(), policy_version: this.policy.version, opened_at: dsp.openedAt.toISOString(), resolved_at: null,
    });
  }

  toDispute(r: Row): Dispute {
    return {
      id: r.id, authId: r.auth_id, accountId: r.credit_party, creditAccount: r.credit_account, amountCents: Number(r.amount_cents), status: r.status,
      openedAt: new Date(r.opened_at), provisionalCreditDueAt: new Date(r.provisional_credit_due_at), resolutionDueAt: new Date(r.resolution_due_at),
      provisionalCreditCents: Number(r.provisional_credit_cents),
    };
  }

  async provisionalCredit(c: Caller | null, disputeId: string) {
    if (c) this.requireStaff(c);
    const r = await this.store.one("disputes", { id: disputeId });
    if (!r) throw new ApiError(404, "not_found");
    let plan;
    try { plan = planProvisionalCredit(this.toDispute(r)); } catch (e) { throw new ApiError(409, "invalid_transition", (e as Error).message); }
    await this.store.postLedger(plan.ledger, `dispute_pc:${disputeId}`);
    await this.store.update("disputes", { id: disputeId }, { status: plan.dispute.status, provisional_credit_cents: plan.dispute.provisionalCreditCents });
    return { id: disputeId, status: plan.dispute.status, provisionalCreditCents: plan.dispute.provisionalCreditCents };
  }

  async resolveDispute(c: Caller, disputeId: string, outcome: "won" | "lost") {
    this.requireStaff(c);
    if (outcome !== "won" && outcome !== "lost") throw new ApiError(422, "invalid_outcome");
    const r = await this.store.one("disputes", { id: disputeId });
    if (!r) throw new ApiError(404, "not_found");
    let plan;
    try { plan = resolveDispute(this.toDispute(r), outcome); } catch (e) { throw new ApiError(409, "invalid_transition", (e as Error).message); }
    if (plan.ledger) await this.store.postLedger(plan.ledger, `dispute_resolve:${disputeId}`);
    await this.store.update("disputes", { id: disputeId }, { status: outcome, provisional_credit_cents: plan.dispute.provisionalCreditCents, resolved_at: this.now().toISOString() });
    await this.audit(c.userId, "dispute_resolved", "dispute", disputeId, outcome);
    return { id: disputeId, status: outcome };
  }

  /** Job: give provisional credit to every open dispute whose due date has arrived (never late). */
  async disputeDeadlines(c: Caller | null) {
    if (c) this.requireStaff(c);
    let credited = 0;
    for (const r of await this.store.list("disputes", { status: "open" })) {
      if (new Date(r.provisional_credit_due_at).getTime() - this.now().getTime() <= 86_400_000) { await this.provisionalCredit(null, r.id); credited++; }
    }
    return { credited };
  }

  // ---------- interest ----------
  async accrueInterest(c: Caller | null, day?: string) {
    if (c) this.requireStaff(c);
    const dday = day ?? isoDate(this.now());
    let n = 0;
    for (const a of await this.store.list("accounts", { kind: "savings" })) {
      if (a.status === "closed") continue;
      if (await this.store.one("interest_accruals", { account_id: a.id, day: dday })) continue;
      const bal = (await this.balanceOf(a.id)).postedCents;
      await this.store.insert("interest_accruals", { account_id: a.id, day: dday, balance_cents: bal, accrued_micro: Number(dailyAccrualMicro(bal, this.policy)) });
      n++;
    }
    return { day: dday, accounts: n };
  }

  async postInterest(c: Caller | null, period: string) {
    if (c) this.requireStaff(c);
    periodBounds(period);
    const out = [];
    for (const a of await this.store.list("accounts", { kind: "savings" })) {
      if (await this.store.one("interest_postings", { account_id: a.id, period })) continue;
      const accrued = (await this.store.list("interest_accruals", { account_id: a.id })).filter((x) => String(x.day).startsWith(period)).reduce((s, x) => s + BigInt(x.accrued_micro), 0n);
      const prev = (await this.store.list("interest_postings", { account_id: a.id })).sort((x, y) => y.period.localeCompare(x.period))[0];
      const carryIn = prev ? BigInt(prev.carry_out_micro) : 0n;
      const plan = planMonthlyInterest({ accountId: a.id, period, accruedMicro: accrued, carryInMicro: carryIn });
      if (plan.ledger) await this.store.postLedger(plan.ledger, `interest:${a.id}:${period}`);
      await this.store.insert("interest_postings", { account_id: a.id, period, accrued_micro: Number(accrued), carry_in_micro: Number(carryIn), posted_cents: plan.postCents, carry_out_micro: Number(plan.carryMicro) });
      out.push({ accountId: a.id, postedCents: plan.postCents, carryMicro: Number(plan.carryMicro) });
    }
    return { period, postings: out };
  }

  // ---------- statements ----------
  async statement(c: Caller, accountId: string, period: string) {
    const a = await this.store.one("accounts", { id: accountId });
    if (!a || (a.user_id !== c.userId && c.role === "customer")) throw new ApiError(404, "not_found", "account not found");
    const rows = await this.store.ledger({ account: "customer_deposits", party: accountId });
    try {
      const s = buildStatement(accountId, period, rows.map((r) => ({ at: new Date(r.at), kind: r.kind, ref: r.ref ?? undefined, debit: Number(r.debit), credit: Number(r.credit) })));
      return { ...s, accountNumber: a.account_number, kind: a.kind, entries: s.entries.map((e) => ({ ...e, at: e.at.toISOString() })) };
    } catch (e) { throw new ApiError(422, "invalid_period", (e as Error).message); }
  }

  // ---------- closure ----------
  async closeAccount(c: Caller, body: { bankId?: string }) {
    const p = await this.profile(c.userId);
    const pockets = await this.pockets(c.userId);
    if (!pockets.length) throw new ApiError(409, "already_closed");
    const holds = await this.holds();
    const now = this.now();
    const members = (await this.store.list("family_members", { owner_user_id: c.userId })).filter((m) => m.status !== "removed");
    const memberIds = new Set(members.map((m) => `member:${m.id}`));
    const activeHolds = holds.filter((h) => (pockets.some((a) => a.id === h.accountId) || memberIds.has(h.accountId)) && holdIsActive(h, now)).reduce((s, h) => s + h.amountCents, 0);
    const banks = (await this.store.list("linked_banks", { user_id: c.userId })).filter((b) => b.status === "active");
    const bankRow = body.bankId ? banks.find((b) => b.id === body.bankId) : banks.find((b) => b.name_matched);
    const cards = (await this.store.list("cards")).filter((x) => pockets.some((a) => a.id === x.account_id)).map((r) => this.toCard(r));
    const pocketsBal = [];
    for (const a of pockets) pocketsBal.push({ accountId: a.id, postedCents: (await this.balanceOf(a.id)).postedCents });
    const allowance = [];
    for (const m of members.filter((x) => x.kind === "teen")) allowance.push({ memberId: m.id, postedCents: (await this.allowanceOf(m.id)).postedCents });
    const openDisputes = (await this.store.list("disputes", { user_id: c.userId })).filter((x) => x.status === "open" || x.status === "provisional_credited").length;
    const input = { kyc: p.kyc_state, accountStatus: "open", pockets: pocketsBal, activeHoldsCents: activeHolds, openDisputes, linkedBank: bankRow ? this.toBank(bankRow) : null, cards, allowancePockets: allowance };
    const blocks = closureBlocks(input);
    if (blocks.length) {
      await this.store.insert("closures", { user_id: c.userId, payout_cents: 0, linked_bank_id: bankRow?.id ?? null, status: "blocked", blocks });
      throw new ApiError(409, "closure_blocked", `closure blocked: ${blocks.join(", ")}`, blocks);
    }
    const closureId = uuid();
    const plan = planClosure(input, closureId);
    for (const id of plan.cardsToCancel) {
      const card = await this.store.one("cards", { id });
      await this.providers.issuer.setStatus(card!.provider_card_id, "canceled");
      await this.store.update("cards", { id }, { status: "canceled", canceled_at: now.toISOString() });
    }
    if (plan.ledger) {
      await this.store.postLedger(plan.ledger, `closure:${closureId}`);
      await this.store.insert("transfers", {
        user_id: c.userId, kind: "closure_payout", speed: null, from_account_id: pockets.find((a) => a.kind === "checking")?.id ?? null, to_account_id: null,
        linked_bank_id: bankRow!.id, counterparty_user_id: null, amount_cents: plan.payoutCents, fee_cents: 0, status: "pending", settle_at: null, return_code: null,
        new_payee: false, policy_version: this.policy.version, fee_version: this.fees.version, idempotency_key: null, created_at: now.toISOString(),
      });
    }
    for (const a of pockets) await this.store.update("accounts", { id: a.id }, { status: "closed", closed_at: now.toISOString() });
    for (const m of members) await this.store.update("family_members", { id: m.id }, { status: "removed" });
    await this.store.insert("closures", { id: closureId, user_id: c.userId, payout_cents: plan.payoutCents, linked_bank_id: bankRow?.id ?? null, status: "completed", blocks: [] });
    await this.audit(c.userId, "account_closed", "profile", c.userId, undefined, { payoutCents: plan.payoutCents });
    return { closureId, payoutCents: plan.payoutCents, cardsCanceled: plan.cardsToCancel.length };
  }

  // ---------- admin ----------
  async adminUsers(c: Caller, kyc?: string) {
    this.requireStaff(c);
    const users = await this.store.list("profiles", kyc ? { kyc_state: kyc } : undefined);
    const out = [];
    for (const u of users) {
      const checks = (await this.store.list("kyc_checks", { user_id: u.id })).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const accts = [];
      for (const a of await this.store.list("accounts", { user_id: u.id })) accts.push({ id: a.id, kind: a.kind, status: a.status, ...(await this.balanceOf(a.id)) });
      out.push({ id: u.id, email: u.email, legalName: u.legal_name, role: u.role, kycState: u.kyc_state, tier: u.tier, lastCheck: checks[0] ?? null, accounts: accts });
    }
    return out;
  }

  async adminSetAccountStatus(c: Caller, accountId: string, status: "open" | "frozen", reason: string) {
    this.requireStaff(c);
    if (!reason?.trim()) throw new ApiError(422, "reason_required");
    const a = await this.store.one("accounts", { id: accountId });
    if (!a || a.status === "closed") throw new ApiError(404, "not_found");
    await this.store.update("accounts", { id: accountId }, { status });
    await this.audit(c.userId, status === "frozen" ? "account_frozen" : "account_unfrozen", "account", accountId, reason);
    return { accountId, status };
  }

  async adminLedger(c: Caller, limit = 200) {
    this.requireStaff(c);
    const rows = await this.store.ledger({ limit: limit * 4 });
    const byTxn = new Map<string, { id: string; kind: string; ref: string | null; at: string; lines: Row[] }>();
    for (const r of rows) {
      const t = byTxn.get(r.txn_id) ?? { id: r.txn_id, kind: r.kind, ref: r.ref, at: r.at, lines: [] };
      t.lines.push({ account: r.account, party: r.party, debit: r.debit, credit: r.credit });
      byTxn.set(r.txn_id, t);
    }
    const txns = [...byTxn.values()].reverse().slice(0, limit);
    const all = await this.store.ledger();
    const trial = all.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    return { txns, trialBalanceCents: trial };
  }

  async adminDisputes(c: Caller) {
    this.requireStaff(c);
    return this.store.list("disputes");
  }

  async adminAudit(c: Caller) {
    this.requireStaff(c);
    return (await this.store.list("audit_log")).slice(-200).reverse();
  }

  // ---------- idempotency ----------
  idemStore(userId: string): IdemStore {
    return {
      get: async (key) => {
        const r = await this.store.one("idempotency_keys", { key: `${userId}:${key}` });
        return r ? { key, requestHash: r.request_hash, status: r.status, body: r.body } : undefined;
      },
      put: async (rec) => { await this.store.insert("idempotency_keys", { key: `${userId}:${rec.key}`, user_id: userId, request_hash: rec.requestHash, status: rec.status, body: rec.body }); },
    };
  }

  async idempotent<T>(c: Caller, key: string | undefined, route: string, body: unknown, fn: () => Promise<T>) {
    try {
      return await withIdempotency(this.idemStore(c.userId), key, { route, body }, async () => {
        try { return { status: 200, body: await fn() as unknown }; }
        catch (e) {
          if (e instanceof ApiError && e.status < 500) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } as unknown };
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof IdempotencyConflict) throw new ApiError(422, "idempotency_conflict", e.message);
      throw e;
    }
  }
}
