// Provider selection. Real vendors are used ONLY in test/sandbox mode; live keys are refused.
export type Env = Record<string, string | undefined>;

export class LiveKeyRefused extends Error {}

export function assertNoLiveKeys(env: Env): void {
  if (
    env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ||
    env.STRIPE_SECRET_KEY?.startsWith("rk_live_")
  ) {
    throw new LiveKeyRefused(
      "Refusing to run with a live Stripe key. Harbor is a test subject: use sk_test_ keys only.",
    );
  }
  if (env.PLAID_ENV && env.PLAID_ENV !== "sandbox") {
    throw new LiveKeyRefused(
      `Refusing PLAID_ENV=${env.PLAID_ENV}. Only the Plaid sandbox is allowed.`,
    );
  }
}

export function useStripe(env: Env): boolean {
  assertNoLiveKeys(env);
  return !!env.STRIPE_SECRET_KEY?.startsWith("sk_test_") && env.HARBOR_FORCE_FAKE !== "1";
}

export function usePlaid(env: Env): boolean {
  assertNoLiveKeys(env);
  return !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET && env.HARBOR_FORCE_FAKE !== "1";
}

export async function stripeRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
): Promise<any> {
  if (!useStripe(env)) throw new Error("stripe not configured (test key required)");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`stripe ${path}: ${json?.error?.message ?? res.status}`);
  return json;
}
