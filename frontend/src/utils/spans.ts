/**
 * Cross-page span helpers shared by the viewer and the page renderer.
 *
 * The selection model uses (page_num, wordIdx) endpoints. The annotation
 * model uses (page_num, char) endpoints. We translate between the two at
 * the point where a selection finalises into a new annotation.
 */
import type { Annotation, AttributeDefinition, Label, Word } from "../types";

export interface Endpoint {
  page: number;
  wordIdx: number;
}

export interface CrossPageRange {
  start: Endpoint;
  end: Endpoint;
}

/** Order endpoints in reading order (page → wordIdx). */
export function orderEndpoints(r: CrossPageRange): { lo: Endpoint; hi: Endpoint } {
  const { start, end } = r;
  if (start.page < end.page) return { lo: start, hi: end };
  if (start.page > end.page) return { lo: end, hi: start };
  return start.wordIdx <= end.wordIdx
    ? { lo: start, hi: end }
    : { lo: end, hi: start };
}

/** Per-page selection slice: which word indices on this page fall in range,
 * or null if the page is outside the range. wordCount is page.words.length. */
export function pageSelectionSlice(
  pageNum: number,
  wordCount: number,
  r: CrossPageRange,
): { startIdx: number; endIdx: number } | null {
  const { lo, hi } = orderEndpoints(r);
  if (pageNum < lo.page || pageNum > hi.page) return null;
  if (wordCount === 0) return null;
  const startIdx = pageNum === lo.page ? lo.wordIdx : 0;
  const endIdx = pageNum === hi.page ? hi.wordIdx : wordCount - 1;
  return { startIdx, endIdx };
}

/** Per-page slice for an existing annotation: char range within `pageNum`,
 * or null if the page is outside the annotation's span. */
export function pageAnnotationSlice(
  pageNum: number,
  pageTextLength: number,
  ann: Annotation,
): { charStart: number; charEnd: number } | null {
  if (pageNum < ann.start_page_num || pageNum > ann.end_page_num) return null;
  const charStart = pageNum === ann.start_page_num ? ann.start_char : 0;
  const charEnd = pageNum === ann.end_page_num ? ann.end_char : pageTextLength;
  if (charEnd <= charStart) return null;
  return { charStart, charEnd };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Group a contiguous run of selected words by visual line and return one
 * rectangle per line, sized to the line's natural y-extent (so the highlight
 * looks like a book-marker rather than skinny per-glyph boxes).
 */
export function lineRects(
  selectedWords: Word[],
  allWords: Word[],
  scale: number,
): Rect[] {
  if (selectedWords.length === 0) return [];

  const allByLine = new Map<string, Word[]>();
  for (const w of allWords) {
    const key = `${w.block}:${w.line}`;
    const arr = allByLine.get(key);
    if (arr) arr.push(w);
    else allByLine.set(key, [w]);
  }

  const groups = new Map<string, Word[]>();
  for (const w of selectedWords) {
    const key = `${w.block}:${w.line}`;
    const arr = groups.get(key);
    if (arr) arr.push(w);
    else groups.set(key, [w]);
  }

  const rects: Rect[] = [];
  for (const [key, sel] of groups) {
    sel.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const x0 = sel[0].bbox[0];
    const x1 = sel[sel.length - 1].bbox[2];
    const lineWords = allByLine.get(key) ?? sel;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const w of lineWords) {
      if (w.bbox[1] < y0) y0 = w.bbox[1];
      if (w.bbox[3] > y1) y1 = w.bbox[3];
    }
    rects.push({
      left: x0 * scale,
      top: y0 * scale,
      width: (x1 - x0) * scale,
      height: (y1 - y0) * scale,
    });
  }
  return rects;
}

/** All effective attributes (own + inherited from ancestors) for a label. */
export function effectiveAttributes(
  label: Label,
  byId: Map<number, Label>,
): AttributeDefinition[] {
  const out: AttributeDefinition[] = [];
  const seenAttrs = new Set<number>();
  const seenLabels = new Set<number>();
  let cur: Label | undefined = label;
  while (cur && !seenLabels.has(cur.id)) {
    seenLabels.add(cur.id);
    for (const a of cur.attributes) {
      if (!seenAttrs.has(a.id)) {
        out.push(a);
        seenAttrs.add(a.id);
      }
    }
    cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export function isValueFilled(value: unknown, type: string): boolean {
  if (type === "bool") return typeof value === "boolean";
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}