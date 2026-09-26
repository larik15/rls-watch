import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlertMessage, sendTelegramMessage } from "../telegram.mjs";

test("formatAlertMessage includes project name, counts, findings, and the project link", () => {
  const project = { name: "Acme <Client>" };
  const counts = { critical: 1, high: 2, medium: 0, info: 3 };
  const findings = [
    { severity: "critical", message: "RLS is disabled on public.todos" },
    { severity: "high", message: "Policy \"open\" allows update with using (true)" },
  ];
  const text = formatAlertMessage(project, counts, findings, "https://watch.example.com", "proj-123");

  assert.match(text, /Acme &lt;Client&gt;/); // escaped, not raw HTML
  assert.match(text, /critical 1 · high 2 · medium 0 · info 3/);
  assert.match(text, /RLS is disabled on public\.todos/);
  assert.match(text, /using \(true\)/);
  assert.match(text, /https:\/\/watch\.example\.com\/projects\/proj-123/);
});

test("formatAlertMessage caps the finding list at 10 and notes the remainder", () => {
  const findings = Array.from({ length: 13 }, (_, i) => ({ severity: "high", message: `finding ${i}` }));
  const text = formatAlertMessage({ name: "Big" }, { critical: 0, high: 13, medium: 0, info: 0 }, findings, "https://x", "p1");

  assert.match(text, /finding 9/); // 10th shown (0-indexed)
  assert.doesNotMatch(text, /finding 10\b/);
  assert.match(text, /…and 3 more, see dashboard/);
});

test("formatAlertMessage stays within 3800 chars however long the findings and name are", () => {
  const long = "<".repeat(5000); // escapes to &lt; — 4x longer
  const findings = Array.from({ length: 50 }, () => ({ severity: "critical", message: long }));
  const text = formatAlertMessage({ name: long }, { critical: 50, high: 0, medium: 0, info: 0 }, findings, "https://watch.example.com", "p1");

  assert.ok(text.length <= 3800, `message is ${text.length} chars`);
  assert.match(text, /…and \d+ more, see dashboard/);
  assert.ok(text.endsWith("https://watch.example.com/projects/p1"), "the dashboard link survives truncation");
  assert.doesNotMatch(text, /<</, "HTML stays escaped");
});

test("sendTelegramMessage posts to the bot API and resolves on ok:true", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };

  const result = await sendTelegramMessage("BOTTOKEN", "12345", "hello", fakeFetch);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botBOTTOKEN/sendMessage");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.chat_id, "12345");
  assert.equal(body.text, "hello");
  assert.equal(result.ok, true);
});

test("sendTelegramMessage throws with the API's error body when the request fails", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, description: "chat not found" }),
  });

  await assert.rejects(
    () => sendTelegramMessage("BOTTOKEN", "bad-chat", "hello", fakeFetch),
    /chat not found/
  );
});
