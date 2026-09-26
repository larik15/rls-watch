#!/usr/bin/env node
// RLS Watch worker. Two loops:
//   - full sweep: every CHECK_INTERVAL_MINUTES (or once, with --once), check every
//     enabled project, up to 3 at a time. Each run holds a lease on its project and
//     ends as 'timeout' after 60s (checkProject), so no project runs twice at once.
//   - run_requests: every 60s, handle "Run now" / "send test message" from the web app.
//
// Required env: WATCH_SUPABASE_URL, WATCH_SERVICE_ROLE_KEY, WEB_URL.
// Optional: TELEGRAM_BOT_TOKEN (no alerts sent without it), CHECK_INTERVAL_MINUTES (default 1440).

import { pathToFileURL } from "node:url";
import { createAdminClient, loadEnabledProjects } from "./db.mjs";
import { checkProject } from "./checkProject.mjs";
import { processRunRequests } from "./runRequests.mjs";
import { mapLimit } from "./pool.mjs";

const PROJECT_CONCURRENCY = 3;
const RUN_REQUESTS_POLL_MS = 60_000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export async function sweep(admin, { telegramBotToken, webUrl, fetchImpl = globalThis.fetch } = {}) {
  const projects = await loadEnabledProjects(admin);
  console.log(`[rls-watch] sweep: ${projects.length} enabled project(s)`);

  return mapLimit(projects, PROJECT_CONCURRENCY, async (project) => {
    try {
      const result = await checkProject({ admin, project, telegramBotToken, webUrl, fetchImpl });
      const alert = result.alert ? ` (alert ${result.alert.status})` : "";
      console.log(`[rls-watch] ${project.name}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}${alert}`);
      return { project: project.id, ...result };
    } catch (err) {
      console.error(`[rls-watch] ${project.name}: check failed outside the run:`, err);
      return { project: project.id, status: "error" };
    }
  });
}

async function main() {
  const watchUrl = requireEnv("WATCH_SUPABASE_URL");
  const watchServiceRoleKey = requireEnv("WATCH_SERVICE_ROLE_KEY");
  const webUrl = requireEnv("WEB_URL");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? 1440);

  const admin = createAdminClient(watchUrl, watchServiceRoleKey);

  if (process.argv.includes("--once")) {
    await sweep(admin, { telegramBotToken, webUrl });
    return;
  }

  console.log(`[rls-watch] worker started; sweeping every ${intervalMinutes}m, run_requests every 60s`);
  if (!telegramBotToken) console.warn("[rls-watch] TELEGRAM_BOT_TOKEN is not set: alerts will be recorded as not delivered");

  const runSweep = () => sweep(admin, { telegramBotToken, webUrl }).catch((e) => console.error("[rls-watch] sweep failed:", e));
  const runRequests = () =>
    processRunRequests({ admin, telegramBotToken, webUrl }).catch((e) => console.error("[rls-watch] run_requests poll failed:", e));

  await runSweep();
  setInterval(runSweep, intervalMinutes * 60_000);
  setInterval(runRequests, RUN_REQUESTS_POLL_MS);
}

// Only run when executed directly (`node worker/index.mjs`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[rls-watch] fatal:", err);
    process.exitCode = 1;
  });
}
