// Savings interest. ROUNDING (documented in docs/SPEC.md and the fee page):
//  1. Daily accrual is computed in integer MICRO-CENTS (1 cent = 1,000,000 micro-cents) using a
//     simple daily rate = APY / 365: accrual = floor(balance_cents * apy_bps * 1e6 / (10000 * 365)).
//     Negative or zero balances accrue nothing. Floor (truncate) per day.
//  2. At month end the month's accrued micro-cents PLUS the carried remainder from last month are
//     converted to cents with banker's rounding (half-to-even) and posted as one ledger txn.
//  3. The difference (accrued - posted*1e6), which may be negative, carries to next month, so the
//     customer is never over- or under-paid by more than half a cent over any horizon.

import type { MoneyPolicy } from "./config.ts";
import { divRoundHalfEven } from "./money.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";

export const MICRO_PER_CENT = 1_000_000n;

export function dailyAccrualMicro(balanceCents: number, policy: MoneyPolicy): bigint {
  if (balanceCents <= 0) return 0n;
  const num = BigInt(balanceCents) * BigInt(policy.interest.savingsApyBps) * MICRO_PER_CENT;
  const den = 10_000n * BigInt(policy.interest.dayCountBasis);
  return num / den; // floor
}

export function accrueMonth(dailyEndBalancesCents: number[], policy: MoneyPolicy): bigint {
  return dailyEndBalancesCents.reduce((acc, b) => acc + dailyAccrualMicro(b, policy), 0n);
}

export interface MonthlyPosting {
  postCents: number;
  carryMicro: bigint;
  ledger?: Txn;
}

export function planMonthlyInterest(p: {
  accountId: string;
  period: string;
  accruedMicro: bigint;
  carryInMicro: bigint;
}): MonthlyPosting {
  const total = p.accruedMicro + p.carryInMicro;
  const cents = divRoundHalfEven(total, MICRO_PER_CENT);
  const carry = total - cents * MICRO_PER_CENT;
  const postCents = Number(cents);
  if (postCents <= 0) return { postCents: 0, carryMicro: total > 0n ? total : 0n };
  return {
    postCents,
    carryMicro: carry,
    ledger: txn(
      "interest_posting",
      [dr("interest_expense", postCents), cr("customer_deposits", postCents, p.accountId)],
      `${p.accountId}:${p.period}`,
    ),
  };
}
