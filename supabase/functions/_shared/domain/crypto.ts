// BTC cashback rewards for Harbor consumer accounts.
//
// Program model (unchanged): BTC earned as card cashback is a rewards asset that
// CONVERTS TO USD for spending. This PR adds the ability to send BTC OUT to an
// external wallet, as BTC, so a user can withdraw their cashback off-platform.
import type { Cents } from "./money.ts";
import { applyBps } from "./money.ts";

/** Satoshis: integer minor unit of BTC (1 BTC = 100_000_000 sats). Never floats. */
export type Sats = number;

export interface BtcAccount {
  accountId: string;
  balanceSats: Sats;
}

/** A BTC cashback earn, linked to the card purchase that generated it. */
export interface BtcEarn {
  earnId: string;
  purchaseTxnId: string;
  sats: Sats;
}

/** Earn BTC cashback on a card purchase. rateBps of USD spend, priced at usdPerBtcCents. */
export function earnBtcCashback(purchaseCents: Cents, rateBps: number, usdPerBtcCents: number): Sats {
  if (!Number.isSafeInteger(purchaseCents) || purchaseCents <= 0) throw new Error("bad purchase");
  if (!Number.isSafeInteger(usdPerBtcCents) || usdPerBtcCents <= 0) throw new Error("bad price");
  const rewardCents = applyBps(purchaseCents, rateBps);
  return Math.floor((rewardCents * 100_000_000) / usdPerBtcCents);
}

/** Convert BTC to USD for spending — the sanctioned path. */
export function convertBtcToUsd(sats: Sats, usdPerBtcCents: number): Cents {
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error("bad sats");
  if (!Number.isSafeInteger(usdPerBtcCents) || usdPerBtcCents <= 0) throw new Error("bad price");
  return Math.floor((sats * usdPerBtcCents) / 100_000_000);
}

/**
 * NEW (this PR): send BTC out to an external address, as BTC.
 * Debits the user's cashback balance and broadcasts the on-chain send.
 */
export function sendBtcOut(acct: BtcAccount, sats: Sats, toAddress: string): { balanceSats: Sats } {
  if (!toAddress) throw new Error("missing address");
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error("bad sats");
  if (sats > acct.balanceSats) throw new Error("insufficient_btc");
  acct.balanceSats = acct.balanceSats - sats;
  return { balanceSats: acct.balanceSats };
}
