"""Label CRUD with hierarchy validation. Admin-authored ontology per project.

Validation rules:
- A label's parent must belong to the same project.
- Setting a parent_id must not create a cycle.
- Delete is rejected if the label has children, or if any annotation
  references it. Force-delete is intentionally not exposed in v0 — once
  annotations exist for a label, treat it as load-bearing.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Annotation, LabelDefinition, Project
from ..schemas import LabelCreate, LabelOut, LabelUpdate


router = APIRouter(prefix="/api/projects/{project_id}/labels", tags=["labels"])


def _ancestors_contain(db: Session, candidate_parent_id: int, label_id: int) -> bool:
    """True if `label_id` is an ancestor of (or equal to) `candidate_parent_id`."""
    cur: int | None = candidate_parent_id
    seen: set[int] = set()
    while cur is not None:
        if cur == label_id:
            return True
        if cur in seen:  # malformed graph; bail
            return True
        seen.add(cur)
        parent = db.get(LabelDefinition, cur)
        cur = parent.parent_id if parent else None
    return False


def _validate_parent(
    db: Session, project_id: int, parent_id: int | None, *, self_id: int | None = None
) -> None:
    if parent_id is None:
        return
    parent = db.get(LabelDefinition, parent_id)
    if parent is None:
        raise HTTPException(status_code=400, detail="parent_id does not exist")
    if parent.project_id != project_id:
        raise HTTPException(status_code=400, detail="parent label is in a different project")
    if self_id is not None and _ancestors_contain(db, parent_id, self_id):
        raise HTTPException(status_code=400, detail="parent_id would create a cycle")


@router.post("", response_model=LabelOut, status_code=201)
def create_label(
    project_id: int, payload: LabelCreate, db: Session = Depends(get_db)
) -> LabelDefinition:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    _validate_parent(db, project_id, payload.parent_id)
    label = LabelDefinition(
        project_id=project_id,
        parent_id=payload.parent_id,
        name=payload.name,
        color=payload.color,
        description=payload.description,
        is_scope=payload.is_scope,
    )
    db.add(label)
    try:
        db.commit()
    except Exception as exc:  # unique-constraint or similar
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.refresh(label)
    return label


@router.patch("/{label_id}", response_model=LabelOut)
def update_label(
    project_id: int,
    label_id: int,
    payload: LabelUpdate,
    db: Session = Depends(get_db),
) -> LabelDefinition:
    label = db.get(LabelDefinition, label_id)
    if label is None or label.project_id != project_id:
        raise HTTPException(status_code=404, detail="Label not found")

    data = payload.model_dump(exclude_unset=True)
    if "parent_id" in data:
        _validate_parent(db, project_id, data["parent_id"], self_id=label.id)
        label.parent_id = data["parent_id"]
    if "name" in data and data["name"] is not None:
        label.name = data["name"]
    if "color" in data and data["color"] is not None:
        label.color = data["color"]
    if "description" in data:
        label.description = data["description"]
    if "is_scope" in data and data["is_scope"] is not None:
        label.is_scope = data["is_scope"]

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.refresh(label)
    return label


@router.delete("/{label_id}", status_code=204)
def delete_label(project_id: int, label_id: int, db: Session = Depends(get_db)) -> None:
    label = db.get(LabelDefinition, label_id)
    if label is None or label.project_id != project_id:
        raise HTTPException(status_code=404, detail="Label not found")

    has_children = db.scalar(
        select(LabelDefinition.id).where(LabelDefinition.parent_id == label_id).limit(1)
    )
    if has_children is not None:
        raise HTTPException(
            status_code=409,
            detail="Label has children; reparent or delete them first.",
        )
    in_use = db.scalar(
        select(Annotation.id).where(Annotation.label_definition_id == label_id).limit(1)
    )
    if in_use is not None:
        raise HTTPException(
            status_code=409,
            detail="Label is referenced by annotations; cannot delete.",
        )

    db.delete(label)
    db.commit()
