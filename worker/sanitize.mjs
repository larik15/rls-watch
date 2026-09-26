// runs.error, run_requests.error and alerts.error are readable by every agency member.
// pg / PostgREST / fetch errors can carry connection strings, hosts, role names, keys
// and SQL; those stay in the worker's logs only.

const MAX_LENGTH = 300;

const RULES = [
  [/\bpostgres(?:ql)?:\/\/\S+/gi, "[connection string]"],
  [/\bhttps?:\/\/\S+/gi, "[url]"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[key]"],
  [/\bsb_(?:secret|publishable)_[\w-]+/g, "[key]"],
  [/\bbot\d+:[\w-]+/g, "bot[token]"],
  [/\b(user|role|database|schema|relation|table|column|function)\s+"[^"]*"/gi, '$1 "[redacted]"'],
  [/\bpostgres\.[a-z0-9]+\b/gi, "[user]"],
  [/\[[0-9a-f:]+\](?::\d+)?/gi, "[ip]"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[ip]"],
  [/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?\b/gi, "[host]"],
  [
    /\b(?:select\b[\s\S]*\bfrom|insert\s+into|update\s+\S+\s+set|delete\s+from|with\s+\w+\s+as|(?:create|alter|drop)\s+(?:table|function|policy|index|view|role))\b[\s\S]*$/i,
    "[sql]",
  ],
];

/** A short, member-safe version of an error message. Log the raw error separately. */
export function sanitizeError(err) {
  let s = String(err?.message ?? err ?? "unknown error").split("\n")[0];
  for (const [re, replacement] of RULES) s = s.replace(re, replacement);
  s = s.trim() || "unknown error";
  return s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH - 1)}…` : s;
}
