-- Serialize a user's money-out ops so concurrent tier-limit checks cannot both pass.
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
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_transfer->>'user_id', ''), 42));
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