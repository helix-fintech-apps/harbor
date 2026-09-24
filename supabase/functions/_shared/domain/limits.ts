// Tier limits (daily / monthly) for transfers out and card spend. Boundaries are inclusive:
// spending exactly up to the limit is allowed; one cent over is declined.

import type { MoneyPolicy, Tier } from "./config.ts";
import { startOfUtcDay, startOfUtcMonth } from "./time.ts";

export type LimitKind = "transfer_out" | "card_spend" | "ach_in";

export interface UsageEvent { at: Date; amountCents: number; kind: LimitKind }

export interface LimitCheck { ok: boolean; reason?: "daily_limit" | "monthly_limit"; remainingDaily: number; remainingMonthly: number }

export function usage(events: UsageEvent[], kind: LimitKind, now: Date): { today: number; month: number } {
  const day = startOfUtcDay(now).getTime();
  const month = startOfUtcMonth(now).getTime();
  let today = 0, m = 0;
  for (const e of events) {
    if (e.kind !== kind) continue;
    const t = e.at.getTime();
    if (t > now.getTime()) continue;
    if (t >= month) m += e.amountCents;
    if (t >= day) today += e.amountCents;
  }
  return { today, month: m };
}

export function limitsFor(tier: Tier, kind: LimitKind, policy: MoneyPolicy): { daily: number; monthly: number } {
  const t = policy.tiers[tier];
  if (kind === "transfer_out") return { daily: t.dailyTransferOutCents, monthly: t.monthlyTransferOutCents };
  if (kind === "card_spend") return { daily: t.dailyCardSpendCents, monthly: t.monthlyCardSpendCents };
  return { daily: t.dailyAchInCents, monthly: Number.MAX_SAFE_INTEGER };
}

export function checkLimit(tier: Tier, kind: LimitKind, amountCents: number, events: UsageEvent[], now: Date, policy: MoneyPolicy): LimitCheck {
  const { daily, monthly } = limitsFor(tier, kind, policy);
  const u = usage(events, kind, now);
  const remainingDaily = Math.max(0, daily - u.today);
  const remainingMonthly = Math.max(0, monthly - u.month);
  if (amountCents > remainingDaily) return { ok: false, reason: "daily_limit", remainingDaily, remainingMonthly };
  if (amountCents > remainingMonthly) return { ok: false, reason: "monthly_limit", remainingDaily, remainingMonthly };
  return { ok: true, remainingDaily, remainingMonthly };
}

/** The window a limit check covered, so storage can re-check it atomically when it writes. */
export interface LimitWindow { kind: LimitKind; dailyCents: number; monthlyCents: number; dayStart: Date; monthStart: Date }

export function limitWindow(tier: Tier, kind: LimitKind, now: Date, policy: MoneyPolicy): LimitWindow {
  const { daily, monthly } = limitsFor(tier, kind, policy);
  return { kind, dailyCents: daily, monthlyCents: monthly, dayStart: startOfUtcDay(now), monthStart: startOfUtcMonth(now) };
}
