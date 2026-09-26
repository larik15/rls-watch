// Input rules shared by the web form (UX), the worker (the actual network sink) and
// db/006 (the authority). Keep the regexes in step with private.is_valid_* there.

export const SUPABASE_URL_RE = /^https:\/\/[a-z]{20}\.supabase\.co$/;

// Pooler (*.pooler.supabase.com) or direct (db.<ref>.supabase.co). Userinfo may not
// contain / ? # (URL-encode the password). The only query parameter allowed is sslmode:
// node-postgres honours ?host=, ?port=, ?sslcert=… over the host in the URL.
const DATABASE_URL_RE =
  /^postgres(ql)?:\/\/([^/?#]*@)?[a-z0-9.-]+\.supabase\.(com|co)(:[0-9]{1,5})?(\/[^?#]*)?(\?sslmode=[a-z-]+)?$/i;
const SUPABASE_HOST_RE = /^[a-z0-9.-]+\.supabase\.(com|co)$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const TWO_ACCOUNT_KEYS = new Set(["name", "ownerColumn", "idColumn", "sampleRow"]);

export function isValidSupabaseUrl(url) {
  return typeof url === "string" && SUPABASE_URL_RE.test(url);
}

export function isValidDatabaseUrl(url) {
  return typeof url === "string" && DATABASE_URL_RE.test(url);
}

/**
 * pg connection fields taken from the URL we validated, so nothing in it can redirect
 * the connection. null if the URL isn't acceptable.
 */
export function databaseUrlToPgConfig(url) {
  if (!isValidDatabaseUrl(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!SUPABASE_HOST_RE.test(host)) return null;
  try {
    return {
      host,
      port: u.port ? Number(u.port) : 5432,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)) || "postgres",
    };
  } catch {
    return null;
  }
}

function jwtRole(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded)).role ?? null;
  } catch {
    return null;
  }
}

/** Why this can't be stored as a project's anon key, or null if it's fine. */
export function anonKeyProblem(key) {
  if (typeof key !== "string" || !key) return "The anon key is required.";
  if (key.startsWith("sb_publishable_")) return null;
  if (key.startsWith("sb_secret_")) return "That's a secret key (sb_secret_…). Paste the publishable key (sb_publishable_…) here.";
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(key)) {
    const role = jwtRole(key);
    if (role === "anon") return null;
    if (role === "service_role") return "That's the service_role key. Paste the anon key here.";
    return "That JWT isn't an anon key.";
  }
  return "Expected an sb_publishable_… key or the legacy anon JWT (eyJ…).";
}

/** Why a two_account config is invalid, or null. Mirrors private.is_valid_two_account. */
export function twoAccountProblem(list) {
  if (!Array.isArray(list)) return "Two-account config must be a list.";
  if (list.length > 20) return "At most 20 two-account tables.";
  for (const t of list) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return "Each two-account table must be an object.";
    for (const k of Object.keys(t)) {
      if (!TWO_ACCOUNT_KEYS.has(k)) return `Unknown two-account field "${k}".`;
    }
    if (typeof t.name !== "string" || !IDENT_RE.test(t.name)) return `"${t.name}" is not a plain table name.`;
    for (const col of ["ownerColumn", "idColumn"]) {
      if (col in t && (typeof t[col] !== "string" || !IDENT_RE.test(t[col]))) {
        return `${col} "${t[col]}" on ${t.name} is not a plain column name.`;
      }
    }
    if ("sampleRow" in t && (!t.sampleRow || typeof t.sampleRow !== "object" || Array.isArray(t.sampleRow))) {
      return `Sample row for ${t.name} must be a JSON object.`;
    }
  }
  return null;
}
