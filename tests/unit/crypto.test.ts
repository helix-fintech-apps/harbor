import { describe, it, expect } from "vitest";
import { earnBtcCashback, convertBtcToUsd, sendBtcOut } from "../../supabase/functions/_shared/domain/crypto.ts";

describe("btc cashback", () => {
  it("earns integer sats on a purchase", () => {
    // $100 spend, 1% cashback, $60,000/BTC -> $1 -> 1666 sats
    expect(earnBtcCashback(10_000, 100, 6_000_000)).toBe(1666);
  });
  it("converts sats to usd cents", () => {
    expect(convertBtcToUsd(1666, 6_000_000)).toBe(99);
  });
  it("sends btc out and debits the balance", () => {
    const acct = { accountId: "a1", balanceSats: 5000 };
    expect(sendBtcOut(acct, 2000, "bc1qexampleaddr").balanceSats).toBe(3000);
  });
});
