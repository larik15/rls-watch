import { test } from "node:test";
import assert from "node:assert/strict";
import { processRunRequests } from "../runRequests.mjs";

function queue(requests, { agency = { name: "Acme", telegram_chat_id: "chat-1" } } = {}) {
  const pending = [...requests];
  const done = [];
  const alerts = [];
  const db = {
    claimRunRequest: async () => pending.shift() ?? null,
    loadAgency: async () => agency,
    loadProject: async (_a, id) => ({ id, name: "P" }),
    markRunRequestDone: async (_a, id, error) => done.push({ id, error }),
    insertAlert: async (_a, alert) => alerts.push(alert),
  };
  return { db, done, alerts };
}

const telegramOk = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const telegramFails = async () =>
  new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });

test("telegram_test sends and records an agency-level alert (no project)", async () => {
  const q = queue([{ id: "r1", kind: "telegram_test", agency_id: "ag1" }]);
  await processRunRequests({ admin: null, telegramBotToken: "1:T", webUrl: "x", fetchImpl: telegramOk, db: q.db });

  assert.deepEqual(q.done, [{ id: "r1", error: null }]);
  assert.deepEqual(
    q.alerts.map((a) => [a.agencyId, a.projectId, a.channel, a.status]),
    [["ag1", null, "telegram", "sent"]]
  );
});

test("a failed telegram_test is recorded as a failed alert and a sanitized request error", async () => {
  const q = queue([{ id: "r1", kind: "telegram_test", agency_id: "ag1" }]);
  await processRunRequests({ admin: null, telegramBotToken: "8850675678:AAGsecret", webUrl: "x", fetchImpl: telegramFails, db: q.db });

  assert.equal(q.alerts[0].status, "failed");
  assert.match(q.done[0].error, /Unauthorized/);
  assert.doesNotMatch(q.done[0].error, /AAGsecret/);
});

test("'run' requests go through checkProject; a skipped run is reported back on the request", async () => {
  const q = queue([
    { id: "r1", kind: "run", project_id: "p1", agency_id: "ag1" },
    { id: "r2", kind: "run", project_id: "p2", agency_id: "ag1" },
  ]);
  const checked = [];
  const check = async ({ project }) => (checked.push(project.id), project.id === "p1" ? { status: "ok" } : { status: "skipped" });

  await processRunRequests({ admin: null, webUrl: "x", db: q.db, check });

  assert.deepEqual(checked, ["p1", "p2"]);
  assert.deepEqual(q.done, [
    { id: "r1", error: null },
    { id: "r2", error: "a run of this project was already in progress" },
  ]);
});
