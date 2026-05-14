import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { api } from "../api";
import type {
  Annotation,
  AnnotationAttributeIO,
  AnnotationCreate,
  AnnotationRelation,
  AttributeDefinition,
  DetectedSection,
  Document as DocModel,
  Label,
  Page as PageModel,
  AutoLabelTier,
  LlmProvider,
  LlmProvidersStatus,
  PrelabelCandidate,
  RelationDefinition,
  SearchHit,
  TncRange,
} from "../types";
import PdfPage from "../components/PdfPage";
import AnnotationListPanel from "../components/AnnotationListPanel";
import {
  CrossPageRange,
  Endpoint,
  effectiveAttributes,
  isValueFilled,
  orderEndpoints,
  pageSelectionSlice,
} from "../utils/spans";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SCALE = 1.4;
const PANEL_PREF_KEY = "labellex.viewer.showPanel";
const SEARCH_DEBOUNCE_MS = 250;
/** Buffer of pages on either side of the viewport that get the heavy
 * render path (canvas + word overlays). Selection / annotation highlights
 * still render outside this window because they're cheap. */
const ACTIVE_BUFFER = 2;

interface SearchHighlight {
  pageNum: number;
  charStart: number;
  charEnd: number;
}

type PopoverState =
  | {
      kind: "picker-label";
      range: CrossPageRange;
      x: number;
      y: number;
    }
  | {
      kind: "picker-attrs";
      range: CrossPageRange;
      labelId: number;
      values: Record<number, unknown>;
      suggestionId: number | null;
      suggesting: boolean;
      suggestError: string | null;
      x: number;
      y: number;
    }
  | {
      kind: "editor";
      annotationId: number;
      values: Record<number, unknown>;
      suggestionId: number | null;
      suggesting: boolean;
      suggestError: string | null;
      x: number;
      y: number;
    };

export default function DocumentViewer() {
  const params = useParams();
  const projectId = Number(params.projectId);
  const documentId = Number(params.documentId);

  const [doc, setDoc] = useState<DocModel | null>(null);
  const [pages, setPages] = useState<PageModel[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Selection — drag in progress.
  const [drag, setDrag] = useState<CrossPageRange | null>(null);
  const dragRef = useRef<CrossPageRange | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  // Popover — picker or editor.
  const [popover, setPopover] = useState<PopoverState | null>(null);

  // Span-edit mode for an existing annotation. While the id is set:
  //   - resize handles render at the annotation's start and end
  //   - word-overlay clicks are suppressed (only handles drive the change)
  //   - dragging a handle records progress in `handleDrag`; releasing stages
  //     a `spanConfirm` popup. Apply confirms, Cancel reverts.
  const [resizingAnnotationId, setResizingAnnotationId] = useState<number | null>(null);

  interface HandleDrag {
    annotationId: number;
    movingEnd: "start" | "end";
    /** The endpoint following the cursor. */
    current: Endpoint;
    /** The endpoint that stays put for this drag. */
    fixed: Endpoint;
  }
  const [handleDrag, setHandleDrag] = useState<HandleDrag | null>(null);
  const handleDragRef = useRef<HandleDrag | null>(null);
  useEffect(() => {
    handleDragRef.current = handleDrag;
  }, [handleDrag]);

  interface SpanConfirmState {
    annotationId: number;
    newStart: Endpoint;
    newEnd: Endpoint;
    x: number;
    y: number;
  }
  const [spanConfirm, setSpanConfirm] = useState<SpanConfirmState | null>(null);

  // Visible-page tracking for lazy canvas rendering. The IntersectionObserver
  // root is the .viewer-pdf-area scroll container — captured via a callback
  // ref so the observer can re-create when the element mounts.
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const wrappersRef = useRef<Map<number, HTMLElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);

  // Search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [activeHitKey, setActiveHitKey] = useState<string | null>(null);
  const [searchHighlight, setSearchHighlight] = useState<SearchHighlight | null>(null);

  // Ollama-driven structure detection.
  type DetectModalState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "result"; model: string; sections: DetectedSection[] };
  const [detectModal, setDetectModal] = useState<DetectModalState | null>(null);

  // Inter-annotation relations.
  const [relations, setRelations] = useState<AnnotationRelation[]>([]);
  const [relationDefs, setRelationDefs] = useState<RelationDefinition[]>([]);
  // Linking mode is the "click another annotation to link" workflow. While
  // active, the annotation editor is closed, a top banner explains the
  // mode, and clicking any other annotation routes to the type picker
  // instead of opening that annotation's editor.
  interface LinkingState {
    fromAnnotationId: number;
    picker: { targetId: number; x: number; y: number } | null;
  }
  const [linkingMode, setLinkingMode] = useState<LinkingState | null>(null);

  // Ollama-driven clause discovery (pre-labelling).
  interface PrelabelState {
    mode: "labels" | "ci";
    startPage: number;
    endPage: number;
    selectedLabels: Set<number>;
    candidates: PrelabelCandidate[];
    running: boolean;
    error: string | null;
    lastModel: string | null;
    lastPagesScanned: number;
    progress: { done: number; total: number } | null;
    // CI mode only.
    tncRanges?: TncRange[] | null;
    detecting?: boolean;
    provider?: LlmProvider;
  }
  const [prelabelModal, setPrelabelModal] = useState<PrelabelState | null>(null);

  interface AutoLabelState {
    running: boolean;
    clausesDone: number;
    clausesTotal: number;
    lastHeading: string | null;
    model: string | null;
    error: string | null;
  }
  const [autoLabel, setAutoLabel] = useState<AutoLabelState | null>(null);

  const [llmProviders, setLlmProviders] = useState<LlmProvidersStatus | null>(null);
  useEffect(() => {
    api
      .getLlmProviders()
      .then(setLlmProviders)
      .catch(() => {
        // Non-fatal — toggle stays disabled.
      });
  }, []);

  const [showPanel, setShowPanel] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(PANEL_PREF_KEY);
      if (raw !== null) return raw === "1";
    } catch {
      // ignore
    }
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_PREF_KEY, showPanel ? "1" : "0");
    } catch {
      // ignore
    }
  }, [showPanel]);

  // ---------- Initial load ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      api.getDocument(documentId),
      api.listLabels(projectId),
      api.listAnnotations(documentId),
      api.getAllPages(documentId),
      api.listDocumentRelations(documentId),
      api.listRelationDefs(projectId),
    ])
      .then(([d, ls, anns, ps, rels, rdefs]) => {
        if (cancelled) return;
        setDoc(d);
        setLabels(ls);
        setAnnotations(anns);
        setPages(ps);
        setRelations(rels);
        setRelationDefs(rdefs);
      })
      .catch((e) => !cancelled && setError(String(e)));

    const loadingTask = pdfjsLib.getDocument({ url: api.pdfUrl(documentId) });
    loadingTask.promise
      .then((p) => !cancelled && setPdf(p))
      .catch((e) => !cancelled && setError(`PDF load failed: ${e}`));

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [documentId, projectId]);

  // ---------- IntersectionObserver ---------------------------------------
  // One observer at this level watches every page wrapper. PdfPage uses
  // `registerWrapper` to opt in / out as it mounts and unmounts.
  const observerCallback = useCallback<IntersectionObserverCallback>((entries) => {
    setVisiblePages((prev) => {
      const next = new Set(prev);
      for (const entry of entries) {
        const num = Number(
          (entry.target as HTMLElement).getAttribute("data-page-num"),
        );
        if (!Number.isFinite(num)) continue;
        if (entry.isIntersecting) next.add(num);
        else next.delete(num);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!scrollContainer) return;
    const obs = new IntersectionObserver(observerCallback, {
      root: scrollContainer,
      rootMargin: "300px 0px",
      threshold: 0,
    });
    observerRef.current = obs;
    // Re-observe any wrappers that already registered before the observer
    // existed (race during initial mount).
    for (const el of wrappersRef.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [observerCallback, scrollContainer]);

  const registerWrapper = useCallback((pageNum: number, el: HTMLElement | null) => {
    const map = wrappersRef.current;
    const previous = map.get(pageNum);
    if (previous && observerRef.current) observerRef.current.unobserve(previous);
    if (el) {
      map.set(pageNum, el);
      observerRef.current?.observe(el);
    } else {
      map.delete(pageNum);
    }
  }, []);

  const activePages = useMemo(() => {
    const out = new Set<number>();
    for (const n of visiblePages) {
      for (let i = -ACTIVE_BUFFER; i <= ACTIVE_BUFFER; i++) {
        out.add(n + i);
      }
    }
    return out;
  }, [visiblePages]);

  const currentPage = useMemo(() => {
    const sorted = Array.from(visiblePages).sort((a, b) => a - b);
    return sorted[0] ?? 1;
  }, [visiblePages]);

  // ---------- Search ------------------------------------------------------
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    const t = setTimeout(() => {
      api
        .searchDocument(documentId, q, 100)
        .then((hits) => {
          setSearchResults(hits);
          setSearchBusy(false);
        })
        .catch((e) => {
          setError(String(e));
          setSearchBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchQuery, documentId]);

  // ---------- Keyboard ---------------------------------------------------
  useEffect(() => {
    if (!doc) return;
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (linkingMode?.picker) {
          e.preventDefault();
          setLinkingMode({ ...linkingMode, picker: null });
        } else if (linkingMode) {
          e.preventDefault();
          setLinkingMode(null);
        } else if (spanConfirm) {
          e.preventDefault();
          setSpanConfirm(null);
          setResizingAnnotationId(null);
        } else if (handleDrag) {
          e.preventDefault();
          handleDragRef.current = null;
          setHandleDrag(null);
        } else if (popover) {
          e.preventDefault();
          setPopover(null);
        } else if (resizingAnnotationId !== null) {
          e.preventDefault();
          setResizingAnnotationId(null);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (e.key === "ArrowLeft") {
        scrollToPage(Math.max(1, currentPage - 1));
      } else if (e.key === "ArrowRight") {
        scrollToPage(Math.min(doc.page_count, currentPage + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // scrollToPage is defined below; we capture it fresh on each render via
    // the closure. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, popover, resizingAnnotationId, handleDrag, spanConfirm, currentPage, linkingMode]);

  // ---------- Helpers ----------------------------------------------------
  const labelById = useMemo(
    () => new Map(labels.map((l) => [l.id, l] as const)),
    [labels],
  );
  const attrDefById = useMemo(() => {
    const m = new Map<number, AttributeDefinition>();
    for (const l of labels) for (const a of l.attributes) m.set(a.id, a);
    return m;
  }, [labels]);
  const pagesByNum = useMemo(() => {
    const m = new Map<number, PageModel>();
    for (const p of pages) m.set(p.page_num, p);
    return m;
  }, [pages]);

  const scrollToPage = (n: number) => {
    const el = wrappersRef.current.get(n);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ---------- Drag-to-select / resize ------------------------------------
  const onWordPointerDown = useCallback(
    (pageNum: number, wordIdx: number, e: React.PointerEvent) => {
      // While popovers / handle drag / confirm / resize / linking are in
      // progress, word clicks must not start a new drag.
      if (popover) return;
      if (handleDragRef.current) return;
      if (spanConfirm) return;
      if (resizingAnnotationId !== null) return;
      if (linkingMode) return;
      e.preventDefault();
      const range: CrossPageRange = {
        start: { page: pageNum, wordIdx },
        end: { page: pageNum, wordIdx },
      };
      dragRef.current = range;
      setDrag(range);
    },
    [popover, spanConfirm, resizingAnnotationId, linkingMode],
  );

  const onWordPointerEnter = useCallback((pageNum: number, wordIdx: number) => {
    // Handle drag takes priority over normal drag.
    if (handleDragRef.current) {
      const next: HandleDrag = {
        ...handleDragRef.current,
        current: { page: pageNum, wordIdx },
      };
      handleDragRef.current = next;
      setHandleDrag(next);
      return;
    }
    if (!dragRef.current) return;
    const next: CrossPageRange = {
      start: dragRef.current.start,
      end: { page: pageNum, wordIdx },
    };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const onHandlePointerDown = useCallback(
    (annId: number, which: "start" | "end", _e: React.PointerEvent) => {
      const ann = annotations.find((a) => a.id === annId);
      if (!ann) return;
      const startPage = pagesByNum.get(ann.start_page_num);
      const endPage = pagesByNum.get(ann.end_page_num);
      if (!startPage || !endPage) return;
      const startIdx = startPage.words.findIndex(
        (w) => w.char_start === ann.start_char,
      );
      const endIdx = endPage.words.findIndex(
        (w) => w.char_end === ann.end_char,
      );
      if (startIdx < 0 || endIdx < 0) return;

      const startEp: Endpoint = { page: ann.start_page_num, wordIdx: startIdx };
      const endEp: Endpoint = { page: ann.end_page_num, wordIdx: endIdx };

      const initial: HandleDrag =
        which === "start"
          ? { annotationId: annId, movingEnd: "start", current: startEp, fixed: endEp }
          : { annotationId: annId, movingEnd: "end", current: endEp, fixed: startEp };
      handleDragRef.current = initial;
      setHandleDrag(initial);
    },
    [annotations, pagesByNum],
  );

  // Document-level pointerup finalises any active drag.
  // Routing rules at release time:
  //   1. Handle drag (span resize): stage a span-confirm popup with the
  //      proposed new endpoints. Apply commits, Cancel reverts.
  //   2. Single-word click landing inside an existing annotation: open
  //      that annotation's editor (word overlays would otherwise swallow
  //      these clicks into the picker).
  //   3. Otherwise (drag, or click on un-annotated word): open the label
  //      picker for a new annotation at the release point.
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      // (1) Handle drag — finalise into a confirmation popup.
      const hd = handleDragRef.current;
      if (hd) {
        handleDragRef.current = null;
        setHandleDrag(null);
        const newStartRaw = hd.movingEnd === "start" ? hd.current : hd.fixed;
        const newEndRaw = hd.movingEnd === "end" ? hd.current : hd.fixed;
        const { lo, hi } = orderEndpoints({ start: newStartRaw, end: newEndRaw });
        setSpanConfirm({
          annotationId: hd.annotationId,
          newStart: lo,
          newEnd: hi,
          x: e.clientX + 6,
          y: e.clientY + 6,
        });
        return;
      }

      const range = dragRef.current;
      if (!range) return;
      dragRef.current = null;
      setDrag(null);

      const { lo, hi } = orderEndpoints(range);
      const startPage = pagesByNum.get(lo.page);
      const endPage = pagesByNum.get(hi.page);
      if (!startPage || !endPage) return;
      const startWord = startPage.words[lo.wordIdx];
      const endWord = endPage.words[hi.wordIdx];
      if (!startWord || !endWord) return;

      // (2) Single-word click on an annotated word → open its editor.
      const isSingleWord = lo.page === hi.page && lo.wordIdx === hi.wordIdx;
      if (isSingleWord) {
        const containing = annotations.find((a) => {
          if (lo.page < a.start_page_num || lo.page > a.end_page_num) return false;
          const sc = lo.page === a.start_page_num ? a.start_char : 0;
          const ec =
            lo.page === a.end_page_num
              ? a.end_char
              : startPage.text.length;
          return startWord.char_start >= sc && startWord.char_end <= ec;
        });
        if (containing) {
          const values: Record<number, unknown> = {};
          for (const av of containing.attributes) {
            values[av.attribute_def_id] = av.value;
          }
          setPopover({
            kind: "editor",
            annotationId: containing.id,
            values,
            suggestionId: null,
            suggesting: false,
            suggestError: null,
            x: e.clientX + 6,
            y: e.clientY + 6,
          });
          return;
        }
      }

      // (3) Default: open the label picker for a new annotation.
      setPopover({
        kind: "picker-label",
        range,
        x: e.clientX + 6,
        y: e.clientY + 6,
      });
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, [pagesByNum, annotations]);

  // ---------- Apply / cancel span-edit ------------------------------------
  const applySpanConfirm = () => {
    if (!spanConfirm) return;
    const { annotationId, newStart, newEnd } = spanConfirm;
    const startPage = pagesByNum.get(newStart.page);
    const endPage = pagesByNum.get(newEnd.page);
    if (!startPage || !endPage) {
      setSpanConfirm(null);
      setResizingAnnotationId(null);
      return;
    }
    const sw = startPage.words[newStart.wordIdx];
    const ew = endPage.words[newEnd.wordIdx];
    if (!sw || !ew) {
      setSpanConfirm(null);
      setResizingAnnotationId(null);
      return;
    }
    const startChar = sw.char_start;
    const endChar = ew.char_end;
    const text = buildSpanText(
      pagesByNum,
      newStart.page,
      startChar,
      newEnd.page,
      endChar,
    );
    api
      .updateAnnotation(annotationId, {
        start_page_num: newStart.page,
        start_char: startChar,
        end_page_num: newEnd.page,
        end_char: endChar,
        text,
      })
      .then((updated) =>
        setAnnotations((prev) =>
          prev.map((a) => (a.id === annotationId ? updated : a)),
        ),
      )
      .catch((err) => setError(String(err)));
    setSpanConfirm(null);
    setResizingAnnotationId(null);
  };

  const cancelSpanConfirm = () => {
    setSpanConfirm(null);
    setResizingAnnotationId(null);
  };

  // ---------- Preview annotations (with handle/confirm overrides) --------
  const annotationsForRender = useMemo(() => {
    if (!handleDrag && !spanConfirm) return annotations;
    return annotations.map((a) => {
      let newStart: Endpoint | null = null;
      let newEnd: Endpoint | null = null;
      if (handleDrag && handleDrag.annotationId === a.id) {
        newStart =
          handleDrag.movingEnd === "start" ? handleDrag.current : handleDrag.fixed;
        newEnd =
          handleDrag.movingEnd === "end" ? handleDrag.current : handleDrag.fixed;
      } else if (spanConfirm && spanConfirm.annotationId === a.id) {
        newStart = spanConfirm.newStart;
        newEnd = spanConfirm.newEnd;
      } else {
        return a;
      }
      const { lo, hi } = orderEndpoints({ start: newStart, end: newEnd });
      const sp = pagesByNum.get(lo.page);
      const ep = pagesByNum.get(hi.page);
      if (!sp || !ep) return a;
      const sw = sp.words[lo.wordIdx];
      const ew = ep.words[hi.wordIdx];
      if (!sw || !ew) return a;
      return {
        ...a,
        start_page_num: lo.page,
        start_char: sw.char_start,
        end_page_num: hi.page,
        end_char: ew.char_end,
      };
    });
  }, [annotations, handleDrag, spanConfirm, pagesByNum]);

  const annotationsByPageForRender = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotationsForRender) {
      for (let n = a.start_page_num; n <= a.end_page_num; n++) {
        const arr = m.get(n);
        if (arr) arr.push(a);
        else m.set(n, [a]);
      }
    }
    return m;
  }, [annotationsForRender]);

  // ---------- Annotation create / update / delete ------------------------
  const cancelPopover = () => setPopover(null);

  const submitNewAnnotation = (
    labelId: number,
    attrs: AnnotationAttributeIO[],
    suggestionId: number | null,
  ) => {
    if (!popover || popover.kind !== "picker-label" && popover.kind !== "picker-attrs") return;
    const range = popover.range;
    const { lo, hi } = orderEndpoints(range);
    const startPage = pagesByNum.get(lo.page);
    const endPage = pagesByNum.get(hi.page);
    if (!startPage || !endPage) return;
    const startWord = startPage.words[lo.wordIdx];
    const endWord = endPage.words[hi.wordIdx];
    if (!startWord || !endWord) return;
    const startChar = startWord.char_start;
    const endChar = endWord.char_end;
    const text = buildSpanText(pagesByNum, lo.page, startChar, hi.page, endChar);

    const payload: AnnotationCreate = {
      document_id: documentId,
      label_definition_id: labelId,
      start_page_num: lo.page,
      start_char: startChar,
      end_page_num: hi.page,
      end_char: endChar,
      text,
      attributes: attrs,
      ...(suggestionId !== null ? { suggestion_id: suggestionId } : {}),
    };
    api
      .createAnnotation(payload)
      .then((created) => setAnnotations((prev) => [...prev, created]))
      .catch((err) => setError(String(err)));
    setPopover(null);
  };

  const onPickLabel = (labelId: number) => {
    if (!popover || popover.kind !== "picker-label") return;
    const label = labelById.get(labelId);
    if (!label) return;
    const attrs = effectiveAttributes(label, labelById);
    if (attrs.length === 0) {
      submitNewAnnotation(labelId, [], null);
      return;
    }
    setPopover({
      kind: "picker-attrs",
      range: popover.range,
      labelId,
      values: {},
      suggestionId: null,
      suggesting: false,
      suggestError: null,
      x: popover.x,
      y: popover.y,
    });
  };

  const onAnnotationClick = (ann: Annotation, e: React.MouseEvent) => {
    e.stopPropagation();
    if (resizingAnnotationId !== null) return; // resize mode in progress

    // Linking mode: route the click to the type picker instead of
    // opening this annotation's editor. Self-link is rejected silently.
    if (linkingMode) {
      if (ann.id === linkingMode.fromAnnotationId) return;
      setLinkingMode({
        ...linkingMode,
        picker: { targetId: ann.id, x: e.clientX + 6, y: e.clientY + 6 },
      });
      return;
    }

    const values: Record<number, unknown> = {};
    for (const a of ann.attributes) values[a.attribute_def_id] = a.value;
    setPopover({
      kind: "editor",
      annotationId: ann.id,
      values,
      suggestionId: null,
      suggesting: false,
      suggestError: null,
      x: e.clientX + 6,
      y: e.clientY + 6,
    });
  };

  const refreshRelations = useCallback(() => {
    api
      .listDocumentRelations(documentId)
      .then(setRelations)
      .catch((err) => setError(String(err)));
  }, [documentId]);

  const startLinkingFromEditor = () => {
    if (!popover || popover.kind !== "editor") return;
    setLinkingMode({ fromAnnotationId: popover.annotationId, picker: null });
    setPopover(null);
  };

  const cancelLinking = useCallback(() => {
    setLinkingMode(null);
  }, []);

  const submitRelation = (relationDefId: number) => {
    if (!linkingMode || !linkingMode.picker) return;
    const fromId = linkingMode.fromAnnotationId;
    const toId = linkingMode.picker.targetId;
    api
      .createRelation({
        from_annotation_id: fromId,
        to_annotation_id: toId,
        relation_def_id: relationDefId,
      })
      .then(() => {
        refreshRelations();
        setLinkingMode(null);
      })
      .catch((err) => setError(String(err)));
  };

  const deleteRelationById = (relationId: number) => {
    api
      .deleteRelation(relationId)
      .then(refreshRelations)
      .catch((err) => setError(String(err)));
  };

  const submitEditor = () => {
    if (!popover || popover.kind !== "editor") return;
    const annId = popover.annotationId;
    const attrs = valuesToPayload(popover.values);
    const suggestionId = popover.suggestionId;
    api
      .updateAnnotation(annId, {
        attributes: attrs,
        ...(suggestionId !== null ? { suggestion_id: suggestionId } : {}),
      })
      .then((updated) =>
        setAnnotations((prev) =>
          prev.map((a) => (a.id === annId ? updated : a)),
        ),
      )
      .catch((err) => setError(String(err)));
    setPopover(null);
  };

  const deleteFromEditor = () => {
    if (!popover || popover.kind !== "editor") return;
    const annId = popover.annotationId;
    api
      .deleteAnnotation(annId)
      .then(() =>
        setAnnotations((prev) => prev.filter((a) => a.id !== annId)),
      )
      .catch((err) => setError(String(err)));
    setPopover(null);
  };

  const startResize = () => {
    if (!popover || popover.kind !== "editor") return;
    setResizingAnnotationId(popover.annotationId);
    setPopover(null);
  };

  // ---------- Search jump --------------------------------------------------
  const jumpToHit = (hit: SearchHit) => {
    if (!doc) return;
    setActiveHitKey(`${hit.page_num}:${hit.char_start}`);
    setSearchHighlight({
      pageNum: hit.page_num,
      charStart: hit.char_start,
      charEnd: hit.char_end,
    });
    scrollToPage(hit.page_num);
  };

  const [pendingScrollAnnotation, setPendingScrollAnnotation] = useState<number | null>(null);

  const jumpToAnnotation = (target: number, annotationId: number) => {
    if (!doc) return;
    setSearchHighlight(null);
    scrollToPage(Math.max(1, Math.min(doc.page_count, target)));
    setPendingScrollAnnotation(annotationId);
  };

  // Once the target annotation's start page becomes active and its overlay
  // is in the DOM, scroll the bbox into view precisely. Effect re-runs as
  // pages activate (IntersectionObserver moves the active set).
  useEffect(() => {
    if (pendingScrollAnnotation === null) return;
    const el = document.querySelector(
      `[data-annotation-id="${pendingScrollAnnotation}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      setPendingScrollAnnotation(null);
    }
  }, [pendingScrollAnnotation, activePages, annotations]);

  const requestSuggestion = useCallback(() => {
    setPopover((prev) => {
      if (!prev || (prev.kind !== "picker-attrs" && prev.kind !== "editor")) return prev;

      // Resolve label id + clause text from the current popover.
      let labelId: number;
      let text: string;
      let span: { start_page_num: number; start_char: number; end_page_num: number; end_char: number } | null = null;

      if (prev.kind === "picker-attrs") {
        labelId = prev.labelId;
        const { lo, hi } = orderEndpoints(prev.range);
        const sp = pagesByNum.get(lo.page);
        const ep = pagesByNum.get(hi.page);
        if (!sp || !ep) return prev;
        const sw = sp.words[lo.wordIdx];
        const ew = ep.words[hi.wordIdx];
        if (!sw || !ew) return prev;
        text = buildSpanText(pagesByNum, lo.page, sw.char_start, hi.page, ew.char_end);
        span = {
          start_page_num: lo.page,
          start_char: sw.char_start,
          end_page_num: hi.page,
          end_char: ew.char_end,
        };
      } else {
        const ann = annotations.find((a) => a.id === prev.annotationId);
        if (!ann) return prev;
        labelId = ann.label_definition_id;
        text = ann.text;
        span = {
          start_page_num: ann.start_page_num,
          start_char: ann.start_char,
          end_page_num: ann.end_page_num,
          end_char: ann.end_char,
        };
      }

      api
        .suggestAttributes(labelId, {
          document_id: documentId,
          label_definition_id: labelId,
          text,
          ...(span ?? {}),
        })
        .then((res) => {
          setPopover((cur) => {
            if (!cur || (cur.kind !== "picker-attrs" && cur.kind !== "editor")) return cur;
            const merged = { ...cur.values };
            for (const sa of res.attributes) {
              merged[sa.attribute_def_id] = sa.value;
            }
            return {
              ...cur,
              values: merged,
              suggestionId: res.suggestion_id,
              suggesting: false,
              suggestError: null,
            };
          });
        })
        .catch((err) => {
          setPopover((cur) => {
            if (!cur || (cur.kind !== "picker-attrs" && cur.kind !== "editor")) return cur;
            return { ...cur, suggesting: false, suggestError: String(err) };
          });
        });

      return { ...prev, suggesting: true, suggestError: null };
    });
  }, [pagesByNum, annotations, documentId]);

  const runDetectStructure = useCallback(() => {
    setDetectModal({ kind: "loading" });
    api
      .detectStructure(documentId)
      .then((res) => {
        setDetectModal({
          kind: "result",
          model: res.model,
          sections: res.sections,
        });
      })
      .catch((err) => {
        setDetectModal({ kind: "error", message: String(err) });
      });
  }, [documentId]);

  // ---------- Pre-label: scope-label workflow (clauses + instruments) -----

  /** Pick the project's scope labels that drive the CI workflow.
   *
   * Convention: the project has two `is_scope` labels — one for clauses
   * (no enum attribute) and one for instruments (an enum attribute that
   * enumerates the Ranking values). Returning null means the project
   * isn't set up for this flow yet — the button is disabled in that case.
   */
  const scopeLabelsForCI = useMemo(() => {
    const scopes = labels.filter((l) => l.is_scope);
    let clauseLabel: Label | null = null;
    let instrumentLabel: Label | null = null;
    let rankingAttrId: number | null = null;
    for (const s of scopes) {
      const enumAttr = s.attributes.find((a) => a.value_type === "enum");
      if (enumAttr && instrumentLabel === null) {
        instrumentLabel = s;
        rankingAttrId = enumAttr.id;
      } else if (!enumAttr && clauseLabel === null) {
        clauseLabel = s;
      }
    }
    if (!clauseLabel || !instrumentLabel || rankingAttrId === null) {
      return null;
    }
    return { clauseLabel, instrumentLabel, rankingAttrId };
  }, [labels]);

  // ---------- Auto-label (bulk Sonnet, writes annotations directly) -----

  const runAutoLabel = useCallback((tier: AutoLabelTier) => {
    if (!doc) return;
    if (autoLabel?.running) return;
    const cfg = scopeLabelsForCI;
    if (!cfg) return;
    if (tier === "claude" && !llmProviders?.claude.available) return;
    const confirmMsg = tier === "regex"
      ? `Regex auto-label will segment the T&C with a simple regex and ` +
        `write one Clause annotation per top-level numbered clause. ` +
        `No instruments at this tier — escalate to Sonnet for those. ` +
        `The document will be marked "unverified" until you review it. ` +
        `Continue?`
      : `Sonnet auto-label will run Sonnet across every numbered clause in ` +
        `the T&C section and write Clause + Instrument annotations directly. ` +
        `The document will be marked "unverified" until you review it. ` +
        `Continue?`;
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) return;
    setAutoLabel({
      running: true,
      clausesDone: 0,
      clausesTotal: 0,
      lastHeading: null,
      model: null,
      error: null,
    });
    void api
      .autoLabelDocumentStream(
        documentId,
        {
          clause_label_id: cfg.clauseLabel.id,
          instrument_label_id: cfg.instrumentLabel.id,
          instrument_ranking_attribute_id: cfg.rankingAttrId,
          tier,
        },
        (event) => {
          setAutoLabel((cur) => {
            if (!cur) return cur;
            if (event.type === "started") {
              return {
                ...cur,
                model: event.model,
                clausesTotal: event.clauses_total,
              };
            }
            if (event.type === "clause_done") {
              return {
                ...cur,
                clausesDone: event.clauses_done,
                clausesTotal: event.clauses_total,
                lastHeading: `${event.number}. ${event.heading}`,
              };
            }
            if (event.type === "error") {
              return { ...cur, running: false, error: event.message };
            }
            if (event.type === "done") {
              return { ...cur, running: false };
            }
            return cur;
          });
        },
      )
      .then(() => {
        // Refetch annotations + document so the new annotations show in the
        // viewer and the review_status pill updates.
        Promise.all([
          api.listAnnotations(documentId),
          api.getDocument(documentId),
        ]).then(([anns, freshDoc]) => {
          setAnnotations(anns);
          setDoc(freshDoc);
        });
      })
      .catch((err) => {
        setAutoLabel((cur) =>
          cur ? { ...cur, running: false, error: String(err) } : cur,
        );
      })
      .finally(() => {
        setAutoLabel((cur) => (cur && cur.running ? { ...cur, running: false } : cur));
      });
  }, [
    doc,
    documentId,
    autoLabel?.running,
    scopeLabelsForCI,
    llmProviders?.claude.available,
  ]);

  const markReviewed = useCallback(() => {
    if (!doc) return;
    api
      .updateDocument(doc.id, { review_status: "reviewed" })
      .then((updated) => setDoc(updated))
      .catch((err) => {
        window.alert(`Could not mark reviewed: ${err}`);
      });
  }, [doc]);

  const openPrelabelCIModal = useCallback(() => {
    if (!doc) return;
    const defaultProvider: LlmProvider = llmProviders?.claude.available
      ? "claude"
      : "ollama";
    setPrelabelModal({
      mode: "ci",
      startPage: 1,
      endPage: doc.page_count,
      selectedLabels: new Set(),
      candidates: [],
      running: false,
      error: null,
      lastModel: null,
      lastPagesScanned: 0,
      progress: null,
      tncRanges: null,
      detecting: true,
      provider: defaultProvider,
    });

    api
      .getTncRanges(documentId)
      .then((ranges) => {
        setPrelabelModal((prev) => {
          if (!prev || prev.mode !== "ci") return prev;
          const next: PrelabelState = { ...prev, tncRanges: ranges, detecting: false };
          if (ranges.length > 0) {
            next.startPage = ranges[0].start_page_num;
            next.endPage = ranges[ranges.length - 1].end_page_num;
          }
          return next;
        });
      })
      .catch((err) => {
        setPrelabelModal((prev) =>
          prev && prev.mode === "ci"
            ? { ...prev, detecting: false, error: String(err) }
            : prev,
        );
      });

    api
      .listDocumentSuggestions(documentId, "pending")
      .then((existing) => {
        setPrelabelModal((prev) => {
          if (!prev || prev.mode !== "ci") return prev;
          const seeded: PrelabelCandidate[] = existing
            .filter(
              (s) =>
                s.start_page_num !== null &&
                s.start_char !== null &&
                s.end_page_num !== null &&
                s.end_char !== null,
            )
            .map((s) => ({
              suggestion_id: s.id,
              label_definition_id: s.label_definition_id,
              start_page_num: s.start_page_num as number,
              start_char: s.start_char as number,
              end_page_num: s.end_page_num as number,
              end_char: s.end_char as number,
              text: s.text,
              confidence: s.confidence,
              suggested_attributes: s.suggested_attributes,
            }));
          return { ...prev, candidates: seeded };
        });
      })
      .catch(() => {
        // Non-fatal — existing-suggestion seeding is a courtesy.
      });
  }, [doc, documentId]);

  const runPrelabelCI = useCallback(() => {
    if (!prelabelModal || prelabelModal.mode !== "ci") return;
    if (prelabelModal.running) return;
    const cfg = scopeLabelsForCI;
    if (!cfg) {
      setPrelabelModal((cur) =>
        cur
          ? {
              ...cur,
              error:
                "Project needs two scope labels (one with an enum attribute) before this flow runs.",
            }
          : cur,
      );
      return;
    }

    const useRange =
      !prelabelModal.tncRanges || prelabelModal.tncRanges.length === 0;
    const provider: LlmProvider = prelabelModal.provider ?? "ollama";
    const body = useRange
      ? {
          clause_label_id: cfg.clauseLabel.id,
          instrument_label_id: cfg.instrumentLabel.id,
          instrument_ranking_attribute_id: cfg.rankingAttrId,
          start_page_num: prelabelModal.startPage,
          end_page_num: prelabelModal.endPage,
          provider,
        }
      : {
          clause_label_id: cfg.clauseLabel.id,
          instrument_label_id: cfg.instrumentLabel.id,
          instrument_ranking_attribute_id: cfg.rankingAttrId,
          provider,
        };

    setPrelabelModal((cur) =>
      cur
        ? {
            ...cur,
            running: true,
            error: null,
            progress: { done: 0, total: 0 },
          }
        : cur,
    );

    void api
      .prelabelClausesInstrumentsStream(documentId, body, (event) => {
        setPrelabelModal((cur) => {
          if (!cur) return cur;
          if (event.type === "started") {
            return {
              ...cur,
              lastModel: event.model,
              progress: { done: 0, total: event.total_pages },
            };
          }
          if (event.type === "page_done") {
            const seen = new Set(cur.candidates.map((c) => c.suggestion_id));
            const merged = [
              ...cur.candidates,
              ...event.candidates.filter((c) => !seen.has(c.suggestion_id)),
            ];
            return {
              ...cur,
              candidates: merged,
              progress: { done: event.pages_done, total: event.pages_total },
              lastPagesScanned: event.pages_done,
            };
          }
          if (event.type === "error") {
            return { ...cur, running: false, error: event.message };
          }
          if (event.type === "done") {
            return { ...cur, running: false };
          }
          return cur;
        });
      })
      .catch((err) => {
        setPrelabelModal((cur) =>
          cur ? { ...cur, running: false, error: String(err) } : cur,
        );
      })
      .finally(() => {
        setPrelabelModal((cur) =>
          cur && cur.running ? { ...cur, running: false } : cur,
        );
      });
  }, [prelabelModal, scopeLabelsForCI, documentId]);

  // ---------- Pre-label (clause discovery) -------------------------------
  const openPrelabelModal = useCallback(() => {
    if (!doc) return;
    const start = currentPage;
    const end = Math.min(doc.page_count, currentPage + 9);
    // Default scope: every leaf label in the project (most specific picks).
    const childIds = new Set<number>();
    for (const l of labels) {
      if (l.parent_id !== null) childIds.add(l.parent_id);
    }
    const leafIds = labels
      .filter((l) => !childIds.has(l.id))
      .map((l) => l.id);
    setPrelabelModal({
      mode: "labels",
      startPage: start,
      endPage: end,
      selectedLabels: new Set(leafIds),
      candidates: [],
      running: false,
      error: null,
      lastModel: null,
      lastPagesScanned: 0,
      progress: null,
    });
    api
      .listDocumentSuggestions(documentId, "pending")
      .then((existing) => {
        setPrelabelModal((prev) => {
          if (!prev) return prev;
          const seeded: PrelabelCandidate[] = existing
            .filter(
              (s) =>
                s.start_page_num !== null &&
                s.start_char !== null &&
                s.end_page_num !== null &&
                s.end_char !== null,
            )
            .map((s) => ({
              suggestion_id: s.id,
              label_definition_id: s.label_definition_id,
              start_page_num: s.start_page_num as number,
              start_char: s.start_char as number,
              end_page_num: s.end_page_num as number,
              end_char: s.end_char as number,
              text: s.text,
              confidence: s.confidence,
            }));
          return { ...prev, candidates: seeded };
        });
      })
      .catch((err) => {
        setPrelabelModal((prev) =>
          prev ? { ...prev, error: String(err) } : prev,
        );
      });
  }, [doc, currentPage, labels, documentId]);

  const runPrelabelScan = useCallback(() => {
    // Side effects (the fetch) MUST live outside setState updaters — React
    // StrictMode invokes updaters twice in dev to surface impurities, and
    // a side effect inside one fires the request twice (concurrent SQLite
    // writers → "database is locked").
    if (!prelabelModal) return;
    if (prelabelModal.running) return;
    if (prelabelModal.selectedLabels.size === 0) {
      setPrelabelModal((cur) =>
        cur ? { ...cur, error: "Pick at least one label to scan for." } : cur,
      );
      return;
    }
    const startPage = prelabelModal.startPage;
    const endPage = prelabelModal.endPage;
    const labelIds = Array.from(prelabelModal.selectedLabels);

    setPrelabelModal((cur) =>
      cur
        ? {
            ...cur,
            running: true,
            error: null,
            progress: { done: 0, total: 0 },
          }
        : cur,
    );

    void api
      .prelabelDocumentStream(
        documentId,
        {
          start_page_num: startPage,
          end_page_num: endPage,
          label_definition_ids: labelIds,
        },
        (event) => {
          setPrelabelModal((cur) => {
            if (!cur) return cur;
            if (event.type === "started") {
              return {
                ...cur,
                lastModel: event.model,
                progress: { done: 0, total: event.total_pages },
              };
            }
            if (event.type === "page_done") {
              const seen = new Set(cur.candidates.map((c) => c.suggestion_id));
              const merged = [
                ...cur.candidates,
                ...event.candidates.filter((c) => !seen.has(c.suggestion_id)),
              ];
              return {
                ...cur,
                candidates: merged,
                progress: {
                  done: event.pages_done,
                  total: event.pages_total,
                },
                lastPagesScanned: event.pages_done,
              };
            }
            if (event.type === "error") {
              return { ...cur, running: false, error: event.message };
            }
            if (event.type === "done") {
              return { ...cur, running: false };
            }
            return cur;
          });
        },
      )
      .catch((err) => {
        setPrelabelModal((cur) =>
          cur ? { ...cur, running: false, error: String(err) } : cur,
        );
      })
      .finally(() => {
        setPrelabelModal((cur) =>
          cur && cur.running ? { ...cur, running: false } : cur,
        );
      });
  }, [prelabelModal, documentId]);

  const acceptCandidate = useCallback(
    (suggestionId: number) => {
      api
        .acceptSuggestion(suggestionId)
        .then((created) => {
          setAnnotations((prev) => [...prev, created]);
          setPrelabelModal((cur) =>
            cur
              ? {
                  ...cur,
                  candidates: cur.candidates.filter(
                    (c) => c.suggestion_id !== suggestionId,
                  ),
                }
              : cur,
          );
        })
        .catch((err) => {
          setPrelabelModal((cur) =>
            cur ? { ...cur, error: String(err) } : cur,
          );
        });
    },
    [],
  );

  const rejectCandidate = useCallback((suggestionId: number) => {
    api
      .rejectSuggestion(suggestionId)
      .then(() => {
        setPrelabelModal((cur) =>
          cur
            ? {
                ...cur,
                candidates: cur.candidates.filter(
                  (c) => c.suggestion_id !== suggestionId,
                ),
              }
            : cur,
        );
      })
      .catch((err) => {
        setPrelabelModal((cur) =>
          cur ? { ...cur, error: String(err) } : cur,
        );
      });
  }, []);

  const jumpToCandidate = useCallback((c: PrelabelCandidate) => {
    setSearchHighlight({
      pageNum: c.start_page_num,
      charStart: c.start_char,
      charEnd: c.end_char,
    });
    scrollToPage(c.start_page_num);
    // scrollToPage is captured fresh each render via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) {
    return <div>Loading document…</div>;
  }

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  const annotationsClickable =
    !drag &&
    !popover &&
    !handleDrag &&
    !spanConfirm &&
    resizingAnnotationId === null;

  // Per-page selection slice for highlighting active drag / awaiting picker.
  const liveRange: CrossPageRange | null =
    drag ??
    (popover && popover.kind !== "editor" ? popover.range : null);

  return (
    <>
      <div className="viewer-toolbar">
        <strong>{doc.filename}</strong>
        <span className="doc-meta">{doc.page_count} pages</span>
        <span className="doc-meta">· {annotations.length} annotations</span>
        <div style={{ flex: 1 }} />
        <button
          className="btn ghost btn-xs"
          onClick={() => setSearchOpen((v) => !v)}
          title="Search document text"
        >
          🔍 {searchOpen ? "Close search" : "Search"}
        </button>
        <button
          className="btn ghost btn-xs"
          onClick={runDetectStructure}
          title="Use Ollama to find the section structure of this document"
        >
          🪄 Detect structure
        </button>
        <button
          className="btn ghost btn-xs"
          onClick={openPrelabelModal}
          title="Use Ollama to propose annotations across a page range"
        >
          🪄 Pre-label
        </button>
        <button
          className="btn ghost btn-xs"
          onClick={openPrelabelCIModal}
          disabled={scopeLabelsForCI === null}
          title={
            scopeLabelsForCI === null
              ? "Needs two scope labels (one with an enum attribute) in this project"
              : "Auto-find Terms & Conditions, then suggest one Clause per numbered clause and one Instrument per ranking section"
          }
        >
          🪄 Pre-label clauses + instruments
        </button>
        <button
          className="btn ghost btn-xs"
          onClick={() => runAutoLabel("regex")}
          disabled={scopeLabelsForCI === null || autoLabel?.running === true}
          title={
            scopeLabelsForCI === null
              ? "Needs two scope labels (one with an enum attribute) in this project"
              : "Tier 1: segment T&C with regex, write one Clause annotation per numbered clause. No instruments, no LLM call. Free, instant."
          }
        >
          {autoLabel?.running && autoLabel.model === "regex-only"
            ? `Auto-labelling… ${autoLabel.clausesDone}/${autoLabel.clausesTotal}`
            : "🪄 Auto-label (regex)"}
        </button>
        <button
          className="btn ghost btn-xs"
          onClick={() => runAutoLabel("claude")}
          disabled={
            scopeLabelsForCI === null ||
            !llmProviders?.claude.available ||
            autoLabel?.running === true
          }
          title={
            !llmProviders?.claude.available
              ? "Needs LABELLEX_ANTHROPIC_API_KEY on the server"
              : scopeLabelsForCI === null
              ? "Needs two scope labels (one with an enum attribute) in this project"
              : "Tier 3 escalation: same regex segmentation, plus one Sonnet call per clause to detect Instrument markers."
          }
        >
          {autoLabel?.running && autoLabel.model !== "regex-only"
            ? `Auto-labelling… ${autoLabel.clausesDone}/${autoLabel.clausesTotal}`
            : "🪄 Auto-label (Sonnet)"}
        </button>
        {doc?.review_status === "unverified" && (
          <button
            className="btn btn-xs"
            onClick={markReviewed}
            title="Confirm this document's auto-labels are accurate enough to publish"
            style={{ background: "#16a34a", borderColor: "#16a34a", color: "white" }}
          >
            Mark as reviewed
          </button>
        )}
        {doc?.review_status === "unverified" && (
          <span
            className="pill"
            style={{
              background: "#fef3c7",
              color: "#92400e",
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
            }}
          >
            UNVERIFIED
          </span>
        )}
        <button
          className="btn ghost btn-xs"
          onClick={() => setShowPanel((v) => !v)}
          title="Toggle annotation panel"
        >
          {showPanel ? "Hide list" : "Show list"}
        </button>
        <button
          className="btn ghost"
          disabled={currentPage <= 1}
          onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
          title="Previous page (←)"
        >
          ◀ Prev
        </button>
        <span>
          Page{" "}
          <input
            type="number"
            min={1}
            max={doc.page_count}
            value={currentPage}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n <= doc.page_count) {
                scrollToPage(n);
              }
            }}
          />{" "}
          / {doc.page_count}
        </span>
        <button
          className="btn ghost"
          disabled={currentPage >= doc.page_count}
          onClick={() => scrollToPage(Math.min(doc.page_count, currentPage + 1))}
          title="Next page (→)"
        >
          Next ▶
        </button>
        <input
          type="range"
          min={1}
          max={doc.page_count}
          value={currentPage}
          onChange={(e) => scrollToPage(Number(e.target.value))}
          className="page-slider"
          title="Jump to page"
        />
      </div>

      {autoLabel?.error && (
        <div className="error-banner" style={{ margin: "8px 0" }}>
          Auto-label failed: {autoLabel.error}{" "}
          <button
            className="btn ghost btn-xs"
            onClick={() => setAutoLabel(null)}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}

      {autoLabel?.running && autoLabel.clausesTotal > 0 && (
        <div
          style={{
            margin: "8px 0",
            padding: "8px 12px",
            borderRadius: 6,
            background: "#0f172a",
            color: "#cbd5e1",
            fontSize: 13,
          }}
        >
          Auto-labelling with{" "}
          <code>{autoLabel.model ?? "claude-sonnet-4-6"}</code> ·{" "}
          {autoLabel.clausesDone} of {autoLabel.clausesTotal} clauses
          {autoLabel.lastHeading && (
            <>
              {" "}· last: <em>{autoLabel.lastHeading}</em>
            </>
          )}
          <progress
            max={autoLabel.clausesTotal || 1}
            value={autoLabel.clausesDone}
            style={{ width: "100%", marginTop: 4 }}
          />
        </div>
      )}

      {searchOpen && (
        <div className="viewer-search">
          <div className="viewer-search-row">
            <input
              type="text"
              placeholder="Search the document text…"
              value={searchQuery}
              autoFocus
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <span className="search-meta">
              {searchBusy
                ? "searching…"
                : searchQuery.trim().length < 2
                  ? "type at least 2 characters"
                  : `${searchResults.length} hits`}
            </span>
            <button
              className="btn ghost btn-xs"
              onClick={() => {
                setSearchQuery("");
                setSearchResults([]);
                setSearchHighlight(null);
              }}
            >
              clear
            </button>
            <button
              className="btn ghost btn-xs"
              onClick={() => {
                setSearchOpen(false);
                setSearchHighlight(null);
              }}
            >
              close ✕
            </button>
          </div>
          {searchQuery.trim().length >= 2 && !searchBusy && searchResults.length === 0 && (
            <div className="search-empty">No matches.</div>
          )}
          {searchResults.length > 0 && (
            <ul className="search-results">
              {searchResults.map((hit) => {
                const key = `${hit.page_num}:${hit.char_start}`;
                const before = hit.snippet.slice(0, hit.match_in_snippet);
                const matchLen = hit.char_end - hit.char_start;
                const matchEnd = hit.match_in_snippet + matchLen;
                const matched = hit.snippet.slice(hit.match_in_snippet, matchEnd);
                const after = hit.snippet.slice(matchEnd);
                return (
                  <li
                    key={key}
                    className={`search-result${activeHitKey === key ? " active" : ""}`}
                    onClick={() => jumpToHit(hit)}
                  >
                    <span className="ann-page">p.{hit.page_num}</span>
                    <span className="search-result-snippet">
                      {before}
                      <mark>{matched}</mark>
                      {after}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {resizingAnnotationId !== null && (
        <div className="resize-banner">
          <span>
            Adjusting span — drag the start or end handle to redefine.
            Esc to cancel.
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost btn-xs"
            onClick={() => {
              setResizingAnnotationId(null);
              setHandleDrag(null);
              handleDragRef.current = null;
              setSpanConfirm(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="viewer-layout">
        <div className="viewer-pdf-area" ref={setScrollContainer}>
          {pdf && pages.length > 0 ? (
            pages.map((p) => {
              const isActive = activePages.has(p.page_num) || visiblePages.has(p.page_num);
              const annotationsOnPage =
                annotationsByPageForRender.get(p.page_num) ?? [];
              const selectionRange = liveRange
                ? pageSelectionSlice(p.page_num, p.words.length, liveRange)
                : null;
              const sh =
                searchHighlight && searchHighlight.pageNum === p.page_num
                  ? {
                      charStart: searchHighlight.charStart,
                      charEnd: searchHighlight.charEnd,
                    }
                  : null;
              return (
                <PdfPage
                  key={p.page_num}
                  pdf={pdf}
                  page={p}
                  scale={SCALE}
                  active={isActive}
                  labels={labels}
                  annotationsOnPage={annotationsOnPage}
                  selectionRange={selectionRange}
                  searchHighlight={sh}
                  resizingAnnotationId={resizingAnnotationId}
                  annotationsClickable={annotationsClickable}
                  registerWrapper={registerWrapper}
                  onWordPointerDown={onWordPointerDown}
                  onWordPointerEnter={onWordPointerEnter}
                  onAnnotationClick={onAnnotationClick}
                  onHandlePointerDown={onHandlePointerDown}
                  attrDefById={attrDefById}
                />
              );
            })
          ) : (
            <div className="empty-state">Loading document…</div>
          )}
        </div>
        {showPanel && (
          <AnnotationListPanel
            annotations={annotations}
            labels={labels}
            currentPage={currentPage}
            onJumpTo={(pageNum, annId) => jumpToAnnotation(pageNum, annId)}
            onEdit={(annId, anchor) => {
              const ann = annotations.find((a) => a.id === annId);
              if (!ann) return;
              const values: Record<number, unknown> = {};
              for (const av of ann.attributes) values[av.attribute_def_id] = av.value;
              setPopover({
                kind: "editor",
                annotationId: annId,
                values,
                suggestionId: null,
                suggesting: false,
                suggestError: null,
                x: anchor.x,
                y: anchor.y,
              });
            }}
            onDelete={(annId) => {
              api
                .deleteAnnotation(annId)
                .then(() =>
                  setAnnotations((prev) => prev.filter((a) => a.id !== annId)),
                )
                .catch((err) => setError(String(err)));
            }}
          />
        )}
      </div>

      {/* Detect-structure modal */}
      {detectModal && (
        <div className="modal-backdrop" onClick={() => setDetectModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Detected document structure</h2>
              <span style={{ flex: 1 }} />
              <button className="btn ghost btn-xs" onClick={() => setDetectModal(null)}>
                close ✕
              </button>
            </div>
            {detectModal.kind === "loading" && (
              <div style={{ padding: 24, textAlign: "center", color: "#475569" }}>
                Analysing the document with Ollama — this can take 10–60 seconds
                depending on the model.
              </div>
            )}
            {detectModal.kind === "error" && (
              <div className="error-banner">
                <strong>Detection failed.</strong>
                <div style={{ marginTop: 6, fontSize: 12 }}>{detectModal.message}</div>
                <div style={{ marginTop: 10, fontSize: 12, color: "#7f1d1d" }}>
                  Make sure Ollama is running and the configured model is pulled.
                  See <code>CLAUDE.md</code> for setup instructions.
                </div>
              </div>
            )}
            {detectModal.kind === "result" && (
              <>
                <div style={{ color: "#64748b", fontSize: 12, marginBottom: 8 }}>
                  Model: <code>{detectModal.model}</code> · {detectModal.sections.length} section(s)
                </div>
                {detectModal.sections.length === 0 ? (
                  <div className="empty-state" style={{ padding: 16 }}>
                    No sections detected. The PDF outline may be empty and the
                    text-TOC fallback didn't find a "TABLE OF CONTENTS" page.
                  </div>
                ) : (
                  <ul className="detected-list">
                    {detectModal.sections.map((s, i) => {
                      const cls =
                        "section-type kind-" +
                        s.section_type.replace(/_/g, "-");
                      return (
                        <li key={i}>
                          <span className="ann-page">p.{s.page_num}</span>
                          <span className="title">{s.title}</span>
                          <span className={cls}>{s.section_type}</span>
                          <button
                            className="btn ghost btn-xs"
                            onClick={() => {
                              scrollToPage(s.page_num);
                              setDetectModal(null);
                            }}
                          >
                            jump
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Pre-label modal */}
      {prelabelModal && doc && (
        <div className="modal-backdrop" onClick={() => setPrelabelModal(null)}>
          <div
            className="modal prelabel-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>
                {prelabelModal.mode === "ci"
                  ? "Pre-label clauses + instruments"
                  : "Pre-label clauses"}
              </h2>
              <span style={{ flex: 1 }} />
              <button
                className="btn ghost btn-xs"
                onClick={() => setPrelabelModal(null)}
              >
                close ✕
              </button>
            </div>

            {prelabelModal.mode === "ci" && (
              <div
                style={{
                  margin: "0 0 10px",
                  padding: "8px 12px",
                  borderRadius: 6,
                  background: "#0f172a",
                  color: "#cbd5e1",
                  fontSize: 13,
                }}
              >
                {prelabelModal.detecting ? (
                  "Detecting Terms & Conditions section…"
                ) : prelabelModal.tncRanges &&
                  prelabelModal.tncRanges.length > 0 ? (
                  <>
                    Found{" "}
                    <strong>{prelabelModal.tncRanges.length}</strong> T&C
                    section{prelabelModal.tncRanges.length === 1 ? "" : "s"}:
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {prelabelModal.tncRanges.map((r, idx) => (
                        <li key={idx}>
                          p.{r.start_page_num}–{r.end_page_num} · {r.title}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    No T&C section detected from the document outline —
                    pick a page range manually below.
                  </>
                )}
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid #1e293b",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>Provider:</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="radio"
                      name="ci-provider"
                      value="ollama"
                      checked={prelabelModal.provider === "ollama"}
                      onChange={() =>
                        setPrelabelModal((prev) =>
                          prev ? { ...prev, provider: "ollama" } : prev,
                        )
                      }
                    />
                    Ollama
                    {llmProviders?.ollama.model && (
                      <span style={{ color: "#64748b" }}>
                        ({llmProviders.ollama.model})
                      </span>
                    )}
                  </label>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      opacity: llmProviders?.claude.available ? 1 : 0.4,
                    }}
                  >
                    <input
                      type="radio"
                      name="ci-provider"
                      value="claude"
                      checked={prelabelModal.provider === "claude"}
                      disabled={!llmProviders?.claude.available}
                      onChange={() =>
                        setPrelabelModal((prev) =>
                          prev ? { ...prev, provider: "claude" } : prev,
                        )
                      }
                    />
                    Claude
                    {llmProviders?.claude.model && (
                      <span style={{ color: "#64748b" }}>
                        ({llmProviders.claude.model})
                      </span>
                    )}
                    {!llmProviders?.claude.available && (
                      <span style={{ color: "#94a3b8", fontStyle: "italic" }}>
                        — set LABELLEX_ANTHROPIC_API_KEY
                      </span>
                    )}
                  </label>
                </div>
              </div>
            )}

            <div className="prelabel-form">
              <div className="prelabel-form-row">
                <label>Pages</label>
                <input
                  type="number"
                  min={1}
                  max={doc.page_count}
                  value={prelabelModal.startPage}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) {
                      setPrelabelModal((prev) =>
                        prev ? { ...prev, startPage: Math.max(1, n) } : prev,
                      );
                    }
                  }}
                />
                <span style={{ color: "#94a3b8" }}>–</span>
                <input
                  type="number"
                  min={prelabelModal.startPage}
                  max={doc.page_count}
                  value={prelabelModal.endPage}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) {
                      setPrelabelModal((prev) =>
                        prev
                          ? {
                              ...prev,
                              endPage: Math.min(doc.page_count, n),
                            }
                          : prev,
                      );
                    }
                  }}
                />
                <span style={{ color: "#64748b", fontSize: 12 }}>
                  of {doc.page_count}
                </span>
              </div>

              {prelabelModal.mode === "labels" && (
                <div
                  className="prelabel-form-row"
                  style={{ alignItems: "flex-start" }}
                >
                  <label style={{ paddingTop: 4 }}>Labels</label>
                  <div className="prelabel-label-grid">
                    {labels.map((l) => {
                      const checked = prelabelModal.selectedLabels.has(l.id);
                      return (
                        <label key={l.id} className="prelabel-label-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setPrelabelModal((prev) => {
                                if (!prev) return prev;
                                const next = new Set(prev.selectedLabels);
                                if (e.target.checked) next.add(l.id);
                                else next.delete(l.id);
                                return { ...prev, selectedLabels: next };
                              });
                            }}
                          />
                          <span
                            className="label-swatch"
                            style={{ background: l.color }}
                          />
                          <span>{l.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="prelabel-form-row" style={{ justifyContent: "flex-end" }}>
                {prelabelModal.mode === "labels" && (
                  <>
                    <button
                      className="btn ghost btn-xs"
                      onClick={() => {
                        setPrelabelModal((prev) =>
                          prev
                            ? {
                                ...prev,
                                selectedLabels: new Set(labels.map((l) => l.id)),
                              }
                            : prev,
                        );
                      }}
                    >
                      select all
                    </button>
                    <button
                      className="btn ghost btn-xs"
                      onClick={() => {
                        setPrelabelModal((prev) =>
                          prev ? { ...prev, selectedLabels: new Set() } : prev,
                        );
                      }}
                    >
                      clear
                    </button>
                  </>
                )}
                <span style={{ flex: 1 }} />
                <button
                  className="btn"
                  disabled={
                    prelabelModal.running ||
                    (prelabelModal.mode === "labels" &&
                      prelabelModal.selectedLabels.size === 0) ||
                    (prelabelModal.mode === "ci" && prelabelModal.detecting === true)
                  }
                  onClick={
                    prelabelModal.mode === "ci" ? runPrelabelCI : runPrelabelScan
                  }
                >
                  {prelabelModal.running ? "scanning…" : "Run scan"}
                </button>
              </div>
            </div>

            {prelabelModal.error && (
              <div className="error-banner" style={{ margin: "10px 0" }}>
                {prelabelModal.error}
              </div>
            )}

            {prelabelModal.running && prelabelModal.progress && (
              <div className="prelabel-progress">
                <div className="prelabel-progress-meta">
                  {prelabelModal.progress.total > 0 ? (
                    <>
                      Scanning page{" "}
                      <strong>
                        {Math.min(
                          prelabelModal.progress.done + 1,
                          prelabelModal.progress.total,
                        )}
                      </strong>{" "}
                      of {prelabelModal.progress.total} ·{" "}
                      {prelabelModal.candidates.length} candidate
                      {prelabelModal.candidates.length === 1 ? "" : "s"} so far
                    </>
                  ) : (
                    "Connecting to Ollama…"
                  )}
                </div>
                <progress
                  max={prelabelModal.progress.total || 1}
                  value={prelabelModal.progress.done}
                />
              </div>
            )}

            {(prelabelModal.lastModel || prelabelModal.candidates.length > 0) && (
              <div style={{ color: "#64748b", fontSize: 12, margin: "10px 0 4px" }}>
                {prelabelModal.lastModel && (
                  <>
                    Model: <code>{prelabelModal.lastModel}</code> ·{" "}
                    {prelabelModal.lastPagesScanned} page(s) scanned ·{" "}
                  </>
                )}
                {prelabelModal.candidates.length} pending candidate
                {prelabelModal.candidates.length === 1 ? "" : "s"}
              </div>
            )}

            {prelabelModal.candidates.length > 0 && (
              <ul className="candidate-list">
                {prelabelModal.candidates.map((c) => {
                  const label = labelById.get(c.label_definition_id);
                  const snippet =
                    c.text.length > 200
                      ? c.text.slice(0, 197) + "…"
                      : c.text;
                  return (
                    <li key={c.suggestion_id}>
                      <div className="candidate-meta">
                        <span className="ann-page">
                          p.{c.start_page_num}
                          {c.end_page_num !== c.start_page_num
                            ? `–${c.end_page_num}`
                            : ""}
                        </span>
                        <span
                          className="candidate-label"
                          style={{
                            background: (label?.color ?? "#1d4ed8") + "22",
                            borderColor: label?.color ?? "#1d4ed8",
                            color: label?.color ?? "#1d4ed8",
                          }}
                        >
                          <span
                            className="label-swatch"
                            style={{ background: label?.color ?? "#1d4ed8" }}
                          />
                          {label?.name ?? `label #${c.label_definition_id}`}
                        </span>
                      </div>
                      <div className="candidate-snippet">"{snippet}"</div>
                      <div className="candidate-actions">
                        <button
                          className="btn ghost btn-xs"
                          onClick={() => jumpToCandidate(c)}
                          title="Scroll to this clause in the PDF (modal stays open)"
                        >
                          jump
                        </button>
                        <button
                          className="btn ghost btn-xs danger"
                          onClick={() => rejectCandidate(c.suggestion_id)}
                        >
                          reject
                        </button>
                        <button
                          className="btn btn-xs"
                          onClick={() => acceptCandidate(c.suggestion_id)}
                        >
                          accept
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {!prelabelModal.running &&
              prelabelModal.candidates.length === 0 &&
              prelabelModal.lastModel !== null && (
                <div className="empty-state" style={{ padding: 16 }}>
                  No clauses matched the selected labels in this page range.
                  Try widening the range or selecting more labels.
                </div>
              )}
          </div>
        </div>
      )}

      {/* Linking-mode banner */}
      {linkingMode && (
        <div className="resize-banner">
          <span>
            {linkingMode.picker
              ? "Pick a relation type, or click a different annotation to retarget. Esc to cancel."
              : "Click another annotation to link from this one. Esc to cancel."}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost btn-xs" onClick={cancelLinking}>
            Cancel
          </button>
        </div>
      )}

      {/* Relation-type picker (rendered while linkingMode.picker is set) */}
      {linkingMode?.picker && (
        <DraggablePopover
          initialX={linkingMode.picker.x}
          initialY={linkingMode.picker.y}
        >
          <div className="picker-title" data-drag-handle>Relation type</div>
          {relationDefs.length === 0 ? (
            <div
              style={{ padding: "6px 8px", fontSize: 12, color: "#94a3b8" }}
            >
              No relation types defined yet. Add them in project settings.
            </div>
          ) : (
            relationDefs.map((rd) => (
              <button
                key={rd.id}
                className="label-row"
                onClick={() => submitRelation(rd.id)}
                title={rd.description ?? undefined}
              >
                <span
                  className="label-swatch"
                  style={{ background: rd.color }}
                />
                <span>{rd.name}</span>
              </button>
            ))
          )}
          <button className="picker-cancel" onClick={cancelLinking}>
            cancel
          </button>
        </DraggablePopover>
      )}

      {/* Span-resize confirmation popup */}
      {spanConfirm && (
        <DraggablePopover initialX={spanConfirm.x} initialY={spanConfirm.y}>
          <div className="picker-title" data-drag-handle>Apply new span?</div>
          <div style={{ padding: "0 8px 8px 8px", fontSize: 12, color: "#475569" }}>
            {spanConfirm.newStart.page === spanConfirm.newEnd.page
              ? `Page ${spanConfirm.newStart.page}`
              : `Pages ${spanConfirm.newStart.page}–${spanConfirm.newEnd.page}`}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "0 4px 4px 4px", justifyContent: "flex-end" }}>
            <button className="btn ghost btn-xs" onClick={cancelSpanConfirm}>
              cancel
            </button>
            <button className="btn btn-xs" onClick={applySpanConfirm}>
              apply
            </button>
          </div>
        </DraggablePopover>
      )}

      {/* Popover (picker / editor) */}
      {popover && (
        <PopoverShell
          popover={popover}
          labels={labels}
          labelById={labelById}
          annotations={annotations}
          attrDefById={attrDefById}
          onCancel={cancelPopover}
          onPickLabel={onPickLabel}
          onAttrsChange={(values) =>
            popover.kind === "picker-attrs"
              ? setPopover({ ...popover, values })
              : popover.kind === "editor"
                ? setPopover({ ...popover, values })
                : null
          }
          onPickerAttrsBack={() =>
            popover.kind === "picker-attrs"
              ? setPopover({
                  kind: "picker-label",
                  range: popover.range,
                  x: popover.x,
                  y: popover.y,
                })
              : null
          }
          onPickerAttrsApply={() => {
            if (popover.kind !== "picker-attrs") return;
            submitNewAnnotation(
              popover.labelId,
              valuesToPayload(popover.values),
              popover.suggestionId,
            );
          }}
          onEditorSave={submitEditor}
          onEditorDelete={deleteFromEditor}
          onEditorResize={startResize}
          onEditorStartLink={startLinkingFromEditor}
          onRequestSuggestion={requestSuggestion}
          relations={relations}
          relationDefs={relationDefs}
          onDeleteRelation={deleteRelationById}
          onJumpToAnnotation={jumpToAnnotation}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers / sub-components
// ---------------------------------------------------------------------------

function buildSpanText(
  pagesByNum: Map<number, PageModel>,
  startPage: number,
  startChar: number,
  endPage: number,
  endChar: number,
): string {
  if (startPage === endPage) {
    const p = pagesByNum.get(startPage);
    return p ? p.text.slice(startChar, endChar) : "";
  }
  const startP = pagesByNum.get(startPage);
  const endP = pagesByNum.get(endPage);
  const middle: string[] = [];
  for (let n = startPage + 1; n < endPage; n++) {
    const p = pagesByNum.get(n);
    if (p) middle.push(p.text.trim());
  }
  return [
    startP?.text.slice(startChar).trim() ?? "",
    ...middle,
    endP?.text.slice(0, endChar).trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function valuesToPayload(values: Record<number, unknown>): AnnotationAttributeIO[] {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => ({ attribute_def_id: Number(k), value: v }));
}

interface LabelNode {
  label: Label;
  children: LabelNode[];
}

function buildLabelTree(labels: Label[]): LabelNode[] {
  const byParent = new Map<number | null, Label[]>();
  for (const l of labels) {
    const arr = byParent.get(l.parent_id);
    if (arr) arr.push(l);
    else byParent.set(l.parent_id, [l]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.id - b.id);
  const build = (parentId: number | null): LabelNode[] =>
    (byParent.get(parentId) ?? []).map((label) => ({
      label,
      children: build(label.id),
    }));
  return build(null);
}

// Fixed-position popover that (a) auto-clamps into the viewport when first
// rendered so the box can't open partly off-screen, and (b) is draggable by
// any element marked with `data-drag-handle`.
function DraggablePopover({
  initialX,
  initialY,
  children,
}: {
  initialX: number;
  initialY: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: initialX, y: initialY });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = initialX;
    let y = initialY;
    if (x + rect.width + margin > vw) x = vw - rect.width - margin;
    if (y + rect.height + margin > vh) y = vh - rect.height - margin;
    if (x < margin) x = margin;
    if (y < margin) y = margin;
    if (x !== initialX || y !== initialY) setPos({ x, y });
    // Run once at mount; the clamp is based on the initial open position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-drag-handle]")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = pos.x;
    const origY = pos.y;
    const onMove = (ev: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = origX + (ev.clientX - startX);
      let ny = origY + (ev.clientY - startY);
      if (nx + rect.width + margin > vw) nx = vw - rect.width - margin;
      if (ny + rect.height + margin > vh) ny = vh - rect.height - margin;
      if (nx < margin) nx = margin;
      if (ny < margin) ny = margin;
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={ref}
      className="label-picker"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  );
}

function LabelPickerTree({
  labels,
  onPick,
}: {
  labels: Label[];
  onPick: (id: number) => void;
}) {
  const tree = useMemo(() => buildLabelTree(labels), [labels]);
  const renderNode = (n: LabelNode, depth: number): JSX.Element => (
    <div key={n.label.id}>
      <button
        className="label-row"
        onClick={() => onPick(n.label.id)}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={n.label.description ?? undefined}
      >
        <span className="label-swatch" style={{ background: n.label.color }} />
        <span style={{ fontWeight: n.children.length > 0 ? 600 : 400 }}>
          {n.label.name}
        </span>
        {n.label.is_scope && (
          <span className="scope-pill" style={{ marginLeft: 6 }}>
            scope
          </span>
        )}
      </button>
      {n.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );
  return <>{tree.map((n) => renderNode(n, 0))}</>;
}

function AttributeInput({
  attr,
  value,
  onChange,
}: {
  attr: AttributeDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (attr.value_type) {
    case "string":
      return (
        <input
          type="text"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === "" ? undefined : Number(v));
          }}
        />
      );
    case "bool":
      return (
        <select
          value={value === undefined ? "" : value ? "true" : "false"}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : e.target.value === "true")
          }
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "date":
      return (
        <input
          type="date"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case "enum":
      return (
        <select
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">—</option>
          {(attr.enum_values ?? []).map((ev) => (
            <option key={ev} value={ev}>
              {ev}
            </option>
          ))}
        </select>
      );
  }
}

function SuggestBar({
  suggesting,
  suggestionId,
  error,
  disabled,
  onClick,
}: {
  suggesting: boolean;
  suggestionId: number | null;
  error: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 6px",
        borderTop: "1px solid #e2e8f0",
        borderBottom: "1px solid #e2e8f0",
        background: "#f8fafc",
        fontSize: 11,
        color: "#475569",
      }}
    >
      <button
        className="btn ghost btn-xs"
        onClick={onClick}
        disabled={disabled || suggesting}
        title="Ask Ollama to propose attribute values for this clause"
      >
        🪄 {suggesting ? "thinking…" : "suggest values"}
      </button>
      <span style={{ flex: 1 }} />
      {error ? (
        <span style={{ color: "#b91c1c" }} title={error}>
          {error.length > 60 ? error.slice(0, 57) + "…" : error}
        </span>
      ) : suggestionId !== null ? (
        <span style={{ color: "#15803d" }}>
          suggestion #{suggestionId} loaded — edit any field to record a correction
        </span>
      ) : null}
    </div>
  );
}

function AttributeFieldsGrid({
  attrs,
  values,
  onChange,
}: {
  attrs: AttributeDefinition[];
  values: Record<number, unknown>;
  onChange: (v: Record<number, unknown>) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "6px 10px",
        padding: "4px 6px 8px 6px",
      }}
    >
      {attrs.map((a) => (
        <div key={a.id} style={{ display: "contents" }}>
          <label
            style={{ fontSize: 12, color: "#334155", alignSelf: "center" }}
            title={a.description ?? undefined}
          >
            {a.name}
            {a.required && <span style={{ color: "#dc2626" }}> *</span>}
            <span style={{ color: "#94a3b8", marginLeft: 6, fontSize: 11 }}>
              {a.value_type}
            </span>
          </label>
          <AttributeInput
            attr={a}
            value={values[a.id]}
            onChange={(v) => onChange({ ...values, [a.id]: v })}
          />
        </div>
      ))}
    </div>
  );
}

function PopoverShell({
  popover,
  labels,
  labelById,
  annotations,
  attrDefById,
  onCancel,
  onPickLabel,
  onAttrsChange,
  onPickerAttrsBack,
  onPickerAttrsApply,
  onEditorSave,
  onEditorDelete,
  onEditorResize,
  onEditorStartLink,
  onRequestSuggestion,
  relations,
  relationDefs,
  onDeleteRelation,
  onJumpToAnnotation,
}: {
  popover: PopoverState;
  labels: Label[];
  labelById: Map<number, Label>;
  annotations: Annotation[];
  attrDefById: Map<number, AttributeDefinition>;
  onCancel: () => void;
  onPickLabel: (id: number) => void;
  onAttrsChange: (v: Record<number, unknown>) => void;
  onPickerAttrsBack: () => void;
  onPickerAttrsApply: () => void;
  onEditorSave: () => void;
  onEditorDelete: () => void;
  onEditorResize: () => void;
  onEditorStartLink: () => void;
  onRequestSuggestion: () => void;
  relations: AnnotationRelation[];
  relationDefs: RelationDefinition[];
  onDeleteRelation: (id: number) => void;
  onJumpToAnnotation: (pageNum: number, annotationId: number) => void;
}) {
  if (popover.kind === "picker-label") {
    return (
      <DraggablePopover initialX={popover.x} initialY={popover.y}>
        <div className="picker-title" data-drag-handle>Apply label</div>
        <LabelPickerTree labels={labels} onPick={onPickLabel} />
        <button className="picker-cancel" onClick={onCancel}>cancel</button>
      </DraggablePopover>
    );
  }

  if (popover.kind === "picker-attrs") {
    const label = labelById.get(popover.labelId);
    if (!label) return null;
    const attrs = effectiveAttributes(label, labelById);
    const missing = attrs.some(
      (a) => a.required && !isValueFilled(popover.values[a.id], a.value_type),
    );
    return (
      <DraggablePopover initialX={popover.x} initialY={popover.y}>
        <div className="picker-title" data-drag-handle>
          <span className="label-swatch" style={{ background: label.color, marginRight: 6 }} />
          {label.name}
        </div>
        <SuggestBar
          suggesting={popover.suggesting}
          suggestionId={popover.suggestionId}
          error={popover.suggestError}
          onClick={onRequestSuggestion}
          disabled={attrs.length === 0}
        />
        <AttributeFieldsGrid attrs={attrs} values={popover.values} onChange={onAttrsChange} />
        <div style={{ display: "flex", gap: 6, justifyContent: "space-between", padding: "6px 4px 0 4px" }}>
          <button className="btn ghost btn-xs" onClick={onPickerAttrsBack}>← back</button>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn ghost btn-xs" onClick={onCancel}>cancel</button>
            <button
              className="btn btn-xs"
              onClick={onPickerAttrsApply}
              disabled={missing}
            >
              apply
            </button>
          </div>
        </div>
      </DraggablePopover>
    );
  }

  // editor
  const ann = annotations.find((a) => a.id === popover.annotationId);
  if (!ann) return null;
  const label = labelById.get(ann.label_definition_id);
  if (!label) return null;
  const attrs = effectiveAttributes(label, labelById);
  const missing = attrs.some(
    (a) => a.required && !isValueFilled(popover.values[a.id], a.value_type),
  );
  const snippet =
    ann.text.length > 80 ? ann.text.slice(0, 77) + "…" : ann.text;
  void attrDefById;
  return (
    <DraggablePopover initialX={popover.x} initialY={popover.y}>
      <div className="picker-title" data-drag-handle>
        <span className="label-swatch" style={{ background: label.color, marginRight: 6 }} />
        {label.name}
        <span
          style={{ marginLeft: 8, fontSize: 11, color: "#94a3b8", fontWeight: 400 }}
        >
          {ann.start_page_num === ann.end_page_num
            ? `p.${ann.start_page_num}`
            : `p.${ann.start_page_num}–${ann.end_page_num}`}
        </span>
      </div>
      <div style={{ padding: "0 6px 8px 6px", color: "#475569", fontSize: 12, fontStyle: "italic", maxWidth: 340 }}>
        “{snippet}”
      </div>
      <SuggestBar
        suggesting={popover.suggesting}
        suggestionId={popover.suggestionId}
        error={popover.suggestError}
        onClick={onRequestSuggestion}
        disabled={attrs.length === 0}
      />
      {attrs.length > 0 ? (
        <AttributeFieldsGrid attrs={attrs} values={popover.values} onChange={onAttrsChange} />
      ) : (
        <div style={{ padding: "0 6px 8px 6px", color: "#94a3b8", fontSize: 12 }}>
          No attributes defined for this label.
        </div>
      )}
      <RelationsSection
        annotationId={ann.id}
        relations={relations}
        relationDefs={relationDefs}
        annotations={annotations}
        labelById={labelById}
        onDeleteRelation={onDeleteRelation}
        onStartLink={onEditorStartLink}
        onJumpToAnnotation={onJumpToAnnotation}
      />
      <div style={{ display: "flex", gap: 6, justifyContent: "space-between", padding: "6px 4px 0 4px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn ghost btn-xs danger" onClick={onEditorDelete}>delete</button>
          <button className="btn ghost btn-xs" onClick={onEditorResize}>edit span</button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn ghost btn-xs" onClick={onCancel}>cancel</button>
          <button
            className="btn btn-xs"
            onClick={onEditorSave}
            disabled={missing}
          >
            save
          </button>
        </div>
      </div>
    </DraggablePopover>
  );
}

function RelationsSection({
  annotationId,
  relations,
  relationDefs,
  annotations,
  labelById,
  onDeleteRelation,
  onStartLink,
  onJumpToAnnotation,
}: {
  annotationId: number;
  relations: AnnotationRelation[];
  relationDefs: RelationDefinition[];
  annotations: Annotation[];
  labelById: Map<number, Label>;
  onDeleteRelation: (id: number) => void;
  onStartLink: () => void;
  onJumpToAnnotation: (pageNum: number, annotationId: number) => void;
}) {
  const annById = new Map(annotations.map((a) => [a.id, a] as const));
  const defById = new Map(relationDefs.map((r) => [r.id, r] as const));
  const relevant = relations.filter(
    (r) =>
      r.from_annotation_id === annotationId ||
      r.to_annotation_id === annotationId,
  );
  return (
    <div className="editor-relations">
      <div className="editor-relations-header">
        <span>Relations</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost btn-xs" onClick={onStartLink}>
          + Link
        </button>
      </div>
      {relevant.length === 0 ? (
        <div className="editor-relations-empty">No relations yet.</div>
      ) : (
        <ul className="editor-relations-list">
          {relevant.map((rel) => {
            const def = defById.get(rel.relation_def_id);
            const isOutgoing = rel.from_annotation_id === annotationId;
            const otherId = isOutgoing
              ? rel.to_annotation_id
              : rel.from_annotation_id;
            const other = annById.get(otherId);
            const otherLabel = other
              ? labelById.get(other.label_definition_id)
              : undefined;
            const snippet = other
              ? other.text.length > 40
                ? other.text.slice(0, 37) + "…"
                : other.text
              : `(annotation #${otherId} not on this document)`;
            return (
              <li key={rel.id} className="editor-relation-row">
                <span className="rel-arrow">{isOutgoing ? "→" : "←"}</span>
                <span
                  className="rel-type"
                  style={{
                    background: (def?.color ?? "#64748b") + "22",
                    color: def?.color ?? "#64748b",
                    borderColor: def?.color ?? "#64748b",
                  }}
                >
                  {def?.name ?? `type #${rel.relation_def_id}`}
                </span>
                <button
                  className="rel-target"
                  onClick={() =>
                    other && onJumpToAnnotation(other.start_page_num, other.id)
                  }
                  title={otherLabel?.name ?? undefined}
                >
                  {other && (
                    <span
                      className="label-swatch"
                      style={{ background: otherLabel?.color ?? "#1d4ed8" }}
                    />
                  )}
                  <span className="rel-snippet">"{snippet}"</span>
                  {other && (
                    <span className="rel-page">p.{other.start_page_num}</span>
                  )}
                </button>
                <button
                  className="rel-delete"
                  onClick={() => onDeleteRelation(rel.id)}
                  title="Remove this relation"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
