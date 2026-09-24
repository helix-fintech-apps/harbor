// Card issuing provider: fake + Stripe Issuing (test mode).
import { stripeRequest, type Env } from "./env.ts";

export interface CardIssuer {
  name: "fake" | "stripe_issuing";
  createCard(p: {
    userId: string;
    legalName: string;
    kind: "virtual" | "physical";
    cardId: string;
  }): Promise<{ providerCardId: string; last4: string }>;
  setStatus(providerCardId: string, status: "active" | "inactive" | "canceled"): Promise<void>;
}

export class FakeIssuer implements CardIssuer {
  name = "fake" as const;
  async createCard(p: { cardId: string }) {
    let h = 0;
    for (const c of p.cardId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { providerCardId: `ic_fake_${p.cardId}`, last4: String(h % 10_000).padStart(4, "0") };
  }
  async setStatus() {}
}

export class StripeIssuing implements CardIssuer {
  name = "stripe_issuing" as const;
  private holders = new Map<string, string>();
  constructor(private env: Env) {}
  async createCard(p: { userId: string; legalName: string; kind: "virtual" | "physical" }) {
    let ch = this.holders.get(p.userId);
    if (!ch) {
      const h = await stripeRequest(this.env, "POST", "/issuing/cardholders", {
        type: "individual",
        name: p.legalName,
        "metadata[user_id]": p.userId,
        "billing[address][line1]": "1 Test St",
        "billing[address][city]": "San Francisco",
        "billing[address][state]": "CA",
        "billing[address][postal_code]": "94111",
        "billing[address][country]": "US",
      });
      ch = h.id as string;
      this.holders.set(p.userId, ch);
    }
    const c = await stripeRequest(this.env, "POST", "/issuing/cards", {
      cardholder: ch,
      currency: "usd",
      type: p.kind,
      status: p.kind === "virtual" ? "active" : "inactive",
    });
    return { providerCardId: c.id as string, last4: c.last4 as string };
  }
  async setStatus(providerCardId: string, status: "active" | "inactive" | "canceled") {
    await stripeRequest(this.env, "POST", `/issuing/cards/${providerCardId}`, { status });
  }
}
