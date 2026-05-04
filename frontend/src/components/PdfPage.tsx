import { useEffect, useMemo, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import type { Annotation, AttributeDefinition, Label, Page, Word } from "../types";
import {
  lineRects,
  pageAnnotationSlice,
} from "../utils/spans";

interface Props {
  pdf: PDFDocumentProxy;
  page: Page;
  scale: number;
  /**
   * When true, render the PDF canvas and the interactive word-overlay layer.
   * When false, only the placeholder + non-interactive highlights render so
   * far-away pages don't pay rendering cost.
   */
  active: boolean;
  labels: Label[];
  /** Annotations whose span overlaps this page. */
  annotationsOnPage: Annotation[];
  /** Index range of currently-selected words on this page (live drag, or
   * the awaiting-picker selection). */
  selectionRange: { startIdx: number; endIdx: number } | null;
  /** Word offsets to highlight as a search match on this page. */
  searchHighlight: { charStart: number; charEnd: number } | null;
  /** Annotation currently in span-edit mode — gets a dashed outline. */
  resizingAnnotationId: number | null;
  /** When true (popover open / drag in progress), annotation overlays go
   * click-through so they don't swallow word interactions. */
  annotationsClickable: boolean;
  registerWrapper: (pageNum: number, el: HTMLElement | null) => void;
  onWordPointerDown: (pageNum: number, wordIdx: number, e: React.PointerEvent) => void;
  onWordPointerEnter: (pageNum: number, wordIdx: number) => void;
  onAnnotationClick: (ann: Annotation, e: React.MouseEvent) => void;
  /** PointerDown on one of the resize handles on `ann`. Only fires when the
   * annotation is in resize mode. */
  onHandlePointerDown: (
    annId: number,
    which: "start" | "end",
    e: React.PointerEvent,
  ) => void;
  attrDefById: Map<number, AttributeDefinition>;
}

function describeAnnotation(
  ann: Annotation,
  label: Label | undefined,
  attrDefById: Map<number, AttributeDefinition>,
): string {
  const parts: string[] = [label?.name ?? "Label"];
  for (const a of ann.attributes) {
    const def = attrDefById.get(a.attribute_def_id);
    parts.push(`${def?.name ?? a.attribute_def_id}=${JSON.stringify(a.value)}`);
  }
  parts.push("(click to edit)");
  return parts.join(" · ");
}

export default function PdfPage({
  pdf,
  page,
  scale,
  active,
  labels,
  annotationsOnPage,
  selectionRange,
  searchHighlight,
  resizingAnnotationId,
  annotationsClickable,
  registerWrapper,
  onWordPointerDown,
  onWordPointerEnter,
  onAnnotationClick,
  onHandlePointerDown,
  attrDefById,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const labelById = useMemo(
    () => new Map(labels.map((l) => [l.id, l] as const)),
    [labels],
  );

  // Register / unregister this wrapper with the parent's IntersectionObserver.
  useEffect(() => {
    registerWrapper(page.page_num, wrapperRef.current);
    return () => registerWrapper(page.page_num, null);
  }, [page.page_num, registerWrapper]);

  // Render canvas when active. We don't unrender on deactivation — keeping
  // the canvas pixels around is cheap-ish and avoids flicker when the user
  // scrolls back over recent pages.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pdfPage = await pdf.getPage(page.page_num);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      task = pdfPage.render({ canvasContext: ctx, viewport }) as unknown as {
        cancel: () => void;
        promise: Promise<void>;
      };
      try {
        await task.promise;
      } catch (e: unknown) {
        const name = (e as { name?: string } | undefined)?.name;
        if (name !== "RenderingCancelledException") {
          // eslint-disable-next-line no-console
          console.error(`pdf render failed (page ${page.page_num})`, e);
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [active, pdf, page.page_num, scale]);

  // Annotation slices: per-annotation list of words on this page covered.
  const annotationCoverage = useMemo(() => {
    const out: { ann: Annotation; words: Word[] }[] = [];
    for (const ann of annotationsOnPage) {
      const slice = pageAnnotationSlice(page.page_num, page.text.length, ann);
      if (!slice) continue;
      const words = page.words.filter(
        (w) => w.char_start >= slice.charStart && w.char_end <= slice.charEnd,
      );
      if (words.length === 0) continue;
      out.push({ ann, words });
    }
    return out;
  }, [annotationsOnPage, page.page_num, page.text.length, page.words]);

  // Words covered by the active selection on this page.
  const selectionWords = useMemo(() => {
    if (!selectionRange) return [];
    const lo = Math.min(selectionRange.startIdx, selectionRange.endIdx);
    const hi = Math.max(selectionRange.startIdx, selectionRange.endIdx);
    return page.words.slice(lo, hi + 1);
  }, [selectionRange, page.words]);

  // Words covered by the search highlight on this page.
  const searchWords = useMemo(() => {
    if (!searchHighlight) return [];
    return page.words.filter(
      (w) =>
        w.char_end > searchHighlight.charStart &&
        w.char_start < searchHighlight.charEnd,
    );
  }, [searchHighlight, page.words]);

  const pixelWidth = page.width * scale;
  const pixelHeight = page.height * scale;

  return (
    <div
      ref={wrapperRef}
      className="pdf-page-wrapper"
      data-page-num={page.page_num}
      style={{ width: pixelWidth, height: pixelHeight }}
    >
      {active && <canvas ref={canvasRef} />}

      {/* Annotation highlights (line-based) — always rendered so navigation
          feedback shows immediately, even before canvas paints. */}
      {annotationCoverage.map(({ ann, words }) => {
        const label = labelById.get(ann.label_definition_id);
        const color = label?.color ?? "#1d4ed8";
        const tooltip = describeAnnotation(ann, label, attrDefById);
        const isResizing = resizingAnnotationId === ann.id;
        const rects = lineRects(words, page.words, scale);
        return rects.map((r, i) => (
          <div
            key={`ann-${ann.id}-${i}`}
            className={`annotation-highlight${isResizing ? " resizing" : ""}`}
            data-annotation-id={i === 0 ? ann.id : undefined}
            title={tooltip}
            onClick={(e) => onAnnotationClick(ann, e)}
            style={{
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              background: color,
              pointerEvents: annotationsClickable && !isResizing ? "auto" : "none",
              cursor: annotationsClickable ? "pointer" : "default",
            }}
          />
        ));
      })}

      {/* Active selection highlight (yellow, line-based). */}
      {selectionWords.length > 0 &&
        lineRects(selectionWords, page.words, scale).map((r, i) => (
          <div
            key={`sel-${i}`}
            className="selection-highlight"
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
        ))}

      {/* Search highlight (yellow with outline + brief pulse). */}
      {searchWords.length > 0 &&
        lineRects(searchWords, page.words, scale).map((r, i) => (
          <div
            key={`search-${i}`}
            className="search-highlight"
            data-search-anchor={i === 0 ? "true" : undefined}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          />
        ))}

      {/* Word overlays — pointer events for drag-to-select. Only rendered
          when the page is active because they're the heaviest layer. */}
      {active &&
        page.words.map((w, idx) => {
          const [x0, y0, x1, y1] = w.bbox;
          return (
            <div
              key={idx}
              className="word-overlay"
              onPointerDown={(e) => onWordPointerDown(page.page_num, idx, e)}
              onPointerEnter={() => onWordPointerEnter(page.page_num, idx)}
              style={{
                left: x0 * scale,
                top: y0 * scale,
                width: (x1 - x0) * scale,
                height: (y1 - y0) * scale,
              }}
            />
          );
        })}

      {/* Resize handles for any annotation currently in resize mode. The
          start handle is drawn on its start_page, the end handle on its
          end_page; for single-page annotations both render here. */}
      {annotationCoverage
        .filter(({ ann }) => resizingAnnotationId === ann.id)
        .flatMap(({ ann }) => {
          const elements: JSX.Element[] = [];
          if (ann.start_page_num === page.page_num) {
            const sw = page.words.find((w) => w.char_start === ann.start_char);
            if (sw) {
              const [x0, y0, , y1] = sw.bbox;
              elements.push(
                <div
                  key={`handle-start-${ann.id}`}
                  className="resize-handle resize-handle-start"
                  title="Drag to adjust the start of the annotation"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onHandlePointerDown(ann.id, "start", e);
                  }}
                  style={{
                    left: x0 * scale - 5,
                    top: y0 * scale,
                    width: 6,
                    height: (y1 - y0) * scale,
                  }}
                />,
              );
            }
          }
          if (ann.end_page_num === page.page_num) {
            const ew = page.words.find((w) => w.char_end === ann.end_char);
            if (ew) {
              const [, y0, x1, y1] = ew.bbox;
              elements.push(
                <div
                  key={`handle-end-${ann.id}`}
                  className="resize-handle resize-handle-end"
                  title="Drag to adjust the end of the annotation"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onHandlePointerDown(ann.id, "end", e);
                  }}
                  style={{
                    left: x1 * scale - 1,
                    top: y0 * scale,
                    width: 6,
                    height: (y1 - y0) * scale,
                  }}
                />,
              );
            }
          }
          return elements;
        })}

      {!active && (
        <div className="pdf-page-placeholder">page {page.page_num}</div>
      )}
    </div>
  );
}