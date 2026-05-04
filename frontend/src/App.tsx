import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";

import { api } from "./api";
import type { Label, Project } from "./types";
import ProjectPage from "./pages/ProjectPage";
import DocumentViewer from "./pages/DocumentViewer";
import LabelsPage from "./pages/LabelsPage";

const PROJECT_ID = 1;

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

function SidebarLabelTree({ nodes, depth = 0 }: { nodes: SidebarTreeNode[]; depth?: number }) {
  return (
    <ul className="sidebar-label-tree">
      {nodes.map((n) => (
        <li key={n.label.id}>
          <div className="label-pill" title={n.label.description ?? undefined}>
            {Array.from({ length: depth }).map((_, i) => (
              <span key={i} className="indent" />
            ))}
            <span className="label-swatch" style={{ background: n.label.color }} />
            <span>{n.label.name}</span>
          </div>
          {n.children.length > 0 && <SidebarLabelTree nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshProject = useCallback(() => {
    api
      .getProject(PROJECT_ID)
      .then(setProject)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refreshProject, [refreshProject]);

  const tree = useMemo(
    () => buildSidebarTree(project?.labels ?? []),
    [project?.labels],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>LabelLex</h1>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
          {project ? project.name : "loading…"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          <Link to="/">Documents</Link>
          <Link to="/labels">Manage labels</Link>
        </div>

        <h2>Labels</h2>
        <SidebarLabelTree nodes={tree} />
      </aside>
      <main className="main">
        {error && <div className="error-banner">{error}</div>}
        <Routes>
          <Route path="/" element={<ProjectPage projectId={PROJECT_ID} />} />
          <Route
            path="/labels"
            element={<LabelsPage projectId={PROJECT_ID} onChange={refreshProject} />}
          />
          <Route
            path="/documents/:id"
            element={<DocumentViewer projectId={PROJECT_ID} />}
          />
        </Routes>
      </main>
    </div>
  );
}
