// Savings goals. A customer names a savings goal and funds it from checking.
// Pure domain: integer cents only, no I/O. Money movement is planned by the service via the ledger.

export interface Goal {
  id: string;
  userId: string;
  name: string;
  targetCents: number;
  savedCents: number;
}

/** Validate the fields of a new goal. Returns a list of error messages (empty when valid). */
export function validateGoal(input: { name: string; targetCents: number }): string[] {
  const errors: string[] = [];
  if (typeof input.name !== "string" || input.name.trim().length === 0)
    errors.push("name is required");
  if (!Number.isSafeInteger(input.targetCents) || input.targetCents <= 0)
    errors.push("targetCents must be a positive integer");
  return errors;
}

/** Build a new goal, throwing when the inputs are invalid. Goals always start at zero saved. */
export function newGoal(p: {
  id: string;
  userId: string;
  name: string;
  targetCents: number;
}): Goal {
  const errors = validateGoal({ name: p.name, targetCents: p.targetCents });
  if (errors.length) throw new Error(errors.join("; "));
  return { id: p.id, userId: p.userId, name: p.name, targetCents: p.targetCents, savedCents: 0 };
}

/**
 * Plan a contribution to a goal. The amount must be a positive integer and cannot exceed the
 * available checking balance. A goal MAY exceed its target — contributions are never capped.
 */
export function planContribution(p: { goal: Goal; amountCents: number; availableCents: number }): {
  newSaved: number;
} {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0)
    throw new Error("amountCents must be a positive integer");
  if (p.amountCents > p.availableCents) throw new Error("amount exceeds available balance");
  return { newSaved: p.goal.savedCents + p.amountCents };
}
