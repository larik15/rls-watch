// Compare this run's findings against the baseline (see planBaseline in checks.mjs).

import { findingUnit } from "./checks.mjs";

/**
 * @param {Array<{fingerprint:string, kind?:string, target?:string}>} baseline
 * @param {Array<{fingerprint:string}>} currentFindings  this run's findings (fingerprinted)
 * @param {Set<string>|null} [evaluated]  units this run evaluated (evaluatedUnits); null = all
 * @returns {{ new: object[], resolved: object[], notEvaluated: object[], unchanged: object[] }}
 *   A baseline finding that's absent now is `resolved` only if its check ran this time;
 *   otherwise it's `notEvaluated` — we don't know.
 */
export function diffFindings(baseline, currentFindings, evaluated = null) {
  const prev = new Set(baseline.map((f) => f.fingerprint));
  const curr = new Set(currentFindings.map((f) => f.fingerprint));

  const newFindings = currentFindings.filter((f) => !prev.has(f.fingerprint));
  const unchanged = currentFindings.filter((f) => prev.has(f.fingerprint));
  const gone = baseline.filter((f) => !curr.has(f.fingerprint));
  const resolved = evaluated ? gone.filter((f) => evaluated.has(findingUnit(f))) : gone;
  const notEvaluated = evaluated ? gone.filter((f) => !evaluated.has(findingUnit(f))) : [];

  return { new: newFindings, resolved, notEvaluated, unchanged };
}

/**
 * True if this run should alert: new critical/high findings, or a probe target that
 * was closed before is now open (anon_open_table/bucket/rpc findings only exist while
 * the target is open, so one appearing as `new` means it just opened up — including
 * the anon_open_rpc case, which is "medium" but still worth a message).
 */
export function shouldAlert(diffResult) {
  return diffResult.new.some(
    (f) => f.severity === "critical" || f.severity === "high" || f.kind?.startsWith("anon_open_")
  );
}
