import {
  roundUpCents,
  planRoundup,
  trialBalance,
  type Txn,
} from "../../supabase/functions/_shared/domain/index.ts";

const err = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("roundUpCents", () => {
  it("sweeps up to the next whole dollar (cents in, cents out)", () => {
    expect(roundUpCents(4237)).toBe(63); // $42.37 -> $43.00
    expect(roundUpCents(1)).toBe(99); // $0.01 -> $1.00
    expect(roundUpCents(99)).toBe(1); // $0.99 -> $1.00
    expect(roundUpCents(4201)).toBe(99); // $42.01 -> $43.00
    expect(roundUpCents(4299)).toBe(1); // $42.99 -> $43.00
  });

  it("sweeps 0 on a whole-dollar amount", () => {
    expect(roundUpCents(5000)).toBe(0); // $50.00
    expect(roundUpCents(0)).toBe(0);
    expect(roundUpCents(100)).toBe(0);
    expect(roundUpCents(4200)).toBe(0);
  });

  it("always lands in [0, 99]", () => {
    for (const a of [0, 1, 37, 50, 99, 100, 150, 4237, 999_999]) {
      const r = roundUpCents(a);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(99);
      expect((a + r) % 100).toBe(0); // reaches a whole dollar
    }
  });

  it("rejects non-integer or negative cents", () => {
    expect(err(() => roundUpCents(42.5))).toMatch(/integer/);
    expect(err(() => roundUpCents(-1))).toMatch(/integer/);
  });
});

describe("planRoundup", () => {
  const base = {
    id: "r1",
    checkingAccountId: "chk",
    memberSavingsId: "sav",
    availableCents: 100_000,
  };

  it("returns null when there is nothing to sweep (whole dollar)", () => {
    expect(planRoundup({ ...base, amountCents: 5000 })).toBeNull();
    expect(planRoundup({ ...base, amountCents: 0 })).toBeNull();
  });

  it("conserves total balance: debit checking == credit savings", () => {
    const t = planRoundup({ ...base, amountCents: 4237 }) as Txn;
    expect(t).not.toBeNull();
    expect(trialBalance(t.lines)).toBe(0); // debits - credits == 0
    const debit = t.lines.find((l) => l.debit > 0)!;
    const credit = t.lines.find((l) => l.credit > 0)!;
    expect(debit.debit).toBe(63);
    expect(credit.credit).toBe(63);
    expect(debit.party).toBe("chk");
    expect(credit.party).toBe("sav");
    expect(debit.account).toBe("customer_deposits");
    expect(credit.account).toBe("customer_deposits");
    expect(t.ref).toBe("r1");
  });

  it("throws when the round-up exceeds available funds", () => {
    expect(err(() => planRoundup({ ...base, amountCents: 1, availableCents: 50 }))).toMatch(
      /exceeds available/,
    );
    // 1c short: sweep is 99c, only 98c available
    expect(err(() => planRoundup({ ...base, amountCents: 1, availableCents: 98 }))).toMatch(
      /exceeds available/,
    );
  });

  it("allows a sweep that exactly uses available funds", () => {
    const t = planRoundup({ ...base, amountCents: 1, availableCents: 99 }) as Txn;
    expect(t.lines.find((l) => l.debit > 0)!.debit).toBe(99);
  });
});
