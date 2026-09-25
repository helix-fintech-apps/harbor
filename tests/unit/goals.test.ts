import {
  validateGoal,
  newGoal,
  planContribution,
  type Goal,
} from "../../supabase/functions/_shared/domain/index.ts";

describe("validateGoal", () => {
  it("accepts a well-formed goal", () => {
    expect(validateGoal({ name: "Vacation", targetCents: 100_000 })).toEqual([]);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(validateGoal({ name: "", targetCents: 5000 })).toContain("name is required");
    expect(validateGoal({ name: "   ", targetCents: 5000 })).toContain("name is required");
  });

  it("rejects a non-positive or non-integer target", () => {
    expect(validateGoal({ name: "Car", targetCents: 0 })).toContain(
      "targetCents must be a positive integer",
    );
    expect(validateGoal({ name: "Car", targetCents: -100 })).toContain(
      "targetCents must be a positive integer",
    );
    expect(validateGoal({ name: "Car", targetCents: 12.5 })).toContain(
      "targetCents must be a positive integer",
    );
  });
});

describe("newGoal", () => {
  it("starts with savedCents at 0", () => {
    const g = newGoal({ id: "g1", userId: "u1", name: "Emergency", targetCents: 250_000 });
    expect(g).toEqual({
      id: "g1",
      userId: "u1",
      name: "Emergency",
      targetCents: 250_000,
      savedCents: 0,
    });
  });

  it("throws when the inputs are invalid", () => {
    expect(() => newGoal({ id: "g2", userId: "u1", name: "", targetCents: 100 })).toThrow();
    expect(() => newGoal({ id: "g3", userId: "u1", name: "X", targetCents: 0 })).toThrow();
  });
});

describe("planContribution", () => {
  const goal: Goal = {
    id: "g1",
    userId: "u1",
    name: "Vacation",
    targetCents: 100_000,
    savedCents: 90_000,
  };

  it("adds the amount to savedCents", () => {
    expect(planContribution({ goal, amountCents: 5000, availableCents: 20_000 })).toEqual({
      newSaved: 95_000,
    });
  });

  it("rejects an amount greater than the available balance", () => {
    expect(() => planContribution({ goal, amountCents: 30_000, availableCents: 20_000 })).toThrow();
  });

  it("rejects a non-positive or non-integer amount", () => {
    expect(() => planContribution({ goal, amountCents: 0, availableCents: 20_000 })).toThrow();
    expect(() => planContribution({ goal, amountCents: -1, availableCents: 20_000 })).toThrow();
    expect(() => planContribution({ goal, amountCents: 1.5, availableCents: 20_000 })).toThrow();
  });

  it("allows a contribution that pushes savedCents past the target", () => {
    expect(planContribution({ goal, amountCents: 50_000, availableCents: 60_000 })).toEqual({
      newSaved: 140_000,
    });
  });
});
