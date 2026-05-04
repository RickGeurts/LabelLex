"""Attach annotation usage counts to LabelDefinition instances.

The count is exposed via `LabelOut.annotation_count`. We resolve it in a
single group-by query per request and stash the result as an ad-hoc
attribute on each ORM instance — Pydantic's `from_attributes=True` reads it
through `getattr`, so this stays decoupled from the SQL model.
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Annotation, LabelDefinition


def attach_annotation_counts(
    db: Session, labels: Iterable[LabelDefinition]
) -> None:
    label_list = list(labels)
    if not label_list:
        return
    ids = [l.id for l in label_list]
    rows = db.execute(
        select(Annotation.label_definition_id, func.count(Annotation.id))
        .where(Annotation.label_definition_id.in_(ids))
        .group_by(Annotation.label_definition_id)
    ).all()
    by_id = {row[0]: row[1] for row in rows}
    for label in label_list:
        label.annotation_count = by_id.get(label.id, 0)  # type: ignore[attr-defined]
