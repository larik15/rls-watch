import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getProject, updateProject } from "../lib/projects.js";
import { upsertProjectSecrets } from "../lib/secrets.js";
import { ProjectForm } from "../components/ProjectForm.jsx";

export function ProjectEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getProject(id)
      .then(setProject)
      .catch((e) => setError(e.message));
  }, [id]);

  async function handleSave({ serviceRoleKey, databaseUrl, ...fields }) {
    await updateProject(id, fields);
    // Only touch secrets the user actually typed something into; blank means "keep".
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
  if (!project) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Edit {project.name}</h1>
        <Link to={`/projects/${id}`}>Cancel</Link>
      </header>
      <ProjectForm initial={project} onSubmit={handleSave} submitLabel="Save changes" pendingLabel="Saving…" />
    </div>
  );
}
