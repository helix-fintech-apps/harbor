// Debit cards: lifecycle, authorizations (hold on available balance), capture/settle with
// partial and bounded over-capture, auth expiry, merchant refunds (posted once), velocity.

import type { FeeSchedule, MoneyPolicy, Tier } from "./config.ts";
import { mccGroup } from "./config.ts";
import type { KycState } from "./kyc.ts";
import { canMoveMoney } from "./kyc.ts";
import { checkLimit, usage, type UsageEvent } from "./limits.ts";
import { applyBps, divRoundHalfUp } from "./money.ts";
import { addDays } from "./time.ts";
import { cr, dr, txn, type LedgerAccount, type Txn } from "./ledger.ts";
import { checkFamilySpend, type FamilyMember, type SpendLimits } from "./family.ts";
import { householdMonthSpend, withinHouseholdCap } from "./households.ts";

export type CardKind = "virtual" | "physical";
export type CardStatus = "requested" | "active" | "frozen" | "canceled" | "replaced";

export interface Card {
  id: string;
  accountId: string; // the owner's checking account
  holderUserId: string;
  familyMemberId?: string;
  kind: CardKind;
  status: CardStatus;
  last4: string;
}

const CARD_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  requested: ["active", "canceled"],
  active: ["frozen", "canceled", "replaced"],
  frozen: ["active", "canceled", "replaced"],
  canceled: [],
  replaced: [],
};

export function canTransitionCard(from: CardStatus, to: CardStatus): boolean {
  return CARD_TRANSITIONS[from].includes(to);
}

export function transitionCard(card: Card, to: CardStatus): Card {
  if (!canTransitionCard(card.status, to))
    throw new Error(`card: cannot go from ${card.status} to ${to}`);
  return { ...card, status: to };
}

/** Virtual cards are active immediately; physical cards start as `requested` until activated. */
export function initialCardStatus(kind: CardKind): CardStatus {
  return kind === "virtual" ? "active" : "requested";
}

export function canIssueCard(
  kyc: KycState,
  kind: CardKind,
  existing: Card[],
  policy: MoneyPolicy,
): { ok: boolean; reason?: string } {
  if (!canMoveMoney(kyc)) return { ok: false, reason: "kyc_not_approved" };
  const live = existing.filter(
    (c) => c.status === "active" || c.status === "frozen" || c.status === "requested",
  );
  if (
    kind === "virtual" &&
    live.filter((c) => c.kind === "virtual" && !c.familyMemberId).length >=
      policy.cards.maxActiveVirtualCards
  ) {
    return { ok: false, reason: "too_many_virtual_cards" };
  }
  if (kind === "physical" && live.some((c) => c.kind === "physical" && !c.familyMemberId))
    return { ok: false, reason: "physical_card_exists" };
  return { ok: true };
}

export type DeclineReason =
  | "invalid_amount"
  | "account_frozen"
  | "card_frozen"
  | "card_canceled"
  | "card_inactive"
  | "kyc_not_approved"
  | "velocity"
  | "daily_limit"
  | "monthly_limit"
  | "insufficient_funds"
  | "member_inactive"
  | "mcc_blocked"
  | "per_txn_limit"
  | "member_daily_limit"
  | "member_monthly_limit"
  | "allowance_exceeded"
  | "card_per_txn_limit"
  | "card_daily_limit"
  | "card_monthly_limit"
  | "household_monthly_cap";

export interface AuthRequest {
  amountCents: number;
  mcc: string;
  merchant: string;
  foreign: boolean;
  atmOutOfNetwork?: boolean;
}

export interface AuthContext {
  card: Card;
  accountStatus?: "open" | "frozen" | "closing" | "closed";
  ownerKyc: KycState;
  ownerTier: Tier;
  ownerUsage: UsageEvent[]; // card_spend events on the owner's account (all cards)
  availableCents: number; // the card's funding-account available balance
  recentAuthAttempts: Date[]; // this card
  member?: FamilyMember;
  memberSpend?: UsageEvent[]; // card_spend events for this family member
  allowanceAvailableCents?: number; // teen allowance pocket
  cardLimits?: SpendLimits; // per-card per-txn / daily / monthly limits (any card, optional)
  cardSpend?: UsageEvent[]; // card_spend events for THIS card (for its own daily / monthly limits)
  householdCapCents?: number | null; // household-wide monthly card-spend cap, if the owner is in one
  householdSpend?: UsageEvent[]; // card_spend across every card of every household member
  now: Date;
}

export type AuthDecision =
  | { approved: false; reason: DeclineReason }
  | {
      approved: true;
      holdCents: number;
      feeCents: number;
      expiresAt: Date;
      funding: { account: LedgerAccount; party: string };
    };

export function velocityExceeded(attempts: Date[], now: Date, policy: MoneyPolicy): boolean {
  const from = now.getTime() - policy.cards.velocity.windowMinutes * 60_000;
  return (
    attempts.filter((t) => t.getTime() > from && t.getTime() <= now.getTime()).length >=
    policy.cards.velocity.maxAuths
  );
}

export function cardFees(req: AuthRequest, fees: FeeSchedule): number {
  let fee = 0;
  if (req.foreign) fee += applyBps(req.amountCents, fees.foreignTransactionBps);
  if (req.atmOutOfNetwork) fee += fees.atmOutOfNetworkCents;
  return fee;
}

export function authorize(
  req: AuthRequest,
  ctx: AuthContext,
  policy: MoneyPolicy,
  fees: FeeSchedule,
): AuthDecision {
  const no = (reason: DeclineReason): AuthDecision => ({ approved: false, reason });
  if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) return no("invalid_amount");
  if (ctx.card.status === "frozen") return no("card_frozen");
  if (ctx.card.status === "canceled" || ctx.card.status === "replaced") return no("card_canceled");
  if (ctx.card.status !== "active") return no("card_inactive");
  if (ctx.accountStatus && ctx.accountStatus !== "open") return no("account_frozen");
  if (!canMoveMoney(ctx.ownerKyc)) return no("kyc_not_approved");
  if (velocityExceeded(ctx.recentAuthAttempts, ctx.now, policy)) return no("velocity");

  // Per-card limits (optional, on any card): the purchase amount is measured, matching tier limits.
  if (ctx.cardLimits) {
    if (req.amountCents > ctx.cardLimits.perTxnCents) return no("card_per_txn_limit");
    const cu = usage(ctx.cardSpend ?? [], "card_spend", ctx.now);
    if (cu.today + req.amountCents > ctx.cardLimits.dailyCents) return no("card_daily_limit");
    if (cu.month + req.amountCents > ctx.cardLimits.monthlyCents) return no("card_monthly_limit");
  }

  const feeCents = cardFees(req, fees);
  const need = req.amountCents + feeCents;

  let funding: { account: LedgerAccount; party: string } = {
    account: "customer_deposits",
    party: ctx.card.accountId,
  };
  if (ctx.card.familyMemberId) {
    if (!ctx.member) return no("member_inactive");
    const fam = checkFamilySpend(ctx.member, req.mcc, need, ctx.memberSpend ?? [], ctx.now);
    if (!fam.ok) return no(fam.reason!);
    if (ctx.member.kind === "teen") {
      if (need > (ctx.allowanceAvailableCents ?? 0)) return no("allowance_exceeded");
      funding = { account: "family_allowance", party: ctx.member.id };
    }
  }

  const lim = checkLimit(
    ctx.ownerTier,
    "card_spend",
    req.amountCents,
    ctx.ownerUsage,
    ctx.now,
    policy,
  );
  if (!lim.ok) return no(lim.reason!);
  // Household-wide monthly cap across every member and card, on top of tier and per-card limits.
  if (
    !withinHouseholdCap(
      ctx.householdCapCents,
      householdMonthSpend(ctx.householdSpend ?? [], ctx.now),
      req.amountCents,
    )
  )
    return no("household_monthly_cap");
  if (funding.account === "customer_deposits" && need > ctx.availableCents)
    return no("insufficient_funds");

  return {
    approved: true,
    holdCents: need,
    feeCents,
    expiresAt: addDays(ctx.now, policy.cards.authValidityDays),
    funding,
  };
}

/** Maximum a merchant may capture against an authorization (tips / fuel tolerance). */
export function maxCapture(authAmountCents: number, mcc: string, policy: MoneyPolicy): number {
  const g = mccGroup(mcc);
  if (g === "fuel") return Math.max(authAmountCents, policy.cards.fuelMaxCaptureCents);
  const bps =
    policy.cards.overCaptureToleranceBps[g ?? "default"] ??
    policy.cards.overCaptureToleranceBps.default ??
    0;
  return authAmountCents + applyBps(authAmountCents, bps);
}

export type AuthStatus = "authorized" | "captured" | "expired" | "reversed" | "declined";

export interface Authorization {
  id: string;
  cardId: string;
  amountCents: number;
  feeCents: number;
  mcc: string;
  foreign: boolean;
  atmOutOfNetwork?: boolean;
  status: AuthStatus;
  expiresAt: Date;
  funding: { account: LedgerAccount; party: string };
}

export interface CapturePlan {
  capturedCents: number;
  feeCents: number;
  releasedCents: number;
  ledger: Txn;
}

/** Capture (settle) an auth. Partial capture releases the remainder; over-capture is allowed within tolerance. */
export function planCapture(
  auth: Authorization,
  captureCents: number,
  now: Date,
  policy: MoneyPolicy,
  fees: FeeSchedule,
): CapturePlan {
  if (auth.status !== "authorized")
    throw new Error(`cannot capture a ${auth.status} authorization`);
  if (now.getTime() >= auth.expiresAt.getTime()) throw new Error("authorization expired");
  if (!Number.isSafeInteger(captureCents) || captureCents <= 0)
    throw new Error("capture must be positive cents");
  const max = maxCapture(auth.amountCents, auth.mcc, policy);
  if (captureCents > max) throw new Error(`over-capture ${captureCents} exceeds tolerance ${max}`);
  const feeCents = cardFees(
    {
      amountCents: captureCents,
      mcc: auth.mcc,
      merchant: "",
      foreign: auth.foreign,
      atmOutOfNetwork: auth.atmOutOfNetwork,
    },
    fees,
  );
  const heldCents = auth.amountCents + auth.feeCents;
  return {
    capturedCents: captureCents,
    feeCents,
    releasedCents: Math.max(0, heldCents - captureCents - feeCents),
    ledger: txn(
      "card_capture",
      [
        dr(auth.funding.account, captureCents + feeCents, auth.funding.party),
        cr("card_settlement", captureCents),
        cr("fee_revenue", feeCents),
      ],
      auth.id,
    ),
  };
}

export function isAuthExpired(auth: Authorization, now: Date): boolean {
  return auth.status === "authorized" && now.getTime() >= auth.expiresAt.getTime();
}

/** Merchant refund against a captured purchase. Each refund id posts at most once. The FX fee is not refunded. */
export function planMerchantRefund(p: {
  refundId: string;
  auth: Authorization;
  capturedCents: number;
  refundedSoFarCents: number;
  amountCents: number;
  postedRefundIds: string[];
}): { duplicate: true } | { duplicate: false; ledger: Txn } {
  if (p.postedRefundIds.includes(p.refundId)) return { duplicate: true };
  if (p.auth.status !== "captured") throw new Error("refund requires a captured purchase");
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new Error("refund must be positive cents");
  if (p.refundedSoFarCents + p.amountCents > p.capturedCents)
    throw new Error("refund exceeds captured amount");
  return {
    duplicate: false,
    ledger: txn(
      "card_refund",
      [
        dr("card_settlement", p.amountCents),
        cr(p.auth.funding.account, p.amountCents, p.auth.funding.party),
      ],
      p.refundId,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Cashback. 1% of the captured purchase amount (not fees) is credited to the card's own account
// on capture, and reversed pro-rata on merchant refund. Cashback is posted as its OWN ledger txn
// (dr cashback_expense, cr customer_deposits[card account]) so it never collides with the capture
// txn's guard when the funding pocket IS the card's account.
// ---------------------------------------------------------------------------------------------

/** Cashback earned on a capture: rateBps of the captured amount, rounded half-up. */
export function cashbackForCapture(capturedCents: number, policy: MoneyPolicy): number {
  if (capturedCents <= 0) return 0;
  return applyBps(capturedCents, policy.cashback.rateBps);
}

/**
 * The cashback to claw back for a refund, computed incrementally against the running refunded
 * total so that a full refund reverses exactly the cashback earned (no rounding residue):
 *   reverse = round(cashback * (refundedSoFar + refund) / captured) - round(cashback * refundedSoFar / captured).
 */
export function cashbackReversal(p: {
  cashbackCents: number;
  capturedCents: number;
  refundedSoFarCents: number;
  refundAmountCents: number;
}): number {
  if (p.cashbackCents <= 0 || p.capturedCents <= 0 || p.refundAmountCents <= 0) return 0;
  const after = divRoundHalfUp(
    p.cashbackCents * (p.refundedSoFarCents + p.refundAmountCents),
    p.capturedCents,
  );
  const before = divRoundHalfUp(p.cashbackCents * p.refundedSoFarCents, p.capturedCents);
  return Math.max(0, after - before);
}

export function cashbackLedger(authId: string, cardAccountId: string, cashbackCents: number): Txn {
  return txn(
    "card_cashback",
    [dr("cashback_expense", cashbackCents), cr("customer_deposits", cashbackCents, cardAccountId)],
    authId,
  );
}

export function cashbackReversalLedger(
  refundId: string,
  cardAccountId: string,
  reversalCents: number,
): Txn {
  return txn(
    "card_cashback_reversal",
    [dr("customer_deposits", reversalCents, cardAccountId), cr("cashback_expense", reversalCents)],
    refundId,
  );
}

export function fakeLast4(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return String(h % 10_000).padStart(4, "0");
}
