// Money out: ACH push (standard, free) and instant (fee), P2P, pocket moves.
// All checks return a typed rejection instead of throwing so the API can map them to 4xx codes.

import type { FeeSchedule, MoneyPolicy, Tier } from "./config.ts";
import type { KycState } from "./kyc.ts";
import { canMoveMoney, canPayout, canReceive } from "./kyc.ts";
import type { LinkedBank } from "./achIn.ts";
import { inCoolingOff } from "./achIn.ts";
import { checkLimit, type UsageEvent } from "./limits.ts";
import { applyBps, clamp } from "./money.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";

export type Speed = "standard" | "instant";

export type TransferRejection =
  | "invalid_amount" | "kyc_not_approved" | "account_frozen" | "payout_blocked" | "bank_not_active"
  | "bank_name_mismatch" | "cooling_off" | "insufficient_funds" | "daily_limit" | "monthly_limit"
  | "step_up_required" | "recipient_unavailable" | "self_transfer" | "below_minimum";

export class TransferError extends Error {
  constructor(public code: TransferRejection, message?: string) { super(message ?? code); }
}

export function instantFee(amountCents: number, fees: FeeSchedule): number {
  return clamp(applyBps(amountCents, fees.instantTransferBps), fees.instantTransferMinCents, fees.instantTransferMaxCents);
}

export function transferFee(amountCents: number, speed: Speed, fees: FeeSchedule): number {
  return speed === "instant" ? instantFee(amountCents, fees) : fees.standardAchCents;
}

export interface SenderCtx {
  kyc: KycState;
  tier: Tier;
  accountId: string;
  accountStatus: "open" | "frozen" | "closing" | "closed";
  availableCents: number;
  usage: UsageEvent[];
}

function commonChecks(amountCents: number, feeCents: number, s: SenderCtx, now: Date, policy: MoneyPolicy): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TransferError("invalid_amount");
  if (!canMoveMoney(s.kyc)) throw new TransferError("kyc_not_approved");
  if (s.accountStatus !== "open") throw new TransferError("account_frozen");
  const lim = checkLimit(s.tier, "transfer_out", amountCents, s.usage, now, policy);
  if (!lim.ok) throw new TransferError(lim.reason!, `${lim.reason}: remaining today ${lim.remainingDaily}, month ${lim.remainingMonthly}`);
  if (amountCents + feeCents > s.availableCents) throw new TransferError("insufficient_funds");
}

export interface PushPlan { feeCents: number; totalDebitCents: number; ledger: Txn }

/** ACH push to a linked bank. Standard is free; instant charges the published fee. */
export function planAchPush(p: {
  transferId: string; amountCents: number; speed: Speed; bank: LinkedBank; sender: SenderCtx; now: Date;
}, policy: MoneyPolicy, fees: FeeSchedule): PushPlan {
  if (p.sender.kyc === "frozen_legal" || (canMoveMoney(p.sender.kyc) && !canPayout(p.sender.kyc))) throw new TransferError("payout_blocked");
  if (p.bank.status !== "active") throw new TransferError("bank_not_active");
  if (!p.bank.nameMatched) throw new TransferError("bank_name_mismatch");
  if (inCoolingOff(p.bank, p.now, policy)) throw new TransferError("cooling_off", `withdrawals to a newly linked bank are allowed after ${policy.achOut.coolingOffHours}h`);
  const feeCents = transferFee(p.amountCents, p.speed, fees);
  commonChecks(p.amountCents, feeCents, p.sender, p.now, policy);
  return {
    feeCents,
    totalDebitCents: p.amountCents + feeCents,
    ledger: txn(`ach_out_${p.speed}`, [
      dr("customer_deposits", p.amountCents + feeCents, p.sender.accountId),
      cr("ach_clearing", p.amountCents),
      cr("fee_revenue", feeCents),
    ], p.transferId),
  };
}

export interface RecipientCtx { userId: string; kyc: KycState; accountId: string; accountStatus: string }

/** P2P to another Harbor user. First transfer to a new payee requires step-up when the policy flag is on. */
export function planP2P(p: {
  transferId: string; amountCents: number; senderUserId: string; sender: SenderCtx; recipient: RecipientCtx | null;
  knownPayee: boolean; stepUpVerified: boolean; now: Date;
}, policy: MoneyPolicy, fees: FeeSchedule): { feeCents: number; ledger: Txn; newPayee: boolean } {
  if (!p.recipient || !canReceive(p.recipient.kyc) || p.recipient.accountStatus !== "open") throw new TransferError("recipient_unavailable");
  if (p.recipient.userId === p.senderUserId) throw new TransferError("self_transfer");
  if (p.amountCents < policy.p2p.minCents && Number.isSafeInteger(p.amountCents) && p.amountCents > 0) throw new TransferError("below_minimum");
  const feeCents = fees.p2pCents;
  commonChecks(p.amountCents, feeCents, p.sender, p.now, policy);
  const newPayee = !p.knownPayee;
  if (newPayee && policy.p2p.newPayeeStepUp && !p.stepUpVerified) throw new TransferError("step_up_required");
  return {
    feeCents,
    newPayee,
    ledger: txn("p2p", [
      dr("customer_deposits", p.amountCents + feeCents, p.sender.accountId),
      cr("customer_deposits", p.amountCents, p.recipient.accountId),
      cr("fee_revenue", feeCents),
    ], p.transferId),
  };
}

/** Move between the customer's own pockets (checking <-> savings). Not subject to transfer-out limits. */
export function planPocketMove(p: { transferId: string; fromAccountId: string; toAccountId: string; amountCents: number; availableCents: number; kyc: KycState }): Txn {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new TransferError("invalid_amount");
  if (!canMoveMoney(p.kyc)) throw new TransferError("kyc_not_approved");
  if (p.fromAccountId === p.toAccountId) throw new TransferError("self_transfer");
  if (p.amountCents > p.availableCents) throw new TransferError("insufficient_funds");
  return txn("pocket_move", [dr("customer_deposits", p.amountCents, p.fromAccountId), cr("customer_deposits", p.amountCents, p.toAccountId)], p.transferId);
}
