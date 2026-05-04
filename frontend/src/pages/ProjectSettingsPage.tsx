import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api } from "../api";
import type { DocumentCategory, RelationDefinition } from "../types";

const COLOR_PRESETS = [
  "#6366f1", "#1d4ed8", "#0ea5e9", "#0d9488", "#16a34a",
  "#84cc16", "#eab308", "#f97316", "#dc2626", "#a855f7",
  "#475569", "#0f172a",
];

interface TaxonItem {
  id: number;
  name: string;
  description: string | null;
  color: string;
}

interface FormState {
  name: string;
  description: string;
  color: string;
}

interface EditingState extends FormState {
  id: number;
}

interface TaxonomySectionProps<T extends TaxonItem> {
  title: string;
  hint: string;
  items: T[] | null;
  defaultColor: string;
  itemNoun: string; // e.g. "category" — used in the delete confirm dialog
  itemPlural: string;
  onCreate: (payload: {
    name: string;
    description: string | null;
    color: string;
  }) => Promise<void>;
  onUpdate: (
    id: number,
    payload: { name: string; description: string | null; color: string },
  ) => Promise<void>;
  onDelete: (item: T) => Promise<void>;
}

function TaxonomySection<T extends TaxonItem>({
  title,
  hint,
  items,
  defaultColor,
  itemNoun,
  itemPlural,
  onCreate,
  onUpdate,
  onDelete,
}: TaxonomySectionProps<T>) {
  const emptyForm: FormState = {
    name: "",
    description: "",
    color: defaultColor,
  };
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const onCreateSubmit = async () => {
    const name = form.name.trim();
    if (!name) return;
    setCreating(true);
    setLocalError(null);
    try {
      await onCreate({
        name,
        description: form.description.trim() || null,
        color: form.color,
      });
      setForm(emptyForm);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const onSaveEdit = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setLocalError(null);
    try {
      await onUpdate(editing.id, {
        name,
        description: editing.description.trim() || null,
        color: editing.color,
      });
      setEditing(null);
    } catch (e) {
      setLocalError(String(e));
    }
  };

  const onDeleteClick = async (item: T) => {
    if (
      !confirm(
        `Delete ${itemNoun} "${item.name}"? Anything tagged with it will be unassigned.`,
      )
    )
      return;
    setLocalError(null);
    try {
      await onDelete(item);
    } catch (e) {
      setLocalError(String(e));
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 0 }}>{hint}</p>

      {localError && <div className="error-banner">{localError}</div>}

      <div className="settings-form">
        <div className="settings-form-row">
          <input
            type="text"
            placeholder={`${itemNoun} name`}
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
            onClick={onCreateSubmit}
            disabled={creating || form.name.trim().length === 0}
          >
            {creating ? "adding…" : "Add"}
          </button>
        </div>
        <input
          type="text"
          placeholder="Description (optional)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          disabled={creating}
        />
      </div>

      {items === null ? (
        <div className="empty-state">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 12 }}>
          No {itemPlural} yet.
        </div>
      ) : (
        <table className="settings-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) =>
              editing && editing.id === item.id ? (
                <tr key={item.id} className="settings-row-editing">
                  <td>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                      }}
                    >
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
                        setEditing({ ...editing, description: e.target.value })
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
                <tr key={item.id}>
                  <td>
                    <span className="category-pill">
                      <span
                        className="label-swatch"
                        style={{ background: item.color }}
                      />
                      {item.name}
                    </span>
                  </td>
                  <td className="muted">{item.description || "—"}</td>
                  <td className="actions">
                    <button
                      className="btn ghost btn-xs"
                      onClick={() =>
                        setEditing({
                          id: item.id,
                          name: item.name,
                          description: item.description ?? "",
                          color: item.color,
                        })
                      }
                    >
                      edit
                    </button>
                    <button
                      className="btn ghost btn-xs danger"
                      onClick={() => onDeleteClick(item)}
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
  );
}

export default function ProjectSettingsPage() {
  const { projectId: projectIdParam } = useParams();
  const projectId = Number(projectIdParam);
  const [categories, setCategories] = useState<DocumentCategory[] | null>(null);
  const [relationDefs, setRelationDefs] = useState<RelationDefinition[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!Number.isFinite(projectId)) return;
    api
      .listCategories(projectId)
      .then(setCategories)
      .catch((e) => setError(String(e)));
    api
      .listRelationDefs(projectId)
      .then(setRelationDefs)
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  if (!Number.isFinite(projectId)) {
    return <div className="error-banner">Invalid project id.</div>;
  }

  return (
    <>
      <h1 style={{ marginTop: 0 }}>Project settings</h1>
      {error && <div className="error-banner">{error}</div>}

      <TaxonomySection<DocumentCategory>
        title="Document categories"
        hint={
          'Buckets you can tag documents with — e.g. "Senior Preferred Prospectus", ' +
          '"AT1 Prospectus", "Indenture". Assignment is optional and editable per ' +
          "document from the documents table."
        }
        items={categories}
        defaultColor="#6366f1"
        itemNoun="category"
        itemPlural="categories"
        onCreate={async (p) => {
          await api.createCategory(projectId, p);
          refresh();
        }}
        onUpdate={async (id, p) => {
          await api.updateCategory(id, p);
          refresh();
        }}
        onDelete={async (item) => {
          await api.deleteCategory(item.id);
          refresh();
        }}
      />

      <TaxonomySection<RelationDefinition>
        title="Annotation relation types"
        hint={
          "Directed relationships you can draw between two annotations on the " +
          'same document — e.g. "modifies", "cross-references", "subordinates-to". ' +
          "Define the types here, then link annotations from the document viewer."
        }
        items={relationDefs}
        defaultColor="#64748b"
        itemNoun="relation type"
        itemPlural="relation types"
        onCreate={async (p) => {
          await api.createRelationDef(projectId, p);
          refresh();
        }}
        onUpdate={async (id, p) => {
          await api.updateRelationDef(id, p);
          refresh();
        }}
        onDelete={async (item) => {
          await api.deleteRelationDef(item.id);
          refresh();
        }}
      />
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
