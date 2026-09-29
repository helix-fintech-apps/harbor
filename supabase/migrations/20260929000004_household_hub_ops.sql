-- Household money hub atomic money operations. Same contract as 20260924000004_atomic_money_ops.sql:
-- one Postgres function per multi-row money operation, called by the api function (service role) via
-- RPC, guarded and re-checked under row locks, raising `harbor:<code>` and rolling back on failure.
-- MemoryStore mirrors each of these guard-for-guard (see _shared/app/store.ts).

-- ---------------------------------------------------------------------------------------------
-- Cards: capture and refund gain an optional cashback ledger (1% of settled debit spend, credited
-- to the card's account; reversed proportionally on refund). Posted in the same transaction.
-- ---------------------------------------------------------------------------------------------
drop function if exists harbor_card_capture(uuid, bigint, bigint, jsonb, timestamptz);
create or replace function harbor_card_capture(p_auth_id uuid, p_captured_cents bigint, p_fee_cents bigint,
                                               p_ledger jsonb, p_cashback jsonb, p_at timestamptz) returns jsonb
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
  if harbor__present(p_cashback) then
    if harbor__ledger_net_debit(p_cashback, 'cashback_expense', null) <= 0 then
      raise exception 'harbor:payload_mismatch' using detail = 'cashback must be funded from cashback_expense';
    end if;
    perform harbor__post_ledger(p_cashback, p_at);
  end if;
  return jsonb_build_object('authorization_id', p_auth_id, 'captured_cents', p_captured_cents, 'fee_cents', p_fee_cents);
end $$;

drop function if exists harbor_card_refund(text, uuid, bigint, jsonb, timestamptz);
create or replace function harbor_card_refund(p_refund_id text, p_auth_id uuid, p_amount_cents bigint,
                                              p_ledger jsonb, p_cashback jsonb, p_at timestamptz) returns jsonb
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
  if harbor__present(p_cashback) then
    if harbor__ledger_net_debit(p_cashback, 'cashback_expense', null) >= 0 then
      raise exception 'harbor:payload_mismatch' using detail = 'cashback reversal must credit cashback_expense';
    end if;
    perform harbor__post_ledger(p_cashback, p_at);
  end if;
  update card_authorizations set refunded_cents = refunded_cents + p_amount_cents where id = p_auth_id
  returning * into v_a;
  return jsonb_build_object('duplicate', false, 'refunded_cents', v_a.refunded_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Envelopes: sweep the remaining balance into the primary checking pocket and close, atomically.
-- Compare-and-set on the envelope balance so a deposit landing just before close isn't stranded.
-- ---------------------------------------------------------------------------------------------
create or replace function harbor_envelope_sweep_close(p_user_id uuid, p_envelope_account_id uuid,
                                                       p_checking_account_id uuid, p_expected_remaining_cents bigint,
                                                       p_transfer jsonb, p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_env accounts;
  v_chk accounts;
  v_remaining bigint;
begin
  select * into v_env from accounts where id = p_envelope_account_id for update;
  if not found or v_env.user_id <> p_user_id or v_env.kind <> 'envelope' then
    raise exception 'harbor:not_found' using detail = 'envelope not found';
  end if;
  if v_env.status = 'closed' then
    return jsonb_build_object('closed', false, 'swept_cents', 0);
  end if;
  v_remaining := harbor__posted_cents(p_envelope_account_id);
  if v_remaining <> p_expected_remaining_cents then
    raise exception 'harbor:closure_state_changed' using detail = 'the envelope balance changed while closing';
  end if;
  if exists (select 1 from holds
              where account_id = p_envelope_account_id and status = 'active'
                and (expires_at is null or expires_at > p_at)) then
    raise exception 'harbor:closure_state_changed' using detail = 'the envelope has pending holds';
  end if;
  if v_remaining > 0 then
    if not harbor__present(p_ledger) or not harbor__present(p_transfer) then
      raise exception 'harbor:payload_mismatch' using detail = 'a non-empty envelope needs a sweep ledger and transfer';
    end if;
    select * into v_chk from accounts where id = p_checking_account_id for update;
    if not found or v_chk.user_id <> p_user_id or v_chk.status <> 'open' then
      raise exception 'harbor:not_found' using detail = 'primary checking account not found';
    end if;
    if harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_envelope_account_id) <> v_remaining
       or harbor__ledger_net_debit(p_ledger, 'customer_deposits', p_checking_account_id) <> -v_remaining then
      raise exception 'harbor:payload_mismatch' using detail = 'the sweep must move the whole balance into checking';
    end if;
    perform harbor__post_ledger(p_ledger, p_at);
    insert into transfers
    select * from jsonb_populate_record(null::transfers,
      jsonb_build_object('fee_cents', 0, 'new_payee', false, 'created_at', p_at) || p_transfer);
  end if;
  if harbor__posted_cents(p_envelope_account_id) <> 0 then
    raise exception 'harbor:payload_mismatch' using detail = 'the envelope must be empty after the sweep';
  end if;
  update accounts set status = 'closed', closed_at = p_at where id = p_envelope_account_id;
  return jsonb_build_object('closed', true, 'swept_cents', v_remaining);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Zelle send: fund from one or more of the user's accounts (source first, shortfall from others).
-- Locks each contributing account and re-checks its available balance before the money leaves.
-- ---------------------------------------------------------------------------------------------
create or replace function harbor_zelle_send(p_user_id uuid, p_payment jsonb, p_funding jsonb,
                                             p_ledger jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_p zelle_payments;
  v_amount bigint := (p_payment->>'amount_cents')::bigint;
  v_leg_total bigint;
  v_row record;
  v_acct accounts;
  v_avail bigint;
begin
  select * into v_p from zelle_payments where id = (p_payment->>'id')::uuid;
  if found then
    return jsonb_build_object('replayed', true);
  end if;
  select coalesce(sum((l->>'cents')::bigint), 0) into v_leg_total
    from jsonb_array_elements(coalesce(p_funding, '[]'::jsonb)) l;
  if v_leg_total <> v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'the funding legs must sum to the payment amount';
  end if;
  if harbor__ledger_net_debit(p_ledger, 'zelle_clearing', null) <> -v_amount then
    raise exception 'harbor:payload_mismatch' using detail = 'a Zelle send credits zelle_clearing the full amount';
  end if;
  for v_row in
    select (l->>'account_id')::uuid as account_id, (l->>'cents')::bigint as cents
    from jsonb_array_elements(p_funding) l order by (l->>'account_id')
  loop
    select * into v_acct from accounts where id = v_row.account_id for update;
    if not found or v_acct.user_id <> p_user_id then
      raise exception 'harbor:not_found' using detail = 'funding account not found';
    end if;
    if v_acct.status <> 'open' then
      raise exception 'harbor:closure_state_changed' using detail = 'a funding account is not open';
    end if;
    if harbor__ledger_net_debit(p_ledger, 'customer_deposits', v_row.account_id) <> v_row.cents then
      raise exception 'harbor:payload_mismatch' using detail = 'each funding leg must debit its account for its share';
    end if;
    v_avail := harbor__available_cents(v_row.account_id, p_at);
    if v_row.cents > v_avail then
      raise exception 'harbor:insufficient_funds'
        using detail = format('available %s on %s, needed %s', v_avail, v_row.account_id, v_row.cents);
    end if;
  end loop;
  insert into zelle_payments
  select * from jsonb_populate_record(null::zelle_payments,
    jsonb_build_object('status', 'sent', 'created_at', p_at) || p_payment);
  perform harbor__post_ledger(p_ledger, p_at);
  return jsonb_build_object('replayed', false);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Zelle return/refund: reverse a sent payment back to the accounts that funded it (once).
-- ---------------------------------------------------------------------------------------------
create or replace function harbor_zelle_return(p_payment_id uuid, p_reason text, p_ledger jsonb,
                                               p_at timestamptz, p_actor uuid, p_audit jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_p zelle_payments;
  v_credit bigint;
begin
  select * into v_p from zelle_payments where id = p_payment_id for update;
  if not found then
    raise exception 'harbor:not_found' using detail = 'Zelle payment not found';
  end if;
  if v_p.status = 'returned' then
    raise exception 'harbor:already_returned' using detail = 'payment already returned';
  end if;
  if harbor__ledger_net_debit(p_ledger, 'zelle_clearing', null) <> v_p.amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'a return debits zelle_clearing the full amount';
  end if;
  select coalesce(-sum(coalesce((l->>'debit')::bigint, 0) - coalesce((l->>'credit')::bigint, 0)), 0)
    into v_credit
    from jsonb_array_elements(coalesce(p_ledger->'lines', '[]'::jsonb)) l
   where l->>'account' = 'customer_deposits';
  if v_credit <> v_p.amount_cents then
    raise exception 'harbor:payload_mismatch' using detail = 'the return credits must equal the payment amount';
  end if;
  perform harbor__post_ledger(p_ledger, p_at);
  update zelle_payments set status = 'returned', return_reason = p_reason, returned_at = p_at where id = p_payment_id;
  insert into audit_log (actor_id, action, entity, entity_id, reason, data, created_at)
  values (p_actor, 'zelle_return', 'zelle_payment', p_payment_id::text, p_reason, p_audit, p_at);
  return jsonb_build_object('reversed', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: clients call none of these; the api function (service role) calls the public ones.
-- (Re-run for the functions added/replaced here; matches the block in the base atomic-ops migration.)
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
