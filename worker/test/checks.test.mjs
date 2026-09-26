import { test } from "node:test";
import assert from "node:assert/strict";
import { findingUnit, evaluatedUnits, targetsEvaluated, planBaseline } from "../../shared/checks.mjs";

test("findingUnit maps each finding kind to the check that produces it", () => {
  assert.equal(findingUnit({ kind: "anon_open_table", table: "todos" }), "probe:table:todos");
  assert.equal(findingUnit({ kind: "anon_open_rpc", target: "get_stats" }), "probe:rpc:get_stats");
  assert.equal(findingUnit({ kind: "cross_tenant_read", target: "todos" }), "two_account:todos");
  assert.equal(findingUnit({ kind: "test_artifacts_left", table: null }), "artifacts");
  assert.equal(findingUnit({ kind: "policy_open_write", table: "todos", policy: "p" }), "policies");
  assert.equal(findingUnit({ kind: "definer_function_exposed", table: null, function: "f()" }), "policies");
});

const checks = {
  probe: { evaluated: [{ kind: "table", target: "todos" }, { kind: "bucket", target: "avatars" }], not_evaluated: [] },
  policies: { evaluated: true, tables: 7 },
  two_account: { evaluated: ["todos"] },
  artifacts: { evaluated: true, pending: 0 },
};

test("evaluatedUnits lists every unit a run evaluated", () => {
  assert.deepEqual(
    [...evaluatedUnits(checks)].sort(),
    ["artifacts", "policies", "probe:bucket:avatars", "probe:table:todos", "two_account:todos"]
  );
  assert.equal(evaluatedUnits(null).size, 0);
});

test("targetsEvaluated: probes + audited tables + two-account tables; null when unknown", () => {
  assert.equal(targetsEvaluated(checks), 2 + 7 + 1);
  assert.equal(targetsEvaluated(null), null);
  assert.equal(
    targetsEvaluated({ probe: { evaluated: [] }, policies: { evaluated: false, reason: "x" }, two_account: { evaluated: [] } }),
    0
  );
});

test("planBaseline: each unit's baseline is the latest ok run that evaluated it", () => {
  const runs = [
    // newest: policy audit didn't run (no database URL), probe did
    { id: "r3", checks: { probe: { evaluated: [{ kind: "table", target: "todos" }] }, policies: { evaluated: false } } },
    // older: policy audit ran
    { id: "r2", checks: { probe: { evaluated: [{ kind: "table", target: "todos" }] }, policies: { evaluated: true, tables: 3 } } },
    { id: "r1", checks: { policies: { evaluated: true, tables: 3 } } },
  ];
  const plan = planBaseline(runs);
  assert.deepEqual(plan.runIds.sort(), ["r2", "r3"]);

  assert.equal(plan.includes({ run_id: "r3", kind: "anon_open_table", target: "todos" }), true);
  assert.equal(plan.includes({ run_id: "r2", kind: "anon_open_table", target: "todos" }), false, "superseded by r3");
  assert.equal(plan.includes({ run_id: "r2", kind: "rls_disabled", target: "x" }), true, "r3 skipped the audit, r2 is its baseline");
  assert.equal(plan.includes({ run_id: "r1", kind: "rls_disabled", target: "x" }), false);
});

test("planBaseline: a pre-006 run (checks = null) covers units no newer run evaluated", () => {
  const runs = [
    { id: "new", checks: { probe: { evaluated: [{ kind: "table", target: "todos" }] }, policies: { evaluated: false } } },
    { id: "legacy", checks: null },
    { id: "older", checks: null },
  ];
  const plan = planBaseline(runs);
  assert.deepEqual(plan.runIds.sort(), ["legacy", "new"]);
  assert.equal(plan.includes({ run_id: "legacy", kind: "rls_disabled", target: "x" }), true);
  assert.equal(plan.includes({ run_id: "legacy", kind: "anon_open_table", target: "todos" }), false);
  assert.equal(plan.includes({ run_id: "older", kind: "rls_disabled", target: "x" }), false);
});

test("planBaseline: no ok runs → empty baseline", () => {
  assert.deepEqual(planBaseline([]).runIds, []);
});
