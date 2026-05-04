import { Navigate, Route, Routes } from "react-router-dom";

import ProjectsListPage from "./pages/ProjectsListPage";
import ProjectShell from "./pages/ProjectShell";
import ProjectPage from "./pages/ProjectPage";
import ProjectSettingsPage from "./pages/ProjectSettingsPage";
import LabelsPage from "./pages/LabelsPage";
import DocumentViewer from "./pages/DocumentViewer";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route path="/projects" element={<ProjectsListPage />} />
      <Route path="/projects/:projectId" element={<ProjectShell />}>
        <Route index element={<ProjectPage />} />
        <Route path="labels" element={<LabelsPage />} />
        <Route path="settings" element={<ProjectSettingsPage />} />
        <Route path="documents/:documentId" element={<DocumentViewer />} />
      </Route>
      {/* Legacy URL fallback for bookmarks. */}
      <Route path="/labels" element={<Navigate to="/projects" replace />} />
      <Route
        path="/documents/:documentId"
        element={<Navigate to="/projects" replace />}
      />
    </Routes>
  );
}
