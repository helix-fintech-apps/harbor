-- Atomic money operations.
--
-- Every money operation that writes more than one row is ONE Postgres function, called by the
-- `api` Edge Function (service role) through RPC, so the whole operation commits or none of it
-- does. The TypeScript domain (`supabase/functions/_shared/domain`) still computes the plan
-- (amounts, fees, ledger lines, holds, deadlines); these functions persist that plan atomically
-- and re-check, under row locks, the guards a concurrent request could invalidate between
-- planning and writing:
--   * state transitions are compare-and-set (capture, settle, return, expiry, dispute steps),
--   * debits and card holds need enough available balance (posted - active holds at p_at),
--   * tier limits (transfers out, ACH deposits) still hold for the window the domain computed,
--   * refunds never exceed captured - refunded; one open dispute per purchase,
--   * closure pays out exactly the planned balances and leaves every pocket at zero,
--   * the ledger payload is balanced and agrees with the business rows it belongs to.
-- A guard failure raises `harbor:<code>` (SQLSTATE P0001, detail = explanation) and rolls the
-- whole call back. The service maps codes to API errors. `MemoryStore` (tests + demo mode)
-- implements the same operations with the same guards (see _shared/app/store.ts).
-- Replaying a call for the same business key (transfer id, auth id, refund id, dispute id,
-- account+period) never posts twice.

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (not callable by clients or the service role directly).
-- ---------------------------------------------------------------------------------------------

create or replace function harbor__present(p jsonb) returns boolean
language sql immutable as $$
  select p is not null and jsonb_typeof(p) <> 'null'
$$;

-- Net debit (debits - credits) that a ledger payload posts to one (account, party).
create or replace function harbor__ledger_net_debit(p_ledger jsonb, p_account text, p_party uuid) returns bigint
language sql immutable as $$
  select coalesce(sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)), 0)::bigint
  from jsonb_array_elements(coalesce(p_ledger->'lines', '[]'::jsonb)) l
  where l->>'account' = p_account and nullif(l->>'party', '')::uuid is not distinct from p_party
$$;

-- Posted balance of a customer pocket (customer_deposits, party = account id).
create or replace function harbor__posted_cents(p_account uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(credit - debit), 0)::bigint from ledger_lines where account = 'customer_deposits' and party = p_account
$$;

-- Available = posted - active holds (a hold stops counting once it expires), evaluated at p_at.
create or replace function harbor__available_cents(p_account uuid, p_at timestamptz) returns bigint
language sql stable security definer set search_path = public as $$
  select harbor__posted_cents(p_account)
       - coalesce((select sum(h.amount_cents) from holds h
                   where h.account_id = p_account and h.status = 'active'
                     and (h.expires_at is null or h.expires_at > p_at)), 0)::bigint
$$;

-- Teen allowance pocket (family_allowance, party = member id) and its card holds.
create or replace function harbor__allowance_posted_cents(p_member uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(credit - debit), 0)::bigint from ledger_lines where account = 'family_allowance' and party = p_member
$$;

create or replace function harbor__allowance_available_cents(p_member uuid, p_at timestamptz) returns bigint
language sql stable security definer set search_path = public as $$
  select harbor__allowance_posted_cents(p_member)
       - coalesce((select sum(h.amount_cents) from holds h
                   where h.account_id is null and h.family_member_id = p_member and h.status = 'active'
                     and (h.expires_at is null or h.expires_at > p_at)), 0)::bigint
$$;

-- Re-check a tier limit for the window the domain computed, under the caller's account lock.
-- p_limit = {"kind": "transfer_out" | "ach_in", "daily_cents", "monthly_cents", "day_start", "month_start"}
-- Usage mirrors domain/limits.ts: transfers out = ach_out + p2p; deposits = ach_in not returned;
-- failed transfers never count; only transfers created at or before p_at count.
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
  v_kinds := case p_limit->>'kind' when 'transfer_out' then array['ach_out', 'p2p'] when 'ach_in' then array['ach_in'] end;
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

-- Post one balanced ledger txn at p_at. Idempotent on p_ledger->>'idem'.
-- p_ledger = {"kind": text, "ref": text, "idem": text, "lines": [{"account","party","debit","credit"}]}
create or replace function harbor__post_ledger(p_ledger jsonb, p_at timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_lines int;
  v_net bigint;
  v_bad int;
begin
  if not harbor__present(p_ledger) or jsonb_typeof(p_ledger->'lines') is distinct from 'array' then
    raise exception 'harbor:unbalanced_ledger' using detail = 'ledger payload has no lines';
  end if;
  select count(*),
         coalesce(sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)), 0),
         count(*) filter (where coalesce((l->>'debit')::bigint, 0) < 0 or coalesce((l->>'credit')::bigint, 0) < 0)
    into v_lines, v_net, v_bad
    from jsonb_array_elements(p_ledger->'lines') l;
  if v_lines = 0 or v_net <> 0 or v_bad > 0 then
    raise exception 'harbor:unbalanced_ledger'
      using detail = format('ledger txn %s: %s lines, debits - credits = %s', p_ledger->>'kind', v_lines, v_net);
  end if;
  if p_ledger->>'idem' is not null then
    select id into v_id from ledger_txns where idempotency_key = p_ledger->>'idem';
    if found then
      return v_id;
    end if;
  end if;
  insert into ledger_txns (kind, ref, idempotency_key, created_at)
  values (p_ledger->>'kind', p_ledger->>'ref', p_ledger->>'idem', coalesce(p_at, now()))
  returning id into v_id;
  insert into ledger_lines (txn_id, account, party, debit, credit)
  select v_id, x.l->>'account', nullif(x.l->>'party', '')::uuid,
         coalesce((x.l->>'debit')::bigint, 0), coalesce((x.l->>'credit')::bigint, 0)
  from jsonb_array_elements(p_ledger->'lines') with ordinality as x(l, n)
  order by x.n;
  return v_id;
end $$;

-- Money out of a customer pocket: lock the source account, re-check the tier limit (if any) and
-- available >= amount + fee, insert the transfer and post its ledger txn. Replaying the same
-- transfer id posts nothing.
create or replace function harbor__transfer_out(p_kind text, p_transfer jsonb, p_ledger jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_from uuid := (p_transfer->>'from_account_id')::uuid;
  v_need bigint := (p_transfer->>'amount_cents')::bigint + coalesce((p_transfer->>'fee_cents')::bigint, 0);
  v_avail bigint;
begin
  if p_transfer->>'kind' is distinct from p_kind then
    raise exception 'harbor:payload_mismatch' using detail = format('expected a %s transfer, got %s', p_kind, p_transfer->>'kind');
  end if;
  select * into v_t from transfers where id = (p_transfer->>'id')::uuid;
  if found then
    return jsonb_build_object('transfer_id', v_t.id, 'replayed', true);
  end if;
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', v_from) <> v_need then
    raise exception 'harbor:payload_mismatch'
      using detail = format('ledger debits %s from the source account, transfer amount + fee is %s',
                            harbor__ledger_net_debit(p_ledger, 'customer_deposits', v_from), v_need);
  end if;
  perform 1 from accounts where id = v_from for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'source account not found';
  end if;
  perform harbor__check_limit((p_transfer->>'user_id')::uuid, p_limit, (p_transfer->>'amount_cents')::bigint, p_at);
  v_avail := harbor__available_cents(v_from, p_at);
  if v_need > v_avail then
    raise exception 'harbor:insufficient_funds' using detail = format('available %s, needed %s', v_avail, v_need);
  end if;
  insert into transfers
  select * from jsonb_populate_record(null::transfers,
    jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer)
  returning * into v_t;
  perform harbor__post_ledger(p_ledger, p_at);
  return jsonb_build_object('transfer_id', v_t.id, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Money in: ACH pull (transfer + credit + deposit hold), settlement, return (reversal/claw-back).
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_ach_pull_create(p_transfer jsonb, p_ledger jsonb, p_hold jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_amount bigint := (p_transfer->>'amount_cents')::bigint;
begin
  if p_transfer->>'kind' is distinct from 'ach_in' then
    raise exception 'harbor:payload_mismatch' using detail = 'not an ACH pull';
  end if;
  select * into v_t from transfers where id = (p_transfer->>'id')::uuid;
  if found then
    return jsonb_build_object('transfer_id', v_t.id, 'replayed', true);
  end if;
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', (p_transfer->>'to_account_id')::uuid) <> -v_amount
     or (p_hold->>'amount_cents')::bigint is distinct from v_amount
     or (p_hold->>'ref_id')::uuid is distinct from (p_transfer->>'id')::uuid
     or (p_hold->>'account_id')::uuid is distinct from (p_transfer->>'to_account_id')::uuid then
    raise exception 'harbor:payload_mismatch' using detail = 'ACH pull credit, deposit hold and transfer must agree';
  end if;
  -- Serialize deposits into this account so the daily deposit limit can't be raced.
  perform 1 from accounts where id = (p_transfer->>'to_account_id')::uuid for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'destination account not found';
  end if;
  perform harbor__check_limit((p_transfer->>'user_id')::uuid, p_limit, v_amount, p_at);
  insert into transfers
  select * from jsonb_populate_record(null::transfers,
    jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer)
  returning * into v_t;
  perform harbor__post_ledger(p_ledger, p_at);
  insert into holds
  select * from jsonb_populate_record(null::holds,
    jsonb_build_object('id', gen_random_uuid(), 'status', 'active', 'created_at', p_at) || p_hold);
  return jsonb_build_object('transfer_id', v_t.id, 'replayed', false);
end $$;

-- Settle one due, pending transfer and release its deposit hold. false = nothing to do.
create or replace function harbor_ach_settle(p_transfer_id uuid, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update transfers set status = 'settled', settled_at = p_at
   where id = p_transfer_id and status = 'pending' and settle_at is not null and settle_at <= p_at;
  if not found then
    return false;
  end if;
  update holds set status = 'released', released_at = p_at where ref_id = p_transfer_id and status = 'active';
  return true;
end $$;

-- ACH return: reverse the credit (may leave a negative balance after settlement), release a
-- deposit hold that is still active, mark the transfer returned, audit. A transfer is returned once.
create or replace function harbor_ach_return(p_transfer_id uuid, p_code text, p_ledger jsonb, p_at timestamptz,
                                             p_actor uuid, p_audit jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t transfers;
  v_released int;
begin
  select * into v_t from transfers where id = p_transfer_id for update;
  if not found or v_t.kind <> 'ach_in' then
    raise exception 'harbor:not_found' using detail = 'ACH deposit not found';
  end if;
  if v_t.status = 'returned' then
    raise exception 'harbor:already_returned' using detail = format('already returned (%s)', v_t.return_code);
  end if;
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', v_t.to_account_id) <> v_t.amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'a return reverses exactly the deposited amount';
  end if;
  perform harbor__post_ledger(p_ledger, p_at);
  update holds set status = 'released', released_at = p_at where ref_id = p_transfer_id and status = 'active';
  get diagnostics v_released = row_count;
  update transfers set status = 'returned', return_code = p_code where id = p_transfer_id;
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'ach_return', 'transfer', p_transfer_id::text, p_code, p_audit, p_at);
  return jsonb_build_object('released_holds', v_released);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Money out: ACH push (standard / instant + fee), P2P, pocket move, teen allowance top-up.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_ach_push(p_transfer jsonb, p_ledger jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if harbor__ledger_net_debit(p_ledger, 'fee_revenue', null) <> -coalesce((p_transfer->>'fee_cents')::bigint, 0) then
    raise exception 'harbor:payload_mismatch' using detail = 'fee revenue must equal the transfer fee';
  end if;
  return harbor__transfer_out('ach_out', p_transfer, p_ledger, p_limit, p_at);
end $$;

create or replace function harbor_p2p_transfer(p_transfer jsonb, p_ledger jsonb, p_payee jsonb, p_limit jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', (p_transfer->>'to_account_id')::uuid)
     <> -(p_transfer->>'amount_cents')::bigint then
    raise exception 'harbor:payload_mismatch' using detail = 'recipient must be credited the transfer amount';
  end if;
  v_result := harbor__transfer_out('p2p', p_transfer, p_ledger, p_limit, p_at);
  if harbor__present(p_payee) and not (v_result->>'replayed')::boolean then
    insert into payees (user_id, payee_user_id, first_paid_at)
    values ((p_payee->>'user_id')::uuid, (p_payee->>'payee_user_id')::uuid, coalesce((p_payee->>'first_paid_at')::timestamptz, p_at))
    on conflict (user_id, payee_user_id) do nothing;
  end if;
  return v_result;
end $$;

create or replace function harbor_pocket_move(p_transfer jsonb, p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if harbor__ledger_net_debit(p_ledger, 'customer_deposits', (p_transfer->>'to_account_id')::uuid)
     <> -(p_transfer->>'amount_cents')::bigint then
    raise exception 'harbor:payload_mismatch' using detail = 'destination pocket must be credited the amount';
  end if;
  return harbor__transfer_out('pocket', p_transfer, p_ledger, null, p_at);
end $$;

create or replace function harbor_allowance_topup(p_transfer jsonb, p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if harbor__ledger_net_debit(p_ledger, 'family_allowance', (p_transfer->>'family_member_id')::uuid)
     <> -(p_transfer->>'amount_cents')::bigint then
    raise exception 'harbor:payload_mismatch' using detail = 'allowance pocket must be credited the amount';
  end if;
  return harbor__transfer_out('allowance_topup', p_transfer, p_ledger, null, p_at);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Cards: authorization + hold, capture (partial / over-capture), expiry, merchant refund.
-- ---------------------------------------------------------------------------------------------

-- Record an authorization. With a hold (approved by the domain), the funding pocket is locked
-- and its available balance re-checked; if it no longer covers the hold, the auth is recorded
-- as declined (insufficient_funds / allowance_exceeded) and no hold is placed.
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
                                         'captured_cents', 0, 'refunded_cents', 0, 'created_at', p_at);
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

-- Capture (settle) an authorization: post captured + fees from the funding pocket, the hold is
-- consumed, the auth records what was captured. Only an unexpired `authorized` auth can be captured.
create or replace function harbor_card_capture(p_auth_id uuid, p_captured_cents bigint, p_fee_cents bigint,
                                               p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
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
  perform harbor__post_ledger(p_ledger, p_at);
  update holds set status = 'captured', released_at = p_at where id = v_a.hold_id;
  update card_authorizations
     set status = 'captured', captured_cents = p_captured_cents, fee_cents = p_fee_cents, captured_at = p_at
   where id = p_auth_id;
  return jsonb_build_object('authorization_id', p_auth_id, 'captured_cents', p_captured_cents, 'fee_cents', p_fee_cents);
end $$;

-- Expire an uncaptured authorization whose validity has passed and release its hold.
create or replace function harbor_card_expire_auth(p_auth_id uuid, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_hold uuid;
begin
  update card_authorizations set status = 'expired'
   where id = p_auth_id and status = 'authorized' and expires_at <= p_at
  returning hold_id into v_hold;
  if not found then
    return false;
  end if;
  update holds set status = 'expired', released_at = p_at where id = v_hold;
  return true;
end $$;

-- Merchant refund: posted once per network refund id, never more than captured - refunded.
create or replace function harbor_card_refund(p_refund_id text, p_auth_id uuid, p_amount_cents bigint,
                                              p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
  v_r card_refunds;
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
  insert into card_refunds (id, auth_id, amount_cents, created_at) values (p_refund_id, p_auth_id, p_amount_cents, p_at);
  perform harbor__post_ledger(p_ledger, p_at);
  update card_authorizations set refunded_cents = refunded_cents + p_amount_cents where id = p_auth_id
  returning * into v_a;
  return jsonb_build_object('duplicate', false, 'refunded_cents', v_a.refunded_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Disputes (Reg E): open, provisional credit, resolve (won keeps the credit, lost reverses it).
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_dispute_open(p_dispute jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_a card_authorizations;
  v_d disputes;
begin
  select * into v_d from disputes where id = (p_dispute->>'id')::uuid;
  if found then
    return to_jsonb(v_d);
  end if;
  select * into v_a from card_authorizations where id = (p_dispute->>'auth_id')::uuid for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'transaction not found';
  end if;
  if v_a.status <> 'captured' then
    raise exception 'harbor:invalid_state' using detail = 'only posted (captured) purchases can be disputed';
  end if;
  if p_dispute->>'credit_account' is distinct from v_a.funding_account
     or (p_dispute->>'credit_party')::uuid is distinct from v_a.funding_party then
    raise exception 'harbor:payload_mismatch' using detail = 'a dispute credits the pocket that paid';
  end if;
  if exists (select 1 from disputes where auth_id = v_a.id and status in ('open', 'provisional_credited')) then
    raise exception 'harbor:dispute_already_open' using detail = 'a dispute is already open for this transaction';
  end if;
  if (p_dispute->>'amount_cents')::bigint > v_a.captured_cents - v_a.refunded_cents then
    raise exception 'harbor:dispute_exceeds_amount' using detail = 'dispute exceeds the unrefunded purchase amount';
  end if;
  insert into disputes
  select * from jsonb_populate_record(null::disputes,
    jsonb_build_object('status', 'open', 'provisional_credit_cents', 0, 'opened_at', p_at) || p_dispute)
  returning * into v_d;
  return to_jsonb(v_d);
end $$;

create or replace function harbor_dispute_provisional_credit(p_dispute_id uuid, p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_d disputes;
begin
  select * into v_d from disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'dispute not found';
  end if;
  if v_d.status <> 'open' then
    raise exception 'harbor:invalid_state' using detail = format('provisional credit not allowed in %s', v_d.status);
  end if;
  if harbor__ledger_net_debit(p_ledger, v_d.credit_account, v_d.credit_party) <> -v_d.amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'provisional credit must equal the disputed amount';
  end if;
  perform harbor__post_ledger(p_ledger, p_at);
  update disputes set status = 'provisional_credited', provisional_credit_cents = amount_cents
   where id = p_dispute_id
  returning * into v_d;
  return jsonb_build_object('id', v_d.id, 'status', v_d.status, 'provisional_credit_cents', v_d.provisional_credit_cents);
end $$;

-- The ledger for a resolution depends on whether provisional credit was given, so the caller
-- names the status it planned from (p_expected_status); a concurrent change aborts the call.
create or replace function harbor_dispute_resolve(p_dispute_id uuid, p_outcome text, p_expected_status text,
                                                  p_provisional_credit_cents bigint, p_ledger jsonb,
                                                  p_at timestamptz, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_d disputes;
begin
  if p_outcome is null or p_outcome not in ('won', 'lost') then
    raise exception 'harbor:payload_mismatch' using detail = 'outcome must be won or lost';
  end if;
  select * into v_d from disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'dispute not found';
  end if;
  if v_d.status not in ('open', 'provisional_credited') then
    raise exception 'harbor:invalid_state' using detail = format('dispute already %s', v_d.status);
  end if;
  if v_d.status <> p_expected_status then
    raise exception 'harbor:invalid_state' using detail = format('dispute moved to %s while resolving', v_d.status);
  end if;
  if harbor__present(p_ledger) then
    perform harbor__post_ledger(p_ledger, p_at);
  end if;
  update disputes set status = p_outcome, provisional_credit_cents = p_provisional_credit_cents, resolved_at = p_at
   where id = p_dispute_id
  returning * into v_d;
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'dispute_resolved', 'dispute', p_dispute_id::text, p_outcome, null, p_at);
  return jsonb_build_object('id', v_d.id, 'status', v_d.status, 'provisional_credit_cents', v_d.provisional_credit_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Savings interest: monthly posting (row + ledger), once per account and period.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_post_interest(p_posting jsonb, p_ledger jsonb, p_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into interest_postings
  select * from jsonb_populate_record(null::interest_postings, jsonb_build_object('created_at', p_at) || p_posting)
  on conflict (account_id, period) do nothing;
  if not found then
    return false;
  end if;
  if harbor__present(p_ledger) then
    if harbor__ledger_net_debit(p_ledger, 'customer_deposits', (p_posting->>'account_id')::uuid)
       <> -(p_posting->>'posted_cents')::bigint then
      raise exception 'harbor:payload_mismatch' using detail = 'interest ledger must credit posted_cents';
    end if;
    perform harbor__post_ledger(p_ledger, p_at);
  elsif (p_posting->>'posted_cents')::bigint <> 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'posted interest needs a ledger txn';
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Account closure: cancel cards, pay out every pocket (incl. teen allowances) in one ledger txn,
-- record the payout transfer, close accounts, remove family members, record the closure, audit.
-- p_expected = {"accounts": [{"id", "posted_cents"}], "members": [{"id", "posted_cents"}]} is what
-- the plan paid out; if anything moved since (balance, new hold, new dispute) the call aborts.
-- ---------------------------------------------------------------------------------------------

create or replace function harbor_close_account(p_user_id uuid, p_closure jsonb, p_expected jsonb, p_ledger jsonb,
                                                p_payout_transfer jsonb, p_at timestamptz, p_actor uuid,
                                                p_audit jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_accounts uuid[];
  v_members uuid[];
  v_row record;
  v_canceled uuid[];
begin
  select coalesce(array_agg((e->>'id')::uuid order by e->>'id'), '{}') into v_accounts
    from jsonb_array_elements(coalesce(p_expected->'accounts', '[]'::jsonb)) e;
  select coalesce(array_agg((e->>'id')::uuid order by e->>'id'), '{}') into v_members
    from jsonb_array_elements(coalesce(p_expected->'members', '[]'::jsonb)) e;
  if cardinality(v_accounts) = 0 then
    raise exception 'harbor:already_closed' using detail = 'no open accounts to close';
  end if;
  -- Lock the pockets (fixed order) so no money moves on them until we commit.
  for v_row in select id, user_id, status from accounts where id = any(v_accounts) order by id for update loop
    if v_row.user_id <> p_user_id then
      raise exception 'harbor:payload_mismatch' using detail = 'account belongs to another customer';
    end if;
    if v_row.status = 'closed' then
      raise exception 'harbor:already_closed' using detail = 'account already closed';
    end if;
  end loop;
  if (select count(*) from accounts where id = any(v_accounts)) <> cardinality(v_accounts)
     or exists (select 1 from accounts where user_id = p_user_id and status <> 'closed' and not (id = any(v_accounts))) then
    raise exception 'harbor:closure_state_changed' using detail = 'the set of open pockets changed';
  end if;
  perform 1 from family_members where id = any(v_members) order by id for update;
  for v_row in select (e->>'id')::uuid as id, (e->>'posted_cents')::bigint as posted
                 from jsonb_array_elements(p_expected->'accounts') e loop
    if harbor__posted_cents(v_row.id) <> v_row.posted then
      raise exception 'harbor:closure_state_changed' using detail = 'a pocket balance changed while closing';
    end if;
  end loop;
  for v_row in select (e->>'id')::uuid as id, (e->>'posted_cents')::bigint as posted
                 from jsonb_array_elements(coalesce(p_expected->'members', '[]'::jsonb)) e loop
    if harbor__allowance_posted_cents(v_row.id) <> v_row.posted then
      raise exception 'harbor:closure_state_changed' using detail = 'an allowance balance changed while closing';
    end if;
  end loop;
  if exists (select 1 from holds
              where status = 'active' and (expires_at is null or expires_at > p_at)
                and (account_id = any(v_accounts) or family_member_id = any(v_members))) then
    raise exception 'harbor:closure_state_changed' using detail = 'pending holds';
  end if;
  if exists (select 1 from disputes where user_id = p_user_id and status in ('open', 'provisional_credited')) then
    raise exception 'harbor:closure_state_changed' using detail = 'open disputes';
  end if;

  with c as (
    update cards set status = 'canceled', canceled_at = p_at
     where account_id = any(v_accounts) and status not in ('canceled', 'replaced')
    returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_canceled from c;

  if harbor__present(p_ledger) then
    perform harbor__post_ledger(p_ledger, p_at);
    insert into transfers
    select * from jsonb_populate_record(null::transfers,
      jsonb_build_object('id', gen_random_uuid(), 'fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_payout_transfer);
  end if;
  -- Post-condition: every pocket and allowance pocket is at exactly zero.
  if exists (select 1 from unnest(v_accounts) a where harbor__posted_cents(a) <> 0)
     or exists (select 1 from unnest(v_members) m where harbor__allowance_posted_cents(m) <> 0) then
    raise exception 'harbor:payload_mismatch' using detail = 'closure payout must leave every pocket at zero';
  end if;

  update accounts set status = 'closed', closed_at = p_at where id = any(v_accounts);
  update family_members set status = 'removed' where id = any(v_members);
  insert into closures
  select * from jsonb_populate_record(null::closures,
    jsonb_build_object('status', 'completed', 'blocks', '[]'::jsonb, 'created_at', p_at) || p_closure);
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'account_closed', 'profile', p_user_id::text, null, p_audit, p_at);
  return jsonb_build_object('closure_id', p_closure->>'id', 'canceled_card_ids', to_jsonb(v_canceled));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: clients (anon / authenticated) can call none of these. The `api` function (service
-- role) calls the public `harbor_*` operations; the `harbor__*` helpers are internal.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  r record;
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
