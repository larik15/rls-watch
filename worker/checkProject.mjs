// One project, one run: probe → audit policies → two-account test → report → diff → alert.
// Every step after the run row is created is wrapped so a failure lands on that run
// (status='error') instead of throwing out of the whole sweep.

import { runProbes } from "supabase-security-mcp/src/probe.mjs";
import { auditPolicies } from "supabase-security-mcp/src/policies.mjs";
import { twoAccountTest } from "supabase-security-mcp/src/twoAccount.mjs";
import { buildReport } from "supabase-security-mcp/src/report.mjs";

import { withFingerprints } from "../shared/fingerprint.mjs";
import { diffFindings, shouldAlert } from "../shared/diff.mjs";
import { formatAlertMessage, sendTelegramMessage } from "./telegram.mjs";
import { discoverTableNames } from "./discoverTables.mjs";
import { verifyTwoAccountCleanup, cleanupFinding } from "./verifyCleanup.mjs";
import * as db from "./db.mjs";

/**
 * @param {Object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.admin  RLS Watch admin client
 * @param {Object} opts.project    a row from `projects`
 * @param {string} [opts.telegramBotToken]
 * @param {string} opts.webUrl
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function checkProject({ admin, project, telegramBotToken, webUrl, fetchImpl = globalThis.fetch }) {
  const startedAt = new Date().toISOString();
  const runId = await db.insertRun(admin, { projectId: project.id, startedAt });

  try {
    const secrets = await db.getProjectSecrets(admin, project.id);

    const policies = secrets.databaseUrl ? await auditPolicies(secrets.databaseUrl) : null;
    const tablesToProbe = project.tables?.length ? project.tables : discoverTableNames(policies);

    const probe = await runProbes(
      { url: project.supabase_url, key: project.anon_key, tables: tablesToProbe, buckets: project.buckets, rpc: project.rpc },
      fetchImpl
    );

    const twoAccount =
      project.two_account_enabled && secrets.serviceRoleKey && project.two_account?.length
        ? await twoAccountTest(
            { url: project.supabase_url, anonKey: project.anon_key, serviceRoleKey: secrets.serviceRoleKey, tables: project.two_account },
            fetchImpl
          )
        : null;

    if (twoAccount) {
      const cleanup = await verifyTwoAccountCleanup(
        { url: project.supabase_url, serviceRoleKey: secrets.serviceRoleKey, tables: project.two_account },
        fetchImpl
      );
      const finding = cleanupFinding(cleanup);
      if (finding) twoAccount.findings = [...twoAccount.findings, finding];
    }

    const report = buildReport({ project: project.name, probe, policies, twoAccount });
    const findings = withFingerprints(report.findings);

    const previousFingerprints = await db.loadPreviousFingerprints(admin, project.id);
    const diff = diffFindings(previousFingerprints, findings);

    await db.insertFindings(admin, runId, project.id, findings);
    await db.finishRun(admin, runId, { status: "ok", counts: report.counts, reportMd: report.markdown });

    let alerted = false;
    if (shouldAlert(diff)) {
      const agency = await db.loadAgency(admin, project.agency_id);
      if (agency?.telegram_chat_id && telegramBotToken) {
        const text = formatAlertMessage(project, report.counts, diff.new, webUrl, project.id);
        await sendTelegramMessage(telegramBotToken, agency.telegram_chat_id, text, fetchImpl);
        await db.insertAlert(admin, { projectId: project.id, runId, channel: "telegram", payload: { text, newCount: diff.new.length } });
        alerted = true;
      }
    }

    return { runId, status: "ok", counts: report.counts, diff, alerted };
  } catch (err) {
    await db.finishRun(admin, runId, { status: "error", error: err.message, counts: { critical: 0, high: 0, medium: 0, info: 0 } });
    return { runId, status: "error", error: err.message };
  }
}
