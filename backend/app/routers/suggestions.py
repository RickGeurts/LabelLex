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
    Document,
    LabelDefinition,
    Page,
)
from ..schemas import (
    AnnotationOut,
    PrelabelRequest,
    SuggestAttributesIn,
    SuggestAttributesOut,
    SuggestedAttribute,
    SuggestionListItem,
)
from ..services.attributes import collect_effective_attributes
from ..services.clause_discovery import discover_clauses_on_page
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
