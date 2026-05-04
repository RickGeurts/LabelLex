# LabelLex

A legal-data labelling app for producing training data for a legal LLM.
First concrete use case: upload bank prospectuses (typically 200–400 pages,
templated by magic-circle law firms) and label clauses for MREL eligibility
under the EU bank-resolution framework (BRRD/SRMR).

The app must show prospectuses with **original PDF layout intact** —
columns, indentation, footnotes — because legal layout carries semantic
meaning. The model loop (a local Ollama LLM) will eventually pre-label
clauses; humans correct; corrections feed the next training signal.

## Stack

- **Backend:** Python 3.11+, FastAPI, SQLAlchemy 2 (sync), SQLite (v0; Postgres later), pymupdf for PDF parsing.
- **Frontend:** React 18 + TypeScript + Vite, pdfjs-dist for PDF rendering.
- **LLM (planned):** local Ollama on `localhost:11434`, target hardware RTX 5070 Ti / 16 GB VRAM.

## Repo layout

```
backend/
  pyproject.toml
  app/
    main.py            FastAPI entrypoint (lifespan creates tables + seeds)
    config.py          Settings (DB url, storage dir, default user/project)
    db.py              Engine, SessionLocal, Base, get_db dep
    models.py          ORM models
    schemas.py         Pydantic request/response models
    seed.py            Idempotent seed: default user, project, starter labels
    services/
      pdf_parser.py    pymupdf → ParsedDocument (canonical text + bboxes)
      storage.py       File store for uploaded PDFs
    routers/
      projects.py      /api/projects, /api/projects/:id/labels
      documents.py     Upload, list, get, /pdf, /pages/:n
      annotations.py   POST/GET/DELETE /api/annotations
  scripts/
    parse_pdf.py       Standalone parser test harness (run on a fixture PDF)

frontend/
  package.json
  vite.config.ts       Dev proxy: /api → http://127.0.0.1:8000
  src/
    main.tsx, App.tsx
    api.ts             Typed API client
    types.ts           Shared types (mirror backend schemas)
    pages/
      ProjectPage.tsx       Upload + document list
      DocumentViewer.tsx    Loads PDF, manages page nav, owns annotation state
    components/
      PdfPageView.tsx       pdf.js canvas + word-bbox overlay + label picker
    styles.css
    vite-env.d.ts

storage/uploads/{id}.pdf   Uploaded PDFs (gitignored)
backend/labellex.db        SQLite (gitignored)
example_*.pdf              Test fixtures (gitignored)
```

## Run

Backend (from repo root):

```
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir backend --port 8000
```

Frontend:

```
cd frontend
npm install   # first time only
npm run dev   # opens on http://localhost:5173 (or 5174 if 5173 is taken)
```

Tables and the default user/project/labels are created on backend startup
(`lifespan` → `Base.metadata.create_all` → `seed`). Idempotent.

To re-parse the canonical fixture from the command line:

```
.venv\Scripts\python.exe backend\scripts\parse_pdf.py
```

## Architecture invariants

These are load-bearing decisions; check before reworking.

- **Backend is canonical for text + offsets.** pymupdf extracts per-word
  `(char_start, char_end, bbox, block, line)` and persists it. The frontend
  uses pdf.js for *visual rendering only* and pulls word data from
  `GET /api/documents/:id/pages/:n` so character offsets in annotations
  agree with what's stored.
- **Word bboxes are PDF native point coords (y-down from top-left).** The
  frontend overlays words at `bbox * scale` directly — no coordinate
  transform. Sample doc is A4 (595×842pt).
- **Annotations carry a span across pages.** Storage:
  `(start_page_num, start_char, end_page_num, end_char)`. Single-page
  spans set `start_page_num == end_page_num`. Char offsets are in each
  page's local text. The frontend resolves per-page slices via
  `pageAnnotationSlice` in `frontend/src/utils/spans.ts`. Re-labelling is
  still done by delete + create; span and attributes can be PATCHed (label
  is immutable post-create).
- **Single source of truth for labels.** A label's `project_id` must match
  the document's project — enforced in `routers/annotations.py`.
- **Selection model is drag-to-select on word overlays.** Cursor on word
  overlays is the I-beam (`cursor: text`). PointerDown on a word starts a
  cross-page drag tracked at viewer level; pointerEnter on subsequent words
  (across pages) extends it; document-level pointerup finalises and opens
  the picker. Selection / annotation / search highlights all render as
  one rectangle per visual line (book-marker style), built by
  `lineRects()` in `utils/spans.ts` — never per-word boxes.
- **Continuous-scroll viewer.** All pages stack vertically in
  `.viewer-pdf-area`. A single `IntersectionObserver` at the viewer level
  watches every page wrapper. Pages within a 2-page buffer of any visible
  page get the heavy render path (canvas + word overlays); other pages
  render only as a sized placeholder. Annotation / selection / search
  highlights render even on inactive pages so navigation feedback shows
  immediately.

## Conventions

- **Imports:** stdlib → third-party → local, blank line between groups.
- **SQLAlchemy 2.0 style:** `Mapped[...]` + `mapped_column` everywhere.
- **Pydantic 2:** schemas inherit `_Base` with `from_attributes=True` so
  ORM models pass through directly.
- **Errors:** raise `HTTPException` from routers; let FastAPI surface them.
- **Frontend types** mirror backend schemas — keep `frontend/src/types.ts`
  and `backend/app/schemas.py` in sync.
- **TS strict mode is on** (incl. `noUnusedLocals`, `noUnusedParameters`).
- **No comments that describe what the code does.** Only WHY-comments where
  a hidden constraint or non-obvious choice would surprise a reader.

## Gotchas / quirks

- **Vite binds IPv6 by default on this Windows setup.** `localhost` and
  `[::1]` work; `127.0.0.1` does not unless you set `host: "127.0.0.1"`
  in `vite.config.ts`.
- **PowerShell 5.1 on Windows wraps native exe stderr in ErrorRecords**,
  which makes a clean `pip install` look like a failure. Verify with the
  follow-up import check, not with `$?`.
- **TOC dotted leaders** (e.g. `'PROGRAMME................................1'`) are
  captured by pymupdf as one giant "word." Filter when running structure
  detection — they're noise, not content.
- **PDF page index ≠ printed page number.** Front matter pushes the offset
  (cover + roman-numeralled TOC). `Page.printed_page_num` is reserved for
  the printed value but not yet populated.
- **The annotation overlay is `pointer-events: auto`** so users can click
  to delete; this means it can swallow clicks on words it covers. Keep an
  eye on this when adding selection features.

## Status

- ✅ v0 spike: upload PDF, render with original layout, click-words to
  label, persist, reload-restores. Validated on a 254-page real bank
  prospectus.
- ✅ Hierarchical labels (`parent_id` self-FK on `LabelDefinition`),
  cycle-safe parent validation, admin CRUD UI at `/labels`, hierarchical
  label picker in the viewer, indented sidebar tree.
- ✅ Typed attributes per label (`AttributeDefinition` + `AnnotationAttribute`).
  Types: string / enum / bool / number / date. Required-attribute
  enforcement on annotation create. Inheritance: an annotation tagged with
  a descendant label can carry values for any attribute defined on itself
  or any ancestor — backend resolves via `services/attributes.collect_effective_attributes`,
  frontend mirrors via `effectiveAttributes(label, labelById)` in
  `PdfPageView`. Admin authors attributes per label at `/labels`; the
  annotation picker becomes a two-step flow (label → attribute form) when
  the picked label has any effective attribute.
- ✅ Annotation editing in the viewer: click an existing annotation overlay
  → popover opens with editable typed-attribute inputs (own + inherited),
  delete / cancel / save buttons. Required attributes still gate save.
  Backend exposes `PATCH /api/annotations/{id}` accepting `{attributes}` —
  it replaces the annotation's attribute set wholesale (label and span are
  immutable post-create — re-label by deleting and creating). Annotation
  overlays only intercept clicks when no picker is in progress, so word
  selection still works.
- ✅ Drag-to-select on word overlays replaces the old click-first /
  click-last model. Selection state lives at the viewer level so drags
  span pages; pages activate via IntersectionObserver as the user scrolls,
  word overlays come online and pointerEnter continues to extend the
  selection. Pointer-up anywhere finalises and opens the picker at the
  release position. Highlights are line-based rectangles (book-marker),
  yellow during drag, label-coloured for annotations, yellow + outline
  for search hits.
- ✅ Continuous-scroll PDF viewer with toolbar slider. Bulk
  `GET /api/documents/:id/pages` loads all pages with words in one shot
  (~20 MB raw / ~3 MB gzipped for the 254-page reference) so cross-page
  selection has the data it needs. Page-input, slider, prev/next, and the
  arrow keys all call into `scrollToPage(n)` which scrolls the page
  wrapper into view. Most-visible page drives `currentPage` state.
- ✅ Edit-span on existing annotations: the editor popover gains an "edit
  span" button that closes the editor and enters resize mode (yellow
  banner across the top). The next drag PATCHes the annotation's span
  fields preserving label + attributes. Esc cancels.
- ✅ Arrow-key page navigation (`←` / `→`) on the document viewer.
  Suppressed when focus is in any `INPUT` / `TEXTAREA` / `SELECT` /
  contenteditable element, and when modifier keys are held.
- ✅ Document-wide text search (backend: `GET /api/documents/:id/search?q=…`,
  case-insensitive substring on `Page.text`, returns `SearchHit { page_num,
  char_start, char_end, snippet, match_in_snippet }` — frontend wraps the
  match in `<mark>`). UI is a magnifying-glass toggle in the toolbar; query
  is debounced 250 ms; clicking a hit navigates and centres a transient
  yellow highlight on the matched words via the same scroll mechanism as
  annotation jump (separate `[data-search-anchor]` element). The highlight
  persists until the user closes the search bar.
- ✅ Annotation list panel on the document viewer: a sticky right-side
  panel listing every annotation in the document, with text search,
  filter-by-label, sort by page / label / newest, click-to-jump. The
  current page's items are highlighted. Toggle via "Hide list" / "Show
  list" in the toolbar; preference persists in `localStorage` under
  `labellex.viewer.showPanel`. Click-jump also **scrolls the bbox into
  view**: `PdfPageView` accepts a `scrollToAnnotationId` prop and centres
  the matching annotation via `scrollIntoView` once it's rendered on the
  current page (the first overlay div of each annotation carries
  `data-annotation-id` for the lookup). Caller clears the request via
  `onScrollHandled`.
- ✅ `/labels` admin polish: edit-as-modal with embedded attribute manager
  (own + read-only inherited shown), per-row checkbox + bulk delete
  (post-order so parent+children selections work), search box (filters
  tree, keeps ancestors of matches), collapse/expand chevrons persisted in
  `localStorage` under `labellex.labels.collapsed`, 14-colour preset
  palette in `ColorInput`, and inline rename via double-click on the row's
  name (Enter saves, Esc cancels, blur saves if non-empty). Annotation
  usage counts surfaced from backend (`LabelOut.annotation_count`,
  computed via group-by in `services/label_counts.attach_annotation_counts`).
- ⬜ Inter-annotation relations.
- ⬜ Multi-user (auth, sessions, roles, projects, per-document checkout).
- ⬜ Postgres + docker-compose.
- ✅ Ollama integration v0: structure detection.
  - `app/services/ollama.py` — sync httpx client. `status()` is non-raising
    (returns `{"reachable": false, "error": ...}` on failure so the UI can
    show it). `generate_structured(prompt, schema)` posts to
    `/api/generate` with the JSON schema in `format=` and parses the
    response (Ollama 0.5+ structured output).
  - `app/services/structure_detector.py` — extracts the document outline
    via `pymupdf` (`doc.get_toc`), falls back to a regex-driven parse of
    the printed "TABLE OF CONTENTS" page; classifies each entry into
    MREL-relevant section types (`tc_senior_preferred`,
    `tc_senior_non_preferred`, `tc_subordinated`, `risk_factors`, etc.)
    via Ollama with a fixed enum schema.
  - `GET /api/ollama/status` — reachability + configured model + locally
    pulled models.
  - `POST /api/documents/:id/detect-structure` — runs the pipeline and
    returns `{model, sections: [{title, page_num, section_type,
    confidence}]}`. 503 if Ollama unreachable or the configured model
    isn't pulled (with a one-line `ollama pull …` hint).
  - Frontend: 🪄 Detect structure button in the viewer toolbar opens a
    modal showing the classified outline with jump-to-page actions.
  - Settings: `LABELLEX_OLLAMA_BASE_URL` (default
    `http://localhost:11434`), `LABELLEX_OLLAMA_MODEL` (default
    `qwen2.5:14b-instruct`), `LABELLEX_OLLAMA_TIMEOUT_SECONDS` (default
    180). Set up Ollama with: install (`winget install Ollama.Ollama`),
    pull the model (`ollama pull qwen2.5:14b-instruct`), and the daemon
    auto-starts on Windows.
- ⬜ Ollama: pre-labelling clauses for MREL features.
- ⬜ Printed-page-number extraction.
