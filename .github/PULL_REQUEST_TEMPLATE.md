## What & why

<!-- One or two sentences. Link the issue: Closes #123 -->

## Money impact

<!-- Tick exactly one. "Yes" requires the money checklist below. -->

- [ ] **None** - no change to balances, holds, fees, limits, interest, disputes, transfers, cards or the ledger
- [ ] **Yes** - describe the before/after with a worked example in cents:

<!--
Example: instant withdrawal of $100.00 (10000)
before: fee 150, total debit 10150, available after 239850
after:  ...
-->

### Money checklist (required if money impact = yes)

- [ ] All amounts are integer cents (micro-cents for interest accrual); no floats, no `toFixed` on money
- [ ] Every money event posts one **balanced** ledger txn; the ledger stays append-only
- [ ] A multi-row money write goes through its atomic operation (`MoneyOps` -> one `harbor_*` SQL function), with the same guards in `MemoryStore`
- [ ] Debits and card authorizations are checked against **available** (posted - active holds); every hold is released exactly once
- [ ] Fees come from the published fee schedule (`/fees`); `fee_version` / `policy_version` recorded
- [ ] Mutating endpoints honour `Idempotency-Key`; a replay returns the first result and moves money once
- [ ] ACH (3 business-day hold, returns once, claw-back), card (auth expiry, capture tolerance, refunds <= captured - refunded), Reg E dispute and interest rounding rules unchanged or updated in `docs/SPEC.md`
- [ ] Logic lives in `supabase/functions/_shared/domain/` (not duplicated in UI/handlers)
- [ ] Only Stripe **test** keys / Plaid **sandbox** / fake providers touched

## Database migration

- [ ] No migration
- [ ] New migration in `supabase/migrations/` (never edit a merged one)
  - [ ] RLS enabled + policies for any new table; no client write grants
  - [ ] Money columns are `bigint` cents
  - [ ] New `harbor_*` functions: `security definer` + `set search_path`, execute revoked from clients, row locks before re-checking guards, idempotent
  - [ ] Backwards compatible with the currently deployed `api` function (deploy order: DB first, then function)
  - [ ] `scripts/ci/db_checks.sql` updated (happy path, replay, guard, rollback)

## Tests

- [ ] Unit tests (`tests/unit`) for domain changes, including boundary cases
- [ ] Integration tests (`tests/integration`, memory **and** Postgres) for service/store/endpoint changes
- [ ] E2E (`e2e/`) for user-visible flows; new controls have `data-testid`
- [ ] N/A - explain:

## Rollout

- [ ] Safe to deploy to staging on merge (no manual steps)
- [ ] Needs manual steps / secrets / config (describe):

## Screenshots

<!-- UI changes only -->
