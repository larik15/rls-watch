// Fallback to the exact-id tracking in artifacts.mjs: after a two-account test, look for
// any auth user with the test's email prefix (and rows those users own) in the client
// project. Catches users created before tracking existed, or whose creation response
// couldn't be read.

import { authHeaders } from "supabase-security-mcp/src/probe.mjs";

/** auth.users created by the two-account test all have emails starting with this. */
const TEST_EMAIL_PREFIX = "rlscheck-";

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Users left over from a two-account test (should normally be none). First page only. */
export async function listLeftoverTestUsers(url, serviceRoleKey, fetchImpl = globalThis.fetch) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/auth/v1/admin/users?per_page=200`, {
    headers: authHeaders(serviceRoleKey),
  });
  if (res.status !== 200) return [];
  const body = await safeJson(res);
  const users = Array.isArray(body) ? body : (body?.users ?? []);
  return users
    .filter((u) => typeof u.email === "string" && u.email.startsWith(TEST_EMAIL_PREFIX))
    .map((u) => ({ id: u.id, email: u.email }));
}

/**
 * Rows in the two-account tables owned by any leftover test user.
 *
 * @param {Array<{name:string, ownerColumn?:string, idColumn?:string}>} tables
 * @param {Array<{id:string, email:string}>} leftoverUsers
 */
export async function listLeftoverTestRows(url, serviceRoleKey, tables, leftoverUsers, fetchImpl = globalThis.fetch) {
  if (!leftoverUsers.length) return [];
  const base = url.replace(/\/+$/, "");
  const rows = [];
  for (const t of tables) {
    const ownerCol = t.ownerColumn || "user_id";
    const idCol = t.idColumn || "id";
    for (const u of leftoverUsers) {
      const endpoint = `${base}/rest/v1/${encodeURIComponent(t.name)}?${encodeURIComponent(ownerCol)}=eq.${encodeURIComponent(u.id)}&select=${encodeURIComponent(idCol)}`;
      const res = await fetchImpl(endpoint, { headers: authHeaders(serviceRoleKey) });
      if (res.status !== 200) continue;
      const body = await safeJson(res);
      for (const row of Array.isArray(body) ? body : []) {
        if (idCol in row) rows.push({ table: t.name, idColumn: idCol, id: row[idCol] });
      }
    }
  }
  return rows;
}

/**
 * @param {{url:string, serviceRoleKey:string, tables:Array}} cfg
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{leftoverUsers: Array, leftoverRows: Array}>}
 */
export async function verifyTwoAccountCleanup({ url, serviceRoleKey, tables }, fetchImpl = globalThis.fetch) {
  const leftoverUsers = await listLeftoverTestUsers(url, serviceRoleKey, fetchImpl);
  const leftoverRows = await listLeftoverTestRows(url, serviceRoleKey, tables, leftoverUsers, fetchImpl);
  return { leftoverUsers, leftoverRows };
}
