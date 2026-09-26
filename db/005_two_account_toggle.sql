begin;

-- Off by default: the two-account test creates two temporary users and test rows in
-- the client's own database. Existing projects keep it off until an owner opts in.
alter table public.projects
  add column two_account_enabled boolean not null default false;

-- Recreate the view to expose the new flag (same shape otherwise).
drop view public.projects_public;
create view public.projects_public
with (security_invoker = true)
as
select p.id, p.agency_id, p.name, p.supabase_url, p.anon_key,
       p.tables, p.buckets, p.rpc, p.two_account, p.two_account_enabled, p.enabled, p.created_at,
       f.has_service_key, f.has_database_url
from public.projects p
cross join lateral private.secret_flags(p.id) f;

revoke all on public.projects_public from anon;
grant select on public.projects_public to authenticated;

commit;
