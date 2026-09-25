#!/usr/bin/env node
// RLS Watch worker. Two loops:
//   - full sweep: every CHECK_INTERVAL_MINUTES (or once, with --once), check every
//     enabled project, up to 3 at a time, 60s timeout each.
//   - run_requests: every 60s, handle "Run now" / "send test message" from the web app.
//
// Required env: WATCH_SUPABASE_URL, WATCH_SERVICE_ROLE_KEY, WEB_URL.
// Optional: TELEGRAM_BOT_TOKEN (no alerts sent without it), CHECK_INTERVAL_MINUTES (default 1440).

import { pathToFileURL } from "node:url";
import { createAdminClient, loadEnabledProjects } from "./db.mjs";
import { checkProject } from "./checkProject.mjs";
import { processRunRequests } from "./runRequests.mjs";
import { mapLimit, withTimeout } from "./pool.mjs";

const PROJECT_CONCURRENCY = 3;
const PROJECT_TIMEOUT_MS = 60_000;
const RUN_REQUESTS_POLL_MS = 60_000;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export async function sweep(admin, { telegramBotToken, webUrl, fetchImpl = globalThis.fetch } = {}) {
  const projects = await loadEnabledProjects(admin);
  console.log(`[rls-watch] sweep: ${projects.length} enabled project(s)`);

  const results = await mapLimit(projects, PROJECT_CONCURRENCY, async (project) => {
    try {
      const result = await withTimeout(
        checkProject({ admin, project, telegramBotToken, webUrl, fetchImpl }),
        PROJECT_TIMEOUT_MS,
        `project ${project.name} (${project.id})`
      );
      console.log(`[rls-watch] ${project.name}: ${result.status}${result.alerted ? " (alerted)" : ""}`);
      return { project: project.id, ...result };
    } catch (err) {
      // withTimeout rejected: checkProject's own run row is left open (started, not
      // finished). Log it; the next sweep for this project starts a fresh run either way.
      console.error(`[rls-watch] ${project.name}: timed out / failed outside checkProject: ${err.message}`);
      return { project: project.id, status: "error", error: err.message };
    }
  });

  return results;
}

async function main() {
  const watchUrl = requireEnv("WATCH_SUPABASE_URL");
  const watchServiceRoleKey = requireEnv("WATCH_SERVICE_ROLE_KEY");
  const webUrl = requireEnv("WEB_URL");
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? 1440);

  const admin = createAdminClient(watchUrl, watchServiceRoleKey);
  const once = process.argv.includes("--once");

  if (once) {
    await sweep(admin, { telegramBotToken, webUrl });
    return;
  }

  console.log(`[rls-watch] worker started; sweeping every ${intervalMinutes}m, run_requests every 60s`);

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
