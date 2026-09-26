import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeError } from "../sanitize.mjs";

test("strips connection strings, URLs and keys", () => {
  const s = sanitizeError(
    new Error(
      "connect failed postgresql://postgres.abc:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres via https://abc.supabase.co/rest/v1/x key sb_secret_AbC123 eyJhbGciOi.eyJyb2xlIjoi.sig"
    )
  );
  assert.doesNotMatch(s, /secret@|pooler|abc\.supabase|sb_secret_|eyJ/);
  assert.match(s, /\[connection string\]/);
  assert.match(s, /\[url\]/);
  assert.match(s, /\[key\]/);
});

test("strips hosts, IPs and pooler user names", () => {
  const s = sanitizeError('getaddrinfo ENOTFOUND db.abcdefghijklmnopqrst.supabase.co; connect ECONNREFUSED 10.0.0.5:5432; password authentication failed for user "postgres.abcdefghijklmnopqrst"');
  assert.doesNotMatch(s, /abcdefghijklmnopqrst|10\.0\.0\.5/);
  assert.match(s, /\[host\]/);
  assert.match(s, /\[ip\]/);
  assert.match(s, /user "\[redacted\]"/);
});

test("drops SQL and multi-line detail from pg / PostgREST errors", () => {
  const s = sanitizeError(new Error('syntax error at or near "fromm" in select id, secret from private.stuff where x = 1\nLINE 1: select id...\nDETAIL: ...'));
  assert.doesNotMatch(s, /private\.stuff|LINE 1|DETAIL/);
  assert.match(s, /\[sql\]/);
});

test("keeps the useful part of ordinary messages and caps the length", () => {
  assert.equal(sanitizeError(new Error("run did not finish within 60s")), "run did not finish within 60s");
  assert.equal(sanitizeError(new Error('column reference "project_id" is ambiguous')), 'column reference "project_id" is ambiguous');
  assert.ok(sanitizeError(new Error("x".repeat(1000))).length <= 300);
  assert.equal(sanitizeError(null), "unknown error");
});

test("telegram bot tokens never survive", () => {
  assert.doesNotMatch(sanitizeError("fetch failed for bot8850675678:AAGTpkoq-xyz/sendMessage"), /AAGTpkoq/);
});
