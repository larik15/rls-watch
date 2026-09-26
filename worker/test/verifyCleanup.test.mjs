import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listLeftoverTestUsers,
  listLeftoverTestRows,
  verifyTwoAccountCleanup,
  cleanupFinding,
} from "../verifyCleanup.mjs";

function fakeFetch({ users = [], rowsByOwner = {} } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/auth/v1/admin/users")) {
      return { status: 200, json: async () => ({ users }) };
    }
    if (u.pathname.startsWith("/rest/v1/")) {
      const table = decodeURIComponent(u.pathname.slice("/rest/v1/".length));
      const ownerCol = [...u.searchParams.keys()].find((k) => k !== "select");
      const ownerVal = u.searchParams.get(ownerCol)?.replace(/^eq\./, "");
      const rows = rowsByOwner[`${table}:${ownerVal}`] ?? [];
      return { status: 200, json: async () => rows };
    }
    return { status: 404, json: async () => null };
  };
}

test("listLeftoverTestUsers keeps only rlscheck- emails", async () => {
  const fetchImpl = fakeFetch({
    users: [
      { id: "u1", email: "rlscheck-a-abc123@example.com" },
      { id: "u2", email: "real-customer@example.com" },
      { id: "u3", email: "rlscheck-b-abc123@example.com" },
    ],
  });
  const users = await listLeftoverTestUsers("https://proj.supabase.co", "service-key", fetchImpl);
  assert.deepEqual(
    users.map((u) => u.id),
    ["u1", "u3"]
  );
});

test("listLeftoverTestUsers returns [] when the admin API call fails", async () => {
  const fetchImpl = async () => ({ status: 401, json: async () => null });
  const users = await listLeftoverTestUsers("https://proj.supabase.co", "bad-key", fetchImpl);
  assert.deepEqual(users, []);
});

test("listLeftoverTestRows returns [] without calling anything when there are no leftover users", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 200, json: async () => [] };
  };
  const rows = await listLeftoverTestRows(
    "https://proj.supabase.co",
    "service-key",
    [{ name: "todos", ownerColumn: "user_id", idColumn: "id" }],
    [],
    fetchImpl
  );
  assert.deepEqual(rows, []);
  assert.equal(calls, 0);
});

test("listLeftoverTestRows finds rows owned by a leftover test user, using each table's own owner/id columns", async () => {
  const fetchImpl = fakeFetch({
    rowsByOwner: { "todos:u1": [{ id: "row-1" }] },
  });
  const rows = await listLeftoverTestRows(
    "https://proj.supabase.co",
    "service-key",
    [{ name: "todos", ownerColumn: "user_id", idColumn: "id" }],
    [{ id: "u1", email: "rlscheck-a-abc123@example.com" }],
    fetchImpl
  );
  assert.deepEqual(rows, [{ table: "todos", id: "row-1" }]);
});

test("listLeftoverTestRows defaults to user_id/id when a table config omits them", async () => {
  const fetchImpl = fakeFetch({
    rowsByOwner: { "notes:u1": [{ id: 42 }] },
  });
  const rows = await listLeftoverTestRows(
    "https://proj.supabase.co",
    "service-key",
    [{ name: "notes" }],
    [{ id: "u1", email: "rlscheck-a-abc123@example.com" }],
    fetchImpl
  );
  assert.deepEqual(rows, [{ table: "notes", id: 42 }]);
});

test("verifyTwoAccountCleanup reports nothing left when cleanup succeeded", async () => {
  const fetchImpl = fakeFetch({ users: [{ id: "u9", email: "real@example.com" }] });
  const result = await verifyTwoAccountCleanup(
    { url: "https://proj.supabase.co", serviceRoleKey: "k", tables: [{ name: "todos" }] },
    fetchImpl
  );
  assert.deepEqual(result, { leftoverUsers: [], leftoverRows: [] });
});

test("verifyTwoAccountCleanup combines leftover users and their rows", async () => {
  const fetchImpl = fakeFetch({
    users: [{ id: "u1", email: "rlscheck-a-abc@example.com" }],
    rowsByOwner: { "todos:u1": [{ id: "row-1" }] },
  });
  const result = await verifyTwoAccountCleanup(
    { url: "https://proj.supabase.co", serviceRoleKey: "k", tables: [{ name: "todos", ownerColumn: "user_id", idColumn: "id" }] },
    fetchImpl
  );
  assert.deepEqual(result.leftoverUsers, [{ id: "u1", email: "rlscheck-a-abc@example.com" }]);
  assert.deepEqual(result.leftoverRows, [{ table: "todos", id: "row-1" }]);
});

test("cleanupFinding returns null when nothing was left", () => {
  assert.equal(cleanupFinding({ leftoverUsers: [], leftoverRows: [] }), null);
});

test("cleanupFinding is critical and names the exact ids when something was left", () => {
  const finding = cleanupFinding({
    leftoverUsers: [{ id: "u1", email: "rlscheck-a-abc@example.com" }],
    leftoverRows: [{ table: "todos", id: "row-1" }],
  });
  assert.equal(finding.severity, "critical");
  assert.equal(finding.kind, "test_artifacts_left");
  assert.match(finding.message, /rlscheck-a-abc@example\.com \(u1\)/);
  assert.match(finding.message, /todos\.row-1/);
});
