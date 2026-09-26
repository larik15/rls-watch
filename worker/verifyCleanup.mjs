// twoAccountTest (supabase-security-mcp) already deletes its two temporary users and
// their test rows in a `finally` block. This is a safety net for the case where that
// cleanup silently failed (a delete request erroring out, a changed policy, a network
// blip) — it re-checks the target project for anything left over, using the project's
// own service role key, and reports exact ids so they can be removed by hand.

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

/** Users left over from a two-account test (should normally be none). */
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
 * Rows in the two-account tables owned by any leftover test user. Only meaningful once
 * we already know which users didn't get cleaned up — an owned row can't be identified
 * any other way, since twoAccountTest doesn't hand back the ids it created.
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
        if (idCol in row) rows.push({ table: t.name, id: row[idCol] });
      }
    }
  }
  return rows;
}

/**
 * @param {Object} cfg
 * @param {string} cfg.url
 * @param {string} cfg.serviceRoleKey
 * @param {Array<{name:string, ownerColumn?:string, idColumn?:string}>} cfg.tables
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{leftoverUsers: Array, leftoverRows: Array}>}
 */
export async function verifyTwoAccountCleanup({ url, serviceRoleKey, tables }, fetchImpl = globalThis.fetch) {
  const leftoverUsers = await listLeftoverTestUsers(url, serviceRoleKey, fetchImpl);
  const leftoverRows = await listLeftoverTestRows(url, serviceRoleKey, tables, leftoverUsers, fetchImpl);
  return { leftoverUsers, leftoverRows };
}

/** Turn a verifyTwoAccountCleanup() result into a finding, or null if nothing was left. */
export function cleanupFinding({ leftoverUsers, leftoverRows }) {
  if (!leftoverUsers.length && !leftoverRows.length) return null;

  const parts = [];
  if (leftoverUsers.length) {
    parts.push(`auth.users: ${leftoverUsers.map((u) => `${u.email} (${u.id})`).join(", ")}`);
  }
  if (leftoverRows.length) {
    parts.push(`rows: ${leftoverRows.map((r) => `${r.table}.${r.id}`).join(", ")}`);
  }

  return {
    severity: "critical",
    kind: "test_artifacts_left",
    table: null,
    message: `The two-account test's own cleanup didn't finish — leftover test data: ${parts.join("; ")}.`,
    fix: "Remove these by hand: delete the listed auth users (and their rows, if not already gone) in the client project.",
  };
}
