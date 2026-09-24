// Account closure. Blocked while holds are pending, the balance is negative, a dispute is open,
// or a legal/sanctions freeze is in place (payout blocked). Otherwise all cards are canceled and
// the remaining balance (all pockets) is paid out to the linked bank.

import type { KycState } from "./kyc.ts";
import { canPayout } from "./kyc.ts";
import type { LinkedBank } from "./achIn.ts";
import { cr, dr, txn, type Txn } from "./ledger.ts";
import type { Card } from "./cards.ts";

export type ClosureBlock = "pending_holds" | "negative_balance" | "open_disputes" | "payout_blocked" | "no_linked_bank" | "already_closed";

export interface ClosureInput {
  kyc: KycState;
  accountStatus: string;
  pockets: { accountId: string; postedCents: number }[];
  activeHoldsCents: number;
  openDisputes: number;
  linkedBank: LinkedBank | null;
  cards: Card[];
  allowancePockets?: { memberId: string; postedCents: number }[];
}

export function closureBlocks(c: ClosureInput): ClosureBlock[] {
  const b: ClosureBlock[] = [];
  if (c.accountStatus === "closed") b.push("already_closed");
  if (c.activeHoldsCents > 0) b.push("pending_holds");
  const total = c.pockets.reduce((a, p) => a + p.postedCents, 0) + (c.allowancePockets ?? []).reduce((a, p) => a + p.postedCents, 0);
  if (c.pockets.some((p) => p.postedCents < 0) || total < 0) b.push("negative_balance");
  if (c.openDisputes > 0) b.push("open_disputes");
  if (!canPayout(c.kyc)) b.push("payout_blocked");
  if (total > 0 && (!c.linkedBank || c.linkedBank.status !== "active" || !c.linkedBank.nameMatched)) b.push("no_linked_bank");
  return b;
}

export interface ClosurePlan { cardsToCancel: string[]; payoutCents: number; ledger?: Txn }

export function planClosure(c: ClosureInput, closureId: string): ClosurePlan {
  const blocks = closureBlocks(c);
  if (blocks.length) throw new Error(`closure blocked: ${blocks.join(", ")}`);
  const lines = [
    ...c.pockets.filter((p) => p.postedCents > 0).map((p) => dr("customer_deposits", p.postedCents, p.accountId)),
    ...(c.allowancePockets ?? []).filter((p) => p.postedCents > 0).map((p) => dr("family_allowance", p.postedCents, p.memberId)),
  ];
  const payoutCents = lines.reduce((a, l) => a + l.debit, 0);
  return {
    cardsToCancel: c.cards.filter((x) => x.status !== "canceled" && x.status !== "replaced").map((x) => x.id),
    payoutCents,
    ledger: payoutCents > 0 ? txn("closure_payout", [...lines, cr("closure_payout", payoutCents)], closureId) : undefined,
  };
}
