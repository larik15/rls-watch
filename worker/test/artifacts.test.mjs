import { test } from "node:test";
import assert from "node:assert/strict";
import { trackingFetch, reconcileArtifacts, artifactsFinding } from "../artifacts.mjs";
import { fakeClientProject, fakeDb, PROJECT_URL } from "./fakes.mjs";

const project = { id: "p1", agency_id: "ag1", supabase_url: PROJECT_URL };

test("trackingFetch records created users and rows, and the caller can still read the body", async () => {
  const client = fakeClientProject();
  const recorded = [];
  const tracked = trackingFetch(client.fetchImpl, {
    baseUrl: PROJECT_URL,
    tables: [{ name: "todos", idColumn: "id" }],
    record: async (a) => recorded.push(a),
  });

  const userRes = await tracked(`${PROJECT_URL}/auth/v1/admin/users`, { method: "POST", body: JSON.stringify({ email: "rlscheck-a@example.com" }) });
  const rowRes = await tracked(`${PROJECT_URL}/rest/v1/todos`, { method: "POST", body: JSON.stringify({ title: "t" }) });
  await tracked(`${PROJECT_URL}/rest/v1/todos?id=eq.row-2&select=*`); // reads aren't recorded
  await tracked(`${PROJECT_URL}/rest/v1/other`, { method: "POST", body: "{}" }); // not a two-account table

  assert.deepEqual(recorded, [
    { kind: "user", ref: "user-1" },
    { kind: "row", table_name: "todos", id_column: "id", ref: "row-2" },
  ]);
  assert.equal((await userRes.json()).id, "user-1");
  assert.equal((await rowRes.json())[0].id, "row-2");
});

test("trackingFetch ignores requests to other hosts", async () => {
  const recorded = [];
  const tracked = trackingFetch(fakeClientProject().fetchImpl, { baseUrl: PROJECT_URL, tables: [], record: async (a) => recorded.push(a) });
  await tracked("https://zyxwvutsrqponmlkjihg.supabase.co/auth/v1/admin/users", { method: "POST", body: "{}" });
  assert.deepEqual(recorded, []);
});

test("reconcileArtifacts marks already-gone artifacts cleaned and deletes present ones", async () => {
  const client = fakeClientProject();
  const { db, calls } = fakeDb();
  client.users.set("user-9", { id: "user-9", email: "rlscheck-a@example.com" });
  await db.insertArtifact(null, { project_id: "p1", supabase_url: PROJECT_URL, kind: "user", ref: "user-9" }); // present
  await db.insertArtifact(null, { project_id: "p1", supabase_url: PROJECT_URL, kind: "user", ref: "user-gone" }); // already gone

  const left = await reconcileArtifacts({ admin: null, db, project, serviceRoleKey: "sb_secret_x", fetchImpl: client.fetchImpl });

  assert.deepEqual(left, []);
  assert.equal(calls.cleaned.length, 2);
  assert.equal(client.users.has("user-9"), false);
});

test("reconcileArtifacts reports what survives a delete, deleting rows before users", async () => {
  const client = fakeClientProject({ deletesFail: true });
  const { db } = fakeDb();
  client.users.set("user-1", { id: "user-1" });
  client.tables.set("todos", [{ id: "row-1", user_id: "user-1" }]);
  await db.insertArtifact(null, { project_id: "p1", supabase_url: PROJECT_URL, kind: "user", ref: "user-1" });
  await db.insertArtifact(null, { project_id: "p1", supabase_url: PROJECT_URL, kind: "row", table_name: "todos", id_column: "id", ref: "row-1" });

  const left = await reconcileArtifacts({ admin: null, db, project, serviceRoleKey: "sb_secret_x", fetchImpl: client.fetchImpl });

  assert.deepEqual(left.map((a) => [a.kind, a.ref, a.reason]), [
    ["row", "row-1", "still present after a delete attempt"],
    ["user", "user-1", "still present after a delete attempt"],
  ]);
  const deletes = client.requests.filter((r) => r.method === "DELETE").map((r) => new URL(r.url).pathname);
  assert.deepEqual(deletes, ["/rest/v1/todos", "/auth/v1/admin/users/user-1"]);
});

test("reconcileArtifacts can't verify without a service key or after the URL changed — reports, doesn't touch", async () => {
  const client = fakeClientProject();
  const { db } = fakeDb();
  await db.insertArtifact(null, { project_id: "p1", supabase_url: PROJECT_URL, kind: "user", ref: "u1" });
  await db.insertArtifact(null, { project_id: "p1", supabase_url: "https://zyxwvutsrqponmlkjihg.supabase.co", kind: "user", ref: "u2" });

  const noKey = await reconcileArtifacts({ admin: null, db, project, serviceRoleKey: null, fetchImpl: client.fetchImpl });
  assert.deepEqual(noKey.map((a) => a.reason), [
    "no service role key stored to check or delete it",
    "created under this project's previous Supabase URL",
  ]);
  assert.equal(client.requests.length, 0);
});

test("artifactsFinding: null when nothing is left; otherwise one critical finding with exact ids", () => {
  assert.equal(artifactsFinding([]), null);
  assert.equal(artifactsFinding([], { leftoverUsers: [], leftoverRows: [] }), null);

  const f = artifactsFinding(
    [
      { kind: "user", ref: "user-1", reason: "still present after a delete attempt" },
      { kind: "row", table_name: "todos", id_column: "id", ref: "row-1", reason: "still present after a delete attempt" },
    ],
    {
      leftoverUsers: [
        { id: "user-1", email: "rlscheck-a@example.com" }, // already listed, not repeated
        { id: "user-7", email: "rlscheck-b@example.com" },
      ],
      leftoverRows: [{ table: "notes", idColumn: "pk", id: 42 }],
    }
  );
  assert.equal(f.severity, "critical");
  assert.equal(f.kind, "test_artifacts_left");
  assert.match(f.message, /user-1 \(still present/);
  assert.match(f.message, /user-7 \(rlscheck-b@example\.com/);
  assert.match(f.message, /todos\.id=row-1/);
  assert.match(f.message, /notes\.pk=42/);
  assert.equal(f.message.match(/user-1/g).length, 1);
});
