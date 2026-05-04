"""Ollama-driven structure detection on uploaded prospectuses."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Document
from ..schemas import (
    DetectedSectionOut,
    DetectStructureResponse,
    OllamaStatus,
)
from ..services.ollama import OllamaError, get_ollama_client
from ..services.structure_detector import detect_structure


router = APIRouter(prefix="/api", tags=["structure"])


@router.get("/ollama/status", response_model=OllamaStatus)
def ollama_status() -> OllamaStatus:
    return OllamaStatus(**get_ollama_client().status())


@router.post(
    "/documents/{document_id}/detect-structure",
    response_model=DetectStructureResponse,
)
def detect_document_structure(
    document_id: int, db: Session = Depends(get_db)
) -> DetectStructureResponse:
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    client = get_ollama_client()
    status = client.status()
    if not status["reachable"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama is not reachable at {status['base_url']} "
                f"({status.get('error')}). Start the daemon and retry."
            ),
        )
    if not status["configured_model_available"]:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Configured model '{status['configured_model']}' is not "
                f"installed locally. Run: ollama pull {status['configured_model']}"
            ),
        )

    try:
        sections = detect_structure(doc.file_path, client)
    except OllamaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return DetectStructureResponse(
        document_id=document_id,
        model=client.default_model,
        sections=[
            DetectedSectionOut(
                title=s.title,
                page_num=s.page_num,
                section_type=s.section_type,
                confidence=s.confidence,
            )
            for s in sections
        ],
    )
