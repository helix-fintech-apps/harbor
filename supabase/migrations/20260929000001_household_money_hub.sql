-- Household Money Hub: on-demand accounts (incl. temporary "envelope" pockets), instant internal
-- transfers, households + invited members, per-card limits and an overall household monthly cap,
-- 1% debit-card cashback (reversed on refund), and Zelle bill pay (one-time + recurring, with an
-- automatic shortfall pull from the user's other accounts). New atomic money operations mirror the
-- TypeScript MemoryStore guard for guard (supabase/functions/_shared/app/store.ts).

-- ---------------------------------------------------------------------------------------------
-- Schema changes.
-- ---------------------------------------------------------------------------------------------

-- Envelope accounts are a new kind. (ALTER TYPE ... ADD VALUE autocommits under psql; not used as
-- a value elsewhere in this file, only referenced in later constraints/functions.)
alter type account_kind add value if not exists 'envelope';

-- Two new ledger accounts: cashback rewards paid out, and Zelle payments in flight.
alter table ledger_lines drop constraint ledger_lines_account_check;
alter table ledger_lines add constraint ledger_lines_account_check check (account in (
  'customer_deposits','family_allowance','ach_clearing','card_settlement','zelle_clearing',
  'fee_revenue','cashback_expense','interest_expense','dispute_receivable','dispute_loss',
  'ach_return_loss','closure_payout'));

-- Accounts: a primary flag (the auto-opened checking/savings), plus an envelope date window.
alter table accounts add column is_primary boolean not null default false;
alter table accounts add column envelope_start date;
alter table accounts add column envelope_end date;
update accounts set is_primary = true where kind in ('checking', 'savings');
-- Exactly one primary pocket per kind per user (envelopes and extra pockets are never primary).
drop index accounts_one_live_per_kind;
create unique index accounts_one_primary_per_kind on accounts (user_id, kind)
  where is_primary and status <> 'closed';
alter table accounts add constraint envelope_not_primary check (kind <> 'envelope' or not is_primary);
alter table accounts add constraint envelope_dates check (
  (kind = 'envelope' and envelope_start is not null and envelope_end is not null and envelope_end > envelope_start)
  or (kind <> 'envelope' and envelope_start is null and envelope_end is null));

-- Transfers: two new kinds and Zelle metadata.
alter table transfers drop constraint transfers_kind_check;
alter table transfers add constraint transfers_kind_check check (kind in (
  'ach_in','ach_out','p2p','pocket','allowance_topup','closure_payout','zelle','envelope_sweep'));
alter table transfers add column zelle_recipient text;
alter table transfers add column zelle_provider_id text;
alter table transfers add column memo text;

-- Cards: optional per-card spend limits (all set together, or all null = no card-level cap).
alter table cards add column per_txn_cents bigint;
alter table cards add column daily_cents bigint;
alter table cards add column monthly_cents bigint;
alter table cards add constraint card_limits_consistent check (
  (per_txn_cents is null and daily_cents is null and monthly_cents is null)
  or (per_txn_cents is not null and daily_cents is not null and monthly_cents is not null
      and per_txn_cents >= 0 and per_txn_cents <= daily_cents and daily_cents <= monthly_cents));

-- Card authorizations: cashback earned at capture and how much has been reversed by refunds.
alter table card_authorizations add column cashback_cents bigint not null default 0 check (cashback_cents >= 0);
alter table card_authorizations add column cashback_reversed_cents bigint not null default 0 check (cashback_reversed_cents >= 0);
alter table card_authorizations add constraint cashback_reversed_le_earned check (cashback_reversed_cents <= cashback_cents);

-- Households + invited members.
create table households (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  monthly_cap_cents bigint check (monthly_cap_cents is null or monthly_cap_cents > 0),
  created_at timestamptz not null default now()
);

create table household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references profiles(id),
  invited_email text not null,
  name text not null check (length(trim(name)) > 0),
  relationship text,
  status text not null default 'invited' check (status in ('invited','active','removed')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz
);
create index on household_members (household_id);
create index on household_members (user_id);

-- Recurring Zelle schedules.
create table zelle_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  source_account_id uuid not null references accounts(id),
  recipient text not null,
  amount_cents bigint not null check (amount_cents > 0),
  frequency text not null check (frequency in ('weekly','monthly')),
  status text not null default 'active' check (status in ('active','canceled')),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  created_at timestamptz not null default now()
);
create index on zelle_schedules (status, next_run_at);

-- Zelle returns/refunds arrive as webhooks; each provider return id is processed once.
create table zelle_returns (
  id text primary key,
  transfer_id uuid not null references transfers(id),
  amount_cents bigint not null check (amount_cents > 0),
  return_code text not null,
  created_at timestamptz not null default now()
);
create index on zelle_returns (transfer_id);

-- ---------------------------------------------------------------------------------------------
-- RLS for the new tables (all writes go through the api service role; clients read their own).
-- ---------------------------------------------------------------------------------------------

do $$ declare t text;
begin
  foreach t in array array['households','household_members','zelle_schedules','zelle_returns']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;

create policy "own household" on households for select using (
  owner_user_id = auth.uid()
  or exists (select 1 from household_members m where m.household_id = households.id and m.user_id = auth.uid())
  or is_staff());
create policy "household members" on household_members for select using (
  user_id = auth.uid()
  or exists (select 1 from households h where h.id = household_id and h.owner_user_id = auth.uid())
  or is_staff());
create policy "own zelle schedules" on zelle_schedules for select using (user_id = auth.uid() or is_staff());
create policy "zelle returns" on zelle_returns for select using (
  exists (select 1 from transfers t where t.id = transfer_id and t.user_id = auth.uid()) or is_staff());

-- ---------------------------------------------------------------------------------------------
-- Zelle counts toward the transfer-out limit alongside ACH push and P2P.
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
  v_kinds := case p_limit->>'kind' when 'transfer_out' then array['ach_out', 'p2p', 'zelle'] when 'ach_in' then array['ach_in'] end;
  if v_kinds is null then
    raise exception 'harbor:payload_mismatch' using detail = format('unknown limit kind %s', p_limit->>'kind');
  end if;
  select coalesce(sum(amount_cents) filter (where created_at >= (p_limit->>'day_start')::timestamptz), 0),
         coalesce(sum(amount_cents) filter (where created_at >= (p_limit->>'month_start')::timestamptz), 0)
    into v_today, v_month
    from transfers
   where user_id = p_user and kind = any(v_kinds) and status <> 'failed'
     and not (kind = 'ach_in' and status = 'returned') and created_at <= p_at;
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
-- Zelle send: debit the source account and, for any shortfall, the other accounts named in the
-- ledger, crediting zelle_clearing the full amount. One transfer row; the transfer-out limit is
-- re-checked; replaying the same transfer id posts nothing.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_zelle_send(p_transfer jsonb, p_ledger jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_amount bigint := (p_transfer->>'amount_cents')::bigint;
  v_user uuid := (p_transfer->>'user_id')::uuid;
  v_total bigint;
  v_owner uuid;
  v_status account_status;
  v_row record;
begin
  if p_transfer->>'kind' is distinct from 'zelle' then
    raise exception 'harbor:payload_mismatch' using detail = 'not a Zelle transfer';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_transfer->>'user_id', ''), 42));
  select * into v_t from transfers where id = (p_transfer->>'id')::uuid;
  if found then
    return jsonb_build_object('transfer_id', v_t.id, 'replayed', true);
  end if;
  if harbor__ledger_net_debit(p_ledger, 'zelle_clearing', null) <> -v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'zelle_clearing must be credited the amount';
  end if;
  select coalesce(sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)), 0) into v_total
    from jsonb_array_elements(p_ledger->'lines') l where l->>'account' = 'customer_deposits';
  if v_total <> v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'Zelle debits must total the amount';
  end if;
  perform harbor__check_limit(v_user, p_limit, v_amount, p_at);
  for v_row in
    select nullif(l->>'party', '')::uuid as acct,
           sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)) as debit
    from jsonb_array_elements(p_ledger->'lines') l
    where l->>'account' = 'customer_deposits'
    group by nullif(l->>'party', '')::uuid
    order by nullif(l->>'party', '')::uuid
  loop
    if v_row.debit <= 0 then
      raise exception 'harbor:payload_mismatch' using detail = 'each Zelle source account must be debited a positive amount';
    end if;
    select user_id, status into v_owner, v_status from accounts where id = v_row.acct for update;
    if not found then
      raise exception 'harbor:not_found' using detail = 'source account not found';
    end if;
    if v_owner <> v_user then
      raise exception 'harbor:payload_mismatch' using detail = 'a Zelle source account is not the sender''s';
    end if;
    if v_status <> 'open' then
      raise exception 'harbor:invalid_state' using detail = 'a Zelle source account is not open';
    end if;
    if v_row.debit > harbor__available_cents(v_row.acct, p_at) then
      raise exception 'harbor:insufficient_funds'
        using detail = format('available %s in %s, needed %s', harbor__available_cents(v_row.acct, p_at), v_row.acct, v_row.debit);
    end if;
  end loop;
  insert into transfers
  select * from jsonb_populate_record(null::transfers,
    jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer)
  returning * into v_t;
  perform harbor__post_ledger(p_ledger, p_at);
  return jsonb_build_object('transfer_id', v_t.id, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Zelle return/refund: credit the money back to the source account, once per provider return id,
-- never above the amount sent minus what already came back. Fully returned => transfer returned.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_zelle_return(p_return_id text, p_transfer_id uuid, p_destination_account_id uuid,
                                              p_amount_cents bigint, p_return_code text, p_ledger jsonb,
                                              p_at timestamptz, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_r zelle_returns;
  v_already bigint;
  v_total bigint;
  v_full boolean;
begin
  select * into v_t from transfers where id = p_transfer_id for update;
  if not found or v_t.kind <> 'zelle' then
    raise exception 'harbor:not_found' using detail = 'Zelle payment not found';
  end if;
  select * into v_r from zelle_returns where id = p_return_id;
  if found then
    if v_r.transfer_id <> p_transfer_id then
      raise exception 'harbor:payload_mismatch' using detail = 'return id already used for another payment';
    end if;
    select coalesce(sum(amount_cents), 0) into v_already from zelle_returns where transfer_id = p_transfer_id;
    return jsonb_build_object('duplicate', true, 'returned_cents', v_already, 'fully_returned', v_t.status = 'returned');
  end if;
  if p_amount_cents <= 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'return amount must be positive';
  end if;
  select coalesce(sum(amount_cents), 0) into v_already from zelle_returns where transfer_id = p_transfer_id;
  if v_already + p_amount_cents > v_t.amount_cents then
    raise exception 'harbor:return_exceeds_amount' using detail = 'return exceeds the amount sent';
  end if;
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_destination_account_id) <> -p_amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'a Zelle return credits the source account the return amount';
  end if;
  insert into zelle_returns (id, transfer_id, amount_cents, return_code, created_at)
  values (p_return_id, p_transfer_id, p_amount_cents, p_return_code, p_at);
  perform harbor__post_ledger(p_ledger, p_at);
  v_total := v_already + p_amount_cents;
  v_full := v_total = v_t.amount_cents;
  if v_full then
    update transfers set status = 'returned', return_code = p_return_code where id = p_transfer_id;
  end if;
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'zelle_return', 'transfer', p_transfer_id::text, p_return_code,
          jsonb_build_object('amountCents', p_amount_cents), p_at);
  return jsonb_build_object('duplicate', false, 'returned_cents', v_total, 'fully_returned', v_full);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Envelope auto-close: sweep the remaining balance into primary checking and close the envelope.
-- Aborts if the balance changed since planning or the envelope has an active hold.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_envelope_sweep_close(p_envelope_account_id uuid, p_checking_account_id uuid,
                                                       p_user_id uuid, p_expected_posted_cents bigint,
                                                       p_ledger jsonb, p_transfer jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_env accounts;
  v_chk accounts;
begin
  select * into v_env from accounts where id = p_envelope_account_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'envelope account not found';
  end if;
  if v_env.user_id <> p_user_id then
    raise exception 'harbor:payload_mismatch' using detail = 'envelope belongs to another customer';
  end if;
  if v_env.kind <> 'envelope' then
    raise exception 'harbor:invalid_state' using detail = 'not an envelope account';
  end if;
  if v_env.status = 'closed' then
    raise exception 'harbor:already_closed' using detail = 'envelope already closed';
  end if;
  select * into v_chk from accounts where id = p_checking_account_id for update;
  if not found or v_chk.user_id <> p_user_id or v_chk.kind <> 'checking' or v_chk.status = 'closed' then
    raise exception 'harbor:not_found' using detail = 'primary checking account not found';
  end if;
  if exists (select 1 from holds where account_id = p_envelope_account_id and status = 'active'
                                    and (expires_at is null or expires_at > p_at)) then
    raise exception 'harbor:closure_state_changed' using detail = 'envelope has an active hold';
  end if;
  if harbor__posted_cents(p_envelope_account_id) <> p_expected_posted_cents then
    raise exception 'harbor:closure_state_changed' using detail = 'envelope balance changed while sweeping';
  end if;
  if harbor__present(p_ledger) then
    if harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_envelope_account_id) <> p_expected_posted_cents
       or harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_checking_account_id) <> -p_expected_posted_cents then
      raise exception 'harbor:payload_mismatch' using detail = 'sweep must move the envelope balance into checking';
    end if;
    perform harbor__post_ledger(p_ledger, p_at);
    if harbor__present(p_transfer) then
      insert into transfers
      select * from jsonb_populate_record(null::transfers,
        jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer);
    end if;
  elsif p_expected_posted_cents <> 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'a non-zero sweep needs a ledger txn';
  end if;
  if harbor__posted_cents(p_envelope_account_id) <> 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'sweep must leave the envelope at zero';
  end if;
  update accounts set status = 'closed', closed_at = p_at where id = p_envelope_account_id;
  return jsonb_build_object('swept_cents', p_expected_posted_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Redefine harbor_card_authorize so its jsonb_populate_record inserts default the new NOT NULL
-- cashback columns to 0 (same body as migration ...000004, with two added defaults).
-- ---------------------------------------------------------------------------------------------

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
-- Privileges: clients call none of these; the api function (service role) calls the new operations.
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
