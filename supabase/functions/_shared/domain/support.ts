// Customer-support cases. A customer opens a case; support agents (staff) work it from a shared
// queue. A case carries the customer's contact snapshot (first name, last name, email) and, at
// read time, the customer's join date and total Harbor balance. Many agents can be assigned to
// one case. Status moves Pending -> In Review -> Finalized (and can be reopened).

export type SupportCaseStatus = "pending" | "in_review" | "finalized";

export const SUPPORT_CASE_STATUSES: SupportCaseStatus[] = ["pending", "in_review", "finalized"];

const CASE_TRANSITIONS: Record<SupportCaseStatus, SupportCaseStatus[]> = {
  pending: ["in_review"],
  in_review: ["finalized", "pending"],
  finalized: ["in_review"], // a finalized case can be reopened for review
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SupportCaseInput {
  firstName: string;
  lastName: string;
  email: string;
  subject: string;
  body?: string;
}

export interface SupportCase {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  subject: string;
  body: string;
  status: SupportCaseStatus;
}

export function validateSupportCase(input: SupportCaseInput): string[] {
  const e: string[] = [];
  if (!input.firstName || !input.firstName.trim()) e.push("firstName is required");
  if (!input.lastName || !input.lastName.trim()) e.push("lastName is required");
  if (!input.email || !EMAIL_RE.test(input.email.trim())) e.push("a valid email is required");
  if (!input.subject || !input.subject.trim()) e.push("subject is required");
  return e;
}

export function newSupportCase(p: {
  id: string;
  userId: string;
  input: SupportCaseInput;
}): SupportCase {
  const errs = validateSupportCase(p.input);
  if (errs.length) throw new Error(errs.join("; "));
  return {
    id: p.id,
    userId: p.userId,
    firstName: p.input.firstName.trim(),
    lastName: p.input.lastName.trim(),
    email: p.input.email.trim().toLowerCase(),
    subject: p.input.subject.trim(),
    body: (p.input.body ?? "").trim(),
    status: "pending",
  };
}

export function isSupportCaseStatus(x: unknown): x is SupportCaseStatus {
  return typeof x === "string" && (SUPPORT_CASE_STATUSES as string[]).includes(x);
}

export function canTransitionCase(from: SupportCaseStatus, to: SupportCaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

/** Validate a requested status change, or throw with a clear reason. Pure. */
export function transitionCase(from: SupportCaseStatus, to: SupportCaseStatus): SupportCaseStatus {
  if (from === to) throw new Error(`case is already ${to}`);
  if (!canTransitionCase(from, to)) throw new Error(`case cannot go from ${from} to ${to}`);
  return to;
}
