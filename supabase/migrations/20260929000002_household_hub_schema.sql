-- Household money hub schema: on-demand accounts (incl. envelopes), per-card limits, shared
-- households, Zelle payments/schedules, and two new ledger accounts (Zelle clearing + cashback).

-- ---------------------------------------------------------------------------------------------
-- Accounts: extra pockets on demand. A "primary" checking + savings are opened at KYC; users may
-- open more checking/savings and temporary envelope accounts (with a start and end date).
-- ---------------------------------------------------------------------------------------------
alter table accounts
  add column if not exists is_primary boolean not null default false,
  add column if not exists start_date date,
  add column if not exists end_date date;

alter table accounts add constraint accounts_primary_kind
  check (not is_primary or kind in ('checking', 'savings'));
alter table accounts add constraint accounts_envelope_dates
  check (kind <> 'envelope' or (start_date is not null and end_date is not null and end_date >= start_date));
alter table accounts add constraint accounts_nonenvelope_no_dates
  check (kind = 'envelope' or (start_date is null and end_date is null));

-- Multiple pockets per kind are allowed now; keep only "one live PRIMARY per kind".
drop index if exists accounts_one_live_per_kind;
create unique index accounts_one_primary_per_kind on accounts (user_id, kind)
  where status <> 'closed' and is_primary;

-- ---------------------------------------------------------------------------------------------
-- Cards: optional per-card per-transaction / daily / monthly spend limits (null = no card limit).
-- ---------------------------------------------------------------------------------------------
alter table cards
  add column if not exists per_txn_cents bigint,
  add column if not exists daily_cents bigint,
  add column if not exists monthly_cents bigint;

alter table cards add constraint card_limits_nonneg
  check ((per_txn_cents is null or per_txn_cents >= 0)
     and (daily_cents is null or daily_cents >= 0)
     and (monthly_cents is null or monthly_cents >= 0));
alter table cards add constraint card_limits_all_or_none
  check ((per_txn_cents is null) = (daily_cents is null)
     and (daily_cents is null) = (monthly_cents is null));
alter table cards add constraint card_limits_ordered
  check (per_txn_cents is null or (per_txn_cents <= daily_cents and daily_cents <= monthly_cents));

-- ---------------------------------------------------------------------------------------------
-- Ledger: add Zelle clearing (payments in flight) and cashback expense (1% debit rewards).
-- ---------------------------------------------------------------------------------------------
alter table ledger_lines drop constraint ledger_lines_account_check;
alter table ledger_lines add constraint ledger_lines_account_check
  check (account in ('customer_deposits','family_allowance','ach_clearing','zelle_clearing','card_settlement',
    'fee_revenue','cashback_expense','interest_expense','dispute_receivable','dispute_loss','ach_return_loss','closure_payout'));

-- ---------------------------------------------------------------------------------------------
-- Shared households: an owner invites family members; each member is a Harbor user.
-- ---------------------------------------------------------------------------------------------
create table households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  monthly_cap_cents bigint check (monthly_cap_cents is null or monthly_cap_cents >= 0),
  created_at timestamptz not null default now(),
  unique (owner_user_id)  -- a user owns at most one household
);

create table household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,   -- resolved once the invitee is known
  email text not null,
  status text not null check (status in ('invited', 'active', 'removed')),
  is_owner boolean not null default false,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  created_at timestamptz not null default now()
);
create index on household_members (household_id);
create index on household_members (user_id) where user_id is not null;
-- A given Harbor user appears at most once (not removed) in a household.
create unique index household_members_active_user on household_members (household_id, user_id)
  where user_id is not null and status <> 'removed';

-- ---------------------------------------------------------------------------------------------
-- Zelle: recurring schedules and the individual payments (one-time or produced by a schedule).
-- ---------------------------------------------------------------------------------------------
create table zelle_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  from_account_id uuid not null references accounts(id),
  recipient text not null,
  amount_cents bigint not null check (amount_cents > 0),
  memo text,
  frequency text not null check (frequency in ('weekly', 'monthly')),
  status text not null default 'active' check (status in ('active', 'canceled')),
  next_run_date date not null,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);
create index on zelle_schedules (status, next_run_date);

create table zelle_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  from_account_id uuid not null references accounts(id),
  recipient text not null,
  amount_cents bigint not null check (amount_cents > 0),
  memo text,
  status text not null check (status in ('sent', 'returned')),
  provider text not null,
  provider_payment_id text,
  schedule_id uuid references zelle_schedules(id),
  funded_from jsonb not null default '[]'::jsonb,  -- [{accountId, cents}] contributions (for returns)
  return_reason text,
  created_at timestamptz not null default now(),
  returned_at timestamptz,
  constraint returned_has_reason check (status <> 'returned' or return_reason is not null)
);
create index on zelle_payments (user_id, created_at desc);
