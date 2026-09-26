// When a project gives a database_url but no explicit `tables` list, we already have
// everything we need to guess one: auditPolicies() (supabase-security-mcp) reads
// pg_class for every relation in `public` with relkind in ('r', 'p') — ordinary and
// partitioned tables. Reuse that instead of a second connection.

/** @param {{tables: Array<{schema:string, table:string}>}|null} policies */
export function discoverTableNames(policies) {
  if (!policies) return [];
  return policies.tables.filter((t) => t.schema === "public").map((t) => t.table);
}
