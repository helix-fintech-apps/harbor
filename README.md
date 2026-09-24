# Harbor — consumer neobank

Harbor is a **consumer neobank**: personal checking and savings, debit cards, and family cards (spouse and teen),
with ACH in/out, P2P, disputes and savings interest. It is built as a **test subject for Helix**, a fintech QA
product (app 2; app 1 is TaskNest). Money correctness is the point: every rule is in
[`docs/SPEC.md`](docs/SPEC.md), on the published terms page (`/fees`), and in code and tests.

Business banking is a separate app (app 3), not part of Harbor.

## Quick start (demo mode, no backend)
```bash
npm install
npm run dev        # http://localhost:5173 — sign in as a demo user (password Harbor!2026)
npm test           # domain unit tests + service/API integration tests (Vitest)
npm run typecheck
npm run build
npm run db:check   # apply migrations to a throwaway local Postgres 16 and run DB assertions
```
Without `VITE_SUPABASE_URL` the UI runs the real service + router in the browser on an in-memory store with
fake providers (state in localStorage; "Reset demo data" on the sign-in page; demo clock in Admin → jobs).

## Layout
| Path | What |
|---|---|
| `supabase/functions/_shared/domain/` | Pure money rules (integer cents): kyc, limits, accounts, achIn, transfers, cards, family, disputes, interest, closure, statements, ledger, idempotency, config (policy + fee schedule) |
| `supabase/functions/_shared/providers/` | Provider interfaces + fakes + test-mode real (Stripe Identity, Stripe Issuing, Plaid sandbox); live keys refused |
| `supabase/functions/_shared/app/` | Service (orchestration), router, stores (Postgres via supabase-js, memory), demo seed |
| `supabase/functions/api/` | Deno Edge Function (service role; JWT auth; Stripe webhook) |
| `supabase/migrations/` | Schema, RLS, generated policy/fee seed |
| `scripts/ci/` | Local Postgres validation (`db_validate.sh`, `auth_stub.sql`, `db_checks.sql`) |
| `src/` | Vite + React + Tailwind UI |
| `tests/unit`, `tests/integration` | Vitest |
| `docs/SPEC.md`, `docs/API.md` | Spec and endpoint reference |

## Deploying to Supabase (when a project is available)
1. `supabase link --project-ref <ref>` then `supabase db push` (migrations).
2. Seed the demo users (same people, ids and balances as demo mode; password `Harbor!2026`, staff roles, KYC states):
   `psql "$SUPABASE_DB_URL" -f supabase/seed.sql` (idempotent). Locally, `supabase db reset` applies migrations + seed.
3. `supabase secrets set` for the variables in `.env.example` (test keys only), then `supabase functions deploy api`.
4. Build the UI with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

Never commit `.env`. Harbor refuses `sk_live_` Stripe keys and any Plaid environment other than `sandbox`.
