import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverTableNames } from "../discoverTables.mjs";

test("returns [] when there's no policies result (no database_url given)", () => {
  assert.deepEqual(discoverTableNames(null), []);
});

test("returns public-schema table names, ignoring other schemas", () => {
  const policies = {
    tables: [
      { schema: "public", table: "todos", rls_enabled: true },
      { schema: "public", table: "profiles", rls_enabled: true },
      { schema: "private", table: "project_secrets", rls_enabled: true },
    ],
  };
  assert.deepEqual(discoverTableNames(policies), ["todos", "profiles"]);
});

test("returns [] when public has no tables", () => {
  assert.deepEqual(discoverTableNames({ tables: [] }), []);
});
