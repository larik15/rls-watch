import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../pool.mjs";

test("mapLimit runs every item and preserves result order", async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await mapLimit(items, 2, async (n) => n * 10);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("mapLimit never runs more than `limit` at once", async () => {
  let running = 0;
  let maxRunning = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 3, async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  });
  assert.ok(maxRunning <= 3, `expected at most 3 concurrent, saw ${maxRunning}`);
});
