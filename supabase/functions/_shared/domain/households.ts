// Households: a shared family group with its own overall monthly card-spend cap that applies
// across every member and every card. Membership and invites are plain records; the only money
// rule here is the cap, which card authorization enforces on top of each card's and member's own
// limits. Month-to-date household spend is measured over the same card_spend usage events the
// tier limit uses, summed across all of the household's cards.

import { startOfUtcMonth } from "./time.ts";
import type { UsageEvent } from "./limits.ts";

export type HouseholdRole = "owner" | "member";
export type HouseholdMemberStatus = "invited" | "active" | "removed";

export function validateHouseholdName(name: string): string[] {
  return name && name.trim().length > 0 ? [] : ["household name is required"];
}

export function validateMonthlyCap(capCents: number | null | undefined): string[] {
  if (capCents == null) return [];
  if (!Number.isSafeInteger(capCents) || capCents < 0)
    return ["monthlyCapCents must be a non-negative integer"];
  return [];
}

/** Month-to-date card spend across a set of card_spend usage events (all household cards). */
export function householdMonthSpend(spend: UsageEvent[], now: Date): number {
  const month = startOfUtcMonth(now).getTime();
  let total = 0;
  for (const e of spend) {
    if (e.kind !== "card_spend") continue;
    const t = e.at.getTime();
    if (t >= month && t <= now.getTime()) total += e.amountCents;
  }
  return total;
}

/**
 * Would this spend keep the household within its monthly cap? Inclusive: spending exactly up to
 * the cap is allowed, one cent over is not. A null cap means no household limit.
 */
export function withinHouseholdCap(
  capCents: number | null | undefined,
  monthSpendCents: number,
  amountCents: number,
): boolean {
  if (capCents == null) return true;
  return monthSpendCents + amountCents <= capCents;
}
