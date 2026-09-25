import { supabase } from "../supabaseClient.js";

/** The signed-in user's role in an agency ('owner' | 'member'), or null if not a member. */
export async function getMyRole(agencyId, userId) {
  const { data, error } = await supabase
    .from("members")
    .select("role")
    .eq("agency_id", agencyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.role ?? null;
}
