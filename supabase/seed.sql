-- Harbor demo data (TEST ONLY). Password for every user: Harbor!2026
--
-- Mirrors the in-browser demo mode (supabase/functions/_shared/app/demo.ts: DEMO_USERS + seedDemo),
-- with the same user ids, so the live app starts where demo mode starts:
--   ava@harbor.test    Ava Harbor     approved, tier1: checking $2,500 (settled ACH from First Platypus
--                                     Bank ••2563, linked 7 days ago), savings $0, one virtual card
--   ben@harbor.test    Ben Rivers     approved, tier1: checking $500 (settled ACH from Tattersall ••9991)
--   rita@harbor.test   Rita Review    needs_review (identity requires input): in the admin KYC queue
--   oleg@harbor.test   Oleg Embargo   frozen_legal (sanctions match)
--   nia@harbor.test    Nia New        unverified
--   admin@harbor.test  Ada Admin      admin
--   agent@harbor.test  Sam Support    support_agent
--
-- `supabase db reset` runs this after the migrations; for a hosted project run it once with
-- `psql "$SUPABASE_DB_URL" -f supabase/seed.sql`. Idempotent: safe to run more than once.
-- Users go straight into auth.users + auth.identities, which is what GoTrue needs for email/password
-- sign-in (bcrypt via pgcrypto; the token columns must be '' rather than NULL). The
-- on_auth_user_created trigger creates each profile as an unverified customer: staff roles and KYC
-- outcomes are set afterwards, because signup can never grant them. Money is created through the
-- same harbor_* operations the api function uses, so every ledger txn balances.

-- 1. Auth users ----------------------------------------------------------------------------------
with demo(id, email, legal_name) as (
  values
    ('00000000-0000-4000-8000-00000000a0a0'::uuid, 'ava@harbor.test',   'Ava Harbor'),
    ('00000000-0000-4000-8000-00000000b0b0'::uuid, 'ben@harbor.test',   'Ben Rivers'),
    ('00000000-0000-4000-8000-00000000c0c0'::uuid, 'rita@harbor.test',  'Rita Review'),
    ('00000000-0000-4000-8000-00000000d0d0'::uuid, 'oleg@harbor.test',  'Oleg Embargo'),
    ('00000000-0000-4000-8000-00000000e0e0'::uuid, 'nia@harbor.test',   'Nia New'),
    ('00000000-0000-4000-8000-00000000ad00'::uuid, 'admin@harbor.test', 'Ada Admin'),
    ('00000000-0000-4000-8000-00000000ae00'::uuid, 'agent@harbor.test', 'Sam Support')
)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select '00000000-0000-0000-0000-000000000000', d.id, 'authenticated', 'authenticated', d.email,
       extensions.crypt('Harbor!2026', extensions.gen_salt('bf')), now(),
       '{"provider": "email", "providers": ["email"]}'::jsonb,
       jsonb_build_object('legal_name', d.legal_name, 'full_name', d.legal_name, 'email_verified', true),
       now(), now(), '', '', '', '', '', '', '', ''
from demo d
on conflict (id) do nothing;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from auth.users u
where u.email like '%@harbor.test'
  and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- Profiles come from the on_auth_user_created trigger; make sure they exist even without it.
insert into public.profiles (id, email, legal_name, role, kyc_state)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'legal_name', ''), 'customer', 'unverified'
from auth.users u where u.email like '%@harbor.test'
on conflict (id) do nothing;

-- 2. Staff roles (granted only by update, never at signup) ----------------------------------------
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000ad00';
update public.profiles set role = 'support_agent' where id = '00000000-0000-4000-8000-00000000ae00';

-- 3. KYC outcomes from the fake identity vendor + sanctions screen (as the api records them) --------
with kyc(id, identity_status, sanctions, decision, reason) as (
  values
    ('00000000-0000-4000-8000-00000000a0a0'::uuid, 'verified',       '{"kind": "clear"}'::jsonb, 'approved',     'identity verified, sanctions clear'),
    ('00000000-0000-4000-8000-00000000b0b0'::uuid, 'verified',       '{"kind": "clear"}'::jsonb, 'approved',     'identity verified, sanctions clear'),
    ('00000000-0000-4000-8000-00000000c0c0'::uuid, 'requires_input', '{"kind": "clear"}'::jsonb, 'needs_review', 'identity requires input'),
    ('00000000-0000-4000-8000-00000000d0d0'::uuid, 'verified',       '{"kind": "confirmed_match", "entry": "Oleg Embargo"}'::jsonb, 'frozen_legal', 'sanctions match: Oleg Embargo')
),
checks as (
  insert into public.kyc_checks (user_id, provider, session_id, identity_status, sanctions, decision, reason, decided_by, created_at)
  select k.id, 'fake', 'vs_fake_' || left(k.id::text, 8) || '_1', k.identity_status, k.sanctions, k.decision::kyc_state, k.reason, null,
         now() - interval '7 days'
  from kyc k
  where not exists (select 1 from public.kyc_checks c where c.user_id = k.id)
  returning user_id, decision
)
update public.profiles p set kyc_state = c.decision from checks c where p.id = c.user_id;

-- 4. Accounts (opened on approval), linked banks past the 72h cooling-off -------------------------
insert into public.accounts (id, user_id, kind, status, account_number, routing_number, nickname, policy_version, opened_at) values
  ('10000000-0000-4000-8000-00000000a0a1', '00000000-0000-4000-8000-00000000a0a0', 'checking', 'open', '880018499015', '091000019', 'Everyday', 1, now() - interval '7 days'),
  ('10000000-0000-4000-8000-00000000a0a2', '00000000-0000-4000-8000-00000000a0a0', 'savings',  'open', '880035276634', '091000019', 'Savings',  1, now() - interval '7 days'),
  ('10000000-0000-4000-8000-00000000b0b1', '00000000-0000-4000-8000-00000000b0b0', 'checking', 'open', '880042039887', '091000019', 'Everyday', 1, now() - interval '7 days'),
  ('10000000-0000-4000-8000-00000000b0b2', '00000000-0000-4000-8000-00000000b0b0', 'savings',  'open', '880058817506', '091000019', 'Savings',  1, now() - interval '7 days')
on conflict do nothing;

insert into public.linked_banks (id, user_id, provider, provider_item_id, provider_account_id, institution, mask, owner_names, name_matched, status, linked_at) values
  ('20000000-0000-4000-8000-00000000a0a1', '00000000-0000-4000-8000-00000000a0a0', 'fake', 'item-First_Platypus_Bank-Ava_Harbor',
   'acc-c4850793', 'First Platypus Bank', '2563', array['Ava Harbor'], true, 'active', now() - interval '7 days'),
  ('20000000-0000-4000-8000-00000000b0b1', '00000000-0000-4000-8000-00000000b0b0', 'fake', 'item-Tattersall_Credit_Union-Ben_Rivers',
   'acc-ddeb85f7', 'Tattersall Credit Union', '9991', array['Ben Rivers'], true, 'active', now() - interval '7 days')
on conflict do nothing;

insert into public.bank_access_tokens (linked_bank_id, access_token) values
  ('20000000-0000-4000-8000-00000000a0a1', 'access-fake-First_Platypus_Bank-Ava_Harbor'),
  ('20000000-0000-4000-8000-00000000b0b1', 'access-fake-Tattersall_Credit_Union-Ben_Rivers')
on conflict do nothing;

-- 5. Opening deposits: ACH pull 7 days ago (credit + hold in one operation), then settled ----------
do $$
declare
  d record;
begin
  for d in
    select * from (values
      ('30000000-0000-4000-8000-00000000a0a1'::uuid, '00000000-0000-4000-8000-00000000a0a0'::uuid,
       '10000000-0000-4000-8000-00000000a0a1'::uuid, '20000000-0000-4000-8000-00000000a0a1'::uuid, 250000::bigint),
      ('30000000-0000-4000-8000-00000000b0b1'::uuid, '00000000-0000-4000-8000-00000000b0b0'::uuid,
       '10000000-0000-4000-8000-00000000b0b1'::uuid, '20000000-0000-4000-8000-00000000b0b1'::uuid, 50000::bigint)
    ) as v(transfer_id, user_id, account_id, bank_id, amount)
  loop
    perform public.harbor_ach_pull_create(
      jsonb_build_object('id', d.transfer_id, 'user_id', d.user_id, 'kind', 'ach_in', 'to_account_id', d.account_id,
        'linked_bank_id', d.bank_id, 'amount_cents', d.amount, 'fee_cents', 0, 'status', 'pending',
        'settle_at', now() - interval '4 days', 'policy_version', 1, 'fee_version', 1, 'created_at', now() - interval '7 days'),
      jsonb_build_object('kind', 'ach_in', 'ref', d.transfer_id, 'idem', 'transfer:' || d.transfer_id, 'lines', jsonb_build_array(
        jsonb_build_object('account', 'ach_clearing', 'debit', d.amount, 'credit', 0),
        jsonb_build_object('account', 'customer_deposits', 'party', d.account_id, 'debit', 0, 'credit', d.amount))),
      jsonb_build_object('account_id', d.account_id, 'kind', 'ach_in', 'amount_cents', d.amount, 'ref_id', d.transfer_id,
        'release_at', now() - interval '4 days', 'created_at', now() - interval '7 days'),
      null,
      now() - interval '7 days');
    perform public.harbor_ach_settle(d.transfer_id, now());
  end loop;
end $$;

-- 6. Ava's virtual card (fake issuer) ----------------------------------------------------------------
insert into public.cards (id, account_id, holder_user_id, family_member_id, kind, status, last4, provider, provider_card_id, created_at) values
  ('40000000-0000-4000-8000-00000000a0a1', '10000000-0000-4000-8000-00000000a0a1', '00000000-0000-4000-8000-00000000a0a0', null,
   'virtual', 'active', '7615', 'fake', 'ic_fake_40000000-0000-4000-8000-00000000a0a1', now())
on conflict do nothing;
