// Onboarding / KYC state machine. Only `approved` customers can move money or use cards.
// Vendor timeouts and unknown vendor statuses NEVER approve: they leave the customer pending.

import type { MoneyPolicy } from "./config.ts";

export type KycState =
  | "unverified" | "pending" | "needs_review" | "approved" | "rejected" | "suspended" | "frozen_legal";

export type IdentityOutcome =
  | { kind: "verified" }
  | { kind: "requires_input"; reason?: string }   // document unreadable, selfie mismatch, ...
  | { kind: "failed"; reason?: string }           // definitive failure (fraudulent document)
  | { kind: "processing" }
  | { kind: "timeout" }
  | { kind: "unknown"; raw: string };

/** Map a raw vendor status string (Stripe Identity / fake) to an outcome. Anything unrecognized is `unknown`. */
export function mapIdentityStatus(raw: string | null | undefined): IdentityOutcome {
  switch (raw) {
    case "verified": return { kind: "verified" };
    case "requires_input": return { kind: "requires_input" };
    case "processing": return { kind: "processing" };
    case "canceled":
    case "failed": return { kind: "failed", reason: raw };
    case "timeout": return { kind: "timeout" };
    default: return { kind: "unknown", raw: String(raw) };
  }
}

export type SanctionsOutcome =
  | { kind: "clear" }
  | { kind: "potential_match"; entry: string; scoreBps: number }
  | { kind: "confirmed_match"; entry: string }
  | { kind: "error" };

/** Fake sanctions list (test fixtures only — not real persons). */
export const FAKE_SANCTIONS_LIST = [
  "Ivan Blocked Testperson",
  "Maria Sanctioned Example",
  "Oleg Embargo",
  "Harbor Test Denied",
];

export function normalizeName(name: string): string[] {
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "mr", "mrs", "ms", "dr"]);
  return name
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/-/g, " ")
    .split(/\s+/).filter((t) => t.length > 0 && !suffixes.has(t));
}

/** Token-overlap score in basis points: |A ∩ B| / |smaller set|. */
export function nameOverlapBps(a: string, b: string): number {
  const A = new Set(normalizeName(a));
  const B = new Set(normalizeName(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return Math.floor((inter * 10_000) / Math.min(A.size, B.size));
}

export function screenSanctions(fullName: string, policy: MoneyPolicy, list: string[] = FAKE_SANCTIONS_LIST): SanctionsOutcome {
  const target = normalizeName(fullName).join(" ");
  let best: { entry: string; score: number } | null = null;
  for (const entry of list) {
    if (normalizeName(entry).join(" ") === target) return { kind: "confirmed_match", entry };
    const score = nameOverlapBps(fullName, entry);
    if (!best || score > best.score) best = { entry, score };
  }
  // Require at least two shared tokens' worth of overlap to avoid flagging every "Maria".
  if (best && best.score >= policy.kyc.sanctionsFuzzyThresholdBps && normalizeName(fullName).length >= 2) {
    return { kind: "potential_match", entry: best.entry, scoreBps: best.score };
  }
  return { kind: "clear" };
}

/** Decide the KYC state from identity + sanctions results. Approval requires BOTH to be definitive passes. */
export function decideKyc(identity: IdentityOutcome, sanctions: SanctionsOutcome | null): { state: KycState; reason: string } {
  if (sanctions?.kind === "confirmed_match") return { state: "frozen_legal", reason: `sanctions match: ${sanctions.entry}` };
  switch (identity.kind) {
    case "failed": return { state: "rejected", reason: `identity failed${identity.reason ? `: ${identity.reason}` : ""}` };
    case "requires_input": return { state: "needs_review", reason: "identity requires input" };
    case "processing": return { state: "pending", reason: "identity processing" };
    case "timeout": return { state: "pending", reason: "identity vendor timeout" };
    case "unknown": return { state: "pending", reason: `unknown identity status: ${identity.raw}` };
    case "verified": break;
  }
  if (sanctions === null || sanctions.kind === "error") return { state: "pending", reason: "sanctions screen not completed" };
  if (sanctions.kind === "potential_match") return { state: "needs_review", reason: `potential sanctions match: ${sanctions.entry}` };
  return { state: "approved", reason: "identity verified, sanctions clear" };
}

const TRANSITIONS: Record<KycState, KycState[]> = {
  unverified: ["pending", "needs_review", "approved", "rejected", "frozen_legal"],
  pending: ["pending", "needs_review", "approved", "rejected", "frozen_legal"],
  needs_review: ["approved", "rejected", "frozen_legal", "pending"],
  approved: ["suspended", "frozen_legal"],
  rejected: ["needs_review"],               // appeal re-opens a manual review only
  suspended: ["approved", "frozen_legal", "rejected"],
  frozen_legal: ["approved", "rejected"],   // only by admin after legal release
};

export function canTransitionKyc(from: KycState, to: KycState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionKyc(from: KycState, to: KycState): KycState {
  if (!canTransitionKyc(from, to)) throw new Error(`KYC: cannot go from ${from} to ${to}`);
  return to;
}

/** Manual approval from needs_review / suspended / frozen_legal requires staff. */
export function requiresStaff(from: KycState, to: KycState): boolean {
  return to === "approved" && from !== "unverified" && from !== "pending";
}

export function canMoveMoney(state: KycState): boolean {
  return state === "approved";
}

/** Can the customer receive incoming credits (ACH in, P2P)? Not while suspended/frozen/rejected. */
export function canReceive(state: KycState): boolean {
  return state === "approved";
}

/** Payouts (withdrawals, closure payouts) are blocked by a legal/sanctions freeze. */
export function canPayout(state: KycState): boolean {
  return state === "approved" || state === "suspended";
}

/** Race an identity vendor call against a timeout; a timeout yields {kind:"timeout"} — never approval. */
export async function withVendorTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ms); });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
