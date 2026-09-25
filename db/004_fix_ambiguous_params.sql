-- RLS Watch — rename RPC parameters to avoid "column reference "project_id" is ambiguous"
--
-- In upsert_project_secrets (plpgsql), `on conflict (project_id)` is parsed as a column
-- reference, and plpgsql sees both the table column and the same-named parameter.
-- Both client-called RPCs get p_-prefixed parameters so the web app and worker use one
-- naming convention. The SQL-language helpers (is_agency_member, is_agency_owner,
-- project_agency, secret_flags) are unaffected: they qualify every reference as
-- fn.param, and SQL functions resolve column names first anyway.
--
-- Postgres refuses to rename an input parameter with `create or replace`, so both
-- functions are dropped and recreated, then their grants re-applied. Neither has
-- dependent objects. Safe to run on a fresh install too (001 already has the fix).

begin;

drop function if exists public.upsert_project_secrets(uuid, text, text);
drop function if exists public.get_project_secrets(uuid);

-- Browser → DB. Owner only. Semantics per argument:
--   null  = leave unchanged,  ''  = remove,  anything else = set.
create function public.upsert_project_secrets(
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
begin
  select p.agency_id into v_agency from public.projects p where p.id = p_project_id;
  if v_agency is null or not public.is_agency_owner(v_agency) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  insert into private.project_secrets (project_id) values (p_project_id)
  on conflict (project_id) do nothing;
  select * into v_row from private.project_secrets s
  where s.project_id = p_project_id for update;

  if p_service_role_key is not null then
    if p_service_role_key = '' then
      delete from vault.secrets where id = v_row.service_role_key_id;
      v_row.service_role_key_id := null;
    elsif v_row.service_role_key_id is null then
      v_row.service_role_key_id := vault.create_secret(
        p_service_role_key, 'rls-watch:' || p_project_id || ':service_role_key');
    else
      perform vault.update_secret(v_row.service_role_key_id, p_service_role_key);
    end if;
  end if;

  if p_database_url is not null then
    if p_database_url = '' then
      delete from vault.secrets where id = v_row.database_url_id;
      v_row.database_url_id := null;
    elsif v_row.database_url_id is null then
      v_row.database_url_id := vault.create_secret(
        p_database_url, 'rls-watch:' || p_project_id || ':database_url');
    else
      perform vault.update_secret(v_row.database_url_id, p_database_url);
    end if;
  end if;

  update private.project_secrets s
  set service_role_key_id = v_row.service_role_key_id,
      database_url_id     = v_row.database_url_id
  where s.project_id = p_project_id;
end;
$$;

revoke all on function public.upsert_project_secrets(uuid, text, text) from public, anon;
grant execute on function public.upsert_project_secrets(uuid, text, text) to authenticated;

-- DB → worker. service_role only.
create function public.get_project_secrets(p_project_id uuid)
returns table (service_role_key text, database_url text)
language sql stable security definer set search_path = ''
as $$
  select
    (select d.decrypted_secret from vault.decrypted_secrets d where d.id = s.service_role_key_id),
    (select d.decrypted_secret from vault.decrypted_secrets d where d.id = s.database_url_id)
  from private.project_secrets s
  where s.project_id = p_project_id;
$$;

revoke all on function public.get_project_secrets(uuid) from public, anon, authenticated;
grant execute on function public.get_project_secrets(uuid) to service_role;

-- Make PostgREST pick up the new signatures right away.
notify pgrst, 'reload schema';

commit;
