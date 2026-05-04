"""Annotation CRUD with typed-attribute support and cross-page span edits.

Spans:
- A span starts at `(start_page_num, start_char)` and ends at
  `(end_page_num, end_char)`. End is exclusive in char terms.
- Single-page span → start_page_num == end_page_num.
- Validation rejects ranges that aren't strictly forward and chars must be
  non-negative.

Attributes:
- `_resolve_attributes` validates each (attribute_def_id, value) against the
  label's effective attribute set (own + ancestors), enforces required
  attributes, and returns coerced values ready to persist.

Updates:
- `attributes`, on its own, replaces the attribute set wholesale.
- The four span fields plus `text` may be sent together to resize the span;
  partial span updates (some fields, not others) are rejected so we never
  end up with an inconsistent range.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..db import get_db
from ..models import (
    Annotation,
    AnnotationAttribute,
    AnnotationRelation,
    AttributeDefinition,
    Document,
    LabelDefinition,
)
from ..schemas import (
    AnnotationAttributeIn,
    AnnotationCreate,
    AnnotationOut,
    AnnotationUpdate,
)
from ..services.attributes import collect_effective_attributes, validate_value
from ..services.document_activity import touch_document
from .suggestions import resolve_suggestion


SPAN_FIELDS = ("start_page_num", "start_char", "end_page_num", "end_char", "text")


def _validate_span(
    start_page_num: int,
    start_char: int,
    end_page_num: int,
    end_char: int,
) -> None:
    if start_page_num < 1 or end_page_num < 1:
        raise HTTPException(status_code=400, detail="page numbers must be ≥ 1")
    if start_char < 0 or end_char < 0:
        raise HTTPException(status_code=400, detail="char offsets must be ≥ 0")
    if end_page_num < start_page_num:
        raise HTTPException(status_code=400, detail="end_page_num precedes start_page_num")
    if end_page_num == start_page_num and end_char <= start_char:
        raise HTTPException(status_code=400, detail="empty or reversed span")


def _resolve_attributes(
    db: Session,
    label: LabelDefinition,
    payload: list[AnnotationAttributeIn],
) -> list[tuple[AttributeDefinition, object]]:
    effective = collect_effective_attributes(db, label.id)
    by_id = {a.id: a for a in effective}

    seen: set[int] = set()
    resolved: list[tuple[AttributeDefinition, object]] = []
    for item in payload:
        if item.attribute_def_id in seen:
            raise HTTPException(
                status_code=400,
                detail=f"Duplicate attribute_def_id in payload: {item.attribute_def_id}",
            )
        seen.add(item.attribute_def_id)
        attr_def = by_id.get(item.attribute_def_id)
        if attr_def is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Attribute {item.attribute_def_id} is not defined on label "
                    f"'{label.name}' or any ancestor."
                ),
            )
        try:
            value = validate_value(attr_def.value_type, attr_def.enum_values, item.value)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Attribute '{attr_def.name}': {exc}",
            ) from exc
        resolved.append((attr_def, value))

    provided_ids = {a.id for a, v in resolved if v is not None}
    for attr_def in effective:
        if attr_def.required and attr_def.id not in provided_ids:
            raise HTTPException(
                status_code=400,
                detail=f"Required attribute '{attr_def.name}' is missing.",
            )
    return resolved


router = APIRouter(prefix="/api", tags=["annotations"])


@router.get("/documents/{document_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(document_id: int, db: Session = Depends(get_db)) -> list[Annotation]:
    return list(
        db.scalars(
            select(Annotation)
            .where(Annotation.document_id == document_id)
            .options(selectinload(Annotation.attributes))
            .order_by(
                Annotation.start_page_num,
                Annotation.start_char,
            )
        ).all()
    )


@router.post("/annotations", response_model=AnnotationOut, status_code=201)
def create_annotation(payload: AnnotationCreate, db: Session = Depends(get_db)) -> Annotation:
    doc = db.get(Document, payload.document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    label = db.get(LabelDefinition, payload.label_definition_id)
    if label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    if label.project_id != doc.project_id:
        raise HTTPException(status_code=400, detail="Label does not belong to document's project")
    _validate_span(
        payload.start_page_num,
        payload.start_char,
        payload.end_page_num,
        payload.end_char,
    )
    if payload.end_page_num > doc.page_count:
        raise HTTPException(status_code=400, detail="end_page_num exceeds document page count")

    resolved = _resolve_attributes(db, label, payload.attributes)

    ann = Annotation(
        document_id=payload.document_id,
        label_definition_id=payload.label_definition_id,
        start_page_num=payload.start_page_num,
        start_char=payload.start_char,
        end_page_num=payload.end_page_num,
        end_char=payload.end_char,
        text=payload.text,
        created_by=settings.default_user_id,
    )
    for attr_def, value in resolved:
        if value is None:
            continue
        ann.attributes.append(
            AnnotationAttribute(attribute_def_id=attr_def.id, value=value)
        )
    db.add(ann)
    touch_document(db, payload.document_id)
    db.commit()
    db.refresh(ann)

    # Resolve any pending suggestion the client referenced.
    if payload.suggestion_id is not None:
        final_attrs = {
            attr_def.id: value
            for attr_def, value in resolved
            if value is not None
        }
        resolve_suggestion(
            db,
            payload.suggestion_id,
            annotation_id=ann.id,
            label_definition_id=ann.label_definition_id,
            span=(
                ann.start_page_num,
                ann.start_char,
                ann.end_page_num,
                ann.end_char,
            ),
            final_attributes=final_attrs,
            user_id=settings.default_user_id,
        )
        db.commit()

    return ann


@router.patch("/annotations/{annotation_id}", response_model=AnnotationOut)
def update_annotation(
    annotation_id: int, payload: AnnotationUpdate, db: Session = Depends(get_db)
) -> Annotation:
    ann = db.get(Annotation, annotation_id)
    if ann is None:
        raise HTTPException(status_code=404, detail="Annotation not found")

    data = payload.model_dump(exclude_unset=True)

    # Span edit: all five fields must be present together (or none).
    span_present = [k for k in SPAN_FIELDS if k in data]
    if span_present and len(span_present) != len(SPAN_FIELDS):
        missing = sorted(set(SPAN_FIELDS) - set(span_present))
        raise HTTPException(
            status_code=400,
            detail=f"Span update requires all of {SPAN_FIELDS}; missing: {missing}",
        )

    if span_present:
        _validate_span(
            data["start_page_num"],
            data["start_char"],
            data["end_page_num"],
            data["end_char"],
        )
        doc = db.get(Document, ann.document_id)
        if doc and data["end_page_num"] > doc.page_count:
            raise HTTPException(status_code=400, detail="end_page_num exceeds document page count")
        ann.start_page_num = data["start_page_num"]
        ann.start_char = data["start_char"]
        ann.end_page_num = data["end_page_num"]
        ann.end_char = data["end_char"]
        ann.text = data["text"]

    if "attributes" in data and data["attributes"] is not None:
        label = db.get(LabelDefinition, ann.label_definition_id)
        assert label is not None  # FK guarantees this
        attrs_payload = [AnnotationAttributeIn(**item) for item in data["attributes"]]
        resolved = _resolve_attributes(db, label, attrs_payload)
        ann.attributes.clear()
        db.flush()
        for attr_def, value in resolved:
            if value is None:
                continue
            ann.attributes.append(
                AnnotationAttribute(attribute_def_id=attr_def.id, value=value)
            )

    touch_document(db, ann.document_id)
    db.commit()
    db.refresh(ann)

    if payload.suggestion_id is not None and "attributes" in data:
        final_attrs = {
            av.attribute_def_id: av.value for av in ann.attributes
        }
        resolve_suggestion(
            db,
            payload.suggestion_id,
            annotation_id=ann.id,
            label_definition_id=ann.label_definition_id,
            span=(
                ann.start_page_num,
                ann.start_char,
                ann.end_page_num,
                ann.end_char,
            ),
            final_attributes=final_attrs,
            user_id=settings.default_user_id,
        )
        db.commit()

    return ann


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: int, db: Session = Depends(get_db)) -> None:
    ann = db.get(Annotation, annotation_id)
    if ann is None:
        raise HTTPException(status_code=404, detail="Annotation not found")
    document_id = ann.document_id
    # SQLite FK enforcement is off; cascade relations explicitly.
    db.execute(
        delete(AnnotationRelation).where(
            (AnnotationRelation.from_annotation_id == annotation_id)
            | (AnnotationRelation.to_annotation_id == annotation_id)
        )
    )
    db.delete(ann)
    touch_document(db, document_id)
    db.commit()
