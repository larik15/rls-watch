# RLS Watch database

SQL migrations for the RLS Watch Supabase project itself. `001_init.sql` is frozen as
first shipped; every later change lives in its own numbered file.

## Apply

1. Open the RLS Watch project in the Supabase dashboard.
2. Check that **Database → Extensions → supabase_vault** is enabled. It is on by default for
   new projects. The migration stops with an error if it is missing.
3. Open **SQL Editor → New query**, paste the whole of `001_init.sql` and click **Run**.
   It runs inside a single transaction, so either everything is created or nothing is.
4. Optional: create two test auth users and walk through `002_test_policies.sql`, which
   lists what each of them should and should not be able to see/do. It's comments, not a
   runnable script.
5. Paste and run `003_grants.sql`. This project was created with **Automatically
   expose new tables** turned off, so RLS alone isn't enough — `authenticated` and
   `service_role` have no privileges on a table until they're granted explicitly.
   Without this file every query, from the browser or the worker, fails with a
   permission-denied error. The `alter default privileges` statements at the end make
   this automatic for any table added by a later migration.
6. Paste and run `004_fix_ambiguous_params.sql` (required). It recreates the two secrets
   RPCs with `p_`-prefixed parameters; with 001's originals, saving secrets fails with
   `column reference "project_id" is ambiguous`.
7. Paste and run `005_two_account_toggle.sql`. Adds `projects.two_account_enabled`
   (default `false`).
8. Paste and run `006_security_round.sql`. Input validation and owner-only rules on
   projects, `agency_id` on worker-written tables, run leases, rate limits, alert status,
   two-account artifact tracking, RPC probe confirmation, and tighter grants. It ends by
   printing a warning for any existing project that the new write-time checks would reject
   (the row is left as is).

Run each file once. The migrations aren't idempotent.

## What it creates

| Object | Who can do what |
| --- | --- |
| `agencies` | members read; any signed-in user creates their own; owner updates and deletes |
| `members` | members read; owner adds, changes and removes `member` rows (the owner row is created by a trigger and can't be changed through the API) |
| `projects` | members read, create and update; owner deletes. `agency_id` never changes. Owner only: changing `supabase_url` (wipes stored secrets), enabling `two_account_enabled` / `rpc_probe_confirmed`. A member changing `two_account` / `rpc` turns the matching flag off |
| `projects_public` (view) | the same as `projects`, plus `has_service_key` / `has_database_url` (true only if the Vault row exists) |
| `runs`, `findings`, `alerts`, `two_account_artifacts` | members read (by `agency_id`); only the worker (service role) writes |
| `run_requests` | members read and create requests for their own agency, rate-limited; the worker claims and completes them |
| `upsert_project_secrets(p_project_id, p_service_role_key, p_database_url)` | agency owner only. `null` leaves a value unchanged, `''` removes it. Rejects non-Supabase database URLs; replacing the database URL removes the service key unless one is passed too |
| `get_project_secrets(p_project_id)` | service role (worker) only |
| `claim_project_run`, `complete_run`, `claim_run_request` | service role (worker) only |

Client secrets are stored in Supabase Vault and referenced from `private.project_secrets`.
The `private` schema isn't exposed through the Data API, and the browser never gets the
secret values back. Vault encrypts at rest; it doesn't hide the values from the service
role or from anyone with SQL access to this project.
