"""Attribute-definition CRUD scoped to a label."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AnnotationAttribute, AttributeDefinition, LabelDefinition
from ..schemas import VALUE_TYPES, AttributeCreate, AttributeOut, AttributeUpdate


router = APIRouter(prefix="/api/labels/{label_id}/attributes", tags=["attributes"])


def _validate_definition(value_type: str, enum_values: list[str] | None) -> None:
    if value_type not in VALUE_TYPES:
        raise HTTPException(status_code=400, detail=f"value_type must be one of {VALUE_TYPES}")
    if value_type == "enum":
        if not enum_values or any(not isinstance(v, str) or v == "" for v in enum_values):
            raise HTTPException(
                status_code=400,
                detail="enum value_type requires a non-empty list of non-empty strings",
            )
    elif enum_values is not None:
        raise HTTPException(
            status_code=400,
            detail="enum_values is only valid when value_type='enum'",
        )


@router.post("", response_model=AttributeOut, status_code=201)
def create_attribute(
    label_id: int, payload: AttributeCreate, db: Session = Depends(get_db)
) -> AttributeDefinition:
    label = db.get(LabelDefinition, label_id)
    if label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    _validate_definition(payload.value_type, payload.enum_values)
    attr = AttributeDefinition(
        label_id=label_id,
        name=payload.name,
        value_type=payload.value_type,
        enum_values=payload.enum_values,
        required=payload.required,
        description=payload.description,
    )
    db.add(attr)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.refresh(attr)
    return attr


@router.patch("/{attr_id}", response_model=AttributeOut)
def update_attribute(
    label_id: int,
    attr_id: int,
    payload: AttributeUpdate,
    db: Session = Depends(get_db),
) -> AttributeDefinition:
    attr = db.get(AttributeDefinition, attr_id)
    if attr is None or attr.label_id != label_id:
        raise HTTPException(status_code=404, detail="Attribute not found")

    data = payload.model_dump(exclude_unset=True)
    new_type = data.get("value_type", attr.value_type)
    new_enum = data.get("enum_values", attr.enum_values)
    if "value_type" in data or "enum_values" in data:
        _validate_definition(new_type, new_enum)

    # If type or enum changes, refuse if any annotation has a value referencing
    # this attribute — values would silently become invalid.
    if "value_type" in data and data["value_type"] != attr.value_type:
        in_use = db.scalar(
            select(AnnotationAttribute.id).where(
                AnnotationAttribute.attribute_def_id == attr_id
            ).limit(1)
        )
        if in_use is not None:
            raise HTTPException(
                status_code=409,
                detail="Attribute has values; cannot change value_type. Clear values first.",
            )
    if "enum_values" in data and attr.value_type == "enum" and new_type == "enum":
        # Removing enum values that are referenced is unsafe.
        in_use_values = db.scalars(
            select(AnnotationAttribute.value).where(
                AnnotationAttribute.attribute_def_id == attr_id
            )
        ).all()
        new_set = set(new_enum or [])
        bad = [v for v in in_use_values if isinstance(v, str) and v not in new_set]
        if bad:
            raise HTTPException(
                status_code=409,
                detail=f"enum_values would orphan existing values: {sorted(set(bad))}",
            )

    if "name" in data and data["name"] is not None:
        attr.name = data["name"]
    if "value_type" in data and data["value_type"] is not None:
        attr.value_type = data["value_type"]
    if "enum_values" in data:
        attr.enum_values = data["enum_values"]
    if "required" in data and data["required"] is not None:
        attr.required = data["required"]
    if "description" in data:
        attr.description = data["description"]

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.refresh(attr)
    return attr


@router.delete("/{attr_id}", status_code=204)
def delete_attribute(
    label_id: int, attr_id: int, db: Session = Depends(get_db)
) -> None:
    attr = db.get(AttributeDefinition, attr_id)
    if attr is None or attr.label_id != label_id:
        raise HTTPException(status_code=404, detail="Attribute not found")
    in_use = db.scalar(
        select(AnnotationAttribute.id).where(
            AnnotationAttribute.attribute_def_id == attr_id
        ).limit(1)
    )
    if in_use is not None:
        raise HTTPException(
            status_code=409,
            detail="Attribute is referenced by annotations; cannot delete.",
        )
    db.delete(attr)
    db.commit()