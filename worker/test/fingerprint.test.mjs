import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, withFingerprints } from "../../shared/fingerprint.mjs";

test("same kind/table/policy always produces the same fingerprint", () => {
  const a = { kind: "policy_open_read", table: "todos", policy: "read all" };
  const b = { kind: "policy_open_read", table: "todos", policy: "read all", message: "different wording" };
  assert.equal(fingerprint(a), fingerprint(b));
});

test("changing kind, table, or policy changes the fingerprint", () => {
  const base = { kind: "policy_open_read", table: "todos", policy: "read all" };
  assert.notEqual(fingerprint(base), fingerprint({ ...base, kind: "policy_open_write" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, table: "notes" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, policy: "read own" }));
});

test("falls back to `function` when there's no table", () => {
  const f = { kind: "definer_function_exposed", function: "do_thing(uuid)" };
  assert.equal(fingerprint(f), fingerprint({ ...f }));
  assert.notEqual(fingerprint(f), fingerprint({ ...f, function: "other_thing(uuid)" }));
});

test("withFingerprints adds a fingerprint to every finding without mutating the input", () => {
  const findings = [{ kind: "rls_disabled", table: "todos" }];
  const out = withFingerprints(findings);
  assert.equal(out.length, 1);
  assert.equal(typeof out[0].fingerprint, "string");
  assert.equal(findings[0].fingerprint, undefined);
});
