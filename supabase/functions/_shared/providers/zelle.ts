// Zelle bill-pay provider: fake (deterministic) + Zelle sandbox (test mode). Live is refused.
// Harbor only pushes the payment; returns and refunds arrive later as Zelle return webhooks.
import type { Env } from "./env.ts";

export interface ZelleSendRequest {
  paymentId: string; // Harbor's business key (also the provider idempotency key)
  fromName: string;
  recipient: { email?: string; phone?: string };
  amountCents: number;
  memo?: string;
}

export interface ZelleProvider {
  name: "fake" | "zelle_sandbox";
  send(req: ZelleSendRequest): Promise<{ providerRef: string; status: string }>;
}

/**
 * Fake Zelle. Deterministic provider reference from the payment id; always accepts (a real return
 * is driven later through the Zelle return webhook, exactly like the card network simulator).
 */
export class FakeZelle implements ZelleProvider {
  name = "fake" as const;
  async send(req: ZelleSendRequest) {
    return { providerRef: `zp_fake_${req.paymentId}`, status: "sent" };
  }
}

export class ZelleSandbox implements ZelleProvider {
  name = "zelle_sandbox" as const;
  constructor(private env: Env) {}
  async send(req: ZelleSendRequest) {
    const base = this.env.ZELLE_API_BASE ?? "https://sandbox.zelle.example";
    const res = await fetch(`${base}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.ZELLE_API_KEY}`,
      },
      body: JSON.stringify({
        idempotency_key: req.paymentId,
        amount: req.amountCents,
        currency: "USD",
        sender_name: req.fromName,
        recipient: req.recipient,
        memo: req.memo ?? null,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`zelle payments: ${json?.error?.message ?? res.status}`);
    return { providerRef: json.id as string, status: (json.status as string) ?? "sent" };
  }
}
