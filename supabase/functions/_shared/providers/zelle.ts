// Zelle payment provider: fake + a sandbox "real" mode. Like the Stripe/Plaid providers, the
// sandbox mode talks to a test endpoint and refuses live credentials; the fake is deterministic and
// used in CI / demo / when no keys are set, so the whole flow runs without live Zelle access.
import type { Env } from "./env.ts";

export interface ZelleSendRequest {
  userId: string;
  recipient: string; // email or phone token
  amountCents: number;
  reference: string; // Harbor's payment id (idempotency handle)
}

export interface ZelleSendResult {
  providerPaymentId: string;
  status: "sent";
}

export interface ZelleProvider {
  name: "fake" | "zelle_sandbox";
  send(p: ZelleSendRequest): Promise<ZelleSendResult>;
}

/** Deterministic fake Zelle: no network, stable provider ids derived from the Harbor reference. */
export class FakeZelle implements ZelleProvider {
  name = "fake" as const;
  async send(p: ZelleSendRequest): Promise<ZelleSendResult> {
    return { providerPaymentId: `zl_fake_${p.reference}`, status: "sent" };
  }
}

/** Sandbox Zelle over REST (test only). Refuses to run against a production base URL. */
export class ZelleSandbox implements ZelleProvider {
  name = "zelle_sandbox" as const;
  constructor(private env: Env) {}
  private base(): string {
    const base = this.env.ZELLE_API_BASE ?? "https://sandbox.zelle.test";
    if (!/sandbox|test|localhost|127\.0\.0\.1/.test(base))
      throw new Error(`Refusing ZELLE_API_BASE=${base}: only the Zelle sandbox is allowed.`);
    return base;
  }
  async send(p: ZelleSendRequest): Promise<ZelleSendResult> {
    const res = await fetch(`${this.base()}/v1/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.ZELLE_API_KEY ?? ""}`,
        "Content-Type": "application/json",
        "Idempotency-Key": p.reference,
      },
      body: JSON.stringify({
        recipient: p.recipient,
        amount_cents: p.amountCents,
        reference: p.reference,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`zelle /payments: ${json?.error ?? res.status}`);
    return { providerPaymentId: String(json.id ?? `zl_${p.reference}`), status: "sent" };
  }
}
