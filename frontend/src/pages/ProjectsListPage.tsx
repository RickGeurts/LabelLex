import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api";
import type { Project } from "../types";

export default function ProjectsListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const p = await api.createProject({ name });
      setNewName("");
      navigate(`/projects/${p.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (p: Project) => {
    if (
      !confirm(
        `Delete project "${p.name}"? This removes its labels, documents, and annotations.`,
      )
    )
      return;
    try {
      await api.deleteProject(p.id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="projects-list-page">
      <div className="projects-list-header">
        <h1>LabelLex</h1>
        <span style={{ color: "#94a3b8", fontSize: 13 }}>
          Pick a project or create a new one
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New project</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={newName}
            placeholder="e.g. AT1 Capital — Q2 2026"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreate();
            }}
            disabled={creating}
            style={{ flex: 1 }}
          />
          <button
            className="btn"
            onClick={onCreate}
            disabled={creating || newName.trim().length === 0}
          >
            {creating ? "creating…" : "Create"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          New projects start empty — you'll add labels via the project's "Manage labels" page.
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Projects</h2>
        {projects === null ? (
          <div className="empty-state">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="empty-state">No projects yet.</div>
        ) : (
          <ul className="project-cards">
            {projects.map((p) => (
              <li key={p.id} className="project-card">
                <div className="project-card-main">
                  <Link to={`/projects/${p.id}`} className="project-card-name">
                    {p.name}
                  </Link>
                  <div className="project-card-meta">
                    {p.labels.length} label{p.labels.length === 1 ? "" : "s"}{" "}
                    · created {new Date(p.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="project-card-actions">
                  <Link to={`/projects/${p.id}`}>
                    <button className="btn ghost btn-xs">Open</button>
                  </Link>
                  <button
                    className="btn ghost btn-xs danger"
                    onClick={() => onDelete(p)}
                  >
                    delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
