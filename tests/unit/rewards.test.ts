import { describe, it, expect } from "vitest";
import {
  cashbackForSpend,
  DEFAULT_BTC_REWARDS as R,
  usdCentsToSats,
  satsToUsdCents,
  planBtcConversion,
  SATS_PER_BTC,
  assertRewardsPolicy,
} from "../../supabase/functions/_shared/domain/index.ts";

const $ = (dollars: number) => Math.round(dollars * 100); // dollars -> cents

describe("cashbackForSpend — marginal brackets", () => {
  it("a spend wholly inside the first band earns 2%", () => {
    const r = cashbackForSpend(0, $(1_000), R);
    expect(r.rewardUsdCents).toBe($(20)); // 2% of $1,000
    expect(r.eligibleSpendCents).toBe($(1_000));
    expect(r.newEligibleCents).toBe($(1_000));
  });

  it("a single spend spanning bands is priced marginally, not at the top rate", () => {
    // $0 -> $25,000: first $20k @2% = $400, next $5k @3% = $150 => $550
    const r = cashbackForSpend(0, $(25_000), R);
    expect(r.rewardUsdCents).toBe($(550));
    expect(r.newEligibleCents).toBe($(25_000));
  });

  it("crossing a band does not retroactively re-rate earlier spend", () => {
    // Already spent $20k (all first band). Next $10k is entirely the 3% band.
    const r = cashbackForSpend($(20_000), $(10_000), R);
    expect(r.rewardUsdCents).toBe($(300)); // 3% of $10k only
    expect(r.newEligibleCents).toBe($(30_000));
  });

  it("earning the whole ladder $0 -> $50k totals $1,600", () => {
    // 2%*20k + 3%*10k + 4%*10k + 5%*10k = 400+300+400+500
    const r = cashbackForSpend(0, $(50_000), R);
    expect(r.rewardUsdCents).toBe($(1_600));
    expect(r.newEligibleCents).toBe($(50_000));
  });

  it("INVARIANT: no reward is earned on spend above the $50k cap", () => {
    const atCap = cashbackForSpend($(50_000), $(5_000), R);
    expect(atCap.rewardUsdCents).toBe(0);
    expect(atCap.eligibleSpendCents).toBe(0);
    expect(atCap.newEligibleCents).toBe($(50_000));

    // A spend straddling the cap only earns on the eligible slice.
    const straddle = cashbackForSpend($(48_000), $(5_000), R);
    expect(straddle.eligibleSpendCents).toBe($(2_000)); // only $2k fits under the cap
    expect(straddle.rewardUsdCents).toBe($(100)); // 5% of $2k
    expect(straddle.newEligibleCents).toBe($(50_000));
  });

  it("INVARIANT: summing per-transaction rewards equals one combined spend", () => {
    const combined = cashbackForSpend(0, $(35_000), R).rewardUsdCents;
    let prior = 0;
    let total = 0;
    for (const amt of [$(9_000), $(9_000), $(9_000), $(8_000)]) {
      const r = cashbackForSpend(prior, amt, R);
      total += r.rewardUsdCents;
      prior = r.newEligibleCents;
    }
    expect(total).toBe(combined);
  });

  it("earns nothing when the program is disabled", () => {
    const r = cashbackForSpend(0, $(1_000), { ...R, enabled: false });
    expect(r.rewardUsdCents).toBe(0);
    expect(r.newEligibleCents).toBe(0);
  });

  it("rejects non-positive or non-integer spend", () => {
    expect(() => cashbackForSpend(0, 0, R)).toThrow();
    expect(() => cashbackForSpend(0, -100, R)).toThrow();
    expect(() => cashbackForSpend(0, 12.5, R)).toThrow();
    expect(() => cashbackForSpend(-1, 100, R)).toThrow();
  });

  it("the default policy is well-formed (last band ends at the cap)", () => {
    expect(() => assertRewardsPolicy(R)).not.toThrow();
    expect(() => assertRewardsPolicy({ ...R, capCents: $(60_000) })).toThrow();
  });
});

describe("sat <-> USD conversion — floors toward Harbor", () => {
  const PRICE = 6_000_000; // $60,000 / BTC in cents

  it("converts a whole-dollar amount exactly at a round price", () => {
    // $600 at $60,000/BTC = 0.01 BTC = 1,000,000 sats
    expect(usdCentsToSats($(600), PRICE)).toBe(1_000_000);
    expect(satsToUsdCents(1_000_000, PRICE)).toBe($(600));
  });

  it("INVARIANT: usd->sats floors (member never over-credited)", () => {
    // $0.01 at $60,000 = 16.66.. sats -> floor 16
    expect(usdCentsToSats(1, PRICE)).toBe(16);
  });

  it("INVARIANT: round-tripping never inflates value", () => {
    for (const cents of [1, 7, 99, 12_345, $(1_400)]) {
      const sats = usdCentsToSats(cents, PRICE);
      const back = satsToUsdCents(sats, PRICE);
      expect(back).toBeLessThanOrEqual(cents);
    }
  });

  it("one full BTC of sats is worth exactly the price", () => {
    expect(satsToUsdCents(SATS_PER_BTC, PRICE)).toBe(PRICE);
  });

  it("rejects a non-positive price", () => {
    expect(() => usdCentsToSats(100, 0)).toThrow();
    expect(() => satsToUsdCents(100, -1)).toThrow();
  });
});

describe("planBtcConversion — cannot spend BTC, only realise it", () => {
  const PRICE = 6_000_000;

  it("converts a valid request and debits exactly what was asked", () => {
    const c = planBtcConversion(1_000_000, 500_000, PRICE);
    expect(c.satsDebited).toBe(500_000);
    expect(c.usdCents).toBe($(300)); // 500k sats = 0.005 BTC = $300
    expect(c.remainingSats).toBe(500_000);
  });

  it("INVARIANT: cannot convert more sats than held", () => {
    expect(() => planBtcConversion(100_000, 100_001, PRICE)).toThrow(/insufficient/);
  });

  it("INVARIANT: rejects a request whose floored value is $0 (no sats burned for nothing)", () => {
    // 10 sats at $60,000 = $0.006 -> floors to 0 cents
    expect(() => planBtcConversion(1_000_000, 10, PRICE)).toThrow(/below_one_cent/);
  });

  it("rejects non-positive requests", () => {
    expect(() => planBtcConversion(1_000_000, 0, PRICE)).toThrow();
    expect(() => planBtcConversion(1_000_000, -5, PRICE)).toThrow();
  });
});
