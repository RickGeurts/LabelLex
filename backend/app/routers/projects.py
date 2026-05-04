"""Project + label-listing endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..models import LabelDefinition, Project
from ..schemas import LabelOut, ProjectOut
from ..services.label_counts import attach_annotation_counts


router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)) -> list[Project]:
    projects = list(
        db.scalars(
            select(Project)
            .options(selectinload(Project.labels).selectinload(LabelDefinition.attributes))
            .order_by(Project.id)
        ).all()
    )
    for p in projects:
        attach_annotation_counts(db, p.labels)
    return projects


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, db: Session = Depends(get_db)) -> Project:
    project = db.scalar(
        select(Project)
        .options(selectinload(Project.labels).selectinload(LabelDefinition.attributes))
        .where(Project.id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    attach_annotation_counts(db, project.labels)
    return project


@router.get("/{project_id}/labels", response_model=list[LabelOut])
def list_labels(project_id: int, db: Session = Depends(get_db)) -> list[LabelDefinition]:
    labels = list(
        db.scalars(
            select(LabelDefinition)
            .options(selectinload(LabelDefinition.attributes))
            .where(LabelDefinition.project_id == project_id)
            .order_by(LabelDefinition.id)
        ).all()
    )
    attach_annotation_counts(db, labels)
    return labels
