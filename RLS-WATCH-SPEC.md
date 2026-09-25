# RLS Watch — build spec (v1)

You are building **RLS Watch**: a hosted monitor that watches the security of many
Supabase projects (typically an agency's client apps) and alerts when something opens up.
It reuses the published npm package `supabase-security-mcp` as a library
(`import { runProbes } from "supabase-security-mcp/src/probe.mjs"` etc. — see its README;
functions: `runProbes`, `auditPolicies`, `twoAccountTest`, `buildReport`).

Work in this repo. Plain ESM JavaScript (no TypeScript build step), Node 20+.
Use `node:test` for tests. Keep it small and readable. Ask before adding dependencies
beyond: `@supabase/supabase-js`, `pg`, `supabase-security-mcp`, `react`, `react-dom`,
`react-router-dom`, `vite`, `@vitejs/plugin-react`, `zod`.

## Repo layout

```
rls-watch/
  db/                # SQL migrations for the RLS Watch database itself
  worker/            # Node service: scheduled checks + alerts (Dockerfile)
  web/               # Vite + React dashboard (Supabase Auth)
  shared/            # tiny shared helpers (diff, severity order)
  docker-compose.yml # worker service (joins the existing caddy/n8n compose on the server)
  README.md
```

## Database (Supabase project "rls-watch")

Write `db/001_init.sql`. Everything with RLS ON and proper policies — this product
must not have the bugs it looks for.

Tables (schema public):

- `agencies` — `id uuid pk default gen_random_uuid()`, `name text`, `owner_id uuid references auth.users not null`, `telegram_chat_id text`, `created_at timestamptz default now()`.
- `members` — `agency_id uuid references agencies on delete cascade`, `user_id uuid references auth.users`, `role text check (role in ('owner','member'))`, primary key (agency_id, user_id).
- `projects` — `id uuid pk`, `agency_id uuid references agencies on delete cascade not null`, `name text not null`, `supabase_url text not null`, `anon_key text not null`, `service_role_key text` (nullable), `database_url text` (nullable), `tables text[] default '{}'`, `buckets text[] default '{}'`, `rpc text[] default '{}'`, `two_account jsonb default '[]'` (array of {name, ownerColumn, idColumn, sampleRow}), `enabled boolean default true`, `created_at timestamptz default now()`.
  - Secrets (`service_role_key`, `database_url`) are stored in Supabase Vault (approved: Vault is available, so no worker-side AES fallback and no `WATCH_SECRET_KEY`). The web app writes them via a SECURITY DEFINER RPC `upsert_project_secrets(project_id, service_role_key, database_url)` that only the agency's owner may call; the client never reads them back (return only `has_service_key boolean`, `has_database_url boolean` via a view `projects_public`). The worker reads them via a `get_project_secrets(project_id)` SECURITY DEFINER function whose `execute` is granted only to `service_role`.
- `runs` — `id uuid pk`, `project_id uuid references projects on delete cascade`, `started_at timestamptz`, `finished_at timestamptz`, `status text check (status in ('ok','error'))`, `error text`, `counts jsonb` (critical/high/medium/info), `report_md text`.
- `findings` — `id uuid pk`, `run_id uuid references runs on delete cascade`, `project_id uuid`, `severity text`, `kind text`, `target text`, `message text`, `fix text`, `fingerprint text` (stable hash of kind+target+policy so we can diff between runs).
- `alerts` — `id uuid pk`, `project_id uuid`, `run_id uuid`, `channel text`, `payload jsonb`, `sent_at timestamptz`.

RLS: a user sees only rows of agencies they are a member of. Helper
`is_agency_member(agency_id uuid) returns boolean` as SECURITY DEFINER, STABLE, checking
`members` — used in every policy. Policies split per command, explicit `TO authenticated`.
Never `using (true)`. Add a `db/002_test_policies.sql` that creates two test users' worth
of data expectations as comments, and a `db/README.md` that explains how to apply the
migration with the Supabase SQL editor.

## Worker (`worker/`)

- `worker/index.mjs`: every `CHECK_INTERVAL_MINUTES` (env, default 1440) or on `--once`,
  load enabled projects with the service role key of the **RLS Watch** project
  (`WATCH_SUPABASE_URL`, `WATCH_SERVICE_ROLE_KEY`), call `get_project_secrets(project_id)`
  to fetch each project's `service_role_key` / `database_url` from Vault, and for each project:
  1. `runProbes` with the project's anon key over tables/buckets/rpc.
  2. `auditPolicies` if `database_url` present.
  3. `twoAccountTest` if `service_role_key` present and `two_account` has entries.
  4. `buildReport` → insert a `runs` row + `findings` rows (with fingerprints).
  5. Diff against the previous run's fingerprints: `new`, `resolved`, `unchanged`.
  6. If there are new findings with severity critical/high, or a previously closed
     probe target is now OPEN → send a Telegram message to the agency's `telegram_chat_id`
     using `TELEGRAM_BOT_TOKEN` (env). Message: project name, counts, list of new findings
     (max 10), link `${WEB_URL}/projects/${id}`. Insert an `alerts` row.
  Errors per project are caught, stored on the run (`status='error'`), and never stop the loop.
- Concurrency: at most 3 projects in parallel. Timeouts: 60s per project.
- `worker/Dockerfile` (node:20-alpine) and a `docker-compose.yml` service `rls-watch-worker`
  with env from `.env` (never commit `.env`; commit `.env.example`).
- Tests: `worker/test/*.test.mjs` for the diff logic, the fingerprint function,
  and the alert message formatter — with fakes, no network.

## Web (`web/`)

Vite + React + react-router. Supabase Auth (email magic link). Pages:

- `/login` — magic link form.
- `/` — agency dashboard: table of projects (name, last run time, status dot, counts
  critical/high, trend arrow vs previous run). Button "Add project".
- `/projects/new` — form: name, Supabase URL, anon key, optional service role key,
  optional database URL, tables/buckets/rpc as comma lists, two-account table config
  (repeatable rows: table, ownerColumn, idColumn, sampleRow JSON). Secrets go through the RPC.
  Button "Run now" that inserts a `run_requests` row (add this small table + policy) the
  worker polls every minute.
- `/projects/:id` — history: list of runs (date, counts), click a run → findings grouped by
  severity with fix text; a "What changed" panel showing new/resolved vs previous run;
  "Copy client report (Markdown)" button using `report_md`.
- `/settings` — agency name, Telegram chat id (with a "send test message" button that
  inserts a `run_requests` row of kind 'telegram_test' handled by the worker).

Styling: minimal, clean, no UI library (plain CSS modules or a single stylesheet), dark
theme, monospace for findings. Must look like a real product, not a demo.

Build output goes to `web/dist`, served statically by Caddy on the server at
`watch.sixthgear.dev` (add the Caddy snippet to README). Supabase URL/anon key of the
RLS Watch project come from `web/.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

## README

Explain what it is, why (Advisor shows "enabled", not "protected"; agencies run 10–20
client apps and nobody re-checks after week one), how to self-host (SQL migration, worker
docker-compose, web build + Caddy), and a "how it checks" section that credits
`supabase-security-mcp`. Keep the tone plain. No marketing fluff.

## Order of work

1. `db/001_init.sql` + `db/README.md`.
2. `worker/` with tests; `node worker/index.mjs --once` must work against the real
   RLS Watch project when `.env` is filled.
3. `web/` pages, in the order listed.
4. `docker-compose.yml`, Caddy snippet, README.
5. Run all tests; `npm run build` in web; show me the summary of what exists and what
   still needs manual steps (env values, Telegram chat id, DNS).

Stop and ask me if anything in this spec is ambiguous. Prefer boring, obvious code.
