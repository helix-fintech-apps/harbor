-- Customer-support cases. Customers open cases; support agents (staff) work them from a shared
-- queue. A case carries a contact snapshot (first/last name, email); the customer's join date and
-- total Harbor balance are derived at read time. Many agents can be assigned to one case.
-- Status: Pending -> In Review -> Finalized (reopenable).

create type support_case_status as enum ('pending', 'in_review', 'finalized');

create table support_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  first_name text not null check (length(trim(first_name)) > 0),
  last_name text not null check (length(trim(last_name)) > 0),
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  subject text not null check (length(trim(subject)) > 0),
  body text not null default '',
  status support_case_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finalized_at timestamptz,
  constraint finalized_has_time check (status <> 'finalized' or finalized_at is not null)
);
create index on support_cases (status, created_at);
create index on support_cases (user_id, created_at desc);

-- Many support agents can handle one case (shared queue).
create table support_case_agents (
  case_id uuid not null references support_cases(id) on delete cascade,
  agent_id uuid not null references profiles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (case_id, agent_id)
);
create index on support_case_agents (agent_id);

-- RLS: customers see their own cases; staff see all. All writes go through the api (service role).
alter table support_cases enable row level security;
revoke insert, update, delete, truncate on support_cases from anon, authenticated;
create policy "own or staff cases" on support_cases for select
  using (user_id = auth.uid() or is_staff());

alter table support_case_agents enable row level security;
revoke insert, update, delete, truncate on support_case_agents from anon, authenticated;
create policy "case agents for staff or owner" on support_case_agents for select
  using (is_staff() or exists (select 1 from support_cases sc where sc.id = case_id and sc.user_id = auth.uid()));
