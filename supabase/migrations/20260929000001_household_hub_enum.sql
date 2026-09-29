-- Household money hub: add the temporary "envelope" account kind. In its own migration so the new
-- enum value is committed before later migrations reference it (Postgres won't use a new enum value
-- in the same transaction that adds it).
alter type account_kind add value if not exists 'envelope';
