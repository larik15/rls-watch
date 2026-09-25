import { supabase } from "../supabaseClient.js";

/**
 * Write a project's service role key / database URL through the owner-only,
 * Vault-backed RPC. The browser never reads these back.
 * @param {string} projectId
 * @param {{ serviceRoleKey?: string|null, databaseUrl?: string|null }} secrets
 *   For each field: `null` leaves it unchanged, `''` removes it, anything else sets it.
 */
export async function upsertProjectSecrets(projectId, { serviceRoleKey = null, databaseUrl = null } = {}) {
  const { error } = await supabase.rpc("upsert_project_secrets", {
    p_project_id: projectId,
    p_service_role_key: serviceRoleKey,
    p_database_url: databaseUrl,
  });
  if (error) throw error;
}
