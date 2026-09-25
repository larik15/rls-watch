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
 * The two most recent runs (latest + previous) for each of the given project ids,
 * as a Map<projectId, {latest, previous}>. Good enough for a status dot + trend
 * arrow without a "top N per group" round trip per project.
 */
export async function listRecentRunsByProject(projectIds) {
  const byProject = new Map(projectIds.map((id) => [id, []]));
  if (projectIds.length === 0) return byProject;

  const { data, error } = await supabase
    .from("runs")
    .select("id, project_id, started_at, finished_at, status, counts")
    .in("project_id", projectIds)
    .order("started_at", { ascending: false })
    .limit(Math.max(projectIds.length * 4, 40));
  if (error) throw error;

  for (const run of data) {
    const list = byProject.get(run.project_id);
    if (list && list.length < 2) list.push(run);
  }

  const result = new Map();
  for (const [id, list] of byProject) {
    result.set(id, { latest: list[0] ?? null, previous: list[1] ?? null });
  }
  return result;
}

/** critical+high count from a `runs.counts` jsonb value (may be null before a first run). */
export function severeCount(counts) {
  if (!counts) return 0;
  return (counts.critical ?? 0) + (counts.high ?? 0);
}

/** "up" (worse), "down" (better), or "flat" comparing two runs' critical+high counts. */
export function trend(latest, previous) {
  if (!latest || !previous) return "flat";
  const a = severeCount(latest.counts);
  const b = severeCount(previous.counts);
  if (a > b) return "up";
  if (a < b) return "down";
  return "flat";
}
