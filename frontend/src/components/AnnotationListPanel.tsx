import { useMemo, useState } from "react";

import type { Annotation, AttributeDefinition, Label } from "../types";
import {
  displayLabelName,
  isDescendantOfSubParagraph,
  labelChipParts,
} from "../utils/spans";

type SortMode = "page" | "label" | "newest";

interface Props {
  annotations: Annotation[];
  labels: Label[];
  currentPage: number;
  onJumpTo: (pageNum: number, annotationId: number) => void;
  onEdit: (annotationId: number, anchor: { x: number; y: number }) => void;
  onDelete: (annotationId: number) => void;
  // Fold child labels into their parent for the PDF overlay + this list.
  // `foldedParentIds` is the set of parent label IDs whose descendants are
  // hidden. `onToggleFold` flips one parent's folded state.
  foldedParentIds?: Set<number>;
  onToggleFold?: (parentId: number) => void;
}

// Span containment used by the "inside scopes only" filter. A clause
// annotation is "inside" a scope iff every position in its span lies within
// the scope's span. Scope annotations themselves are always shown when the
// filter is on so the user keeps the structural context.
function isInsideAnyScope(
  ann: Annotation,
  scopes: Annotation[],
): boolean {
  for (const s of scopes) {
    if (s.id === ann.id) continue;
    const startsAfter =
      s.start_page_num < ann.start_page_num ||
      (s.start_page_num === ann.start_page_num &&
        s.start_char <= ann.start_char);
    const endsBefore =
      s.end_page_num > ann.end_page_num ||
      (s.end_page_num === ann.end_page_num && s.end_char >= ann.end_char);
    if (startsAfter && endsBefore) return true;
  }
  return false;
}

export default function AnnotationListPanel({
  annotations,
  labels,
  currentPage,
  onJumpTo,
  onEdit,
  onDelete,
  foldedParentIds,
  onToggleFold,
}: Props) {
  const [filterLabel, setFilterLabel] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("page");
  const [insideScopesOnly, setInsideScopesOnly] = useState(false);

  const labelById = useMemo(
    () => new Map(labels.map((l) => [l.id, l])),
    [labels],
  );

  // Labels with children (other labels whose parent_id points to them).
  // These are the labels that can be folded — folding hides all their
  // descendants from both this list and the PDF overlay.
  //
  // Chain-internal labels (every descendant of Sub-paragraph) are
  // suppressed here — folding the Sub-paragraph chip already cascades
  // to the whole sub-paragraph subtree, so showing per-depth chips just
  // clutters the row.
  const labelsWithChildren = useMemo(() => {
    const parentIds = new Set<number>();
    for (const l of labels) {
      if (l.parent_id !== null) parentIds.add(l.parent_id);
    }
    return labels
      .filter((l) => parentIds.has(l.id))
      .filter((l) => !isDescendantOfSubParagraph(l, labelById))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [labels, labelById]);
  const attrDefById = useMemo(() => {
    const m = new Map<number, AttributeDefinition>();
    for (const l of labels) for (const a of l.attributes) m.set(a.id, a);
    return m;
  }, [labels]);

  const scopeAnnotations = useMemo(
    () =>
      annotations.filter(
        (a) => labelById.get(a.label_definition_id)?.is_scope,
      ),
    [annotations, labelById],
  );
  const hasScopes = scopeAnnotations.length > 0;

  const items = useMemo(() => {
    const lower = search.trim().toLowerCase();
    let xs = annotations.filter((a) => {
      if (filterLabel !== "all" && a.label_definition_id !== filterLabel) return false;
      if (lower && !a.text.toLowerCase().includes(lower)) return false;
      if (insideScopesOnly && hasScopes) {
        const isScope = labelById.get(a.label_definition_id)?.is_scope;
        if (!isScope && !isInsideAnyScope(a, scopeAnnotations)) return false;
      }
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
  }, [
    annotations,
    filterLabel,
    search,
    sort,
    labelById,
    insideScopesOnly,
    hasScopes,
    scopeAnnotations,
  ]);

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
          {labelsWithChildren.length > 0 && onToggleFold && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                fontSize: 11,
                color: "#475569",
                marginBottom: 4,
              }}
              title="Click to fold a label's children (Sub-paragraph etc.) — hides them from the list and from the PDF overlay"
            >
              <span style={{ color: "#94a3b8", marginRight: 2 }}>Fold:</span>
              {labelsWithChildren.map((parent) => {
                const folded = foldedParentIds?.has(parent.id) ?? false;
                return (
                  <button
                    key={parent.id}
                    onClick={() => onToggleFold(parent.id)}
                    title={
                      folded
                        ? `Show children of "${parent.name}"`
                        : `Hide children of "${parent.name}"`
                    }
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: `1px solid ${parent.color}`,
                      background: folded ? parent.color + "33" : "transparent",
                      color: folded ? parent.color : "#475569",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    <span>{folded ? "▶" : "▼"}</span>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: parent.color,
                      }}
                    />
                    <span>{parent.name}</span>
                  </button>
                );
              })}
            </div>
          )}
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
                  {displayLabelName(l, labelById)}
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
          {hasScopes && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "#475569",
              }}
            >
              <input
                type="checkbox"
                checked={insideScopesOnly}
                onChange={(e) => setInsideScopesOnly(e.target.checked)}
              />
              Inside scopes only
            </label>
          )}
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
                    {(() => {
                      const { name, depthChip } = labelChipParts(label, labelById);
                      return (
                        <>
                          <span className="ann-label">{name}</span>
                          {depthChip && (
                            <span className="ann-level">{depthChip}</span>
                          )}
                        </>
                      );
                    })()}
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