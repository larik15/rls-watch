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
| `upsert_project_secrets(project_id, service_role_key, database_url)` | agency owner only. `null` leaves a value unchanged, `''` removes it |
| `get_project_secrets(project_id)` | service role (worker) only |

Client secrets are stored in Supabase Vault and referenced from `private.project_secrets`.
The `private` schema isn't exposed through the Data API, and the browser never gets the
secret values back.
