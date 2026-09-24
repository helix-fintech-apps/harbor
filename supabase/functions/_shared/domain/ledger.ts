// Double-entry ledger. Every money event posts lines whose debits equal credits.
// Customer accounts are liabilities: balance = credits - debits (party = Harbor account id).

export type LedgerAccount =
  | "customer_deposits"     // per Harbor account (checking / savings), party = account id
  | "family_allowance"      // per family member (teen allowance pocket), party = member id
  | "ach_clearing"          // ACH in flight to/from external banks
  | "card_settlement"       // card network settlement
  | "fee_revenue"
  | "interest_expense"
  | "dispute_receivable"    // provisional credit given, pending network outcome
  | "dispute_loss"
  | "ach_return_loss"       // negative balances written off
  | "closure_payout";       // closure payouts in flight

export interface Line { account: LedgerAccount; party?: string; debit: number; credit: number }
export interface Txn { kind: string; ref?: string; lines: Line[] }

export function assertBalanced(t: Txn): void {
  let net = 0;
  for (const l of t.lines) {
    if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || l.debit < 0 || l.credit < 0) {
      throw new Error(`invalid line amounts in ${t.kind}`);
    }
    net += l.debit - l.credit;
  }
  if (net !== 0) throw new Error(`unbalanced ${t.kind}: off by ${net}`);
}

export const dr = (account: LedgerAccount, amount: number, party?: string): Line => ({ account, party, debit: amount, credit: 0 });
export const cr = (account: LedgerAccount, amount: number, party?: string): Line => ({ account, party, debit: 0, credit: amount });

export function txn(kind: string, lines: Line[], ref?: string): Txn {
  const t = { kind, ref, lines: lines.filter((l) => l.debit !== 0 || l.credit !== 0) };
  if (t.lines.length === 0) throw new Error(`empty txn ${kind}`);
  assertBalanced(t);
  return t;
}

/** Balance of a liability-style account for a party: credits - debits. */
export function partyBalance(lines: Line[], account: LedgerAccount, party: string): number {
  let b = 0;
  for (const l of lines) if (l.account === account && l.party === party) b += l.credit - l.debit;
  return b;
}

/** Trial balance: sum of debits minus credits across all lines must be zero. */
export function trialBalance(lines: Line[]): number {
  return lines.reduce((a, l) => a + l.debit - l.credit, 0);
}
