// Family cards: spouse / teen members get a sub-card on the owner's account.
// Spouse spends from the owner's checking within limits. Teens spend only from an allowance
// pocket topped up by the owner, and a teen card needs the owner's (guardian's) approval.

import type { MoneyPolicy } from "./config.ts";
import { mccGroup } from "./config.ts";
import { startOfUtcDay, startOfUtcMonth } from "./time.ts";
import type { UsageEvent } from "./limits.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";

export type MemberKind = "spouse" | "teen";
export type MemberStatus = "pending_guardian_approval" | "active" | "paused" | "removed";

export interface SpendLimits { perTxnCents: number; dailyCents: number; monthlyCents: number }

export interface FamilyMember {
  id: string;
  ownerUserId: string;
  name: string;
  kind: MemberKind;
  status: MemberStatus;
  limits: SpendLimits;
  blockedMccGroups: string[];
  blockedMccs: string[];
}

export const DEFAULT_TEEN_BLOCKS = ["gambling", "alcohol", "tobacco", "adult"];

export function validateLimits(l: SpendLimits): string[] {
  const e: string[] = [];
  for (const [k, v] of Object.entries(l)) if (!Number.isSafeInteger(v) || v < 0) e.push(`${k} must be non-negative cents`);
  if (l.perTxnCents > l.dailyCents) e.push("perTxn cannot exceed daily");
  if (l.dailyCents > l.monthlyCents) e.push("daily cannot exceed monthly");
  return e;
}

export function newFamilyMember(p: { id: string; ownerUserId: string; name: string; kind: MemberKind; limits: SpendLimits; blockedMccGroups?: string[]; existingCount: number }, policy: MoneyPolicy): FamilyMember {
  if (p.existingCount >= policy.family.maxMembers) throw new Error("family member limit reached");
  const errs = validateLimits(p.limits);
  if (errs.length) throw new Error(errs.join("; "));
  const teen = p.kind === "teen";
  const blocks = new Set([...(p.blockedMccGroups ?? []), ...(teen ? DEFAULT_TEEN_BLOCKS : [])]);
  return {
    id: p.id, ownerUserId: p.ownerUserId, name: p.name, kind: p.kind,
    status: teen && policy.family.teenRequiresGuardianApproval ? "pending_guardian_approval" : "active",
    limits: p.limits, blockedMccGroups: [...blocks], blockedMccs: [],
  };
}

/** Only the owner (guardian) can approve a teen member. */
export function guardianApprove(m: FamilyMember, approverUserId: string): FamilyMember {
  if (m.status !== "pending_guardian_approval") throw new Error("member is not awaiting approval");
  if (approverUserId !== m.ownerUserId) throw new Error("only the guardian (account owner) can approve");
  return { ...m, status: "active" };
}

export function isMccBlocked(m: FamilyMember, mcc: string): boolean {
  if (m.blockedMccs.includes(mcc)) return true;
  const g = mccGroup(mcc);
  return g !== undefined && m.blockedMccGroups.includes(g);
}

export function checkFamilySpend(m: FamilyMember, mcc: string, amountCents: number, spend: UsageEvent[], now: Date):
  { ok: true; reason?: undefined } | { ok: false; reason: "member_inactive" | "mcc_blocked" | "per_txn_limit" | "member_daily_limit" | "member_monthly_limit" } {
  if (m.status !== "active") return { ok: false, reason: "member_inactive" };
  if (isMccBlocked(m, mcc)) return { ok: false, reason: "mcc_blocked" };
  if (amountCents > m.limits.perTxnCents) return { ok: false, reason: "per_txn_limit" };
  const day = startOfUtcDay(now).getTime(), month = startOfUtcMonth(now).getTime();
  let today = 0, mon = 0;
  for (const e of spend) {
    if (e.kind !== "card_spend") continue;
    const t = e.at.getTime();
    if (t >= month && t <= now.getTime()) mon += e.amountCents;
    if (t >= day && t <= now.getTime()) today += e.amountCents;
  }
  if (today + amountCents > m.limits.dailyCents) return { ok: false, reason: "member_daily_limit" };
  if (mon + amountCents > m.limits.monthlyCents) return { ok: false, reason: "member_monthly_limit" };
  return { ok: true };
}

/** Owner tops up a teen's allowance pocket from checking. */
export function planAllowanceTopUp(p: { id: string; ownerAccountId: string; member: FamilyMember; amountCents: number; ownerAvailableCents: number }): Txn {
  if (p.member.kind !== "teen") throw new Error("allowance is for teen members");
  if (p.member.status === "removed") throw new Error("member removed");
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error("amount must be positive cents");
  if (p.amountCents > p.ownerAvailableCents) throw new Error("insufficient funds");
  return txn("allowance_topup", [dr("customer_deposits", p.amountCents, p.ownerAccountId), cr("family_allowance", p.amountCents, p.member.id)], p.id);
}
