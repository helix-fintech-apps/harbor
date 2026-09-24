-- Assertions for supabase/seed.sql, run by scripts/ci/db_validate.sh on a fresh database after the
-- migrations and TWO runs of the seed (it must be idempotent).
\set ON_ERROR_STOP 1

do $$
declare
  u record;
begin
  assert (select count(*) from auth.users where email like '%@harbor.test') = 7, 'seed: 7 demo users';
  for u in select * from auth.users where email like '%@harbor.test' loop
    -- GoTrue signs in with bcrypt (pgcrypto bf hashes are $2a$, which Go's bcrypt verifies).
    assert u.encrypted_password like '$2a$%', format('seed: %s has a bcrypt hash', u.email);
    assert extensions.crypt('Harbor!2026', u.encrypted_password) = u.encrypted_password, format('seed: %s password is Harbor!2026', u.email);
    assert extensions.crypt('harbor!2026', u.encrypted_password) <> u.encrypted_password, format('seed: %s rejects a wrong password', u.email);
    assert u.aud = 'authenticated' and u.role = 'authenticated' and u.instance_id = '00000000-0000-0000-0000-000000000000',
      format('seed: %s aud/role/instance as GoTrue expects', u.email);
    assert u.email_confirmed_at is not null and u.confirmed_at is not null, format('seed: %s email confirmed', u.email);
    -- NULL token columns make GoTrue fail sign-in with "Database error querying schema".
    assert u.confirmation_token = '' and u.recovery_token = '' and u.email_change_token_new = '' and u.email_change = ''
       and u.email_change_token_current = '' and u.phone_change = '' and u.phone_change_token = '' and u.reauthentication_token = '',
      format('seed: %s token columns are empty strings', u.email);
    assert u.raw_app_meta_data->>'provider' = 'email', format('seed: %s app metadata provider', u.email);
    assert (select count(*) from auth.identities i
             where i.user_id = u.id and i.provider = 'email' and i.provider_id = u.id::text
               and i.identity_data->>'sub' = u.id::text and i.email = u.email) = 1,
      format('seed: %s has exactly one email identity', u.email);
  end loop;
end $$;

do $$ begin
  -- Profiles, staff roles and KYC outcomes match demo mode.
  assert (select string_agg(email || '=' || role || '/' || kyc_state, ' ' order by email) from profiles where email like '%@harbor.test') =
    'admin@harbor.test=admin/unverified agent@harbor.test=support_agent/unverified ava@harbor.test=customer/approved '
    'ben@harbor.test=customer/approved nia@harbor.test=customer/unverified oleg@harbor.test=customer/frozen_legal '
    'rita@harbor.test=customer/needs_review', 'seed: roles and KYC states';
  assert (select legal_name from profiles where email = 'ava@harbor.test') = 'Ava Harbor', 'seed: legal names from metadata';
  assert (select count(*) from kyc_checks) = 4, 'seed: one KYC check per screened customer';
  assert (select reason from kyc_checks where user_id = '00000000-0000-4000-8000-00000000d0d0') = 'sanctions match: Oleg Embargo', 'seed: sanctions reason';

  -- Accounts and money (posted = available: the deposits settled and their holds were released).
  assert (select count(*) from accounts where status = 'open') = 4, 'seed: checking + savings for Ava and Ben only';
  assert (select posted_cents || '/' || available_cents from account_available where account_id = '10000000-0000-4000-8000-00000000a0a1') = '250000/250000',
    'seed: Ava checking $2,500 available';
  assert (select posted_cents || '/' || available_cents from account_available where account_id = '10000000-0000-4000-8000-00000000b0b1') = '50000/50000',
    'seed: Ben checking $500 available';
  assert (select count(*) from transfers where kind = 'ach_in' and status = 'settled') = 2, 'seed: two settled ACH deposits';
  assert (select count(*) from holds where status = 'active') = 0, 'seed: no active holds';
  assert (select count(*) from ledger_txns) = 2, 'seed: one ledger txn per deposit (idempotent reruns post nothing)';
  assert (select coalesce(sum(debit) - sum(credit), 0) from ledger_lines) = 0, 'seed: trial balance is zero';

  -- Banks are name-matched and past the 72h cooling-off; Ava has one active virtual card.
  assert (select count(*) from linked_banks where name_matched and status = 'active' and linked_at <= now() - interval '72 hours') = 2,
    'seed: banks usable for withdrawals';
  assert (select count(*) from cards where status = 'active' and account_id = '10000000-0000-4000-8000-00000000a0a1') = 1, 'seed: Ava virtual card';
end $$;

-- RLS still scopes the seeded data: Ben sees his own pockets only.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-00000000b0b0';
do $$ begin
  assert (select count(*) from accounts) = 2, 'seed RLS: Ben sees his two pockets';
  assert (select count(*) from cards) = 0, 'seed RLS: Ben sees no card of Ava';
end $$;
reset role;

\echo 'seed_checks: all assertions passed'
