// Agent-initiated disputes raised from a support case. A support agent working a case can pull up
// a posted (captured) card transaction and mark it disputed; marking it disputed kicks off the
// refund process so the customer is made whole without waiting on the investigation.
//
// A case dispute links three things: the support case it was raised from, the dispute record, and
// the merchant refund that was issued to return the money.

export interface CaseDisputeInput {
  caseId: string;
  authorizationId: string;
  reason: string;
}

export interface CaseDisputePlan {
  amountCents: number;
  reason: string;
}

/** Validate an agent's request to dispute a case transaction. Pure. */
export function validateCaseDispute(input: CaseDisputeInput): string[] {
  const e: string[] = [];
  if (!input.caseId || !input.caseId.trim()) e.push("caseId is required");
  if (!input.authorizationId || !input.authorizationId.trim())
    e.push("authorizationId is required");
  if (!input.reason || !input.reason.trim()) e.push("a dispute reason is required");
  return e;
}

/**
 * Work out how much to refund when an agent disputes a transaction: the full posted amount that
 * has not already been refunded.
 */
export function planCaseDispute(p: {
  input: CaseDisputeInput;
  capturedCents: number;
  refundedCents: number;
  status: string;
}): CaseDisputePlan {
  const errs = validateCaseDispute(p.input);
  if (errs.length) throw new Error(errs.join("; "));
  if (p.status !== "captured") throw new Error("only posted (captured) purchases can be disputed");
  const amountCents = p.capturedCents - p.refundedCents;
  if (amountCents <= 0) throw new Error("transaction has nothing left to refund");
  return { amountCents, reason: p.input.reason.trim() };
}
