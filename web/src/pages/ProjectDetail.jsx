import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { getProject, deleteProject } from "../lib/projects.js";
import { listRuns, listFindings, getLatestAlert } from "../lib/runs.js";
import { getMyRole } from "../lib/members.js";
import { StatusDot, UndeliveredAlertBanner, relativeTime, runState } from "../components/StatusBadges.jsx";
import { sortBySeverity } from "../../../shared/severity.mjs";
import { diffFindings } from "../../../shared/diff.mjs";
import { targetsEvaluated } from "../../../shared/checks.mjs";

function FindingsList({ findings, emptyText }) {
  if (!findings.length) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="findings" style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {sortBySeverity(findings).map((f) => (
        <li key={f.id ?? f.fingerprint} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <span className={`finding-severity ${f.severity}`}>{f.severity}</span>
          {f.message}
          {f.fix && (
            <div className="muted" style={{ marginTop: 2 }}>
              fix: {f.fix}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What a run did and didn't evaluate (runs.checks). Pre-006 runs have no checks. */
function Coverage({ checks }) {
  if (!checks) return null;
  const probe = checks.probe ?? {};
  const rows = [];

  const probed = probe.evaluated?.length ?? 0;
  const skipped = probe.not_evaluated ?? [];
  rows.push([
    "Anon probe",
    `${probed} target(s) evaluated${probe.tables_source === "discovered" ? " (tables auto-discovered)" : ""}` +
      (skipped.length ? `; not evaluated: ${skipped.map((t) => `${t.target} (${t.reason})`).join(", ")}` : "") +
      (probe.rpc_skipped ? `; ${probe.rpc_skipped} RPC function(s) not called — not confirmed by the owner` : ""),
  ]);
  rows.push([
    "Policy audit",
    checks.policies?.evaluated ? `ran — ${checks.policies.tables} table(s) in public` : `not run — ${checks.policies?.reason}`,
  ]);
  const ta = checks.two_account ?? {};
  rows.push([
    "Two-account test",
    ta.reason
      ? `not run — ${ta.reason}`
      : `${ta.evaluated?.length ?? 0} table(s) tested` +
        (ta.not_evaluated?.length ? `; not evaluated: ${ta.not_evaluated.map((t) => `${t.table} (${t.reason})`).join(", ")}` : ""),
  ]);
  rows.push([
    "Test-data cleanup",
    checks.artifacts?.evaluated
      ? checks.artifacts.pending
        ? `${checks.artifacts.pending} leftover(s) — see findings`
        : "nothing left over"
      : `not verified — ${checks.artifacts?.reason}`,
  ]);

  return (
    <div className="card" style={{ maxWidth: "none", marginBottom: 16, padding: "12px 16px" }}>
      <h3 style={{ marginTop: 0, fontSize: 14 }}>Coverage</h3>
      <table className="table" style={{ fontSize: 13 }}>
        <tbody>
          {rows.map(([label, text]) => (
            <tr key={label}>
              <td className="muted" style={{ width: 150, padding: "4px 8px 4px 0", borderBottom: "none" }}>
                {label}
              </td>
              <td style={{ padding: "4px 0", borderBottom: "none" }}>{text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [runs, setRuns] = useState(null);
  const [latestAlert, setLatestAlert] = useState(null);
  const [error, setError] = useState(null);
  const [isOwner, setIsOwner] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const [selectedRunId, setSelectedRunId] = useState(null);
  const [findings, setFindings] = useState(null);
  const [previousFindings, setPreviousFindings] = useState(null);
  const [copyStatus, setCopyStatus] = useState("idle"); // idle | copied

  useEffect(() => {
    getProject(id)
      .then((p) => {
        setProject(p);
        return getMyRole(p.agency_id, user.id);
      })
      .then((role) => setIsOwner(role === "owner"))
      .catch((e) => setError(e.message));
    listRuns(id)
      .then((list) => {
        setRuns(list);
        if (list.length) setSelectedRunId(list[0].id);
      })
      .catch((e) => setError(e.message));
    getLatestAlert(id)
      .then(setLatestAlert)
      .catch((e) => setError(e.message));
  }, [id, user.id]);

  async function handleDelete() {
    if (!window.confirm(`Delete "${project.name}"? This removes its run history and findings too. This can't be undone.`)) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(id);
      navigate("/");
    } catch (e) {
      setDeleteError(e.message);
      setDeleting(false);
    }
  }

  const selectedIndex = useMemo(() => runs?.findIndex((r) => r.id === selectedRunId) ?? -1, [runs, selectedRunId]);
  const selectedRun = selectedIndex >= 0 ? runs[selectedIndex] : null;
  // Only for runs recorded before the worker stored its own diff: the previous ok run.
  const previousOkRun = selectedIndex >= 0 ? (runs.slice(selectedIndex + 1).find((r) => r.status === "ok") ?? null) : null;

  useEffect(() => {
    if (!selectedRun) return;
    setFindings(null);
    setPreviousFindings(null);
    setCopyStatus("idle");
    if (selectedRun.status !== "ok") {
      setFindings([]);
      setPreviousFindings([]);
      return;
    }
    listFindings(selectedRun.id)
      .then(setFindings)
      .catch((e) => setError(e.message));
    if (selectedRun.diff || !previousOkRun) {
      setPreviousFindings([]);
    } else {
      listFindings(previousOkRun.id)
        .then(setPreviousFindings)
        .catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  const diff = useMemo(() => {
    if (!selectedRun || selectedRun.status !== "ok" || !findings) return null;
    if (selectedRun.diff) {
      const isNew = new Set(selectedRun.diff.new ?? []);
      return {
        new: findings.filter((f) => isNew.has(f.fingerprint)),
        resolved: selectedRun.diff.resolved ?? [],
        notEvaluated: selectedRun.diff.not_evaluated ?? [],
      };
    }
    if (previousFindings === null) return null;
    return diffFindings(previousFindings, findings);
  }, [selectedRun, findings, previousFindings]);

  async function handleCopyReport() {
    if (!selectedRun?.report_md) return;
    await navigator.clipboard.writeText(selectedRun.report_md);
    setCopyStatus("copied");
    setTimeout(() => setCopyStatus("idle"), 2000);
  }

  if (error) {
    return (
      <div className="page">
        <p className="notice notice-error">{error}</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  if (!project || !runs) return <div className="page">Loading…</div>;

  const nothingChecked = selectedRun?.status === "ok" && targetsEvaluated(selectedRun.checks) === 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{project.name}</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {project.supabase_url} {!project.enabled && <span className="badge">disabled</span>}
          </p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Tables:{" "}
            {project.tables.length > 0 ? (
              project.tables.join(", ")
            ) : project.has_database_url ? (
              <span className="badge">auto-discovered</span>
            ) : (
              "none configured"
            )}
          </p>
        </div>
        <div className="page-header-right">
          <Link to={`/projects/${id}/edit`}>Edit</Link>
          {isOwner && (
            <button className="btn-link" onClick={handleDelete} disabled={deleting} style={{ color: "var(--critical)" }}>
              {deleting ? "Deleting…" : "Delete project"}
            </button>
          )}
          <Link to="/">Back to dashboard</Link>
        </div>
      </header>

      {deleteError && <p className="notice notice-error">{deleteError}</p>}
      <UndeliveredAlertBanner alert={latestAlert} />

      {runs.length === 0 ? (
        <p className="muted">No runs yet. Use "Run now" from the project's setup, or wait for the next sweep.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24, alignItems: "start" }}>
          <div>
            <h2 style={{ fontSize: 14, color: "var(--text-muted)", textTransform: "uppercase" }}>Runs</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    className="btn-link"
                    onClick={() => setSelectedRunId(r.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 0",
                      color: r.id === selectedRunId ? "var(--text)" : "var(--text-muted)",
                      fontWeight: r.id === selectedRunId ? 600 : 400,
                    }}
                  >
                    <StatusDot run={r} withLabel />
                    <span className="mono" style={{ fontSize: 13 }}>
                      {relativeTime(r.started_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            {selectedRun && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div className="mono muted">
                    {new Date(selectedRun.started_at).toLocaleString()} — {runState(selectedRun).label ?? selectedRun.status}
                    {selectedRun.error && `: ${selectedRun.error}`}
                  </div>
                  {selectedRun.report_md && (
                    <button onClick={handleCopyReport}>{copyStatus === "copied" ? "Copied!" : "Copy client report (Markdown)"}</button>
                  )}
                </div>

                {nothingChecked && (
                  <p className="notice notice-warn">
                    <strong>Nothing checked.</strong> This run couldn't evaluate a single target, so "no findings" means
                    nothing here. See Coverage for why.
                  </p>
                )}

                <Coverage checks={selectedRun.checks} />

                {selectedRun.status !== "ok" ? (
                  <p className="muted">
                    This run didn't complete, so it has no findings or counts. The previous successful run's results still
                    stand.
                  </p>
                ) : (
                  <>
                    {diff && (diff.new.length > 0 || diff.resolved.length > 0 || diff.notEvaluated.length > 0) && (
                      <div className="card" style={{ maxWidth: "none", marginBottom: 16 }}>
                        <h3 style={{ marginTop: 0, fontSize: 14 }}>What changed</h3>
                        {diff.new.length > 0 && (
                          <>
                            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                              NEW ({diff.new.length})
                            </div>
                            <FindingsList findings={diff.new} emptyText="" />
                          </>
                        )}
                        {diff.resolved.length > 0 && (
                          <>
                            <div className="muted" style={{ fontSize: 12, margin: "12px 0 4px" }}>
                              RESOLVED ({diff.resolved.length})
                            </div>
                            <FindingsList findings={diff.resolved} emptyText="" />
                          </>
                        )}
                        {diff.notEvaluated.length > 0 && (
                          <>
                            <div className="muted" style={{ fontSize: 12, margin: "12px 0 4px" }}>
                              NOT EVALUATED THIS RUN ({diff.notEvaluated.length}) — last known open; the check didn't run
                            </div>
                            <FindingsList findings={diff.notEvaluated} emptyText="" />
                          </>
                        )}
                      </div>
                    )}

                    <h3 style={{ fontSize: 14 }}>Findings ({findings?.length ?? 0})</h3>
                    {findings === null ? (
                      <p className="muted">Loading…</p>
                    ) : (
                      <FindingsList
                        findings={findings}
                        emptyText={
                          nothingChecked ? "No findings — but nothing was checked." : "Nothing found by the checks that ran."
                        }
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
