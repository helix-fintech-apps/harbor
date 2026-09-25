// Round-up savings: round a card purchase UP to the next whole dollar and sweep the
// difference from checking into savings. Pure functions, integer cents only.

import { cr, dr, txn, type Txn } from "./ledger.ts";

/**
 * The round-up sweep for a purchase: ceil(amount/100)*100 - amount, always in [0, 99].
 * A whole-dollar amount rounds up 0 (no sweep). Inputs are cents, not dollars, so a
 * 99c purchase (amount 99) sweeps 1c and a 5000c purchase ($50.00) sweeps 0.
 */
export function roundUpCents(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0)
    throw new Error(`amount must be a non-negative integer cents, got ${amountCents}`);
  return (100 - (amountCents % 100)) % 100;
}

export interface RoundupInput {
  id: string;
  checkingAccountId: string;
  memberSavingsId?: string;
  amountCents: number;
  availableCents: number;
}

/**
 * Plan the ledger move for a purchase's round-up. Returns null when there is nothing to
 * sweep (whole-dollar amount). Throws when the round-up would overdraw available funds.
 * The txn debits the checking pocket and credits the savings pocket for the same cents,
 * so it always conserves total balance (debit == credit).
 */
export function planRoundup(p: RoundupInput): Txn | null {
  const sweep = roundUpCents(p.amountCents);
  if (sweep === 0) return null;
  if (!Number.isSafeInteger(p.availableCents) || sweep > p.availableCents)
    throw new Error(`round-up ${sweep} exceeds available ${p.availableCents}`);
  return txn(
    "roundup",
    [
      dr("customer_deposits", sweep, p.checkingAccountId),
      cr("customer_deposits", sweep, p.memberSavingsId),
    ],
    p.id,
  );
}
