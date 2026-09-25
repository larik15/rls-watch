// Compare this run's finding fingerprints against the previous run's.

/**
 * @param {string[]} previousFingerprints  fingerprints from the previous run (may be empty)
 * @param {Array<{fingerprint:string}>} currentFindings  this run's findings (already fingerprinted)
 * @returns {{ new: object[], resolved: string[], unchanged: object[] }}
 */
export function diffFindings(previousFingerprints, currentFindings) {
  const prevSet = new Set(previousFingerprints);
  const currSet = new Set(currentFindings.map((f) => f.fingerprint));

  const newFindings = currentFindings.filter((f) => !prevSet.has(f.fingerprint));
  const unchanged = currentFindings.filter((f) => prevSet.has(f.fingerprint));
  const resolved = [...prevSet].filter((fp) => !currSet.has(fp));

  return { new: newFindings, resolved, unchanged };
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
