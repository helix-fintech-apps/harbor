-- Household Money Hub: on-demand accounts (extra pockets + temporary envelopes), instant internal
-- transfers between a user's own pockets, households with a shared monthly card-spend cap, per-card
-- limits, 1% debit-card cashback, and Zelle bill pay (one-time + recurring, with shortfall auto-pull
-- from the user's other pockets, and returns via webhook). All money is integer cents; every money
-- operation that writes more than one row is one atomic harbor_* function, mirrored by MemoryStore.

-- ---------------------------------------------------------------------------------------------
-- Accounts: allow multiple pockets per kind, mark the primary checking, and model envelopes.
-- ---------------------------------------------------------------------------------------------
alter table accounts add column if not exists is_primary boolean not null default false;
alter table accounts add column if not exists start_date date;   -- envelope start (informational)
alter table accounts add column if not exists end_date date;     -- envelope end (auto-close + sweep)

-- Previously one live checking + one live savings per user; on-demand pockets remove that cap.
drop index if exists accounts_one_live_per_kind;
-- At most one primary checking per user; envelopes carry an end date; only checking can be primary.
create unique index if not exists accounts_one_primary_checking
  on accounts (user_id) where is_primary and status <> 'closed';
alter table accounts add constraint envelope_has_end_date
  check (kind <> 'envelope' or end_date is not null);
alter table accounts add constraint only_checking_is_primary
  check (not is_primary or kind = 'checking');

-- ---------------------------------------------------------------------------------------------
-- Cards: optional per-card per-txn / daily / monthly limits (any card).
-- ---------------------------------------------------------------------------------------------
alter table cards add column if not exists per_txn_cents bigint;
alter table cards add column if not exists daily_cents bigint;
alter table cards add column if not exists monthly_cents bigint;
alter table cards add constraint card_limits_nonneg
  check (per_txn_cents is null or (per_txn_cents >= 0 and daily_cents >= 0 and monthly_cents >= 0));
alter table cards add constraint card_limits_ordered
  check (per_txn_cents is null or (per_txn_cents <= daily_cents and daily_cents <= monthly_cents));

-- ---------------------------------------------------------------------------------------------
-- Card authorizations: track cashback earned on capture and reversed on refund.
-- ---------------------------------------------------------------------------------------------
alter table card_authorizations add column if not exists cashback_cents bigint not null default 0
  check (cashback_cents >= 0);
alter table card_authorizations add column if not exists cashback_reversed_cents bigint not null default 0
  check (cashback_reversed_cents >= 0);
alter table card_authorizations add constraint cashback_reversed_le_earned
  check (cashback_reversed_cents <= cashback_cents);

-- ---------------------------------------------------------------------------------------------
-- Transfers: add the 'zelle' kind; only ACH deposits require an R-code when returned.
-- ---------------------------------------------------------------------------------------------
alter table transfers drop constraint transfers_kind_check;
alter table transfers add constraint transfers_kind_check
  check (kind in ('ach_in','ach_out','p2p','pocket','allowance_topup','closure_payout','zelle'));
alter table transfers drop constraint returned_has_code;
alter table transfers add constraint returned_has_code
  check (status <> 'returned' or kind <> 'ach_in' or return_code is not null);

-- ---------------------------------------------------------------------------------------------
-- Ledger accounts: add zelle_clearing (bill pay in flight) and cashback_expense.
-- ---------------------------------------------------------------------------------------------
alter table ledger_lines drop constraint ledger_lines_account_check;
alter table ledger_lines add constraint ledger_lines_account_check
  check (account in ('customer_deposits','family_allowance','ach_clearing','zelle_clearing','card_settlement',
    'fee_revenue','interest_expense','cashback_expense','dispute_receivable','dispute_loss','ach_return_loss','closure_payout'));

-- ---------------------------------------------------------------------------------------------
-- Households: a shared family group with an overall monthly card-spend cap across all members.
-- ---------------------------------------------------------------------------------------------
create table households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  monthly_cap_cents bigint check (monthly_cap_cents is null or monthly_cap_cents >= 0),
  created_at timestamptz not null default now()
);
create index on households (owner_user_id);

create table household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references profiles(id),
  invited_email text not null,
  role text not null check (role in ('owner','member')),
  status text not null check (status in ('invited','active','removed')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz
);
create index on household_members (household_id);
-- A user can be an active member of at most one household.
create unique index household_one_active_membership on household_members (user_id) where status = 'active';

-- ---------------------------------------------------------------------------------------------
-- Zelle: recurring schedules and a record per sent payment (returns flip its status).
-- ---------------------------------------------------------------------------------------------
create table zelle_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  from_account_id uuid not null references accounts(id),
  recipient_email text,
  recipient_phone text,
  memo text,
  amount_cents bigint not null check (amount_cents > 0),
  frequency text not null check (frequency in ('weekly','monthly')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  status text not null default 'active' check (status in ('active','paused','canceled')),
  created_at timestamptz not null default now(),
  constraint zelle_schedule_has_recipient check (recipient_email is not null or recipient_phone is not null)
);
create index on zelle_schedules (status, next_run_at);

create table zelle_payments (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  schedule_id uuid references zelle_schedules(id),
  recipient_email text,
  recipient_phone text,
  memo text,
  provider_ref text,
  status text not null default 'sent' check (status in ('sent','returned')),
  returned_at timestamptz,
  return_reason text,
  created_at timestamptz not null default now(),
  constraint zelle_payment_has_recipient check (recipient_email is not null or recipient_phone is not null)
);
create unique index zelle_payments_one_per_transfer on zelle_payments (transfer_id);
create unique index zelle_payments_provider_ref on zelle_payments (provider_ref) where provider_ref is not null;

-- ---------------------------------------------------------------------------------------------
-- RLS: reads scoped to the owner / members / staff; all writes go through the api service role.
-- ---------------------------------------------------------------------------------------------
do $$ declare t text;
begin
  foreach t in array array['households','household_members','zelle_schedules','zelle_payments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;

create policy "household read" on households for select
  using (owner_user_id = auth.uid()
    or exists (select 1 from household_members m where m.household_id = households.id and m.user_id = auth.uid() and m.status <> 'removed')
    or is_staff());
create policy "household members read" on household_members for select
  using (user_id = auth.uid()
    or exists (select 1 from households h where h.id = household_members.household_id and h.owner_user_id = auth.uid())
    or is_staff());
create policy "zelle schedules read" on zelle_schedules for select using (user_id = auth.uid() or is_staff());
create policy "zelle payments read" on zelle_payments for select
  using (exists (select 1 from transfers t where t.id = zelle_payments.transfer_id and t.user_id = auth.uid()) or is_staff());

-- ---------------------------------------------------------------------------------------------
-- Tier-limit usage now includes Zelle sends (money out), and never counts returned transfers.
-- ---------------------------------------------------------------------------------------------
create or replace function harbor__check_limit(p_user uuid, p_limit jsonb, p_amount bigint, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_kinds text[];
  v_today bigint;
  v_month bigint;
begin
  if not harbor__present(p_limit) then
    return;
  end if;
  v_kinds := case p_limit->>'kind'
    when 'transfer_out' then array['ach_out', 'p2p', 'zelle']
    when 'ach_in' then array['ach_in'] end;
  if v_kinds is null then
    raise exception 'harbor:payload_mismatch' using detail = format('unknown limit kind %s', p_limit->>'kind');
  end if;
  select coalesce(sum(amount_cents) filter (where created_at >= (p_limit->>'day_start')::timestamptz), 0),
         coalesce(sum(amount_cents) filter (where created_at >= (p_limit->>'month_start')::timestamptz), 0)
    into v_today, v_month
    from transfers
   where user_id = p_user and kind = any(v_kinds) and status not in ('failed', 'returned') and created_at <= p_at;
  if v_today + p_amount > (p_limit->>'daily_cents')::bigint then
    raise exception 'harbor:daily_limit'
      using detail = format('daily limit %s: used %s, requested %s', p_limit->>'daily_cents', v_today, p_amount);
  end if;
  if v_month + p_amount > (p_limit->>'monthly_cents')::bigint then
    raise exception 'harbor:monthly_limit'
      using detail = format('monthly limit %s: used %s, requested %s', p_limit->>'monthly_cents', v_month, p_amount);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Instant internal transfers between a user's own pockets reuse harbor_pocket_move (kind 'pocket').
-- ---------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------
-- Zelle send: debit the source pocket first, then pull the shortfall from other locked pockets
-- (each re-checked for enough available balance), credit zelle_clearing, record the payment.
-- ---------------------------------------------------------------------------------------------
create or replace function harbor_zelle_send(p_transfer jsonb, p_ledger jsonb, p_payment jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_amount bigint := (p_transfer->>'amount_cents')::bigint;
  v_user uuid := (p_transfer->>'user_id')::uuid;
  v_row record;
  v_uid uuid;
  v_status account_status;
  v_avail bigint;
  v_total bigint := 0;
begin
  if p_transfer->>'kind' is distinct from 'zelle' then
    raise exception 'harbor:payload_mismatch' using detail = 'not a Zelle send';
  end if;
  select * into v_t from transfers where id = (p_transfer->>'id')::uuid;
  if found then
    return jsonb_build_object('transfer_id', v_t.id, 'replayed', true);
  end if;
  if harbor__ledger_net_debit(p_ledger, 'zelle_clearing', null) <> -v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'a Zelle send credits zelle_clearing the full amount';
  end if;
  for v_row in
    select nullif(l->>'party', '')::uuid as acct,
           sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)) as net
    from jsonb_array_elements(coalesce(p_ledger->'lines', '[]'::jsonb)) l
    where l->>'account' = 'customer_deposits'
    group by 1 order by 1
  loop
    if v_row.net <= 0 then
      raise exception 'harbor:payload_mismatch' using detail = 'each funding pocket must be net debited';
    end if;
    select user_id, status into v_uid, v_status from accounts where id = v_row.acct for update;
    if not found then
      raise exception 'harbor:not_found' using detail = 'funding account not found';
    end if;
    if v_uid <> v_user then
      raise exception 'harbor:payload_mismatch' using detail = 'a funding pocket belongs to another customer';
    end if;
    if v_status <> 'open' then
      raise exception 'harbor:invalid_state' using detail = 'a funding pocket is not open';
    end if;
    v_avail := harbor__available_cents(v_row.acct, p_at);
    if v_row.net > v_avail then
      raise exception 'harbor:insufficient_funds' using detail = format('pocket %s: available %s, needed %s', v_row.acct, v_avail, v_row.net);
    end if;
    v_total := v_total + v_row.net;
  end loop;
  if v_total <> v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'funding debits must sum to the amount';
  end if;
  perform harbor__check_limit(v_user, p_limit, v_amount, p_at);
  insert into transfers
  select * from jsonb_populate_record(null::transfers,
    jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer)
  returning * into v_t;
  perform harbor__post_ledger(p_ledger, p_at);
  insert into zelle_payments
  select * from jsonb_populate_record(null::zelle_payments,
    jsonb_build_object('id', gen_random_uuid(), 'status', 'sent', 'created_at', p_at) || p_payment);
  return jsonb_build_object('transfer_id', v_t.id, 'replayed', false);
end $$;

-- Zelle return/refund webhook: reverse the credit back into the source pocket, once per payment.
create or replace function harbor_zelle_return(p_transfer_id uuid, p_code text, p_ledger jsonb, p_at timestamptz,
                                              p_actor uuid, p_audit jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_t transfers;
begin
  select * into v_t from transfers where id = p_transfer_id for update;
  if not found or v_t.kind <> 'zelle' then
    raise exception 'harbor:not_found' using detail = 'Zelle payment not found';
  end if;
  if v_t.status = 'returned' then
    raise exception 'harbor:already_returned' using detail = 'already returned';
  end if;
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', v_t.from_account_id) <> -v_t.amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'a Zelle return credits the source pocket the sent amount';
  end if;
  perform harbor__post_ledger(p_ledger, p_at);
  update transfers set status = 'returned', return_code = null where id = p_transfer_id;
  update zelle_payments set status = 'returned', returned_at = p_at, return_reason = p_code where transfer_id = p_transfer_id;
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'zelle_return', 'transfer', p_transfer_id::text, p_code, p_audit, p_at);
  return jsonb_build_object('reversed', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Envelope auto-close: sweep the remaining balance into primary checking and close the pocket.
-- ---------------------------------------------------------------------------------------------
create or replace function harbor_close_envelope(p_envelope_id uuid, p_primary_checking_id uuid, p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_env accounts;
  v_chk accounts;
  v_bal bigint;
begin
  select * into v_env from accounts where id = p_envelope_id for update;
  if not found or v_env.kind <> 'envelope' or v_env.status <> 'open' then
    return jsonb_build_object('closed', false, 'swept_cents', 0);
  end if;
  if v_env.end_date is not null and (p_at at time zone 'UTC')::date < v_env.end_date then
    return jsonb_build_object('closed', false, 'swept_cents', 0); -- not due yet
  end if;
  if exists (select 1 from holds where account_id = p_envelope_id and status = 'active' and (expires_at is null or expires_at > p_at)) then
    return jsonb_build_object('closed', false, 'swept_cents', 0); -- holds outstanding: retry next run
  end if;
  v_bal := harbor__posted_cents(p_envelope_id);
  if v_bal < 0 then
    return jsonb_build_object('closed', false, 'swept_cents', 0); -- never sweep a negative balance
  end if;
  if v_bal > 0 then
    if harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_envelope_id) <> v_bal
       or harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_primary_checking_id) <> -v_bal then
      raise exception 'harbor:payload_mismatch' using detail = 'sweep must move the envelope balance to primary checking';
    end if;
    select * into v_chk from accounts where id = p_primary_checking_id for update;
    if not found or v_chk.user_id <> v_env.user_id or v_chk.status = 'closed' then
      raise exception 'harbor:not_found' using detail = 'primary checking is unavailable for the sweep';
    end if;
    perform harbor__post_ledger(p_ledger, p_at);
  elsif harbor__present(p_ledger) then
    raise exception 'harbor:payload_mismatch' using detail = 'a zero-balance envelope needs no sweep ledger';
  end if;
  if harbor__posted_cents(p_envelope_id) <> 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'sweep must leave the envelope at zero';
  end if;
  update accounts set status = 'closed', closed_at = p_at where id = p_envelope_id;
  return jsonb_build_object('closed', true, 'swept_cents', v_bal);
end $$;

-- Authorization defaults now include the cashback columns (jsonb_populate_record fills missing
-- fields with NULL, not the column default), so recorded auths start at cashback 0.
create or replace function harbor_card_authorize(p_auth jsonb, p_hold jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
  v_hold_id uuid;
  v_need bigint;
  v_avail bigint;
  v_reason text;
  v_party uuid := (p_auth->>'funding_party')::uuid;
  v_defaults jsonb := jsonb_build_object('fee_cents', 0, 'foreign_txn', false, 'atm_out_of_network', false,
                                         'captured_cents', 0, 'refunded_cents', 0, 'cashback_cents', 0,
                                         'cashback_reversed_cents', 0, 'created_at', p_at);
begin
  select * into v_a from card_authorizations
   where id = (p_auth->>'id')::uuid
      or (p_auth->>'provider_auth_id' is not null and provider_auth_id = p_auth->>'provider_auth_id');
  if found then
    return jsonb_build_object('authorization_id', v_a.id, 'approved', v_a.status <> 'declined',
                              'reason', v_a.decline_reason, 'hold_id', v_a.hold_id, 'replayed', true);
  end if;
  if not harbor__present(p_hold) then
    insert into card_authorizations
    select * from jsonb_populate_record(null::card_authorizations, v_defaults || p_auth)
    returning * into v_a;
    if v_a.status <> 'declined' then
      raise exception 'harbor:payload_mismatch' using detail = 'an approved authorization needs a hold';
    end if;
    return jsonb_build_object('authorization_id', v_a.id, 'approved', false, 'reason', v_a.decline_reason,
                              'hold_id', null, 'replayed', false);
  end if;
  v_need := (p_hold->>'amount_cents')::bigint;
  if v_need is distinct from (p_auth->>'amount_cents')::bigint + coalesce((p_auth->>'fee_cents')::bigint, 0)
     or (p_hold->>'ref_id')::uuid is distinct from (p_auth->>'id')::uuid then
    raise exception 'harbor:payload_mismatch' using detail = 'the hold must cover amount + fees of this authorization';
  end if;
  if p_auth->>'funding_account' = 'family_allowance' then
    if (p_hold->>'family_member_id')::uuid is distinct from v_party or harbor__present(p_hold->'account_id') then
      raise exception 'harbor:payload_mismatch' using detail = 'allowance holds sit on the member pocket';
    end if;
    perform 1 from family_members where id = v_party for update;
    v_avail := harbor__allowance_available_cents(v_party, p_at);
    v_reason := 'allowance_exceeded';
  else
    if (p_hold->>'account_id')::uuid is distinct from v_party then
      raise exception 'harbor:payload_mismatch' using detail = 'card holds sit on the funding account';
    end if;
    perform 1 from accounts where id = v_party for update;
    v_avail := harbor__available_cents(v_party, p_at);
    v_reason := 'insufficient_funds';
  end if;
  if v_need > v_avail then
    insert into card_authorizations
    select * from jsonb_populate_record(null::card_authorizations, v_defaults || p_auth
      || jsonb_build_object('status', 'declined', 'decline_reason', v_reason, 'fee_cents', 0, 'hold_id', null, 'expires_at', p_at))
    returning * into v_a;
    return jsonb_build_object('authorization_id', v_a.id, 'approved', false, 'reason', v_reason,
                              'hold_id', null, 'replayed', false);
  end if;
  insert into holds
  select * from jsonb_populate_record(null::holds,
    jsonb_build_object('id', gen_random_uuid(), 'status', 'active', 'created_at', p_at) || p_hold)
  returning id into v_hold_id;
  insert into card_authorizations
  select * from jsonb_populate_record(null::card_authorizations,
    v_defaults || p_auth || jsonb_build_object('hold_id', v_hold_id))
  returning * into v_a;
  return jsonb_build_object('authorization_id', v_a.id, 'approved', true, 'reason', null,
                            'hold_id', v_hold_id, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Capture / refund now also post cashback (its own balanced ledger txn on the card's account),
-- so we replace the two functions (dropping the old signatures first) with cashback parameters.
-- ---------------------------------------------------------------------------------------------
drop function if exists harbor_card_capture(uuid, bigint, bigint, jsonb, timestamptz);
create or replace function harbor_card_capture(p_auth_id uuid, p_captured_cents bigint, p_fee_cents bigint,
                                               p_ledger jsonb, p_cashback_ledger jsonb, p_cashback_cents bigint,
                                               p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
  v_card_account uuid;
begin
  select * into v_a from card_authorizations where id = p_auth_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'authorization not found';
  end if;
  if v_a.status <> 'authorized' then
    raise exception 'harbor:invalid_state' using detail = format('cannot capture a %s authorization', v_a.status);
  end if;
  if v_a.expires_at <= p_at then
    raise exception 'harbor:auth_expired' using detail = 'authorization expired';
  end if;
  if p_captured_cents <= 0 or p_fee_cents < 0
     or harbor__ledger_net_debit(p_ledger, v_a.funding_account, v_a.funding_party) <> p_captured_cents + p_fee_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'capture must debit the funding pocket captured + fees';
  end if;
  if coalesce(p_cashback_cents, 0) > 0 then
    select account_id into v_card_account from cards where id = v_a.card_id;
    if harbor__ledger_net_debit(p_cashback_ledger, 'cashback_expense', null) <> p_cashback_cents
       or harbor__ledger_net_debit(p_cashback_ledger, 'customer_deposits', v_card_account) <> -p_cashback_cents then
      raise exception 'harbor:payload_mismatch' using detail = 'cashback must be credited to the card''s account';
    end if;
  end if;
  perform harbor__post_ledger(p_ledger, p_at);
  if coalesce(p_cashback_cents, 0) > 0 then
    perform harbor__post_ledger(p_cashback_ledger, p_at);
  end if;
  update holds set status = 'captured', released_at = p_at where id = v_a.hold_id;
  update card_authorizations
     set status = 'captured', captured_cents = p_captured_cents, fee_cents = p_fee_cents,
         cashback_cents = coalesce(p_cashback_cents, 0), captured_at = p_at
   where id = p_auth_id;
  return jsonb_build_object('authorization_id', p_auth_id, 'captured_cents', p_captured_cents, 'fee_cents', p_fee_cents);
end $$;

drop function if exists harbor_card_refund(text, uuid, bigint, jsonb, timestamptz);
create or replace function harbor_card_refund(p_refund_id text, p_auth_id uuid, p_amount_cents bigint,
                                              p_ledger jsonb, p_cashback_reversal_ledger jsonb,
                                              p_cashback_reversal_cents bigint, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
  v_r card_refunds;
  v_card_account uuid;
begin
  select * into v_a from card_authorizations where id = p_auth_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'authorization not found';
  end if;
  select * into v_r from card_refunds where id = p_refund_id;
  if found then
    if v_r.auth_id <> p_auth_id then
      raise exception 'harbor:refund_id_conflict' using detail = 'refund id already used for another purchase';
    end if;
    return jsonb_build_object('duplicate', true, 'refunded_cents', v_a.refunded_cents);
  end if;
  if v_a.status <> 'captured' then
    raise exception 'harbor:invalid_state' using detail = 'refund requires a captured purchase';
  end if;
  if p_amount_cents <= 0 or v_a.refunded_cents + p_amount_cents > v_a.captured_cents then
    raise exception 'harbor:refund_exceeds_captured'
      using detail = format('captured %s, refunded %s, requested %s', v_a.captured_cents, v_a.refunded_cents, p_amount_cents);
  end if;
  if harbor__ledger_net_debit(p_ledger, v_a.funding_account, v_a.funding_party) <> -p_amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'refund must credit the funding pocket the refund amount';
  end if;
  if coalesce(p_cashback_reversal_cents, 0) > 0 then
    if p_cashback_reversal_cents > v_a.cashback_cents - v_a.cashback_reversed_cents then
      raise exception 'harbor:payload_mismatch' using detail = 'cashback reversal exceeds the cashback earned';
    end if;
    select account_id into v_card_account from cards where id = v_a.card_id;
    if harbor__ledger_net_debit(p_cashback_reversal_ledger, 'customer_deposits', v_card_account) <> p_cashback_reversal_cents then
      raise exception 'harbor:payload_mismatch' using detail = 'cashback reversal must debit the card''s account';
    end if;
  end if;
  insert into card_refunds (id, auth_id, amount_cents, created_at) values (p_refund_id, p_auth_id, p_amount_cents, p_at);
  perform harbor__post_ledger(p_ledger, p_at);
  if coalesce(p_cashback_reversal_cents, 0) > 0 then
    perform harbor__post_ledger(p_cashback_reversal_ledger, p_at);
  end if;
  update card_authorizations
     set refunded_cents = refunded_cents + p_amount_cents,
         cashback_reversed_cents = cashback_reversed_cents + coalesce(p_cashback_reversal_cents, 0)
   where id = p_auth_id
  returning * into v_a;
  return jsonb_build_object('duplicate', false, 'refunded_cents', v_a.refunded_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: clients call none of these; the api service role calls the public harbor_* ops.
-- ---------------------------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'harbor\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    if r.proname not like 'harbor\_\_%' then
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;
