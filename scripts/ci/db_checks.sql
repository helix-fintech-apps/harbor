-- DB-level assertions. Each block raises (and aborts the run) if an invariant is not enforced.
\set ON_ERROR_STOP 1

-- Fixtures
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'ava@harbor.test', '{"legal_name":"Ava Harbor"}'),
  ('00000000-0000-0000-0000-00000000000b', 'ben@harbor.test', '{"legal_name":"Ben Rivers"}'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@harbor.test', '{"legal_name":"Ada Admin","role":"admin"}');

do $$ begin
  assert (select count(*) from profiles) = 3, 'profiles created by trigger';
  assert (select role from profiles where id = '00000000-0000-0000-0000-0000000000ad') = 'customer', 'signup can never grant staff';
  assert (select kyc_state from profiles where id = '00000000-0000-0000-0000-00000000000a') = 'unverified', 'new users are unverified';
  assert (select (policy->>'version')::int from money_policies where version = 1) = 1, 'policy seeded';
  assert (select (schedule->>'instantTransferBps')::int from fee_schedules where version = 1) = 150, 'fees seeded';
end $$;
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000ad';
update profiles set kyc_state = 'approved' where id in ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b');

insert into accounts (id, user_id, kind, account_number, policy_version) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'checking', '880000000001', 1),
  ('10000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-00000000000a', 'savings',  '880000000002', 1),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'checking', '880000000003', 1);

-- 1. Balanced txn via post_ledger_txn commits.
select post_ledger_txn('ach_in', 't1', 'idem-1', '[{"account":"ach_clearing","debit":10000},{"account":"customer_deposits","party":"10000000-0000-0000-0000-00000000000a","credit":10000}]');
-- idempotent replay returns the same txn and posts nothing new
do $$ declare a uuid; b uuid; begin
  a := post_ledger_txn('ach_in', 't1', 'idem-1', '[{"account":"ach_clearing","debit":10000},{"account":"customer_deposits","party":"10000000-0000-0000-0000-00000000000a","credit":10000}]');
  select id into b from ledger_txns where idempotency_key = 'idem-1';
  assert a = b, 'idempotent ledger post';
  assert (select count(*) from ledger_lines) = 2, 'replay posts no lines';
end $$;

-- 2. Unbalanced txn is rejected at COMMIT by the deferred trigger.
do $$ begin
  begin
    perform post_ledger_txn('bad', null, null, '[{"account":"ach_clearing","debit":100},{"account":"customer_deposits","party":"10000000-0000-0000-0000-00000000000a","credit":99}]');
    set constraints ledger_balanced immediate;  -- force the deferred check inside this block
    raise exception 'UNBALANCED ACCEPTED';
  exception when check_violation then null;
  end;
end $$;
-- Also verify deferral: lines inserted one at a time are fine as long as they balance at commit.
begin;
insert into ledger_txns (id, kind) values ('20000000-0000-0000-0000-000000000001', 'split');
insert into ledger_lines (txn_id, account, debit) values ('20000000-0000-0000-0000-000000000001', 'fee_revenue', 0 + 1) ;
insert into ledger_lines (txn_id, account, party, credit) values ('20000000-0000-0000-0000-000000000001', 'customer_deposits', '10000000-0000-0000-0000-00000000000a', 1);
commit;
-- An unbalanced explicit transaction fails at commit.
do $$ begin
  begin
    insert into ledger_txns (id, kind) values ('20000000-0000-0000-0000-000000000002', 'half');
    insert into ledger_lines (txn_id, account, debit) values ('20000000-0000-0000-0000-000000000002', 'fee_revenue', 5);
    set constraints ledger_balanced immediate;
    raise exception 'HALF TXN ACCEPTED';
  exception when check_violation then null;
  end;
end $$;

-- 3. Ledger is append-only and lines are one-sided, non-negative, and customer lines need a party.
do $$ begin
  begin update ledger_lines set debit = debit + 1 where id = 1; raise exception 'UPDATE ALLOWED';
  exception when insufficient_privilege then null; end;
  begin delete from ledger_txns; raise exception 'DELETE ALLOWED';
  exception when insufficient_privilege then null; end;
  begin insert into ledger_lines (txn_id, account, debit, credit) select id, 'fee_revenue', 5, 5 from ledger_txns limit 1; raise exception 'TWO-SIDED LINE';
  exception when check_violation then null; end;
  begin insert into ledger_lines (txn_id, account, debit) select id, 'fee_revenue', -5 from ledger_txns limit 1; raise exception 'NEGATIVE LINE';
  exception when check_violation then null; end;
  begin insert into ledger_lines (txn_id, account, credit) select id, 'customer_deposits', 5 from ledger_txns limit 1; raise exception 'PARTYLESS CUSTOMER LINE';
  exception when check_violation then null; end;
  begin insert into ledger_lines (txn_id, account, credit) select id, 'made_up_account', 5 from ledger_txns limit 1; raise exception 'UNKNOWN ACCOUNT';
  exception when check_violation then null; end;
end $$;

-- 4. Holds: positive, card auths must expire; balances view = posted - active holds.
insert into holds (account_id, kind, amount_cents, status, release_at) values ('10000000-0000-0000-0000-00000000000a', 'ach_in', 6000, 'active', now() + interval '3 days');
insert into holds (account_id, kind, amount_cents, status, expires_at) values ('10000000-0000-0000-0000-00000000000a', 'card_auth', 500, 'active', now() - interval '1 minute'); -- expired: ignored
do $$ begin
  assert (select posted_cents from account_available where account_id = '10000000-0000-0000-0000-00000000000a') = 10001, 'posted from ledger';
  assert (select available_cents from account_available where account_id = '10000000-0000-0000-0000-00000000000a') = 4001, 'available = posted - active holds';
  begin insert into holds (account_id, kind, amount_cents) values ('10000000-0000-0000-0000-00000000000a', 'ach_in', 0); raise exception 'ZERO HOLD';
  exception when check_violation then null; end;
  begin insert into holds (account_id, kind, amount_cents) values ('10000000-0000-0000-0000-00000000000a', 'card_auth', 100); raise exception 'CARD HOLD WITHOUT EXPIRY';
  exception when check_violation then null; end;
  begin insert into holds (kind, amount_cents, release_at) values ('ach_in', 100, now()); raise exception 'OWNERLESS HOLD';
  exception when check_violation then null; end;
  begin insert into holds (account_id, kind, amount_cents, status) values ('10000000-0000-0000-0000-00000000000a', 'ach_in', 100, 'released'); raise exception 'RELEASED WITHOUT TIME';
  exception when check_violation then null; end;
end $$;

-- 5. Family limits ordered; teen can't be active without guardian approval.
do $$ begin
  begin insert into family_members (owner_user_id, name, kind, status, per_txn_cents, daily_cents, monthly_cents)
    values ('00000000-0000-0000-0000-00000000000a', 'Sam', 'spouse', 'active', 20000, 10000, 50000); raise exception 'PER TXN > DAILY';
  exception when check_violation then null; end;
  begin insert into family_members (owner_user_id, name, kind, status, per_txn_cents, daily_cents, monthly_cents)
    values ('00000000-0000-0000-0000-00000000000a', 'Tia', 'teen', 'active', 1000, 2000, 5000); raise exception 'TEEN ACTIVE WITHOUT APPROVAL';
  exception when check_violation then null; end;
end $$;
insert into family_members (owner_user_id, name, kind, status, per_txn_cents, daily_cents, monthly_cents)
  values ('00000000-0000-0000-0000-00000000000a', 'Tia', 'teen', 'pending_guardian_approval', 1000, 2000, 5000);

-- 6. Transfers, cards, auths, refunds, disputes constraints.
insert into cards (id, account_id, holder_user_id, kind, status, last4) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'virtual', 'active', '4242');
insert into card_authorizations (id, card_id, amount_cents, mcc, merchant, status, funding_account, funding_party, captured_cents, expires_at)
  values ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 5000, '5411', 'Grocer', 'captured', 'customer_deposits', '10000000-0000-0000-0000-00000000000a', 5000, now() + interval '7 days');
insert into card_refunds (id, auth_id, amount_cents) values ('re_1', '40000000-0000-0000-0000-000000000001', 1000);
insert into disputes (auth_id, user_id, credit_account, credit_party, amount_cents, reason, status, provisional_credit_due_at, resolution_due_at, policy_version)
  values ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'customer_deposits', '10000000-0000-0000-0000-00000000000a', 4000, 'not received', 'open', now() + interval '10 days', now() + interval '45 days', 1);
do $$ begin
  begin insert into transfers (user_id, kind, amount_cents, status, policy_version, fee_version) values ('00000000-0000-0000-0000-00000000000a', 'ach_out', 0, 'pending', 1, 1); raise exception 'ZERO TRANSFER';
  exception when check_violation then null; end;
  begin insert into transfers (user_id, kind, amount_cents, fee_cents, status, policy_version, fee_version) values ('00000000-0000-0000-0000-00000000000a', 'ach_out', 100, -1, 'pending', 1, 1); raise exception 'NEGATIVE FEE';
  exception when check_violation then null; end;
  begin insert into transfers (user_id, kind, amount_cents, status, policy_version, fee_version) values ('00000000-0000-0000-0000-00000000000a', 'ach_in', 100, 'returned', 1, 1); raise exception 'RETURN WITHOUT CODE';
  exception when check_violation then null; end;
  begin insert into transfers (user_id, kind, counterparty_user_id, amount_cents, status, policy_version, fee_version) values ('00000000-0000-0000-0000-00000000000a', 'p2p', '00000000-0000-0000-0000-00000000000a', 100, 'completed', 1, 1); raise exception 'SELF P2P';
  exception when check_violation then null; end;
  begin insert into transfers (user_id, kind, amount_cents, status, policy_version, fee_version, idempotency_key) values ('00000000-0000-0000-0000-00000000000a', 'p2p', 100, 'completed', 1, 1, 'dup'),
    ('00000000-0000-0000-0000-00000000000a', 'p2p', 100, 'completed', 1, 1, 'dup'); raise exception 'DUP IDEMPOTENCY KEY';
  exception when unique_violation then null; end;
  begin insert into card_refunds (id, auth_id, amount_cents) values ('re_1', '40000000-0000-0000-0000-000000000001', 1000); raise exception 'REFUND POSTED TWICE';
  exception when unique_violation then null; end;
  begin update card_authorizations set refunded_cents = 5001 where id = '40000000-0000-0000-0000-000000000001'; raise exception 'REFUND > CAPTURED';
  exception when check_violation then null; end;
  begin insert into disputes (auth_id, user_id, credit_account, credit_party, amount_cents, reason, status, provisional_credit_due_at, resolution_due_at, policy_version)
    values ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'customer_deposits', '10000000-0000-0000-0000-00000000000a', 100, 'again', 'open', now(), now(), 1); raise exception 'SECOND OPEN DISPUTE';
  exception when unique_violation then null; end;
  begin insert into accounts (user_id, kind, account_number, policy_version) values ('00000000-0000-0000-0000-00000000000a', 'checking', '880000000009', 1); raise exception 'SECOND CHECKING';
  exception when unique_violation then null; end;
  begin insert into card_authorizations (card_id, amount_cents, mcc, merchant, status, funding_account, funding_party, expires_at)
    values ('30000000-0000-0000-0000-000000000001', 100, '5411', 'x', 'declined', 'customer_deposits', '10000000-0000-0000-0000-00000000000a', now()); raise exception 'DECLINE WITHOUT REASON';
  exception when check_violation then null; end;
  begin insert into interest_postings (account_id, period, accrued_micro, carry_in_micro, posted_cents, carry_out_micro)
    values ('10000000-0000-0000-0000-0000000000a5', '2026-09', 3000000, 0, 3, 900000); raise exception 'CARRY > HALF CENT';
  exception when check_violation then null; end;
end $$;

insert into linked_banks (id, user_id, provider, institution, mask, name_matched) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'fake', 'First Platypus Bank', '1234', true);
insert into bank_access_tokens (linked_bank_id, access_token) values ('50000000-0000-0000-0000-000000000001', 'access-fake-secret');

-- 7. RLS: customers see only their own rows; cannot write; cannot call post_ledger_txn.
grant select on all tables in schema public to authenticated;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from accounts) = 1, 'ben sees only his account';
  assert (select count(*) from account_available) = 1, 'balance view respects RLS';
  assert (select count(*) from ledger_lines) = 0, 'ben sees no ledger lines of ava';
  assert (select count(*) from cards) = 0, 'ben sees no cards of ava';
  assert (select count(*) from fee_schedules) = 1, 'fees are public';
  assert (select count(*) from linked_banks) = 0, 'ben cannot see ava banks';
  begin insert into transfers (user_id, kind, amount_cents, status, policy_version, fee_version) values ('00000000-0000-0000-0000-00000000000b', 'p2p', 100, 'completed', 1, 1); raise exception 'CLIENT WRITE ALLOWED';
  exception when insufficient_privilege then null; end;
  begin update profiles set kyc_state = 'approved'; raise exception 'CLIENT KYC SELF-APPROVE';
  exception when insufficient_privilege then null; end;
  begin perform post_ledger_txn('x', null, null, '[]'); raise exception 'CLIENT LEDGER POST';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from accounts) = 2, 'ava sees checking + savings';
  assert (select count(*) from ledger_lines) = 2, 'ava sees her own customer ledger lines only';
  assert (select available_cents from account_available where kind = 'checking') = 4001, 'ava available via view';
  assert (select count(*) from statement_lines) = 2, 'statement lines visible';
  assert (select count(*) from linked_banks) = 1, 'ava sees her bank';
  assert (select count(*) from bank_access_tokens) = 0, 'access tokens are never visible to clients';
  assert (select count(*) from idempotency_keys) = 0, 'idempotency keys hidden';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  assert (select count(*) from ledger_lines) = 4, 'admin sees the whole ledger';
  assert (select count(*) from accounts) = 3, 'admin sees all accounts';
end $$;
reset role;

do $$ begin
  assert (select coalesce(sum(debit) - sum(credit), 0) from ledger_lines) = 0, 'trial balance is zero';
end $$;
\echo 'db_checks: all assertions passed'
