"""Project + label-listing endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..db import get_db
from ..models import LabelDefinition, Project
from ..schemas import LabelOut, ProjectCreate, ProjectOut
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


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectCreate, db: Session = Depends(get_db)
) -> Project:
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name required")
    if db.scalar(select(Project).where(Project.name == name)) is not None:
        raise HTTPException(
            status_code=409, detail=f"A project named '{name}' already exists"
        )
    project = Project(name=name, owner_id=settings.default_user_id)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


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


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)) -> None:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(project)
    db.commit()


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
