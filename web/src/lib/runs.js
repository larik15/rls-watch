import { supabase } from "../supabaseClient.js";

/** All runs for a project, newest first. */
export async function listRuns(projectId) {
  const { data, error } = await supabase
    .from("runs")
    .select("id, started_at, finished_at, status, error, counts, report_md")
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
