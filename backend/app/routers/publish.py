"""Push a project's labelled documents to a sibling LoRA Forge instance.

LoRA Forge consumes the payload at `/datasets/labellex-webhook` and
materialises it as a Dataset that drives clause-extractor fine-tuning.
The contract is one-way and idempotent on the LoRA Forge side: re-
publishing the same project replaces the previous dataset row.

Documents with zero annotations are still listed in the payload so the
LoRA Forge side can report what was skipped — keeping the user honest
about coverage gaps in their labelling.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..db import get_db
from ..models import (
    Annotation,
    AnnotationAttribute,
    AttributeDefinition,
    Document,
    LabelDefinition,
    Page,
    Project,
)


router = APIRouter(prefix="/api/projects", tags=["publish"])


def _document_text(document: Document) -> str:
    """Concatenate every page's extracted text in page order.

    Pages are pre-sorted by page_num via the Document.pages relationship.
    Two newlines between pages so downstream chunkers can spot boundaries.
    """
    return "\n\n".join((p.text or "").strip() for p in document.pages)


def _serialise_annotation(
    ann: Annotation,
    label_name_by_id: dict[int, str],
    attr_name_by_id: dict[int, str],
) -> dict:
    """Flatten a stored annotation into the LoRA Forge payload shape.

    Attributes are emitted as a flat `{name: value}` dict (LoRA Forge
    doesn't care about the typed schema, it just renders them as
    `(key=value, ...)` pairs alongside the clause text).
    """
    attributes: dict[str, object] = {}
    for av in ann.attributes:
        name = attr_name_by_id.get(av.attribute_def_id)
        if name:
            attributes[name] = av.value
    return {
        "label": label_name_by_id.get(ann.label_definition_id, "unknown"),
        "text": ann.text,
        "startPage": ann.start_page_num,
        "endPage": ann.end_page_num,
        "attributes": attributes,
    }


def _build_payload(project: Project, documents: list[Document]) -> dict:
    label_name_by_id = {lbl.id: lbl.name for lbl in project.labels}
    attr_name_by_id: dict[int, str] = {}
    for lbl in project.labels:
        for attr in lbl.attributes:
            attr_name_by_id[attr.id] = attr.name

    return {
        "source": "labellex",
        "schemaVersion": 1,
        "project": {"id": project.id, "name": project.name},
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "taskType": "clause_extractor",
        "documents": [
            {
                "id": d.id,
                "filename": d.filename,
                "documentText": _document_text(d),
                "annotations": [
                    _serialise_annotation(a, label_name_by_id, attr_name_by_id)
                    for a in d.annotations
                ],
            }
            for d in documents
        ],
    }


class PublishRequest(BaseModel):
    """Optional body for publish-to-lora-forge.

    `publish_unverified` is the override switch: by default the endpoint
    refuses to publish if any document carries `review_status="unverified"`
    so model-labelled artefacts can't ship to fine-tuning without a human
    pass. Set to true to bypass.
    """

    publish_unverified: bool = False


@router.post("/{project_id}/publish-to-lora-forge")
def publish_to_lora_forge(
    project_id: int,
    body: PublishRequest | None = None,
    db: Session = Depends(get_db),
) -> dict:
    """Bundle every document + annotation in this project and POST to LoRA Forge.

    Returns LoRA Forge's response inline so the caller (UI) can show the
    new dataset id without a follow-up request.
    """
    publish_unverified = bool(body and body.publish_unverified)
    project = db.scalar(
        select(Project)
        .options(
            selectinload(Project.labels).selectinload(LabelDefinition.attributes),
        )
        .where(Project.id == project_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    documents = list(
        db.scalars(
            select(Document)
            .options(
                selectinload(Document.pages),
                selectinload(Document.annotations).selectinload(
                    Annotation.attributes
                ),
            )
            .where(Document.project_id == project_id)
            .order_by(Document.id)
        ).all()
    )

    unverified = [d for d in documents if d.review_status == "unverified"]
    if unverified and not publish_unverified:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "unverified_documents",
                "message": (
                    f"{len(unverified)} document(s) are model-labelled but "
                    "have not been marked as reviewed. Review them in the "
                    "viewer, or set publish_unverified=true to override."
                ),
                "unverifiedDocumentIds": [d.id for d in unverified],
                "unverifiedDocumentCount": len(unverified),
            },
        )

    payload = _build_payload(project, documents)

    try:
        response = httpx.post(
            settings.lora_forge_webhook_url,
            json=payload,
            timeout=settings.lora_forge_timeout_seconds,
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not reach LoRA Forge at "
                f"{settings.lora_forge_webhook_url}: {exc}. "
                "Check that LoRA Forge is running and that "
                "LABELLEX_LORA_FORGE_WEBHOOK_URL is correct."
            ),
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"LoRA Forge rejected the publish "
                f"(HTTP {response.status_code}): {response.text[:500]}"
            ),
        )

    dataset = response.json()
    docs_with_labels = sum(1 for d in payload["documents"] if d["annotations"])
    total_annotations = sum(
        len(d["annotations"]) for d in payload["documents"]
    )
    return {
        "ok": True,
        "loraForgeUrl": settings.lora_forge_webhook_url,
        "dataset": dataset,
        "summary": {
            "totalDocuments": len(documents),
            "documentsWithLabels": docs_with_labels,
            "annotations": total_annotations,
        },
    }
