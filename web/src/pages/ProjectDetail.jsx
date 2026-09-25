import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { getProject, deleteProject } from "../lib/projects.js";
import { listRuns, listFindings } from "../lib/runs.js";
import { getMyRole } from "../lib/members.js";
import { StatusDot, relativeTime } from "../components/StatusBadges.jsx";
import { sortBySeverity } from "../../../shared/severity.mjs";
import { diffFindings } from "../../../shared/diff.mjs";

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

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [runs, setRuns] = useState(null);
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
  const previousRun = selectedIndex >= 0 ? (runs[selectedIndex + 1] ?? null) : null;

  useEffect(() => {
    if (!selectedRunId) return;
    setFindings(null);
    setPreviousFindings(null);
    setCopyStatus("idle");
    listFindings(selectedRunId)
      .then(setFindings)
      .catch((e) => setError(e.message));
    if (previousRun) {
      listFindings(previousRun.id)
        .then(setPreviousFindings)
        .catch((e) => setError(e.message));
    } else {
      setPreviousFindings([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  const diff = useMemo(() => {
    if (!findings || previousFindings === null) return null;
    const result = diffFindings(
      previousFindings.map((f) => f.fingerprint),
      findings
    );
    const resolved = result.resolved
      .map((fp) => previousFindings.find((f) => f.fingerprint === fp))
      .filter(Boolean);
    return { new: result.new, resolved, unchanged: result.unchanged };
  }, [findings, previousFindings]);

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

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{project.name}</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {project.supabase_url} {!project.enabled && <span className="badge">disabled</span>}
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
                    <StatusDot run={r} />
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
                    {new Date(selectedRun.started_at).toLocaleString()} —{" "}
                    {selectedRun.status === "error" ? `error: ${selectedRun.error}` : "ok"}
                  </div>
                  {selectedRun.report_md && (
                    <button onClick={handleCopyReport}>{copyStatus === "copied" ? "Copied!" : "Copy client report (Markdown)"}</button>
                  )}
                </div>

                {diff && (diff.new.length > 0 || diff.resolved.length > 0) && (
                  <div className="card" style={{ marginBottom: 16 }}>
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
                  </div>
                )}
                {previousFindings !== null && previousFindings.length === 0 && selectedIndex === runs.length - 1 && (
                  <p className="muted" style={{ fontSize: 13 }}>
                    First run — nothing to compare against yet.
                  </p>
                )}

                <h3 style={{ fontSize: 14 }}>Findings ({findings?.length ?? 0})</h3>
                {findings === null ? (
                  <p className="muted">Loading…</p>
                ) : (
                  <FindingsList findings={findings} emptyText="Nothing found by these checks in this run." />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
