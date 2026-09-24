import { assertNoLiveKeys, usePlaid, useStripe, type Env } from "./env.ts";
import { FakeIdentity, StripeIdentity, type IdentityProvider } from "./identity.ts";
import { FakeBankLink, PlaidSandbox, type BankLinkProvider } from "./bank.ts";
import { FakeIssuer, StripeIssuing, type CardIssuer } from "./issuer.ts";

export * from "./env.ts";
export * from "./identity.ts";
export * from "./bank.ts";
export * from "./issuer.ts";

export interface Providers {
  identity: IdentityProvider;
  bank: BankLinkProvider;
  issuer: CardIssuer;
  mode: "fake" | "test";
}

export function selectProviders(env: Env): Providers {
  assertNoLiveKeys(env);
  const stripe = useStripe(env);
  const plaid = usePlaid(env);
  return {
    identity: stripe ? new StripeIdentity(env) : new FakeIdentity(),
    issuer: stripe ? new StripeIssuing(env) : new FakeIssuer(),
    bank: plaid ? new PlaidSandbox(env) : new FakeBankLink(),
    mode: stripe || plaid ? "test" : "fake",
  };
}

export function fakeProviders(): Providers {
  return {
    identity: new FakeIdentity(),
    bank: new FakeBankLink(),
    issuer: new FakeIssuer(),
    mode: "fake",
  };
}
