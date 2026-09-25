-- Savings goals. A customer names a savings goal and contributes to it from checking.
-- All money is integer cents (bigint). Contributions move money via the double-entry ledger
-- (checking -> savings) and mirror the running total onto saved_cents.

create table savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  target_cents bigint not null check (target_cents > 0),
  saved_cents bigint not null default 0 check (saved_cents >= 0),
  created_at timestamptz not null default now()
);
create index on savings_goals (user_id, created_at desc);

-- Reads are owner-or-staff; all writes go through the service (service role), never the client.
alter table savings_goals enable row level security;
revoke insert, update, delete, truncate on savings_goals from anon, authenticated;
create policy "own goals" on savings_goals for select using (user_id = auth.uid() or is_staff());
