-- Family-card invitations + scheduled card start dates.
--   * An account owner invites a family member (first name, last name, DOB, email).
--   * The invitee accepts with a one-time token; a family_member + debit card are created.
--   * A card may carry a future start date (cards.activate_at); it cannot authorize before then.

-- A card's scheduled start. NULL = usable immediately once issued.
alter table cards add column activate_at timestamptz;

create type invite_status as enum ('sent', 'accepted', 'expired', 'revoked');

create table family_invites (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references profiles(id) on delete cascade,
  member_user_id uuid references profiles(id),          -- set when the invitee accepts (or pre-matched by email)
  family_member_id uuid references family_members(id),  -- set when accepted
  first_name text not null check (length(trim(first_name)) > 0),
  last_name text not null check (length(trim(last_name)) > 0),
  dob date not null check (dob < current_date),
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  kind text not null check (kind in ('spouse', 'teen')),
  per_txn_cents bigint not null check (per_txn_cents >= 0),
  daily_cents bigint not null check (daily_cents >= 0),
  monthly_cents bigint not null check (monthly_cents >= 0),
  blocked_mcc_groups text[] not null default '{}',
  card_kind text not null check (card_kind in ('virtual', 'physical')),
  card_activate_at timestamptz,                         -- NULL = the issued card starts immediately
  token text not null unique,
  status invite_status not null default 'sent',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invite_limits_ordered check (per_txn_cents <= daily_cents and daily_cents <= monthly_cents),
  constraint accepted_has_member check (status <> 'accepted' or (member_user_id is not null and family_member_id is not null))
);
create index on family_invites (owner_user_id, created_at desc);
create index on family_invites (email);

-- One outstanding (sent) invite per owner+email; accepted/expired/revoked don't block a re-invite.
create unique index family_invites_one_open_per_email on family_invites (owner_user_id, email) where status = 'sent';

-- RLS: browser reads are scoped; every write goes through the `api` Edge Function (service role).
alter table family_invites enable row level security;
revoke insert, update, delete, truncate on family_invites from anon, authenticated;
create policy "own invites" on family_invites for select
  using (owner_user_id = auth.uid() or member_user_id = auth.uid() or is_staff());
