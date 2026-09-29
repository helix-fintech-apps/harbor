// Accounts (checking + savings pockets), fake account/routing numbers, and balances.
// Posted balance = ledger (credits - debits). Available = posted - active holds.

import type { Line, Txn } from "./ledger.ts";
import { cr, dr, partyBalance, txn } from "./ledger.ts";

export type AccountKind = "checking" | "savings" | "envelope";
export type AccountStatus = "open" | "frozen" | "closing" | "closed";

/**
 * A temporary "envelope" account earmarks money for a purpose between a start and an end date.
 * When it reaches its end date it auto-closes and any remaining balance sweeps into the user's
 * primary checking account. Envelopes are never a user's primary pocket.
 */
export interface OpenAccountRequest {
  kind: AccountKind;
  nickname?: string;
  startDate?: string; // YYYY-MM-DD, envelope only
  endDate?: string; // YYYY-MM-DD, envelope only
}

/** ISO date (YYYY-MM-DD) validity: a real calendar date, no time component. */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Validate an open-account request. Returns the list of problems (empty = ok). */
export function validateOpenAccount(r: OpenAccountRequest): string[] {
  const e: string[] = [];
  if (r.kind !== "checking" && r.kind !== "savings" && r.kind !== "envelope")
    e.push("kind must be checking, savings or envelope");
  if (r.kind === "envelope") {
    if (!r.startDate || !isValidIsoDate(r.startDate)) e.push("envelope needs a valid start date");
    if (!r.endDate || !isValidIsoDate(r.endDate)) e.push("envelope needs a valid end date");
    if (r.startDate && r.endDate && isValidIsoDate(r.startDate) && isValidIsoDate(r.endDate)) {
      if (r.endDate <= r.startDate) e.push("envelope end date must be after the start date");
    }
  } else if (r.startDate || r.endDate) {
    e.push("only envelope accounts have a start and end date");
  }
  return e;
}

/** An envelope has reached its end date (auto-close boundary) at `now` (end date is inclusive; it closes at end-of-day UTC). */
export function envelopeExpired(endDate: string | null | undefined, now: Date): boolean {
  if (!endDate) return false;
  return now.getTime() >= new Date(`${endDate}T00:00:00Z`).getTime() + 86_400_000;
}

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

/**
 * Sweep an envelope's remaining balance into the primary checking account (the auto-close step).
 * A positive balance moves to checking; a zero balance sweeps nothing. A negative envelope
 * balance is a bug and is refused so closure never hides a shortfall.
 */
export function planEnvelopeSweep(p: {
  sweepId: string;
  envelopeAccountId: string;
  checkingAccountId: string;
  postedCents: number;
}): { payoutCents: number; ledger?: Txn } {
  if (!Number.isSafeInteger(p.postedCents))
    throw new Error("envelope balance must be integer cents");
  if (p.postedCents < 0) throw new Error("envelope balance is negative");
  if (p.envelopeAccountId === p.checkingAccountId)
    throw new Error("envelope and checking must differ");
  if (p.postedCents === 0) return { payoutCents: 0 };
  return {
    payoutCents: p.postedCents,
    ledger: txn(
      "envelope_sweep",
      [
        dr("customer_deposits", p.postedCents, p.envelopeAccountId),
        cr("customer_deposits", p.postedCents, p.checkingAccountId),
      ],
      p.sweepId,
    ),
  };
}
