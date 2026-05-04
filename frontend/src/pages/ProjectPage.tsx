import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api";
import type { Document } from "../types";

interface Props {
  projectId: number;
}

export default function ProjectPage({ projectId }: Props) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    api.listDocuments(projectId).then(setDocs).catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const onUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await api.uploadDocument(projectId, file);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Upload prospectus</h2>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
        />
        {busy && <div style={{ marginTop: 8, color: "#64748b" }}>Parsing… can take a few seconds for long docs.</div>}
        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Documents</h2>
        {docs.length === 0 ? (
          <div className="empty-state">No documents yet. Upload one above.</div>
        ) : (
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id}>
                <div>
                  <Link to={`/documents/${d.id}`}>{d.filename}</Link>
                  <div className="doc-meta">
                    {d.page_count} pages · uploaded {new Date(d.uploaded_at).toLocaleString()} · status {d.status}
                  </div>
                </div>
                <Link to={`/documents/${d.id}`}>
                  <button className="btn ghost">Open</button>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}