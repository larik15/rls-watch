import { supabase } from "../supabaseClient.js";

/** Agencies the signed-in user is a member of (RLS: agencies_select). */
export async function listMyAgencies() {
  const { data, error } = await supabase.from("agencies").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

/** Create a new agency, owned by the signed-in user. */
export async function createAgency(name, ownerId) {
  const { data, error } = await supabase.from("agencies").insert({ name, owner_id: ownerId }).select().single();
  if (error) throw error;
  return data;
}
