import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useParams } from "react-router-dom";

import { api } from "../api";
import type { Label, Project } from "../types";

interface SidebarTreeNode {
  label: Label;
  children: SidebarTreeNode[];
}

function buildSidebarTree(labels: Label[]): SidebarTreeNode[] {
  const byParent = new Map<number | null, Label[]>();
  for (const l of labels) {
    const arr = byParent.get(l.parent_id) ?? [];
    arr.push(l);
    byParent.set(l.parent_id, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.id - b.id);
  const build = (parentId: number | null): SidebarTreeNode[] =>
    (byParent.get(parentId) ?? []).map((label) => ({
      label,
      children: build(label.id),
    }));
  return build(null);
}

function SidebarLabelTree({
  nodes,
  depth = 0,
}: {
  nodes: SidebarTreeNode[];
  depth?: number;
}) {
  return (
    <ul className="sidebar-label-tree">
      {nodes.map((n) => (
        <li key={n.label.id}>
          <div className="label-pill" title={n.label.description ?? undefined}>
            {Array.from({ length: depth }).map((_, i) => (
              <span key={i} className="indent" />
            ))}
            <span
              className="label-swatch"
              style={{ background: n.label.color }}
            />
            <span>{n.label.name}</span>
          </div>
          {n.children.length > 0 && (
            <SidebarLabelTree nodes={n.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

interface ProjectContext {
  project: Project;
  refreshProject: () => void;
}

export default function ProjectShell() {
  const { projectId: projectIdParam } = useParams();
  const projectId = Number(projectIdParam);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshProject = useCallback(() => {
    if (!Number.isFinite(projectId)) return;
    api
      .getProject(projectId)
      .then(setProject)
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(refreshProject, [refreshProject]);

  const tree = useMemo(
    () => buildSidebarTree(project?.labels ?? []),
    [project?.labels],
  );

  const ctx: ProjectContext = useMemo(
    () => ({ project: project as Project, refreshProject }),
    [project, refreshProject],
  );

  if (!Number.isFinite(projectId)) {
    return <div className="error-banner">Invalid project id.</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>LabelLex</h1>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
          {project ? project.name : "loading…"}
        </div>
        <Link
          to="/projects"
          style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 12 }}
        >
          ← Switch project
        </Link>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            marginTop: 8,
          }}
        >
          <Link to={`/projects/${projectId}`}>Documents</Link>
          <Link to={`/projects/${projectId}/labels`}>Manage labels</Link>
          <Link to={`/projects/${projectId}/settings`}>Settings</Link>
        </div>

        <h2>Labels</h2>
        <SidebarLabelTree nodes={tree} />
      </aside>
      <main className="main">
        {error && <div className="error-banner">{error}</div>}
        {project ? <Outlet context={ctx} /> : <div>Loading project…</div>}
      </main>
    </div>
  );
}
