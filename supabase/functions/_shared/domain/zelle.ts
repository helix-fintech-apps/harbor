// Zelle bill pay: one-time and recurring (weekly / monthly) sends from any of the user's accounts.
// If the chosen source account can't cover the send, the shortfall is automatically pulled from the
// user's other accounts before the money leaves. Returns/refunds come back as Zelle return webhooks.
//
// Pure planning only: the funding split and ledger are computed here; the store persists them
// atomically and re-checks each contributing account's available balance under a row lock.

import { cr, dr, txn, type Txn } from "./ledger.ts";
import { daysInMonth } from "./time.ts";

export type ZelleFrequency = "once" | "weekly" | "monthly";
export type ZellePaymentStatus = "sent" | "returned";
export type ZelleScheduleStatus = "active" | "canceled";

/** One account's contribution to a send. */
export interface ZelleFundingLeg {
  accountId: string;
  cents: number;
}

export interface AccountFunds {
  accountId: string;
  availableCents: number;
}

export type ZelleRejection =
  "invalid_amount" | "invalid_recipient" | "invalid_frequency" | "insufficient_funds";

export class ZelleError extends Error {
  constructor(
    public code: ZelleRejection,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const FREQUENCIES: ZelleFrequency[] = ["once", "weekly", "monthly"];

/** A recipient is an email address or a US phone number (10–15 digits, optional +). */
export function normalizeRecipient(raw: string): string | null {
  const r = (raw ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) return r.toLowerCase();
  const digits = r.replace(/[\s()+-]/g, "");
  if (/^\d{10,15}$/.test(digits)) return digits;
  return null;
}

export function validateZelleRequest(p: {
  amountCents: number;
  recipient: string;
  frequency: ZelleFrequency;
}): void {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  if (!normalizeRecipient(p.recipient)) throw new ZelleError("invalid_recipient");
  if (!FREQUENCIES.includes(p.frequency)) throw new ZelleError("invalid_frequency");
}

/**
 * Decide which accounts fund a send. The source pays as much as it can; any shortfall is pulled
 * from the other accounts, most-available first (ties broken by account id for determinism).
 * Throws `insufficient_funds` if the user's accounts together can't cover the amount.
 */
export function planZelleFunding(p: {
  amountCents: number;
  source: AccountFunds;
  others: AccountFunds[];
}): ZelleFundingLeg[] {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new ZelleError("invalid_amount");
  const legs: ZelleFundingLeg[] = [];
  let remaining = p.amountCents;
  const take = (a: AccountFunds) => {
    if (remaining <= 0) return;
    const avail = Math.max(0, a.availableCents);
    const cents = Math.min(avail, remaining);
    if (cents > 0) {
      legs.push({ accountId: a.accountId, cents });
      remaining -= cents;
    }
  };
  take(p.source);
  const ordered = [...p.others]
    .filter((a) => a.accountId !== p.source.accountId)
    .sort((a, b) => b.availableCents - a.availableCents || a.accountId.localeCompare(b.accountId));
  for (const a of ordered) take(a);
  if (remaining > 0)
    throw new ZelleError(
      "insufficient_funds",
      `available across accounts falls ${remaining} short of ${p.amountCents}`,
    );
  return legs;
}

/** Build the ledger for a send: debit each funding leg, credit Zelle clearing the total. */
export function planZelleSend(p: {
  paymentId: string;
  amountCents: number;
  source: AccountFunds;
  others: AccountFunds[];
}): { funding: ZelleFundingLeg[]; ledger: Txn } {
  const funding = planZelleFunding(p);
  return {
    funding,
    ledger: txn(
      "zelle_send",
      [
        ...funding.map((l) => dr("customer_deposits", l.cents, l.accountId)),
        cr("zelle_clearing", p.amountCents),
      ],
      p.paymentId,
    ),
  };
}

/** Reverse a returned send: debit Zelle clearing, credit each account exactly what it contributed. */
export function planZelleReturn(p: {
  paymentId: string;
  amountCents: number;
  funding: ZelleFundingLeg[];
}): Txn {
  const total = p.funding.reduce((s, l) => s + l.cents, 0);
  if (total !== p.amountCents)
    throw new Error(
      `return funding (${total}) does not match the payment amount (${p.amountCents})`,
    );
  return txn(
    "zelle_return",
    [
      dr("zelle_clearing", p.amountCents),
      ...p.funding.map((l) => cr("customer_deposits", l.cents, l.accountId)),
    ],
    `${p.paymentId}:return`,
  );
}

/** Next run date for a recurring schedule (UTC calendar). Monthly clamps to the month length. */
export function nextRunDate(from: Date, frequency: ZelleFrequency): Date {
  if (frequency === "weekly") return new Date(from.getTime() + 7 * 86_400_000);
  if (frequency === "monthly") {
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth();
    const day = Math.min(from.getUTCDate(), daysInMonth(y, m + 1));
    return new Date(Date.UTC(y, m + 1, day, from.getUTCHours(), from.getUTCMinutes()));
  }
  return from;
}
