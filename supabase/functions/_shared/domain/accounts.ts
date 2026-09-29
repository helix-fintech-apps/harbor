// Accounts (checking + savings pockets), fake account/routing numbers, and balances.
// Posted balance = ledger (credits - debits). Available = posted - active holds.

import type { Line } from "./ledger.ts";
import { cr, dr, partyBalance, txn, type Txn } from "./ledger.ts";
import { isoDate } from "./time.ts";

// Checking + savings are the primary pockets opened at KYC. Users may also open extra pockets on
// demand: more checking/savings, and temporary "envelope" accounts with a start and end date that
// auto-close on their end date, sweeping any remaining balance into the primary checking account.
export type AccountKind = "checking" | "savings" | "envelope";
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
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
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
  expiresAt?: Date; // card auths expire; ACH holds release at settlement
  releaseAt?: Date;
}

export function holdIsActive(h: Hold, now: Date): boolean {
  if (h.status !== "active") return false;
  if (h.expiresAt && now.getTime() >= h.expiresAt.getTime()) return false;
  return true;
}

export function activeHoldsTotal(holds: Hold[], accountId: string, now: Date): number {
  return holds
    .filter((h) => h.accountId === accountId && holdIsActive(h, now))
    .reduce((a, h) => a + h.amountCents, 0);
}

export interface Balances {
  postedCents: number;
  availableCents: number;
  holdsCents: number;
}

export function balances(lines: Line[], holds: Hold[], accountId: string, now: Date): Balances {
  const postedCents = partyBalance(lines, "customer_deposits", accountId);
  const holdsCents = activeHoldsTotal(holds, accountId, now);
  return { postedCents, holdsCents, availableCents: postedCents - holdsCents };
}

// ---------- on-demand accounts ----------

export type OnDemandKind = "checking" | "savings" | "envelope";

/** Validate a request to open an account on demand. Envelopes require a start and end date. */
export function validateNewAccount(p: {
  kind: OnDemandKind;
  startDate?: string;
  endDate?: string;
  openCount: number;
  maxOpen: number;
}): string[] {
  const e: string[] = [];
  if (!["checking", "savings", "envelope"].includes(p.kind)) e.push("unknown account kind");
  if (p.openCount >= p.maxOpen) e.push("account limit reached");
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
  if (p.kind === "envelope") {
    if (!isDate(p.startDate) || !isDate(p.endDate)) {
      e.push("envelope accounts need a start date and end date (YYYY-MM-DD)");
    } else if (p.endDate! < p.startDate!) {
      e.push("envelope end date must be on or after the start date");
    }
  } else if (p.startDate || p.endDate) {
    e.push("only envelope accounts have a start and end date");
  }
  return e;
}

/** A temporary envelope auto-closes once its end date has passed (end date inclusive). */
export function envelopeShouldClose(endDate: string, now: Date): boolean {
  return isoDate(now) > endDate;
}

/**
 * Sweep an envelope's remaining balance into the primary checking pocket and close it.
 * Returns null when the envelope is already empty (nothing to move; the account just closes).
 */
export function planEnvelopeSweep(p: {
  transferId: string;
  envelopeAccountId: string;
  checkingAccountId: string;
  remainingCents: number;
}): Txn | null {
  if (!Number.isSafeInteger(p.remainingCents) || p.remainingCents < 0)
    throw new Error("envelope balance must be a non-negative integer");
  if (p.remainingCents === 0) return null;
  if (p.envelopeAccountId === p.checkingAccountId)
    throw new Error("cannot sweep an envelope into itself");
  return txn(
    "envelope_sweep",
    [
      dr("customer_deposits", p.remainingCents, p.envelopeAccountId),
      cr("customer_deposits", p.remainingCents, p.checkingAccountId),
    ],
    p.transferId,
  );
}
