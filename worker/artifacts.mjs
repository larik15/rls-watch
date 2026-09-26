// Users and rows the two-account test creates in a client project, tracked by exact id.
// twoAccountTest (supabase-security-mcp) doesn't report what it created, so the fetch it
// is given records each creation in two_account_artifacts before the test continues —
// if the worker dies mid-test, the ids are already stored. Every run first retries the
// cleanup of anything not yet confirmed gone.

import { authHeaders } from "supabase-security-mcp/src/probe.mjs";

/**
 * @param {typeof fetch} fetchImpl
 * @param {{ baseUrl: string, tables: Array<{name:string, idColumn?:string}>, record: (a: object) => Promise<void> }} opts
 * @returns {typeof fetch}
 */
export function trackingFetch(fetchImpl, { baseUrl, tables, record }) {
  const base = baseUrl.replace(/\/+$/, "");
  const idColumnOf = new Map(tables.map((t) => [t.name, t.idColumn || "id"]));

  return async (url, init = {}) => {
    const res = await fetchImpl(url, init);
    const isCreate = (init.method ?? "GET").toUpperCase() === "POST" && res.status >= 200 && res.status < 300;
    if (!isCreate || !String(url).startsWith(`${base}/`)) return res;

    try {
      const path = new URL(url).pathname;
      if (path === "/auth/v1/admin/users") {
        const body = await res.clone().json();
        if (body?.id) await record({ kind: "user", ref: String(body.id) });
      } else if (path.startsWith("/rest/v1/")) {
        const table = decodeURIComponent(path.slice("/rest/v1/".length));
        const idColumn = idColumnOf.get(table);
        if (idColumn) {
          const body = await res.clone().json();
          for (const row of Array.isArray(body) ? body : []) {
            if (row && idColumn in row) {
              await record({ kind: "row", table_name: table, id_column: idColumn, ref: String(row[idColumn]) });
            }
          }
        }
      }
    } catch (err) {
      console.error("[rls-watch] could not record a two-account test artifact:", err);
    }
    return res;
  };
}

function artifactUrl(base, a) {
  if (a.kind === "user") return `${base}/auth/v1/admin/users/${encodeURIComponent(a.ref)}`;
  const col = encodeURIComponent(a.id_column);
  return `${base}/rest/v1/${encodeURIComponent(a.table_name)}?${col}=eq.${encodeURIComponent(a.ref)}`;
}

/** true / false, or null when the answer is unknown (request failed). */
export async function artifactExists(base, serviceRoleKey, a, fetchImpl) {
  try {
    const url = a.kind === "user" ? artifactUrl(base, a) : `${artifactUrl(base, a)}&select=${encodeURIComponent(a.id_column)}`;
    const res = await fetchImpl(url, { headers: authHeaders(serviceRoleKey) });
    if (a.kind === "user") {
      if (res.status === 404) return false;
      return res.status === 200 ? true : null;
    }
    if (res.status !== 200) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length > 0 : null;
  } catch {
    return null;
  }
}

async function removeArtifact(base, serviceRoleKey, a, fetchImpl) {
  try {
    await fetchImpl(artifactUrl(base, a), { method: "DELETE", headers: authHeaders(serviceRoleKey) });
  } catch {
    // checked again right after
  }
}

/**
 * Re-check every artifact of this project not yet confirmed gone, delete what's still
 * there, and return what's left (still present, or couldn't be checked) with a reason.
 */
export async function reconcileArtifacts({ admin, db, project, serviceRoleKey, fetchImpl }) {
  const pending = await db.loadPendingArtifacts(admin, project.id);
  // Rows before users: an owner column may reference auth.users.
  pending.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "row" ? -1 : 1));

  const base = project.supabase_url.replace(/\/+$/, "");
  const left = [];
  for (const a of pending) {
    if (a.supabase_url.replace(/\/+$/, "") !== base) {
      left.push({ ...a, reason: "created under this project's previous Supabase URL" });
      continue;
    }
    if (!serviceRoleKey) {
      left.push({ ...a, reason: "no service role key stored to check or delete it" });
      continue;
    }

    let present = await artifactExists(base, serviceRoleKey, a, fetchImpl);
    if (present) {
      await removeArtifact(base, serviceRoleKey, a, fetchImpl);
      present = await artifactExists(base, serviceRoleKey, a, fetchImpl);
    }
    if (present === false) {
      await db.markArtifactCleaned(admin, a.id);
      continue;
    }
    const reason = present ? "still present after a delete attempt" : "could not check whether it still exists";
    await db.markArtifactError(admin, a.id, reason);
    left.push({ ...a, reason });
  }
  return left;
}

/**
 * One critical finding naming every leftover by exact id, or null.
 * @param {Array} left   from reconcileArtifacts
 * @param {{leftoverUsers: Array<{id,email}>, leftoverRows: Array<{table,id}>}} [scan]  from verifyTwoAccountCleanup
 */
export function artifactsFinding(left, scan = { leftoverUsers: [], leftoverRows: [] }) {
  const users = new Map();
  const rows = new Map();
  for (const a of left) {
    if (a.kind === "user") users.set(a.ref, a.reason);
    else rows.set(`${a.table_name}.${a.id_column}=${a.ref}`, a.reason);
  }
  for (const u of scan.leftoverUsers) {
    if (!users.has(u.id)) users.set(u.id, `${u.email}, matched by the rlscheck- email prefix`);
  }
  for (const r of scan.leftoverRows) {
    const key = `${r.table}.${r.idColumn ?? "id"}=${r.id}`;
    if (!rows.has(key)) rows.set(key, "owned by a leftover test user");
  }
  if (!users.size && !rows.size) return null;

  const parts = [];
  if (users.size) parts.push(`auth.users: ${[...users].map(([id, why]) => `${id} (${why})`).join(", ")}`);
  if (rows.size) parts.push(`rows: ${[...rows].map(([ref, why]) => `${ref} (${why})`).join(", ")}`);
  return {
    severity: "critical",
    kind: "test_artifacts_left",
    table: null,
    message: `Two-account test data is still in the client project — ${parts.join("; ")}.`,
    fix: "Delete these by hand in the client project (Authentication → Users, and the listed rows), or store a working service role key so the worker can retry.",
  };
}
