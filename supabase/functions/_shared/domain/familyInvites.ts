// Family-card invitations. An account owner invites a family member by first name, last name,
// date of birth and email. The invitee accepts with a one-time token, which links their profile
// to a new family member and issues them a debit card. The card's start date is either immediate
// or a future date, and the card cannot authorize before it starts. Spouse cards spend from the
// owner's shared checking (so owner and member draw the same funds); teen cards spend from an
// allowance pocket — see family.ts and cards.ts.

import type { MoneyPolicy } from "./config.ts";
import { addDays, startOfUtcDay } from "./time.ts";
import type { MemberKind, SpendLimits } from "./family.ts";
import { validateLimits } from "./family.ts";

export type InviteStatus = "sent" | "accepted" | "expired" | "revoked";

/** How long an unaccepted invite stays valid, and how far ahead a card start date may be set. */
export const INVITE_TTL_DAYS = 14;
export const CARD_MAX_SCHEDULE_DAYS = 90;
export const MIN_MEMBER_AGE_YEARS = 13;
export const MAX_MEMBER_AGE_YEARS = 120;
export const SPOUSE_MIN_AGE_YEARS = 18;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteInput {
  firstName: string;
  lastName: string;
  dob: string; // ISO calendar date, YYYY-MM-DD
  email: string;
  kind: MemberKind;
  limits: SpendLimits;
  blockedMccGroups?: string[];
  cardKind: "virtual" | "physical";
  cardStartAt?: string; // ISO timestamp; omitted or "" = start immediately
}

export interface FamilyInvite {
  id: string;
  ownerUserId: string;
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  kind: MemberKind;
  limits: SpendLimits;
  blockedMccGroups: string[];
  cardKind: "virtual" | "physical";
  cardActivateAt?: Date; // undefined = card is usable immediately once issued
  token: string;
  status: InviteStatus;
  expiresAt: Date;
}

/** Whole years between an ISO date of birth and `now` (UTC). NaN if unparseable, -1 if in the future. */
export function ageYears(dobIso: string, now: Date): number {
  const dob = new Date(dobIso + "T00:00:00Z");
  if (Number.isNaN(dob.getTime())) return NaN;
  if (dob.getTime() > now.getTime()) return -1;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** A start date must be empty (immediate) or a real time that is not in the past and within the window. */
export function validateCardStartDate(startAt: string | undefined, now: Date): string[] {
  if (startAt === undefined || startAt === "") return [];
  const t = new Date(startAt);
  if (Number.isNaN(t.getTime())) return ["cardStartAt is not a valid date"];
  // Allow "today" regardless of the time-of-day: compare against the start of the current UTC day.
  if (t.getTime() < startOfUtcDay(now).getTime()) return ["cardStartAt cannot be in the past"];
  if (t.getTime() > addDays(now, CARD_MAX_SCHEDULE_DAYS).getTime())
    return [`cardStartAt cannot be more than ${CARD_MAX_SCHEDULE_DAYS} days ahead`];
  return [];
}

export function resolveStartAt(startAt: string | undefined): Date | undefined {
  return startAt ? new Date(startAt) : undefined;
}

export function validateInviteInput(input: InviteInput, now: Date): string[] {
  const e: string[] = [];
  if (!input.firstName || !input.firstName.trim()) e.push("firstName is required");
  if (!input.lastName || !input.lastName.trim()) e.push("lastName is required");
  if (!input.email || !EMAIL_RE.test(input.email.trim())) e.push("a valid email is required");
  if (input.kind !== "spouse" && input.kind !== "teen") e.push("kind must be spouse or teen");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dob ?? "")) {
    e.push("dob must be an ISO date (YYYY-MM-DD)");
  } else {
    const age = ageYears(input.dob, now);
    if (Number.isNaN(age) || age < 0) e.push("dob must be a valid date in the past");
    else if (age < MIN_MEMBER_AGE_YEARS)
      e.push(`member must be at least ${MIN_MEMBER_AGE_YEARS} years old`);
    else if (age > MAX_MEMBER_AGE_YEARS) e.push("dob is out of range");
    else if (input.kind === "spouse" && age < SPOUSE_MIN_AGE_YEARS)
      e.push(`a spouse member must be at least ${SPOUSE_MIN_AGE_YEARS}`);
  }
  e.push(...validateLimits(input.limits));
  if (input.cardKind !== "virtual" && input.cardKind !== "physical")
    e.push("cardKind must be virtual or physical");
  e.push(...validateCardStartDate(input.cardStartAt, now));
  return e;
}

export function newFamilyInvite(
  p: { id: string; ownerUserId: string; token: string; input: InviteInput },
  _policy: MoneyPolicy,
  now: Date,
): FamilyInvite {
  const errs = validateInviteInput(p.input, now);
  if (errs.length) throw new Error(errs.join("; "));
  return {
    id: p.id,
    ownerUserId: p.ownerUserId,
    firstName: p.input.firstName.trim(),
    lastName: p.input.lastName.trim(),
    dob: p.input.dob,
    email: p.input.email.trim().toLowerCase(),
    kind: p.input.kind,
    limits: p.input.limits,
    blockedMccGroups: p.input.blockedMccGroups ?? [],
    cardKind: p.input.cardKind,
    cardActivateAt: resolveStartAt(p.input.cardStartAt),
    token: p.token,
    status: "sent",
    expiresAt: addDays(now, INVITE_TTL_DAYS),
  };
}

/** Effective status: a `sent` invite past its expiry reads as `expired` without a write. */
export function inviteState(
  inv: { status: InviteStatus; expiresAt: Date },
  now: Date,
): InviteStatus {
  if (inv.status === "sent" && now.getTime() > inv.expiresAt.getTime()) return "expired";
  return inv.status;
}

export type AcceptError = "invite_not_pending" | "invite_expired";

export interface AcceptPlan {
  displayName: string; // "First Last" — becomes family_members.name
  kind: MemberKind;
  limits: SpendLimits;
  blockedMccGroups: string[];
  cardKind: "virtual" | "physical";
  cardActivateAt?: Date;
}

/** Validate a token acceptance and return what to create (a family member + a card). Pure. */
export function acceptInvite(
  inv: FamilyInvite,
  now: Date,
): { ok: true; plan: AcceptPlan } | { ok: false; reason: AcceptError } {
  const state = inviteState(inv, now);
  if (state === "expired") return { ok: false, reason: "invite_expired" };
  if (state !== "sent") return { ok: false, reason: "invite_not_pending" };
  return {
    ok: true,
    plan: {
      displayName: `${inv.firstName} ${inv.lastName}`.trim(),
      kind: inv.kind,
      limits: inv.limits,
      blockedMccGroups: inv.blockedMccGroups,
      cardKind: inv.cardKind,
      cardActivateAt: inv.cardActivateAt,
    },
  };
}
