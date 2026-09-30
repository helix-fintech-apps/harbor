// Zelle bill pay (money out to an external recipient). One-time or recurring (weekly / monthly).
// Money leaves the customer's pocket(s) to the Zelle network: dr customer_deposits, cr zelle_clearing.
// A Zelle send draws first from the chosen source account; if the source is short, the shortfall is
// pulled from the user's OTHER spendable pockets (checking + savings, never earmarked envelopes),
// in the order the caller supplies, taking each pocket's available balance until the amount is
// covered. No pocket is ever overdrawn. Returns/refunds arrive later as webhooks and reverse the
// credit back into the source account.

import type { AccountKind } from "./accounts.ts";
import { addDays, daysInMonth } from "./time.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";

export type ZelleFrequency = "once" | "weekly" | "monthly";

export type ZelleRejection = "invalid_amount" | "invalid_recipient" | "insufficient_funds";

export class ZelleError extends Error {
  constructor(
    public code: ZelleRejection,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ZelleRecipient {
  email?: string;
  phone?: string;
}

/** A pocket the send may draw from, with the available balance the plan will re-check under lock. */
export interface SpendablePocket {
  accountId: string;
  kind: AccountKind;
  availableCents: number;
}

export interface ZelleContribution {
  accountId: string;
  amountCents: number;
}

export interface ZellePlan {
  /** Per-pocket debits that fund the send (source first, then pulled pockets), summing to amount. */
  funding: ZelleContribution[];
  /** Amount drawn from pockets other than the source (0 when the source covered it alone). */
  shortfallCents: number;
  ledger: Txn;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9]{7,15}$/;

export function validateRecipient(r: ZelleRecipient | null | undefined): boolean {
  if (!r) return false;
  if (r.email) return EMAIL.test(r.email.trim());
  if (r.phone) return PHONE.test(r.phone.replace(/[\s()-]/g, ""));
  return false;
}

export function isValidFrequency(f: unknown): f is ZelleFrequency {
  return f === "once" || f === "weekly" || f === "monthly";
}

/**
 * Plan a Zelle send. `spendable[0]` must be the source pocket; the rest are the pull pockets in
 * priority order. Each pocket contributes min(its available, remaining); envelopes must be filtered
 * out of the pull pool by the caller. Throws ZelleError("insufficient_funds") if the source plus the
 * pull pockets cannot cover the amount.
 */
export function planZelleSend(p: {
  transferId: string;
  fromAccountId: string;
  amountCents: number;
  recipient: ZelleRecipient;
  spendable: SpendablePocket[];
  now: Date;
}): ZellePlan {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  if (!validateRecipient(p.recipient)) throw new ZelleError("invalid_recipient");
  if (!p.spendable.some((s) => s.accountId === p.fromAccountId))
    throw new ZelleError("invalid_amount", "source account is not spendable");

  let remaining = p.amountCents;
  const funding: ZelleContribution[] = [];
  for (const pocket of p.spendable) {
    if (remaining <= 0) break;
    const take = Math.min(pocket.availableCents, remaining);
    if (take > 0) {
      funding.push({ accountId: pocket.accountId, amountCents: take });
      remaining -= take;
    }
  }
  if (remaining > 0)
    throw new ZelleError(
      "insufficient_funds",
      `Zelle send needs ${p.amountCents}; only ${p.amountCents - remaining} available across pockets`,
    );

  const fromSource = funding.find((f) => f.accountId === p.fromAccountId)?.amountCents ?? 0;
  return {
    funding,
    shortfallCents: p.amountCents - fromSource,
    ledger: txn(
      "zelle_send",
      [
        ...funding.map((f) => dr("customer_deposits", f.amountCents, f.accountId)),
        cr("zelle_clearing", p.amountCents),
      ],
      p.transferId,
    ),
  };
}

/** A Zelle return/refund: the network sends the money back into the source pocket. */
export function planZelleReturn(p: {
  transferId: string;
  toAccountId: string;
  amountCents: number;
}): { ledger: Txn } {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  return {
    ledger: txn(
      "zelle_return",
      [dr("zelle_clearing", p.amountCents), cr("customer_deposits", p.amountCents, p.toAccountId)],
      p.transferId,
    ),
  };
}

/** Next run of a recurring schedule after `current`. Monthly clamps to the last day of the month. */
export function nextZelleRun(current: Date, frequency: ZelleFrequency): Date | null {
  if (frequency === "weekly") return addDays(current, 7);
  if (frequency === "monthly") {
    const y = current.getUTCFullYear();
    const m = current.getUTCMonth();
    const day = current.getUTCDate();
    const dim = daysInMonth(y, m + 1);
    return new Date(
      Date.UTC(
        y,
        m + 1,
        Math.min(day, dim),
        current.getUTCHours(),
        current.getUTCMinutes(),
        current.getUTCSeconds(),
      ),
    );
  }
  return null; // "once" does not recur
}
