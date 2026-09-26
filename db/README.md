# RLS Watch database

SQL migrations for the RLS Watch Supabase project itself.

## Apply

1. Open the RLS Watch project in the Supabase dashboard.
2. Check that **Database → Extensions → supabase_vault** is enabled. It is on by default for
   new projects. The migration stops with an error if it is missing.
3. Open **SQL Editor → New query**, paste the whole of `001_init.sql` and click **Run**.
   It runs inside a single transaction, so either everything is created or nothing is.
4. Optional but recommended: create two test auth users and walk through
   `002_test_policies.sql`, which lists what each of them should and should not be
   able to see/do. It's comments, not a runnable script — follow it manually with
   each user's JWT (or `set role` in the SQL editor).
5. Paste and run `003_grants.sql`. This project was created with **Automatically
   expose new tables** turned off, so RLS alone isn't enough — `authenticated` and
   `service_role` have no privileges on a table until they're granted explicitly.
   Without this file every query, from the browser or the worker, fails with a
   permission-denied error even though the policies in `001_init.sql` are correct.
   The `alter default privileges` statements at the end make this automatic for any
   table added by a later migration, run the same way (SQL editor, as `postgres`).

6. If you applied `001_init.sql` before the parameter fix landed in it, run
   `004_fix_ambiguous_params.sql`. It drops and recreates the two RPC functions with
   `p_`-prefixed parameters (saving secrets used to fail with
   `column reference "project_id" is ambiguous`). Harmless on a fresh install.
7. Paste and run `005_two_account_toggle.sql`. Adds `projects.two_account_enabled`
   (default `false`) and recreates `projects_public` to expose it. Existing projects
   keep the two-account test off until an owner ticks the checkbox in the web app.

Run each file once. The migrations aren't idempotent: running `001_init.sql` a second time
fails on `create table`.

## What it creates

| Object | Who can do what |
| --- | --- |
| `agencies` | members read; any signed-in user creates their own; owner updates and deletes |
| `members` | members read; owner adds, changes and removes `member` rows (the owner row is created by a trigger and can't be changed through the API) |
| `projects` | members read, create and update; owner deletes |
| `projects_public` (view) | the same as `projects`, plus `has_service_key` and `has_database_url` flags |
| `runs`, `findings`, `alerts` | members read; only the worker (service role) writes |
| `run_requests` | members read and create requests for their own agency; the worker processes them |
| `upsert_project_secrets(p_project_id, p_service_role_key, p_database_url)` | agency owner only. `null` leaves a value unchanged, `''` removes it |
| `get_project_secrets(p_project_id)` | service role (worker) only |

Client secrets are stored in Supabase Vault and referenced from `private.project_secrets`.
The `private` schema isn't exposed through the Data API, and the browser never gets the
secret values back.
