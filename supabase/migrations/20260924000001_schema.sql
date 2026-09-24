-- Harbor core schema. All money is integer cents (bigint). Interest accrual uses integer micro-cents.

create extension if not exists pgcrypto;

create type user_role as enum ('customer', 'admin', 'support_agent');
create type kyc_state as enum ('unverified','pending','needs_review','approved','rejected','suspended','frozen_legal');
create type customer_tier as enum ('tier1','tier2');
create type account_kind as enum ('checking','savings');
create type account_status as enum ('open','frozen','closing','closed');
create type hold_kind as enum ('ach_in','card_auth','dispute','legal');
create type hold_status as enum ('active','released','captured','expired');
create type card_status as enum ('requested','active','frozen','canceled','replaced');
create type member_status as enum ('pending_guardian_approval','active','paused','removed');

-- Versioned money policy + fee schedule (the fee schedule is the published fee page).
create table money_policies (
  version int primary key,
  policy jsonb not null,
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table fee_schedules (
  version int primary key,
  schedule jsonb not null,
  effective_from timestamptz not null default now(),
  published_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'customer',
  legal_name text not null default '',
  email text,
  kyc_state kyc_state not null default 'unverified',
  tier customer_tier not null default 'tier1',
  step_up_enrolled boolean not null default false,
  created_at timestamptz not null default now()
);

create table kyc_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  provider text not null check (provider in ('fake','stripe_identity')),
  session_id text,
  identity_status text,               -- raw vendor status (unknown values never approve)
  sanctions jsonb,
  decision kyc_state not null,
  reason text not null,
  decided_by uuid references profiles(id),   -- null = automatic
  created_at timestamptz not null default now()
);
create index on kyc_checks (user_id, created_at desc);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind account_kind not null,
  status account_status not null default 'open',
  account_number text not null unique check (account_number ~ '^[0-9]{12}$'),
  routing_number text not null default '091000019' check (routing_number ~ '^[0-9]{9}$'),
  nickname text not null default '',
  policy_version int not null references money_policies(version),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
-- One live checking and one live savings pocket per user.
create unique index accounts_one_live_per_kind on accounts (user_id, kind) where status <> 'closed';

create table linked_banks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  provider text not null check (provider in ('fake','plaid')),
  provider_item_id text,               -- Plaid item id; the access token lives in a vault, never here
  provider_account_id text,
  institution text not null,
  mask text not null check (mask ~ '^[0-9]{2,4}$'),
  owner_names text[] not null default '{}',
  name_matched boolean not null,
  status text not null default 'active' check (status in ('active','removed')),
  linked_at timestamptz not null default now()
);
create index on linked_banks (user_id);

create table direct_deposit_forms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  account_id uuid not null references accounts(id),
  employer_name text not null check (length(trim(employer_name)) > 0),
  allocation jsonb not null,
  signature_name text not null,
  created_at timestamptz not null default now()
);

create table family_members (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references profiles(id) on delete cascade,
  member_user_id uuid references profiles(id),
  name text not null,
  kind text not null check (kind in ('spouse','teen')),
  status member_status not null,
  per_txn_cents bigint not null check (per_txn_cents >= 0),
  daily_cents bigint not null check (daily_cents >= 0),
  monthly_cents bigint not null check (monthly_cents >= 0),
  blocked_mcc_groups text[] not null default '{}',
  blocked_mccs text[] not null default '{}',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint limits_ordered check (per_txn_cents <= daily_cents and daily_cents <= monthly_cents),
  constraint teen_needs_approval check (kind <> 'teen' or status <> 'active' or approved_at is not null)
);

create table cards (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  holder_user_id uuid not null references profiles(id),
  family_member_id uuid references family_members(id),
  kind text not null check (kind in ('virtual','physical')),
  status card_status not null,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  provider text not null default 'fake' check (provider in ('fake','stripe_issuing')),
  provider_card_id text unique,
  replaces_card_id uuid references cards(id),
  created_at timestamptz not null default now(),
  canceled_at timestamptz
);
create index on cards (account_id);

create table holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references accounts(id),            -- null when funded by a teen allowance pocket
  family_member_id uuid references family_members(id),
  kind hold_kind not null,
  amount_cents bigint not null check (amount_cents > 0),
  status hold_status not null default 'active',
  ref_id uuid,
  expires_at timestamptz,
  release_at timestamptz,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint hold_has_owner check (account_id is not null or family_member_id is not null),
  constraint card_auth_expires check (kind <> 'card_auth' or expires_at is not null),
  constraint released_has_time check (status = 'active' or released_at is not null)
);
create index on holds (account_id) where status = 'active';

create table transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  kind text not null check (kind in ('ach_in','ach_out','p2p','pocket','allowance_topup','closure_payout')),
  speed text check (speed in ('standard','instant')),
  from_account_id uuid references accounts(id),
  to_account_id uuid references accounts(id),
  linked_bank_id uuid references linked_banks(id),
  counterparty_user_id uuid references profiles(id),
  family_member_id uuid references family_members(id),
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  status text not null check (status in ('pending','settled','returned','completed','failed')),
  return_code text check (return_code ~ '^R[0-9]{2}$'),
  settle_at timestamptz,
  new_payee boolean not null default false,
  policy_version int not null references money_policies(version),
  fee_version int not null references fee_schedules(version),
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint instant_only_out check (speed is null or kind = 'ach_out'),
  constraint returned_has_code check (status <> 'returned' or return_code is not null),
  constraint no_self_p2p check (kind <> 'p2p' or counterparty_user_id <> user_id)
);
create index on transfers (user_id, created_at desc);

create table payees (
  user_id uuid not null references profiles(id) on delete cascade,
  payee_user_id uuid not null references profiles(id) on delete cascade,
  first_paid_at timestamptz not null default now(),
  primary key (user_id, payee_user_id)
);

create table card_authorizations (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id),
  provider_auth_id text unique,
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  mcc text not null check (mcc ~ '^[0-9]{4}$'),
  merchant text not null,
  foreign_txn boolean not null default false,
  status text not null check (status in ('authorized','captured','expired','reversed','declined')),
  decline_reason text,
  hold_id uuid references holds(id),
  funding_account text not null check (funding_account in ('customer_deposits','family_allowance')),
  funding_party uuid not null,
  captured_cents bigint not null default 0 check (captured_cents >= 0),
  refunded_cents bigint not null default 0 check (refunded_cents >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  captured_at timestamptz,
  constraint refund_le_captured check (refunded_cents <= captured_cents),
  constraint declined_has_reason check (status <> 'declined' or decline_reason is not null),
  constraint declined_no_hold check (status <> 'declined' or hold_id is null)
);
create index on card_authorizations (card_id, created_at desc);

-- Merchant refunds: the network refund id is the primary key, so each posts at most once.
create table card_refunds (
  id text primary key,
  auth_id uuid not null references card_authorizations(id),
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now()
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid not null references card_authorizations(id),
  user_id uuid not null references profiles(id),
  credit_account text not null check (credit_account in ('customer_deposits','family_allowance')),
  credit_party uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null check (length(trim(reason)) > 0),
  status text not null check (status in ('open','provisional_credited','won','lost','withdrawn')),
  provisional_credit_cents bigint not null default 0 check (provisional_credit_cents >= 0),
  provisional_credit_due_at timestamptz not null,
  resolution_due_at timestamptz not null,
  policy_version int not null references money_policies(version),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint provisional_le_amount check (provisional_credit_cents <= amount_cents)
);
create unique index disputes_one_open_per_auth on disputes (auth_id) where status in ('open','provisional_credited');

create table interest_accruals (
  account_id uuid not null references accounts(id),
  day date not null,
  balance_cents bigint not null,
  accrued_micro bigint not null check (accrued_micro >= 0),
  primary key (account_id, day)
);

create table interest_postings (
  account_id uuid not null references accounts(id),
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  accrued_micro bigint not null,
  carry_in_micro bigint not null,
  posted_cents bigint not null check (posted_cents >= 0),
  carry_out_micro bigint not null check (abs(carry_out_micro) <= 500000 or posted_cents = 0),
  created_at timestamptz not null default now(),
  primary key (account_id, period)
);

create table closures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  payout_cents bigint not null check (payout_cents >= 0),
  linked_bank_id uuid references linked_banks(id),
  status text not null check (status in ('completed','blocked')),
  blocks text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Double-entry ledger.
create table ledger_txns (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table ledger_lines (
  id bigserial primary key,
  txn_id uuid not null references ledger_txns(id) on delete cascade,
  account text not null check (account in ('customer_deposits','family_allowance','ach_clearing','card_settlement','fee_revenue',
    'interest_expense','dispute_receivable','dispute_loss','ach_return_loss','closure_payout')),
  party uuid,
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  constraint one_sided check ((debit = 0) <> (credit = 0)),
  constraint customer_lines_have_party check (account not in ('customer_deposits','family_allowance') or party is not null)
);
create index on ledger_lines (txn_id);
create index on ledger_lines (account, party);

-- Every transaction must balance at commit time (deferred so lines can be inserted one by one).
create or replace function ledger_assert_balanced() returns trigger language plpgsql as $$
declare net bigint; tid uuid := coalesce(new.txn_id, old.txn_id);
begin
  select coalesce(sum(debit) - sum(credit), 0) into net from ledger_lines where txn_id = tid;
  if net <> 0 then
    raise exception 'ledger txn % unbalanced by %', tid, net using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger ledger_balanced
  after insert or update or delete on ledger_lines
  deferrable initially deferred
  for each row execute function ledger_assert_balanced();

-- The ledger is append-only: corrections are new reversing txns.
create or replace function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger is append-only (% on %)', tg_op, tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger ledger_lines_append_only before update or delete on ledger_lines for each row execute function ledger_append_only();
create trigger ledger_txns_append_only before update or delete on ledger_txns for each row execute function ledger_append_only();

-- Atomic ledger posting for the api function (service role only). Idempotent on p_idem.
create or replace function post_ledger_txn(p_kind text, p_ref text, p_idem text, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare tid uuid; l jsonb;
begin
  if p_idem is not null then
    select id into tid from ledger_txns where idempotency_key = p_idem;
    if found then return tid; end if;
  end if;
  insert into ledger_txns (kind, ref, idempotency_key) values (p_kind, p_ref, p_idem) returning id into tid;
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into ledger_lines (txn_id, account, party, debit, credit)
    values (tid, l->>'account', nullif(l->>'party','')::uuid, coalesce((l->>'debit')::bigint, 0), coalesce((l->>'credit')::bigint, 0));
  end loop;
  return tid;
end $$;

create table idempotency_keys (
  key text primary key,
  user_id uuid,
  request_hash text not null,
  status int not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);

create table provider_events (
  id text primary key,               -- provider event id: processed once
  provider text not null,
  type text not null,
  received_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  reason text,
  data jsonb,
  created_at timestamptz not null default now()
);

-- Balances: posted = ledger; available = posted - active holds. security_invoker keeps RLS.
create view account_balances with (security_invoker = true) as
select a.id as account_id, a.user_id, a.kind,
  coalesce((select sum(l.credit - l.debit) from ledger_lines l where l.account = 'customer_deposits' and l.party = a.id), 0)::bigint as posted_cents,
  coalesce((select sum(h.amount_cents) from holds h where h.account_id = a.id and h.status = 'active' and (h.expires_at is null or h.expires_at > now())), 0)::bigint as holds_cents
from accounts a;

create view account_available with (security_invoker = true) as
select *, posted_cents - holds_cents as available_cents from account_balances;

create view allowance_balances with (security_invoker = true) as
select f.id as member_id, f.owner_user_id,
  coalesce((select sum(l.credit - l.debit) from ledger_lines l where l.account = 'family_allowance' and l.party = f.id), 0)::bigint as posted_cents,
  coalesce((select sum(h.amount_cents) from holds h where h.family_member_id = f.id and h.status = 'active' and (h.expires_at is null or h.expires_at > now())), 0)::bigint as holds_cents
from family_members f;

-- Statement lines for an account (ledger only).
create view statement_lines with (security_invoker = true) as
select l.party as account_id, t.created_at as at, t.kind, t.ref, l.debit, l.credit
from ledger_lines l join ledger_txns t on t.id = l.txn_id
where l.account = 'customer_deposits';
