// Harbor `api` Edge Function (Deno). The ONLY writer of money tables: it uses the service role.
// Auth: Supabase JWT (Authorization: Bearer <access token>). Mutations honour `Idempotency-Key`.
// Providers: fake by default; Stripe (sk_test_ only) and Plaid sandbox when keys are set. Live keys are refused.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { HarborService, ApiError } from "../_shared/app/service.ts";
import { SupabaseStore } from "../_shared/app/store.ts";
import { route } from "../_shared/app/router.ts";
import { selectProviders } from "../_shared/providers/index.ts";
import {
  DEFAULT_FEES,
  DEFAULT_POLICY,
  type FeeSchedule,
  type MoneyPolicy,
} from "../_shared/domain/index.ts";

const env = Deno.env.toObject();
const providers = selectProviders(env); // throws on live keys: the function refuses to boot
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const store = new SupabaseStore(admin);

const cors = {
  "Access-Control-Allow-Origin": env.HARBOR_ALLOWED_ORIGIN ?? "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, idempotency-key, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...extra },
  });

async function activeConfig(): Promise<{ policy: MoneyPolicy; fees: FeeSchedule }> {
  const [{ data: p }, { data: f }] = await Promise.all([
    admin.from("money_policies").select("policy").order("version", { ascending: false }).limit(1),
    admin.from("fee_schedules").select("schedule").order("version", { ascending: false }).limit(1),
  ]);
  return {
    policy: (p?.[0]?.policy as MoneyPolicy) ?? DEFAULT_POLICY,
    fees: (f?.[0]?.schedule as FeeSchedule) ?? DEFAULT_FEES,
  };
}

async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parts.t}.${payload}`),
  );
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === parts.v1;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(functions\/v1\/)?api/, "") || "/";
  const { policy, fees } = await activeConfig();
  const service = new HarborService({ store, providers, policy, fees });

  // Stripe webhooks (Issuing real-time authorizations; events processed once).
  if (path === "/webhooks/stripe" && req.method === "POST") {
    const raw = await req.text();
    if (
      !(await verifyStripeSignature(
        raw,
        req.headers.get("stripe-signature"),
        env.STRIPE_WEBHOOK_SECRET,
      ))
    )
      return json(400, { error: { code: "bad_signature" } });
    const evt = JSON.parse(raw);
    const { error: dup } = await admin
      .from("provider_events")
      .insert({ id: evt.id, provider: "stripe", type: evt.type });
    if (dup) return json(200, { received: true, duplicate: true });
    if (evt.type === "issuing_authorization.request") {
      const a = evt.data.object;
      const { data: card } = await admin
        .from("cards")
        .select("id")
        .eq("provider_card_id", a.card.id)
        .single();
      const decision = card
        ? await service.authorizeCard(card.id, {
            amountCents: a.pending_request?.amount ?? a.amount,
            mcc: a.merchant_data?.category_code ?? "0000",
            merchant: a.merchant_data?.name ?? "Merchant",
            foreign: a.merchant_data?.country && a.merchant_data.country !== "US",
            providerAuthId: a.id,
          })
        : { approved: false };
      // Respond synchronously to approve/decline the Stripe Issuing authorization.
      return json(200, { approved: decision.approved }, { "Stripe-Version": "2024-06-20" });
    }
    return json(200, { received: true });
  }

  let caller = null;
  const token = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (token) {
    const { data } = await admin.auth.getUser(token);
    if (data.user) {
      const { data: prof } = await admin
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();
      caller = {
        userId: data.user.id,
        role: (prof?.role ?? "customer") as "customer" | "admin" | "support_agent",
      };
    }
  }
  // Fake-only test hooks (card network simulator) are disabled when a real issuer is configured.
  if (path.startsWith("/sim/") && providers.issuer.name !== "fake")
    return json(404, { error: { code: "no_route" } });

  let body: unknown = {};
  if (req.method !== "GET") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }
  try {
    const res = await route(service, {
      method: req.method,
      path,
      body,
      caller,
      idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
      query: Object.fromEntries(url.searchParams),
    });
    return json(res.status, res.body, res.replayed ? { "Idempotent-Replayed": "true" } : {});
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError(500, "internal", (e as Error).message);
    return json(err.status, { error: { code: err.code, message: err.message } });
  }
});
