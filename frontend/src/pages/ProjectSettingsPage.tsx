import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api";
import type { DocumentCategory } from "../types";

const DEFAULT_COLOR = "#6366f1";
const COLOR_PRESETS = [
  "#6366f1", "#1d4ed8", "#0ea5e9", "#0d9488", "#16a34a",
  "#84cc16", "#eab308", "#f97316", "#dc2626", "#a855f7",
  "#475569", "#0f172a",
];

interface NewCategoryForm {
  name: string;
  description: string;
  color: string;
}

const EMPTY_FORM: NewCategoryForm = {
  name: "",
  description: "",
  color: DEFAULT_COLOR,
};

interface EditingState {
  id: number;
  name: string;
  description: string;
  color: string;
}

export default function ProjectSettingsPage() {
  const { projectId: projectIdParam } = useParams();
  const projectId = Number(projectIdParam);
  const [categories, setCategories] = useState<DocumentCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<NewCategoryForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);

  const refresh = useCallback(() => {
    if (!Number.isFinite(projectId)) return;
    api
      .listCategories(projectId)
      .then(setCategories)
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const onCreate = async () => {
    const name = form.name.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      await api.createCategory(projectId, {
        name,
        description: form.description.trim() || null,
        color: form.color,
      });
      setForm(EMPTY_FORM);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const onSaveEdit = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    try {
      await api.updateCategory(editing.id, {
        name,
        description: editing.description.trim() || null,
        color: editing.color,
      });
      setEditing(null);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const onDelete = async (cat: DocumentCategory) => {
    if (
      !confirm(
        `Delete category "${cat.name}"? Documents in this category will be unassigned.`,
      )
    )
      return;
    try {
      await api.deleteCategory(cat.id);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!Number.isFinite(projectId)) {
    return <div className="error-banner">Invalid project id.</div>;
  }

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Project settings</h1>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Document categories</h2>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 0 }}>
          Buckets you can tag documents with — e.g. "Senior Preferred Prospectus",
          "AT1 Prospectus", "Indenture". Assignment is optional and editable
          per document from the documents table.
        </p>

        <div className="settings-form">
          <div className="settings-form-row">
            <input
              type="text"
              placeholder="Category name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={creating}
            />
            <ColorInput
              value={form.color}
              onChange={(c) => setForm({ ...form, color: c })}
            />
            <button
              className="btn"
              onClick={onCreate}
              disabled={creating || form.name.trim().length === 0}
            >
              {creating ? "adding…" : "Add"}
            </button>
          </div>
          <input
            type="text"
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) =>
              setForm({ ...form, description: e.target.value })
            }
            disabled={creating}
          />
        </div>

        {categories === null ? (
          <div className="empty-state">Loading…</div>
        ) : categories.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 12 }}>
            No categories yet.
          </div>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {categories.map((c) =>
                editing && editing.id === c.id ? (
                  <tr key={c.id} className="settings-row-editing">
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <ColorInput
                          value={editing.color}
                          onChange={(col) =>
                            setEditing({ ...editing, color: col })
                          }
                        />
                        <input
                          type="text"
                          value={editing.name}
                          onChange={(e) =>
                            setEditing({ ...editing, name: e.target.value })
                          }
                          autoFocus
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editing.description}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            description: e.target.value,
                          })
                        }
                        style={{ width: "100%" }}
                      />
                    </td>
                    <td className="actions">
                      <button
                        className="btn ghost btn-xs"
                        onClick={() => setEditing(null)}
                      >
                        cancel
                      </button>
                      <button className="btn btn-xs" onClick={onSaveEdit}>
                        save
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id}>
                    <td>
                      <span className="category-pill">
                        <span
                          className="label-swatch"
                          style={{ background: c.color }}
                        />
                        {c.name}
                      </span>
                    </td>
                    <td className="muted">{c.description || "—"}</td>
                    <td className="actions">
                      <button
                        className="btn ghost btn-xs"
                        onClick={() =>
                          setEditing({
                            id: c.id,
                            name: c.name,
                            description: c.description ?? "",
                            color: c.color,
                          })
                        }
                      >
                        edit
                      </button>
                      <button
                        className="btn ghost btn-xs danger"
                        onClick={() => onDelete(c)}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="color-input">
      <span className="label-swatch" style={{ background: value }} />
      <div className="color-presets">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            className="color-preset"
            style={{ background: c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
      </div>
    </div>
  );
}
