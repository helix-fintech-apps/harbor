// Money helpers. All amounts are integer minor units (cents). Never use floats for money.

export type Cents = number;

export function assertCents(n: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be integer cents, got ${n}`);
  return n;
}

export function assertPositiveCents(n: number, label = "amount"): Cents {
  assertCents(n, label);
  if (n <= 0) throw new Error(`${label} must be positive, got ${n}`);
  return n;
}

/** Integer division rounded half-up (away from zero for negatives). */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error("denominator must be positive");
  if (numerator < 0) return -divRoundHalfUp(-numerator, denominator);
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Integer division rounded half-to-even ("banker's rounding"). BigInt-safe for large numerators. */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  if (numerator < 0n) return -divRoundHalfEven(-numerator, denominator);
  const q = numerator / denominator;
  const r = numerator % denominator;
  const twice = r * 2n;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  return q % 2n === 0n ? q : q + 1n;
}

/** Apply basis points (1 bp = 0.01%) to an amount, rounding half-up. */
export function applyBps(amount: Cents, bps: number): Cents {
  return divRoundHalfUp(amount * bps, 10_000);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function formatCents(c: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(c / 100);
}

/** Basis points as a percentage: 400 -> "4%", 150 -> "1.50%", 5 -> "0.05%". Integer math only. */
export function formatBps(bps: number): string {
  if (!Number.isSafeInteger(bps)) throw new Error(`bps must be an integer, got ${bps}`);
  const sign = bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return frac === 0 ? `${sign}${whole}%` : `${sign}${whole}.${String(frac).padStart(2, "0")}%`;
}
