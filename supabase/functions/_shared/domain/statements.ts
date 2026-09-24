// Monthly statements are derived from the ledger only: opening + credits - debits = closing.

export interface StatementEntry { at: Date; kind: string; ref?: string; debit: number; credit: number }

export interface Statement {
  accountId: string;
  period: string;           // YYYY-MM
  openingCents: number;
  creditsCents: number;
  debitsCents: number;
  closingCents: number;
  entries: (StatementEntry & { runningCents: number })[];
}

export function periodBounds(period: string): { from: Date; to: Date } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error("period must be YYYY-MM");
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/** `entries` are the account's ledger lines (customer_deposits, party = accountId) with txn timestamps. */
export function buildStatement(accountId: string, period: string, entries: StatementEntry[]): Statement {
  const { from, to } = periodBounds(period);
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  let opening = 0;
  for (const e of sorted) if (e.at.getTime() < from.getTime()) opening += e.credit - e.debit;
  let running = opening, credits = 0, debits = 0;
  const out: Statement["entries"] = [];
  for (const e of sorted) {
    const t = e.at.getTime();
    if (t < from.getTime() || t >= to.getTime()) continue;
    credits += e.credit; debits += e.debit; running += e.credit - e.debit;
    out.push({ ...e, runningCents: running });
  }
  const closing = opening + credits - debits;
  if (closing !== running) throw new Error("statement does not reconcile");
  return { accountId, period, openingCents: opening, creditsCents: credits, debitsCents: debits, closingCents: closing, entries: out };
}
