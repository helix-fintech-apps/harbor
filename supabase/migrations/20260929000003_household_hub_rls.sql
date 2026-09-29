-- RLS for the household money hub tables. As everywhere in Harbor, browser reads are scoped to the
-- user; ALL writes go through the `api` Edge Function (service role). anon/authenticated get no
-- write grants. (Accounts, cards, transfers, holds and ledger_lines already have their policies from
-- the base RLS migration, which cover the new columns and the new ledger accounts.)

do $$ declare t text;
begin
  foreach t in array array['households', 'household_members', 'zelle_payments', 'zelle_schedules']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on %I from anon, authenticated', t);
  end loop;
end $$;

-- Owner, active members and staff can read a household.
create policy "households" on households for select using (
  owner_user_id = auth.uid()
  or is_staff()
  or exists (
    select 1 from household_members m
    where m.household_id = households.id and m.user_id = auth.uid() and m.status <> 'removed'
  )
);

-- A member sees their own membership row; the owner sees all rows in their household; staff see all.
create policy "household members" on household_members for select using (
  is_staff()
  or user_id = auth.uid()
  or exists (
    select 1 from households h where h.id = household_members.household_id and h.owner_user_id = auth.uid()
  )
);

create policy "zelle payments" on zelle_payments for select using (user_id = auth.uid() or is_staff());
create policy "zelle schedules" on zelle_schedules for select using (user_id = auth.uid() or is_staff());
