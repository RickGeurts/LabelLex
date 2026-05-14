import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api } from "../api";
import type { Document, DocumentCategory } from "../types";

type UploadStatus = "queued" | "uploading" | "done" | "failed";

interface UploadItem {
  key: string;
  file: File;
  status: UploadStatus;
  error?: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ProjectPage() {
  const { projectId: projectIdParam } = useParams();
  const projectId = Number(projectIdParam);

  const [docs, setDocs] = useState<Document[] | null>(null);
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    if (!Number.isFinite(projectId)) return;
    api
      .listDocuments(projectId)
      .then(setDocs)
      .catch((e) => setError(String(e)));
    api
      .listCategories(projectId)
      .then(setCategories)
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c] as const)),
    [categories],
  );

  const onAssignCategory = async (docId: number, value: string) => {
    const category_id = value === "" ? null : Number(value);
    try {
      const updated = await api.updateDocument(docId, { category_id });
      setDocs((prev) =>
        prev ? prev.map((d) => (d.id === docId ? updated : d)) : prev,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const onDeleteDocument = async (doc: Document) => {
    const annPart =
      doc.annotation_count > 0
        ? ` and ${doc.annotation_count} annotation${doc.annotation_count === 1 ? "" : "s"}`
        : "";
    if (
      !confirm(
        `Delete "${doc.filename}"? This permanently removes the PDF${annPart}.`,
      )
    )
      return;
    setError(null);
    try {
      await api.deleteDocument(doc.id);
      setDocs((prev) => (prev ? prev.filter((d) => d.id !== doc.id) : prev));
    } catch (e) {
      setError(String(e));
    }
  };

  // Sequential upload: pymupdf parsing is CPU-bound, parallel uploads only
  // hurt. Each file flips through queued → uploading → done|failed; the
  // table refreshes after the run so the user sees the new rows.
  const processQueue = useCallback(
    async (items: UploadItem[]) => {
      for (const item of items) {
        setUploads((prev) =>
          prev.map((u) =>
            u.key === item.key ? { ...u, status: "uploading" } : u,
          ),
        );
        try {
          await api.uploadDocument(projectId, item.file);
          setUploads((prev) =>
            prev.map((u) =>
              u.key === item.key ? { ...u, status: "done" } : u,
            ),
          );
        } catch (e) {
          setUploads((prev) =>
            prev.map((u) =>
              u.key === item.key
                ? { ...u, status: "failed", error: String(e) }
                : u,
            ),
          );
        }
        // Refresh after each so the user sees rows appearing live.
        refresh();
      }
    },
    [projectId, refresh],
  );

  const enqueueFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const pdfs = arr.filter((f) =>
        (f.name || "").toLowerCase().endsWith(".pdf"),
      );
      const skipped = arr.length - pdfs.length;
      if (pdfs.length === 0) {
        setError(
          skipped > 0
            ? `Only PDFs are supported (${skipped} file${skipped === 1 ? "" : "s"} skipped).`
            : "No files selected.",
        );
        return;
      }
      setError(
        skipped > 0
          ? `${skipped} non-PDF file${skipped === 1 ? "" : "s"} skipped.`
          : null,
      );
      const items: UploadItem[] = pdfs.map((f) => ({
        key: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        status: "queued",
      }));
      setUploads((prev) => [...prev, ...items]);
      void processQueue(items);
    },
    [processQueue],
  );

  // Drag handlers — counter-based so children's dragenter/leave don't flicker.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    if (e.dataTransfer.files?.length) enqueueFiles(e.dataTransfer.files);
  };

  const clearFinishedUploads = () => {
    setUploads((prev) =>
      prev.filter((u) => u.status !== "done" && u.status !== "failed"),
    );
  };

  const queuedOrActive = uploads.filter(
    (u) => u.status === "queued" || u.status === "uploading",
  );
  const finished = uploads.filter(
    (u) => u.status === "done" || u.status === "failed",
  );

  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  const totalAnnotations = useMemo(
    () => (docs ?? []).reduce((sum, d) => sum + (d.annotation_count ?? 0), 0),
    [docs],
  );
  const unverifiedCount = useMemo(
    () => (docs ?? []).filter((d) => d.review_status === "unverified").length,
    [docs],
  );

  const doPublish = async (publishUnverified: boolean) => {
    if (!Number.isFinite(projectId)) return;
    setPublishing(true);
    setPublishMessage(null);
    try {
      const result = await api.publishToLoraForge(projectId, {
        publishUnverified,
      });
      setPublishMessage({
        tone: "ok",
        text: `Published ${result.summary.documentsWithLabels}/${result.summary.totalDocuments} document(s) and ${result.summary.annotations} annotation(s) → LoRA Forge dataset ${result.dataset.id} (${result.dataset.rowCount} row${result.dataset.rowCount === 1 ? "" : "s"}).`,
      });
    } catch (e) {
      const msg = String(e);
      // Surface the server's 409 unverified-docs error with an override
      // option in the toast UI.
      if (msg.includes("409") && msg.includes("unverified")) {
        const proceed = window.confirm(
          `${unverifiedCount} document(s) are model-labelled but not yet ` +
            `marked as reviewed. Publish anyway?`,
        );
        if (proceed) {
          await doPublish(true);
          return;
        }
        setPublishMessage({
          tone: "err",
          text: `Publish blocked: ${unverifiedCount} unverified document(s). Mark them as reviewed in the viewer or override.`,
        });
      } else {
        setPublishMessage({ tone: "err", text: msg });
      }
    } finally {
      setPublishing(false);
    }
  };

  const onPublishToLoraForge = () => doPublish(false);

  return (
    <>
      <div
        className={`drop-zone${dragActive ? " active" : ""}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
      >
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) enqueueFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="drop-zone-title">
          {dragActive ? "Drop PDFs to upload" : "Drag & drop PDFs here"}
        </div>
        <div className="drop-zone-sub">
          or click to browse · multiple files OK · uploads run sequentially
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {uploads.length > 0 && (
        <div className="card upload-queue-card">
          <div className="upload-queue-header">
            <h2 style={{ margin: 0 }}>Uploads</h2>
            <span style={{ flex: 1 }} />
            {finished.length > 0 && queuedOrActive.length === 0 && (
              <button
                className="btn ghost btn-xs"
                onClick={clearFinishedUploads}
              >
                clear
              </button>
            )}
          </div>
          <ul className="upload-queue">
            {uploads.map((u) => (
              <li key={u.key} className={`upload-item upload-${u.status}`}>
                <span className="upload-name">{u.file.name}</span>
                <span className="upload-size">
                  {(u.file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <span className={`upload-status status-${u.status}`}>
                  {u.status === "queued" && "queued"}
                  {u.status === "uploading" && "uploading…"}
                  {u.status === "done" && "✓ done"}
                  {u.status === "failed" && "✗ failed"}
                </span>
                {u.status === "failed" && u.error && (
                  <span className="upload-error" title={u.error}>
                    {u.error.length > 60 ? u.error.slice(0, 57) + "…" : u.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="upload-queue-header" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>Documents</h2>
          <span style={{ flex: 1 }} />
          <span style={{ color: "#94a3b8", fontSize: 12 }}>
            {docs?.length ?? 0} document
            {(docs?.length ?? 0) === 1 ? "" : "s"}
          </span>
          {unverifiedCount > 0 && (
            <span
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 4,
                background: "#fef3c7",
                color: "#92400e",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.4,
              }}
              title="Auto-labelled documents that have not been marked as reviewed will block the publish unless overridden"
            >
              {unverifiedCount} UNVERIFIED
            </span>
          )}
          <button
            className="btn btn-xs"
            onClick={onPublishToLoraForge}
            disabled={publishing || !docs || totalAnnotations === 0}
            title={
              totalAnnotations === 0
                ? "Label at least one annotation before publishing"
                : "Send all labelled documents to the local LoRA Forge instance as a Dataset"
            }
            style={{ marginLeft: 8 }}
          >
            {publishing ? "Publishing…" : "Publish to LoRA Forge"}
          </button>
        </div>
        {publishMessage && (
          <div
            className={publishMessage.tone === "err" ? "error-banner" : ""}
            style={
              publishMessage.tone === "ok"
                ? {
                    marginBottom: 8,
                    padding: "8px 12px",
                    borderRadius: 6,
                    background: "#064e3b",
                    color: "#d1fae5",
                    fontSize: 13,
                  }
                : { marginBottom: 8 }
            }
          >
            {publishMessage.text}
          </div>
        )}
        {docs === null ? (
          <div className="empty-state">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="empty-state">
            No documents yet. Drop a PDF above to get started.
            {categories.length === 0 && (
              <div style={{ fontSize: 12, marginTop: 6, color: "#94a3b8" }}>
                Tip: define categories in{" "}
                <Link to={`/projects/${projectId}/settings`}>Settings</Link>{" "}
                to bucket your prospectuses.
              </div>
            )}
          </div>
        ) : (
          <table className="doc-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Category</th>
                <th>Status</th>
                <th className="num">Annotations</th>
                <th>Last modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const labelled = d.annotation_count > 0;
                const parseFailed = d.status === "failed";
                const parsing = d.status === "parsing";
                const category =
                  d.category_id !== null
                    ? categoriesById.get(d.category_id)
                    : undefined;
                return (
                  <tr key={d.id}>
                    <td>
                      <Link
                        to={`/projects/${projectId}/documents/${d.id}`}
                        className="doc-table-name"
                      >
                        {d.filename}
                      </Link>
                      <div className="doc-table-sub">
                        {d.page_count} page{d.page_count === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td>
                      <div className="category-cell">
                        <span
                          className="label-swatch"
                          style={{
                            background: category?.color ?? "#cbd5e1",
                            opacity: category ? 1 : 0.4,
                          }}
                        />
                        <select
                          className="category-select"
                          value={d.category_id ?? ""}
                          onChange={(e) =>
                            onAssignCategory(d.id, e.target.value)
                          }
                        >
                          <option value="">— uncategorised</option>
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td>
                      {parseFailed ? (
                        <span className="status-pill status-pill-failed">
                          parse failed
                        </span>
                      ) : parsing ? (
                        <span className="status-pill status-pill-parsing">
                          parsing
                        </span>
                      ) : labelled ? (
                        <span className="status-pill status-pill-labelled">
                          labelled
                        </span>
                      ) : (
                        <span className="status-pill status-pill-unlabelled">
                          unlabelled
                        </span>
                      )}
                      {d.review_status === "unverified" && (
                        <span
                          style={{
                            marginLeft: 6,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "#fef3c7",
                            color: "#92400e",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.4,
                          }}
                          title="Auto-labelled; not yet marked as reviewed"
                        >
                          UNVERIFIED
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {d.annotation_count > 0 ? d.annotation_count : "—"}
                    </td>
                    <td className="muted">{formatDate(d.last_modified_at)}</td>
                    <td className="actions">
                      <Link
                        to={`/projects/${projectId}/documents/${d.id}`}
                      >
                        <button className="btn ghost btn-xs">Open</button>
                      </Link>
                      <button
                        className="btn ghost btn-xs"
                        onClick={() => onDeleteDocument(d)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
