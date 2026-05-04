"""Pre-labelling suggestion endpoints.

`POST /api/labels/{label_id}/suggest-attributes` runs the routed strategy
against a clause text and returns the proposed attribute values, along
with a `suggestion_id` that the client should send back when it submits
the resulting annotation. That round-trip is how we measure per-strategy
accuracy: by comparing the suggestion to what the labeller ended up
saving.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AnnotationSuggestion, Document, LabelDefinition
from ..schemas import (
    SuggestAttributesIn,
    SuggestAttributesOut,
    SuggestedAttribute,
)
from ..services.attributes import collect_effective_attributes
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
