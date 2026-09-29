// Households group an owner with invited family members. Each member can be given their own
// account and/or a card on a shared account. The household carries an optional overall monthly
// card-spend cap enforced across every member and card (see cards.ts authorize()).

import type { MoneyPolicy } from "./config.ts";

export type HouseholdMemberStatus = "invited" | "active" | "removed";

export interface HouseholdInvite {
  name: string;
  email: string;
  relationship?: string; // free text, e.g. "spouse", "teen", "parent"
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateHouseholdName(name: string): string[] {
  return name && name.trim().length > 0 ? [] : ["household name is required"];
}

/** A monthly cap, when set, must be a positive integer number of cents. null clears it. */
export function validateMonthlyCap(capCents: number | null | undefined): string[] {
  if (capCents === null || capCents === undefined) return [];
  if (!Number.isSafeInteger(capCents) || capCents <= 0)
    return ["monthly cap must be a positive integer number of cents"];
  return [];
}

export function validateInvite(
  invite: HouseholdInvite,
  currentMemberCount: number,
  policy: MoneyPolicy,
): string[] {
  const e: string[] = [];
  if (!invite.name || !invite.name.trim()) e.push("member name is required");
  if (!invite.email || !EMAIL_RE.test(invite.email)) e.push("a valid member email is required");
  if (currentMemberCount >= policy.household.maxMembers)
    e.push(`a household can have at most ${policy.household.maxMembers} members`);
  return e;
}

/** Accepting an invite: only an `invited` member can move to `active`, by the invited user. */
export function acceptInvite(status: HouseholdMemberStatus): HouseholdMemberStatus {
  if (status !== "invited") throw new Error(`invite is ${status}, not invited`);
  return "active";
}
