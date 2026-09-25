// Stable identity for a finding, so the worker can diff one run against the next
// (new / resolved / unchanged) without relying on row order or wording changes.
//
// Built from kind + target (table or function name) + policy name, when present —
// deliberately NOT from `message`, since message text can include incidental detail
// (e.g. a column list) that shouldn't make an unchanged finding look "new".

import { createHash } from "node:crypto";

/** @param {{kind:string, table?:string|null, function?:string|null, policy?:string|null}} finding */
export function fingerprint(finding) {
  const target = finding.table ?? finding.function ?? "";
  const policy = finding.policy ?? "";
  const raw = `${finding.kind}|${target}|${policy}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/** Adds a `fingerprint` field to each finding, returning new objects. */
export function withFingerprints(findings) {
  return findings.map((f) => ({ ...f, fingerprint: fingerprint(f) }));
}
