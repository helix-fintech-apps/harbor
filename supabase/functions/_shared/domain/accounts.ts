// Accounts (checking + savings pockets), fake account/routing numbers, and balances.
// Posted balance = ledger (credits - debits). Available = posted - active holds.

import type { Line } from "./ledger.ts";
import { partyBalance } from "./ledger.ts";

export type AccountKind = "checking" | "savings";
export type AccountStatus = "open" | "frozen" | "closing" | "closed";

/** Harbor's fake routing number (passes the ABA checksum; not a real bank). */
export const HARBOR_ROUTING_NUMBER = "091000019";

export function abaChecksumValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const s = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return s % 10 === 0;
}

/** Deterministic fake 12-digit account number from a seed (e.g. account uuid), prefixed 8800. */
export function fakeAccountNumber(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "8800" + String(h).padStart(10, "0").slice(-8);
}

export function maskAccountNumber(n: string): string {
  return "••••" + n.slice(-4);
}

export type HoldKind = "ach_in" | "card_auth" | "dispute" | "legal";
export type HoldStatus = "active" | "released" | "captured" | "expired";

export interface Hold {
  id: string;
  accountId: string;
  kind: HoldKind;
  amountCents: number;
  status: HoldStatus;
  createdAt: Date;
  expiresAt?: Date;       // card auths expire; ACH holds release at settlement
  releaseAt?: Date;
}

export function holdIsActive(h: Hold, now: Date): boolean {
  if (h.status !== "active") return false;
  if (h.expiresAt && now.getTime() >= h.expiresAt.getTime()) return false;
  return true;
}

export function activeHoldsTotal(holds: Hold[], accountId: string, now: Date): number {
  return holds.filter((h) => h.accountId === accountId && holdIsActive(h, now)).reduce((a, h) => a + h.amountCents, 0);
}

export interface Balances { postedCents: number; availableCents: number; holdsCents: number }

export function balances(lines: Line[], holds: Hold[], accountId: string, now: Date): Balances {
  const postedCents = partyBalance(lines, "customer_deposits", accountId);
  const holdsCents = activeHoldsTotal(holds, accountId, now);
  return { postedCents, holdsCents, availableCents: postedCents - holdsCents };
}
