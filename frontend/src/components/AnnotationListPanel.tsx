import { useMemo, useState } from "react";

import type { Annotation, AttributeDefinition, Label } from "../types";

type SortMode = "page" | "label" | "newest";

interface Props {
  annotations: Annotation[];
  labels: Label[];
  currentPage: number;
  onJumpTo: (pageNum: number, annotationId: number) => void;
  onEdit: (annotationId: number, anchor: { x: number; y: number }) => void;
  onDelete: (annotationId: number) => void;
}

export default function AnnotationListPanel({
  annotations,
  labels,
  currentPage,
  onJumpTo,
  onEdit,
  onDelete,
}: Props) {
  const [filterLabel, setFilterLabel] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("page");

  const labelById = useMemo(
    () => new Map(labels.map((l) => [l.id, l])),
    [labels],
  );
  const attrDefById = useMemo(() => {
    const m = new Map<number, AttributeDefinition>();
    for (const l of labels) for (const a of l.attributes) m.set(a.id, a);
    return m;
  }, [labels]);

  const items = useMemo(() => {
    const lower = search.trim().toLowerCase();
    let xs = annotations.filter((a) => {
      if (filterLabel !== "all" && a.label_definition_id !== filterLabel) return false;
      if (lower && !a.text.toLowerCase().includes(lower)) return false;
      return true;
    });
    xs = [...xs].sort((a, b) => {
      if (sort === "page") {
        return (
          a.start_page_num - b.start_page_num ||
          a.start_char - b.start_char
        );
      }
      if (sort === "label") {
        const la = labelById.get(a.label_definition_id)?.name ?? "";
        const lb = labelById.get(b.label_definition_id)?.name ?? "";
        return la.localeCompare(lb) || a.start_page_num - b.start_page_num;
      }
      return b.created_at.localeCompare(a.created_at);
    });
    return xs;
  }, [annotations, filterLabel, search, sort, labelById]);

  const formatAttrs = (a: Annotation): string => {
    if (a.attributes.length === 0) return "";
    return a.attributes
      .map((at) => {
        const def = attrDefById.get(at.attribute_def_id);
        return `${def?.name ?? at.attribute_def_id}=${JSON.stringify(at.value)}`;
      })
      .join(" · ");
  };

  return (
    <aside className="viewer-annotation-panel">
      <header>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Annotations</strong>
          <span style={{ color: "#64748b", fontSize: 12 }}>
            {items.length} of {annotations.length}
          </span>
        </div>
        <div className="ann-controls">
          <input
            type="text"
            placeholder="Search annotated text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="row">
            <select
              value={filterLabel === "all" ? "all" : String(filterLabel)}
              onChange={(e) =>
                setFilterLabel(e.target.value === "all" ? "all" : Number(e.target.value))
              }
              style={{ flex: 1 }}
            >
              <option value="all">All labels</option>
              {labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
            >
              <option value="page">By page</option>
              <option value="label">By label</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="empty-state" style={{ padding: 16 }}>
          {annotations.length === 0
            ? "No annotations yet."
            : "No annotations match the filter."}
        </div>
      ) : (
        <ul className="ann-list">
          {items.map((a) => {
            const label = labelById.get(a.label_definition_id);
            const isCurrent =
              a.start_page_num <= currentPage && currentPage <= a.end_page_num;
            const text = a.text.length > 100 ? a.text.slice(0, 97) + "…" : a.text;
            const attrSummary = formatAttrs(a);
            const pageBadge =
              a.start_page_num === a.end_page_num
                ? `p.${a.start_page_num}`
                : `p.${a.start_page_num}–${a.end_page_num}`;
            return (
              <li
                key={a.id}
                className={isCurrent ? "current" : ""}
                onClick={() => onJumpTo(a.start_page_num, a.id)}
              >
                <div
                  className="ann-color-band"
                  style={{ background: label?.color ?? "#94a3b8" }}
                />
                <div>
                  <div className="ann-meta">
                    <span className="ann-label">{label?.name ?? "(unknown)"}</span>
                    <span className="ann-page">{pageBadge}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="btn ghost btn-xs"
                      title="Edit annotation"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(a.id, {
                          x: e.clientX + 6,
                          y: e.clientY + 6,
                        });
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="btn ghost btn-xs danger"
                      title="Delete annotation"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(a.id);
                      }}
                    >
                      delete
                    </button>
                  </div>
                  <div className="ann-text">{text}</div>
                  {attrSummary && <div className="ann-attrs">{attrSummary}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}