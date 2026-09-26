import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.jsx";
import { getProject, updateProject } from "../lib/projects.js";
import { upsertProjectSecrets } from "../lib/secrets.js";
import { getMyRole } from "../lib/members.js";
import { ProjectForm } from "../components/ProjectForm.jsx";

export function ProjectEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [role, setRole] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    getProject(id)
      .then((p) => {
        setProject(p);
        return getMyRole(p.agency_id, user.id);
      })
      .then(setRole)
      .catch((e) => setError(e.message));
  }, [id, user.id]);

  async function handleSave({ serviceRoleKey, databaseUrl, ...fields }) {
    // A new supabase_url makes the database delete the stored secrets first; anything
    // typed below is then stored for the new project.
    await updateProject(id, fields);
    if (serviceRoleKey || databaseUrl) {
      await upsertProjectSecrets(id, {
        serviceRoleKey: serviceRoleKey || null,
        databaseUrl: databaseUrl || null,
      });
    }
    navigate(`/projects/${id}`);
  }

  if (error) {
    return (
      <div className="page">
        <p className="notice notice-error">{error}</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }
  if (!project || role === undefined) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Edit {project.name}</h1>
        <Link to={`/projects/${id}`}>Cancel</Link>
      </header>
      <ProjectForm
        initial={project}
        isOwner={role === "owner"}
        onSubmit={handleSave}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />
    </div>
  );
}
