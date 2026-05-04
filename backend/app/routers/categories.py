"""Document-category CRUD scoped to a project.

A category is a free-form bucket the project admin defines (e.g. 'Senior
Preferred Prospectus'). Documents may be tagged with one — assignment is
optional and lives on `Document.category_id`. Deleting a category nulls
the FK on all documents that referenced it; we do this in Python rather
than relying on SQLite's `ON DELETE SET NULL` because foreign-key
enforcement is off on this engine by default.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Document, DocumentCategory, Project
from ..schemas import (
    DocumentCategoryCreate,
    DocumentCategoryOut,
    DocumentCategoryUpdate,
)


router = APIRouter(prefix="/api", tags=["categories"])


@router.get(
    "/projects/{project_id}/categories",
    response_model=list[DocumentCategoryOut],
)
def list_categories(
    project_id: int, db: Session = Depends(get_db)
) -> list[DocumentCategory]:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return list(
        db.scalars(
            select(DocumentCategory)
            .where(DocumentCategory.project_id == project_id)
            .order_by(DocumentCategory.name)
        ).all()
    )


@router.post(
    "/projects/{project_id}/categories",
    response_model=DocumentCategoryOut,
    status_code=201,
)
def create_category(
    project_id: int,
    payload: DocumentCategoryCreate,
    db: Session = Depends(get_db),
) -> DocumentCategory:
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name required")
    existing = db.scalar(
        select(DocumentCategory).where(
            DocumentCategory.project_id == project_id,
            DocumentCategory.name == name,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"A category named '{name}' already exists in this project",
        )
    cat = DocumentCategory(
        project_id=project_id,
        name=name,
        description=payload.description,
        color=payload.color,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


@router.patch(
    "/categories/{category_id}",
    response_model=DocumentCategoryOut,
)
def update_category(
    category_id: int,
    payload: DocumentCategoryUpdate,
    db: Session = Depends(get_db),
) -> DocumentCategory:
    cat = db.get(DocumentCategory, category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="Category not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Category name required")
        if new_name != cat.name:
            clash = db.scalar(
                select(DocumentCategory).where(
                    DocumentCategory.project_id == cat.project_id,
                    DocumentCategory.name == new_name,
                    DocumentCategory.id != category_id,
                )
            )
            if clash is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"A category named '{new_name}' already exists",
                )
        cat.name = new_name
    if "description" in data:
        cat.description = data["description"]
    if "color" in data and data["color"]:
        cat.color = data["color"]
    db.commit()
    db.refresh(cat)
    return cat


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(category_id: int, db: Session = Depends(get_db)) -> None:
    cat = db.get(DocumentCategory, category_id)
    if cat is None:
        raise HTTPException(status_code=404, detail="Category not found")
    # Null out the FK on every document that referenced this category.
    db.execute(
        update(Document)
        .where(Document.category_id == category_id)
        .values(category_id=None)
    )
    db.delete(cat)
    db.commit()
