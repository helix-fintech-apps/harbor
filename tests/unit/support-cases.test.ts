import {
  validateSupportCase,
  newSupportCase,
  canTransitionCase,
  transitionCase,
  isSupportCaseStatus,
  SUPPORT_CASE_STATUSES,
  type SupportCaseInput,
} from "../../supabase/functions/_shared/domain/index.ts";

const input = (over: Partial<SupportCaseInput> = {}): SupportCaseInput => ({
  firstName: "Dana",
  lastName: "Kim",
  email: "dana@example.com",
  subject: "Card declined at the pump",
  ...over,
});

describe("support case validation", () => {
  it("accepts a well-formed case", () => {
    expect(validateSupportCase(input())).toEqual([]);
  });
  it("requires first name, last name, email and subject", () => {
    expect(validateSupportCase(input({ firstName: " " }))).toContain("firstName is required");
    expect(validateSupportCase(input({ lastName: "" }))).toContain("lastName is required");
    expect(validateSupportCase(input({ email: "nope" }))).toContain("a valid email is required");
    expect(validateSupportCase(input({ subject: "  " }))).toContain("subject is required");
  });
  it("newSupportCase trims, lower-cases the email, and starts Pending", () => {
    const c = newSupportCase({
      id: "c1",
      userId: "u1",
      input: input({ email: "Dana@Example.com", firstName: "  Dana " }),
    });
    expect(c.status).toBe("pending");
    expect(c.email).toBe("dana@example.com");
    expect(c.firstName).toBe("Dana");
  });
  it("newSupportCase throws on invalid input", () => {
    expect(() =>
      newSupportCase({ id: "c1", userId: "u1", input: input({ email: "bad" }) }),
    ).toThrow();
  });
});

describe("support case status machine", () => {
  it("statuses are pending, in_review, finalized", () => {
    expect(SUPPORT_CASE_STATUSES).toEqual(["pending", "in_review", "finalized"]);
    expect(isSupportCaseStatus("in_review")).toBe(true);
    expect(isSupportCaseStatus("closed")).toBe(false);
  });
  it("pending -> in_review -> finalized, and finalized can reopen to in_review", () => {
    expect(canTransitionCase("pending", "in_review")).toBe(true);
    expect(canTransitionCase("in_review", "finalized")).toBe(true);
    expect(canTransitionCase("in_review", "pending")).toBe(true);
    expect(canTransitionCase("finalized", "in_review")).toBe(true);
  });
  it("rejects illegal jumps and no-op transitions", () => {
    expect(canTransitionCase("pending", "finalized")).toBe(false);
    expect(() => transitionCase("pending", "finalized")).toThrow();
    expect(() => transitionCase("pending", "pending")).toThrow();
    expect(() => transitionCase("finalized", "pending")).toThrow();
  });
  it("transitionCase returns the new status on a legal move", () => {
    expect(transitionCase("pending", "in_review")).toBe("in_review");
    expect(transitionCase("in_review", "finalized")).toBe("finalized");
  });
});
