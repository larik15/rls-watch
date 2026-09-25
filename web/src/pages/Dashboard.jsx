import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { useCurrentAgency } from "../hooks/useCurrentAgency.js";
import { createAgency } from "../lib/agencies.js";
import { listProjects, listRecentRunsByProject, severeCount, trend } from "../lib/projects.js";
import { StatusDot, TrendArrow, relativeTime } from "../components/StatusBadges.jsx";

export function Dashboard() {
  const { user, signOut } = useAuth();
  const { agencies, agencyId, selectAgency, addAgency, loading: loadingAgencies, error: agencyError } = useCurrentAgency();
  const [projects, setProjects] = useState(null);
  const [runsByProject, setRunsByProject] = useState(new Map());
  const [error, setError] = useState(null);
  const [newAgencyName, setNewAgencyName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (agencyError) setError(agencyError);
  }, [agencyError]);

  useEffect(() => {
    if (!agencyId) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    setProjects(null);
    listProjects(agencyId)
      .then(async (list) => {
        if (cancelled) return;
        setProjects(list);
        const runs = await listRecentRunsByProject(list.map((p) => p.id));
        if (!cancelled) setRunsByProject(runs);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [agencyId]);

  async function handleCreateAgency(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const agency = await createAgency(newAgencyName.trim(), user.id);
      addAgency(agency);
      setNewAgencyName("");
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>RLS Watch</h1>
        <div className="page-header-right">
          {agencies && agencies.length > 1 && (
            <select value={agencyId ?? ""} onChange={(e) => selectAgency(e.target.value)}>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <Link to="/settings">Settings</Link>
          <span className="muted">{user.email}</span>
          <button className="btn-link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {error && <p className="notice notice-error">{error}</p>}

      {loadingAgencies ? (
        <p className="muted">Loading…</p>
      ) : agencies.length === 0 ? (
        <div className="card">
          <h2>Create your agency</h2>
          <p className="muted">You need an agency before you can add projects to watch.</p>
          <form onSubmit={handleCreateAgency}>
            <input
              value={newAgencyName}
              onChange={(e) => setNewAgencyName(e.target.value)}
              placeholder="Agency name"
              required
            />
            <button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create agency"}
            </button>
          </form>
        </div>
      ) : (
        <>
          <div className="page-toolbar">
            <Link className="btn" to="/projects/new">
              Add project
            </Link>
          </div>

          {projects === null ? (
            <p className="muted">Loading projects…</p>
          ) : projects.length === 0 ? (
            <p className="muted">No projects yet. Add one to start watching it.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Last run</th>
                  <th>Status</th>
                  <th>Critical / high</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const runs = runsByProject.get(p.id) ?? { latest: null, previous: null };
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/projects/${p.id}`}>{p.name}</Link>
                        {!p.enabled && <span className="badge">disabled</span>}
                      </td>
                      <td className="mono">{relativeTime(runs.latest?.started_at)}</td>
                      <td>
                        <StatusDot run={runs.latest} />
                      </td>
                      <td className="mono">{severeCount(runs.latest?.counts)}</td>
                      <td>
                        <TrendArrow direction={trend(runs.latest, runs.previous)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
