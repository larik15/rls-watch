// What a run evaluated, at the granularity a finding can be "resolved" or "not evaluated".
//
// runs.checks (written by the worker):
//   probe:       { evaluated: [{kind, target}], not_evaluated: [{kind, target, reason}], rpc_skipped: n }
//   policies:    { evaluated: true, tables: n } | { evaluated: false, reason }
//   two_account: { evaluated: [table], not_evaluated: [{table, reason}], reason? }
//   artifacts:   { evaluated: true, pending: n } | { evaluated: false, reason }
// Runs from before migration 006 have checks = null.

/** The check unit a finding belongs to. Works on worker findings ({table|function}) and DB rows ({target}). */
export function findingUnit(f) {
  const kind = f.kind ?? "";
  const target = f.target ?? f.table ?? f.function ?? "";
  if (kind.startsWith("anon_open_")) return `probe:${kind.slice("anon_open_".length)}:${target}`;
  if (kind.startsWith("cross_tenant_")) return `two_account:${target}`;
  if (kind === "test_artifacts_left") return "artifacts";
  return "policies";
}

/** Set of units a run evaluated. */
export function evaluatedUnits(checks) {
  const units = new Set();
  if (!checks) return units;
  for (const t of checks.probe?.evaluated ?? []) units.add(`probe:${t.kind}:${t.target}`);
  if (checks.policies?.evaluated) units.add("policies");
  for (const table of checks.two_account?.evaluated ?? []) units.add(`two_account:${table}`);
  if (checks.artifacts?.evaluated) units.add("artifacts");
  return units;
}

/** How many targets a run actually looked at, or null for pre-006 runs (unknown). */
export function targetsEvaluated(checks) {
  if (!checks) return null;
  return (
    (checks.probe?.evaluated?.length ?? 0) +
    (checks.policies?.evaluated ? (checks.policies.tables ?? 0) : 0) +
    (checks.two_account?.evaluated?.length ?? 0)
  );
}

/**
 * Which earlier findings to diff against. For each unit, the baseline is the latest ok
 * run that evaluated it — not simply the latest run, which may have skipped that check.
 * A pre-006 run (checks = null) stands in for every unit no newer run evaluated.
 *
 * @param {Array<{id:string, checks:object|null}>} runs  ok runs, newest first
 * @returns {{ runIds: string[], includes: (finding: {run_id:string}) => boolean }}
 */
export function planBaseline(runs) {
  const unitRun = new Map();
  const used = new Set();
  let legacyRunId = null;

  for (const run of runs) {
    if (!run.checks) {
      legacyRunId = run.id;
      used.add(run.id);
      break;
    }
    for (const unit of evaluatedUnits(run.checks)) {
      if (!unitRun.has(unit)) {
        unitRun.set(unit, run.id);
        used.add(run.id);
      }
    }
  }

  return {
    runIds: [...used],
    includes: (f) => {
      const runId = unitRun.get(findingUnit(f));
      return runId ? runId === f.run_id : f.run_id === legacyRunId;
    },
  };
}
