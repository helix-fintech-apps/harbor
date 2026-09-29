// Zelle bill pay: one-time and recurring (weekly / monthly) payments to an external party.
// A payment is funded from a chosen source account; if the source is short at send time the
// shortfall is pulled from the user's other spendable accounts (checking / savings, never an
// earmarked envelope) before the payment goes out. Returns and refunds arrive as Zelle webhooks.

import type { MoneyPolicy } from "./config.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";
import { startOfUtcDay } from "./time.ts";

export type ZelleFrequency = "once" | "weekly" | "monthly";

export type ZelleRejection =
  | "invalid_amount"
  | "below_minimum"
  | "insufficient_funds"
  | "self_payment"
  | "recipient_required"
  | "invalid_frequency";

export class ZelleError extends Error {
  constructor(
    public code: ZelleRejection,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface ZelleFundingAccount {
  accountId: string;
  availableCents: number;
}

export interface ZelleSendPlan {
  amountCents: number;
  feeCents: number;
  /** Per-account debits, source first then the accounts the shortfall was pulled from. */
  contributions: { accountId: string; amountCents: number }[];
  pulledCents: number; // amount pulled from accounts other than the source
  ledger: Txn;
}

/**
 * Plan a Zelle send. The source account is drained first (up to its available balance); any
 * shortfall is pulled from `others` in the order given. Fails if the combined available balance
 * cannot cover the amount. Zelle has no fee.
 */
export function planZelleSend(
  p: {
    transferId: string;
    amountCents: number;
    source: ZelleFundingAccount;
    others: ZelleFundingAccount[];
  },
  policy: MoneyPolicy,
): ZelleSendPlan {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  if (p.amountCents < policy.zelle.minCents) throw new ZelleError("below_minimum");
  const total =
    p.source.availableCents + p.others.reduce((a, o) => a + Math.max(0, o.availableCents), 0);
  if (p.amountCents > total) throw new ZelleError("insufficient_funds");

  const contributions: { accountId: string; amountCents: number }[] = [];
  let remaining = p.amountCents;
  const take = (acct: ZelleFundingAccount) => {
    const amt = Math.min(Math.max(0, acct.availableCents), remaining);
    if (amt > 0) {
      contributions.push({ accountId: acct.accountId, amountCents: amt });
      remaining -= amt;
    }
  };
  take(p.source);
  for (const o of p.others) {
    if (remaining === 0) break;
    take(o);
  }
  if (remaining !== 0) throw new ZelleError("insufficient_funds"); // defensive; total check covers it

  const pulledCents = contributions
    .filter((c) => c.accountId !== p.source.accountId)
    .reduce((a, c) => a + c.amountCents, 0);

  return {
    amountCents: p.amountCents,
    feeCents: 0,
    contributions,
    pulledCents,
    ledger: txn(
      "zelle",
      [
        ...contributions.map((c) => dr("customer_deposits", c.amountCents, c.accountId)),
        cr("zelle_clearing", p.amountCents),
      ],
      p.transferId,
    ),
  };
}

/**
 * Plan a Zelle return/refund: money comes back from the network and is credited to the account
 * the payment was sent from. `amountCents` is bounded by the caller (never above what was sent
 * minus what already came back).
 */
export function planZelleReturn(p: {
  returnId: string;
  destinationAccountId: string;
  amountCents: number;
  returnCode: string;
}): { ledger: Txn } {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  return {
    ledger: txn(
      `zelle_return_${p.returnCode}`,
      [
        dr("zelle_clearing", p.amountCents),
        cr("customer_deposits", p.amountCents, p.destinationAccountId),
      ],
      p.returnId,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Recurring schedules.
// ---------------------------------------------------------------------------------------------

export function isValidFrequency(f: string): f is ZelleFrequency {
  return f === "once" || f === "weekly" || f === "monthly";
}

/** The next run instant after `from` for a recurring frequency (00:00 UTC on the target day). */
export function nextRunAt(frequency: ZelleFrequency, from: Date): Date | null {
  if (frequency === "once") return null;
  const base = startOfUtcDay(from);
  if (frequency === "weekly") return new Date(base.getTime() + 7 * 86_400_000);
  // monthly: same day-of-month next month, clamped to the month's length.
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const day = base.getUTCDate();
  const lastOfNext = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + 1, Math.min(day, lastOfNext)));
}

export function scheduleDue(nextRunAtIso: string, now: Date): boolean {
  return now.getTime() >= new Date(nextRunAtIso).getTime();
}
