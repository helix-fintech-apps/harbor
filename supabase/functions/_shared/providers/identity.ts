// Identity verification provider: fake (deterministic) + Stripe Identity (test mode).
import { stripeRequest, type Env } from "./env.ts";

export interface IdentitySession {
  sessionId: string;
  url?: string;
  status: string;
}

export interface IdentityProvider {
  name: "fake" | "stripe_identity";
  start(userId: string, legalName: string): Promise<IdentitySession>;
  /** Returns the RAW vendor status string. The domain maps unknown values to `pending`. */
  status(sessionId: string): Promise<string>;
}

/**
 * Fake identity vendor. Outcome is chosen by the legal name so QA can drive every branch:
 *  contains "review"  -> requires_input      contains "fail"    -> canceled
 *  contains "slow"    -> never answers (vendor timeout)
 *  contains "weird"   -> an unknown status string
 *  contains "pending" -> processing           otherwise          -> verified
 */
export class FakeIdentity implements IdentityProvider {
  name = "fake" as const;
  private sessions = new Map<string, string>();
  async start(userId: string, legalName: string): Promise<IdentitySession> {
    const id = `vs_fake_${userId.slice(0, 8)}_${this.sessions.size + 1}`;
    this.sessions.set(id, legalName.toLowerCase());
    return { sessionId: id, status: "requires_input" };
  }
  async status(sessionId: string): Promise<string> {
    const n = this.sessions.get(sessionId) ?? sessionId.toLowerCase();
    if (n.includes("slow")) return new Promise(() => {});
    if (n.includes("review")) return "requires_input";
    if (n.includes("fail")) return "canceled";
    if (n.includes("weird")) return "verified_pending_maybe";
    if (n.includes("pending")) return "processing";
    return "verified";
  }
}

export class StripeIdentity implements IdentityProvider {
  name = "stripe_identity" as const;
  constructor(private env: Env) {}
  async start(userId: string): Promise<IdentitySession> {
    const s = await stripeRequest(this.env, "POST", "/identity/verification_sessions", {
      type: "document",
      "metadata[user_id]": userId,
    });
    return { sessionId: s.id, url: s.url, status: s.status };
  }
  async status(sessionId: string): Promise<string> {
    const s = await stripeRequest(this.env, "GET", `/identity/verification_sessions/${sessionId}`);
    return s.status;
  }
}
