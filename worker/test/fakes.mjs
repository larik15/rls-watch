// Shared fakes for worker tests. No network.

export const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A tiny stand-in for a client Supabase project: admin users API + one REST table per
 * name. `deletesFail` makes every DELETE a no-op (cleanup "silently failing").
 */
export function fakeClientProject({ deletesFail = false, extraUsers = [] } = {}) {
  const users = new Map(extraUsers.map((u) => [u.id, u]));
  const tables = new Map();
  let nextId = 1;
  const requests = [];

  async function fetchImpl(url, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ method, url: String(url) });
    if (init.signal?.aborted) throw init.signal.reason;
    const u = new URL(url);

    if (u.pathname === "/auth/v1/admin/users") {
      if (method === "POST") {
        const body = JSON.parse(init.body);
        const id = `user-${nextId++}`;
        users.set(id, { id, email: body.email });
        return json({ id, email: body.email });
      }
      return json({ users: [...users.values()] });
    }
    if (u.pathname === "/auth/v1/token" && method === "POST") {
      const { email } = JSON.parse(init.body);
      return json({ access_token: `jwt-for-${email}` });
    }
    if (u.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      if (method === "DELETE") {
        if (!deletesFail) users.delete(id);
        return json({});
      }
      return users.has(id) ? json(users.get(id)) : json({ msg: "User not found" }, 404);
    }
    if (u.pathname.startsWith("/rest/v1/")) {
      const table = decodeURIComponent(u.pathname.slice("/rest/v1/".length));
      if (!tables.has(table)) tables.set(table, []);
      const rows = tables.get(table);
      const filters = [...u.searchParams].filter(([k]) => k !== "select");
      const match = (row) => filters.every(([k, v]) => String(row[k]) === v.replace(/^eq\./, ""));
      if (method === "POST") {
        const row = { id: `row-${nextId++}`, ...JSON.parse(init.body) };
        rows.push(row);
        return json([row], 201);
      }
      if (method === "DELETE") {
        if (!deletesFail) tables.set(table, rows.filter((r) => !match(r)));
        return new Response(null, { status: 204 });
      }
      return json(rows.filter(match));
    }
    return json({ message: "not found" }, 404);
  }

  return { fetchImpl, users, tables, requests };
}

/** In-memory stand-in for worker/db.mjs. */
export function fakeDb({ claim = "run-1", secrets = {}, baseline = [], agency = { telegram_chat_id: "chat-1", name: "Agency" }, completeReturns = true } = {}) {
  const calls = { completed: [], alerts: [], artifacts: [], cleaned: [], artifactErrors: [], order: [] };
  const artifacts = [];
  const db = {
    claimProjectRun: async () => claim,
    getProjectSecrets: async () => ({ serviceRoleKey: null, databaseUrl: null, ...secrets }),
    loadBaselineFindings: async () => baseline,
    completeRun: async (_admin, runId, payload) => {
      calls.completed.push({ runId, ...payload });
      calls.order.push(`complete:${payload.status}`);
      return completeReturns;
    },
    loadAgency: async () => agency,
    insertAlert: async (_admin, a) => {
      calls.alerts.push(a);
      calls.order.push(`alert:${a.status}`);
    },
    insertArtifact: async (_admin, a) => {
      calls.artifacts.push(a);
      artifacts.push({ id: `artifact-${artifacts.length + 1}`, cleaned_at: null, ...a });
    },
    loadPendingArtifacts: async () => artifacts.filter((a) => !a.cleaned_at).map((a) => ({ ...a })),
    markArtifactCleaned: async (_admin, id) => {
      artifacts.find((a) => a.id === id).cleaned_at = "now";
      calls.cleaned.push(id);
    },
    markArtifactError: async (_admin, id, reason) => calls.artifactErrors.push({ id, reason }),
  };
  return { db, calls, artifacts };
}
