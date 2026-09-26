import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSafeFetch } from "../safeFetch.mjs";

test("never follows redirects and always carries an abort signal", async () => {
  let seen;
  const safe = makeSafeFetch({ fetchImpl: async (url, init) => ((seen = init), { status: 200 }) });
  await safe("https://abcdefghijklmnopqrst.supabase.co/rest/v1/x", { redirect: "follow", headers: { a: "b" } });
  assert.equal(seen.redirect, "manual");
  assert.equal(seen.headers.a, "b");
  assert.ok(seen.signal instanceof AbortSignal);
});

test("a request that hangs past the per-request timeout is aborted", async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const safe = makeSafeFetch({ fetchImpl: hang, timeoutMs: 20 });
  await assert.rejects(() => safe("https://x"), { name: "TimeoutError" });
});

test("the run's deadline signal aborts requests made through it", async () => {
  const controller = new AbortController();
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const safe = makeSafeFetch({ fetchImpl: hang, signal: controller.signal, timeoutMs: 10_000 });
  const pending = safe("https://x");
  controller.abort(new Error("deadline"));
  await assert.rejects(pending, /deadline/);
});
