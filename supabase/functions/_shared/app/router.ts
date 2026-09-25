// HTTP-agnostic router for the `api` Edge Function (and the browser demo transport).
// Every mutating route honours the Idempotency-Key header: a replay returns the first response.

import { ApiError, type Caller, type HarborService } from "./service.ts";

export interface ApiRequest {
  method: string;
  path: string;
  body: any;
  caller: Caller | null;
  idempotencyKey?: string;
  query?: Record<string, string>;
}
export interface ApiResponse {
  status: number;
  body: unknown;
  replayed?: boolean;
}

type Handler = (
  s: HarborService,
  c: Caller,
  p: Record<string, string>,
  body: any,
  q: Record<string, string>,
) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  mutating: boolean;
  public?: boolean;
}

const routes: Route[] = [];
function add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler, mutating: method !== "GET", public: opts.public });
}

// Public
add("GET", "/fees", async (s) => s.publishedTerms(), { public: true });

// Customer
add("GET", "/me", (s, c) => s.me(c));
add("POST", "/kyc/start", (s, c) => s.runKyc(c));
add("POST", "/kyc/refresh", async (s, c, _p, b) => s.runKyc(c, b?.sessionId));
add("POST", "/banks/link-token", (s, c) => s.linkToken(c));
add("POST", "/banks/exchange", (s, c, _p, b) => s.exchange(c, b?.publicToken));
add("POST", "/banks/:id/remove", (s, c, p) => s.removeBank(c, p.id));
add("POST", "/direct-deposit", (s, c, _p, b) => s.directDeposit(c, b));
add("GET", "/transfers/fee-quote", async (s, _c, _p, _b, q) =>
  s.quoteFee(Number(q.amountCents), q.speed === "instant" ? "instant" : "standard"),
);
add("POST", "/transfers/ach-in", (s, c, _p, b) => s.achIn(c, b));
add("POST", "/transfers/ach-out", (s, c, _p, b) => s.achOut(c, b));
add("POST", "/transfers/p2p", (s, c, _p, b) => s.p2p(c, b));
add("POST", "/transfers/pocket", (s, c, _p, b) => s.pocketMove(c, b));
add("POST", "/cards", (s, c, _p, b) => s.issueCard(c, b));
add("POST", "/cards/:id/freeze", (s, c, p) => s.setCardStatus(c, p.id, "frozen"));
add("POST", "/cards/:id/unfreeze", (s, c, p) => s.setCardStatus(c, p.id, "active"));
add("POST", "/cards/:id/activate", (s, c, p) => s.setCardStatus(c, p.id, "active"));
add("POST", "/cards/:id/cancel", (s, c, p) => s.setCardStatus(c, p.id, "canceled"));
add("POST", "/cards/:id/replace", (s, c, p) => s.replaceCard(c, p.id));
add("POST", "/family", (s, c, _p, b) => s.addFamilyMember(c, b));
add("POST", "/family/:id/approve", (s, c, p) => s.approveMember(c, p.id));
add("POST", "/family/:id/limits", (s, c, p, b) => s.updateMemberLimits(c, p.id, b));
add("POST", "/family/:id/allowance", (s, c, p, b) =>
  s.allowanceTopUp(c, p.id, b?.amountCents, b?.idempotencyKey),
);
add("POST", "/disputes", (s, c, _p, b) => s.openDispute(c, b));
add("GET", "/statements", (s, c, _p, _b, q) => s.statement(c, q.accountId, q.period));
add("POST", "/accounts/close", (s, c, _p, b) => s.closeAccount(c, b ?? {}));
add("POST", "/goals", (s, c, _p, b) => s.createGoal(c, b));
add("GET", "/goals", (s, c) => s.listGoals(c));
add("POST", "/goals/:id/contribute", (s, c, p, b) => s.contributeGoal(c, p.id, b));

// Card network simulator (fake issuer) — in test mode Stripe Issuing webhooks map onto the same service calls.
add("POST", "/sim/cards/:id/authorize", async (s, c, p, b) => {
  await s.cardFor(c, p.id);
  return s.authorizeCard(p.id, b);
});
add("POST", "/sim/authorizations/:id/capture", async (s, _c, p, b) =>
  s.capture(p.id, b?.amountCents),
);
add("POST", "/sim/authorizations/:id/refund", async (s, _c, p, b) =>
  s.merchantRefund(p.id, String(b?.refundId ?? ""), b?.amountCents),
);

// Staff
add("GET", "/admin/users", (s, c, _p, _b, q) => s.adminUsers(c, q.kyc));
add("POST", "/admin/users/:id/kyc", (s, c, p, b) => s.adminSetKyc(c, p.id, b?.state, b?.reason));
add("POST", "/admin/users/:id/tier", (s, c, p, b) => s.adminSetTier(c, p.id, b?.tier));
add("POST", "/admin/accounts/:id/freeze", (s, c, p, b) =>
  s.adminSetAccountStatus(c, p.id, "frozen", b?.reason),
);
add("POST", "/admin/accounts/:id/unfreeze", (s, c, p, b) =>
  s.adminSetAccountStatus(c, p.id, "open", b?.reason),
);
add("POST", "/admin/transfers/:id/return", (s, c, p, b) => s.achReturn(c, p.id, b?.code));
add("GET", "/admin/disputes", (s, c) => s.adminDisputes(c));
add("POST", "/admin/disputes/:id/provisional-credit", (s, c, p) => s.provisionalCredit(c, p.id));
add("POST", "/admin/disputes/:id/resolve", (s, c, p, b) => s.resolveDispute(c, p.id, b?.outcome));
add("GET", "/admin/ledger", (s, c, _p, _b, q) => s.adminLedger(c, q.limit ? Number(q.limit) : 200));
add("GET", "/admin/audit", (s, c) => s.adminAudit(c));
add("POST", "/admin/jobs/settle-ach", (s, c) => s.settleAch(c));
add("POST", "/admin/jobs/expire-auths", (s, c) => s.expireAuths(c));
add("POST", "/admin/jobs/dispute-deadlines", (s, c) => s.disputeDeadlines(c));
add("POST", "/admin/jobs/accrue-interest", (s, c, _p, b) => s.accrueInterest(c, b?.day));
add("POST", "/admin/jobs/post-interest", (s, c, _p, b) => s.postInterest(c, b?.period));

export async function route(s: HarborService, req: ApiRequest): Promise<ApiResponse> {
  const path = req.path.replace(/\/+$/, "") || "/";
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.pattern);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (!r.public && !req.caller) throw new ApiError(401, "unauthenticated", "sign in required");
      const caller = req.caller ?? { userId: "anon", role: "customer" as const };
      if (r.mutating) {
        const res = await s.idempotent(
          caller,
          req.idempotencyKey,
          `${req.method} ${path}`,
          req.body ?? null,
          () =>
            r.handler(
              s,
              caller,
              params,
              { ...(req.body ?? {}), idempotencyKey: req.idempotencyKey },
              req.query ?? {},
            ),
        );
        return { status: res.status, body: res.body, replayed: res.replayed };
      }
      return { status: 200, body: await r.handler(s, caller, params, req.body, req.query ?? {}) };
    }
    return { status: 404, body: { error: { code: "no_route", message: `${req.method} ${path}` } } };
  } catch (e) {
    if (e instanceof ApiError)
      return {
        status: e.status,
        body: { error: { code: e.code, message: e.message, details: e.details } },
      };
    return { status: 500, body: { error: { code: "internal", message: (e as Error).message } } };
  }
}

export const ROUTES = routes.map((r) => `${r.method} ${r.pattern.source}`);
