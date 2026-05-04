"""Helpers for tracking document-level activity.

`touch_document` is the single point of truth for bumping
`Document.last_modified_at`. `attach_annotation_counts` mirrors the
LabelDefinition equivalent — one group-by query per request, then we
stash the result as an ad-hoc attribute on each ORM row so Pydantic's
`from_attributes` picks it up.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Annotation, Document


def touch_document(db: Session, document_id: int) -> None:
    """Mark `document_id` as just-modified. No-op if the doc was deleted."""
    doc = db.get(Document, document_id)
    if doc is None:
        return
    doc.last_modified_at = datetime.now(timezone.utc)


def attach_annotation_counts(
    db: Session, documents: Iterable[Document]
) -> None:
    doc_list = list(documents)
    if not doc_list:
        return
    ids = [d.id for d in doc_list]
    rows = db.execute(
        select(Annotation.document_id, func.count(Annotation.id))
        .where(Annotation.document_id.in_(ids))
        .group_by(Annotation.document_id)
    ).all()
    by_id = {row[0]: row[1] for row in rows}
    for doc in doc_list:
        doc.annotation_count = by_id.get(doc.id, 0)  # type: ignore[attr-defined]
