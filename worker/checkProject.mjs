// One project, one run: lease → retry old test-data cleanup → policy audit → anon probe
// → two-account test → verify cleanup → report → diff → complete_run → alert.
// The run is final before any alert is attempted, so a Telegram failure can't change it.

import { runProbes } from "supabase-security-mcp/src/probe.mjs";
import { auditPolicies } from "supabase-security-mcp/src/policies.mjs";
import { twoAccountTest } from "supabase-security-mcp/src/twoAccount.mjs";
import { buildReport } from "supabase-security-mcp/src/report.mjs";

import { withFingerprints } from "../shared/fingerprint.mjs";
import { diffFindings, shouldAlert } from "../shared/diff.mjs";
import { evaluatedUnits } from "../shared/checks.mjs";
import { isValidSupabaseUrl } from "../shared/validate.mjs";
import { formatAlertMessage, sendTelegramMessage } from "./telegram.mjs";
import { discoverTableNames } from "./discoverTables.mjs";
import { trackingFetch, reconcileArtifacts, artifactsFinding } from "./artifacts.mjs";
import { verifyTwoAccountCleanup } from "./verifyCleanup.mjs";
import { makeSafeFetch } from "./safeFetch.mjs";
import { GuardedPgClient } from "./pgClient.mjs";
import { sanitizeError } from "./sanitize.mjs";
import * as realDb from "./db.mjs";

export const PROJECT_DEADLINE_MS = 60_000;
const LEASE_MARGIN_SECONDS = 30;

const defaultDeps = { db: realDb, runProbes, auditPolicies, twoAccountTest };

/** Did this probe actually learn whether the target is open? */
function probeEvaluated(r) {
  if (r.kind === "rpc") return [200, 400, 401, 403].includes(r.status);
  if (r.kind === "bucket") return [200, 400, 401, 403].includes(r.status);
  return [200, 401, 403].includes(r.status);
}

function summarizeProbe(results) {
  const evaluated = [];
  const notEvaluated = [];
  for (const r of results) {
    if (probeEvaluated(r)) evaluated.push({ kind: r.kind, target: r.target });
    else notEvaluated.push({ kind: r.kind, target: r.target, reason: r.status === 0 ? "request failed" : `HTTP ${r.status}` });
  }
  return { evaluated, not_evaluated: notEvaluated };
}

function summarizeTwoAccount(result) {
  const evaluated = [];
  const notEvaluated = [];
  for (const r of result.results ?? []) {
    if (r.steps?.other_user_select !== undefined) evaluated.push(r.table);
    else notEvaluated.push({ table: r.table, reason: `test row could not be inserted (HTTP ${r.steps?.owner_insert ?? "?"})` });
  }
  return { evaluated, not_evaluated: notEvaluated };
}

function coverageMarkdown(checks) {
  const gaps = [];
  for (const t of checks.probe?.not_evaluated ?? []) gaps.push(`anon probe: ${t.kind} \`${t.target}\` not evaluated (${t.reason})`);
  if (checks.probe?.rpc_skipped) gaps.push(`anon probe: ${checks.probe.rpc_skipped} RPC function(s) listed but not called — the agency owner hasn't confirmed RPC probing`);
  if (checks.probe?.tables_source === "none") gaps.push("anon probe: no tables listed and none discovered");
  if (!checks.policies?.evaluated) gaps.push(`policy audit: not run (${checks.policies?.reason})`);
  if (checks.two_account?.reason) gaps.push(`two-account test: not run (${checks.two_account.reason})`);
  for (const t of checks.two_account?.not_evaluated ?? []) gaps.push(`two-account test: \`${t.table}\` not evaluated (${t.reason})`);
  if (!checks.artifacts?.evaluated) gaps.push(`test-data cleanup: not verified (${checks.artifacts?.reason})`);

  const lines = ["## Coverage"];
  if (!gaps.length) lines.push("Every configured check ran.");
  else for (const g of gaps) lines.push(`- ${g}`);
  return lines.join("\n");
}

const findingSummary = (f) => ({
  fingerprint: f.fingerprint,
  kind: f.kind,
  target: f.target ?? f.table ?? f.function ?? null,
  severity: f.severity,
  message: f.message,
});

async function evaluate({ admin, project, runId, fetch, d }) {
  if (!isValidSupabaseUrl(project.supabase_url)) {
    throw new Error("supabase_url failed validation; not contacting it");
  }
  const secrets = await d.db.getProjectSecrets(admin, project.id);
  const cleanupArgs = { admin, db: d.db, project, serviceRoleKey: secrets.serviceRoleKey, fetchImpl: fetch };
  const checks = {};

  // Test data left by earlier runs gets another cleanup attempt before anything else.
  await reconcileArtifacts(cleanupArgs).catch((err) =>
    console.error(`[rls-watch] ${project.name}: artifact cleanup retry failed:`, err)
  );

  let policies = null;
  if (!secrets.databaseUrl) {
    checks.policies = { evaluated: false, reason: "no database URL stored" };
  } else {
    try {
      policies = await d.auditPolicies(secrets.databaseUrl, { Client: GuardedPgClient });
      checks.policies = { evaluated: true, tables: policies.tables.length };
    } catch (err) {
      console.error(`[rls-watch] ${project.name}: policy audit failed:`, err);
      checks.policies = { evaluated: false, reason: `policy audit failed: ${sanitizeError(err)}` };
    }
  }

  const configuredTables = project.tables ?? [];
  const tables = configuredTables.length ? configuredTables : discoverTableNames(policies);
  const rpc = project.rpc_probe_confirmed ? (project.rpc ?? []) : [];
  const probe = await d.runProbes(
    { url: project.supabase_url, key: project.anon_key, tables, buckets: project.buckets ?? [], rpc },
    fetch
  );
  checks.probe = {
    ...summarizeProbe(probe),
    tables_source: configuredTables.length ? "configured" : tables.length ? "discovered" : "none",
    rpc_skipped: project.rpc_probe_confirmed ? 0 : (project.rpc?.length ?? 0),
  };

  const twoAccountTables = project.two_account ?? [];
  const twoAccountAttempted = Boolean(project.two_account_enabled && secrets.serviceRoleKey && twoAccountTables.length);
  let twoAccount = null;
  if (!project.two_account_enabled) checks.two_account = { evaluated: [], reason: "disabled" };
  else if (!secrets.serviceRoleKey) checks.two_account = { evaluated: [], reason: "no service role key stored" };
  else if (!twoAccountTables.length) checks.two_account = { evaluated: [], reason: "no tables configured" };
  else {
    const record = (a) =>
      d.db.insertArtifact(admin, {
        ...a,
        project_id: project.id,
        agency_id: project.agency_id,
        run_id: runId,
        supabase_url: project.supabase_url,
      });
    try {
      twoAccount = await d.twoAccountTest(
        { url: project.supabase_url, anonKey: project.anon_key, serviceRoleKey: secrets.serviceRoleKey, tables: twoAccountTables },
        trackingFetch(fetch, { baseUrl: project.supabase_url, tables: twoAccountTables, record })
      );
      checks.two_account = summarizeTwoAccount(twoAccount);
    } catch (err) {
      console.error(`[rls-watch] ${project.name}: two-account test failed:`, err);
      checks.two_account = { evaluated: [], reason: `two-account test failed: ${sanitizeError(err)}` };
    }
  }

  let leftoverFinding = null;
  try {
    const left = await reconcileArtifacts(cleanupArgs);
    const scan = twoAccountAttempted
      ? await verifyTwoAccountCleanup(
          { url: project.supabase_url, serviceRoleKey: secrets.serviceRoleKey, tables: twoAccountTables },
          fetch
        )
      : undefined;
    leftoverFinding = artifactsFinding(left, scan);
    checks.artifacts = { evaluated: true, pending: left.length };
  } catch (err) {
    console.error(`[rls-watch] ${project.name}: test-data cleanup check failed:`, err);
    checks.artifacts = { evaluated: false, reason: `cleanup check failed: ${sanitizeError(err)}` };
  }

  // Leftover test data is reported with the two-account results so buildReport counts it.
  const twoAccountPart =
    twoAccount || leftoverFinding
      ? { results: twoAccount?.results ?? [], findings: [...(twoAccount?.findings ?? []), ...(leftoverFinding ? [leftoverFinding] : [])] }
      : null;
  const report = buildReport({ project: project.name, probe, policies, twoAccount: twoAccountPart });
  const findings = withFingerprints(report.findings);

  const baseline = await d.db.loadBaselineFindings(admin, project.id);
  const diff = diffFindings(baseline, findings, evaluatedUnits(checks));

  return {
    counts: report.counts,
    reportMd: `${report.markdown}\n${coverageMarkdown(checks)}\n`,
    checks,
    findings,
    diff,
  };
}

async function alertIfNeeded({ admin, db, project, runId, counts, diff, telegramBotToken, webUrl, fetchImpl }) {
  if (!shouldAlert(diff)) return null;

  const base = { projectId: project.id, agencyId: project.agency_id, runId };
  const newCount = diff.new.length;
  const agency = await db.loadAgency(admin, project.agency_id);
  const missing = !telegramBotToken
    ? "TELEGRAM_BOT_TOKEN is not set on the worker"
    : !agency?.telegram_chat_id
      ? "the agency has no Telegram chat id"
      : null;
  if (missing) {
    await db.insertAlert(admin, { ...base, channel: "none", status: "skipped", error: missing, payload: { newCount } });
    return { status: "skipped", reason: missing };
  }

  const text = formatAlertMessage(project, counts, diff.new, webUrl, project.id);
  try {
    await sendTelegramMessage(telegramBotToken, agency.telegram_chat_id, text, makeSafeFetch({ fetchImpl }));
  } catch (err) {
    console.error(`[rls-watch] ${project.name}: Telegram alert failed:`, err);
    const error = sanitizeError(err);
    await db.insertAlert(admin, { ...base, channel: "telegram", status: "failed", error, payload: { text, newCount } });
    return { status: "failed", error };
  }
  await db.insertAlert(admin, { ...base, channel: "telegram", status: "sent", payload: { text, newCount } });
  return { status: "sent" };
}

/**
 * @param {Object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.admin  RLS Watch admin client
 * @param {Object} opts.project    a row from `projects`
 * @param {string} [opts.telegramBotToken]
 * @param {string} opts.webUrl
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.deadlineMs]
 * @param {Object} [opts.deps]     test seams: { db, runProbes, auditPolicies, twoAccountTest }
 */
export async function checkProject({
  admin,
  project,
  telegramBotToken,
  webUrl,
  fetchImpl = globalThis.fetch,
  deadlineMs = PROJECT_DEADLINE_MS,
  deps = {},
}) {
  const d = { ...defaultDeps, ...deps };
  const runId = await d.db.claimProjectRun(admin, project.id, Math.ceil(deadlineMs / 1000) + LEASE_MARGIN_SECONDS);
  if (!runId) return { status: "skipped", reason: "another run of this project is still in progress" };

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`run did not finish within ${Math.round(deadlineMs / 1000)}s`);
      err.timeout = true;
      controller.abort(err);
      reject(err);
    }, deadlineMs);
  });
  const fetch = makeSafeFetch({ fetchImpl, signal: controller.signal });

  let result;
  try {
    result = await Promise.race([evaluate({ admin, project, runId, fetch, d }), deadline]);
  } catch (err) {
    const status = err.timeout ? "timeout" : "error";
    const error = sanitizeError(err);
    console.error(`[rls-watch] ${project.name} (${project.id}) run ${runId} ${status}:`, err);
    await d.db.completeRun(admin, runId, { status, error });
    return { runId, status, error };
  } finally {
    clearTimeout(timer);
  }

  const completed = await d.db.completeRun(admin, runId, {
    status: "ok",
    counts: result.counts,
    reportMd: result.reportMd,
    checks: result.checks,
    findings: result.findings,
    diff: {
      new: result.diff.new.map((f) => f.fingerprint),
      resolved: result.diff.resolved.map(findingSummary),
      not_evaluated: result.diff.notEvaluated.map(findingSummary),
    },
  });
  if (!completed) return { runId, status: "timeout", error: "the run's lease expired before it finished" };

  let alert = null;
  try {
    alert = await alertIfNeeded({
      admin,
      db: d.db,
      project,
      runId,
      counts: result.counts,
      diff: result.diff,
      telegramBotToken,
      webUrl,
      fetchImpl,
    });
  } catch (err) {
    console.error(`[rls-watch] ${project.name}: recording the alert failed:`, err);
  }

  return { runId, status: "ok", counts: result.counts, checks: result.checks, diff: result.diff, alert };
}
