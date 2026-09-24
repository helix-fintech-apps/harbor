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

-- ================================================================================================
-- 8. Atomic money operations (migration 20260924000004): every multi-row money write is one
--    function. Each check covers the happy path, idempotent replay, the guard that refuses a stale
--    or invalid request, and that a failing call leaves nothing behind (the whole call rolls back).
--    A refused call raises `harbor:<code>`; the nested BEGIN/EXCEPTION blocks catch exactly that
--    code (and roll back to their savepoint), anything else fails the run.
-- ================================================================================================
create function pg_temp.id(n text) returns uuid language sql immutable as $$
  select (case n
    when 'cara' then 'c0000000-0000-4000-8000-000000000001' when 'dan' then 'd0000000-0000-4000-8000-000000000001'
    when 'cara_chk' then 'c1000000-0000-4000-8000-000000000001' when 'cara_sav' then 'c1000000-0000-4000-8000-000000000002'
    when 'dan_chk' then 'd1000000-0000-4000-8000-000000000001' when 'teen' then 'c3000000-0000-4000-8000-000000000001'
    when 'cara_card' then 'c2000000-0000-4000-8000-000000000001' when 'teen_card' then 'c2000000-0000-4000-8000-000000000002'
    when 'dep1' then 'e0000000-0000-4000-8000-000000000001' when 'dep2' then 'e0000000-0000-4000-8000-000000000002'
    when 'dep_bad' then 'e0000000-0000-4000-8000-000000000003' when 'hold1' then 'e1000000-0000-4000-8000-000000000001'
    when 'hold2' then 'e1000000-0000-4000-8000-000000000002' when 'hold_bad' then 'e1000000-0000-4000-8000-000000000003'
    when 'wd1' then 'e2000000-0000-4000-8000-000000000001' when 'wd_big' then 'e2000000-0000-4000-8000-000000000002'
    when 'p2p1' then 'e3000000-0000-4000-8000-000000000001' when 'p2p2' then 'e3000000-0000-4000-8000-000000000002'
    when 'pocket1' then 'e4000000-0000-4000-8000-000000000001' when 'allow1' then 'e4000000-0000-4000-8000-000000000002'
    when 'auth1' then 'e5000000-0000-4000-8000-000000000001' when 'auth2' then 'e5000000-0000-4000-8000-000000000002'
    when 'auth3' then 'e5000000-0000-4000-8000-000000000003' when 'auth_teen' then 'e5000000-0000-4000-8000-000000000004'
    when 'ahold1' then 'e6000000-0000-4000-8000-000000000001' when 'ahold2' then 'e6000000-0000-4000-8000-000000000002'
    when 'ahold3' then 'e6000000-0000-4000-8000-000000000003' when 'ahold_teen' then 'e6000000-0000-4000-8000-000000000004'
    when 'disp1' then 'e7000000-0000-4000-8000-000000000001' when 'disp2' then 'e7000000-0000-4000-8000-000000000002'
    when 'closure1' then 'e8000000-0000-4000-8000-000000000001' when 'payout1' then 'e8000000-0000-4000-8000-000000000002'
  end)::uuid
$$;
create function pg_temp.dr(a text, amount bigint, party uuid default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('account', a, 'party', party, 'debit', amount, 'credit', 0)
$$;
create function pg_temp.cr(a text, amount bigint, party uuid default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('account', a, 'party', party, 'debit', 0, 'credit', amount)
$$;
create function pg_temp.ledger(kind text, idem text, variadic lines jsonb[]) returns jsonb language sql immutable as $$
  select jsonb_build_object('kind', kind, 'ref', null, 'idem', idem, 'lines', to_jsonb(lines))
$$;
-- A transfers row as the service sends it.
create function pg_temp.xfer(id uuid, owner uuid, kind text, from_acct uuid, to_acct uuid, amount bigint, fee bigint default 0,
                             extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('id', id, 'user_id', owner, 'kind', kind, 'from_account_id', from_acct, 'to_account_id', to_acct,
    'amount_cents', amount, 'fee_cents', fee, 'status', 'completed', 'policy_version', 1, 'fee_version', 1, 'created_at', now()) || extra
$$;
create function pg_temp.avail(a uuid) returns bigint language sql stable as $$ select harbor__available_cents(a, now()) $$;
create function pg_temp.posted(a uuid) returns bigint language sql stable as $$ select harbor__posted_cents(a) $$;
create function pg_temp.trial() returns bigint language sql stable as $$ select coalesce(sum(debit) - sum(credit), 0) from ledger_lines $$;

insert into auth.users (id, email, raw_user_meta_data) values
  (pg_temp.id('cara'), 'cara@harbor.test', '{"legal_name":"Cara Atomic"}'),
  (pg_temp.id('dan'), 'dan@harbor.test', '{"legal_name":"Dan Atomic"}');
update profiles set kyc_state = 'approved' where id in (pg_temp.id('cara'), pg_temp.id('dan'));
insert into accounts (id, user_id, kind, account_number, policy_version) values
  (pg_temp.id('cara_chk'), pg_temp.id('cara'), 'checking', '880000000101', 1),
  (pg_temp.id('cara_sav'), pg_temp.id('cara'), 'savings', '880000000102', 1),
  (pg_temp.id('dan_chk'), pg_temp.id('dan'), 'checking', '880000000103', 1);
insert into family_members (id, owner_user_id, name, kind, status, per_txn_cents, daily_cents, monthly_cents, approved_at)
  values (pg_temp.id('teen'), pg_temp.id('cara'), 'Tess', 'teen', 'active', 5000, 10000, 40000, now());
insert into cards (id, account_id, holder_user_id, family_member_id, kind, status, last4) values
  (pg_temp.id('cara_card'), pg_temp.id('cara_chk'), pg_temp.id('cara'), null, 'virtual', 'active', '1111'),
  (pg_temp.id('teen_card'), pg_temp.id('cara_chk'), pg_temp.id('cara'), pg_temp.id('teen'), 'virtual', 'active', '2222');

-- 8a. ACH pull: transfer + credit + deposit hold in one call; replay posts nothing; a failure in the
--     LAST step (hold insert) rolls back the transfer and the ledger txn written before it.
do $$
declare r jsonb;
begin
  r := harbor_ach_pull_create(
    pg_temp.xfer(pg_temp.id('dep1'), pg_temp.id('cara'), 'ach_in', null, pg_temp.id('cara_chk'), 50000, 0,
      jsonb_build_object('status', 'pending', 'settle_at', now() + interval '3 days', 'idempotency_key', 'cara:dep-1')),
    pg_temp.ledger('ach_in', 'transfer:dep1', pg_temp.dr('ach_clearing', 50000), pg_temp.cr('customer_deposits', 50000, pg_temp.id('cara_chk'))),
    jsonb_build_object('id', pg_temp.id('hold1'), 'account_id', pg_temp.id('cara_chk'), 'kind', 'ach_in', 'amount_cents', 50000,
      'ref_id', pg_temp.id('dep1'), 'release_at', now() + interval '3 days'),
    null, now());
  assert not (r->>'replayed')::boolean, 'ach pull: first call writes';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 50000, 'ach pull: posted immediately';
  assert pg_temp.avail(pg_temp.id('cara_chk')) = 0, 'ach pull: held until settlement';
  -- replay of the same transfer id
  r := harbor_ach_pull_create(
    pg_temp.xfer(pg_temp.id('dep1'), pg_temp.id('cara'), 'ach_in', null, pg_temp.id('cara_chk'), 50000, 0, '{"status":"pending"}'),
    pg_temp.ledger('ach_in', 'transfer:dep1', pg_temp.dr('ach_clearing', 50000), pg_temp.cr('customer_deposits', 50000, pg_temp.id('cara_chk'))),
    jsonb_build_object('id', gen_random_uuid(), 'account_id', pg_temp.id('cara_chk'), 'kind', 'ach_in', 'amount_cents', 50000, 'ref_id', pg_temp.id('dep1')),
    null, now());
  assert (r->>'replayed')::boolean, 'ach pull: replay reported';
  assert (select count(*) from transfers where user_id = pg_temp.id('cara')) = 1, 'ach pull: replay inserts no transfer';
  assert (select count(*) from holds where ref_id = pg_temp.id('dep1')) = 1, 'ach pull: replay places no second hold';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 50000, 'ach pull: replay posts nothing';
  -- rollback: card_auth holds need an expiry, so the final insert fails after transfer + ledger were written
  begin
    perform harbor_ach_pull_create(
      pg_temp.xfer(pg_temp.id('dep_bad'), pg_temp.id('cara'), 'ach_in', null, pg_temp.id('cara_chk'), 700, 0, '{"status":"pending"}'),
      pg_temp.ledger('ach_in', 'transfer:dep_bad', pg_temp.dr('ach_clearing', 700), pg_temp.cr('customer_deposits', 700, pg_temp.id('cara_chk'))),
      jsonb_build_object('id', pg_temp.id('hold_bad'), 'account_id', pg_temp.id('cara_chk'), 'kind', 'card_auth', 'amount_cents', 700, 'ref_id', pg_temp.id('dep_bad')),
      null, now());
    raise exception 'FAIL ach pull with an invalid hold was accepted';
  exception when check_violation then null;
  end;
  assert not exists (select 1 from transfers where id = pg_temp.id('dep_bad')), 'ach pull rollback: no transfer left behind';
  assert not exists (select 1 from ledger_txns where idempotency_key = 'transfer:dep_bad'), 'ach pull rollback: no ledger txn left behind';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 50000, 'ach pull rollback: balance unchanged';
  -- guards: hold must match the credit; the daily deposit limit is re-checked
  begin
    perform harbor_ach_pull_create(
      pg_temp.xfer(pg_temp.id('dep_bad'), pg_temp.id('cara'), 'ach_in', null, pg_temp.id('cara_chk'), 700, 0, '{"status":"pending"}'),
      pg_temp.ledger('ach_in', 'transfer:dep_bad', pg_temp.dr('ach_clearing', 700), pg_temp.cr('customer_deposits', 700, pg_temp.id('cara_chk'))),
      jsonb_build_object('account_id', pg_temp.id('cara_chk'), 'kind', 'ach_in', 'amount_cents', 1, 'ref_id', pg_temp.id('dep_bad')), null, now());
    raise exception 'FAIL ach pull with a short hold was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:payload_mismatch' then raise; end if;
  end;
  begin
    perform harbor_ach_pull_create(
      pg_temp.xfer(pg_temp.id('dep_bad'), pg_temp.id('cara'), 'ach_in', null, pg_temp.id('cara_chk'), 700, 0, '{"status":"pending"}'),
      pg_temp.ledger('ach_in', 'transfer:dep_bad', pg_temp.dr('ach_clearing', 700), pg_temp.cr('customer_deposits', 700, pg_temp.id('cara_chk'))),
      jsonb_build_object('account_id', pg_temp.id('cara_chk'), 'kind', 'ach_in', 'amount_cents', 700, 'ref_id', pg_temp.id('dep_bad')),
      jsonb_build_object('kind', 'ach_in', 'daily_cents', 50500, 'monthly_cents', 9007199254740991,
        'day_start', date_trunc('day', now()), 'month_start', date_trunc('month', now())), now());
    raise exception 'FAIL ach pull over the daily deposit limit was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:daily_limit' then raise; end if;
  end;
  assert not exists (select 1 from transfers where id = pg_temp.id('dep_bad')), 'ach pull guards: nothing written';
end $$;

-- 8b. ACH settle: not before settle_at; releases the hold once; a second run is a no-op.
do $$ begin
  assert not harbor_ach_settle(pg_temp.id('dep1'), now()), 'settle: not before settle_at';
  assert pg_temp.avail(pg_temp.id('cara_chk')) = 0, 'settle: still held';
  assert harbor_ach_settle(pg_temp.id('dep1'), now() + interval '4 days'), 'settle: due';
  assert (select status from transfers where id = pg_temp.id('dep1')) = 'settled', 'settle: transfer settled';
  assert (select status from holds where id = pg_temp.id('hold1')) = 'released', 'settle: hold released';
  assert pg_temp.avail(pg_temp.id('cara_chk')) = 50000, 'settle: now available';
  assert not harbor_ach_settle(pg_temp.id('dep1'), now() + interval '5 days'), 'settle: idempotent';
end $$;

-- 8c. Money out. Instant withdrawal posts amount + fee in one txn; a withdrawal above the available
--     balance, a fee that doesn't match fee revenue and an unbalanced ledger are refused with nothing
--     written; replaying the same transfer id debits once. P2P records the payee once and re-checks
--     the transfer-out limit. Pocket move and teen allowance top-up.
do $$
declare r jsonb;
begin
  r := harbor_ach_push(
    pg_temp.xfer(pg_temp.id('wd1'), pg_temp.id('cara'), 'ach_out', pg_temp.id('cara_chk'), null, 10000, 150, '{"speed":"instant","idempotency_key":"cara:wd-1"}'),
    pg_temp.ledger('ach_out_instant', 'transfer:wd1', pg_temp.dr('customer_deposits', 10150, pg_temp.id('cara_chk')),
      pg_temp.cr('ach_clearing', 10000), pg_temp.cr('fee_revenue', 150)),
    null, now());
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 39850, 'withdraw: amount + fee debited';
  r := harbor_ach_push(
    pg_temp.xfer(pg_temp.id('wd1'), pg_temp.id('cara'), 'ach_out', pg_temp.id('cara_chk'), null, 10000, 150, '{"speed":"instant"}'),
    pg_temp.ledger('ach_out_instant', 'transfer:wd1', pg_temp.dr('customer_deposits', 10150, pg_temp.id('cara_chk')),
      pg_temp.cr('ach_clearing', 10000), pg_temp.cr('fee_revenue', 150)),
    null, now());
  assert (r->>'replayed')::boolean and pg_temp.posted(pg_temp.id('cara_chk')) = 39850, 'withdraw: replay debits once';
  begin
    perform harbor_ach_push(
      pg_temp.xfer(pg_temp.id('wd_big'), pg_temp.id('cara'), 'ach_out', pg_temp.id('cara_chk'), null, 39800, 51, '{"speed":"instant"}'),
      pg_temp.ledger('ach_out_instant', 'transfer:wd_big', pg_temp.dr('customer_deposits', 39851, pg_temp.id('cara_chk')),
        pg_temp.cr('ach_clearing', 39800), pg_temp.cr('fee_revenue', 51)),
      null, now());
    raise exception 'FAIL withdrawal above available (amount + fee) was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:insufficient_funds' then raise; end if;
  end;
  begin
    perform harbor_ach_push(
      pg_temp.xfer(pg_temp.id('wd_big'), pg_temp.id('cara'), 'ach_out', pg_temp.id('cara_chk'), null, 1000, 25, '{"speed":"instant"}'),
      pg_temp.ledger('ach_out_instant', 'transfer:wd_big', pg_temp.dr('customer_deposits', 1025, pg_temp.id('cara_chk')),
        pg_temp.cr('ach_clearing', 1024), pg_temp.cr('fee_revenue', 1)),
      null, now());
    raise exception 'FAIL fee revenue different from the transfer fee was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:payload_mismatch' then raise; end if;
  end;
  begin
    perform harbor_ach_push(
      pg_temp.xfer(pg_temp.id('wd_big'), pg_temp.id('cara'), 'ach_out', pg_temp.id('cara_chk'), null, 1000, 0, '{"speed":"standard"}'),
      pg_temp.ledger('ach_out_standard', 'transfer:wd_big', pg_temp.dr('customer_deposits', 1000, pg_temp.id('cara_chk')), pg_temp.cr('ach_clearing', 999)),
      null, now());
    raise exception 'FAIL unbalanced withdrawal ledger was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:unbalanced_ledger' then raise; end if;
  end;
  assert not exists (select 1 from transfers where id = pg_temp.id('wd_big')), 'withdraw guards: no transfer written';
  assert not exists (select 1 from ledger_txns where idempotency_key = 'transfer:wd_big'), 'withdraw guards: no ledger txn written';

  -- P2P: payee recorded once; the limit re-check counts the withdrawal above (10,000 used today).
  perform harbor_p2p_transfer(
    pg_temp.xfer(pg_temp.id('p2p1'), pg_temp.id('cara'), 'p2p', pg_temp.id('cara_chk'), pg_temp.id('dan_chk'), 20000, 0,
      jsonb_build_object('counterparty_user_id', pg_temp.id('dan'), 'new_payee', true)),
    pg_temp.ledger('p2p', 'transfer:p2p1', pg_temp.dr('customer_deposits', 20000, pg_temp.id('cara_chk')), pg_temp.cr('customer_deposits', 20000, pg_temp.id('dan_chk'))),
    jsonb_build_object('user_id', pg_temp.id('cara'), 'payee_user_id', pg_temp.id('dan')),
    jsonb_build_object('kind', 'transfer_out', 'daily_cents', 100000, 'monthly_cents', 500000,
      'day_start', date_trunc('day', now()), 'month_start', date_trunc('month', now())), now());
  assert pg_temp.posted(pg_temp.id('dan_chk')) = 20000 and pg_temp.posted(pg_temp.id('cara_chk')) = 19850, 'p2p: moved';
  assert (select count(*) from payees where user_id = pg_temp.id('cara')) = 1, 'p2p: payee recorded';
  begin
    perform harbor_p2p_transfer(
      pg_temp.xfer(pg_temp.id('p2p2'), pg_temp.id('cara'), 'p2p', pg_temp.id('cara_chk'), pg_temp.id('dan_chk'), 1000, 0,
        jsonb_build_object('counterparty_user_id', pg_temp.id('dan'))),
      pg_temp.ledger('p2p', 'transfer:p2p2', pg_temp.dr('customer_deposits', 1000, pg_temp.id('cara_chk')), pg_temp.cr('customer_deposits', 1000, pg_temp.id('dan_chk'))),
      null,
      jsonb_build_object('kind', 'transfer_out', 'daily_cents', 30500, 'monthly_cents', 500000,
        'day_start', date_trunc('day', now()), 'month_start', date_trunc('month', now())), now());
    raise exception 'FAIL p2p over the daily limit was accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:daily_limit' then raise; end if;
  end;

  perform harbor_pocket_move(
    pg_temp.xfer(pg_temp.id('pocket1'), pg_temp.id('cara'), 'pocket', pg_temp.id('cara_chk'), pg_temp.id('cara_sav'), 5000),
    pg_temp.ledger('pocket_move', 'transfer:pocket1', pg_temp.dr('customer_deposits', 5000, pg_temp.id('cara_chk')), pg_temp.cr('customer_deposits', 5000, pg_temp.id('cara_sav'))),
    now());
  perform harbor_allowance_topup(
    pg_temp.xfer(pg_temp.id('allow1'), pg_temp.id('cara'), 'allowance_topup', pg_temp.id('cara_chk'), null, 2000, 0, jsonb_build_object('family_member_id', pg_temp.id('teen'))),
    pg_temp.ledger('allowance_topup', 'transfer:allow1', pg_temp.dr('customer_deposits', 2000, pg_temp.id('cara_chk')), pg_temp.cr('family_allowance', 2000, pg_temp.id('teen'))),
    now());
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 12850 and pg_temp.posted(pg_temp.id('cara_sav')) = 5000, 'pocket move posted';
  assert harbor__allowance_posted_cents(pg_temp.id('teen')) = 2000, 'allowance topped up';
  assert pg_temp.trial() = 0, 'money out: trial balance';
end $$;

-- 8d. Cards. An approved auth places its hold; if the pocket can no longer cover it, the auth is
--     recorded as declined with no hold. Teen auths draw on the allowance. Capture is a single
--     compare-and-set (a second capture and capture after expiry are refused); expiry releases a hold
--     once; merchant refunds post once per refund id and never exceed captured - refunded.
do $$
declare r jsonb;
begin
  r := harbor_card_authorize(
    jsonb_build_object('id', pg_temp.id('auth1'), 'card_id', pg_temp.id('cara_card'), 'amount_cents', 5000, 'fee_cents', 0, 'mcc', '5812',
      'merchant', 'Cafe', 'status', 'authorized', 'funding_account', 'customer_deposits', 'funding_party', pg_temp.id('cara_chk'),
      'expires_at', now() + interval '7 days', 'provider_auth_id', 'iauth_1'),
    jsonb_build_object('id', pg_temp.id('ahold1'), 'account_id', pg_temp.id('cara_chk'), 'kind', 'card_auth', 'amount_cents', 5000,
      'ref_id', pg_temp.id('auth1'), 'expires_at', now() + interval '7 days'),
    now());
  assert (r->>'approved')::boolean and pg_temp.avail(pg_temp.id('cara_chk')) = 7850, 'authorize: hold placed';
  r := harbor_card_authorize(jsonb_build_object('id', gen_random_uuid(), 'provider_auth_id', 'iauth_1'), null, now());
  assert (r->>'replayed')::boolean and (r->>'authorization_id')::uuid = pg_temp.id('auth1'), 'authorize: provider auth id replay';
  r := harbor_card_authorize(
    jsonb_build_object('id', pg_temp.id('auth2'), 'card_id', pg_temp.id('cara_card'), 'amount_cents', 8000, 'fee_cents', 0, 'mcc', '5411',
      'merchant', 'Grocer', 'status', 'authorized', 'funding_account', 'customer_deposits', 'funding_party', pg_temp.id('cara_chk'),
      'expires_at', now() + interval '7 days'),
    jsonb_build_object('id', pg_temp.id('ahold2'), 'account_id', pg_temp.id('cara_chk'), 'kind', 'card_auth', 'amount_cents', 8000,
      'ref_id', pg_temp.id('auth2'), 'expires_at', now() + interval '7 days'),
    now());
  assert not (r->>'approved')::boolean and r->>'reason' = 'insufficient_funds', 'authorize: re-checked balance declines';
  assert (select status from card_authorizations where id = pg_temp.id('auth2')) = 'declined', 'authorize: decline recorded';
  assert not exists (select 1 from holds where id = pg_temp.id('ahold2')), 'authorize: no hold for a decline';
  r := harbor_card_authorize(
    jsonb_build_object('id', pg_temp.id('auth_teen'), 'card_id', pg_temp.id('teen_card'), 'amount_cents', 2500, 'fee_cents', 0, 'mcc', '5411',
      'merchant', 'Books', 'status', 'authorized', 'funding_account', 'family_allowance', 'funding_party', pg_temp.id('teen'),
      'expires_at', now() + interval '7 days'),
    jsonb_build_object('id', pg_temp.id('ahold_teen'), 'account_id', null, 'family_member_id', pg_temp.id('teen'), 'kind', 'card_auth',
      'amount_cents', 2500, 'ref_id', pg_temp.id('auth_teen'), 'expires_at', now() + interval '7 days'),
    now());
  assert not (r->>'approved')::boolean and r->>'reason' = 'allowance_exceeded', 'authorize: teen limited to the allowance';

  -- capture 5,900 on a 5,000 restaurant auth (tip); a second capture is refused
  perform harbor_card_capture(pg_temp.id('auth1'), 5900, 0,
    pg_temp.ledger('card_capture', 'capture:auth1', pg_temp.dr('customer_deposits', 5900, pg_temp.id('cara_chk')), pg_temp.cr('card_settlement', 5900)), now());
  assert (select status from holds where id = pg_temp.id('ahold1')) = 'captured', 'capture: hold consumed';
  assert (select captured_cents from card_authorizations where id = pg_temp.id('auth1')) = 5900, 'capture: amount recorded';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 6950 and pg_temp.avail(pg_temp.id('cara_chk')) = 6950, 'capture: posted = available';
  begin
    perform harbor_card_capture(pg_temp.id('auth1'), 100, 0,
      pg_temp.ledger('card_capture', 'capture:auth1-again', pg_temp.dr('customer_deposits', 100, pg_temp.id('cara_chk')), pg_temp.cr('card_settlement', 100)), now());
    raise exception 'FAIL second capture accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:invalid_state' then raise; end if;
  end;

  -- a fresh auth: expiry blocks capture, then releases the hold exactly once
  perform harbor_card_authorize(
    jsonb_build_object('id', pg_temp.id('auth3'), 'card_id', pg_temp.id('cara_card'), 'amount_cents', 1000, 'fee_cents', 30, 'mcc', '5411',
      'merchant', 'Abroad', 'foreign_txn', true, 'status', 'authorized', 'funding_account', 'customer_deposits', 'funding_party', pg_temp.id('cara_chk'),
      'expires_at', now() + interval '7 days'),
    jsonb_build_object('id', pg_temp.id('ahold3'), 'account_id', pg_temp.id('cara_chk'), 'kind', 'card_auth', 'amount_cents', 1030,
      'ref_id', pg_temp.id('auth3'), 'expires_at', now() + interval '7 days'),
    now());
  assert not harbor_card_expire_auth(pg_temp.id('auth3'), now()), 'expire: not before expiry';
  begin
    perform harbor_card_capture(pg_temp.id('auth3'), 1000, 30,
      pg_temp.ledger('card_capture', 'capture:auth3', pg_temp.dr('customer_deposits', 1030, pg_temp.id('cara_chk')),
        pg_temp.cr('card_settlement', 1000), pg_temp.cr('fee_revenue', 30)), now() + interval '8 days');
    raise exception 'FAIL capture after expiry accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:auth_expired' then raise; end if;
  end;
  assert harbor_card_expire_auth(pg_temp.id('auth3'), now() + interval '8 days'), 'expire: due';
  assert (select status from holds where id = pg_temp.id('ahold3')) = 'expired', 'expire: hold released';
  assert not harbor_card_expire_auth(pg_temp.id('auth3'), now() + interval '8 days'), 'expire: idempotent';

  -- merchant refunds on auth1 (captured 5,900)
  r := harbor_card_refund('re_atomic_1', pg_temp.id('auth1'), 900,
    pg_temp.ledger('card_refund', 'refund:re_atomic_1', pg_temp.dr('card_settlement', 900), pg_temp.cr('customer_deposits', 900, pg_temp.id('cara_chk'))), now());
  assert not (r->>'duplicate')::boolean and (r->>'refunded_cents')::bigint = 900, 'refund: posted';
  r := harbor_card_refund('re_atomic_1', pg_temp.id('auth1'), 900,
    pg_temp.ledger('card_refund', 'refund:re_atomic_1', pg_temp.dr('card_settlement', 900), pg_temp.cr('customer_deposits', 900, pg_temp.id('cara_chk'))), now());
  assert (r->>'duplicate')::boolean and (select refunded_cents from card_authorizations where id = pg_temp.id('auth1')) = 900, 'refund: once per refund id';
  begin
    perform harbor_card_refund('re_atomic_2', pg_temp.id('auth1'), 5001,
      pg_temp.ledger('card_refund', 'refund:re_atomic_2', pg_temp.dr('card_settlement', 5001), pg_temp.cr('customer_deposits', 5001, pg_temp.id('cara_chk'))), now());
    raise exception 'FAIL refund above captured - refunded accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:refund_exceeds_captured' then raise; end if;
  end;
  begin
    perform harbor_card_refund('re_atomic_1', pg_temp.id('auth3'), 10,
      pg_temp.ledger('card_refund', 'refund:x', pg_temp.dr('card_settlement', 10), pg_temp.cr('customer_deposits', 10, pg_temp.id('cara_chk'))), now());
    raise exception 'FAIL refund id reused across purchases';
  exception when raise_exception then if sqlerrm <> 'harbor:refund_id_conflict' then raise; end if;
  end;
  assert not exists (select 1 from card_refunds where id = 're_atomic_2'), 'refund guards: nothing written';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 7850, 'cards: balance after capture + refund';
  assert pg_temp.trial() = 0, 'cards: trial balance';
end $$;

-- 8e. Disputes: one open dispute per purchase; provisional credit once; a resolution planned on a
--     stale status is refused; lost reverses the provisional credit.
do $$
declare r jsonb;
begin
  r := harbor_dispute_open(jsonb_build_object('id', pg_temp.id('disp1'), 'auth_id', pg_temp.id('auth1'), 'user_id', pg_temp.id('cara'),
    'credit_account', 'customer_deposits', 'credit_party', pg_temp.id('cara_chk'), 'amount_cents', 5000, 'reason', 'not as described',
    'provisional_credit_due_at', now() + interval '14 days', 'resolution_due_at', now() + interval '45 days', 'policy_version', 1), now());
  assert r->>'status' = 'open', 'dispute: opened';
  begin
    perform harbor_dispute_open(jsonb_build_object('id', pg_temp.id('disp2'), 'auth_id', pg_temp.id('auth1'), 'user_id', pg_temp.id('cara'),
      'credit_account', 'customer_deposits', 'credit_party', pg_temp.id('cara_chk'), 'amount_cents', 100, 'reason', 'again',
      'provisional_credit_due_at', now(), 'resolution_due_at', now(), 'policy_version', 1), now());
    raise exception 'FAIL second open dispute accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:dispute_already_open' then raise; end if;
  end;
  perform harbor_dispute_provisional_credit(pg_temp.id('disp1'),
    pg_temp.ledger('dispute_provisional_credit', 'dispute_pc:disp1', pg_temp.dr('dispute_receivable', 5000), pg_temp.cr('customer_deposits', 5000, pg_temp.id('cara_chk'))), now());
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 12850, 'dispute: provisional credit posted';
  begin
    perform harbor_dispute_provisional_credit(pg_temp.id('disp1'),
      pg_temp.ledger('dispute_provisional_credit', 'dispute_pc:disp1-again', pg_temp.dr('dispute_receivable', 5000), pg_temp.cr('customer_deposits', 5000, pg_temp.id('cara_chk'))), now());
    raise exception 'FAIL provisional credit given twice';
  exception when raise_exception then if sqlerrm <> 'harbor:invalid_state' then raise; end if;
  end;
  begin
    -- "won" planned while the dispute was still open would credit the customer again
    perform harbor_dispute_resolve(pg_temp.id('disp1'), 'won', 'open', 0,
      pg_temp.ledger('dispute_won', 'dispute_resolve:disp1', pg_temp.dr('card_settlement', 5000), pg_temp.cr('customer_deposits', 5000, pg_temp.id('cara_chk'))),
      now(), pg_temp.id('cara'));
    raise exception 'FAIL resolution planned on a stale status accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:invalid_state' then raise; end if;
  end;
  perform harbor_dispute_resolve(pg_temp.id('disp1'), 'lost', 'provisional_credited', 0,
    pg_temp.ledger('dispute_lost_reversal', 'dispute_resolve:disp1', pg_temp.dr('customer_deposits', 5000, pg_temp.id('cara_chk')), pg_temp.cr('dispute_receivable', 5000)),
    now(), pg_temp.id('cara'));
  assert (select status from disputes where id = pg_temp.id('disp1')) = 'lost', 'dispute: resolved lost';
  assert pg_temp.posted(pg_temp.id('cara_chk')) = 7850, 'dispute: lost reverses provisional credit';
  assert exists (select 1 from audit_log where action = 'dispute_resolved' and entity_id = pg_temp.id('disp1')::text), 'dispute: audited';
end $$;

-- 8f. ACH return after settlement claws back (balance may go negative); a transfer is returned once.
do $$ begin
  perform harbor_ach_return(pg_temp.id('dep1'), 'R10',
    pg_temp.ledger('ach_return_R10', 'return:dep1', pg_temp.dr('customer_deposits', 50000, pg_temp.id('cara_chk')), pg_temp.cr('ach_clearing', 50000)),
    now(), pg_temp.id('cara'), '{"negativeBalanceCents": 42150}');
  assert pg_temp.posted(pg_temp.id('cara_chk')) = -42150, 'return: claw-back leaves a negative balance';
  assert (select status || ':' || return_code from transfers where id = pg_temp.id('dep1')) = 'returned:R10', 'return: transfer returned';
  begin
    perform harbor_ach_return(pg_temp.id('dep1'), 'R10',
      pg_temp.ledger('ach_return_R10', 'return:dep1-again', pg_temp.dr('customer_deposits', 50000, pg_temp.id('cara_chk')), pg_temp.cr('ach_clearing', 50000)),
      now(), pg_temp.id('cara'), '{}');
    raise exception 'FAIL second return accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:already_returned' then raise; end if;
  end;
  assert pg_temp.posted(pg_temp.id('cara_chk')) = -42150, 'return: once';
end $$;

-- 8g. Before settlement a return reverses the credit and releases the deposit hold.
do $$ begin
  perform harbor_ach_pull_create(
    pg_temp.xfer(pg_temp.id('dep2'), pg_temp.id('dan'), 'ach_in', null, pg_temp.id('dan_chk'), 3000, 0,
      jsonb_build_object('status', 'pending', 'settle_at', now() + interval '3 days')),
    pg_temp.ledger('ach_in', 'transfer:dep2', pg_temp.dr('ach_clearing', 3000), pg_temp.cr('customer_deposits', 3000, pg_temp.id('dan_chk'))),
    jsonb_build_object('id', pg_temp.id('hold2'), 'account_id', pg_temp.id('dan_chk'), 'kind', 'ach_in', 'amount_cents', 3000, 'ref_id', pg_temp.id('dep2')),
    null, now());
  perform harbor_ach_return(pg_temp.id('dep2'), 'R01',
    pg_temp.ledger('ach_return_R01', 'return:dep2', pg_temp.dr('customer_deposits', 3000, pg_temp.id('dan_chk')), pg_temp.cr('ach_clearing', 3000)),
    now(), null, '{}');
  assert (select status from holds where id = pg_temp.id('hold2')) = 'released', 'return before settlement releases the hold';
  assert pg_temp.posted(pg_temp.id('dan_chk')) = 20000 and pg_temp.avail(pg_temp.id('dan_chk')) = 20000, 'return before settlement: nothing was spendable';
end $$;

-- 8h. Interest posting: once per account and period.
do $$ begin
  assert harbor_post_interest(jsonb_build_object('account_id', pg_temp.id('cara_sav'), 'period', '2026-09', 'accrued_micro', 1600000,
      'carry_in_micro', 0, 'posted_cents', 2, 'carry_out_micro', -400000),
    pg_temp.ledger('interest_posting', 'interest:cara_sav:2026-09', pg_temp.dr('interest_expense', 2), pg_temp.cr('customer_deposits', 2, pg_temp.id('cara_sav'))), now()),
    'interest: posted';
  assert not harbor_post_interest(jsonb_build_object('account_id', pg_temp.id('cara_sav'), 'period', '2026-09', 'accrued_micro', 1600000,
      'carry_in_micro', 0, 'posted_cents', 2, 'carry_out_micro', -400000),
    pg_temp.ledger('interest_posting', 'interest:cara_sav:2026-09-b', pg_temp.dr('interest_expense', 2), pg_temp.cr('customer_deposits', 2, pg_temp.id('cara_sav'))), now()),
    'interest: once per period';
  assert pg_temp.posted(pg_temp.id('cara_sav')) = 5002, 'interest: credited once';
end $$;

-- 8i. Closure (Dan: 20,000 in checking, one card). A plan made before money moved is refused; a payout
--     that would leave a cent behind rolls back every step (cards, ledger, transfer, accounts);
--     the real closure cancels cards, pays out in one txn and closes; a replay finds nothing to close.
insert into cards (id, account_id, holder_user_id, kind, status, last4)
  values ('d2000000-0000-4000-8000-000000000001', pg_temp.id('dan_chk'), pg_temp.id('dan'), 'virtual', 'active', '3333');
do $$
declare
  v_closure jsonb := jsonb_build_object('id', pg_temp.id('closure1'), 'user_id', pg_temp.id('dan'), 'payout_cents', 20000);
  v_payout jsonb := pg_temp.xfer(pg_temp.id('payout1'), pg_temp.id('dan'), 'closure_payout', pg_temp.id('dan_chk'), null, 20000, 0, '{"status":"pending"}');
  r jsonb;
begin
  begin
    perform harbor_close_account(pg_temp.id('dan'), v_closure, jsonb_build_object('accounts', jsonb_build_array(
        jsonb_build_object('id', pg_temp.id('dan_chk'), 'posted_cents', 23000))), null, null, now(), pg_temp.id('dan'), '{}');
    raise exception 'FAIL closure on stale balances accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:closure_state_changed' then raise; end if;
  end;
  begin
    perform harbor_close_account(pg_temp.id('dan'), v_closure || '{"payout_cents": 19999}', jsonb_build_object('accounts', jsonb_build_array(
        jsonb_build_object('id', pg_temp.id('dan_chk'), 'posted_cents', 20000))),
      pg_temp.ledger('closure_payout', 'closure:closure1', pg_temp.dr('customer_deposits', 19999, pg_temp.id('dan_chk')), pg_temp.cr('closure_payout', 19999)),
      v_payout || '{"amount_cents": 19999}', now(), pg_temp.id('dan'), '{}');
    raise exception 'FAIL closure leaving a cent behind accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:payload_mismatch' then raise; end if;
  end;
  assert (select status from cards where id = 'd2000000-0000-4000-8000-000000000001') = 'active', 'closure rollback: card still active';
  assert (select status from accounts where id = pg_temp.id('dan_chk')) = 'open', 'closure rollback: account still open';
  assert not exists (select 1 from ledger_txns where idempotency_key = 'closure:closure1'), 'closure rollback: no payout txn';
  assert not exists (select 1 from transfers where id = pg_temp.id('payout1')), 'closure rollback: no payout transfer';

  r := harbor_close_account(pg_temp.id('dan'), v_closure, jsonb_build_object('accounts', jsonb_build_array(
      jsonb_build_object('id', pg_temp.id('dan_chk'), 'posted_cents', 20000))),
    pg_temp.ledger('closure_payout', 'closure:closure1', pg_temp.dr('customer_deposits', 20000, pg_temp.id('dan_chk')), pg_temp.cr('closure_payout', 20000)),
    v_payout, now(), pg_temp.id('dan'), '{"payoutCents": 20000}');
  assert jsonb_array_length(r->'canceled_card_ids') = 1, 'closure: card canceled';
  assert (select status from accounts where id = pg_temp.id('dan_chk')) = 'closed' and pg_temp.posted(pg_temp.id('dan_chk')) = 0, 'closure: closed at zero';
  assert (select status from closures where id = pg_temp.id('closure1')) = 'completed', 'closure: recorded';
  assert (select amount_cents from transfers where id = pg_temp.id('payout1')) = 20000, 'closure: payout transfer';
  begin
    perform harbor_close_account(pg_temp.id('dan'), v_closure, jsonb_build_object('accounts', jsonb_build_array(
        jsonb_build_object('id', pg_temp.id('dan_chk'), 'posted_cents', 0))), null, null, now(), pg_temp.id('dan'), '{}');
    raise exception 'FAIL closing a closed account accepted';
  exception when raise_exception then if sqlerrm <> 'harbor:already_closed' then raise; end if;
  end;
end $$;

-- 8j. Clients can call none of the money operations; the service role can.
set role authenticated;
do $$ begin
  begin perform harbor_ach_settle(gen_random_uuid(), now()); raise exception 'CLIENT CALLED A MONEY OPERATION';
  exception when insufficient_privilege then null; end;
  begin perform harbor__post_ledger('{}', now()); raise exception 'CLIENT CALLED AN INTERNAL HELPER';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ begin
  assert not harbor_ach_settle(gen_random_uuid(), now()), 'service role can call money operations';
end $$;
reset role;

do $$ begin
  assert (select coalesce(sum(debit) - sum(credit), 0) from ledger_lines) = 0, 'trial balance is zero';
end $$;
\echo 'db_checks: all assertions passed'
