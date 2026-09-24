// Cardholder disputes (Reg E style). Provisional credit is due within N business days of
// notice; the investigation must finish within resolutionDays (longer for new accounts).
// Won: provisional credit becomes final. Lost: provisional credit is reversed.

import type { MoneyPolicy } from "./config.ts";
import { addBusinessDays, addDays } from "./time.ts";
import { cr, dr, txn, type LedgerAccount, type Txn } from "./ledger.ts";

export type DisputeStatus = "open" | "provisional_credited" | "won" | "lost" | "withdrawn";

export interface Dispute {
  id: string;
  authId: string;
  accountId: string;          // account credited (owner checking or allowance funding party)
  creditAccount: LedgerAccount;
  amountCents: number;
  status: DisputeStatus;
  openedAt: Date;
  provisionalCreditDueAt: Date;
  resolutionDueAt: Date;
  provisionalCreditCents: number;
}

export function disputeTimeline(openedAt: Date, accountOpenedAt: Date, policy: MoneyPolicy): { provisionalCreditDueAt: Date; resolutionDueAt: Date } {
  const ageDays = (openedAt.getTime() - accountOpenedAt.getTime()) / 86_400_000;
  const newAccount = ageDays < policy.disputes.newAccountDays;
  return {
    provisionalCreditDueAt: addBusinessDays(openedAt, policy.disputes.provisionalCreditBusinessDays, policy.holidays),
    resolutionDueAt: addDays(openedAt, newAccount ? policy.disputes.newAccountResolutionDays : policy.disputes.resolutionDays),
  };
}

export function openDispute(p: {
  id: string; authId: string; accountId: string; creditAccount?: LedgerAccount; amountCents: number;
  capturedCents: number; refundedCents: number; postedAt: Date; now: Date; accountOpenedAt: Date; existingOpen: boolean;
}, policy: MoneyPolicy): Dispute {
  if (p.existingOpen) throw new Error("a dispute is already open for this transaction");
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error("amount must be positive cents");
  if (p.amountCents > p.capturedCents - p.refundedCents) throw new Error("dispute exceeds the unrefunded purchase amount");
  if (p.now.getTime() > addDays(p.postedAt, policy.disputes.windowDays).getTime()) throw new Error("dispute window closed");
  const tl = disputeTimeline(p.now, p.accountOpenedAt, policy);
  return {
    id: p.id, authId: p.authId, accountId: p.accountId, creditAccount: p.creditAccount ?? "customer_deposits",
    amountCents: p.amountCents, status: "open", openedAt: p.now, ...tl, provisionalCreditCents: 0,
  };
}

export function planProvisionalCredit(d: Dispute): { dispute: Dispute; ledger: Txn } {
  if (d.status !== "open") throw new Error(`provisional credit not allowed in ${d.status}`);
  return {
    dispute: { ...d, status: "provisional_credited", provisionalCreditCents: d.amountCents },
    ledger: txn("dispute_provisional_credit", [dr("dispute_receivable", d.amountCents), cr(d.creditAccount, d.amountCents, d.accountId)], d.id),
  };
}

/** Provisional credit is overdue if not given by the due date and the dispute is unresolved. */
export function provisionalCreditOverdue(d: Dispute, now: Date): boolean {
  return d.status === "open" && now.getTime() > d.provisionalCreditDueAt.getTime();
}

export function resolveDispute(d: Dispute, outcome: "won" | "lost"): { dispute: Dispute; ledger?: Txn } {
  if (d.status !== "open" && d.status !== "provisional_credited") throw new Error(`dispute already ${d.status}`);
  const credited = d.status === "provisional_credited";
  if (outcome === "won") {
    // Network chargeback recovers the money from the merchant.
    const lines = credited
      ? [dr("card_settlement", d.amountCents), cr("dispute_receivable", d.amountCents)]
      : [dr("card_settlement", d.amountCents), cr(d.creditAccount, d.amountCents, d.accountId)];
    return { dispute: { ...d, status: "won" }, ledger: txn("dispute_won", lines, d.id) };
  }
  if (!credited) {
    // Nothing was credited, so there is nothing to reverse.
    return { dispute: { ...d, status: "lost" } };
  }
  return {
    dispute: { ...d, status: "lost", provisionalCreditCents: 0 },
    ledger: txn("dispute_lost_reversal", [dr(d.creditAccount, d.amountCents, d.accountId), cr("dispute_receivable", d.amountCents)], d.id),
  };
}
