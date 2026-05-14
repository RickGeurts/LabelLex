"""Pre-labelling suggestion endpoints.

Two flavours of suggestion:

1. Per-clause attribute fill — `POST /api/labels/{label_id}/suggest-attributes`
   runs the routed strategy against a clause text the labeller has already
   selected and returns proposed attribute values, plus a `suggestion_id`
   the client sends back on annotation create/update so we can measure
   accuracy.

2. Section-wide clause discovery — `POST /api/documents/{id}/prelabel`
   sweeps a page range and asks Ollama to find clauses that match any of
   a label set. Each find is persisted as a pending `AnnotationSuggestion`
   with a concrete span; the labeller reviews via the modal and accepts
   (turns into a real annotation) or rejects (status flips, no annotation
   created).
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import (
    Annotation,
    AnnotationAttribute,
    AnnotationSuggestion,
    AttributeDefinition,
    Document,
    LabelDefinition,
    Page,
)
from ..schemas import (
    AnnotationOut,
    AutoLabelRequest,
    PrelabelCIRequest,
    PrelabelRequest,
    SuggestAttributesIn,
    SuggestAttributesOut,
    SuggestedAttribute,
    SuggestionListItem,
    TncRangeOut,
)
from ..services.attributes import collect_effective_attributes
from ..services.clause_discovery import discover_clauses_on_page
from ..services.clause_instrument_discovery import (
    detect_tnc_ranges,
    discover_on_page as discover_ci_on_page,
)
from ..services.auto_label import run_auto_label
from ..services.clause_instrument_discovery_claude import (
    collect_few_shot_examples,
    discover_on_page_claude,
    get_claude_client,
)
from ..services.subparagraph_segmenter import segment_subparagraphs
from ..services.document_activity import touch_document
from ..services.ollama import OllamaError, get_ollama_client
from ..services.strategies import route_for_attribute_prediction


router = APIRouter(prefix="/api", tags=["suggestions"])


@router.post(
    "/labels/{label_id}/suggest-attributes",
    response_model=SuggestAttributesOut,
)
def suggest_attributes(
    label_id: int,
    payload: SuggestAttributesIn,
    db: Session = Depends(get_db),
) -> SuggestAttributesOut:
    label = db.get(LabelDefinition, label_id)
    if label is None or label.id != payload.label_definition_id:
        raise HTTPException(status_code=404, detail="Label not found")
    doc = db.get(Document, payload.document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if label.project_id != doc.project_id:
        raise HTTPException(
            status_code=400,
            detail="Label does not belong to document's project",
        )

    client = get_ollama_client()
    status = client.status()
    if not status["reachable"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama is not reachable at {status['base_url']} "
                f"({status.get('error')})."
            ),
        )
    if not status["configured_model_available"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Configured model '{status['configured_model']}' is not "
                f"installed locally."
            ),
        )

    attributes = collect_effective_attributes(db, label.id)
    strategy = route_for_attribute_prediction(db=db, label=label)
    try:
        output = strategy.predict_attributes(
            db=db,
            label=label,
            attributes=attributes,
            clause_text=payload.text,
            ollama=client,
        )
    except OllamaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    suggestion = AnnotationSuggestion(
        document_id=payload.document_id,
        label_definition_id=label.id,
        text=payload.text,
        start_page_num=payload.start_page_num,
        start_char=payload.start_char,
        end_page_num=payload.end_page_num,
        end_char=payload.end_char,
        strategy=output.strategy,
        model=output.model,
        confidence=output.confidence,
        suggested_attributes=[
            {"attribute_def_id": v.attribute_def_id, "value": v.value}
            for v in output.values
        ],
        status="pending",
    )
    db.add(suggestion)
    db.commit()
    db.refresh(suggestion)

    return SuggestAttributesOut(
        suggestion_id=suggestion.id,
        strategy=suggestion.strategy,
        model=suggestion.model,
        confidence=suggestion.confidence,
        attributes=[
            SuggestedAttribute(
                attribute_def_id=v.attribute_def_id,
                value=v.value,
            )
            for v in output.values
        ],
    )


def resolve_suggestion(
    db: Session,
    suggestion_id: int,
    *,
    annotation_id: int,
    label_definition_id: int,
    span: tuple[int, int, int, int],
    final_attributes: dict[int, object],
    user_id: int,
) -> None:
    """Compute the diff between a suggestion and the saved annotation, and
    update the suggestion's status accordingly. No-ops gracefully if the
    suggestion was deleted or referred to a different label."""
    suggestion = db.get(AnnotationSuggestion, suggestion_id)
    if suggestion is None or suggestion.status != "pending":
        return

    label_changed = suggestion.label_definition_id != label_definition_id
    span_changed = (
        suggestion.start_page_num is not None
        and (
            suggestion.start_page_num,
            suggestion.start_char,
            suggestion.end_page_num,
            suggestion.end_char,
        )
        != span
    )
    suggested = {
        item["attribute_def_id"]: item["value"]
        for item in suggestion.suggested_attributes
    }
    attributes_changed = suggested != final_attributes

    if label_changed or span_changed or attributes_changed:
        suggestion.status = "modified"
    else:
        suggestion.status = "accepted_as_is"
    suggestion.label_changed = label_changed
    suggestion.span_changed = span_changed
    suggestion.attributes_changed = attributes_changed
    suggestion.annotation_id = annotation_id
    suggestion.resolved_at = datetime.now(timezone.utc)
    suggestion.resolved_by = user_id


# --- Section-wide clause discovery ----------------------------------------


def _ensure_ollama_ready() -> None:
    client = get_ollama_client()
    status = client.status()
    if not status["reachable"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama is not reachable at {status['base_url']} "
                f"({status.get('error')}). Start the daemon and retry."
            ),
        )
    if not status["configured_model_available"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Configured model '{status['configured_model']}' is not "
                f"installed locally. Run: ollama pull {status['configured_model']}"
            ),
        )


@router.post("/documents/{document_id}/prelabel")
def prelabel_document(
    document_id: int,
    payload: PrelabelRequest,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Stream pre-label progress as NDJSON events.

    Each line is a JSON object with one of:
      - {"type":"started","model":...,"total_pages":N}
      - {"type":"page_done","page_num":X,"pages_done":K,"pages_total":N,
         "candidates":[PrelabelCandidate, ...]}
      - {"type":"done"}
      - {"type":"error","message":...}

    Pre-flight validation (404/400/503) still raises HTTPException before
    the stream starts. Errors that surface mid-scan come through as
    `error` events; per-page commits mean candidates from already-completed
    pages stay durable.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if payload.start_page_num < 1 or payload.end_page_num < payload.start_page_num:
        raise HTTPException(status_code=400, detail="Invalid page range")
    if payload.end_page_num > doc.page_count:
        raise HTTPException(
            status_code=400,
            detail=(
                f"end_page_num ({payload.end_page_num}) exceeds document "
                f"page count ({doc.page_count})"
            ),
        )

    label_q = select(LabelDefinition).where(
        LabelDefinition.project_id == doc.project_id
    )
    if payload.label_definition_ids:
        label_q = label_q.where(
            LabelDefinition.id.in_(payload.label_definition_ids)
        )
    labels = list(db.scalars(label_q).all())
    if not labels:
        raise HTTPException(
            status_code=400,
            detail="No labels in scope. Either pass label_definition_ids or seed the project.",
        )

    _ensure_ollama_ready()
    client = get_ollama_client()

    pages = list(
        db.scalars(
            select(Page)
            .where(Page.document_id == document_id)
            .where(Page.page_num >= payload.start_page_num)
            .where(Page.page_num <= payload.end_page_num)
            .order_by(Page.page_num)
        ).all()
    )

    def event_stream() -> Iterator[str]:
        yield json.dumps(
            {
                "type": "started",
                "model": client.default_model,
                "total_pages": len(pages),
            }
        ) + "\n"
        try:
            for i, page in enumerate(pages, start=1):
                page_candidates: list[dict] = []
                discovered = discover_clauses_on_page(page, labels, client)
                for c in discovered:
                    suggestion = AnnotationSuggestion(
                        document_id=document_id,
                        label_definition_id=c.label_definition_id,
                        text=c.text,
                        start_page_num=c.start_page_num,
                        start_char=c.start_char,
                        end_page_num=c.end_page_num,
                        end_char=c.end_char,
                        strategy="clause_discovery",
                        model=client.default_model,
                        confidence=c.confidence,
                        suggested_attributes=[],
                        status="pending",
                    )
                    db.add(suggestion)
                    db.flush()
                    page_candidates.append(
                        {
                            "suggestion_id": suggestion.id,
                            "label_definition_id": c.label_definition_id,
                            "start_page_num": c.start_page_num,
                            "start_char": c.start_char,
                            "end_page_num": c.end_page_num,
                            "end_char": c.end_char,
                            "text": c.text,
                            "confidence": c.confidence,
                        }
                    )
                db.commit()
                yield json.dumps(
                    {
                        "type": "page_done",
                        "page_num": page.page_num,
                        "pages_done": i,
                        "pages_total": len(pages),
                        "candidates": page_candidates,
                    }
                ) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except OllamaError as exc:
            db.rollback()
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        except Exception as exc:  # noqa: BLE001 — surface anything to client
            db.rollback()
            yield json.dumps(
                {"type": "error", "message": f"Unexpected error: {exc}"}
            ) + "\n"

    return StreamingResponse(
        event_stream(), media_type="application/x-ndjson"
    )


@router.get(
    "/documents/{document_id}/suggestions",
    response_model=list[SuggestionListItem],
)
def list_document_suggestions(
    document_id: int,
    status: str | None = "pending",
    db: Session = Depends(get_db),
) -> list[AnnotationSuggestion]:
    if db.get(Document, document_id) is None:
        raise HTTPException(status_code=404, detail="Document not found")
    q = select(AnnotationSuggestion).where(
        AnnotationSuggestion.document_id == document_id
    )
    if status:
        q = q.where(AnnotationSuggestion.status == status)
    q = q.order_by(
        AnnotationSuggestion.start_page_num,
        AnnotationSuggestion.start_char,
    )
    return list(db.scalars(q).all())


@router.post(
    "/suggestions/{suggestion_id}/accept",
    response_model=AnnotationOut,
    status_code=201,
)
def accept_suggestion(
    suggestion_id: int, db: Session = Depends(get_db)
) -> Annotation:
    sug = db.get(AnnotationSuggestion, suggestion_id)
    if sug is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if sug.status != "pending":
        raise HTTPException(
            status_code=400,
            detail=f"Suggestion already resolved (status={sug.status})",
        )
    if (
        sug.start_page_num is None
        or sug.start_char is None
        or sug.end_page_num is None
        or sug.end_char is None
    ):
        raise HTTPException(
            status_code=400,
            detail="Suggestion has no concrete span — cannot accept.",
        )

    # We deliberately bypass the required-attribute validation that
    # `create_annotation` runs. Clause-discovery proposes a span+label but
    # not attributes; the labeller reviews and fills required attrs in the
    # editor after accepting. Future iterations should run zero-shot
    # attribute prediction inline at accept time.
    ann = Annotation(
        document_id=sug.document_id,
        label_definition_id=sug.label_definition_id,
        start_page_num=sug.start_page_num,
        start_char=sug.start_char,
        end_page_num=sug.end_page_num,
        end_char=sug.end_char,
        text=sug.text,
        created_by=settings.default_user_id,
    )
    for entry in sug.suggested_attributes or []:
        attr_id = entry.get("attribute_def_id")
        value = entry.get("value")
        if attr_id is None or value is None:
            continue
        ann.attributes.append(
            AnnotationAttribute(attribute_def_id=attr_id, value=value)
        )
    db.add(ann)
    db.flush()

    sug.annotation_id = ann.id
    sug.status = "accepted_as_is"
    sug.label_changed = False
    sug.span_changed = False
    sug.attributes_changed = False
    sug.resolved_at = datetime.now(timezone.utc)
    sug.resolved_by = settings.default_user_id
    touch_document(db, ann.document_id)
    db.commit()
    db.refresh(ann)
    return ann


@router.post("/suggestions/{suggestion_id}/reject", status_code=204)
def reject_suggestion(
    suggestion_id: int, db: Session = Depends(get_db)
) -> None:
    sug = db.get(AnnotationSuggestion, suggestion_id)
    if sug is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if sug.status != "pending":
        raise HTTPException(
            status_code=400,
            detail=f"Suggestion already resolved (status={sug.status})",
        )
    sug.status = "rejected"
    sug.resolved_at = datetime.now(timezone.utc)
    sug.resolved_by = settings.default_user_id
    db.commit()


# --- Pre-label clauses + instruments (scope-label workflow) ---------------


@router.get("/llm-providers")
def list_llm_providers() -> dict:
    """Report which provider backends are configured.

    The UI uses this to gate the "Claude" option in the pre-label modal —
    if `claude.available` is false, the toggle is disabled.
    """
    return {
        "ollama": {
            "available": True,
            "model": settings.ollama_model,
        },
        "claude": {
            "available": bool(settings.anthropic_api_key),
            "model": settings.anthropic_model,
        },
    }


@router.get(
    "/documents/{document_id}/tnc-ranges",
    response_model=list[TncRangeOut],
)
def get_tnc_ranges(
    document_id: int, db: Session = Depends(get_db)
) -> list[TncRangeOut]:
    """Detect Terms & Conditions page ranges via the document outline.

    Empty list when the outline doesn't yield T&C-titled entries — the
    UI should then fall back to letting the user pick a range manually.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    ranges = detect_tnc_ranges(doc.file_path)
    return [
        TncRangeOut(
            start_page_num=r.start_page_num,
            end_page_num=r.end_page_num,
            title=r.title,
        )
        for r in ranges
    ]


@router.post("/documents/{document_id}/prelabel-clauses-instruments")
def prelabel_clauses_and_instruments(
    document_id: int,
    payload: PrelabelCIRequest,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Sweep the T&C section page-by-page; persist Clause + Instrument
    suggestions with status=pending.

    NDJSON event shape mirrors `/prelabel`:
      - {"type":"started","model":...,"total_pages":N,"ranges":[...]}
      - {"type":"page_done","page_num":X,"pages_done":K,"pages_total":N,
         "candidates":[...]}
      - {"type":"done"}
      - {"type":"error","message":...}

    Each candidate carries `suggested_attributes` so Instrument
    suggestions reach the review modal with the Ranking pre-filled.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    clause_label = db.get(LabelDefinition, payload.clause_label_id)
    instrument_label = db.get(LabelDefinition, payload.instrument_label_id)
    if clause_label is None or instrument_label is None:
        raise HTTPException(status_code=404, detail="Scope label not found")
    if (
        clause_label.project_id != doc.project_id
        or instrument_label.project_id != doc.project_id
    ):
        raise HTTPException(
            status_code=400,
            detail="Scope labels must belong to the document's project",
        )

    ranking_attr = db.get(
        AttributeDefinition, payload.instrument_ranking_attribute_id
    )
    if ranking_attr is None or ranking_attr.label_id != instrument_label.id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Ranking attribute must belong to the instrument scope label"
            ),
        )
    if ranking_attr.value_type != "enum" or not ranking_attr.enum_values:
        raise HTTPException(
            status_code=400,
            detail="Ranking attribute must be an enum with enum_values",
        )
    ranking_values = list(ranking_attr.enum_values)

    # Resolve page range — either explicit or auto-detect from outline.
    if (
        payload.start_page_num is not None
        and payload.end_page_num is not None
    ):
        if payload.start_page_num < 1 or payload.end_page_num < payload.start_page_num:
            raise HTTPException(status_code=400, detail="Invalid page range")
        if payload.end_page_num > doc.page_count:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"end_page_num ({payload.end_page_num}) exceeds document "
                    f"page count ({doc.page_count})"
                ),
            )
        ranges = [
            (payload.start_page_num, payload.end_page_num, "user-supplied")
        ]
    else:
        detected = detect_tnc_ranges(doc.file_path)
        if not detected:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No Terms & Conditions section found in the document "
                    "outline. Supply start_page_num and end_page_num manually."
                ),
            )
        ranges = [(r.start_page_num, r.end_page_num, r.title) for r in detected]

    # Pick the LLM backend. Ollama path needs reachability + a pulled model;
    # Claude path needs an API key on the server.
    if payload.provider == "claude":
        claude_client = get_claude_client()
        if claude_client is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Claude provider selected but LABELLEX_ANTHROPIC_API_KEY "
                    "is not configured on the server."
                ),
            )
        few_shot = collect_few_shot_examples(
            db,
            project_id=doc.project_id,
            clause_label_id=clause_label.id,
            instrument_label_id=instrument_label.id,
            ranking_attribute_id=ranking_attr.id,
            exclude_document_id=document_id,
        )
        model_label = settings.anthropic_model
        strategy_tag = "clause_instrument_discovery_claude"

        def _discover(page: Page) -> list:
            return discover_on_page_claude(
                page,
                clause_label=clause_label,
                instrument_label=instrument_label,
                ranking_attribute_id=ranking_attr.id,
                ranking_values=ranking_values,
                examples=few_shot,
                client=claude_client,
                model=settings.anthropic_model,
            )
    else:
        _ensure_ollama_ready()
        ollama_client = get_ollama_client()
        model_label = ollama_client.default_model
        strategy_tag = "clause_instrument_discovery"

        def _discover(page: Page) -> list:
            return discover_ci_on_page(
                page,
                clause_label=clause_label,
                instrument_label=instrument_label,
                ranking_attribute_id=ranking_attr.id,
                ranking_values=ranking_values,
                ollama=ollama_client,
            )

    pages: list[Page] = []
    for start, end, _ in ranges:
        page_rows = list(
            db.scalars(
                select(Page)
                .where(Page.document_id == document_id)
                .where(Page.page_num >= start)
                .where(Page.page_num <= end)
                .order_by(Page.page_num)
            ).all()
        )
        pages.extend(page_rows)

    def event_stream() -> Iterator[str]:
        yield json.dumps(
            {
                "type": "started",
                "model": model_label,
                "total_pages": len(pages),
                "ranges": [
                    {
                        "start_page_num": s,
                        "end_page_num": e,
                        "title": t,
                    }
                    for s, e, t in ranges
                ],
            }
        ) + "\n"
        try:
            for i, page in enumerate(pages, start=1):
                page_candidates: list[dict] = []
                discovered = _discover(page)
                for c in discovered:
                    suggestion = AnnotationSuggestion(
                        document_id=document_id,
                        label_definition_id=c.label_definition_id,
                        text=c.text,
                        start_page_num=c.start_page_num,
                        start_char=c.start_char,
                        end_page_num=c.end_page_num,
                        end_char=c.end_char,
                        strategy=strategy_tag,
                        model=model_label,
                        confidence=c.confidence,
                        suggested_attributes=c.suggested_attributes,
                        status="pending",
                    )
                    db.add(suggestion)
                    db.flush()
                    page_candidates.append(
                        {
                            "suggestion_id": suggestion.id,
                            "label_definition_id": c.label_definition_id,
                            "start_page_num": c.start_page_num,
                            "start_char": c.start_char,
                            "end_page_num": c.end_page_num,
                            "end_char": c.end_char,
                            "text": c.text,
                            "confidence": c.confidence,
                            "suggested_attributes": c.suggested_attributes,
                        }
                    )
                db.commit()
                yield json.dumps(
                    {
                        "type": "page_done",
                        "page_num": page.page_num,
                        "pages_done": i,
                        "pages_total": len(pages),
                        "candidates": page_candidates,
                    }
                ) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except OllamaError as exc:
            db.rollback()
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
        except Exception as exc:  # noqa: BLE001 — surface anything to client
            db.rollback()
            yield json.dumps(
                {"type": "error", "message": f"Unexpected error: {exc}"}
            ) + "\n"

    return StreamingResponse(
        event_stream(), media_type="application/x-ndjson"
    )


# --- Bulk auto-label (production path) ------------------------------------


@router.post("/documents/{document_id}/auto-label")
def auto_label_document(
    document_id: int,
    payload: AutoLabelRequest,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Run the bulk auto-label pipeline and write Annotations directly.

    Streaming NDJSON shape:
      - {"type":"started","model","clauses_total","ranges":[...]}
      - {"type":"clause_done","clauses_done","clauses_total","number",
         "heading","clause_annotation_id","instrument_annotation_id",
         "ranking"}
      - {"type":"done"}
      - {"type":"error","message"}

    On success, flips `Document.review_status` to "unverified" so the
    LoRA Forge publish endpoint can gate on it.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    clause_label = db.get(LabelDefinition, payload.clause_label_id)
    instrument_label = db.get(LabelDefinition, payload.instrument_label_id)
    if clause_label is None or instrument_label is None:
        raise HTTPException(status_code=404, detail="Scope label not found")
    if (
        clause_label.project_id != doc.project_id
        or instrument_label.project_id != doc.project_id
    ):
        raise HTTPException(
            status_code=400,
            detail="Scope labels must belong to the document's project",
        )

    ranking_attr = db.get(
        AttributeDefinition, payload.instrument_ranking_attribute_id
    )
    if ranking_attr is None or ranking_attr.label_id != instrument_label.id:
        raise HTTPException(
            status_code=400,
            detail="Ranking attribute must belong to the instrument scope label",
        )
    if ranking_attr.value_type != "enum" or not ranking_attr.enum_values:
        raise HTTPException(
            status_code=400,
            detail="Ranking attribute must be an enum with enum_values",
        )
    ranking_values = list(ranking_attr.enum_values)

    def event_stream() -> Iterator[str]:
        for event in run_auto_label(
            db,
            document=doc,
            clause_label=clause_label,
            instrument_label=instrument_label,
            ranking_attribute_id=ranking_attr.id,
            ranking_values=ranking_values,
            tier=payload.tier,
            model=payload.model,
        ):
            yield json.dumps({"type": event.type, **event.payload}) + "\n"

    return StreamingResponse(
        event_stream(), media_type="application/x-ndjson"
    )


# --- Sub-paragraph segmentation (regex-only) ------------------------------


_CLAUSE_NUMBER_RE = re.compile(r"^\s*(\d{1,3})\b")


def _resolve_subparagraph_chain(
    db: Session, root_label_id: int, project_id: int
) -> list[int]:
    """Walk parent_id links downward from the Sub-paragraph root to
    build a flat chain [level2_id, level3_id, level4_id, ...].

    At each step we expect a single child (the project ontology models a
    linear Sub-paragraph → Sub-sub-paragraph → ... chain). If a label
    has multiple children, the lowest id wins so the chain stays
    deterministic. Stops when a label has no children.
    """
    chain: list[int] = [root_label_id]
    current = root_label_id
    while True:
        next_child = db.scalars(
            select(LabelDefinition)
            .where(LabelDefinition.parent_id == current)
            .where(LabelDefinition.project_id == project_id)
            .order_by(LabelDefinition.id)
            .limit(1)
        ).first()
        if next_child is None:
            break
        chain.append(next_child.id)
        current = next_child.id
    return chain


def _label_subparagraphs_for_document(
    db: Session,
    document_id: int,
    chain: list[int],
    clause_label_id: int,
) -> tuple[int, dict[int, int]]:
    """Walk every Clause annotation; segment sub-paragraphs and assign
    each to the label in `chain` corresponding to its nesting level.

    `chain[0]` is the level-2 label (Sub-paragraph), `chain[1]` level-3,
    etc. Spans deeper than the chain length collapse onto the last
    label (so the deepest available label catches everything below it).

    The level is computed by the segmenter from indentation clustering
    with a style-stack fallback. Parent clause number is extracted from
    the clause text's leading `N.` so numeric markers like `14.2` are
    rejected when found inside a clause whose number isn't 14.

    Returns (clauses_scanned, written_by_level) where written_by_level
    maps absolute nesting level → annotations created at that level.
    """
    from datetime import datetime, timezone

    clause_anns = list(
        db.scalars(
            select(Annotation)
            .where(Annotation.document_id == document_id)
            .where(Annotation.label_definition_id == clause_label_id)
            .order_by(Annotation.start_page_num, Annotation.start_char)
        ).all()
    )
    written_by_level: dict[int, int] = {}
    for clause in clause_anns:
        clause_number: int | None = None
        m = _CLAUSE_NUMBER_RE.match(clause.text or "")
        if m:
            try:
                clause_number = int(m.group(1))
            except ValueError:
                clause_number = None
        pages = list(
            db.scalars(
                select(Page)
                .where(Page.document_id == document_id)
                .where(Page.page_num >= clause.start_page_num)
                .where(Page.page_num <= clause.end_page_num)
                .order_by(Page.page_num)
            ).all()
        )
        spans = segment_subparagraphs(
            pages,
            clause.start_page_num,
            clause.start_char,
            clause.end_page_num,
            clause.end_char,
            clause_number=clause_number,
        )
        now = datetime.now(timezone.utc)
        for s in spans:
            idx = max(0, min(s.level - 2, len(chain) - 1))
            target_label_id = chain[idx]
            effective_level = idx + 2
            ann = Annotation(
                document_id=document_id,
                label_definition_id=target_label_id,
                start_page_num=s.start_page_num,
                start_char=s.start_char,
                end_page_num=s.end_page_num,
                end_char=s.end_char,
                text=s.text,
                created_by=settings.default_user_id,
            )
            db.add(ann)
            db.flush()
            audit = AnnotationSuggestion(
                document_id=document_id,
                label_definition_id=target_label_id,
                text=s.text,
                start_page_num=s.start_page_num,
                start_char=s.start_char,
                end_page_num=s.end_page_num,
                end_char=s.end_char,
                strategy="auto_label_subparagraphs_regex",
                model="regex-only",
                confidence=0.95,
                suggested_attributes=[],
                status="accepted_as_is",
                annotation_id=ann.id,
                label_changed=False,
                span_changed=False,
                attributes_changed=False,
                resolved_at=now,
                resolved_by=settings.default_user_id,
            )
            db.add(audit)
            written_by_level[effective_level] = (
                written_by_level.get(effective_level, 0) + 1
            )
    return len(clause_anns), written_by_level


@router.post("/documents/{document_id}/auto-label-subparagraphs")
def auto_label_subparagraphs(
    document_id: int,
    sub_paragraph_label_id: int,
    clause_label_id: int = 1,
    replace_existing: bool = True,
    db: Session = Depends(get_db),
) -> dict:
    """Detect sub-paragraphs within each Clause annotation on this doc
    and assign each to the label in the Sub-paragraph chain matching its
    nesting level. The chain is walked from `sub_paragraph_label_id`
    downward via `parent_id` links — every child added to the chain
    extends the addressable depth by one level. Spans deeper than the
    chain collapse onto the deepest label.

    `replace_existing=true` (default) deletes any prior annotations
    carrying any label in the chain before running.
    """
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    sub_label = db.get(LabelDefinition, sub_paragraph_label_id)
    clause_label = db.get(LabelDefinition, clause_label_id)
    if sub_label is None or clause_label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    project_id = doc.project_id
    if sub_label.project_id != project_id or clause_label.project_id != project_id:
        raise HTTPException(
            status_code=400,
            detail="Labels must belong to the document's project",
        )

    chain = _resolve_subparagraph_chain(db, sub_label.id, project_id)

    if replace_existing:
        existing = list(
            db.scalars(
                select(Annotation)
                .where(Annotation.document_id == document_id)
                .where(Annotation.label_definition_id.in_(chain))
            ).all()
        )
        for ann in existing:
            db.delete(ann)
        db.flush()

    clauses_scanned, written_by_level = _label_subparagraphs_for_document(
        db, document_id, chain, clause_label.id
    )
    touch_document(db, document_id)
    db.commit()
    return {
        "ok": True,
        "document_id": document_id,
        "clauses_scanned": clauses_scanned,
        "chain_label_ids": chain,
        "written_by_level": written_by_level,
        "total_written": sum(written_by_level.values()),
    }


@router.post(
    "/projects/{project_id}/auto-label-subparagraphs-all"
)
def auto_label_subparagraphs_all(
    project_id: int,
    sub_paragraph_label_id: int,
    clause_label_id: int = 1,
    replace_existing: bool = True,
    db: Session = Depends(get_db),
) -> dict:
    """Run the sub-paragraph segmenter against every document in the
    project. The label chain is derived once from
    `sub_paragraph_label_id` (walking `parent_id` children) and reused
    across all documents. Returns per-doc counts and a project total.
    """
    sub_label = db.get(LabelDefinition, sub_paragraph_label_id)
    clause_label = db.get(LabelDefinition, clause_label_id)
    if sub_label is None or clause_label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    if sub_label.project_id != project_id or clause_label.project_id != project_id:
        raise HTTPException(
            status_code=400,
            detail="Labels must belong to the project",
        )

    chain = _resolve_subparagraph_chain(db, sub_label.id, project_id)

    docs = list(
        db.scalars(
            select(Document)
            .where(Document.project_id == project_id)
            .order_by(Document.id)
        ).all()
    )

    per_doc: list[dict] = []
    project_by_level: dict[int, int] = {}
    for doc in docs:
        if replace_existing:
            existing = list(
                db.scalars(
                    select(Annotation)
                    .where(Annotation.document_id == doc.id)
                    .where(Annotation.label_definition_id.in_(chain))
                ).all()
            )
            for ann in existing:
                db.delete(ann)
            db.flush()

        clauses_scanned, written_by_level = _label_subparagraphs_for_document(
            db, doc.id, chain, clause_label.id
        )
        doc_total = sum(written_by_level.values())
        if clauses_scanned > 0 or doc_total > 0:
            touch_document(db, doc.id)
        per_doc.append(
            {
                "document_id": doc.id,
                "filename": doc.filename,
                "clauses_scanned": clauses_scanned,
                "written_by_level": written_by_level,
                "total_written": doc_total,
            }
        )
        for lvl, n in written_by_level.items():
            project_by_level[lvl] = project_by_level.get(lvl, 0) + n
    db.commit()
    return {
        "ok": True,
        "project_id": project_id,
        "documents_processed": len(docs),
        "chain_label_ids": chain,
        "total_by_level": project_by_level,
        "total_written": sum(project_by_level.values()),
        "per_document": per_doc,
    }
