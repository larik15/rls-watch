import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { useCurrentAgency } from "../hooks/useCurrentAgency.js";
import { createProject } from "../lib/projects.js";
import { upsertProjectSecrets } from "../lib/secrets.js";
import { requestRun } from "../lib/runRequests.js";
import { getMyRole } from "../lib/members.js";
import { ProjectForm } from "../components/ProjectForm.jsx";

export function ProjectNew() {
  const { user } = useAuth();
  const { agencyId, loading: loadingAgency } = useCurrentAgency();
  const [role, setRole] = useState(undefined);

  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // the new project row, once saved
  const [runQueued, setRunQueued] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    if (!agencyId) return;
    getMyRole(agencyId, user.id)
      .then(setRole)
      .catch((e) => setError(e.message));
  }, [agencyId, user.id]);

  async function handleCreate({ serviceRoleKey, databaseUrl, ...fields }) {
    const project = await createProject(agencyId, fields);
    if (serviceRoleKey || databaseUrl) {
      await upsertProjectSecrets(project.id, {
        serviceRoleKey: serviceRoleKey || null,
        databaseUrl: databaseUrl || null,
      });
    }
    setCreated(project);
  }

  async function handleRunNow() {
    setQueueing(true);
    setError(null);
    try {
      await requestRun(agencyId, created.id);
      setRunQueued(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setQueueing(false);
    }
  }

  if (loadingAgency || (agencyId && role === undefined && !error)) return <div className="page">Loading…</div>;
  if (!agencyId) {
    return (
      <div className="page">
        <p className="muted">
          You need an agency first. Go to the <Link to="/">dashboard</Link> and create one.
        </p>
      </div>
    );
  }

  if (created) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Project added</h1>
        </header>
        <div className="card">
          <h2>{created.name}</h2>
          <p className="muted">It won't be checked until the next scheduled sweep, or you run it now.</p>
          {error && <p className="notice notice-error">{error}</p>}
          {runQueued ? (
            <p className="notice notice-ok">Queued — the worker picks up run requests within a minute.</p>
          ) : (
            <button onClick={handleRunNow} disabled={queueing}>
              {queueing ? "Queueing…" : "Run now"}
            </button>
          )}
          <p style={{ marginTop: 16 }}>
            <Link to={`/projects/${created.id}`}>View project</Link> · <Link to="/">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Add project</h1>
      </header>
      {error && <p className="notice notice-error">{error}</p>}
      <ProjectForm isOwner={role === "owner"} onSubmit={handleCreate} submitLabel="Save project" pendingLabel="Saving…" />
    </div>
  );
}
