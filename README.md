# RLS Watch

A hosted monitor for the security of many Supabase projects. It runs the same checks as
[`supabase-security-mcp`](https://www.npmjs.com/package/supabase-security-mcp) on a schedule,
against every project you register, and alerts on Telegram when something opens up.

## Why

Supabase's Advisor tells you whether RLS is *enabled* on a table, not whether the policies
on it actually do what you think. A policy with `using (true)`, a bucket left public, a
service-role key checked into a client bundle — none of that shows up as a red flag in the
dashboard. If you run an agency with ten or twenty client projects, nobody goes back and
re-checks them after week one, and a Supabase upgrade or a rushed migration can quietly
reopen something that used to be fixed. RLS Watch exists to keep asking the question
instead of asking it once.

## Architecture

Three pieces, one Supabase project of its own (called "RLS Watch" below, distinct from the
client projects it monitors):

- **db** — the RLS Watch project's own schema (`agencies`, `members`, `projects`, `runs`,
  `findings`, `alerts`, `run_requests`). Everything has RLS on. A user only ever sees rows
  belonging to agencies they're a member of, enforced by a `is_agency_member(agency_id)`
  helper function (`SECURITY DEFINER`, `STABLE`) that every policy calls instead of
  re-deriving membership inline. There's no `using (true)` anywhere — this product can't
  have the bugs it looks for.

  Each monitored project's `service_role_key` and `database_url` are secrets, not plain
  columns: they're stored in **Supabase Vault** and referenced from a `private` schema
  that the Data API never exposes. The web app writes them through a `SECURITY DEFINER`
  RPC (`upsert_project_secrets`, agency owner only) and never reads them back — the
  `projects_public` view only exposes `has_service_key` / `has_database_url` booleans. The
  worker reads them through a separate RPC (`get_project_secrets`) whose `execute`
  privilege is granted only to `service_role`, not `authenticated`.

- **worker** — a Node service with no HTTP surface. On a timer (`CHECK_INTERVAL_MINUTES`,
  default daily) it loads every enabled project, pulls each one's secrets from Vault, and
  for each project: runs `runProbes` (anon-key checks against the tables/buckets/RPCs you
  listed), `auditPolicies` if a `database_url` was given, and `twoAccountTest` if a
  `service_role_key` and `two_account` config were given. Results become a `runs` row and
  a set of `findings`, each with a stable fingerprint so the worker can diff against the
  previous run and tell new findings from unchanged ones. New critical/high findings, or a
  previously-fixed check that's now open again, trigger a Telegram message to the agency.
  A project failing (bad key, network error, whatever) is recorded as `status='error'` and
  does not stop the sweep for the rest. The web app can also ask for an immediate run: it
  inserts a `run_requests` row, which the worker polls for every minute.

- **web** — a Vite + React dashboard (Supabase Auth, email magic link). Project list with
  status and trend, per-project run history with findings grouped by severity and a
  markdown report you can copy to send a client, and a settings page for the agency's name
  and Telegram chat id. Talks to the RLS Watch Supabase project directly with the anon key;
  everything is gated by the RLS policies above, there's no separate API layer.

## Self-hosting

### 1. Database

Create a Supabase project for RLS Watch itself (separate from anything you'll monitor).
Confirm **Database → Extensions → supabase_vault** is enabled (on by default for new
projects), then in the SQL editor run, in order:

1. `db/001_init.sql` — tables, RLS policies, `is_agency_member`, the Vault-backed secrets
   RPCs. Runs in one transaction.
2. (optional) walk through `db/002_test_policies.sql` with two test users to confirm the
   policies do what they say — it's a checklist in comments, not a script.
3. `db/003_grants.sql` — required. This project has "automatically expose new tables"
   off, so RLS alone doesn't grant access; without this, every query fails with
   permission-denied even though the policies are correct.
4. `db/004_fix_ambiguous_params.sql` — only needed if you applied `001_init.sql` before
   this fix landed in it (renames the secrets RPCs' parameters to `p_`-prefixed to avoid
   an ambiguous-column error). Harmless to run on a fresh install.

Each file runs once; they aren't idempotent. Details on what each grant/RPC does are in
`db/README.md`.

### 2. Worker

Copy `.env.example` to `.env` and fill it in:

- `WATCH_SUPABASE_URL` / `WATCH_SERVICE_ROLE_KEY` / `WATCH_DATABASE_URL` — the RLS Watch
  project itself, service role (used to read every agency's projects and secrets, not a
  monitored project's credentials).
- `TELEGRAM_BOT_TOKEN` — a bot created via @BotFather. Each agency sets its own chat id
  from the web app's Settings page.
- `WEB_URL` — the public dashboard URL, used to build links in alert messages.
- `CHECK_INTERVAL_MINUTES` — sweep interval, default 1440 (once a day).
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — same RLS Watch project, read by `web/`
  at build time.

Then, from the repo root:

```bash
docker compose up -d --build
```

This builds `worker/Dockerfile` and starts the `rls-watch-worker` service with `.env` as
its `env_file`. It's written to join an existing Caddy/n8n compose stack on the same
server rather than stand alone — if you're deploying next to one, copy this repo's
`worker/`, `shared/`, `package.json`, `package-lock.json`, `.env` and `docker-compose.yml`
to the server and bring it up there.

### 3. Web

```bash
cd web
npm install
npm run build
```

Output goes to `web/dist` — a static site, no server-side code. Serve it with Caddy
(adjust the domain and path):

```
watch.example.com {
    root * /opt/rls-watch/web
    file_server
    try_files {path} /index.html
}
```

`try_files {path} /index.html` is needed because this is a client-side-routed SPA
(`react-router-dom`) — without it, refreshing on `/projects/:id` 404s.

### 4. Supabase Auth URLs

In the RLS Watch Supabase project, under **Authentication → URL Configuration**, set the
site URL to your dashboard's public URL (the same value as `WEB_URL`), and add it to the
redirect allow-list. Magic links won't come back to the right place otherwise.

## Limits

- No support for Supabase self-hosted projects — only supabase.com-hosted ones, since the
  probes assume the standard REST/Vault/connection-string surface.
- The two-account impersonation test needs you to hand-configure a sample row and two
  existing user ids per table; it's not derived automatically.
- `auditPolicies` needs a direct Postgres connection string. If a monitored project only
  gives you an anon/service key with no `database_url`, you get the anon-key probes and
  (if a service key is present) the two-account test, but not the policy audit.
- One check interval per RLS Watch deployment, not per project — you can't run one project
  hourly and another weekly without running two separate deployments.
- Alerts are Telegram-only; there's no email or webhook channel.
- Findings are diffed by fingerprint (kind + target + policy), not by human review, so a
  cosmetic policy rewrite that doesn't change behavior can still show up as "new" and
  "resolved" in the same run.
