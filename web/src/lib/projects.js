import { supabase } from "../supabaseClient.js";

/** Projects (via projects_public, which never exposes secret values) for one agency. */
export async function listProjects(agencyId) {
  const { data, error } = await supabase
    .from("projects_public")
    .select("*")
    .eq("agency_id", agencyId)
    .order("name", { ascending: true });
  if (error) throw error;
  return data;
}

/** One project, via projects_public (no secret values). */
export async function getProject(projectId) {
  const { data, error } = await supabase.from("projects_public").select("*").eq("id", projectId).single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} agencyId
 * @param {{ name, supabase_url, anon_key, tables, buckets, rpc, two_account }} fields
 */
export async function createProject(agencyId, fields) {
  const { data, error } = await supabase
    .from("projects")
    .insert({ agency_id: agencyId, ...fields })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** @param {{ name, supabase_url, anon_key, tables, buckets, rpc, two_account }} fields */
export async function updateProject(projectId, fields) {
  const { data, error } = await supabase.from("projects").update(fields).eq("id", projectId).select().single();
  if (error) throw error;
  return data;
}

/** Owner only (enforced by RLS' projects_delete policy). Cascades to runs/findings/alerts. */
export async function deleteProject(projectId) {
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
}

/**
 * Per project: the latest run (any status, for the status dot) and the two latest ok
 * runs (for the trend — failed runs have no counts and must not move it), as a
 * Map<projectId, {latest, latestOk, previousOk}>.
 */
export async function listRecentRunsByProject(projectIds) {
  const byProject = new Map(projectIds.map((id) => [id, { latest: null, ok: [] }]));
  if (projectIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("runs")
    .select("id, project_id, started_at, finished_at, status, error, counts, checks")
    .in("project_id", projectIds)
    .order("started_at", { ascending: false })
    .limit(Math.max(projectIds.length * 6, 60));
  if (error) throw error;

  for (const run of data) {
    const entry = byProject.get(run.project_id);
    if (!entry) continue;
    entry.latest ??= run;
    if (run.status === "ok" && entry.ok.length < 2) entry.ok.push(run);
  }

  const result = new Map();
  for (const [id, entry] of byProject) {
    result.set(id, { latest: entry.latest, latestOk: entry.ok[0] ?? null, previousOk: entry.ok[1] ?? null });
  }
  return result;
}

/** critical+high count from a `runs.counts` jsonb value; null when there are no counts (failed or no run). */
export function severeCount(counts) {
  if (!counts) return null;
  return (counts.critical ?? 0) + (counts.high ?? 0);
}

/** "up" (worse), "down" (better), or "flat" comparing two ok runs' critical+high counts. */
export function trend(latestOk, previousOk) {
  const a = severeCount(latestOk?.counts);
  const b = severeCount(previousOk?.counts);
  if (a === null || b === null) return "flat";
  if (a > b) return "up";
  if (a < b) return "down";
  return "flat";
}

/**
 * The most recent alert per project for an agency, as a Map<projectId, alert>.
 * Used to flag projects whose last critical/high alert wasn't delivered.
 */
export async function listLatestAlertsByProject(agencyId) {
  const { data, error } = await supabase
    .from("alerts")
    .select("project_id, channel, status, error, sent_at")
    .eq("agency_id", agencyId)
    .not("project_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const latest = new Map();
  for (const a of data) if (!latest.has(a.project_id)) latest.set(a.project_id, a);
  return latest;
}

/** True if an alert row means "we had something to tell you and it didn't arrive". */
export function alertUndelivered(alert) {
  return Boolean(alert && alert.status !== "sent");
}
