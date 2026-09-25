import { supabase } from "../supabaseClient.js";

/** Queue an on-demand run for one project. The worker polls run_requests every minute. */
export async function requestRun(agencyId, projectId) {
  const { error } = await supabase.from("run_requests").insert({ agency_id: agencyId, project_id: projectId, kind: "run" });
  if (error) throw error;
}

/** Queue a Telegram test message for the agency's configured chat. */
export async function requestTelegramTest(agencyId) {
  const { error } = await supabase.from("run_requests").insert({ agency_id: agencyId, kind: "telegram_test" });
  if (error) throw error;
}
