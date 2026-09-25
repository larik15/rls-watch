import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit, withTimeout } from "../pool.mjs";

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

test("withTimeout resolves normally when the promise finishes first", async () => {
  const result = await withTimeout(Promise.resolve("done"), 100, "test op");
  assert.equal(result, "done");
});

test("withTimeout rejects when the promise takes too long", async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(() => withTimeout(slow, 5, "slow op"), /slow op timed out after 5ms/);
});
