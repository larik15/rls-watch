// Thin wrapper around the RLS Watch Supabase project (the service that stores
// projects/runs/findings/alerts), accessed with the service role key. RLS doesn't
// apply to this client, so every query here is trusted, worker-only code.

import { createClient } from "@supabase/supabase-js";

export function createAdminClient(url, serviceRoleKey) {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** All projects with `enabled = true`. */
export async function loadEnabledProjects(admin) {
  const { data, error } = await admin.from("projects").select("*").eq("enabled", true);
  if (error) throw new Error(`loadEnabledProjects: ${error.message}`);
  return data;
}

/** Decrypted secrets for one project, via the service_role-only RPC. Vault-backed. */
export async function getProjectSecrets(admin, projectId) {
  const { data, error } = await admin.rpc("get_project_secrets", { p_project_id: projectId });
  if (error) throw new Error(`getProjectSecrets(${projectId}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { serviceRoleKey: row?.service_role_key ?? null, databaseUrl: row?.database_url ?? null };
}

/** Fingerprints from the most recent finished run of a project, or []. for a first run. */
export async function loadPreviousFingerprints(admin, projectId) {
  const { data: run, error: runErr } = await admin
    .from("runs")
    .select("id")
    .eq("project_id", projectId)
    .not("finished_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) throw new Error(`loadPreviousFingerprints(${projectId}): ${runErr.message}`);
  if (!run) return [];

  const { data: findings, error: findErr } = await admin
    .from("findings")
    .select("fingerprint")
    .eq("run_id", run.id);
  if (findErr) throw new Error(`loadPreviousFingerprints(${projectId}): ${findErr.message}`);
  return findings.map((f) => f.fingerprint);
}

/** Insert a run row, return its id. */
export async function insertRun(admin, { projectId, startedAt }) {
  const { data, error } = await admin
    .from("runs")
    .insert({ project_id: projectId, started_at: startedAt })
    .select("id")
    .single();
  if (error) throw new Error(`insertRun(${projectId}): ${error.message}`);
  return data.id;
}

/** Mark a run finished, with its outcome. */
export async function finishRun(admin, runId, { status, error, counts, reportMd }) {
  const { error: updErr } = await admin
    .from("runs")
    .update({ finished_at: new Date().toISOString(), status, error: error ?? null, counts, report_md: reportMd ?? null })
    .eq("id", runId);
  if (updErr) throw new Error(`finishRun(${runId}): ${updErr.message}`);
}

/** Bulk-insert findings for a run. No-op if the list is empty. */
export async function insertFindings(admin, runId, projectId, findings) {
  if (!findings.length) return;
  const rows = findings.map((f) => ({
    run_id: runId,
    project_id: projectId,
    severity: f.severity,
    kind: f.kind,
    target: f.table ?? f.function ?? null,
    message: f.message,
    fix: f.fix ?? null,
    fingerprint: f.fingerprint,
  }));
  const { error } = await admin.from("findings").insert(rows);
  if (error) throw new Error(`insertFindings(run ${runId}): ${error.message}`);
}

export async function insertAlert(admin, { projectId, runId, channel, payload }) {
  const { error } = await admin
    .from("alerts")
    .insert({ project_id: projectId, run_id: runId, channel, payload });
  if (error) throw new Error(`insertAlert(${projectId}): ${error.message}`);
}

export async function loadProject(admin, projectId) {
  const { data, error } = await admin.from("projects").select("*").eq("id", projectId).single();
  if (error) throw new Error(`loadProject(${projectId}): ${error.message}`);
  return data;
}

/** Pending `run_requests`, oldest first. */
export async function loadPendingRunRequests(admin) {
  const { data, error } = await admin
    .from("run_requests")
    .select("*")
    .is("picked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`loadPendingRunRequests: ${error.message}`);
  return data;
}

export async function markRunRequestPicked(admin, id) {
  const { error } = await admin.from("run_requests").update({ picked_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`markRunRequestPicked(${id}): ${error.message}`);
}

export async function markRunRequestDone(admin, id, error) {
  const { error: updErr } = await admin
    .from("run_requests")
    .update({ done_at: new Date().toISOString(), error: error ?? null })
    .eq("id", id);
  if (updErr) throw new Error(`markRunRequestDone(${id}): ${updErr.message}`);
}

/** Agency row, for its telegram_chat_id. */
export async function loadAgency(admin, agencyId) {
  const { data, error } = await admin.from("agencies").select("*").eq("id", agencyId).single();
  if (error) throw new Error(`loadAgency(${agencyId}): ${error.message}`);
  return data;
}
