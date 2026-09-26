# RLS Watch

Scheduled security checks for many Supabase projects, with Telegram alerts when something
opens up. It runs the checks from
[`supabase-security-mcp`](https://www.npmjs.com/package/supabase-security-mcp) against every
project you register and diffs each run against the last one.

It's meant to be self-hosted by the agency that looks after the projects: one Supabase
project of its own, a worker in Docker on your infrastructure, and a static dashboard.
There is also a hosted instance at `watch.sixthgear.dev`; it's invite-only (sign-ups are
disabled in its Supabase Auth settings).

## Why

Supabase's Advisor tells you RLS is *enabled* on a table, not that the policies on it do
what you think. A policy with `using (true)`, a `SECURITY DEFINER` function anyone can call,
a public bucket — the table still shows as protected. An agency with ten or twenty client
apps checks this once, at launch; after that, a migration or a rushed fix can quietly reopen
something and nobody notices. RLS Watch keeps asking.

## How it checks

The checks come from `supabase-security-mcp` (pinned to an exact version). What each one
needs, and what it can find:

| Check | Credential | Finding kinds |
| --- | --- | --- |
| Anon probe — read one row from each table, list each bucket, call each RPC with `{}` | anon / publishable key | `anon_open_table`, `anon_open_bucket`, `anon_open_rpc` |
| Policy audit — reads `pg_class`, `pg_policies`, `pg_proc` and table grants | database URL | `rls_disabled`, `rls_disabled_unexposed`, `rls_no_policies`, `policy_no_to_clause`, `policy_open_read`, `policy_open_insert`, `policy_open_write`, `definer_function_exposed` |
| Two-account test — user B tries to read/update/delete user A's row | service role key (+ anon key) | `cross_tenant_read`, `cross_tenant_update`, `cross_tenant_delete` |
| Test-data cleanup — confirms the two-account test left nothing behind | service role key | `test_artifacts_left` |

With a database URL and no table list, the probe uses every table the audit found in
`public`. Each run records what it actually evaluated; a check that didn't run (no
credential, request failed, test disabled) leaves its earlier findings marked *not
evaluated* rather than *resolved*, and a run that evaluated nothing shows as "nothing
checked", never as clean.

## Trust model

Read this before you give RLS Watch a client's credentials.

**What the worker holds.** Its `.env` has the RLS Watch service role key. With it, anyone can
call `get_project_secrets()` and read every stored client credential — each client's service
role key and database URL — and every agency's data, bypassing RLS. Treat the worker host and
its `.env` as holding all of your clients' keys at once. It doesn't need
`WATCH_DATABASE_URL` (that's only for applying migrations); leave it off the server.

**What Vault does and doesn't do.** Client service keys and database URLs are stored in
Supabase Vault: encrypted at rest, never returned to the browser, readable only through a
`service_role`-only function. That is not a boundary against the RLS Watch project's service
role, its `postgres` role, or anyone with access to its Supabase dashboard / SQL editor — all
of them can read the decrypted values.

**Credentials in plain text.** The anon key is stored as a normal column and visible to every
member of the agency. The database and the form refuse a secret key in that field
(`sb_secret_…`, or a JWT whose role isn't `anon`).

**Key formats.** Supabase's newer keys are `sb_publishable_…` (replaces the anon key) and
`sb_secret_…` (replaces the service role key); both go in the `apikey` header. The legacy JWT
keys (`eyJ…`, role `anon` / `service_role`) still work.

**The database URL is a full login.** The audit only reads catalog views, but the URL you
paste is usually the `postgres` user's, which can read and change everything. You can give it
a dedicated role with just enough to read the catalogs instead. Use the **session pooler**
URL (`…pooler.supabase.com:5432`): direct connections to `db.<ref>.supabase.co:5432` are
IPv6-only, and the worker's Docker network is IPv4. The audit connection uses TLS but doesn't
verify the server certificate.

**The two-account test writes to the client's project.** It creates two real auth users,
signs them in, inserts a row per configured table, and tries to read, update and delete it as
the other user. Triggers, webhooks, auth hooks and emails fire exactly as they would for a
real signup. It's off by default, and only the agency owner can turn it on. Every user and
row it creates is recorded by id before the test continues, cleanup is re-verified after the
test and retried at the start of the next run, and anything still there becomes a critical
`test_artifacts_left` finding listing the exact ids. **Get the client's written permission
before running write tests against their project.**

**RPC probes call functions.** Each listed RPC is invoked with the anon key and empty
arguments on every run. Nothing is called until the owner confirms the list ("these functions
will be invoked daily with the anon key"); a member editing the list resets that.

**Where the worker connects.** Besides its own RLS Watch project and `api.telegram.org`, only
to client URLs of the form `https://<20-letter ref>.supabase.co` and Postgres hosts under
`*.supabase.com` / `*.supabase.co`, checked when saved (database trigger and form) and again
by the worker before connecting; Postgres URL parameters that would redirect the connection
(`?host=`, `?sslkey=`, …) are refused. It never follows redirects, times out each
request after 15 s and each project after 60 s. Changing a project's Supabase URL is
owner-only and deletes its stored secrets; replacing the database URL deletes the stored
service key unless you enter it again.

**Network restrictions.** If a client uses Supabase Network Restrictions, they need to allow
the worker's egress IP. Publish yours to clients; the hosted instance connects from
`2.28.12.7` (IPv4 only).

**Alerts.** Telegram bot messages aren't end-to-end encrypted: Telegram can read them. They
contain project names, table and policy names and finding text, but no credentials. If the
bot token or chat id is missing, the alert is recorded as not delivered and the dashboard says
so.

**What members can see.** Error text shown in the dashboard is stripped of connection
strings, hosts, user names, keys and SQL; the full error is only in the worker's logs.

## Architecture

- **db** (`db/`) — the RLS Watch project's own schema. RLS on every table; a user sees only
  rows of agencies they're a member of (`is_agency_member(agency_id)`, `SECURITY DEFINER`,
  used by every policy). `runs`, `findings`, `alerts` and `two_account_artifacts` carry
  `agency_id` and are written only by the worker. Triggers validate project input, keep
  `agency_id` immutable and consistent, and rate-limit on-demand requests (3 runs per project
  per hour, 20 per agency per day, 3 Telegram tests per agency per day).
- **worker** (`worker/`) — a Node service with no HTTP surface. Every
  `CHECK_INTERVAL_MINUTES` (default 1440) it checks each enabled project, three at a time.
  A run holds a lease on its project (`claim_project_run`), so the same project never runs
  twice at once; a run that outlives its lease ends as `timeout`. Findings and the final
  status are written in one transaction (`complete_run`); alerts are sent only after that,
  so a failed Telegram send can't change a run's outcome. Every minute it also claims
  "Run now" / "send test message" requests from `run_requests`, with an expiring lease.
- **web** (`web/`) — Vite + React, Supabase Auth magic links, talking to the RLS Watch
  project directly with its anon key; RLS is the only gate.

## Self-hosting

### 1. Database

Create a Supabase project for RLS Watch itself (separate from anything you'll monitor).
Confirm **Database → Extensions → supabase_vault** is enabled, then run in the SQL editor,
in order: `001_init.sql`, `003_grants.sql`, `004_fix_ambiguous_params.sql`,
`005_two_account_toggle.sql`, `006_security_round.sql`. `002_test_policies.sql` is an
optional manual checklist. Each file runs once. See `db/README.md` for what each does.

Then, in **Authentication**: set the site URL and redirect allow-list to your dashboard URL
(**URL Configuration**), turn off new sign-ups, and invite your team from **Users**.

### 2. Worker

Copy `.env.example` to `.env` and fill in `WATCH_SUPABASE_URL`, `WATCH_SERVICE_ROLE_KEY`,
`TELEGRAM_BOT_TOKEN` (from @BotFather), `WEB_URL` and optionally `CHECK_INTERVAL_MINUTES`.
Copy `worker/`, `shared/`, `package.json`, `package-lock.json`, `docker-compose.yml` and that
`.env` to your server, then:

```bash
docker compose up -d --build
```

### 3. Web

Put `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (the RLS Watch project, publishable key)
in the repo-root `.env`, then:

```bash
cd web && npm install && npm run build
```

Serve `web/dist` as a static site. With Caddy:

```
watch.example.com {
    root * /opt/rls-watch/web
    file_server
    try_files {path} /index.html
}
```

`try_files` is needed because routing is client-side.

## Limits

- Only supabase.com-hosted projects; self-hosted Supabase doesn't fit the URL rules above.
- The policy audit reads `public` only. The anon probe reads at most one row per table and
  can't tell a table that's empty from one RLS hides.
- The two-account test needs a hand-written sample row per table that satisfies its
  constraints; tables it can't insert into are reported as not evaluated.
- Buckets and RPCs aren't discovered; list them by hand.
- One check interval per deployment, not per project.
- Alerts are Telegram-only.
- Findings are matched across runs by kind + target + policy name, so renaming a policy shows
  up as one finding resolved and another new.
