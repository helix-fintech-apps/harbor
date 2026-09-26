-- BTC debit-cashback rewards. Adds a spendable USD "rewards" wallet, a per-period satoshi balance,
-- and append-style accrual/conversion logs. Money model mirrors 20260924000001_schema.sql.

-- 1) The rewards wallet is a new account kind (one live wallet per user, via the existing
--    accounts_one_live_per_kind index).
alter type account_kind add value if not exists 'rewards';

-- 2) Cashback payouts book to a new ledger expense account.
alter table ledger_lines drop constraint ledger_lines_account_check;
alter table ledger_lines add constraint ledger_lines_account_check
  check (account in ('customer_deposits','family_allowance','ach_clearing','card_settlement','fee_revenue',
    'interest_expense','dispute_receivable','dispute_loss','ach_return_loss','closure_payout','rewards_expense'));

-- 3) Per-user, per-period earning state: satoshis held and eligible-spend progress toward the cap.
create table btc_rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  period text not null,
  eligible_cents bigint not null default 0 check (eligible_cents >= 0),
  sats_balance bigint not null default 0 check (sats_balance >= 0),
  updated_at timestamptz not null default now(),
  unique (user_id, period)
);

-- 4) One accrual per captured authorization. id = 'reward:<authId>' makes a re-capture idempotent.
create table btc_reward_events (
  id text primary key,
  auth_id uuid not null references card_authorizations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  period text not null,
  spend_cents bigint not null check (spend_cents > 0),
  eligible_spend_cents bigint not null check (eligible_spend_cents >= 0),
  reward_usd_cents bigint not null check (reward_usd_cents >= 0),
  sats bigint not null check (sats >= 0),
  price_cents bigint not null check (price_cents > 0),
  created_at timestamptz not null default now()
);
create index on btc_reward_events (user_id, period);

-- 5) One row per BTC -> USD conversion. idempotency_key dedupes a replayed request.
create table btc_conversions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  period text not null,
  idempotency_key text not null unique,
  sats bigint not null check (sats > 0),
  usd_cents bigint not null check (usd_cents > 0),
  price_cents bigint not null check (price_cents > 0),
  created_at timestamptz not null default now()
);
create index on btc_conversions (user_id);

-- 6) BTC spot snapshots (optional oracle feed; the service falls back to the policy price).
create table btc_rates (
  id uuid primary key default gen_random_uuid(),
  price_cents bigint not null check (price_cents > 0),
  as_of timestamptz not null default now()
);

-- RLS: a member sees only their own rewards; staff see all; the rate feed is public read.
alter table btc_rewards enable row level security;
alter table btc_reward_events enable row level security;
alter table btc_conversions enable row level security;
alter table btc_rates enable row level security;

create policy "own btc rewards" on btc_rewards for select using (user_id = auth.uid() or is_staff());
create policy "own btc reward events" on btc_reward_events for select using (user_id = auth.uid() or is_staff());
create policy "own btc conversions" on btc_conversions for select using (user_id = auth.uid() or is_staff());
create policy "btc rates public" on btc_rates for select using (true);
