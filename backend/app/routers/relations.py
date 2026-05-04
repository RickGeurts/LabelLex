"""Inter-annotation relations: types (per-project) + concrete links.

`RelationDefinition` is the admin-authored type (e.g. 'modifies',
'cross-references'). `AnnotationRelation` is a concrete directed link
between two annotations on the same document, tagged with one of those
types.

v0 constraints:
- Source and target must belong to the same document (cross-document
  relations are deferred).
- Self-loops are rejected.
- Cascade-on-parent-delete is done in Python because SQLite FK
  enforcement is off on this engine. Annotation delete in the
  annotations router wipes related rows first; deleting a relation type
  here wipes its instances.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import (
    Annotation,
    AnnotationRelation,
    Document,
    Project,
    RelationDefinition,
)
from ..schemas import (
    AnnotationRelationCreate,
    AnnotationRelationOut,
    RelationDefinitionCreate,
    RelationDefinitionOut,
    RelationDefinitionUpdate,
)


router = APIRouter(prefix="/api", tags=["relations"])


# --- Relation definitions (project-scoped types) --------------------------


@router.get(
    "/projects/{project_id}/relation-defs",
    response_model=list[RelationDefinitionOut],
)
def list_relation_defs(
    project_id: int, db: Session = Depends(get_db)
) -> list[RelationDefinition]:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return list(
        db.scalars(
            select(RelationDefinition)
            .where(RelationDefinition.project_id == project_id)
            .order_by(RelationDefinition.name)
        ).all()
    )


@router.post(
    "/projects/{project_id}/relation-defs",
    response_model=RelationDefinitionOut,
    status_code=201,
)
def create_relation_def(
    project_id: int,
    payload: RelationDefinitionCreate,
    db: Session = Depends(get_db),
) -> RelationDefinition:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    clash = db.scalar(
        select(RelationDefinition).where(
            RelationDefinition.project_id == project_id,
            RelationDefinition.name == name,
        )
    )
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A relation type named '{name}' already exists in this project",
        )
    rd = RelationDefinition(
        project_id=project_id,
        name=name,
        description=payload.description,
        color=payload.color,
    )
    db.add(rd)
    db.commit()
    db.refresh(rd)
    return rd


@router.patch(
    "/relation-defs/{def_id}",
    response_model=RelationDefinitionOut,
)
def update_relation_def(
    def_id: int,
    payload: RelationDefinitionUpdate,
    db: Session = Depends(get_db),
) -> RelationDefinition:
    rd = db.get(RelationDefinition, def_id)
    if rd is None:
        raise HTTPException(status_code=404, detail="Relation type not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Name required")
        if new_name != rd.name:
            clash = db.scalar(
                select(RelationDefinition).where(
                    RelationDefinition.project_id == rd.project_id,
                    RelationDefinition.name == new_name,
                    RelationDefinition.id != def_id,
                )
            )
            if clash is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"A relation type named '{new_name}' already exists",
                )
        rd.name = new_name
    if "description" in data:
        rd.description = data["description"]
    if "color" in data and data["color"]:
        rd.color = data["color"]
    db.commit()
    db.refresh(rd)
    return rd


@router.delete("/relation-defs/{def_id}", status_code=204)
def delete_relation_def(def_id: int, db: Session = Depends(get_db)) -> None:
    rd = db.get(RelationDefinition, def_id)
    if rd is None:
        raise HTTPException(status_code=404, detail="Relation type not found")
    # Wipe instances first; SQLite FK cascade isn't enforced on this engine.
    db.execute(
        delete(AnnotationRelation).where(
            AnnotationRelation.relation_def_id == def_id
        )
    )
    db.delete(rd)
    db.commit()


# --- Concrete relations ---------------------------------------------------


@router.get(
    "/documents/{document_id}/relations",
    response_model=list[AnnotationRelationOut],
)
def list_document_relations(
    document_id: int, db: Session = Depends(get_db)
) -> list[AnnotationRelation]:
    if db.get(Document, document_id) is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return list(
        db.scalars(
            select(AnnotationRelation)
            .where(AnnotationRelation.document_id == document_id)
            .order_by(AnnotationRelation.id)
        ).all()
    )


@router.post(
    "/relations",
    response_model=AnnotationRelationOut,
    status_code=201,
)
def create_relation(
    payload: AnnotationRelationCreate, db: Session = Depends(get_db)
) -> AnnotationRelation:
    if payload.from_annotation_id == payload.to_annotation_id:
        raise HTTPException(
            status_code=400,
            detail="A relation cannot link an annotation to itself.",
        )
    src = db.get(Annotation, payload.from_annotation_id)
    if src is None:
        raise HTTPException(
            status_code=404, detail="Source annotation not found"
        )
    tgt = db.get(Annotation, payload.to_annotation_id)
    if tgt is None:
        raise HTTPException(
            status_code=404, detail="Target annotation not found"
        )
    if src.document_id != tgt.document_id:
        raise HTTPException(
            status_code=400,
            detail="Cross-document relations aren't supported in v0.",
        )
    rd = db.get(RelationDefinition, payload.relation_def_id)
    if rd is None:
        raise HTTPException(status_code=404, detail="Relation type not found")
    doc = db.get(Document, src.document_id)
    assert doc is not None  # FK guarantee
    if rd.project_id != doc.project_id:
        raise HTTPException(
            status_code=400,
            detail="Relation type belongs to a different project than the document.",
        )
    existing = db.scalar(
        select(AnnotationRelation).where(
            AnnotationRelation.from_annotation_id == payload.from_annotation_id,
            AnnotationRelation.to_annotation_id == payload.to_annotation_id,
            AnnotationRelation.relation_def_id == payload.relation_def_id,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="An identical relation already exists.",
        )
    rel = AnnotationRelation(
        document_id=src.document_id,
        from_annotation_id=payload.from_annotation_id,
        to_annotation_id=payload.to_annotation_id,
        relation_def_id=payload.relation_def_id,
        created_by=settings.default_user_id,
    )
    db.add(rel)
    db.commit()
    db.refresh(rel)
    return rel


@router.delete("/relations/{relation_id}", status_code=204)
def delete_relation(relation_id: int, db: Session = Depends(get_db)) -> None:
    rel = db.get(AnnotationRelation, relation_id)
    if rel is None:
        raise HTTPException(status_code=404, detail="Relation not found")
    db.delete(rel)
    db.commit()
