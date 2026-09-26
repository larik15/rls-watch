import { test } from "node:test";
import assert from "node:assert/strict";
import { twoAccountTest } from "supabase-security-mcp/src/twoAccount.mjs";
import { checkProject } from "../checkProject.mjs";
import { fingerprint } from "../../shared/fingerprint.mjs";
import { fakeClientProject, fakeDb, PROJECT_URL } from "./fakes.mjs";

const baseProject = {
  id: "p1",
  agency_id: "ag1",
  name: "Acme",
  supabase_url: PROJECT_URL,
  anon_key: "sb_publishable_x",
  tables: ["todos"],
  buckets: [],
  rpc: ["get_stats"],
  rpc_probe_confirmed: false,
  two_account: [{ name: "todos" }],
  two_account_enabled: false,
};

const closed = (cfg) => [
  ...cfg.tables.map((t) => ({ target: t, kind: "table", open: false, status: 401, detail: "blocked" })),
  ...cfg.rpc.map((f) => ({ target: f, kind: "rpc", open: false, status: 401, detail: "blocked" })),
];
const openTodos = () => [{ target: "todos", kind: "table", open: true, status: 200, detail: "returned rows" }];

function telegram({ fail = false } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return fail
      ? new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { sent, fetchImpl };
}

async function run({ project = {}, db: dbOpts = {}, deps = {}, fetchImpl, telegramBotToken = "123:TOKEN", deadlineMs } = {}) {
  const fake = fakeDb(dbOpts);
  const result = await checkProject({
    admin: null,
    project: { ...baseProject, ...project },
    telegramBotToken,
    webUrl: "https://watch.example.com",
    fetchImpl: fetchImpl ?? telegram().fetchImpl,
    deadlineMs,
    deps: { db: fake.db, runProbes: async (cfg) => closed(cfg), auditPolicies: async () => ({ tables: [] }), ...deps },
  });
  return { result, ...fake };
}

test("a clean run completes ok and records what it did and didn't check", async () => {
  let probedRpc;
  const { result, calls } = await run({ deps: { runProbes: async (cfg) => ((probedRpc = cfg.rpc), closed(cfg)) } });

  assert.equal(result.status, "ok");
  const done = calls.completed[0];
  assert.equal(done.status, "ok");
  assert.deepEqual(done.checks.probe.evaluated, [{ kind: "table", target: "todos" }]);
  assert.deepEqual(probedRpc, [], "RPCs aren't called until the owner confirms");
  assert.equal(done.checks.probe.rpc_skipped, 1);
  assert.equal(done.checks.policies.reason, "no database URL stored");
  assert.equal(done.checks.two_account.reason, "disabled");
  assert.match(done.reportMd, /## Coverage/);
  assert.match(done.reportMd, /policy audit: not run \(no database URL stored\)/);
  assert.match(done.reportMd, /RPC function\(s\) listed but not called/);
  assert.deepEqual(calls.alerts, []);
});

test("RPCs are probed once rpc_probe_confirmed is set", async () => {
  let probedRpc;
  await run({ project: { rpc_probe_confirmed: true }, deps: { runProbes: async (cfg) => ((probedRpc = cfg.rpc), closed(cfg)) } });
  assert.deepEqual(probedRpc, ["get_stats"]);
});

test("a failed Telegram send leaves the run ok and records the failure separately", async () => {
  const tg = telegram({ fail: true });
  const { result, calls } = await run({ deps: { runProbes: openTodos }, fetchImpl: tg.fetchImpl });

  assert.equal(result.status, "ok");
  assert.deepEqual(calls.order, ["complete:ok", "alert:failed"], "the run is final before the alert is attempted");
  assert.equal(calls.alerts[0].channel, "telegram");
  assert.match(calls.alerts[0].error, /chat not found/);
  assert.equal(calls.completed.length, 1, "nothing rewrites the run afterwards");
});

test("new critical/high findings with no chat id → alert recorded on channel 'none'", async () => {
  const { calls } = await run({ deps: { runProbes: openTodos }, db: { agency: { telegram_chat_id: null } } });
  assert.deepEqual(
    calls.alerts.map((a) => [a.channel, a.status, a.error]),
    [["none", "skipped", "the agency has no Telegram chat id"]]
  );
});

test("new critical/high findings with no bot token → alert recorded on channel 'none'", async () => {
  const { calls } = await run({ deps: { runProbes: openTodos }, telegramBotToken: null });
  assert.equal(calls.alerts[0].channel, "none");
  assert.match(calls.alerts[0].error, /TELEGRAM_BOT_TOKEN/);
});

test("a sent alert is recorded as sent, with agency_id", async () => {
  const tg = telegram();
  const { calls } = await run({ deps: { runProbes: openTodos }, fetchImpl: tg.fetchImpl });
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].body.chat_id, "chat-1");
  assert.deepEqual([calls.alerts[0].status, calls.alerts[0].agencyId], ["sent", "ag1"]);
});

test("an error run stores no counts and a sanitized error", async () => {
  const { result, calls } = await run({
    deps: {
      runProbes: async () => {
        throw new Error("boom connecting to postgresql://postgres.ref:pw@aws-0.pooler.supabase.com:5432/postgres");
      },
    },
  });
  assert.equal(result.status, "error");
  const done = calls.completed[0];
  assert.equal(done.status, "error");
  assert.equal(done.counts, undefined);
  assert.doesNotMatch(done.error, /pooler|pw@/);
  assert.deepEqual(calls.alerts, []);
});

test("a run that exceeds its deadline ends as 'timeout' and its requests are aborted", async () => {
  let abortedWith;
  const hanging = async (cfg, fetch) => {
    try {
      await fetch(`${PROJECT_URL}/rest/v1/todos`);
    } catch (err) {
      abortedWith = err;
    }
    return [];
  };
  const client = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const { result, calls } = await run({ deps: { runProbes: hanging }, fetchImpl: client, deadlineMs: 30 });

  assert.equal(result.status, "timeout");
  assert.equal(calls.completed[0].status, "timeout");
  assert.match(calls.completed[0].error, /did not finish within/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(abortedWith, "the in-flight request was aborted");
  assert.equal(calls.completed.length, 1, "the abandoned evaluation never completes the run");
});

test("no second run while another run of the project holds the lease", async () => {
  const { result, calls } = await run({ db: { claim: null } });
  assert.equal(result.status, "skipped");
  assert.deepEqual(calls.completed, []);
});

test("if the lease was lost meanwhile, the result is not alerted on", async () => {
  const { result, calls } = await run({ deps: { runProbes: openTodos }, db: { completeReturns: false } });
  assert.equal(result.status, "timeout");
  assert.deepEqual(calls.alerts, []);
});

test("previous findings of a check that didn't run are 'not evaluated', not 'resolved'", async () => {
  const policyFinding = { run_id: "r0", kind: "policy_open_read", target: "todos", severity: "high", message: "open", fingerprint: fingerprint({ kind: "policy_open_read", table: "todos", policy: "p" }) };
  const probeFinding = { run_id: "r0", kind: "anon_open_table", target: "todos", severity: "high", message: "open", fingerprint: fingerprint({ kind: "anon_open_table", table: "todos" }) };

  const { calls } = await run({ db: { baseline: [policyFinding, probeFinding] } });
  const diff = calls.completed[0].diff;
  assert.deepEqual(diff.resolved.map((f) => f.kind), ["anon_open_table"], "todos was probed and is closed now");
  assert.deepEqual(diff.not_evaluated.map((f) => f.kind), ["policy_open_read"], "no database URL this run");
});

test("with a database URL and no tables listed, the probe uses the tables the audit found", async () => {
  let probedTables;
  const { calls } = await run({
    project: { tables: [] },
    db: { secrets: { databaseUrl: "postgresql://postgres.ref:pw@aws-0.pooler.supabase.com:5432/postgres" } },
    deps: {
      auditPolicies: async () => ({ tables: [{ schema: "public", table: "notes" }, { schema: "public", table: "todos" }], policies: [], functions: [], findings: [] }),
      runProbes: async (cfg) => ((probedTables = cfg.tables), closed(cfg)),
    },
  });
  assert.deepEqual(probedTables, ["notes", "todos"]);
  assert.equal(calls.completed[0].checks.probe.tables_source, "discovered");
  assert.equal(calls.completed[0].checks.policies.tables, 2);
});

test("a run with zero evaluable targets is still ok, and says so in checks", async () => {
  const { calls } = await run({
    project: { tables: ["nope"] },
    deps: { runProbes: async () => [{ target: "nope", kind: "table", open: false, status: 404, detail: "not found" }] },
  });
  const checks = calls.completed[0].checks;
  assert.deepEqual(checks.probe.evaluated, []);
  assert.deepEqual(checks.probe.not_evaluated, [{ kind: "table", target: "nope", reason: "HTTP 404" }]);
});

test("the two-account test runs only when enabled; everything it creates is tracked by id", async () => {
  const client = fakeClientProject();
  const { calls, artifacts } = await run({
    project: { two_account_enabled: true },
    db: { secrets: { serviceRoleKey: "sb_secret_x" } },
    deps: { twoAccountTest },
    fetchImpl: client.fetchImpl,
  });

  assert.deepEqual(calls.artifacts.map((a) => a.kind).sort(), ["row", "user", "user"]);
  assert.ok(calls.artifacts.every((a) => a.run_id === "run-1" && a.agency_id === "ag1" && a.supabase_url === PROJECT_URL));
  assert.ok(artifacts.every((a) => a.cleaned_at), "the library's own cleanup worked and was verified");
  assert.deepEqual(calls.completed[0].checks.two_account.evaluated, ["todos"]);
  assert.ok(!calls.completed[0].findings.some((f) => f.kind === "test_artifacts_left"));
});

test("test data that survives cleanup becomes a critical test_artifacts_left finding with exact ids", async () => {
  const client = fakeClientProject({ deletesFail: true });
  const { calls } = await run({
    project: { two_account_enabled: true },
    db: { secrets: { serviceRoleKey: "sb_secret_x" }, agency: { telegram_chat_id: null } },
    deps: { twoAccountTest },
    fetchImpl: client.fetchImpl,
  });

  const leftover = calls.completed[0].findings.find((f) => f.kind === "test_artifacts_left");
  assert.equal(leftover.severity, "critical");
  for (const id of [...client.users.keys()]) assert.match(leftover.message, new RegExp(id));
  assert.match(leftover.message, /todos\.id=row-/);
  assert.equal(calls.completed[0].counts.critical >= 1, true);
});
