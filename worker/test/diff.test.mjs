import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFindings, shouldAlert } from "../../shared/diff.mjs";

test("first run: everything is new, nothing resolved", () => {
  const current = [{ fingerprint: "a", severity: "high" }, { fingerprint: "b", severity: "info" }];
  const diff = diffFindings([], current);
  assert.deepEqual(diff.new, current);
  assert.deepEqual(diff.resolved, []);
  assert.deepEqual(diff.unchanged, []);
});

test("unchanged findings stay unchanged, gone ones are resolved, fresh ones are new", () => {
  const previous = ["a", "b", "c"];
  const current = [
    { fingerprint: "b", severity: "medium" }, // still there
    { fingerprint: "d", severity: "critical" }, // new
  ];
  const diff = diffFindings(previous, current);
  assert.deepEqual(diff.new.map((f) => f.fingerprint), ["d"]);
  assert.deepEqual(diff.unchanged.map((f) => f.fingerprint), ["b"]);
  assert.deepEqual(diff.resolved.sort(), ["a", "c"]);
});

test("shouldAlert is true when a new finding is critical or high", () => {
  assert.equal(shouldAlert({ new: [{ severity: "info" }, { severity: "high" }], resolved: [], unchanged: [] }), true);
  assert.equal(shouldAlert({ new: [{ severity: "critical" }], resolved: [], unchanged: [] }), true);
});

test("shouldAlert is false when new findings are only medium/info and not probe opens", () => {
  assert.equal(shouldAlert({ new: [{ severity: "medium", kind: "policy_no_to_clause" }], resolved: [], unchanged: [] }), false);
  assert.equal(shouldAlert({ new: [], resolved: ["a"], unchanged: [] }), false);
});

test("shouldAlert is true when a previously closed probe target opens (anon_open_*), even at medium severity", () => {
  assert.equal(
    shouldAlert({ new: [{ severity: "medium", kind: "anon_open_rpc" }], resolved: [], unchanged: [] }),
    true
  );
});
