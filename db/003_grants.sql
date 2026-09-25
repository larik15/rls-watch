-- RLS Watch — schema/table grants
--
-- This project was created with "Automatically expose new tables" OFF, so Supabase
-- does not grant `authenticated`/`service_role` access to new tables by itself — RLS
-- alone controls nothing if the role has no table privileges to begin with. This file
-- is the one-time catch-up plus a rule so every table created from now on gets the
-- same grants automatically. `anon` gets nothing: every table requires a signed-in
-- session, checked by the policies in 001_init.sql.
--
-- Already applied by hand in the SQL editor; kept here so the grants are versioned
-- and a fresh copy of this project (or a review) can reproduce them.

begin;

-- Schema usage
grant usage on schema public to authenticated, service_role;
revoke all on schema public from anon;

-- Existing tables
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;

-- Existing sequences (identity/serial columns, if any)
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on all sequences in schema public from anon;

-- Same grants for tables/sequences created after this migration, by the role that
-- runs migrations in the Supabase SQL editor (postgres).
alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to authenticated, service_role;

commit;
