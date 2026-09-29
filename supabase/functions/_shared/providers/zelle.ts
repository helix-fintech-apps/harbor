// Zelle payments provider: a fake/sandbox implementation (there is no live Zelle integration in
// Harbor, a test subject). Mirrors the Stripe-test / Plaid-sandbox providers: it runs with no live
// credentials and drives every branch deterministically from the recipient handle so QA can force
// returns and refunds. Returns and refunds arrive back as Zelle "return" webhooks, which the api
// function verifies and replays into the service (idempotent per provider event id).

export interface ZellePaymentResult {
  providerPaymentId: string;
  status: "sent" | "pending";
}

export interface ZelleProvider {
  name: "fake" | "zelle";
  /** Submit a payment to the network. Returns the network payment id. */
  send(p: {
    userId: string;
    recipient: string;
    amountCents: number;
    ref: string;
  }): Promise<ZellePaymentResult>;
}

/**
 * Fake Zelle. The recipient handle chooses the outcome so QA can drive every branch:
 *   contains "pending" -> accepted but not yet delivered
 *   otherwise          -> sent
 * The recipient handle is an email or US phone; returns/refunds are delivered later as webhooks
 * (in demo/tests via the /sim/zelle/webhook hook), never synchronously here.
 */
export class FakeZelle implements ZelleProvider {
  name = "fake" as const;
  async send(p: {
    userId: string;
    recipient: string;
    amountCents: number;
    ref: string;
  }): Promise<ZellePaymentResult> {
    let h = 2166136261;
    for (const c of `${p.ref}:${p.recipient}`) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const status = p.recipient.toLowerCase().includes("pending") ? "pending" : "sent";
    return { providerPaymentId: `zp_fake_${h.toString(16)}`, status };
  }
}

/** A Zelle handle is an email or a US-style phone number (10-15 digits, optional +). */
export function isValidZelleHandle(recipient: string): boolean {
  const r = recipient.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) return true;
  return /^\+?\d{10,15}$/.test(r.replace(/[\s()-]/g, ""));
}
