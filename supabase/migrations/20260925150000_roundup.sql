-- Round-up savings: per-user on/off setting. Reads are scoped to the owner (or staff);
-- all writes go through the `api` Edge Function using the service role.

create table roundup_settings (
  user_id uuid primary key references profiles(id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table roundup_settings enable row level security;
revoke insert, update, delete, truncate on roundup_settings from anon, authenticated;
create policy "own roundup" on roundup_settings for select using (user_id = auth.uid() or is_staff());
