// Severity order shared between the worker (deciding whether to alert) and the web
// dashboard (sorting/counting findings). Keep in sync with supabase-security-mcp's
// own ORDER in its src/report.mjs.

export const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function sortBySeverity(items, severityOf = (x) => x.severity) {
  return [...items].sort(
    (a, b) => (SEVERITY_ORDER[severityOf(a)] ?? 9) - (SEVERITY_ORDER[severityOf(b)] ?? 9)
  );
}

/** True if any finding is critical or high severity. */
export function hasCriticalOrHigh(findings) {
  return findings.some((f) => f.severity === "critical" || f.severity === "high");
}
