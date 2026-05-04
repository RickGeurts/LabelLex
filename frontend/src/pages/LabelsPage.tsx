import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import type {
  AttributeCreate,
  AttributeDefinition,
  AttributeUpdate,
  Label,
  LabelCreate,
  LabelUpdate,
  ValueType,
} from "../types";

interface Props {
  projectId: number;
  onChange?: () => void;
}

const DEFAULT_COLOR = "#3b82f6";
const VALUE_TYPES: ValueType[] = ["string", "enum", "bool", "number", "date"];

// Curated 14-colour preset palette covering the seeded label hues plus a few
// sensible neutrals. Free-form colour entry is still available alongside.
const COLOR_PRESETS = [
  "#0f172a", "#1e293b", "#475569", "#1d4ed8", "#3b82f6", "#7c3aed", "#a855f7",
  "#dc2626", "#991b1b", "#ea580c", "#b45309", "#16a34a", "#15803d", "#0d9488",
];

const COLLAPSED_STORAGE_KEY = "labellex.labels.collapsed";

interface TreeNode {
  label: Label;
  children: TreeNode[];
}

function buildTree(labels: Label[]): TreeNode[] {
  const byParent = new Map<number | null, Label[]>();
  for (const l of labels) {
    const arr = byParent.get(l.parent_id) ?? [];
    arr.push(l);
    byParent.set(l.parent_id, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.id - b.id);
  const build = (parentId: number | null): TreeNode[] =>
    (byParent.get(parentId) ?? []).map((label) => ({
      label,
      children: build(label.id),
    }));
  return build(null);
}

function postOrderIds(tree: TreeNode[]): number[] {
  const out: number[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      walk(n.children);
      out.push(n.label.id);
    }
  };
  walk(tree);
  return out;
}

/**
 * Compute which label ids should be visible given a search query. A label is
 * visible if it (or any descendant) matches the query — ancestors of matches
 * stay rendered so the tree structure is preserved. `null` means no filter.
 */
function visibleSet(labels: Label[], query: string): Set<number> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = new Map(labels.map((l) => [l.id, l]));
  const visible = new Set<number>();
  for (const l of labels) {
    if (l.name.toLowerCase().includes(q)) {
      let cur: number | null = l.id;
      while (cur !== null && !visible.has(cur)) {
        visible.add(cur);
        cur = byId.get(cur)?.parent_id ?? null;
      }
    }
  }
  return visible;
}

interface CreateFormState {
  parent_id: number | null;
  name: string;
  color: string;
  description: string;
}

interface InlineRenameState {
  labelId: number;
  draft: string;
}

export default function LabelsPage({ projectId, onChange }: Props) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateFormState | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (raw) return new Set<number>(JSON.parse(raw));
    } catch {
      // ignore
    }
    return new Set();
  });
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_STORAGE_KEY,
        JSON.stringify(Array.from(collapsed)),
      );
    } catch {
      // ignore
    }
  }, [collapsed]);

  const refresh = () => {
    api
      .listLabels(projectId)
      .then(setLabels)
      .catch((e) => setError(String(e)));
  };

  useEffect(refresh, [projectId]);

  const tree = useMemo(() => buildTree(labels), [labels]);
  const editingLabel = useMemo(
    () => labels.find((l) => l.id === editingLabelId) ?? null,
    [labels, editingLabelId],
  );
  const visible = useMemo(() => visibleSet(labels, query), [labels, query]);

  const startCreate = (parentId: number | null) =>
    setCreateForm({
      parent_id: parentId,
      name: "",
      color: DEFAULT_COLOR,
      description: "",
    });

  const submitCreate = async () => {
    if (!createForm) return;
    setError(null);
    try {
      const payload: LabelCreate = {
        name: createForm.name.trim(),
        color: createForm.color,
        description: createForm.description.trim() || null,
        parent_id: createForm.parent_id,
      };
      await api.createLabel(projectId, payload);
      setCreateForm(null);
      refresh();
      onChange?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeLabel = async (label: Label) => {
    if (!confirm(`Delete label "${label.name}"?`)) return;
    setError(null);
    try {
      await api.deleteLabel(projectId, label.id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(label.id);
        return next;
      });
      refresh();
      onChange?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected label(s)?`)) return;
    setError(null);
    const order = postOrderIds(tree).filter((id) => selected.has(id));
    for (const id of order) {
      try {
        await api.deleteLabel(projectId, id);
      } catch (e) {
        setError(`Stopped at label ${id}: ${e}`);
        refresh();
        onChange?.();
        return;
      }
    }
    clearSelection();
    refresh();
    onChange?.();
  };

  const toggleCollapsed = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startInlineRename = (label: Label) =>
    setInlineRename({ labelId: label.id, draft: label.name });

  const commitInlineRename = async () => {
    if (!inlineRename) return;
    const next = inlineRename.draft.trim();
    const label = labels.find((l) => l.id === inlineRename.labelId);
    setInlineRename(null);
    if (!label || next.length === 0 || next === label.name) return;
    try {
      await api.updateLabel(projectId, label.id, { name: next });
      refresh();
      onChange?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const cancelInlineRename = () => setInlineRename(null);

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Labels</h2>
          <button className="btn" onClick={() => startCreate(null)}>
            + New top-level label
          </button>
        </div>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 8 }}>
          Hierarchical taxonomy. Attributes inherit down the tree. Click "edit"
          to manage a label's attributes; double-click a name to rename inline.
        </p>
      </div>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search labels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <>
            <span className="search-meta">
              {visible ? `${visible.size} visible (incl. ancestors)` : ""}
            </span>
            <button className="btn ghost btn-xs" onClick={() => setQuery("")}>
              clear
            </button>
          </>
        )}
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span style={{ flex: 1 }}>{selected.size} label(s) selected</span>
          <button className="btn ghost" onClick={clearSelection}>
            Clear
          </button>
          <button className="btn" onClick={bulkDelete}>
            Delete selected
          </button>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {createForm && (
        <CreateLabelForm
          form={createForm}
          labels={labels}
          onChange={setCreateForm}
          onSubmit={submitCreate}
          onCancel={() => setCreateForm(null)}
        />
      )}

      <div className="card">
        {tree.length === 0 ? (
          <div className="empty-state">No labels yet.</div>
        ) : (
          <ul className="label-tree">
            {tree.map((n) => (
              <LabelTreeRow
                key={n.label.id}
                node={n}
                depth={0}
                visible={visible}
                collapsed={collapsed}
                onToggleCollapsed={toggleCollapsed}
                selected={selected}
                onToggleSelected={toggleSelected}
                onCreateChild={startCreate}
                onEditLabel={(l) => setEditingLabelId(l.id)}
                onDeleteLabel={removeLabel}
                inlineRename={inlineRename}
                onStartInlineRename={startInlineRename}
                onChangeInlineRename={(draft) =>
                  inlineRename && setInlineRename({ ...inlineRename, draft })
                }
                onCommitInlineRename={commitInlineRename}
                onCancelInlineRename={cancelInlineRename}
              />
            ))}
          </ul>
        )}
      </div>

      {editingLabel && (
        <EditLabelModal
          label={editingLabel}
          labels={labels}
          onClose={() => setEditingLabelId(null)}
          onChange={() => {
            refresh();
            onChange?.();
          }}
        />
      )}
    </>
  );
}

function LabelTreeRow({
  node,
  depth,
  visible,
  collapsed,
  onToggleCollapsed,
  selected,
  onToggleSelected,
  onCreateChild,
  onEditLabel,
  onDeleteLabel,
  inlineRename,
  onStartInlineRename,
  onChangeInlineRename,
  onCommitInlineRename,
  onCancelInlineRename,
}: {
  node: TreeNode;
  depth: number;
  visible: Set<number> | null;
  collapsed: Set<number>;
  onToggleCollapsed: (id: number) => void;
  selected: Set<number>;
  onToggleSelected: (id: number) => void;
  onCreateChild: (parentId: number | null) => void;
  onEditLabel: (l: Label) => void;
  onDeleteLabel: (l: Label) => void;
  inlineRename: InlineRenameState | null;
  onStartInlineRename: (l: Label) => void;
  onChangeInlineRename: (draft: string) => void;
  onCommitInlineRename: () => void;
  onCancelInlineRename: () => void;
}) {
  const l = node.label;
  if (visible && !visible.has(l.id)) return null;
  const isCollapsed = collapsed.has(l.id);
  const hasChildren = node.children.length > 0;
  const renaming = inlineRename?.labelId === l.id;

  return (
    <li className="label-tree-row" style={{ paddingLeft: depth * 18 }}>
      <div className="label-tree-row-line">
        {hasChildren ? (
          <span
            className="chevron"
            onClick={() => onToggleCollapsed(l.id)}
            role="button"
            aria-label={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? "▸" : "▾"}
          </span>
        ) : (
          <span className="chevron placeholder">·</span>
        )}
        <input
          type="checkbox"
          checked={selected.has(l.id)}
          onChange={() => onToggleSelected(l.id)}
          aria-label={`Select ${l.name}`}
        />
        <span className="label-swatch" style={{ background: l.color }} />
        {renaming ? (
          <input
            className="inline-rename"
            type="text"
            value={inlineRename!.draft}
            autoFocus
            onChange={(e) => onChangeInlineRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onCommitInlineRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancelInlineRename();
              }
            }}
            onBlur={onCommitInlineRename}
          />
        ) : (
          <span
            className="label-name"
            style={{ fontWeight: 500 }}
            onDoubleClick={() => onStartInlineRename(l)}
            title="Double-click to rename"
          >
            {l.name}
          </span>
        )}
        <span
          className={`usage-count${l.annotation_count === 0 ? " zero" : ""}`}
          title={`${l.annotation_count} annotation(s) using this label`}
        >
          {l.annotation_count}
        </span>
        {l.attributes.length > 0 && (
          <span className="attr-type" title="Number of attributes defined on this label">
            {l.attributes.length} attr
          </span>
        )}
        {l.description && (
          <span style={{ color: "#64748b", fontSize: 12, marginLeft: 8 }}>
            {l.description}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost btn-xs" onClick={() => onCreateChild(l.id)}>
          + child
        </button>
        <button className="btn ghost btn-xs" onClick={() => onEditLabel(l)}>
          edit
        </button>
        <button className="btn ghost btn-xs danger" onClick={() => onDeleteLabel(l)}>
          delete
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="label-tree">
          {node.children.map((c) => (
            <LabelTreeRow
              key={c.label.id}
              node={c}
              depth={depth + 1}
              visible={visible}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              selected={selected}
              onToggleSelected={onToggleSelected}
              onCreateChild={onCreateChild}
              onEditLabel={onEditLabel}
              onDeleteLabel={onDeleteLabel}
              inlineRename={inlineRename}
              onStartInlineRename={onStartInlineRename}
              onChangeInlineRename={onChangeInlineRename}
              onCommitInlineRename={onCommitInlineRename}
              onCancelInlineRename={onCancelInlineRename}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CreateLabelForm({
  form,
  labels,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CreateFormState;
  labels: Label[];
  onChange: (f: CreateFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>New label</h3>
      <div style={formGridStyle}>
        <label>Name</label>
        <input
          type="text"
          value={form.name}
          autoFocus
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
        <label>Color</label>
        <ColorInput
          value={form.color}
          onChange={(color) => onChange({ ...form, color })}
        />
        <label>Parent</label>
        <select
          value={form.parent_id ?? ""}
          onChange={(e) =>
            onChange({
              ...form,
              parent_id: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        >
          <option value="">— top level —</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <label>Description</label>
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
        />
      </div>
      <div style={formActionsStyle}>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn"
          onClick={onSubmit}
          disabled={form.name.trim().length === 0}
        >
          Create
        </button>
      </div>
    </div>
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
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 44, height: 28, padding: 0, border: "1px solid #cbd5e1" }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 100 }}
        />
      </div>
      <div className="color-presets">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            className={`color-preset${c.toLowerCase() === value.toLowerCase() ? " selected" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
    </div>
  );
}

interface AttrFormState {
  mode: "create" | "edit";
  attrId?: number;
  name: string;
  value_type: ValueType;
  enum_values: string[];
  required: boolean;
  description: string;
}

function EditLabelModal({
  label,
  labels,
  onClose,
  onChange,
}: {
  label: Label;
  labels: Label[];
  onClose: () => void;
  onChange: () => void;
}) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [description, setDescription] = useState(label.description ?? "");
  const [parentId, setParentId] = useState<number | null>(label.parent_id);
  const [labelDirty, setLabelDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attrForm, setAttrForm] = useState<AttrFormState | null>(null);

  useEffect(() => {
    setName(label.name);
    setColor(label.color);
    setDescription(label.description ?? "");
    setParentId(label.parent_id);
    setLabelDirty(false);
  }, [label.id, label.name, label.color, label.description, label.parent_id]);

  const descendantIds = useMemo(() => {
    const out = new Set<number>([label.id]);
    let added = true;
    while (added) {
      added = false;
      for (const l of labels) {
        if (l.parent_id !== null && out.has(l.parent_id) && !out.has(l.id)) {
          out.add(l.id);
          added = true;
        }
      }
    }
    return out;
  }, [label.id, labels]);
  const parentOptions = labels.filter((l) => !descendantIds.has(l.id));

  const inheritedAttrs = useMemo(() => {
    const byId = new Map(labels.map((l) => [l.id, l]));
    const out: { from: Label; attr: AttributeDefinition }[] = [];
    const seen = new Set<number>();
    let cur = label.parent_id !== null ? byId.get(label.parent_id) : undefined;
    const visited = new Set<number>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      for (const a of cur.attributes) {
        if (!seen.has(a.id)) {
          out.push({ from: cur, attr: a });
          seen.add(a.id);
        }
      }
      cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
    }
    return out;
  }, [label.id, label.parent_id, labels]);

  const saveLabel = async () => {
    setError(null);
    try {
      const payload: LabelUpdate = {
        name: name.trim(),
        color,
        description: description.trim() || null,
        parent_id: parentId,
      };
      await api.updateLabel(label.project_id, label.id, payload);
      setLabelDirty(false);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  };

  const startAddAttr = () =>
    setAttrForm({
      mode: "create",
      name: "",
      value_type: "string",
      enum_values: [],
      required: false,
      description: "",
    });

  const startEditAttr = (a: AttributeDefinition) =>
    setAttrForm({
      mode: "edit",
      attrId: a.id,
      name: a.name,
      value_type: a.value_type,
      enum_values: a.enum_values ?? [],
      required: a.required,
      description: a.description ?? "",
    });

  const submitAttr = async () => {
    if (!attrForm) return;
    setError(null);
    const enumValues =
      attrForm.value_type === "enum"
        ? attrForm.enum_values.map((s) => s.trim()).filter(Boolean)
        : null;
    try {
      if (attrForm.mode === "create") {
        const payload: AttributeCreate = {
          name: attrForm.name.trim(),
          value_type: attrForm.value_type,
          enum_values: enumValues,
          required: attrForm.required,
          description: attrForm.description.trim() || null,
        };
        await api.createAttribute(label.id, payload);
      } else if (attrForm.attrId !== undefined) {
        const payload: AttributeUpdate = {
          name: attrForm.name.trim(),
          value_type: attrForm.value_type,
          enum_values: enumValues,
          required: attrForm.required,
          description: attrForm.description.trim() || null,
        };
        await api.updateAttribute(label.id, attrForm.attrId, payload);
      }
      setAttrForm(null);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteAttr = async (a: AttributeDefinition) => {
    if (!confirm(`Delete attribute "${a.name}"?`)) return;
    setError(null);
    try {
      await api.deleteAttribute(label.id, a.id);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="label-swatch" style={{ background: color }} />
          <h2>Edit label</h2>
          <span
            className={`usage-count${label.annotation_count === 0 ? " zero" : ""}`}
            title={`${label.annotation_count} annotation(s) using this label`}
          >
            {label.annotation_count} use
          </span>
          <button className="btn ghost btn-xs" onClick={onClose}>close ✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div style={formGridStyle}>
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setLabelDirty(true);
            }}
          />
          <label>Color</label>
          <ColorInput
            value={color}
            onChange={(v) => {
              setColor(v);
              setLabelDirty(true);
            }}
          />
          <label>Parent</label>
          <select
            value={parentId ?? ""}
            onChange={(e) => {
              setParentId(e.target.value === "" ? null : Number(e.target.value));
              setLabelDirty(true);
            }}
          >
            <option value="">— top level —</option>
            {parentOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <label>Description</label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setLabelDirty(true);
            }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button
            className="btn"
            disabled={!labelDirty || name.trim().length === 0}
            onClick={saveLabel}
          >
            Save label
          </button>
        </div>

        <div className="modal-section-title">Attributes</div>

        {inheritedAttrs.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
              Inherited (read-only — edit on the defining label):
            </div>
            <ul className="attr-list" style={{ marginLeft: 0, borderLeftColor: "#cbd5e1" }}>
              {inheritedAttrs.map(({ from, attr }) => (
                <li key={attr.id} className="attr-row">
                  <span className="attr-name">{attr.name}</span>
                  <span className="attr-type">{attr.value_type}</span>
                  {attr.required && <span className="attr-required">required</span>}
                  {attr.enum_values && (
                    <span className="attr-enum">[{attr.enum_values.join(", ")}]</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ color: "#64748b", fontSize: 11, fontStyle: "italic" }}>
                    from {from.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {label.attributes.length > 0 ? (
          <ul className="attr-list" style={{ marginLeft: 0 }}>
            {label.attributes.map((a) => (
              <li key={a.id} className="attr-row">
                <span className="attr-name">{a.name}</span>
                <span className="attr-type">{a.value_type}</span>
                {a.required && <span className="attr-required">required</span>}
                {a.enum_values && (
                  <span className="attr-enum">[{a.enum_values.join(", ")}]</span>
                )}
                {a.description && <span className="attr-desc">{a.description}</span>}
                <span style={{ flex: 1 }} />
                <button className="btn ghost btn-xs" onClick={() => startEditAttr(a)}>
                  edit
                </button>
                <button className="btn ghost btn-xs danger" onClick={() => deleteAttr(a)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state" style={{ padding: "8px 0" }}>
            No attributes defined on this label.
          </div>
        )}

        {attrForm ? (
          <AttrSubForm
            form={attrForm}
            onChange={setAttrForm}
            onSubmit={submitAttr}
            onCancel={() => setAttrForm(null)}
          />
        ) : (
          <button
            className="btn ghost"
            style={{ marginTop: 10 }}
            onClick={startAddAttr}
          >
            + Add attribute
          </button>
        )}
      </div>
    </div>
  );
}

function AttrSubForm({
  form,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: AttrFormState;
  onChange: (f: AttrFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const enumInvalid =
    form.value_type === "enum" &&
    form.enum_values.map((v) => v.trim()).filter(Boolean).length === 0;
  return (
    <div
      style={{
        marginTop: 12,
        padding: 14,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 6,
      }}
    >
      <h4 style={{ margin: "0 0 10px 0" }}>
        {form.mode === "create" ? "New attribute" : "Edit attribute"}
      </h4>
      <div style={formGridStyle}>
        <label>Name</label>
        <input
          type="text"
          value={form.name}
          autoFocus
          onChange={(e) => onChange({ ...form, name: e.target.value })}
        />
        <label>Type</label>
        <select
          value={form.value_type}
          onChange={(e) =>
            onChange({ ...form, value_type: e.target.value as ValueType })
          }
        >
          {VALUE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {form.value_type === "enum" && (
          <>
            <label>Enum values</label>
            <textarea
              rows={3}
              value={form.enum_values.join("\n")}
              placeholder="One value per line"
              onChange={(e) =>
                onChange({ ...form, enum_values: e.target.value.split("\n") })
              }
            />
          </>
        )}
        <label>Required</label>
        <input
          type="checkbox"
          checked={form.required}
          onChange={(e) => onChange({ ...form, required: e.target.checked })}
          style={{ justifySelf: "start", width: 18, height: 18 }}
        />
        <label>Description</label>
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
        />
      </div>
      <div style={formActionsStyle}>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn"
          onClick={onSubmit}
          disabled={form.name.trim().length === 0 || enumInvalid}
        >
          {form.mode === "create" ? "Add" : "Save"}
        </button>
      </div>
    </div>
  );
}

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "120px 1fr",
  gap: "10px 14px",
  alignItems: "center",
};

const formActionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 14,
  justifyContent: "flex-end",
};
