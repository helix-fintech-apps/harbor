// BTC debit-cashback rewards. Pure functions, integer math only.
//
// Model
// -----
// Members earn Bitcoin cashback on *captured* debit-card spend (never on an auth — an auth can
// be reversed). The rate is MARGINAL and bracketed, like income tax: each dollar of eligible
// spend earns the rate of the band it falls in, and crossing a band never recomputes spend
// already earned at a lower rate. Eligible spend is capped per program period; spend above the
// cap earns nothing.
//
// Cashback is denominated and stored in **satoshis** (1 BTC = 100,000,000 sats), an asset
// quantity that lives OUTSIDE the USD double-entry ledger. A member cannot spend satoshis. The
// only way to realise them is to convert BTC -> USD at the live rate; the resulting USD lands in
// a separate, spendable rewards wallet.
//
// Rounding
// --------
// Every sat<->USD conversion floors toward zero, so residual dust always stays with Harbor and a
// member is never awarded, or paid out, more than is owed. The USD reward amount inside a bracket
// uses the same half-up basis-point rounding as the rest of the fee schedule (see money.ts).

import { applyBps, assertCents } from "./money.ts";

/** 1 BTC = 100,000,000 satoshis. */
export const SATS_PER_BTC = 100_000_000;
const SATS_PER_BTC_BIG = 100_000_000n;

/** A satoshi count. Always a non-negative safe integer. */
export type Sats = number;

/** BTC spot price, expressed as an integer number of USD cents per 1 BTC (e.g. $60,000 -> 6_000_000). */
export type BtcPriceCents = number;

export interface RewardBracket {
  /** Upper bound of this band in cumulative eligible spend (cents). The band runs from the
   *  previous bracket's upper bound (0 for the first) up to, but not including, this value. */
  uptoCents: number;
  /** Reward rate for spend in this band, in basis points (200 = 2%). */
  bps: number;
}

export interface BtcRewardsPolicy {
  version: number;
  enabled: boolean;
  /** Bands in ascending order. The last band's uptoCents must equal capCents. */
  brackets: RewardBracket[];
  /** Eligible-spend ceiling per program period (cents). Spend beyond this earns nothing. */
  capCents: number;
}

/** 2% to $20k, 3% to $30k, 4% to $40k, 5% to $50k; nothing above $50k. */
export const DEFAULT_BTC_REWARDS: BtcRewardsPolicy = {
  version: 1,
  enabled: true,
  brackets: [
    { uptoCents: 2_000_000, bps: 200 }, // first $20,000 @ 2%
    { uptoCents: 3_000_000, bps: 300 }, // next  $10,000 @ 3%
    { uptoCents: 4_000_000, bps: 400 }, // next  $10,000 @ 4%
    { uptoCents: 5_000_000, bps: 500 }, // next  $10,000 @ 5%
  ],
  capCents: 5_000_000, // $50,000 eligible-spend cap
};

/** Validate a policy's shape once, so a malformed schedule can't silently mis-price rewards. */
export function assertRewardsPolicy(p: BtcRewardsPolicy): BtcRewardsPolicy {
  if (!p.brackets.length) throw new Error("rewards policy has no brackets");
  let prev = 0;
  for (const b of p.brackets) {
    assertCents(b.uptoCents, "bracket.uptoCents");
    if (!Number.isSafeInteger(b.bps) || b.bps < 0) throw new Error(`invalid bracket bps ${b.bps}`);
    if (b.uptoCents <= prev) throw new Error("brackets must strictly ascend");
    prev = b.uptoCents;
  }
  if (p.brackets[p.brackets.length - 1].uptoCents !== p.capCents) {
    throw new Error("last bracket must end exactly at capCents");
  }
  return p;
}

export interface CashbackResult {
  /** USD value of the cashback earned on this spend, in cents (half-up per bracket). */
  rewardUsdCents: number;
  /** The portion of this spend that was within the eligible cap and actually earned. */
  eligibleSpendCents: number;
  /** Cumulative eligible spend after this transaction (never exceeds capCents). */
  newEligibleCents: number;
}

/**
 * Marginal, bracketed cashback for one captured debit spend.
 *
 * @param priorEligibleCents cumulative eligible spend already booked this period (>= 0)
 * @param spendCents         the captured amount of this transaction (> 0)
 */
export function cashbackForSpend(
  priorEligibleCents: number,
  spendCents: number,
  policy: BtcRewardsPolicy = DEFAULT_BTC_REWARDS,
): CashbackResult {
  assertCents(priorEligibleCents, "priorEligibleCents");
  assertCents(spendCents, "spendCents");
  if (priorEligibleCents < 0) throw new Error("priorEligibleCents must be >= 0");
  if (spendCents <= 0) throw new Error("spendCents must be positive");
  if (!policy.enabled) {
    return { rewardUsdCents: 0, eligibleSpendCents: 0, newEligibleCents: priorEligibleCents };
  }
  assertRewardsPolicy(policy);

  const cap = policy.capCents;
  // Only the slice of this spend that lands inside [priorEligible, cap) earns anything.
  const start = Math.min(priorEligibleCents, cap);
  const end = Math.min(priorEligibleCents + spendCents, cap);
  const eligibleSpendCents = Math.max(0, end - start);

  let reward = 0;
  let bandLo = 0;
  for (const b of policy.brackets) {
    const bandHi = b.uptoCents;
    const overlap = Math.max(0, Math.min(end, bandHi) - Math.max(start, bandLo));
    if (overlap > 0) reward += applyBps(overlap, b.bps);
    bandLo = bandHi;
  }

  return {
    rewardUsdCents: reward,
    eligibleSpendCents,
    newEligibleCents: start + eligibleSpendCents,
  };
}

/** Convert a USD-cent amount to satoshis at the given price, flooring (dust stays with Harbor). */
export function usdCentsToSats(usdCents: number, priceCents: BtcPriceCents): Sats {
  assertCents(usdCents, "usdCents");
  if (usdCents < 0) throw new Error("usdCents must be >= 0");
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new Error(`btc price must be a positive integer, got ${priceCents}`);
  }
  const sats = (BigInt(usdCents) * SATS_PER_BTC_BIG) / BigInt(priceCents);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("sats overflow");
  return Number(sats);
}

/** Convert satoshis to a USD-cent amount at the given price, flooring (dust stays with Harbor). */
export function satsToUsdCents(sats: Sats, priceCents: BtcPriceCents): number {
  if (!Number.isSafeInteger(sats) || sats < 0)
    throw new Error(`sats must be a non-negative integer, got ${sats}`);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw new Error(`btc price must be a positive integer, got ${priceCents}`);
  }
  const cents = (BigInt(sats) * BigInt(priceCents)) / SATS_PER_BTC_BIG;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("usd cents overflow");
  return Number(cents);
}

export interface BtcConversion {
  /** Sats removed from the rewards balance. */
  satsDebited: Sats;
  /** USD credited to the rewards wallet (floored). */
  usdCents: number;
  /** Rewards balance remaining after the conversion. */
  remainingSats: Sats;
}

/**
 * Plan a BTC -> USD conversion. Never converts more than is held, and rejects a conversion whose
 * floored USD value would be zero so no sats are ever burned for nothing.
 *
 * @param heldSats    the member's current rewards balance in sats
 * @param requestSats the sats they want to convert (> 0, <= heldSats)
 */
export function planBtcConversion(
  heldSats: Sats,
  requestSats: Sats,
  priceCents: BtcPriceCents,
): BtcConversion {
  if (!Number.isSafeInteger(heldSats) || heldSats < 0) throw new Error("heldSats invalid");
  if (!Number.isSafeInteger(requestSats) || requestSats <= 0)
    throw new Error("requestSats must be positive");
  if (requestSats > heldSats) throw new Error("insufficient_btc_balance");
  const usdCents = satsToUsdCents(requestSats, priceCents);
  if (usdCents <= 0) throw new Error("conversion_below_one_cent");
  return { satsDebited: requestSats, usdCents, remainingSats: heldSats - requestSats };
}

export function formatSats(sats: Sats): string {
  return `${sats.toLocaleString("en-US")} sats`;
}
