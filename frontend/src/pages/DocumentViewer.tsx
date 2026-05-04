import {
  useCallback,
  useEffect,
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
  AttributeDefinition,
  DetectedSection,
  Document as DocModel,
  Label,
  Page as PageModel,
  PrelabelCandidate,
  SearchHit,
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

  // Ollama-driven clause discovery (pre-labelling).
  interface PrelabelState {
    startPage: number;
    endPage: number;
    selectedLabels: Set<number>;
    candidates: PrelabelCandidate[];
    running: boolean;
    error: string | null;
    lastModel: string | null;
    lastPagesScanned: number;
    progress: { done: number; total: number } | null;
  }
  const [prelabelModal, setPrelabelModal] = useState<PrelabelState | null>(null);

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
    ])
      .then(([d, ls, anns, ps]) => {
        if (cancelled) return;
        setDoc(d);
        setLabels(ls);
        setAnnotations(anns);
        setPages(ps);
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
        if (spanConfirm) {
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
  }, [doc, popover, resizingAnnotationId, handleDrag, spanConfirm, currentPage]);

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
      // While popovers / handle drag / confirm / resize are in progress,
      // word clicks must not start a new drag.
      if (popover) return;
      if (handleDragRef.current) return;
      if (spanConfirm) return;
      if (resizingAnnotationId !== null) return;
      e.preventDefault();
      const range: CrossPageRange = {
        start: { page: pageNum, wordIdx },
        end: { page: pageNum, wordIdx },
      };
      dragRef.current = range;
      setDrag(range);
    },
    [popover, spanConfirm, resizingAnnotationId],
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
              <h2>Pre-label clauses</h2>
              <span style={{ flex: 1 }} />
              <button
                className="btn ghost btn-xs"
                onClick={() => setPrelabelModal(null)}
              >
                close ✕
              </button>
            </div>

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

              <div className="prelabel-form-row" style={{ alignItems: "flex-start" }}>
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

              <div className="prelabel-form-row" style={{ justifyContent: "flex-end" }}>
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
                <span style={{ flex: 1 }} />
                <button
                  className="btn"
                  disabled={
                    prelabelModal.running ||
                    prelabelModal.selectedLabels.size === 0
                  }
                  onClick={runPrelabelScan}
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

      {/* Span-resize confirmation popup */}
      {spanConfirm && (
        <div
          className="label-picker"
          style={{ position: "fixed", left: spanConfirm.x, top: spanConfirm.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="picker-title">Apply new span?</div>
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
        </div>
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
          onRequestSuggestion={requestSuggestion}
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
  onRequestSuggestion,
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
  onRequestSuggestion: () => void;
}) {
  // Position is fixed in the viewport (not inside any scrolling page).
  const style: React.CSSProperties = { left: popover.x, top: popover.y, position: "fixed" };

  if (popover.kind === "picker-label") {
    return (
      <div className="label-picker" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="picker-title">Apply label</div>
        <LabelPickerTree labels={labels} onPick={onPickLabel} />
        <button className="picker-cancel" onClick={onCancel}>cancel</button>
      </div>
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
      <div className="label-picker" style={style} onClick={(e) => e.stopPropagation()}>
        <div className="picker-title">
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
      </div>
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
    <div className="label-picker" style={style} onClick={(e) => e.stopPropagation()}>
      <div className="picker-title">
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
    </div>
  );
}
