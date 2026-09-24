-- Row-level security. Browser reads are scoped to the user; ALL writes go through the `api`
-- Edge Function using the service role. authenticated/anon have no write grants at all.

do $$ declare t text;
begin
  foreach t in array array['money_policies','fee_schedules','profiles','kyc_checks','accounts','linked_banks','direct_deposit_forms',
    'family_members','cards','holds','transfers','payees','card_authorizations','card_refunds','disputes','interest_accruals',
    'interest_postings','closures','ledger_txns','ledger_lines','idempotency_keys','provider_events','audit_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function post_ledger_txn(text, text, text, jsonb) from public, anon, authenticated;

create or replace function is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('admin','support_agent'));
$$;

create or replace function owns_account(a uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from accounts where id = a and user_id = auth.uid());
$$;

create or replace function sees_member(m uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from family_members where id = m and (owner_user_id = auth.uid() or member_user_id = auth.uid()));
$$;

-- Published terms are public.
create policy "policies public" on money_policies for select using (true);
create policy "fees public" on fee_schedules for select using (true);

create policy "own profile" on profiles for select using (id = auth.uid() or is_staff());
create policy "own kyc" on kyc_checks for select using (user_id = auth.uid() or is_staff());
create policy "own accounts" on accounts for select using (user_id = auth.uid() or is_staff());
create policy "own banks" on linked_banks for select using (user_id = auth.uid() or is_staff());
create policy "own dd forms" on direct_deposit_forms for select using (user_id = auth.uid() or is_staff());
create policy "family" on family_members for select using (owner_user_id = auth.uid() or member_user_id = auth.uid() or is_staff());
create policy "cards" on cards for select using (owns_account(account_id) or holder_user_id = auth.uid() or is_staff());
create policy "holds" on holds for select using (owns_account(account_id) or sees_member(family_member_id) or is_staff());
create policy "transfers" on transfers for select using (user_id = auth.uid() or counterparty_user_id = auth.uid() or is_staff());
create policy "payees" on payees for select using (user_id = auth.uid() or is_staff());
create policy "auths" on card_authorizations for select
  using (exists (select 1 from cards c where c.id = card_id and (owns_account(c.account_id) or c.holder_user_id = auth.uid())) or is_staff());
create policy "card refunds" on card_refunds for select
  using (exists (select 1 from card_authorizations a join cards c on c.id = a.card_id where a.id = auth_id and (owns_account(c.account_id) or c.holder_user_id = auth.uid())) or is_staff());
create policy "disputes" on disputes for select using (user_id = auth.uid() or is_staff());
create policy "interest accruals" on interest_accruals for select using (owns_account(account_id) or is_staff());
create policy "interest postings" on interest_postings for select using (owns_account(account_id) or is_staff());
create policy "closures" on closures for select using (user_id = auth.uid() or is_staff());
-- Customers see ledger lines for their own pockets (statements); staff see everything.
create policy "ledger lines" on ledger_lines for select
  using (is_staff() or (account = 'customer_deposits' and owns_account(party)) or (account = 'family_allowance' and sees_member(party)));
create policy "ledger txns" on ledger_txns for select
  using (is_staff() or exists (select 1 from ledger_lines l where l.txn_id = ledger_txns.id and
    ((l.account = 'customer_deposits' and owns_account(l.party)) or (l.account = 'family_allowance' and sees_member(l.party)))));
create policy "audit staff" on audit_log for select using (is_staff());
-- idempotency_keys and provider_events: service role only (no policies => no rows for clients).

grant select on account_balances, account_available, allowance_balances, statement_lines to authenticated;

-- New auth users get a customer profile (never staff, never approved).
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, legal_name, email, role, kyc_state)
  values (new.id, coalesce(new.raw_user_meta_data->>'legal_name', new.raw_user_meta_data->>'full_name', ''), new.email, 'customer', 'unverified');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
