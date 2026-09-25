-- Disputes raised by a support agent from a case. Links the support case to the dispute record and
-- to the merchant refund issued to return the money. Any staff agent working the queue can raise
-- one; marking a transaction disputed kicks off the refund.

create table case_disputes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references support_cases(id) on delete cascade,
  auth_id uuid not null references card_authorizations(id),
  dispute_id uuid not null references disputes(id),
  refund_id text not null references card_refunds(id),
  agent_id uuid not null references profiles(id),
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);
create index on case_disputes (case_id, created_at desc);
create index on case_disputes (auth_id);

-- RLS: staff see all case disputes; the case owner sees their own. All writes go through the api.
alter table case_disputes enable row level security;
revoke insert, update, delete, truncate on case_disputes from anon, authenticated;
create policy "case disputes for staff or owner" on case_disputes for select
  using (
    is_staff()
    or exists (select 1 from support_cases sc where sc.id = case_id and sc.user_id = auth.uid())
  );
