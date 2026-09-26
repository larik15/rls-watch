import { supabase } from "../supabaseClient.js";

/** All runs for a project, newest first. */
export async function listRuns(projectId) {
  const { data, error } = await supabase
    .from("runs")
    .select("id, started_at, finished_at, status, error, counts, report_md, checks, diff")
    .eq("project_id", projectId)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data;
}

/** Findings for one run. */
export async function listFindings(runId) {
  const { data, error } = await supabase.from("findings").select("*").eq("run_id", runId);
  if (error) throw error;
  return data;
}

/** The latest alert recorded for a project, or null. */
export async function getLatestAlert(projectId) {
  const { data, error } = await supabase
    .from("alerts")
    .select("channel, status, error, sent_at")
    .eq("project_id", projectId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}
