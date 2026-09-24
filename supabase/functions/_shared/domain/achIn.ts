// Money in: linked banks, ACH pulls with holds until settlement, returns, owner-name match,
// direct-deposit switch form (record only).

import type { MoneyPolicy } from "./config.ts";
import { addBusinessDays, addHours } from "./time.ts";
import { normalizeName } from "./kyc.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";
import { assertPositiveCents } from "./money.ts";

export interface LinkedBank {
  id: string;
  userId: string;
  institution: string;
  mask: string;
  ownerNames: string[];
  nameMatched: boolean;
  linkedAt: Date;
  status: "active" | "removed";
}

/**
 * Account-owner name match. A linked account matches if ANY owner name shares first AND last
 * name tokens with the Harbor customer's legal name (case/accents/punctuation/middle names ignored).
 */
export function ownerNameMatches(legalName: string, ownerNames: string[]): boolean {
  const me = normalizeName(legalName);
  if (me.length < 2) return false;
  const first = me[0],
    last = me[me.length - 1];
  return ownerNames.some((o) => {
    const t = normalizeName(o);
    if (t.length < 2) return false;
    // allow "Last, First" ordering
    const set = new Set(t);
    return set.has(first) && set.has(last);
  });
}

export function inCoolingOff(bank: LinkedBank, now: Date, policy: MoneyPolicy): boolean {
  return now.getTime() < addHours(bank.linkedAt, policy.achOut.coolingOffHours).getTime();
}

export type AchInStatus = "pending" | "settled" | "returned";

export interface AchInPlan {
  settleAt: Date;
  holdCents: number;
  ledger: Txn;
}

/** Plan an ACH pull: credit posts immediately, a hold of the full amount lasts until settlement. */
export function planAchPull(
  p: {
    transferId: string;
    accountId: string;
    amountCents: number;
    bank: LinkedBank;
    now: Date;
  },
  policy: MoneyPolicy,
): AchInPlan {
  assertPositiveCents(p.amountCents);
  if (p.bank.status !== "active") throw new Error("bank not active");
  if (policy.achIn.nameMatchRequired && !p.bank.nameMatched)
    throw new Error("account owner name does not match");
  return {
    settleAt: addBusinessDays(p.now, policy.achIn.holdBusinessDays, policy.holidays),
    holdCents: p.amountCents,
    ledger: txn(
      "ach_in",
      [dr("ach_clearing", p.amountCents), cr("customer_deposits", p.amountCents, p.accountId)],
      p.transferId,
    ),
  };
}

export function canSettle(settleAt: Date, now: Date): boolean {
  return now.getTime() >= settleAt.getTime();
}

export interface AchReturnPlan {
  reverses: boolean;
  ledger?: Txn;
  releaseHold: boolean;
  /** Amount that exceeded the customer's balance and becomes a negative balance (clawback). */
  negativeBalanceCents: number;
}

/**
 * ACH return (e.g. R01 insufficient funds, R10 unauthorized). Reverses the credit.
 * If returned before settlement, the hold kept the money unavailable, so nothing was spent.
 * If after settlement and the customer already spent it, the balance goes negative (claw back).
 */
export function planAchReturn(
  p: {
    transferId: string;
    accountId: string;
    amountCents: number;
    returnCode: string;
    status: AchInStatus;
    postedBalanceCents: number;
  },
  policy: MoneyPolicy,
): AchReturnPlan {
  if (p.status === "returned") throw new Error("already returned");
  const reverses = policy.achIn.reversingReturnCodes.includes(p.returnCode);
  if (!reverses) return { reverses: false, releaseHold: false, negativeBalanceCents: 0 };
  const after = p.postedBalanceCents - p.amountCents;
  return {
    reverses: true,
    releaseHold: p.status === "pending",
    negativeBalanceCents: after < 0 ? -after : 0,
    ledger: txn(
      `ach_return_${p.returnCode}`,
      [dr("customer_deposits", p.amountCents, p.accountId), cr("ach_clearing", p.amountCents)],
      p.transferId,
    ),
  };
}

export interface DirectDepositForm {
  employerName: string;
  allocation:
    | { kind: "full" }
    | { kind: "percent"; percent: number }
    | { kind: "fixed"; amountCents: number };
  accountNumber: string;
  routingNumber: string;
  accountType: "checking" | "savings";
  signatureName: string;
}

/** Validate a direct-deposit switch form. The form is recorded only; Harbor does not contact employers. */
export function validateDirectDepositForm(f: DirectDepositForm, legalName: string): string[] {
  const errors: string[] = [];
  if (!f.employerName.trim()) errors.push("employer name required");
  if (
    f.allocation.kind === "percent" &&
    (!Number.isInteger(f.allocation.percent) ||
      f.allocation.percent < 1 ||
      f.allocation.percent > 100)
  )
    errors.push("percent must be 1-100");
  if (
    f.allocation.kind === "fixed" &&
    (!Number.isInteger(f.allocation.amountCents) || f.allocation.amountCents <= 0)
  )
    errors.push("fixed amount must be positive cents");
  if (!/^\d{9}$/.test(f.routingNumber)) errors.push("routing number must be 9 digits");
  if (!/^\d{4,17}$/.test(f.accountNumber)) errors.push("account number invalid");
  if (normalizeName(f.signatureName).join(" ") !== normalizeName(legalName).join(" "))
    errors.push("signature must match legal name");
  return errors;
}
