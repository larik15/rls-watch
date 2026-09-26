import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSupabaseUrl,
  isValidDatabaseUrl,
  databaseUrlToPgConfig,
  anonKeyProblem,
  twoAccountProblem,
} from "../../shared/validate.mjs";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${b64url(payload)}.sig`;

test("supabase_url: only https://<20 lowercase letters>.supabase.co", () => {
  assert.equal(isValidSupabaseUrl("https://abcdefghijklmnopqrst.supabase.co"), true);
  for (const bad of [
    "https://abcdefghijklmnopqrst.supabase.co/",
    "http://abcdefghijklmnopqrst.supabase.co",
    "https://abc.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co.evil.com",
    "https://evil.com/abcdefghijklmnopqrst.supabase.co",
    "https://ABCDEFGHIJKLMNOPQRST.supabase.co",
    "https://localhost:54321",
  ]) {
    assert.equal(isValidSupabaseUrl(bad), false, bad);
  }
});

test("database_url: pooler and direct Supabase hosts are accepted", () => {
  for (const good of [
    "postgresql://postgres.abcdefghijklmnopqrst:pa%24s@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
    "postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    "postgresql://postgres.x:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require",
  ]) {
    assert.equal(isValidDatabaseUrl(good), true, good);
  }
});

test("database_url: other hosts and connection-redirecting parameters are rejected", () => {
  for (const bad of [
    "postgresql://postgres:pw@evil.example.com:5432/postgres",
    "postgresql://postgres:pw@db.x.supabase.co.evil.com/postgres",
    "postgresql://postgres:pw@db.x.supabase.co/postgres?host=evil.example.com",
    "postgresql://postgres:pw@db.x.supabase.co/postgres?sslkey=/proc/self/environ",
    "postgresql://u:p@evil.example.com/x?a=@b.supabase.com",
    "postgresql://postgres:pw@169.254.169.254/postgres",
    "mysql://root:pw@db.x.supabase.co/x",
  ]) {
    assert.equal(isValidDatabaseUrl(bad), false, bad);
    assert.equal(databaseUrlToPgConfig(bad), null, bad);
  }
});

test("databaseUrlToPgConfig returns explicit fields, decoding the password", () => {
  const cfg = databaseUrlToPgConfig("postgresql://postgres.ref:K%24R%23x@aws-1-eu-west-1.pooler.supabase.com:5432/postgres");
  assert.deepEqual(cfg, {
    host: "aws-1-eu-west-1.pooler.supabase.com",
    port: 5432,
    user: "postgres.ref",
    password: "K$R#x",
    database: "postgres",
  });
});

test("databaseUrlToPgConfig takes the host after the last '@' in the userinfo, like the WHATWG parser", () => {
  const cfg = databaseUrlToPgConfig("postgresql://u:evil.com@db.abcdefghijklmnopqrst.supabase.co/postgres");
  assert.equal(cfg.host, "db.abcdefghijklmnopqrst.supabase.co");
  assert.equal(cfg.password, "evil.com");
});

test("anon key: publishable keys and anon JWTs pass; secret and service_role keys don't", () => {
  assert.equal(anonKeyProblem("sb_publishable_abc"), null);
  assert.equal(anonKeyProblem(jwt({ role: "anon" })), null);
  assert.match(anonKeyProblem("sb_secret_abc"), /secret key/);
  assert.match(anonKeyProblem(jwt({ role: "service_role" })), /service_role/);
  assert.match(anonKeyProblem(jwt({ role: "authenticated" })), /isn't an anon key/);
  assert.match(anonKeyProblem("hunter2"), /Expected/);
});

test("two_account config: plain identifiers, known keys, object sample rows", () => {
  assert.equal(twoAccountProblem([]), null);
  assert.equal(twoAccountProblem([{ name: "todos", ownerColumn: "user_id", idColumn: "id", sampleRow: { title: "t" } }]), null);
  assert.match(twoAccountProblem([{ name: "todos", idColumn: "id=not.is.null&x" }]), /not a plain column name/);
  assert.match(twoAccountProblem([{ name: "public.todos" }]), /not a plain table name/);
  assert.match(twoAccountProblem([{ name: "todos", extra: 1 }]), /Unknown two-account field/);
  assert.match(twoAccountProblem([{ name: "todos", sampleRow: [1] }]), /must be a JSON object/);
  assert.match(twoAccountProblem(Array.from({ length: 21 }, () => ({ name: "t" }))), /At most 20/);
});
