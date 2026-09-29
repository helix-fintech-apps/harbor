// Shared households: an owner invites family members into a household. Each member is a Harbor
// user who can be given their own account and/or a card on one of the household's shared accounts.
// The household also carries an overall monthly card-spend cap across every member and card.

import type { MoneyPolicy } from "./config.ts";

export type HouseholdMemberStatus = "invited" | "active" | "removed";

export interface Household {
  id: string;
  ownerUserId: string;
  name: string;
  monthlyCapCents: number | null; // null = no overall cap
}

export interface HouseholdMember {
  id: string;
  householdId: string;
  userId: string | null; // resolved once the invitee is a known Harbor user
  email: string;
  status: HouseholdMemberStatus;
  isOwner: boolean;
}

export function validateHouseholdName(name: string): string[] {
  const e: string[] = [];
  if (!name || !name.trim()) e.push("household name is required");
  if (name && name.length > 80) e.push("household name is too long");
  return e;
}

/** An overall monthly cap must be a non-negative integer, or null for "no cap". */
export function validateMonthlyCap(capCents: number | null): string[] {
  if (capCents === null) return [];
  if (!Number.isSafeInteger(capCents) || capCents < 0)
    return ["monthly cap must be a non-negative integer of cents, or null"];
  return [];
}

/** Whether another member can still be added (the owner counts toward the limit). */
export function canAddMember(activeOrInvitedCount: number, policy: MoneyPolicy): boolean {
  return activeOrInvitedCount < policy.household.maxMembers;
}

export function canInvite(p: {
  activeOrInvitedCount: number;
  alreadyMember: boolean;
  invitingSelf: boolean;
  policy: MoneyPolicy;
}): { ok: true } | { ok: false; reason: string } {
  if (p.invitingSelf) return { ok: false, reason: "you are already in this household" };
  if (p.alreadyMember) return { ok: false, reason: "that person is already in this household" };
  if (!canAddMember(p.activeOrInvitedCount, p.policy))
    return { ok: false, reason: "household member limit reached" };
  return { ok: true };
}

/** An invited member accepts (only their own invitation, only while it is still pending). */
export function acceptInvite(m: HouseholdMember, userId: string): HouseholdMember {
  if (m.status !== "invited") throw new Error("this invitation is not pending");
  if (m.userId !== userId) throw new Error("only the invited member can accept");
  return { ...m, status: "active" };
}

/**
 * Household overall monthly cap check. `currentSpendCents` is the household's card spend so far this
 * calendar month; the cap is inclusive (spending exactly up to it is allowed). No cap => always ok.
 */
export function withinHouseholdCap(
  capCents: number | null,
  currentSpendCents: number,
  proposedCents: number,
): boolean {
  if (capCents === null) return true;
  return currentSpendCents + proposedCents <= capCents;
}
