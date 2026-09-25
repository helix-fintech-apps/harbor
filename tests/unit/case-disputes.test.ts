import {
  validateCaseDispute,
  planCaseDispute,
  type CaseDisputeInput,
} from "../../supabase/functions/_shared/domain/index.ts";

const input = (over: Partial<CaseDisputeInput> = {}): CaseDisputeInput => ({
  caseId: "case-1",
  authorizationId: "auth-1",
  reason: "Customer says the charge was not authorized",
  ...over,
});

describe("case dispute validation", () => {
  it("accepts a well-formed request", () => {
    expect(validateCaseDispute(input())).toEqual([]);
  });
  it("requires caseId, authorizationId and a reason", () => {
    expect(validateCaseDispute(input({ caseId: " " }))).toContain("caseId is required");
    expect(validateCaseDispute(input({ authorizationId: "" }))).toContain(
      "authorizationId is required",
    );
    expect(validateCaseDispute(input({ reason: "   " }))).toContain("a dispute reason is required");
  });
});

describe("planCaseDispute", () => {
  it("refunds the full unrefunded posted amount", () => {
    const plan = planCaseDispute({
      input: input(),
      capturedCents: 5000,
      refundedCents: 0,
      status: "captured",
    });
    expect(plan.amountCents).toBe(5000);
    expect(plan.reason).toBe("Customer says the charge was not authorized");
  });

  it("nets out amounts already refunded", () => {
    const plan = planCaseDispute({
      input: input(),
      capturedCents: 5000,
      refundedCents: 1500,
      status: "captured",
    });
    expect(plan.amountCents).toBe(3500);
  });

  it("rejects transactions that are not captured", () => {
    expect(() =>
      planCaseDispute({
        input: input(),
        capturedCents: 5000,
        refundedCents: 0,
        status: "authorized",
      }),
    ).toThrow(/captured/);
  });

  it("rejects a fully refunded transaction", () => {
    expect(() =>
      planCaseDispute({
        input: input(),
        capturedCents: 5000,
        refundedCents: 5000,
        status: "captured",
      }),
    ).toThrow(/nothing left to refund/);
  });

  it("trims the reason", () => {
    const plan = planCaseDispute({
      input: input({ reason: "  duplicate charge  " }),
      capturedCents: 2000,
      refundedCents: 0,
      status: "captured",
    });
    expect(plan.reason).toBe("duplicate charge");
  });
});
