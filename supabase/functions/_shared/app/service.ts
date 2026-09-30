// Harbor application service: orchestrates domain rules + providers + store.
// Used by the `api` Edge Function (SupabaseStore) and the browser demo / tests (MemoryStore).
// All money rules live in ../domain; this file only loads state, calls the domain, and persists.

import {
  DEFAULT_FEES,
  DEFAULT_POLICY,
  type FeeSchedule,
  type MoneyPolicy,
  type Tier,
  mapIdentityStatus,
  decideKyc,
  screenSanctions,
  canTransitionKyc,
  canMoveMoney,
  withVendorTimeout,
  requiresStaff,
  type KycState,
  fakeAccountNumber,
  HARBOR_ROUTING_NUMBER,
  balances,
  holdIsActive,
  type Hold,
  ownerNameMatches,
  planAchPull,
  planAchReturn,
  canSettle,
  validateDirectDepositForm,
  type LinkedBank,
  type DirectDepositForm,
  planAchPush,
  planP2P,
  planPocketMove,
  TransferError,
  transferFee,
  type SenderCtx,
  type Speed,
  authorize,
  planCapture,
  planMerchantRefund,
  canIssueCard,
  initialCardStatus,
  canTransitionCard,
  type Card,
  type CardStatus,
  type Authorization,
  newFamilyMember,
  guardianApprove,
  planAllowanceTopUp,
  validateLimits,
  type FamilyMember,
  type SpendLimits,
  openDispute,
  planProvisionalCredit,
  resolveDispute,
  type Dispute,
  dailyAccrualMicro,
  planMonthlyInterest,
  closureBlocks,
  planClosure,
  buildStatement,
  periodBounds,
  withIdempotency,
  IdempotencyConflict,
  type IdemStore,
  type UsageEvent,
  type Line,
  type LedgerAccount,
  isoDate,
  addHours,
  addBusinessDays,
  checkLimit,
  limitWindow,
  type AccountKind,
  validateEnvelopeDates,
  envelopeReachedEnd,
  planEnvelopeSweep,
  validateHouseholdName,
  validateMonthlyCap,
  planZelleSend,
  planZelleReturn,
  nextZelleRun,
  validateRecipient,
  isValidFrequency,
  ZelleError,
  type ZelleFrequency,
  type ZelleRecipient,
  type SpendablePocket,
  cashbackForCapture,
  cashbackReversal,
  cashbackLedger,
  cashbackReversalLedger,
} from "../domain/index.ts";
import type { Providers } from "../providers/index.ts";
import { MoneyOpError, uuid, type Row, type Store } from "./store.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export interface Caller {
  userId: string;
  role: "customer" | "admin" | "support_agent";
}

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
  now() {
    return this.clock();
  }

  async audit(
    actor: string | null,
    action: string,
    entity: string,
    entityId: string | null,
    reason?: string,
    data?: unknown,
  ) {
    await this.store.insert("audit_log", {
      actor_id: actor,
      action,
      entity,
      entity_id: entityId,
      reason: reason ?? null,
      data: data ?? null,
      created_at: this.now().toISOString(),
    });
  }

  async profile(userId: string): Promise<Row> {
    const p = await this.store.one("profiles", { id: userId });
    if (!p) throw new ApiError(404, "not_found", "profile not found");
    return p;
  }

  requireStaff(c: Caller) {
    if (c.role !== "admin" && c.role !== "support_agent")
      throw new ApiError(403, "forbidden", "staff only");
  }
  requireAdmin(c: Caller) {
    if (c.role !== "admin") throw new ApiError(403, "forbidden", "admin only");
  }

  /** Transfers store the client's Idempotency-Key namespaced by user (unique per user, not globally). */
  transferIdemKey(c: Caller, key?: string): string | null {
    return key ? `${c.userId}:${key}` : null;
  }

  /**
   * An atomic money operation refused to write because a guard failed under its row locks (the
   * state changed after this request planned it). Map it onto the endpoint's error contract.
   * Payload/ledger mismatches are server bugs and stay 500s.
   */
  opFailed(e: unknown, contract?: { status: number; code: string }): never {
    if (
      !(e instanceof MoneyOpError) ||
      e.code === "payload_mismatch" ||
      e.code === "unbalanced_ledger"
    )
      throw e;
    if (e.code === "insufficient_funds" || e.code === "daily_limit" || e.code === "monthly_limit")
      throw new ApiError(422, e.code, e.message);
    if (e.code === "not_found") throw new ApiError(404, "not_found", e.message);
    if (contract) throw new ApiError(contract.status, contract.code, e.message);
    throw new ApiError(409, e.code, e.message);
  }

  async pockets(userId: string): Promise<Row[]> {
    return (await this.store.list("accounts", { user_id: userId })).filter(
      (a) => a.status !== "closed",
    );
  }

  /** The user's default pocket of a kind. For checking this is the primary pocket (cards, ACH,
   *  allowances and Zelle default to it); other kinds return the oldest open pocket. */
  async pocket(userId: string, kind: AccountKind): Promise<Row> {
    const of = (await this.pockets(userId)).filter((x) => x.kind === kind);
    const a = kind === "checking" ? (of.find((x) => x.is_primary) ?? of[0]) : of[0];
    if (!a) throw new ApiError(409, "no_account", `no open ${kind} account (complete KYC first)`);
    return a;
  }

  /** The user's primary checking row (for envelope sweeps / closure payout), or null if none open. */
  async primaryCheckingRow(userId: string): Promise<Row | null> {
    const checking = (await this.pockets(userId)).filter((x) => x.kind === "checking");
    return checking.find((x) => x.is_primary) ?? checking[0] ?? null;
  }

  /** A pocket owned by the caller, still open. Used by on-demand transfers, cards and Zelle sends. */
  async accountOf(userId: string, accountId: string): Promise<Row> {
    const a = await this.store.one("accounts", { id: accountId, user_id: userId });
    if (!a || a.status === "closed") throw new ApiError(404, "not_found", "account not found");
    return a;
  }

  /** Pockets a Zelle send may draw from: the source first, then the user's other open checking and
   *  savings pockets (never earmarked envelopes) ordered checking→savings then oldest first. */
  async spendableForZelle(userId: string, source: Row): Promise<SpendablePocket[]> {
    const open = (await this.pockets(userId)).filter((a) => a.status === "open");
    const others = open
      .filter((a) => a.id !== source.id && (a.kind === "checking" || a.kind === "savings"))
      .sort((x, y) =>
        x.kind === y.kind
          ? String(x.opened_at).localeCompare(String(y.opened_at))
          : x.kind === "checking"
            ? -1
            : 1,
      );
    const out: SpendablePocket[] = [];
    for (const a of [source, ...others])
      out.push({
        accountId: a.id,
        kind: a.kind,
        availableCents: (await this.balanceOf(a.id)).availableCents,
      });
    return out;
  }

  /** The active household this user belongs to (as owner or member), or null. */
  async householdOf(userId: string): Promise<Row | null> {
    const m = (await this.store.list("household_members", { user_id: userId })).find(
      (x) => x.status === "active",
    );
    if (!m) return null;
    return (await this.store.one("households", { id: m.household_id })) ?? null;
  }

  /** Card-spend usage across every card of every active member of a household (for the monthly cap). */
  async householdCardSpend(householdId: string): Promise<UsageEvent[]> {
    const members = (await this.store.list("household_members", { household_id: householdId }))
      .filter((m) => m.status === "active" && m.user_id)
      .map((m) => m.user_id);
    const events: UsageEvent[] = [];
    for (const uid of members)
      for (const e of await this.usage(uid)) if (e.kind === "card_spend") events.push(e);
    return events;
  }

  /** Card-spend usage for one card (for its own per-card daily / monthly limits). */
  async cardSpendEvents(cardId: string): Promise<UsageEvent[]> {
    return (await this.store.list("card_authorizations", { card_id: cardId }))
      .filter((a) => a.status === "authorized" || a.status === "captured")
      .map((a) => ({
        at: new Date(a.created_at),
        amountCents: Number(a.status === "captured" ? a.captured_cents : a.amount_cents),
        kind: "card_spend" as const,
      }));
  }

  async holds(): Promise<Hold[]> {
    return (await this.store.list("holds")).map((h) => ({
      id: h.id,
      accountId: h.account_id ?? `member:${h.family_member_id}`,
      kind: h.kind,
      amountCents: Number(h.amount_cents),
      status: h.status,
      createdAt: new Date(h.created_at),
      expiresAt: d(h.expires_at),
      releaseAt: d(h.release_at),
    }));
  }

  async lines(account: LedgerAccount, party: string): Promise<Line[]> {
    return (await this.store.ledger({ account, party })).map((l) => ({
      account: l.account as LedgerAccount,
      party: l.party ?? undefined,
      debit: Number(l.debit),
      credit: Number(l.credit),
    }));
  }

  async balanceOf(accountId: string) {
    return balances(
      await this.lines("customer_deposits", accountId),
      await this.holds(),
      accountId,
      this.now(),
    );
  }

  async allowanceOf(memberId: string) {
    const lines = (await this.lines("family_allowance", memberId)).map((l) => ({
      ...l,
      account: "customer_deposits" as const,
      party: `member:${memberId}`,
    }));
    return balances(lines, await this.holds(), `member:${memberId}`, this.now());
  }

  async usage(userId: string): Promise<UsageEvent[]> {
    const ev: UsageEvent[] = [];
    for (const t of await this.store.list("transfers", { user_id: userId })) {
      if (t.status === "failed") continue;
      if (
        (t.kind === "ach_out" || t.kind === "p2p" || t.kind === "zelle") &&
        t.status !== "returned"
      )
        ev.push({
          at: new Date(t.created_at),
          amountCents: Number(t.amount_cents),
          kind: "transfer_out",
        });
      if (t.kind === "ach_in" && t.status !== "returned")
        ev.push({
          at: new Date(t.created_at),
          amountCents: Number(t.amount_cents),
          kind: "ach_in",
        });
    }
    const accountIds = new Set(
      (await this.store.list("accounts", { user_id: userId })).map((a) => a.id),
    );
    const cards = (await this.store.list("cards")).filter((c) => accountIds.has(c.account_id));
    const cardIds = new Set(cards.map((c) => c.id));
    for (const a of await this.store.list("card_authorizations")) {
      if (!cardIds.has(a.card_id)) continue;
      const amt =
        a.status === "captured"
          ? Number(a.captured_cents)
          : a.status === "authorized"
            ? Number(a.amount_cents)
            : 0;
      if (amt > 0) ev.push({ at: new Date(a.created_at), amountCents: amt, kind: "card_spend" });
    }
    return ev;
  }

  async memberSpend(memberId: string): Promise<UsageEvent[]> {
    const cardIds = new Set(
      (await this.store.list("cards", { family_member_id: memberId })).map((c) => c.id),
    );
    return (await this.store.list("card_authorizations"))
      .filter(
        (a) => cardIds.has(a.card_id) && (a.status === "authorized" || a.status === "captured"),
      )
      .map((a) => ({
        at: new Date(a.created_at),
        amountCents:
          Number(a.status === "captured" ? a.captured_cents : a.amount_cents) + Number(a.fee_cents),
        kind: "card_spend" as const,
      }));
  }

  async senderCtx(userId: string): Promise<SenderCtx> {
    const p = await this.profile(userId);
    const chk = await this.pocket(userId, "checking");
    return {
      kyc: p.kyc_state,
      tier: p.tier as Tier,
      accountId: chk.id,
      accountStatus: chk.status,
      availableCents: (await this.balanceOf(chk.id)).availableCents,
      usage: await this.usage(userId),
    };
  }

  toBank(r: Row): LinkedBank {
    return {
      id: r.id,
      userId: r.user_id,
      institution: r.institution,
      mask: r.mask,
      ownerNames: r.owner_names,
      nameMatched: r.name_matched,
      linkedAt: new Date(r.linked_at),
      status: r.status,
    };
  }

  async bankOf(userId: string, bankId: string): Promise<LinkedBank> {
    const b = await this.store.one("linked_banks", { id: bankId, user_id: userId });
    if (!b) throw new ApiError(404, "not_found", "linked bank not found");
    return this.toBank(b);
  }

  toCard(r: Row): Card {
    return {
      id: r.id,
      accountId: r.account_id,
      holderUserId: r.holder_user_id,
      familyMemberId: r.family_member_id ?? undefined,
      kind: r.kind,
      status: r.status,
      last4: r.last4,
    };
  }

  toMember(r: Row): FamilyMember {
    return {
      id: r.id,
      ownerUserId: r.owner_user_id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      limits: {
        perTxnCents: Number(r.per_txn_cents),
        dailyCents: Number(r.daily_cents),
        monthlyCents: Number(r.monthly_cents),
      },
      blockedMccGroups: r.blocked_mcc_groups ?? [],
      blockedMccs: r.blocked_mccs ?? [],
    };
  }

  toAuth(r: Row): Authorization {
    return {
      id: r.id,
      cardId: r.card_id,
      amountCents: Number(r.amount_cents),
      feeCents: Number(r.fee_cents),
      mcc: r.mcc,
      foreign: r.foreign_txn,
      atmOutOfNetwork: r.atm_out_of_network ?? false,
      status: r.status,
      expiresAt: new Date(r.expires_at),
      funding: { account: r.funding_account, party: r.funding_party },
    };
  }

  /** Card visible to caller: owner of the funding account or the family member holder. */
  async cardFor(c: Caller, cardId: string): Promise<Row> {
    const card = await this.store.one("cards", { id: cardId });
    if (!card) throw new ApiError(404, "not_found", "card not found");
    const acct = await this.store.one("accounts", { id: card.account_id });
    if (acct?.user_id !== c.userId && card.holder_user_id !== c.userId && c.role === "customer")
      throw new ApiError(404, "not_found", "card not found");
    return card;
  }

  async ownedCard(c: Caller, cardId: string): Promise<Row> {
    const card = await this.cardFor(c, cardId);
    const acct = await this.store.one("accounts", { id: card.account_id });
    if (acct?.user_id !== c.userId && c.role === "customer")
      throw new ApiError(403, "forbidden", "only the account owner can manage this card");
    return card;
  }

  // ---------- onboarding / KYC ----------
  async createProfile(
    userId: string,
    email: string,
    legalName: string,
    role: Caller["role"] = "customer",
  ) {
    const existing = await this.store.one("profiles", { id: userId });
    if (existing) return existing;
    return this.store.insert("profiles", {
      id: userId,
      email: email.toLowerCase(),
      legal_name: legalName,
      role,
      kyc_state: "unverified",
      tier: "tier1",
      step_up_enrolled: false,
      created_at: this.now().toISOString(),
    });
  }

  async ensureAccounts(userId: string) {
    const existing = await this.pockets(userId);
    for (const kind of ["checking", "savings"] as const) {
      if (existing.some((a) => a.kind === kind)) continue;
      const id = uuid();
      await this.store.insert("accounts", {
        id,
        user_id: userId,
        kind,
        status: "open",
        account_number: fakeAccountNumber(id),
        routing_number: HARBOR_ROUTING_NUMBER,
        nickname: kind === "checking" ? "Everyday" : "Savings",
        is_primary: kind === "checking",
        start_date: null,
        end_date: null,
        policy_version: this.policy.version,
        opened_at: this.now().toISOString(),
        closed_at: null,
      });
    }
  }

  async setKyc(userId: string, to: KycState, reason: string, by: string | null, extra: Row = {}) {
    const p = await this.profile(userId);
    const from = p.kyc_state as KycState;
    if (from !== to && !canTransitionKyc(from, to))
      throw new ApiError(409, "invalid_transition", `KYC cannot go from ${from} to ${to}`);
    await this.store.update("profiles", { id: userId }, { kyc_state: to });
    await this.store.insert("kyc_checks", {
      user_id: userId,
      provider: extra.provider ?? "manual",
      session_id: extra.session_id ?? null,
      identity_status: extra.identity_status ?? null,
      sanctions: extra.sanctions ?? null,
      decision: to,
      reason,
      decided_by: by,
      created_at: this.now().toISOString(),
    });
    if (to === "approved") await this.ensureAccounts(userId);
    if (to === "frozen_legal")
      for (const a of await this.pockets(userId))
        await this.store.update("accounts", { id: a.id }, { status: "frozen" });
    if (to === "approved" && from === "frozen_legal")
      for (const a of await this.pockets(userId))
        await this.store.update("accounts", { id: a.id }, { status: "open" });
    await this.audit(by, "kyc_transition", "profile", userId, reason, { from, to });
  }

  async runKyc(c: Caller, sessionId?: string) {
    const p = await this.profile(c.userId);
    if (!["unverified", "pending"].includes(p.kyc_state))
      throw new ApiError(409, "kyc_already_decided", `KYC is ${p.kyc_state}`);
    const session = sessionId
      ? { sessionId }
      : await this.providers.identity.start(c.userId, p.legal_name);
    let raw: string;
    try {
      const r = await withVendorTimeout(
        this.providers.identity.status(session.sessionId),
        this.kycTimeoutMs,
      );
      raw = r === "timeout" ? "timeout" : r;
    } catch {
      raw = "timeout"; // vendor errors are treated like timeouts: never approve
    }
    const identity = mapIdentityStatus(raw);
    const sanctions = screenSanctions(p.legal_name, this.policy);
    const decision = decideKyc(identity, sanctions);
    await this.setKyc(c.userId, decision.state, decision.reason, null, {
      provider: this.providers.identity.name,
      session_id: session.sessionId,
      identity_status: raw,
      sanctions,
    });
    return {
      state: decision.state,
      reason: decision.reason,
      sessionId: session.sessionId,
      identityStatus: raw,
      sanctions: sanctions.kind,
    };
  }

  async adminSetKyc(c: Caller, userId: string, to: KycState, reason: string) {
    this.requireStaff(c);
    if (!reason?.trim()) throw new ApiError(422, "reason_required", "a reason is required");
    const p = await this.profile(userId);
    if ((to === "approved" && p.kyc_state === "frozen_legal") || to === "frozen_legal")
      this.requireAdmin(c);
    // Staff can approve only after an automated check routed the customer to review (or to lift a suspension/freeze);
    // they can never skip verification for unverified/pending/rejected customers.
    if (to === "approved" && !requiresStaff(p.kyc_state, to))
      throw new ApiError(
        409,
        "manual_approval_not_allowed",
        `cannot manually approve a ${p.kyc_state} customer`,
      );
    if (to === "approved" && p.kyc_state === "rejected")
      throw new ApiError(
        409,
        "manual_approval_not_allowed",
        "rejected customers must appeal into review first",
      );
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
      accounts.push({
        id: a.id,
        kind: a.kind,
        status: a.status,
        nickname: a.nickname,
        accountNumber: a.account_number,
        routingNumber: a.routing_number,
        isPrimary: !!a.is_primary,
        startDate: a.start_date ?? null,
        endDate: a.end_date ?? null,
        ...(await this.balanceOf(a.id)),
      });
    }
    const banks = (await this.store.list("linked_banks", { user_id: c.userId }))
      .filter((b) => b.status === "active")
      .map((b) => {
        const bank = this.toBank(b);
        return {
          id: b.id,
          institution: b.institution,
          mask: b.mask,
          ownerNames: b.owner_names,
          nameMatched: b.name_matched,
          linkedAt: b.linked_at,
          coolingOffUntil: addHours(
            bank.linkedAt,
            this.policy.achOut.coolingOffHours,
          ).toISOString(),
        };
      });
    const accountIds = new Set(accounts.map((a) => a.id));
    const cards = (await this.store.list("cards")).filter(
      (x) => accountIds.has(x.account_id) || x.holder_user_id === c.userId,
    );
    const family = [];
    for (const m of await this.store.list("family_members", { owner_user_id: c.userId })) {
      if (m.status === "removed") continue;
      family.push({
        ...this.toMember(m),
        allowance: m.kind === "teen" ? await this.allowanceOf(m.id) : null,
      });
    }
    const transfers = (await this.store.list("transfers", { user_id: c.userId }))
      .concat(await this.store.list("transfers", { counterparty_user_id: c.userId }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50);
    const cardIds = new Set(cards.map((x) => x.id));
    const authorizations = (await this.store.list("card_authorizations"))
      .filter((a) => cardIds.has(a.card_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50);
    const disputes = await this.store.list("disputes", { user_id: c.userId });
    const u = await this.usage(c.userId);
    const householdRow = await this.householdOf(c.userId);
    let household = null;
    if (householdRow) {
      const members = (
        await this.store.list("household_members", { household_id: householdRow.id })
      ).filter((m) => m.status !== "removed");
      household = {
        id: householdRow.id,
        name: householdRow.name,
        ownerUserId: householdRow.owner_user_id,
        monthlyCapCents: householdRow.monthly_cap_cents ?? null,
        monthSpendCents:
          householdRow.monthly_cap_cents != null
            ? (await this.householdCardSpend(householdRow.id)).reduce(
                (s, e) => s + e.amountCents,
                0,
              )
            : null,
        members: members.map((m) => ({
          id: m.id,
          userId: m.user_id ?? null,
          invitedEmail: m.invited_email ?? null,
          role: m.role,
          status: m.status,
        })),
      };
    }
    const zelleSchedules = (await this.store.list("zelle_schedules", { user_id: c.userId })).filter(
      (s) => s.status === "active",
    );
    return {
      profile: {
        id: p.id,
        email: p.email,
        legalName: p.legal_name,
        role: p.role,
        kycState: p.kyc_state,
        tier: p.tier,
      },
      limits: this.policy.tiers[p.tier as Tier],
      usage: u.map((e) => ({ ...e, at: e.at.toISOString() })),
      accounts,
      banks,
      cards,
      family,
      household,
      transfers,
      authorizations,
      disputes,
      zelleSchedules,
      now: this.now().toISOString(),
    };
  }

  publishedTerms() {
    return { fees: this.fees, policy: this.policy };
  }

  // ---------- banks ----------
  async linkToken(c: Caller) {
    await this.profile(c.userId);
    return {
      linkToken: await this.providers.bank.createLinkToken(c.userId),
      provider: this.providers.bank.name,
    };
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
      user_id: c.userId,
      provider: this.providers.bank.name,
      provider_item_id: ex.itemId,
      provider_account_id: acct.accountId,
      institution: acct.institution,
      mask: acct.mask,
      owner_names: acct.ownerNames,
      name_matched: nameMatched,
      status: "active",
      linked_at: this.now().toISOString(),
    });
    await this.store.insert("bank_access_tokens", {
      linked_bank_id: row.id,
      access_token: ex.accessToken,
    });
    await this.audit(c.userId, "bank_linked", "linked_bank", row.id, undefined, { nameMatched });
    return {
      id: row.id,
      institution: row.institution,
      mask: row.mask,
      nameMatched,
      ownerNames: acct.ownerNames,
    };
  }

  async removeBank(c: Caller, bankId: string) {
    await this.bankOf(c.userId, bankId);
    await this.store.update("linked_banks", { id: bankId }, { status: "removed" });
    return { id: bankId, status: "removed" };
  }

  async directDeposit(c: Caller, f: DirectDepositForm & { accountKind?: "checking" | "savings" }) {
    const p = await this.profile(c.userId);
    const acct = await this.pocket(c.userId, f.accountKind ?? "checking");
    const form = {
      ...f,
      accountNumber: acct.account_number,
      routingNumber: acct.routing_number,
      accountType: acct.kind,
    };
    const errors = validateDirectDepositForm(form, p.legal_name);
    if (errors.length) throw new ApiError(422, "invalid_form", errors.join("; "), errors);
    const row = await this.store.insert("direct_deposit_forms", {
      user_id: c.userId,
      account_id: acct.id,
      employer_name: f.employerName,
      allocation: f.allocation,
      signature_name: f.signatureName,
    });
    return {
      id: row.id,
      recorded: true,
      accountNumber: acct.account_number,
      routingNumber: acct.routing_number,
    };
  }

  // ---------- money in ----------
  async achIn(c: Caller, body: { bankId: string; amountCents: number; idempotencyKey?: string }) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state))
      throw new ApiError(403, "kyc_not_approved", "complete verification first");
    const chk = await this.pocket(c.userId, "checking");
    if (chk.status !== "open") throw new ApiError(409, "account_frozen");
    const bank = await this.bankOf(c.userId, body.bankId);
    const lim = checkLimit(
      p.tier,
      "ach_in",
      body.amountCents,
      await this.usage(c.userId),
      this.now(),
      this.policy,
    );
    if (!lim.ok)
      throw new ApiError(422, lim.reason!, `deposit limit: remaining today ${lim.remainingDaily}`);
    const id = uuid();
    let plan;
    try {
      plan = planAchPull(
        { transferId: id, accountId: chk.id, amountCents: body.amountCents, bank, now: this.now() },
        this.policy,
      );
    } catch (e) {
      throw new ApiError(
        422,
        /name/.test((e as Error).message) ? "bank_name_mismatch" : "invalid_request",
        (e as Error).message,
      );
    }
    const at = this.now().toISOString();
    await this.store
      .achPullCreate({
        transfer: {
          id,
          user_id: c.userId,
          kind: "ach_in",
          speed: null,
          to_account_id: chk.id,
          from_account_id: null,
          linked_bank_id: bank.id,
          counterparty_user_id: null,
          family_member_id: null,
          amount_cents: body.amountCents,
          fee_cents: 0,
          status: "pending",
          settle_at: plan.settleAt.toISOString(),
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, body.idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...plan.ledger, idem: `transfer:${id}` },
        hold: {
          id: uuid(),
          account_id: chk.id,
          family_member_id: null,
          kind: "ach_in",
          amount_cents: plan.holdCents,
          status: "active",
          ref_id: id,
          expires_at: null,
          release_at: plan.settleAt.toISOString(),
          created_at: at,
          released_at: null,
        },
        limit: limitWindow(p.tier, "ach_in", this.now(), this.policy),
        at,
      })
      .catch((e) => this.opFailed(e));
    return {
      id,
      status: "pending",
      amountCents: body.amountCents,
      settleAt: plan.settleAt.toISOString(),
      holdCents: plan.holdCents,
    };
  }

  async settleAch(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let settled = 0;
    for (const t of await this.store.list("transfers", { status: "pending" })) {
      if (!t.settle_at || !canSettle(new Date(t.settle_at), now)) continue;
      if (await this.store.achSettle({ transferId: t.id, at: now.toISOString() })) settled++;
    }
    return { settled };
  }

  async achReturn(c: Caller, transferId: string, code: string) {
    this.requireStaff(c);
    const t = await this.store.one("transfers", { id: transferId });
    if (!t || t.kind !== "ach_in") throw new ApiError(404, "not_found", "ACH deposit not found");
    const posted = (await this.balanceOf(t.to_account_id)).postedCents;
    let plan;
    try {
      plan = planAchReturn(
        {
          transferId,
          accountId: t.to_account_id,
          amountCents: Number(t.amount_cents),
          returnCode: code,
          status: t.status,
          postedBalanceCents: posted,
        },
        this.policy,
      );
    } catch (e) {
      throw new ApiError(409, "already_returned", (e as Error).message);
    }
    if (!plan.reverses) return { reversed: false, code };
    await this.store
      .achReturn({
        transferId,
        code,
        ledger: { ...plan.ledger!, idem: `return:${transferId}` },
        at: this.now().toISOString(),
        actorId: c.userId,
        audit: { negativeBalanceCents: plan.negativeBalanceCents },
      })
      .catch((e) => this.opFailed(e));
    return {
      reversed: true,
      code,
      negativeBalanceCents: plan.negativeBalanceCents,
      heldBeforeSettlement: plan.releaseHold,
    };
  }

  // ---------- money out ----------
  mapTransferError(e: unknown): never {
    if (e instanceof TransferError)
      throw new ApiError(
        e.code === "kyc_not_approved" || e.code === "payout_blocked" ? 403 : 422,
        e.code,
        e.message,
      );
    throw e;
  }

  quoteFee(amountCents: number, speed: Speed) {
    return {
      amountCents,
      speed,
      feeCents: transferFee(amountCents, speed, this.fees),
      feeVersion: this.fees.version,
    };
  }

  async achOut(
    c: Caller,
    body: { bankId: string; amountCents: number; speed: Speed; idempotencyKey?: string },
  ) {
    const bank = await this.bankOf(c.userId, body.bankId);
    const sender = await this.senderCtx(c.userId);
    const id = uuid();
    let plan;
    try {
      plan = planAchPush(
        {
          transferId: id,
          amountCents: body.amountCents,
          speed: body.speed === "instant" ? "instant" : "standard",
          bank,
          sender,
          now: this.now(),
        },
        this.policy,
        this.fees,
      );
    } catch (e) {
      this.mapTransferError(e);
    }
    const instant = body.speed === "instant";
    const at = this.now().toISOString();
    await this.store
      .achPush({
        transfer: {
          id,
          user_id: c.userId,
          kind: "ach_out",
          speed: instant ? "instant" : "standard",
          from_account_id: sender.accountId,
          to_account_id: null,
          linked_bank_id: bank.id,
          counterparty_user_id: null,
          family_member_id: null,
          amount_cents: body.amountCents,
          fee_cents: plan!.feeCents,
          status: instant ? "completed" : "pending",
          settle_at: instant
            ? null
            : addBusinessDays(this.now(), 1, this.policy.holidays).toISOString(),
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, body.idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...plan!.ledger, idem: `transfer:${id}` },
        limit: limitWindow(sender.tier, "transfer_out", this.now(), this.policy),
        at,
      })
      .catch((e) => this.opFailed(e));
    return {
      id,
      status: instant ? "completed" : "pending",
      amountCents: body.amountCents,
      feeCents: plan!.feeCents,
      totalDebitCents: plan!.totalDebitCents,
    };
  }

  async p2p(
    c: Caller,
    body: {
      recipientEmail: string;
      amountCents: number;
      stepUpCode?: string;
      memo?: string;
      idempotencyKey?: string;
    },
  ) {
    const sender = await this.senderCtx(c.userId);
    const rp = await this.store.one("profiles", {
      email: String(body.recipientEmail ?? "").toLowerCase(),
    });
    let recipient = null;
    if (rp) {
      const rchk = (await this.pockets(rp.id)).find((a) => a.kind === "checking");
      if (rchk)
        recipient = {
          userId: rp.id,
          kyc: rp.kyc_state,
          accountId: rchk.id,
          accountStatus: rchk.status,
        };
    }
    const known = rp
      ? !!(await this.store.one("payees", { user_id: c.userId, payee_user_id: rp.id }))
      : false;
    const stepUpVerified = body.stepUpCode
      ? await this.verifyStepUp(c.userId, body.stepUpCode)
      : false;
    const id = uuid();
    let plan;
    try {
      plan = planP2P(
        {
          transferId: id,
          amountCents: body.amountCents,
          senderUserId: c.userId,
          sender,
          recipient,
          knownPayee: known,
          stepUpVerified,
          now: this.now(),
        },
        this.policy,
        this.fees,
      );
    } catch (e) {
      this.mapTransferError(e);
    }
    const at = this.now().toISOString();
    await this.store
      .p2pTransfer({
        transfer: {
          id,
          user_id: c.userId,
          kind: "p2p",
          speed: null,
          from_account_id: sender.accountId,
          to_account_id: recipient!.accountId,
          linked_bank_id: null,
          counterparty_user_id: recipient!.userId,
          family_member_id: null,
          amount_cents: body.amountCents,
          fee_cents: plan!.feeCents,
          status: "completed",
          settle_at: null,
          return_code: null,
          new_payee: plan!.newPayee,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, body.idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...plan!.ledger, idem: `transfer:${id}` },
        payee: known
          ? null
          : { user_id: c.userId, payee_user_id: recipient!.userId, first_paid_at: at },
        limit: limitWindow(sender.tier, "transfer_out", this.now(), this.policy),
        at,
      })
      .catch((e) => this.opFailed(e));
    return { id, status: "completed", amountCents: body.amountCents, newPayee: plan!.newPayee };
  }

  async pocketMove(
    c: Caller,
    body: {
      from: "checking" | "savings";
      to: "checking" | "savings";
      amountCents: number;
      idempotencyKey?: string;
    },
  ) {
    const p = await this.profile(c.userId);
    const from = await this.pocket(c.userId, body.from);
    const to = await this.pocket(c.userId, body.to);
    if (from.status !== "open" || to.status !== "open") throw new ApiError(409, "account_frozen");
    const id = uuid();
    let t;
    try {
      t = planPocketMove({
        transferId: id,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents: body.amountCents,
        availableCents: (await this.balanceOf(from.id)).availableCents,
        kyc: p.kyc_state,
      });
    } catch (e) {
      this.mapTransferError(e);
    }
    const at = this.now().toISOString();
    await this.store
      .pocketMove({
        transfer: {
          id,
          user_id: c.userId,
          kind: "pocket",
          speed: null,
          from_account_id: from.id,
          to_account_id: to.id,
          linked_bank_id: null,
          counterparty_user_id: null,
          family_member_id: null,
          amount_cents: body.amountCents,
          fee_cents: 0,
          status: "completed",
          settle_at: null,
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, body.idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...t!, idem: `transfer:${id}` },
        at,
      })
      .catch((e) => this.opFailed(e));
    return { id, status: "completed" };
  }

  // ---------- on-demand accounts ----------
  /** Open an extra pocket on demand: another checking/savings, or a temporary envelope that runs
   *  from startDate to endDate and auto-closes into primary checking on its end date. */
  async openAccount(
    c: Caller,
    body: { kind: AccountKind; nickname?: string; startDate?: string; endDate?: string },
  ) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state))
      throw new ApiError(403, "kyc_not_approved", "complete verification first");
    const kind = body.kind;
    if (kind !== "checking" && kind !== "savings" && kind !== "envelope")
      throw new ApiError(422, "invalid_kind", "kind must be checking, savings or envelope");
    let start: string | null = null;
    let end: string | null = null;
    if (kind === "envelope") {
      start = body.startDate ?? isoDate(this.now());
      if (!body.endDate)
        throw new ApiError(422, "invalid_envelope", "envelope requires an endDate");
      end = body.endDate;
      const errs = validateEnvelopeDates(start, end);
      if (errs.length) throw new ApiError(422, "invalid_envelope", errs.join("; "));
    }
    const id = uuid();
    const row = await this.store.insert("accounts", {
      id,
      user_id: c.userId,
      kind,
      status: "open",
      account_number: fakeAccountNumber(id),
      routing_number: HARBOR_ROUTING_NUMBER,
      nickname:
        body.nickname?.trim() ||
        (kind === "checking" ? "Checking" : kind === "savings" ? "Savings" : "Envelope"),
      is_primary: false,
      start_date: start,
      end_date: end,
      policy_version: this.policy.version,
      opened_at: this.now().toISOString(),
      closed_at: null,
    });
    await this.audit(c.userId, "account_opened", "account", id, undefined, { kind, start, end });
    return {
      id: row.id,
      kind,
      status: "open",
      nickname: row.nickname,
      startDate: start,
      endDate: end,
      accountNumber: row.account_number,
      routingNumber: row.routing_number,
    };
  }

  /** Instant internal transfer between any two of the user's own pockets. */
  async internalTransfer(
    c: Caller,
    body: {
      fromAccountId: string;
      toAccountId: string;
      amountCents: number;
      idempotencyKey?: string;
    },
  ) {
    const p = await this.profile(c.userId);
    const from = await this.accountOf(c.userId, body.fromAccountId);
    const to = await this.accountOf(c.userId, body.toAccountId);
    if (from.status !== "open" || to.status !== "open") throw new ApiError(409, "account_frozen");
    const id = uuid();
    let t;
    try {
      t = planPocketMove({
        transferId: id,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents: body.amountCents,
        availableCents: (await this.balanceOf(from.id)).availableCents,
        kyc: p.kyc_state,
      });
    } catch (e) {
      this.mapTransferError(e);
    }
    const at = this.now().toISOString();
    await this.store
      .pocketMove({
        transfer: {
          id,
          user_id: c.userId,
          kind: "pocket",
          speed: null,
          from_account_id: from.id,
          to_account_id: to.id,
          linked_bank_id: null,
          counterparty_user_id: null,
          family_member_id: null,
          amount_cents: body.amountCents,
          fee_cents: 0,
          status: "completed",
          settle_at: null,
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, body.idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...t!, idem: `transfer:${id}` },
        at,
      })
      .catch((e) => this.opFailed(e));
    return {
      id,
      status: "completed",
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents: body.amountCents,
    };
  }

  /** Job: auto-close every envelope that has reached its end date, sweeping its balance to primary checking. */
  async closeEnvelopes(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let closed = 0;
    for (const env of await this.store.list("accounts", { kind: "envelope", status: "open" })) {
      if (!envelopeReachedEnd(env.end_date, now)) continue;
      const primary = await this.primaryCheckingRow(env.user_id);
      if (!primary) continue; // no primary checking to sweep into
      const remaining = (await this.balanceOf(env.id)).postedCents;
      const sweep = planEnvelopeSweep({
        envelopeId: env.id,
        primaryCheckingId: primary.id,
        remainingCents: remaining,
      });
      const r = await this.store
        .closeEnvelope({
          envelopeId: env.id,
          primaryCheckingId: primary.id,
          ledger: sweep ? { ...sweep, idem: `envelope_close:${env.id}` } : null,
          at: now.toISOString(),
        })
        .catch((e) => this.opFailed(e));
      if (r.closed) {
        closed++;
        await this.audit(c?.userId ?? null, "envelope_closed", "account", env.id, undefined, {
          sweptCents: r.sweptCents,
          to: primary.id,
        });
      }
    }
    return { closed };
  }

  // ---------- households ----------
  async createHousehold(c: Caller, body: { name: string; monthlyCapCents?: number | null }) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved");
    const errs = [
      ...validateHouseholdName(body.name ?? ""),
      ...validateMonthlyCap(body.monthlyCapCents),
    ];
    if (errs.length) throw new ApiError(422, "invalid_household", errs.join("; "));
    if (await this.householdOf(c.userId))
      throw new ApiError(409, "already_in_household", "you are already in a household");
    const id = uuid();
    const at = this.now().toISOString();
    const row = await this.store.insert("households", {
      id,
      owner_user_id: c.userId,
      name: body.name.trim(),
      monthly_cap_cents: body.monthlyCapCents ?? null,
      created_at: at,
    });
    await this.store.insert("household_members", {
      id: uuid(),
      household_id: id,
      user_id: c.userId,
      invited_email: p.email,
      role: "owner",
      status: "active",
      invited_at: at,
      joined_at: at,
    });
    await this.audit(c.userId, "household_created", "household", id);
    return {
      id: row.id,
      name: row.name,
      monthlyCapCents: row.monthly_cap_cents ?? null,
    };
  }

  async inviteToHousehold(c: Caller, householdId: string, body: { email: string }) {
    const h = await this.store.one("households", { id: householdId });
    if (!h) throw new ApiError(404, "not_found", "household not found");
    if (h.owner_user_id !== c.userId)
      throw new ApiError(403, "forbidden", "only the household owner can invite members");
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new ApiError(422, "invalid_email", "a valid email is required");
    const members = await this.store.list("household_members", { household_id: householdId });
    if (members.some((m) => m.invited_email === email && m.status !== "removed"))
      throw new ApiError(409, "already_invited", "that email is already in the household");
    const invitee = await this.store.one("profiles", { email });
    const id = uuid();
    await this.store.insert("household_members", {
      id,
      household_id: householdId,
      user_id: invitee?.id ?? null,
      invited_email: email,
      role: "member",
      status: "invited",
      invited_at: this.now().toISOString(),
      joined_at: null,
    });
    await this.audit(c.userId, "household_invited", "household", householdId, email);
    return { id, householdId, invitedEmail: email, status: "invited" };
  }

  async acceptHouseholdInvite(c: Caller, inviteId: string) {
    const p = await this.profile(c.userId);
    const invite = await this.store.one("household_members", { id: inviteId });
    if (!invite || invite.status !== "invited")
      throw new ApiError(404, "not_found", "invitation not found");
    if (invite.invited_email !== String(p.email).toLowerCase())
      throw new ApiError(403, "forbidden", "this invitation was sent to a different email");
    if (await this.householdOf(c.userId))
      throw new ApiError(409, "already_in_household", "you are already in a household");
    await this.store.update(
      "household_members",
      { id: inviteId },
      { user_id: c.userId, status: "active", joined_at: this.now().toISOString() },
    );
    await this.audit(c.userId, "household_joined", "household", invite.household_id);
    return { id: inviteId, householdId: invite.household_id, status: "active" };
  }

  // ---------- cards ----------
  async issueCard(
    c: Caller,
    body: {
      kind: "virtual" | "physical";
      familyMemberId?: string;
      accountId?: string;
      limits?: SpendLimits;
    },
  ) {
    const p = await this.profile(c.userId);
    // A card is tied to a specific funding account (default: primary checking). Envelopes are
    // temporary and can't fund cards.
    const acct = body.accountId
      ? await this.accountOf(c.userId, body.accountId)
      : await this.pocket(c.userId, "checking");
    if (acct.kind === "envelope")
      throw new ApiError(422, "invalid_funding_account", "cards cannot be funded by an envelope");
    if (acct.status !== "open") throw new ApiError(409, "account_frozen");
    const existing = (await this.store.list("cards", { account_id: acct.id })).map((r) =>
      this.toCard(r),
    );
    let holder = c.userId;
    if (body.familyMemberId) {
      const m = await this.store.one("family_members", {
        id: body.familyMemberId,
        owner_user_id: c.userId,
      });
      if (!m || m.status === "removed")
        throw new ApiError(404, "not_found", "family member not found");
      if (
        existing.some(
          (x) => x.familyMemberId === m.id && ["active", "frozen", "requested"].includes(x.status),
        )
      )
        throw new ApiError(409, "member_has_card");
      holder = m.member_user_id ?? c.userId;
      if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved");
    } else {
      const ok = canIssueCard(p.kyc_state, body.kind, existing, this.policy);
      if (!ok.ok) throw new ApiError(ok.reason === "kyc_not_approved" ? 403 : 409, ok.reason!);
    }
    if (body.limits) {
      const errs = validateLimits(body.limits);
      if (errs.length) throw new ApiError(422, "invalid_limits", errs.join("; "));
    }
    const id = uuid();
    const prov = await this.providers.issuer.createCard({
      userId: c.userId,
      legalName: p.legal_name,
      kind: body.kind,
      cardId: id,
    });
    const row = await this.store.insert("cards", {
      id,
      account_id: acct.id,
      holder_user_id: holder,
      family_member_id: body.familyMemberId ?? null,
      kind: body.kind,
      status: initialCardStatus(body.kind),
      last4: prov.last4,
      provider: this.providers.issuer.name,
      provider_card_id: prov.providerCardId,
      replaces_card_id: null,
      per_txn_cents: body.limits?.perTxnCents ?? null,
      daily_cents: body.limits?.dailyCents ?? null,
      monthly_cents: body.limits?.monthlyCents ?? null,
      created_at: this.now().toISOString(),
      canceled_at: null,
    });
    return row;
  }

  async setCardStatus(c: Caller, cardId: string, to: CardStatus) {
    const card = await this.ownedCard(c, cardId);
    if (!canTransitionCard(card.status, to))
      throw new ApiError(409, "invalid_transition", `card cannot go from ${card.status} to ${to}`);
    await this.providers.issuer.setStatus(
      card.provider_card_id,
      to === "active" ? "active" : to === "frozen" ? "inactive" : "canceled",
    );
    await this.store.update(
      "cards",
      { id: cardId },
      {
        status: to,
        canceled_at:
          to === "canceled" || to === "replaced"
            ? this.now().toISOString()
            : (card.canceled_at ?? null),
      },
    );
    return { ...card, status: to };
  }

  async replaceCard(c: Caller, cardId: string) {
    const card = await this.ownedCard(c, cardId);
    await this.setCardStatus(c, cardId, "replaced");
    const p = await this.profile(c.userId);
    const id = uuid();
    const prov = await this.providers.issuer.createCard({
      userId: c.userId,
      legalName: p.legal_name,
      kind: card.kind,
      cardId: id,
    });
    return this.store.insert("cards", {
      id,
      account_id: card.account_id,
      holder_user_id: card.holder_user_id,
      family_member_id: card.family_member_id,
      kind: card.kind,
      status: initialCardStatus(card.kind),
      last4: prov.last4,
      provider: this.providers.issuer.name,
      provider_card_id: prov.providerCardId,
      replaces_card_id: card.id,
      created_at: this.now().toISOString(),
      canceled_at: null,
    });
  }

  /** Card network authorization request (fake issuer test hook; Stripe Issuing webhook maps here too). */
  async authorizeCard(
    cardId: string,
    req: {
      amountCents: number;
      mcc: string;
      merchant: string;
      foreign?: boolean;
      atmOutOfNetwork?: boolean;
      providerAuthId?: string;
    },
  ) {
    const card = await this.store.one("cards", { id: cardId });
    if (!card) throw new ApiError(404, "not_found", "card not found");
    const acct = await this.store.one("accounts", { id: card.account_id });
    const owner = await this.profile(acct!.user_id);
    const memberRow = card.family_member_id
      ? await this.store.one("family_members", { id: card.family_member_id })
      : undefined;
    const member = memberRow ? this.toMember(memberRow) : undefined;
    const attempts = (await this.store.list("card_authorizations", { card_id: cardId })).map(
      (a) => new Date(a.created_at),
    );
    const now = this.now();
    const cardLimits =
      card.per_txn_cents != null
        ? {
            perTxnCents: Number(card.per_txn_cents),
            dailyCents: Number(card.daily_cents),
            monthlyCents: Number(card.monthly_cents),
          }
        : undefined;
    const household = await this.householdOf(owner.id);
    const householdCapCents = household?.monthly_cap_cents ?? null;
    const decision = authorize(
      {
        amountCents: req.amountCents,
        mcc: String(req.mcc),
        merchant: req.merchant ?? "Merchant",
        foreign: !!req.foreign,
        atmOutOfNetwork: !!req.atmOutOfNetwork,
      },
      {
        card: this.toCard(card),
        accountStatus: acct!.status,
        ownerKyc: owner.kyc_state,
        ownerTier: owner.tier,
        ownerUsage: await this.usage(owner.id),
        availableCents: (await this.balanceOf(card.account_id)).availableCents,
        recentAuthAttempts: attempts,
        member,
        memberSpend: member ? await this.memberSpend(member.id) : undefined,
        allowanceAvailableCents:
          member?.kind === "teen" ? (await this.allowanceOf(member.id)).availableCents : undefined,
        cardLimits,
        cardSpend: cardLimits ? await this.cardSpendEvents(cardId) : undefined,
        householdCapCents,
        householdSpend:
          household && householdCapCents != null
            ? await this.householdCardSpend(household.id)
            : undefined,
        now,
      },
      this.policy,
      this.fees,
    );
    const id = uuid();
    const base = {
      id,
      card_id: cardId,
      provider_auth_id: req.providerAuthId ?? null,
      amount_cents:
        Number.isSafeInteger(req.amountCents) && req.amountCents > 0 ? req.amountCents : 1,
      mcc: String(req.mcc).padStart(4, "0").slice(0, 4),
      merchant: req.merchant ?? "Merchant",
      foreign_txn: !!req.foreign,
      atm_out_of_network: !!req.atmOutOfNetwork,
      captured_cents: 0,
      refunded_cents: 0,
      created_at: now.toISOString(),
      captured_at: null,
    };
    const at = now.toISOString();
    if (!decision.approved) {
      const r = await this.store.cardAuthorize({
        auth: {
          ...base,
          fee_cents: 0,
          status: "declined",
          decline_reason: decision.reason,
          hold_id: null,
          funding_account: "customer_deposits",
          funding_party: card.account_id,
          expires_at: at,
        },
        hold: null,
        at,
      });
      return { authorizationId: id, approved: false, reason: r.reason ?? decision.reason };
    }
    const teen = decision.funding.account === "family_allowance";
    // The store re-checks the funding pocket under a lock; if a concurrent debit used the money,
    // the authorization is recorded as declined instead of placing the hold.
    const r = await this.store.cardAuthorize({
      auth: {
        ...base,
        fee_cents: decision.feeCents,
        status: "authorized",
        decline_reason: null,
        hold_id: null,
        funding_account: decision.funding.account,
        funding_party: decision.funding.party,
        expires_at: decision.expiresAt.toISOString(),
      },
      hold: {
        id: uuid(),
        account_id: teen ? null : card.account_id,
        family_member_id: teen ? decision.funding.party : null,
        kind: "card_auth",
        amount_cents: decision.holdCents,
        status: "active",
        ref_id: id,
        expires_at: decision.expiresAt.toISOString(),
        release_at: null,
        created_at: at,
        released_at: null,
      },
      at,
    });
    if (!r.approved) return { authorizationId: id, approved: false, reason: r.reason };
    return {
      authorizationId: id,
      approved: true,
      holdCents: decision.holdCents,
      feeCents: decision.feeCents,
      expiresAt: decision.expiresAt.toISOString(),
    };
  }

  async capture(authId: string, amountCents: number) {
    const a = await this.store.one("card_authorizations", { id: authId });
    if (!a) throw new ApiError(404, "not_found", "authorization not found");
    let plan;
    try {
      plan = planCapture(this.toAuth(a), amountCents, this.now(), this.policy, this.fees);
    } catch (e) {
      throw new ApiError(422, "capture_rejected", (e as Error).message);
    }
    // 1% cashback on the captured amount, credited to the card's own account (its own ledger txn).
    const card = await this.store.one("cards", { id: a.card_id });
    const cashback = cashbackForCapture(plan.capturedCents, this.policy);
    const cbLedger =
      cashback > 0 && card
        ? { ...cashbackLedger(authId, card.account_id, cashback), idem: `cashback:${authId}` }
        : null;
    await this.store
      .cardCapture({
        authId,
        capturedCents: plan.capturedCents,
        feeCents: plan.feeCents,
        ledger: { ...plan.ledger, idem: `capture:${authId}` },
        cashbackLedger: cbLedger,
        cashbackCents: cashback,
        at: this.now().toISOString(),
      })
      .catch((e) => this.opFailed(e, { status: 422, code: "capture_rejected" }));
    return {
      authorizationId: authId,
      capturedCents: plan.capturedCents,
      feeCents: plan.feeCents,
      releasedCents: plan.releasedCents,
      cashbackCents: cashback,
    };
  }

  async merchantRefund(authId: string, refundId: string, amountCents: number) {
    const a = await this.store.one("card_authorizations", { id: authId });
    if (!a) throw new ApiError(404, "not_found", "authorization not found");
    const posted = (await this.store.list("card_refunds", { auth_id: authId })).map((r) => r.id);
    const existing = await this.store.one("card_refunds", { id: refundId });
    if (existing && existing.auth_id !== authId) throw new ApiError(409, "refund_id_conflict");
    let plan;
    try {
      plan = planMerchantRefund({
        refundId,
        auth: this.toAuth(a),
        capturedCents: Number(a.captured_cents),
        refundedSoFarCents: Number(a.refunded_cents),
        amountCents,
        postedRefundIds: posted,
      });
    } catch (e) {
      throw new ApiError(422, "refund_rejected", (e as Error).message);
    }
    if (plan.duplicate)
      return { refundId, duplicate: true, refundedCents: Number(a.refunded_cents) };
    // Reverse cashback pro-rata to the refund (its own ledger txn on the card's account).
    const card = await this.store.one("cards", { id: a.card_id });
    const reversal = cashbackReversal({
      cashbackCents: Number(a.cashback_cents),
      capturedCents: Number(a.captured_cents),
      refundedSoFarCents: Number(a.refunded_cents),
      refundAmountCents: amountCents,
    });
    const revLedger =
      reversal > 0 && card
        ? {
            ...cashbackReversalLedger(refundId, card.account_id, reversal),
            idem: `cashback_rev:${refundId}`,
          }
        : null;
    const r = await this.store
      .cardRefund({
        refundId,
        authId,
        amountCents,
        ledger: { ...plan.ledger, idem: `refund:${refundId}` },
        cashbackReversalLedger: revLedger,
        cashbackReversalCents: reversal,
        at: this.now().toISOString(),
      })
      .catch((e) =>
        this.opFailed(
          e,
          e instanceof MoneyOpError && e.code === "refund_id_conflict"
            ? { status: 409, code: "refund_id_conflict" }
            : { status: 422, code: "refund_rejected" },
        ),
      );
    return {
      refundId,
      duplicate: r.duplicate,
      refundedCents: r.refundedCents,
      cashbackReversedCents: reversal,
    };
  }

  async expireAuths(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let expired = 0;
    for (const a of await this.store.list("card_authorizations", { status: "authorized" })) {
      if (new Date(a.expires_at).getTime() > now.getTime()) continue;
      if (await this.store.cardExpireAuth({ authId: a.id, at: now.toISOString() })) expired++;
    }
    return { expired };
  }

  // ---------- family ----------
  async addFamilyMember(
    c: Caller,
    body: {
      name: string;
      kind: "spouse" | "teen";
      limits: SpendLimits;
      blockedMccGroups?: string[];
      memberEmail?: string;
    },
  ) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state)) throw new ApiError(403, "kyc_not_approved");
    const count = (await this.store.list("family_members", { owner_user_id: c.userId })).filter(
      (m) => m.status !== "removed",
    ).length;
    let m;
    try {
      m = newFamilyMember(
        {
          id: uuid(),
          ownerUserId: c.userId,
          name: body.name,
          kind: body.kind,
          limits: body.limits,
          blockedMccGroups: body.blockedMccGroups,
          existingCount: count,
        },
        this.policy,
      );
    } catch (e) {
      throw new ApiError(422, "invalid_member", (e as Error).message);
    }
    const memberUser = body.memberEmail
      ? await this.store.one("profiles", { email: body.memberEmail.toLowerCase() })
      : undefined;
    return this.store.insert("family_members", {
      id: m.id,
      owner_user_id: c.userId,
      member_user_id: memberUser?.id ?? null,
      name: m.name,
      kind: m.kind,
      status: m.status,
      per_txn_cents: m.limits.perTxnCents,
      daily_cents: m.limits.dailyCents,
      monthly_cents: m.limits.monthlyCents,
      blocked_mcc_groups: m.blockedMccGroups,
      blocked_mccs: m.blockedMccs,
      approved_at: m.status === "active" && m.kind === "teen" ? this.now().toISOString() : null,
    });
  }

  async memberFor(c: Caller, id: string) {
    const m = await this.store.one("family_members", { id });
    if (!m || (m.owner_user_id !== c.userId && m.member_user_id !== c.userId))
      throw new ApiError(404, "not_found", "family member not found");
    return m;
  }

  async approveMember(c: Caller, id: string) {
    const m = await this.memberFor(c, id);
    try {
      guardianApprove(this.toMember(m), c.userId);
    } catch (e) {
      throw new ApiError(403, "guardian_required", (e as Error).message);
    }
    await this.store.update(
      "family_members",
      { id },
      { status: "active", approved_at: this.now().toISOString() },
    );
    return { id, status: "active" };
  }

  async updateMemberLimits(
    c: Caller,
    id: string,
    body: { limits?: SpendLimits; blockedMccGroups?: string[] },
  ) {
    const m = await this.memberFor(c, id);
    if (m.owner_user_id !== c.userId)
      throw new ApiError(403, "forbidden", "only the owner can change limits");
    const patch: Row = {};
    if (body.limits) {
      const errs = validateLimits(body.limits);
      if (errs.length) throw new ApiError(422, "invalid_limits", errs.join("; "));
      Object.assign(patch, {
        per_txn_cents: body.limits.perTxnCents,
        daily_cents: body.limits.dailyCents,
        monthly_cents: body.limits.monthlyCents,
      });
    }
    if (body.blockedMccGroups)
      patch.blocked_mcc_groups =
        m.kind === "teen"
          ? [...new Set([...body.blockedMccGroups, "gambling", "alcohol", "tobacco", "adult"])]
          : body.blockedMccGroups;
    await this.store.update("family_members", { id }, patch);
    return { id, ...patch };
  }

  async allowanceTopUp(c: Caller, id: string, amountCents: number, idempotencyKey?: string) {
    const m = await this.memberFor(c, id);
    if (m.owner_user_id !== c.userId)
      throw new ApiError(403, "forbidden", "only the owner can fund an allowance");
    const chk = await this.pocket(c.userId, "checking");
    const tid = uuid();
    let t;
    try {
      t = planAllowanceTopUp({
        id: tid,
        ownerAccountId: chk.id,
        member: this.toMember(m),
        amountCents,
        ownerAvailableCents: (await this.balanceOf(chk.id)).availableCents,
      });
    } catch (e) {
      throw new ApiError(422, "allowance_rejected", (e as Error).message);
    }
    const at = this.now().toISOString();
    await this.store
      .allowanceTopUp({
        transfer: {
          id: tid,
          user_id: c.userId,
          kind: "allowance_topup",
          speed: null,
          from_account_id: chk.id,
          to_account_id: null,
          family_member_id: id,
          linked_bank_id: null,
          counterparty_user_id: null,
          amount_cents: amountCents,
          fee_cents: 0,
          status: "completed",
          settle_at: null,
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: this.transferIdemKey(c, idempotencyKey),
          created_at: at,
          settled_at: null,
        },
        ledger: { ...t, idem: `transfer:${tid}` },
        at,
      })
      .catch((e) => this.opFailed(e, { status: 422, code: "allowance_rejected" }));
    return { id: tid, memberId: id, allowance: await this.allowanceOf(id) };
  }

  // ---------- Zelle bill pay ----------
  /** Send one Zelle payment now: plan the funding (source first, shortfall pulled from other
   *  pockets), call the provider, then atomically debit and record it. */
  private async sendOneZelle(p: {
    userId: string;
    source: Row;
    recipient: ZelleRecipient;
    amountCents: number;
    memo?: string;
    scheduleId?: string | null;
    idempotencyKey?: string;
  }): Promise<{ id: string; shortfallCents: number }> {
    const prof = await this.profile(p.userId);
    const spendable = await this.spendableForZelle(p.userId, p.source);
    const id = uuid();
    let plan;
    try {
      plan = planZelleSend({
        transferId: id,
        fromAccountId: p.source.id,
        amountCents: p.amountCents,
        recipient: p.recipient,
        spendable,
        now: this.now(),
      });
    } catch (e) {
      if (e instanceof ZelleError) throw new ApiError(422, e.code, e.message);
      throw e;
    }
    const sent = await this.providers.zelle
      .send({
        paymentId: id,
        fromName: prof.legal_name,
        recipient: p.recipient,
        amountCents: p.amountCents,
        memo: p.memo,
      })
      .catch((e) => {
        throw new ApiError(502, "zelle_provider_error", (e as Error).message);
      });
    const providerRef = sent.providerRef;
    const at = this.now().toISOString();
    await this.store
      .zelleSend({
        transfer: {
          id,
          user_id: p.userId,
          kind: "zelle",
          speed: null,
          from_account_id: p.source.id,
          to_account_id: null,
          linked_bank_id: null,
          counterparty_user_id: null,
          family_member_id: null,
          amount_cents: p.amountCents,
          fee_cents: 0,
          status: "completed",
          settle_at: null,
          return_code: null,
          new_payee: false,
          policy_version: this.policy.version,
          fee_version: this.fees.version,
          idempotency_key: p.idempotencyKey ? `${p.userId}:${p.idempotencyKey}` : null,
          created_at: at,
          settled_at: null,
        },
        ledger: { ...plan.ledger, idem: `transfer:${id}` },
        payment: {
          id: uuid(),
          transfer_id: id,
          schedule_id: p.scheduleId ?? null,
          recipient_email: p.recipient.email ?? null,
          recipient_phone: p.recipient.phone ?? null,
          memo: p.memo ?? null,
          provider_ref: providerRef,
          status: "sent",
          returned_at: null,
          return_reason: null,
          created_at: at,
        },
        limit: limitWindow(prof.tier, "transfer_out", this.now(), this.policy),
        at,
      })
      .catch((e) => this.opFailed(e));
    return { id, shortfallCents: plan.shortfallCents };
  }

  async zellePay(
    c: Caller,
    body: {
      fromAccountId: string;
      recipient: ZelleRecipient;
      amountCents: number;
      memo?: string;
      frequency?: ZelleFrequency;
      startDate?: string;
      idempotencyKey?: string;
    },
  ) {
    const p = await this.profile(c.userId);
    if (!canMoveMoney(p.kyc_state))
      throw new ApiError(403, "kyc_not_approved", "complete verification first");
    const freq: ZelleFrequency = body.frequency ?? "once";
    if (!isValidFrequency(freq))
      throw new ApiError(422, "invalid_frequency", "frequency must be once, weekly or monthly");
    if (!validateRecipient(body.recipient))
      throw new ApiError(422, "invalid_recipient", "a valid email or phone is required");
    const source = await this.accountOf(c.userId, body.fromAccountId);
    if (source.status !== "open") throw new ApiError(409, "account_frozen");
    const now = this.now();

    if (freq === "once") {
      const r = await this.sendOneZelle({
        userId: c.userId,
        source,
        recipient: body.recipient,
        amountCents: body.amountCents,
        memo: body.memo,
        idempotencyKey: body.idempotencyKey,
      });
      return {
        id: r.id,
        frequency: "once",
        status: "completed",
        amountCents: body.amountCents,
        shortfallCents: r.shortfallCents,
      };
    }

    if (body.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate))
      throw new ApiError(422, "invalid_start_date", "startDate must be YYYY-MM-DD");
    const startAt = body.startDate ? new Date(`${body.startDate}T00:00:00.000Z`) : now;
    const scheduleId = uuid();
    let firstPaymentId: string | null = null;
    let nextRunAt = startAt;
    // Create the schedule first (a first payment's record references it); if the first send can't
    // be funded, cancel the schedule so a failed setup leaves nothing active.
    await this.store.insert("zelle_schedules", {
      id: scheduleId,
      user_id: c.userId,
      from_account_id: source.id,
      recipient_email: body.recipient.email ?? null,
      recipient_phone: body.recipient.phone ?? null,
      memo: body.memo ?? null,
      amount_cents: body.amountCents,
      frequency: freq,
      next_run_at: startAt.toISOString(),
      last_run_at: null,
      status: "active",
      created_at: now.toISOString(),
    });
    if (startAt.getTime() <= now.getTime()) {
      try {
        const r = await this.sendOneZelle({
          userId: c.userId,
          source,
          recipient: body.recipient,
          amountCents: body.amountCents,
          memo: body.memo,
          scheduleId,
          idempotencyKey: body.idempotencyKey,
        });
        firstPaymentId = r.id;
        nextRunAt = nextZelleRun(startAt, freq)!;
        await this.store.update(
          "zelle_schedules",
          { id: scheduleId },
          { next_run_at: nextRunAt.toISOString(), last_run_at: now.toISOString() },
        );
      } catch (e) {
        await this.store.update("zelle_schedules", { id: scheduleId }, { status: "canceled" });
        throw e;
      }
    }
    return {
      scheduleId,
      frequency: freq,
      status: "scheduled",
      nextRunAt: nextRunAt.toISOString(),
      firstPaymentId,
      amountCents: body.amountCents,
    };
  }

  /** Job: send every recurring Zelle schedule whose next run is due; advance its cadence. */
  async runZelle(c: Caller | null) {
    if (c) this.requireStaff(c);
    const now = this.now();
    let sent = 0;
    for (const s of await this.store.list("zelle_schedules", { status: "active" })) {
      if (!s.next_run_at || new Date(s.next_run_at).getTime() > now.getTime()) continue;
      const next = nextZelleRun(new Date(s.next_run_at), s.frequency as ZelleFrequency);
      const source = await this.store.one("accounts", { id: s.from_account_id });
      if (source && source.status === "open") {
        try {
          await this.sendOneZelle({
            userId: s.user_id,
            source,
            recipient: {
              email: s.recipient_email ?? undefined,
              phone: s.recipient_phone ?? undefined,
            },
            amountCents: Number(s.amount_cents),
            memo: s.memo ?? undefined,
            scheduleId: s.id,
          });
          sent++;
        } catch (e) {
          // Insufficient funds or a closed source: skip this run and move to the next period.
          await this.audit(
            null,
            "zelle_schedule_skipped",
            "zelle_schedule",
            s.id,
            (e as Error).message,
          );
        }
      }
      await this.store.update(
        "zelle_schedules",
        { id: s.id },
        { next_run_at: next?.toISOString() ?? null, last_run_at: now.toISOString() },
      );
    }
    return { sent };
  }

  /** A Zelle return/refund (webhook, or admin-simulated): reverse the credit into the source pocket. */
  async zelleReturn(c: Caller | null, transferId: string, reason: string | null) {
    if (c) this.requireStaff(c);
    const t = await this.store.one("transfers", { id: transferId });
    if (!t || t.kind !== "zelle") throw new ApiError(404, "not_found", "Zelle payment not found");
    const plan = planZelleReturn({
      transferId: t.id,
      toAccountId: t.from_account_id,
      amountCents: Number(t.amount_cents),
    });
    await this.store
      .zelleReturn({
        transferId: t.id,
        code: reason ?? null,
        ledger: { ...plan.ledger, idem: `zelle_return:${t.id}` },
        at: this.now().toISOString(),
        actorId: c?.userId ?? null,
        audit: { reason: reason ?? null },
      })
      .catch((e) => this.opFailed(e, { status: 409, code: "already_returned" }));
    return { transferId: t.id, reversed: true, amountCents: Number(t.amount_cents) };
  }

  /** Resolve a Zelle payment by its provider reference (for the inbound webhook), then return it. */
  async zelleReturnByRef(providerRef: string, reason: string | null) {
    const pay = await this.store.one("zelle_payments", { provider_ref: providerRef });
    if (!pay) throw new ApiError(404, "not_found", "Zelle payment not found");
    return this.zelleReturn(null, pay.transfer_id, reason);
  }

  // ---------- disputes ----------
  async openDispute(
    c: Caller,
    body: { authorizationId: string; amountCents: number; reason: string },
  ) {
    const a = await this.store.one("card_authorizations", { id: body.authorizationId });
    if (!a) throw new ApiError(404, "not_found", "transaction not found");
    await this.cardFor(c, a.card_id);
    if (a.status !== "captured")
      throw new ApiError(422, "not_disputable", "only posted (captured) purchases can be disputed");
    if (!body.reason?.trim()) throw new ApiError(422, "reason_required");
    const card = await this.store.one("cards", { id: a.card_id });
    const acct = await this.store.one("accounts", { id: card!.account_id });
    const existingOpen = (await this.store.list("disputes", { auth_id: a.id })).some(
      (x) => x.status === "open" || x.status === "provisional_credited",
    );
    let dsp: Dispute;
    try {
      dsp = openDispute(
        {
          id: uuid(),
          authId: a.id,
          accountId: a.funding_party,
          creditAccount: a.funding_account,
          amountCents: body.amountCents,
          capturedCents: Number(a.captured_cents),
          refundedCents: Number(a.refunded_cents),
          postedAt: new Date(a.captured_at ?? a.created_at),
          now: this.now(),
          accountOpenedAt: new Date(acct!.opened_at),
          existingOpen,
        },
        this.policy,
      );
    } catch (e) {
      throw new ApiError(422, "dispute_rejected", (e as Error).message);
    }
    return this.store
      .disputeOpen({
        dispute: {
          id: dsp.id,
          auth_id: a.id,
          user_id: acct!.user_id,
          credit_account: dsp.creditAccount,
          credit_party: dsp.accountId,
          amount_cents: dsp.amountCents,
          reason: body.reason,
          status: "open",
          provisional_credit_cents: 0,
          provisional_credit_due_at: dsp.provisionalCreditDueAt.toISOString(),
          resolution_due_at: dsp.resolutionDueAt.toISOString(),
          policy_version: this.policy.version,
          opened_at: dsp.openedAt.toISOString(),
          resolved_at: null,
        },
        at: this.now().toISOString(),
      })
      .catch((e) => this.opFailed(e, { status: 422, code: "dispute_rejected" }));
  }

  toDispute(r: Row): Dispute {
    return {
      id: r.id,
      authId: r.auth_id,
      accountId: r.credit_party,
      creditAccount: r.credit_account,
      amountCents: Number(r.amount_cents),
      status: r.status,
      openedAt: new Date(r.opened_at),
      provisionalCreditDueAt: new Date(r.provisional_credit_due_at),
      resolutionDueAt: new Date(r.resolution_due_at),
      provisionalCreditCents: Number(r.provisional_credit_cents),
    };
  }

  async provisionalCredit(c: Caller | null, disputeId: string) {
    if (c) this.requireStaff(c);
    const r = await this.store.one("disputes", { id: disputeId });
    if (!r) throw new ApiError(404, "not_found");
    let plan;
    try {
      plan = planProvisionalCredit(this.toDispute(r));
    } catch (e) {
      throw new ApiError(409, "invalid_transition", (e as Error).message);
    }
    await this.store
      .disputeProvisionalCredit({
        disputeId,
        ledger: { ...plan.ledger, idem: `dispute_pc:${disputeId}` },
        at: this.now().toISOString(),
      })
      .catch((e) => this.opFailed(e, { status: 409, code: "invalid_transition" }));
    return {
      id: disputeId,
      status: plan.dispute.status,
      provisionalCreditCents: plan.dispute.provisionalCreditCents,
    };
  }

  async resolveDispute(c: Caller, disputeId: string, outcome: "won" | "lost") {
    this.requireStaff(c);
    if (outcome !== "won" && outcome !== "lost") throw new ApiError(422, "invalid_outcome");
    const r = await this.store.one("disputes", { id: disputeId });
    if (!r) throw new ApiError(404, "not_found");
    let plan;
    try {
      plan = resolveDispute(this.toDispute(r), outcome);
    } catch (e) {
      throw new ApiError(409, "invalid_transition", (e as Error).message);
    }
    await this.store
      .disputeResolve({
        disputeId,
        outcome,
        expectedStatus: r.status,
        provisionalCreditCents: plan.dispute.provisionalCreditCents,
        ledger: plan.ledger ? { ...plan.ledger, idem: `dispute_resolve:${disputeId}` } : null,
        at: this.now().toISOString(),
        actorId: c.userId,
      })
      .catch((e) => this.opFailed(e, { status: 409, code: "invalid_transition" }));
    return { id: disputeId, status: outcome };
  }

  /** Job: give provisional credit to every open dispute whose due date has arrived (never late). */
  async disputeDeadlines(c: Caller | null) {
    if (c) this.requireStaff(c);
    let credited = 0;
    for (const r of await this.store.list("disputes", { status: "open" })) {
      if (new Date(r.provisional_credit_due_at).getTime() - this.now().getTime() <= 86_400_000) {
        await this.provisionalCredit(null, r.id);
        credited++;
      }
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
      await this.store.insert("interest_accruals", {
        account_id: a.id,
        day: dday,
        balance_cents: bal,
        accrued_micro: Number(dailyAccrualMicro(bal, this.policy)),
      });
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
      const accrued = (await this.store.list("interest_accruals", { account_id: a.id }))
        .filter((x) => String(x.day).startsWith(period))
        .reduce((s, x) => s + BigInt(x.accrued_micro), 0n);
      const prev = (await this.store.list("interest_postings", { account_id: a.id })).sort((x, y) =>
        y.period.localeCompare(x.period),
      )[0];
      const carryIn = prev ? BigInt(prev.carry_out_micro) : 0n;
      const plan = planMonthlyInterest({
        accountId: a.id,
        period,
        accruedMicro: accrued,
        carryInMicro: carryIn,
      });
      const posted = await this.store.postInterest({
        posting: {
          account_id: a.id,
          period,
          accrued_micro: Number(accrued),
          carry_in_micro: Number(carryIn),
          posted_cents: plan.postCents,
          carry_out_micro: Number(plan.carryMicro),
        },
        ledger: plan.ledger ? { ...plan.ledger, idem: `interest:${a.id}:${period}` } : null,
        at: this.now().toISOString(),
      });
      if (!posted) continue; // a concurrent run posted this account + period first
      out.push({
        accountId: a.id,
        postedCents: plan.postCents,
        carryMicro: Number(plan.carryMicro),
      });
    }
    return { period, postings: out };
  }

  // ---------- statements ----------
  async statement(c: Caller, accountId: string, period: string) {
    const a = await this.store.one("accounts", { id: accountId });
    if (!a || (a.user_id !== c.userId && c.role === "customer"))
      throw new ApiError(404, "not_found", "account not found");
    const rows = await this.store.ledger({ account: "customer_deposits", party: accountId });
    try {
      const s = buildStatement(
        accountId,
        period,
        rows.map((r) => ({
          at: new Date(r.at),
          kind: r.kind,
          ref: r.ref ?? undefined,
          debit: Number(r.debit),
          credit: Number(r.credit),
        })),
      );
      return {
        ...s,
        accountNumber: a.account_number,
        kind: a.kind,
        entries: s.entries.map((e) => ({ ...e, at: e.at.toISOString() })),
      };
    } catch (e) {
      throw new ApiError(422, "invalid_period", (e as Error).message);
    }
  }

  // ---------- closure ----------
  async closeAccount(c: Caller, body: { bankId?: string }) {
    const p = await this.profile(c.userId);
    const pockets = await this.pockets(c.userId);
    if (!pockets.length) throw new ApiError(409, "already_closed");
    const holds = await this.holds();
    const now = this.now();
    const members = (await this.store.list("family_members", { owner_user_id: c.userId })).filter(
      (m) => m.status !== "removed",
    );
    const memberIds = new Set(members.map((m) => `member:${m.id}`));
    const activeHolds = holds
      .filter(
        (h) =>
          (pockets.some((a) => a.id === h.accountId) || memberIds.has(h.accountId)) &&
          holdIsActive(h, now),
      )
      .reduce((s, h) => s + h.amountCents, 0);
    const banks = (await this.store.list("linked_banks", { user_id: c.userId })).filter(
      (b) => b.status === "active",
    );
    const bankRow = body.bankId
      ? banks.find((b) => b.id === body.bankId)
      : banks.find((b) => b.name_matched);
    const cards = (await this.store.list("cards"))
      .filter((x) => pockets.some((a) => a.id === x.account_id))
      .map((r) => this.toCard(r));
    const pocketsBal = [];
    for (const a of pockets)
      pocketsBal.push({ accountId: a.id, postedCents: (await this.balanceOf(a.id)).postedCents });
    const allowance = [];
    for (const m of members.filter((x) => x.kind === "teen"))
      allowance.push({ memberId: m.id, postedCents: (await this.allowanceOf(m.id)).postedCents });
    const openDisputes = (await this.store.list("disputes", { user_id: c.userId })).filter(
      (x) => x.status === "open" || x.status === "provisional_credited",
    ).length;
    const input = {
      kyc: p.kyc_state,
      accountStatus: "open",
      pockets: pocketsBal,
      activeHoldsCents: activeHolds,
      openDisputes,
      linkedBank: bankRow ? this.toBank(bankRow) : null,
      cards,
      allowancePockets: allowance,
    };
    const blocks = closureBlocks(input);
    if (blocks.length) {
      await this.store.insert("closures", {
        user_id: c.userId,
        payout_cents: 0,
        linked_bank_id: bankRow?.id ?? null,
        status: "blocked",
        blocks,
      });
      throw new ApiError(409, "closure_blocked", `closure blocked: ${blocks.join(", ")}`, blocks);
    }
    const closureId = uuid();
    const plan = planClosure(input, closureId);
    const at = now.toISOString();
    const allowanceOf = new Map(allowance.map((x) => [x.memberId, x.postedCents]));
    // One atomic operation: cancel cards, pay out every pocket, close accounts, remove family
    // members, record the closure. It aborts if a balance, hold or dispute changed since planning.
    const { canceledCardIds } = await this.store
      .closeAccount({
        userId: c.userId,
        closure: {
          id: closureId,
          user_id: c.userId,
          payout_cents: plan.payoutCents,
          linked_bank_id: bankRow?.id ?? null,
          status: "completed",
          blocks: [],
          created_at: at,
        },
        expected: {
          accounts: pocketsBal.map((x) => ({ id: x.accountId, postedCents: x.postedCents })),
          members: members.map((m) => ({ id: m.id, postedCents: allowanceOf.get(m.id) ?? 0 })),
        },
        ledger: plan.ledger ? { ...plan.ledger, idem: `closure:${closureId}` } : null,
        payoutTransfer: plan.ledger
          ? {
              id: uuid(),
              user_id: c.userId,
              kind: "closure_payout",
              speed: null,
              from_account_id: pockets.find((a) => a.kind === "checking")?.id ?? null,
              to_account_id: null,
              linked_bank_id: bankRow!.id,
              counterparty_user_id: null,
              family_member_id: null,
              amount_cents: plan.payoutCents,
              fee_cents: 0,
              status: "pending",
              settle_at: null,
              return_code: null,
              new_payee: false,
              policy_version: this.policy.version,
              fee_version: this.fees.version,
              idempotency_key: null,
              created_at: at,
              settled_at: null,
            }
          : null,
        at,
        actorId: c.userId,
        audit: { payoutCents: plan.payoutCents },
      })
      .catch((e) => this.opFailed(e));
    // The database is the source of truth for authorizations, so cards are canceled there first;
    // then the issuer is told. An issuer failure is audited for support to retry.
    for (const id of canceledCardIds) {
      const card = await this.store.one("cards", { id });
      try {
        await this.providers.issuer.setStatus(card!.provider_card_id, "canceled");
      } catch (e) {
        await this.audit(c.userId, "issuer_cancel_failed", "card", id, (e as Error).message);
      }
    }
    return { closureId, payoutCents: plan.payoutCents, cardsCanceled: canceledCardIds.length };
  }

  // ---------- admin ----------
  async adminUsers(c: Caller, kyc?: string) {
    this.requireStaff(c);
    const users = await this.store.list("profiles", kyc ? { kyc_state: kyc } : undefined);
    const out = [];
    for (const u of users) {
      const checks = (await this.store.list("kyc_checks", { user_id: u.id })).sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      const accts = [];
      for (const a of await this.store.list("accounts", { user_id: u.id }))
        accts.push({ id: a.id, kind: a.kind, status: a.status, ...(await this.balanceOf(a.id)) });
      const achDeposits = (await this.store.list("transfers", { user_id: u.id, kind: "ach_in" }))
        .filter((t) => t.status !== "returned")
        .map((t) => ({
          id: t.id,
          amountCents: Number(t.amount_cents),
          status: t.status,
          createdAt: t.created_at,
        }));
      out.push({
        id: u.id,
        email: u.email,
        legalName: u.legal_name,
        role: u.role,
        kycState: u.kyc_state,
        tier: u.tier,
        lastCheck: checks[0] ?? null,
        accounts: accts,
        achDeposits,
      });
    }
    return out;
  }

  async adminSetAccountStatus(
    c: Caller,
    accountId: string,
    status: "open" | "frozen",
    reason: string,
  ) {
    this.requireStaff(c);
    if (!reason?.trim()) throw new ApiError(422, "reason_required");
    const a = await this.store.one("accounts", { id: accountId });
    if (!a || a.status === "closed") throw new ApiError(404, "not_found");
    await this.store.update("accounts", { id: accountId }, { status });
    await this.audit(
      c.userId,
      status === "frozen" ? "account_frozen" : "account_unfrozen",
      "account",
      accountId,
      reason,
    );
    return { accountId, status };
  }

  async adminLedger(c: Caller, limit = 200) {
    this.requireStaff(c);
    const rows = await this.store.ledger({ limit: limit * 4 });
    const byTxn = new Map<
      string,
      { id: string; kind: string; ref: string | null; at: string; lines: Row[] }
    >();
    for (const r of rows) {
      const t = byTxn.get(r.txn_id) ?? {
        id: r.txn_id,
        kind: r.kind,
        ref: r.ref,
        at: r.at,
        lines: [],
      };
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
      put: async (rec) => {
        await this.store.insert("idempotency_keys", {
          key: `${userId}:${rec.key}`,
          user_id: userId,
          request_hash: rec.requestHash,
          status: rec.status,
          body: rec.body,
        });
      },
    };
  }

  async idempotent<T>(
    c: Caller,
    key: string | undefined,
    route: string,
    body: unknown,
    fn: () => Promise<T>,
  ) {
    try {
      return await withIdempotency(this.idemStore(c.userId), key, { route, body }, async () => {
        try {
          return { status: 200, body: (await fn()) as unknown };
        } catch (e) {
          if (e instanceof ApiError && e.status < 500)
            return {
              status: e.status,
              body: { error: { code: e.code, message: e.message, details: e.details } } as unknown,
            };
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof IdempotencyConflict)
        throw new ApiError(422, "idempotency_conflict", e.message);
      throw e;
    }
  }
}
