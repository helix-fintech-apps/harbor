-- Household Money Hub: new account kind. In its own migration so the enum value is committed
-- before any later migration (or code) uses it (Postgres forbids using a new enum value in the
-- same transaction that adds it).
alter type account_kind add value if not exists 'envelope';
