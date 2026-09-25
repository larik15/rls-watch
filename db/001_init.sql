-- RLS Watch — initial schema
-- Apply once in the Supabase SQL editor of the "rls-watch" project (see db/README.md).
--
-- Rules this file follows (this product must not have the bugs it looks for):
--   * RLS is enabled on every table.
--   * Policies are split per command and always `to authenticated`. No `using (true)`.
--   * Membership is checked through SECURITY DEFINER helpers with an empty search_path.
--   * Client secrets (service role key, database URL) live in Supabase Vault. The
--     browser can write them through upsert_project_secrets() but can never read them;
--     only the worker (service_role) can, through get_project_secrets().
--   * runs / findings / alerts are written only by the worker (service_role bypasses RLS);
--     authenticated users can read them, nothing else.

begin;

-- ---------------------------------------------------------------------------
-- Preconditions
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'supabase_vault extension is required (Database → Extensions → enable "supabase_vault")';
  end if;
end $$;

-- Objects in this schema are not exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.agencies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  owner_id         uuid not null references auth.users on delete cascade,
  telegram_chat_id text,
  created_at       timestamptz not null default now()
);

create table public.members (
  agency_id uuid not null references public.agencies on delete cascade,
  user_id   uuid not null references auth.users on delete cascade,
  role      text not null check (role in ('owner', 'member')),
  primary key (agency_id, user_id)
);
create index members_user_id_idx on public.members (user_id);

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  agency_id    uuid not null references public.agencies on delete cascade,
  name         text not null,
  supabase_url text not null,
  anon_key     text not null,
  tables       text[] not null default '{}',
  buckets      text[] not null default '{}',
  rpc          text[] not null default '{}',
  -- [{ "name": "...", "ownerColumn": "...", "idColumn": "...", "sampleRow": {...} }]
  two_account  jsonb not null default '[]' check (jsonb_typeof(two_account) = 'array'),
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);
create index projects_agency_id_idx on public.projects (agency_id);

-- Vault secret ids per project. Not in the public schema, no client access at all.
create table private.project_secrets (
  project_id          uuid primary key references public.projects on delete cascade,
  service_role_key_id uuid,
  database_url_id     uuid
);
alter table private.project_secrets enable row level security;
-- (no policies: only SECURITY DEFINER functions below touch this table)

create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text check (status in ('ok', 'error')),
  error       text,
  counts      jsonb not null default '{"critical":0,"high":0,"medium":0,"info":0}',
  report_md   text
);
create index runs_project_started_idx on public.runs (project_id, started_at desc);

create table public.findings (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.runs on delete cascade,
  project_id  uuid not null references public.projects on delete cascade,
  severity    text not null check (severity in ('critical', 'high', 'medium', 'info')),
  kind        text not null,
  target      text,
  message     text not null,
  fix         text,
  fingerprint text not null
);
create index findings_run_id_idx on public.findings (run_id);
create index findings_project_fp_idx on public.findings (project_id, fingerprint);

create table public.alerts (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects on delete cascade,
  run_id     uuid references public.runs on delete cascade,
  channel    text not null,
  payload    jsonb not null,
  sent_at    timestamptz not null default now()
);
create index alerts_project_id_idx on public.alerts (project_id);

-- "Run now" / "send test message" requests from the web app, polled by the worker.
create table public.run_requests (
  id           uuid primary key default gen_random_uuid(),
  agency_id    uuid not null references public.agencies on delete cascade,
  project_id   uuid references public.projects on delete cascade,
  kind         text not null check (kind in ('run', 'telegram_test')),
  requested_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at   timestamptz not null default now(),
  picked_at    timestamptz,
  done_at      timestamptz,
  error        text,
  check (kind <> 'run' or project_id is not null)
);
create index run_requests_pending_idx on public.run_requests (created_at) where picked_at is null;

-- ---------------------------------------------------------------------------
-- Membership helpers (used by every policy)
-- ---------------------------------------------------------------------------

create function public.is_agency_member(agency_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.agency_id = is_agency_member.agency_id
      and m.user_id = (select auth.uid())
  );
$$;

create function public.is_agency_owner(agency_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.agency_id = is_agency_owner.agency_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

create function public.project_agency(project_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.agency_id from public.projects p where p.id = project_agency.project_id;
$$;

revoke all on function public.is_agency_member(uuid) from public, anon;
revoke all on function public.is_agency_owner(uuid)  from public, anon;
revoke all on function public.project_agency(uuid)   from public, anon;
grant execute on function public.is_agency_member(uuid) to authenticated;
grant execute on function public.is_agency_owner(uuid)  to authenticated;
grant execute on function public.project_agency(uuid)   to authenticated;

-- The creator of an agency becomes its owner member automatically.
create function private.add_owner_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.members (agency_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger agencies_add_owner_member
after insert on public.agencies
for each row execute function private.add_owner_member();

-- ---------------------------------------------------------------------------
-- Grants: anon gets nothing. Worker-written tables are read-only for users.
-- ---------------------------------------------------------------------------

revoke all on public.agencies, public.members, public.projects, public.runs,
              public.findings, public.alerts, public.run_requests from anon;

revoke insert, update, delete, truncate on public.runs, public.findings, public.alerts
  from authenticated;
revoke update, delete, truncate on public.run_requests from authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

alter table public.agencies     enable row level security;
alter table public.members      enable row level security;
alter table public.projects     enable row level security;
alter table public.runs         enable row level security;
alter table public.findings     enable row level security;
alter table public.alerts       enable row level security;
alter table public.run_requests enable row level security;

-- agencies
-- owner_id check lets `insert ... returning` see the new row before the owner
-- member row (added by the trigger) is visible to the STABLE helper.
create policy agencies_select on public.agencies for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_agency_member(id));
create policy agencies_insert on public.agencies for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy agencies_update on public.agencies for update to authenticated
  using (public.is_agency_owner(id))
  with check (public.is_agency_owner(id) and owner_id = (select auth.uid()));
create policy agencies_delete on public.agencies for delete to authenticated
  using (public.is_agency_owner(id));

-- members: everyone in the agency can see the roster; only the owner manages it,
-- and the owner row itself cannot be added, changed or removed through the API.
create policy members_select on public.members for select to authenticated
  using (public.is_agency_member(agency_id));
create policy members_insert on public.members for insert to authenticated
  with check (public.is_agency_owner(agency_id) and role = 'member');
create policy members_update on public.members for update to authenticated
  using (public.is_agency_owner(agency_id) and role = 'member')
  with check (public.is_agency_owner(agency_id) and role = 'member');
create policy members_delete on public.members for delete to authenticated
  using (public.is_agency_owner(agency_id) and role = 'member');

-- projects: members read and edit, only the owner deletes.
create policy projects_select on public.projects for select to authenticated
  using (public.is_agency_member(agency_id));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.is_agency_member(agency_id));
create policy projects_update on public.projects for update to authenticated
  using (public.is_agency_member(agency_id))
  with check (public.is_agency_member(agency_id));
create policy projects_delete on public.projects for delete to authenticated
  using (public.is_agency_owner(agency_id));

-- runs / findings / alerts: read-only for members (writes come from the worker).
create policy runs_select on public.runs for select to authenticated
  using (public.is_agency_member(public.project_agency(project_id)));
create policy findings_select on public.findings for select to authenticated
  using (public.is_agency_member(public.project_agency(project_id)));
create policy alerts_select on public.alerts for select to authenticated
  using (public.is_agency_member(public.project_agency(project_id)));

-- run_requests: members can see and create requests for their own agency's projects.
create policy run_requests_select on public.run_requests for select to authenticated
  using (public.is_agency_member(agency_id));
create policy run_requests_insert on public.run_requests for insert to authenticated
  with check (
    public.is_agency_member(agency_id)
    and requested_by = (select auth.uid())
    and picked_at is null and done_at is null and error is null
    and (project_id is null or public.project_agency(project_id) = agency_id)
  );

-- ---------------------------------------------------------------------------
-- Secrets (Vault)
-- ---------------------------------------------------------------------------

-- Browser → DB. Owner only. Semantics per argument:
--   null  = leave unchanged,  ''  = remove,  anything else = set.
create function public.upsert_project_secrets(
  project_id       uuid,
  service_role_key text,
  database_url     text
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_agency uuid;
  v_row    private.project_secrets;
begin
  select p.agency_id into v_agency from public.projects p where p.id = upsert_project_secrets.project_id;
  if v_agency is null or not public.is_agency_owner(v_agency) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  insert into private.project_secrets (project_id) values (upsert_project_secrets.project_id)
  on conflict (project_id) do nothing;
  select * into v_row from private.project_secrets s
  where s.project_id = upsert_project_secrets.project_id for update;

  if service_role_key is not null then
    if service_role_key = '' then
      delete from vault.secrets where id = v_row.service_role_key_id;
      v_row.service_role_key_id := null;
    elsif v_row.service_role_key_id is null then
      v_row.service_role_key_id := vault.create_secret(
        service_role_key, 'rls-watch:' || v_row.project_id || ':service_role_key');
    else
      perform vault.update_secret(v_row.service_role_key_id, service_role_key);
    end if;
  end if;

  if database_url is not null then
    if database_url = '' then
      delete from vault.secrets where id = v_row.database_url_id;
      v_row.database_url_id := null;
    elsif v_row.database_url_id is null then
      v_row.database_url_id := vault.create_secret(
        database_url, 'rls-watch:' || v_row.project_id || ':database_url');
    else
      perform vault.update_secret(v_row.database_url_id, database_url);
    end if;
  end if;

  update private.project_secrets s
  set service_role_key_id = v_row.service_role_key_id,
      database_url_id     = v_row.database_url_id
  where s.project_id = v_row.project_id;
end;
$$;

revoke all on function public.upsert_project_secrets(uuid, text, text) from public, anon;
grant execute on function public.upsert_project_secrets(uuid, text, text) to authenticated;

-- DB → worker. service_role only.
create function public.get_project_secrets(project_id uuid)
returns table (service_role_key text, database_url text)
language sql stable security definer set search_path = ''
as $$
  select
    (select d.decrypted_secret from vault.decrypted_secrets d where d.id = s.service_role_key_id),
    (select d.decrypted_secret from vault.decrypted_secrets d where d.id = s.database_url_id)
  from private.project_secrets s
  where s.project_id = get_project_secrets.project_id;
$$;

revoke all on function public.get_project_secrets(uuid) from public, anon, authenticated;
grant execute on function public.get_project_secrets(uuid) to service_role;

-- Flags for the UI. Returns false/false for projects the caller cannot see.
create function private.secret_flags(project_id uuid)
returns table (has_service_key boolean, has_database_url boolean)
language sql stable security definer set search_path = ''
as $$
  select
    coalesce(bool_or(s.service_role_key_id is not null), false),
    coalesce(bool_or(s.database_url_id is not null), false)
  from private.project_secrets s
  where s.project_id = secret_flags.project_id
    and public.is_agency_member(public.project_agency(s.project_id));
$$;

grant usage on schema private to authenticated;
revoke all on function private.secret_flags(uuid) from public, anon;
grant execute on function private.secret_flags(uuid) to authenticated;
revoke all on function private.add_owner_member() from public, anon, authenticated;

-- Remove Vault entries when a project (and so its secrets row) is deleted.
create function private.delete_vault_secrets()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from vault.secrets
  where id in (old.service_role_key_id, old.database_url_id);
  return old;
end;
$$;
revoke all on function private.delete_vault_secrets() from public, anon, authenticated;

create trigger project_secrets_delete_vault
after delete on private.project_secrets
for each row execute function private.delete_vault_secrets();

-- What the web app reads. security_invoker = the caller's RLS on projects applies.
create view public.projects_public
with (security_invoker = true)
as
select p.id, p.agency_id, p.name, p.supabase_url, p.anon_key,
       p.tables, p.buckets, p.rpc, p.two_account, p.enabled, p.created_at,
       f.has_service_key, f.has_database_url
from public.projects p
cross join lateral private.secret_flags(p.id) f;

revoke all on public.projects_public from anon;
grant select on public.projects_public to authenticated;

commit;
