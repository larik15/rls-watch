-- RLS Watch — security round (external review)
--
--  1. supabase_url / database_url / anon_key / two_account are validated on write.
--     Changing supabase_url is owner-only and wipes the stored secrets; replacing the
--     database URL wipes the stored service key unless a new one is sent with it.
--  2. projects.agency_id is immutable.
--  3. runs / findings / alerts carry agency_id; their policies no longer need
--     project_agency(), which authenticated can no longer execute.
--  4. Leases: runs.status is never null, one active run per project, expired leases
--     end as 'timeout'; run_requests are claimed with an expiring lease.
--  5. run_requests rate limits (trigger).
--  7. counts is null unless status = 'ok'.
--  8. runs.checks / runs.diff record what each run evaluated.
--  9-10. alerts.status / alerts.error; channel 'none' when alerts aren't configured.
-- 11. two_account_artifacts; enabling the two-account test is owner-only.
-- 12. projects.rpc_probe_confirmed (owner-only).
-- 14. Vault: missing secret rows are recreated; has_* flags check that they exist.
-- Plus: 003 granted authenticated more than 001 intended (TRUNCATE on agencies/members/
-- projects, writes on worker-only tables). RLS blocked the API paths; revoked anyway.

begin;

-- ---------------------------------------------------------------------------
-- 0. Grants
-- ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on public.runs, public.findings, public.alerts from authenticated;
revoke update, delete, truncate on public.run_requests from authenticated;
revoke truncate on public.agencies, public.members, public.projects from authenticated;

-- ---------------------------------------------------------------------------
-- 1. Validators (same rules as shared/validate.mjs, used by the web app and worker)
-- ---------------------------------------------------------------------------

create function private.is_valid_supabase_url(p text)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(p ~ '^https://[a-z]{20}\.supabase\.co$', false);
$$;

-- Pooler (*.pooler.supabase.com) or direct (db.<ref>.supabase.co). Userinfo may not
-- contain / ? # (URL-encode the password). The only query parameter allowed is
-- sslmode: node-postgres honours ?host=, ?port=, ?sslcert= etc. over the URL's host.
create function private.is_valid_database_url(p text)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(p ~* '^postgres(ql)?://([^/?#]*@)?[a-z0-9.-]+\.supabase\.(com|co)(:[0-9]{1,5})?(/[^?#]*)?(\?sslmode=[a-z-]+)?$', false);
$$;

create function private.jwt_role(p text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_payload text := translate(split_part(p, '.', 2), '-_', '+/');
begin
  v_payload := v_payload || repeat('=', (4 - length(v_payload) % 4) % 4);
  return convert_from(decode(v_payload, 'base64'), 'UTF8')::jsonb ->> 'role';
exception when others then
  return null;
end;
$$;

-- The anon key is stored in plain text and shown to every agency member, so a service
-- role key pasted into this field would leak to all of them.
create function private.is_valid_anon_key(p text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p is null then false
    when starts_with(p, 'sb_publishable_') then true
    when starts_with(p, 'sb_') then false
    when p ~ '^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$' then private.jwt_role(p) is not distinct from 'anon'
    else false
  end;
$$;

-- [{ "name": ident, "ownerColumn"?: ident, "idColumn"?: ident, "sampleRow"?: object }], at most 20.
-- Column names end up in PostgREST query strings the service role key is sent with.
create function private.is_valid_two_account(p jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 20
     and not exists (
       select 1
       from jsonb_array_elements(p) e
       where case
         when jsonb_typeof(e) <> 'object' then true
         else jsonb_typeof(e -> 'name') is distinct from 'string'
           or (e ->> 'name') !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
           or (e ? 'ownerColumn' and (jsonb_typeof(e -> 'ownerColumn') <> 'string'
                                      or (e ->> 'ownerColumn') !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'))
           or (e ? 'idColumn' and (jsonb_typeof(e -> 'idColumn') <> 'string'
                                   or (e ->> 'idColumn') !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'))
           or (e ? 'sampleRow' and jsonb_typeof(e -> 'sampleRow') <> 'object')
           or exists (select 1 from jsonb_object_keys(e) k
                      where k not in ('name', 'ownerColumn', 'idColumn', 'sampleRow'))
       end
     );
$$;

revoke all on function private.is_valid_supabase_url(text) from public, anon, authenticated;
revoke all on function private.is_valid_database_url(text) from public, anon, authenticated;
revoke all on function private.jwt_role(text)              from public, anon, authenticated;
revoke all on function private.is_valid_anon_key(text)     from public, anon, authenticated;
revoke all on function private.is_valid_two_account(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2 / 11 / 12. projects: new flags, agency_id pinned, owner-only changes
-- ---------------------------------------------------------------------------

alter table public.projects
  add column rpc_probe_confirmed boolean not null default false;

create function private.projects_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner boolean;
begin
  if not private.is_valid_supabase_url(new.supabase_url) then
    raise exception 'supabase_url must be https://<20-letter project ref>.supabase.co' using errcode = '22023';
  end if;
  if not private.is_valid_anon_key(new.anon_key) then
    raise exception 'anon_key must be the project''s sb_publishable_ key or legacy anon JWT, never a secret/service role key'
      using errcode = '22023';
  end if;
  if not private.is_valid_two_account(new.two_account) then
    raise exception 'two_account must be a list of at most 20 {name, ownerColumn?, idColumn?, sampleRow?} with plain identifiers'
      using errcode = '22023';
  end if;

  -- Everything below is about what a signed-in user may change. The worker (service
  -- role) and migrations (postgres) have no auth.uid().
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (new.two_account_enabled or new.rpc_probe_confirmed) and not public.is_agency_owner(new.agency_id) then
      raise exception 'only the agency owner can enable the two-account test or RPC probing' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.agency_id is distinct from old.agency_id then
    raise exception 'a project cannot be moved to another agency' using errcode = '42501';
  end if;

  v_owner := public.is_agency_owner(old.agency_id);

  if new.supabase_url is distinct from old.supabase_url then
    if not v_owner then
      raise exception 'only the agency owner can change the Supabase URL' using errcode = '42501';
    end if;
    -- The stored service key / database URL belong to the old project. Keeping them
    -- would send them to whatever the new URL points at. The delete trigger on
    -- private.project_secrets removes the Vault entries.
    delete from private.project_secrets s where s.project_id = old.id;
  end if;

  if not v_owner then
    if (new.two_account_enabled and not old.two_account_enabled)
       or (new.rpc_probe_confirmed and not old.rpc_probe_confirmed) then
      raise exception 'only the agency owner can enable the two-account test or RPC probing' using errcode = '42501';
    end if;
    -- A member may edit the lists, but the owner has to re-confirm what gets written to /
    -- invoked in the client's project.
    if new.two_account is distinct from old.two_account then
      new.two_account_enabled := false;
    end if;
    if new.rpc is distinct from old.rpc then
      new.rpc_probe_confirmed := false;
    end if;
  end if;

  return new;
end;
$$;
revoke all on function private.projects_guard() from public, anon, authenticated;

create trigger projects_guard
before insert or update on public.projects
for each row execute function private.projects_guard();

-- For policies: a subquery on projects inside a projects policy is "infinite recursion".
-- STABLE, so inside an UPDATE it sees the row as it was before the statement. Lives in
-- private (not exposed through the Data API); only confirms a (project, agency) pair.
create function private.project_in_agency(p_project_id uuid, p_agency_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p where p.id = p_project_id and p.agency_id = p_agency_id
  );
$$;
revoke all on function private.project_in_agency(uuid, uuid) from public, anon;
grant execute on function private.project_in_agency(uuid, uuid) to authenticated;

drop policy projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (public.is_agency_member(agency_id))
  with check (
    public.is_agency_member(agency_id)
    and private.project_in_agency(id, agency_id)
  );

-- ---------------------------------------------------------------------------
-- 14 / 1. Secrets: validate the database URL, wipe the service key when the database
-- URL is replaced, recreate Vault rows that have gone missing.
-- ---------------------------------------------------------------------------

-- null = keep (but forget an id whose Vault row is gone), '' = delete, else set.
create function private.put_secret(p_id uuid, p_value text, p_name text)
returns uuid
language plpgsql volatile set search_path = ''
as $$
begin
  if p_value is null then
    if p_id is not null and not exists (select 1 from vault.secrets v where v.id = p_id) then
      return null;
    end if;
    return p_id;
  end if;

  if p_value = '' then
    delete from vault.secrets v where v.id = p_id;
    return null;
  end if;

  if p_id is not null and exists (select 1 from vault.secrets v where v.id = p_id) then
    perform vault.update_secret(p_id, p_value);
    return p_id;
  end if;

  -- Missing or never created. Clear an orphan holding the (unique) name first.
  delete from vault.secrets v where v.name = p_name;
  return vault.create_secret(p_value, p_name);
end;
$$;
revoke all on function private.put_secret(uuid, text, text) from public, anon, authenticated;

create or replace function public.upsert_project_secrets(
  p_project_id       uuid,
  p_service_role_key text,
  p_database_url     text
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_agency uuid;
  v_row    private.project_secrets;
  v_old_db text;
begin
  select p.agency_id into v_agency from public.projects p where p.id = p_project_id;
  if v_agency is null or not public.is_agency_owner(v_agency) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_database_url is not null and p_database_url <> ''
     and not private.is_valid_database_url(p_database_url) then
    raise exception 'database URL must be postgresql://…@<host>.supabase.com or .supabase.co, with the password URL-encoded and no query parameters except sslmode'
      using errcode = '22023';
  end if;

  insert into private.project_secrets (project_id) values (p_project_id)
  on conflict (project_id) do nothing;
  select * into v_row from private.project_secrets s
  where s.project_id = p_project_id for update;

  -- Replacing the database URL means pointing the project at (possibly) another
  -- database; the stored service key has to be entered again alongside it.
  if p_database_url is not null and p_database_url <> '' and p_service_role_key is null then
    select d.decrypted_secret into v_old_db
    from vault.decrypted_secrets d where d.id = v_row.database_url_id;
    if v_old_db is not null and v_old_db is distinct from p_database_url then
      v_row.service_role_key_id := private.put_secret(v_row.service_role_key_id, '', null);
    end if;
  end if;

  v_row.service_role_key_id := private.put_secret(
    v_row.service_role_key_id, p_service_role_key, 'rls-watch:' || p_project_id || ':service_role_key');
  v_row.database_url_id := private.put_secret(
    v_row.database_url_id, p_database_url, 'rls-watch:' || p_project_id || ':database_url');

  update private.project_secrets s
  set service_role_key_id = v_row.service_role_key_id,
      database_url_id     = v_row.database_url_id
  where s.project_id = p_project_id;
end;
$$;

-- has_* reflect whether the Vault row actually exists, not just whether an id is stored.
create or replace function private.secret_flags(project_id uuid)
returns table (has_service_key boolean, has_database_url boolean)
language sql stable security definer set search_path = ''
as $$
  select
    coalesce(bool_or(exists (select 1 from vault.secrets v where v.id = s.service_role_key_id)), false),
    coalesce(bool_or(exists (select 1 from vault.secrets v where v.id = s.database_url_id)), false)
  from private.project_secrets s
  join public.projects p on p.id = s.project_id
  where s.project_id = secret_flags.project_id
    and public.is_agency_member(p.agency_id);
$$;

-- ---------------------------------------------------------------------------
-- 3. agency_id on runs / findings / alerts
-- ---------------------------------------------------------------------------

alter table public.runs     add column agency_id uuid references public.agencies on delete cascade;
alter table public.findings add column agency_id uuid references public.agencies on delete cascade;
alter table public.alerts   add column agency_id uuid references public.agencies on delete cascade;

update public.runs r     set agency_id = p.agency_id from public.projects p where p.id = r.project_id;
update public.findings f set agency_id = p.agency_id from public.projects p where p.id = f.project_id;
update public.alerts a   set agency_id = p.agency_id from public.projects p where p.id = a.project_id;

alter table public.runs     alter column agency_id set not null;
alter table public.findings alter column agency_id set not null;
alter table public.alerts   alter column agency_id set not null;

create index runs_agency_id_idx     on public.runs (agency_id);
create index findings_agency_id_idx on public.findings (agency_id);
create index alerts_agency_id_idx   on public.alerts (agency_id);

-- The worker fills agency_id; this makes sure it can never disagree with the project,
-- which would show one agency's findings to another.
create function private.set_agency_from_project()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_agency uuid;
begin
  if new.project_id is not null then
    select p.agency_id into v_agency from public.projects p where p.id = new.project_id;
    if new.agency_id is null then
      new.agency_id := v_agency;
    elsif new.agency_id is distinct from v_agency then
      raise exception 'agency_id does not match the project''s agency' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.set_agency_from_project() from public, anon, authenticated;

create trigger runs_agency before insert or update of agency_id, project_id on public.runs
  for each row execute function private.set_agency_from_project();
create trigger findings_agency before insert or update of agency_id, project_id on public.findings
  for each row execute function private.set_agency_from_project();
create trigger alerts_agency before insert or update of agency_id, project_id on public.alerts
  for each row execute function private.set_agency_from_project();

drop policy runs_select on public.runs;
drop policy findings_select on public.findings;
drop policy alerts_select on public.alerts;
create policy runs_select on public.runs for select to authenticated
  using (public.is_agency_member(agency_id));
create policy findings_select on public.findings for select to authenticated
  using (public.is_agency_member(agency_id));
create policy alerts_select on public.alerts for select to authenticated
  using (public.is_agency_member(agency_id));

-- ---------------------------------------------------------------------------
-- 4 / 7 / 8. runs: status, lease, counts only on ok runs, checks + diff
-- ---------------------------------------------------------------------------

update public.runs
set status = 'timeout', finished_at = coalesce(finished_at, now()),
    error = coalesce(error, 'run never finished (recorded before migration 006)')
where status is null;
update public.runs set counts = null where status <> 'ok';

alter table public.runs drop constraint runs_status_check;
alter table public.runs
  alter column status set not null,
  add constraint runs_status_check check (status in ('queued', 'running', 'ok', 'error', 'timeout')),
  alter column counts drop not null,
  alter column counts drop default,
  add constraint runs_counts_only_when_ok check (case when status = 'ok' then counts is not null else counts is null end),
  add column lease_expires_at timestamptz,
  add column checks jsonb,
  add column diff jsonb;

create unique index runs_one_active_per_project on public.runs (project_id)
  where status in ('queued', 'running');

-- Worker only. Returns the new run id, or null if another run of this project holds a
-- live lease. Leases that ran out (worker crashed or hung) end as 'timeout' first.
create function public.claim_project_run(p_project_id uuid, p_lease_seconds integer)
returns uuid
language plpgsql volatile set search_path = ''
as $$
declare
  v_agency uuid;
  v_run    uuid;
begin
  update public.runs r
  set status = 'timeout', finished_at = now(), lease_expires_at = null,
      error = 'lease expired before the run finished'
  where r.project_id = p_project_id
    and r.status in ('queued', 'running')
    and r.lease_expires_at < now();

  select p.agency_id into v_agency from public.projects p where p.id = p_project_id;
  if v_agency is null then
    raise exception 'unknown project %', p_project_id;
  end if;

  begin
    insert into public.runs (project_id, agency_id, status, started_at, lease_expires_at)
    values (p_project_id, v_agency, 'running', now(), now() + make_interval(secs => p_lease_seconds))
    returning id into v_run;
  exception when unique_violation then
    return null;
  end;
  return v_run;
end;
$$;

-- Worker only. Writes findings and the final status in one transaction, and only if
-- the run is still active: a run that already ended as 'timeout' is never overwritten.
create function public.complete_run(
  p_run_id    uuid,
  p_status    text,
  p_error     text,
  p_counts    jsonb,
  p_report_md text,
  p_checks    jsonb,
  p_diff      jsonb,
  p_findings  jsonb
)
returns boolean
language plpgsql volatile set search_path = ''
as $$
declare
  v_run public.runs;
begin
  if p_status not in ('ok', 'error', 'timeout') then
    raise exception 'complete_run: bad status %', p_status;
  end if;

  select * into v_run from public.runs r where r.id = p_run_id for update;
  if v_run.id is null or v_run.status not in ('queued', 'running') then
    return false;
  end if;

  if p_status = 'ok' then
    insert into public.findings (run_id, project_id, agency_id, severity, kind, target, message, fix, fingerprint)
    select p_run_id, v_run.project_id, v_run.agency_id,
           f ->> 'severity', f ->> 'kind', f ->> 'target', f ->> 'message', f ->> 'fix', f ->> 'fingerprint'
    from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f;
  end if;

  update public.runs r
  set status = p_status,
      finished_at = now(),
      lease_expires_at = null,
      error = case when p_status = 'ok' then null else p_error end,
      counts = case when p_status = 'ok' then p_counts else null end,
      report_md = case when p_status = 'ok' then p_report_md else null end,
      checks = p_checks,
      diff = case when p_status = 'ok' then p_diff else null end
  where r.id = p_run_id;
  return true;
end;
$$;

revoke all on function public.claim_project_run(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_run(uuid, text, text, jsonb, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.claim_project_run(uuid, integer) to service_role;
grant execute on function public.complete_run(uuid, text, text, jsonb, text, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4 / 5. run_requests: leases + rate limits
-- ---------------------------------------------------------------------------

alter table public.run_requests
  add column expires_at timestamptz,
  add column attempts integer not null default 0;

-- Requests picked before 006 and never finished: make them claimable again.
update public.run_requests set expires_at = picked_at
where picked_at is not null and done_at is null;

drop index public.run_requests_pending_idx;
create index run_requests_open_idx on public.run_requests (created_at) where done_at is null;
create index run_requests_project_created_idx on public.run_requests (project_id, created_at);
create index run_requests_agency_created_idx on public.run_requests (agency_id, created_at);

-- Worker only. Claims the oldest open request (new, or whose lease expired).
create function public.claim_run_request(p_lease_seconds integer)
returns setof public.run_requests
language plpgsql volatile set search_path = ''
as $$
begin
  update public.run_requests r
  set done_at = now(), error = 'gave up after 3 attempts'
  where r.done_at is null and r.attempts >= 3
    and (r.expires_at is null or r.expires_at < now());

  return query
  update public.run_requests r
  set picked_at = now(),
      expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = r.attempts + 1
  where r.id = (
    select q.id from public.run_requests q
    where q.done_at is null and (q.picked_at is null or q.expires_at < now())
    order by q.created_at
    limit 1
    for update skip locked
  )
  returning r.*;
end;
$$;
revoke all on function public.claim_run_request(integer) from public, anon, authenticated;
grant execute on function public.claim_run_request(integer) to service_role;

create function private.run_requests_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  -- The windows below count by created_at, so it can't be supplied by the client.
  new.created_at := now();

  if (select auth.uid()) is null then
    return new;
  end if;

  -- Serialise inserts per agency so concurrent requests can't both pass the count.
  perform pg_advisory_xact_lock(hashtextextended('rls-watch:run_requests:' || new.agency_id::text, 0));

  if new.kind = 'run' then
    select count(*) into v_count from public.run_requests r
    where r.project_id = new.project_id and r.kind = 'run' and r.created_at > now() - interval '1 hour';
    if v_count >= 3 then
      raise exception 'Rate limit: at most 3 runs per project per hour.' using errcode = 'PT429';
    end if;

    select count(*) into v_count from public.run_requests r
    where r.agency_id = new.agency_id and r.kind = 'run' and r.created_at > now() - interval '1 day';
    if v_count >= 20 then
      raise exception 'Rate limit: at most 20 runs per agency per day.' using errcode = 'PT429';
    end if;
  elsif new.kind = 'telegram_test' then
    select count(*) into v_count from public.run_requests r
    where r.agency_id = new.agency_id and r.kind = 'telegram_test' and r.created_at > now() - interval '1 day';
    if v_count >= 3 then
      raise exception 'Rate limit: at most 3 Telegram test messages per agency per day.' using errcode = 'PT429';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function private.run_requests_guard() from public, anon, authenticated;

create trigger run_requests_guard
before insert on public.run_requests
for each row execute function private.run_requests_guard();

drop policy run_requests_insert on public.run_requests;
create policy run_requests_insert on public.run_requests for insert to authenticated
  with check (
    public.is_agency_member(agency_id)
    and requested_by = (select auth.uid())
    and picked_at is null and expires_at is null and done_at is null and error is null and attempts = 0
    and (project_id is null or private.project_in_agency(project_id, agency_id))
  );

-- Nothing in a policy needs it any more.
revoke execute on function public.project_agency(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 9 / 10. alerts
-- ---------------------------------------------------------------------------

alter table public.alerts
  add column status text not null default 'sent' check (status in ('sent', 'failed', 'skipped')),
  add column error text,
  add constraint alerts_channel_check check (channel in ('telegram', 'none'));

-- ---------------------------------------------------------------------------
-- 11. Two-account test artifacts
-- ---------------------------------------------------------------------------

create table public.two_account_artifacts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects on delete cascade,
  agency_id    uuid not null references public.agencies on delete cascade,
  run_id       uuid references public.runs on delete set null,
  supabase_url text not null,
  kind         text not null check (kind in ('user', 'row')),
  table_name   text,
  id_column    text,
  ref          text not null,
  created_at   timestamptz not null default now(),
  cleaned_at   timestamptz,
  last_error   text,
  check (kind = 'user' or (table_name is not null and id_column is not null))
);
create index two_account_artifacts_pending_idx on public.two_account_artifacts (project_id)
  where cleaned_at is null;
create index two_account_artifacts_agency_idx on public.two_account_artifacts (agency_id);

alter table public.two_account_artifacts enable row level security;
revoke all on public.two_account_artifacts from anon;
revoke insert, update, delete, truncate on public.two_account_artifacts from authenticated;
grant select on public.two_account_artifacts to authenticated;
grant all on public.two_account_artifacts to service_role;

create policy two_account_artifacts_select on public.two_account_artifacts for select to authenticated
  using (public.is_agency_member(agency_id));

create trigger two_account_artifacts_agency before insert or update of agency_id, project_id
  on public.two_account_artifacts
  for each row execute function private.set_agency_from_project();

-- ---------------------------------------------------------------------------
-- View
-- ---------------------------------------------------------------------------

drop view public.projects_public;
create view public.projects_public
with (security_invoker = true)
as
select p.id, p.agency_id, p.name, p.supabase_url, p.anon_key,
       p.tables, p.buckets, p.rpc, p.rpc_probe_confirmed,
       p.two_account, p.two_account_enabled, p.enabled, p.created_at,
       f.has_service_key, f.has_database_url
from public.projects p
cross join lateral private.secret_flags(p.id) f;

revoke all on public.projects_public from anon, authenticated;
grant select on public.projects_public to authenticated;

-- ---------------------------------------------------------------------------
-- Existing rows that the new write-time checks would reject (reported, not changed)
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.id, p.name,
           private.is_valid_supabase_url(p.supabase_url) url_ok,
           private.is_valid_anon_key(p.anon_key) key_ok,
           private.is_valid_two_account(p.two_account) two_account_ok,
           (d.decrypted_secret is null or private.is_valid_database_url(d.decrypted_secret)) db_ok
    from public.projects p
    left join private.project_secrets s on s.project_id = p.id
    left join vault.decrypted_secrets d on d.id = s.database_url_id
  loop
    if not (r.url_ok and r.key_ok and r.two_account_ok and r.db_ok) then
      raise warning 'project % (%) fails 006 validation: url=% anon_key=% two_account=% database_url=%',
        r.name, r.id, r.url_ok, r.key_ok, r.two_account_ok, r.db_ok;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
