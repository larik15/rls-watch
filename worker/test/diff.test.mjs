import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFindings, shouldAlert } from "../../shared/diff.mjs";

const f = (fingerprint, kind, target, severity = "high") => ({ fingerprint, kind, target, severity });

test("first run: everything is new, nothing resolved", () => {
  const current = [f("a", "rls_disabled", "t"), f("b", "anon_open_table", "t")];
  const diff = diffFindings([], current, new Set(["policies", "probe:table:t"]));
  assert.deepEqual(diff.new, current);
  assert.deepEqual(diff.resolved, []);
  assert.deepEqual(diff.notEvaluated, []);
  assert.deepEqual(diff.unchanged, []);
});

test("unchanged stay unchanged, fresh ones are new, gone ones are resolved when their check ran", () => {
  const baseline = [f("a", "rls_disabled", "x"), f("b", "rls_disabled", "y"), f("c", "anon_open_table", "z")];
  const current = [f("b", "rls_disabled", "y"), f("d", "policy_open_write", "w", "critical")];
  const diff = diffFindings(baseline, current, new Set(["policies", "probe:table:z"]));
  assert.deepEqual(diff.new.map((x) => x.fingerprint), ["d"]);
  assert.deepEqual(diff.unchanged.map((x) => x.fingerprint), ["b"]);
  assert.deepEqual(diff.resolved.map((x) => x.fingerprint).sort(), ["a", "c"]);
  assert.deepEqual(diff.notEvaluated, []);
});

test("a finding whose check didn't run is 'not evaluated', not 'resolved'", () => {
  const baseline = [
    f("pol", "policy_open_read", "todos"), // policy audit — no database URL this run
    f("probe", "anon_open_table", "notes"), // probe of notes failed this run
    f("xt", "cross_tenant_read", "todos"), // two-account test disabled this run
    f("gone", "anon_open_table", "todos"), // todos was probed and is closed now
  ];
  const diff = diffFindings(baseline, [], new Set(["probe:table:todos"]));
  assert.deepEqual(diff.resolved.map((x) => x.fingerprint), ["gone"]);
  assert.deepEqual(diff.notEvaluated.map((x) => x.fingerprint).sort(), ["pol", "probe", "xt"]);
});

test("without an evaluated set, everything gone counts as resolved (legacy display)", () => {
  const diff = diffFindings([f("a", "rls_disabled", "t")], []);
  assert.deepEqual(diff.resolved.map((x) => x.fingerprint), ["a"]);
  assert.deepEqual(diff.notEvaluated, []);
});

test("shouldAlert is true when a new finding is critical or high", () => {
  assert.equal(shouldAlert({ new: [{ severity: "info" }, { severity: "high" }] }), true);
  assert.equal(shouldAlert({ new: [{ severity: "critical" }] }), true);
});

test("shouldAlert is false when new findings are only medium/info and not probe opens", () => {
  assert.equal(shouldAlert({ new: [{ severity: "medium", kind: "policy_no_to_clause" }] }), false);
  assert.equal(shouldAlert({ new: [] }), false);
});

test("shouldAlert is true when a previously closed probe target opens (anon_open_*), even at medium severity", () => {
  assert.equal(shouldAlert({ new: [{ severity: "medium", kind: "anon_open_rpc" }] }), true);
});
