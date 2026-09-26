// Thin wrapper around the RLS Watch Supabase project (the service that stores
// projects/runs/findings/alerts), accessed with the service role key. RLS doesn't
// apply to this client, so every query here is trusted, worker-only code.

import { createClient } from "@supabase/supabase-js";
import { makeSafeFetch } from "./safeFetch.mjs";
import { planBaseline } from "../shared/checks.mjs";

const BASELINE_RUNS = 20;

export function createAdminClient(url, serviceRoleKey) {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: makeSafeFetch() },
  });
}

/** All projects with `enabled = true`. */
export async function loadEnabledProjects(admin) {
  const { data, error } = await admin.from("projects").select("*").eq("enabled", true);
  if (error) throw new Error(`loadEnabledProjects: ${error.message}`);
  return data;
}

export async function loadProject(admin, projectId) {
  const { data, error } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (error) throw new Error(`loadProject(${projectId}): ${error.message}`);
  return data;
}

/** Decrypted secrets for one project, via the service_role-only RPC. Vault-backed. */
export async function getProjectSecrets(admin, projectId) {
  const { data, error } = await admin.rpc("get_project_secrets", { p_project_id: projectId });
  if (error) throw new Error(`getProjectSecrets(${projectId}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { serviceRoleKey: row?.service_role_key ?? null, databaseUrl: row?.database_url ?? null };
}

/** Start a run holding a lease on the project; null if another run of it is still active. */
export async function claimProjectRun(admin, projectId, leaseSeconds) {
  const { data, error } = await admin.rpc("claim_project_run", {
    p_project_id: projectId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`claimProjectRun(${projectId}): ${error.message}`);
  return data ?? null;
}

/**
 * Findings + final status in one transaction. false if the run had already ended
 * (e.g. its lease expired and it was marked 'timeout') — nothing is written then.
 */
export async function completeRun(admin, runId, { status, error, counts, reportMd, checks, diff, findings }) {
  const { data, error: rpcErr } = await admin.rpc("complete_run", {
    p_run_id: runId,
    p_status: status,
    p_error: error ?? null,
    p_counts: counts ?? null,
    p_report_md: reportMd ?? null,
    p_checks: checks ?? null,
    p_diff: diff ?? null,
    p_findings: (findings ?? []).map((f) => ({
      severity: f.severity,
      kind: f.kind,
      target: f.table ?? f.function ?? null,
      message: f.message,
      fix: f.fix ?? null,
      fingerprint: f.fingerprint,
    })),
  });
  if (rpcErr) throw new Error(`completeRun(${runId}): ${rpcErr.message}`);
  return data === true;
}

/** Baseline findings to diff a new run against: per check, from the latest ok run that evaluated it. */
export async function loadBaselineFindings(admin, projectId) {
  const { data: runs, error: runsErr } = await admin
    .from("runs")
    .select("id, checks")
    .eq("project_id", projectId)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(BASELINE_RUNS);
  if (runsErr) throw new Error(`loadBaselineFindings(${projectId}): ${runsErr.message}`);

  const plan = planBaseline(runs);
  if (!plan.runIds.length) return [];

  const { data: findings, error: findErr } = await admin
    .from("findings")
    .select("run_id, fingerprint, kind, target, severity, message")
    .in("run_id", plan.runIds);
  if (findErr) throw new Error(`loadBaselineFindings(${projectId}): ${findErr.message}`);
  return findings.filter(plan.includes);
}

export async function insertAlert(admin, { projectId, agencyId, runId, channel, status, error, payload }) {
  const { error: insErr } = await admin.from("alerts").insert({
    project_id: projectId ?? null,
    agency_id: agencyId,
    run_id: runId ?? null,
    channel,
    status,
    error: error ?? null,
    payload: payload ?? {},
  });
  if (insErr) throw new Error(`insertAlert(${projectId ?? agencyId}): ${insErr.message}`);
}

/** Agency row, for its telegram_chat_id. */
export async function loadAgency(admin, agencyId) {
  const { data, error } = await admin.from("agencies").select("*").eq("id", agencyId).single();
  if (error) throw new Error(`loadAgency(${agencyId}): ${error.message}`);
  return data;
}

/** Claim the oldest open run request (new, or whose lease expired). null when there is none. */
export async function claimRunRequest(admin, leaseSeconds) {
  const { data, error } = await admin.rpc("claim_run_request", { p_lease_seconds: leaseSeconds });
  if (error) throw new Error(`claimRunRequest: ${error.message}`);
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

export async function markRunRequestDone(admin, id, error) {
  const { error: updErr } = await admin
    .from("run_requests")
    .update({ done_at: new Date().toISOString(), error: error ?? null })
    .eq("id", id);
  if (updErr) throw new Error(`markRunRequestDone(${id}): ${updErr.message}`);
}

export async function insertArtifact(admin, artifact) {
  const { error } = await admin.from("two_account_artifacts").insert(artifact);
  if (error) throw new Error(`insertArtifact: ${error.message}`);
}

export async function loadPendingArtifacts(admin, projectId) {
  const { data, error } = await admin
    .from("two_account_artifacts")
    .select("*")
    .eq("project_id", projectId)
    .is("cleaned_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`loadPendingArtifacts(${projectId}): ${error.message}`);
  return data;
}

export async function markArtifactCleaned(admin, id) {
  const { error } = await admin
    .from("two_account_artifacts")
    .update({ cleaned_at: new Date().toISOString(), last_error: null })
    .eq("id", id);
  if (error) throw new Error(`markArtifactCleaned(${id}): ${error.message}`);
}

export async function markArtifactError(admin, id, reason) {
  const { error } = await admin.from("two_account_artifacts").update({ last_error: reason }).eq("id", id);
  if (error) throw new Error(`markArtifactError(${id}): ${error.message}`);
}
