# Harbor — build spec (shared by all agents)

Consumer neobank used as a Helix test subject (app 2; app 1 is TaskNest). Money correctness is the point:
every rule below is written down here, in the published terms page (`/fees`), and in code + tests.

## Ground rules
- Money = integer cents (`bigint` in SQL). Interest accrual uses integer **micro-cents** (1 cent = 1,000,000). Never floats.
- All money logic lives in `supabase/functions/_shared/domain/*.ts` (pure, no I/O) with unit tests in `tests/unit/`.
  Reuse it; never duplicate rules in the UI or the API. Imports inside `supabase/functions` use explicit `.ts` extensions (Deno).
  The Vite app imports the same files via the aliases `@domain` and `@shared`.
- Policy: `DEFAULT_POLICY` (config.ts) = `money_policies` v1; `DEFAULT_FEES` = `fee_schedules` v1 (the published fee page).
  The seed migration is GENERATED from config.ts (`node --experimental-strip-types scripts/gen-policy-seed.ts`) and a unit
  test fails if they drift. Accounts, transfers and disputes store `policy_version` / `fee_version`.
- Writes to money tables happen ONLY in the `api` Edge Function with the service role. Browser reads via supabase-js under RLS;
  `anon`/`authenticated` have no INSERT/UPDATE/DELETE grants on any table.
- Every money event posts a balanced double-entry txn (`ledger.ts` → `post_ledger_txn()` → `ledger_txns` + `ledger_lines`).
  A DEFERRABLE constraint trigger rejects unbalanced txns at commit; the ledger is append-only (update/delete raise).
- Balances are derived: **posted** = ledger (credits − debits on `customer_deposits`, party = account id);
  **available** = posted − active holds (`ach_in` deposit holds, `card_auth` holds; expired holds don't count).
- Every mutating endpoint accepts `Idempotency-Key`; a replay returns the first response (header `Idempotent-Replayed: true`);
  reusing a key with a different body → 422 `idempotency_conflict`. Ledger posts are also idempotent per business key.
- Providers (interface + fake + real test mode). Fakes are deterministic and used in CI / demo / when no keys:
  - Identity: `FakeIdentity` | `StripeIdentity` (Stripe Identity, `sk_test_` only).
  - Bank link: `FakeBankLink` | `PlaidSandbox` (REST: `/link/token/create`, `/item/public_token/exchange`, `/auth/get`, `/identity/get`).
  - Card issuing: `FakeIssuer` | `StripeIssuing` (Stripe Issuing test mode; real-time auth via `issuing_authorization.request` webhook).
  - Refuse to boot with `sk_live_`/`rk_live_` or `PLAID_ENV` ≠ `sandbox`.

## Domain rules (policy v1)
### Onboarding / KYC (`kyc.ts`)
States: `unverified → pending | needs_review | approved | rejected | frozen_legal`; `approved → suspended | frozen_legal`;
`needs_review → approved | rejected | frozen_legal`; `rejected → needs_review` (appeal); `suspended → approved | rejected | frozen_legal`;
`frozen_legal → approved | rejected` (admin only).
- Approve only when identity = `verified` AND sanctions = `clear`. Vendor **timeout, error, `processing` or any unknown status → `pending`** (never approved).
- Identity `requires_input` → `needs_review`; `canceled`/`failed` → `rejected`.
- Sanctions screen against a fake list (normalized: case, accents, punctuation, suffixes). Exact → `frozen_legal`; token overlap ≥ 80% (≥2 tokens) → `needs_review`.
- Staff may approve only from `needs_review`/`suspended`/`frozen_legal` (the last: admin only), with a reason; never skip verification.
- Only `approved` customers can move money, receive P2P or use cards. `frozen_legal` blocks every payout (withdrawals, closure).
- Fake identity: legal name containing `review` → requires_input, `fail` → canceled, `slow` → timeout, `weird` → unknown status, `pending` → processing; else verified.

### Tier limits (`limits.ts`) — inclusive boundaries, UTC day / UTC calendar month
| | tier1 | tier2 |
|---|---|---|
| Transfers out / day (ACH push + instant + P2P) | $1,000 | $5,000 |
| Transfers out / month | $5,000 | $25,000 |
| Card spend / day (all cards incl. family) | $2,000 | $5,000 |
| Card spend / month | $10,000 | $25,000 |
| ACH deposits / day | $2,500 | $10,000 |

### Accounts (`accounts.ts`)
One live checking + one savings pocket per user, opened on KYC approval. Fake routing `091000019` (ABA-checksum valid), 12-digit account numbers `8800…`.

### Money in (`achIn.ts`)
- Link bank via Plaid (fake: public token `public-fake-<Institution>-<Owner_Name>`). **Owner name must match** the legal name (first + last token, any order, ignoring case/accents/middle names/suffixes); mismatched banks are recorded but unusable.
- ACH pull: credit posts immediately; a hold for the full amount lasts **3 business days** (`achIn.holdBusinessDays`, weekends + listed holidays skipped); settlement job releases it.
- Returns R01/R02/R03/R04/R10/R16/R29 reverse the credit. Before settlement the hold kept the money unavailable; after settlement the claw-back can make the balance negative. A transfer is returned at most once.
- Direct-deposit switch form: validated and recorded only.

### Money out (`transfers.ts`)
- ACH push standard: free, settles next business day. Instant: fee = 1.5% clamped to [$0.25, $15.00] (half-up rounding). Amount + fee ≤ available.
- **Cooling-off**: no withdrawals to a bank linked < 72 h ago (exactly 72 h is allowed).
- P2P to another approved Harbor user; min $1.00; not to self; **first payment to a new payee requires step-up** (fake code `000000`).
- Pocket moves checking ↔ savings are not limited by tier.

### Debit cards (`cards.ts`)
- Virtual: active instantly (max 3 live). Physical: `requested` until activated (max 1 live). Freeze ↔ unfreeze; replace (old → `replaced`, new card); cancel (terminal).
- Authorization order of checks: amount → card status (frozen/canceled/replaced/requested) → account frozen → KYC → velocity (≥5 attempts in 10 min) → family rules → tier card limit → available balance (amount + fees).
- Approved auth places a hold (amount + fees) for 7 days. Capture: partial releases the rest; over-capture allowed within tolerance — restaurants (MCC 5812-5814) +20%, fuel (5541/5542) up to $175; otherwise 0%. Expired auths can't be captured and their hold stops counting.
- Foreign transaction fee 3% (recomputed on capture; not refunded on merchant refund). Out-of-network ATM $2.50.
- Merchant refunds post once per network refund id and never exceed captured − refunded.

### Family cards (`family.ts`)
- Spouse: active immediately, spends from owner's checking within per-txn/daily/monthly limits (per-txn ≤ daily ≤ monthly).
- Teen: `pending_guardian_approval` until the owner approves; spends **only from an allowance pocket** (`family_allowance` ledger account) funded by owner top-ups; default MCC blocks gambling/alcohol/tobacco/adult. Max 5 members.

### Disputes (`disputes.ts`, Reg E style)
Window 60 days after posting. Provisional credit due within 10 business days of notice; decision within 45 days (90 if the account is < 30 days old).
`open → provisional_credited → won | lost`. Won keeps the credit (network chargeback: `card_settlement` → `dispute_receivable`). Lost reverses the provisional credit (can go negative). One open dispute per transaction.

### Fees & interest (`config.ts`, `interest.ts`)
Fee schedule table = published fee page. Savings APY 4.00%: daily accrual = floor(balance × APY_bps × 10⁶ / (10,000 × 365)) micro-cents on end-of-day posted balance (≤ 0 accrues nothing). Monthly posting rounds (accrued + carry-in) to cents **half-to-even**; the remainder (|carry| ≤ ½ cent) carries to next month.

### Closure (`closure.ts`)
Blocked by: pending holds (incl. teen allowance holds), negative balance, open disputes, `frozen_legal` (payout blocked), positive balance with no active name-matched linked bank. Otherwise: cancel all cards, pay out all pockets + allowance pockets in one ledger txn, close accounts, remove family members.

### Statements (`statements.ts`)
Monthly statement = ledger lines for the account: opening + credits − debits = closing; running balance per line.

## Ledger accounts
`customer_deposits` (party = account), `family_allowance` (party = member), `ach_clearing`, `card_settlement`, `fee_revenue`, `interest_expense`, `dispute_receivable`, `dispute_loss`, `ach_return_loss`, `closure_payout`.

## Supabase
No hosted project yet (free-tier limit). Migrations in `supabase/migrations/` (schema, RLS, generated policy/fee seed) are validated against a
local Postgres 16 with a stub `auth` schema: `npm run db:check` (`scripts/ci/db_validate.sh` + `scripts/ci/db_checks.sql`).
Demo users (in-browser demo mode; create the same users in Supabase Auth when a project exists): `ava@harbor.test` (approved, $2,500),
`ben@harbor.test` (approved, $500), `rita@harbor.test` (needs_review), `oleg@harbor.test` (frozen_legal, sanctions), `nia@harbor.test` (unverified),
`admin@harbor.test`, `agent@harbor.test` (support). Password: `Harbor!2026` (test only).

## API
See `docs/API.md`. Edge Function `api`; errors are `{error: {code, message, details?}}` with 4xx.

## UI (Vite + React + TS + Tailwind, light theme, blue accent)
Pages: Sign in · Accounts (available vs posted vs on hold, KYC banner, pocket move, activity) · Link bank (fake Plaid, name match, cooling-off, direct deposit form) ·
Transfers (ACH in, withdraw standard/instant with fee quote, P2P with step-up) · Cards (issue/freeze/replace/cancel, family members with limits/MCC blocks/approval/allowance, merchant simulator) ·
Disputes · Statements · Fees & terms (published terms from the active policy + fee schedule) · Settings (close account) · Admin (KYC review, tier, freeze, ACH returns, disputes, jobs, ledger + trial balance).
`data-testid` on key controls. Without `VITE_SUPABASE_URL` the UI runs in **demo mode**: the same service/router runs in the browser on an in-memory store (fake providers, persisted in localStorage, demo clock).
