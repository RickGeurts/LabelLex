"""File storage for uploaded PDFs. Local filesystem behind a thin interface
so we can swap in MinIO/S3 later without touching the routers.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import BinaryIO

from ..config import settings


def _uploads_dir() -> Path:
    p = settings.storage_dir / "uploads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_upload(document_id: int, source: BinaryIO) -> Path:
    """Persist an uploaded PDF stream under storage/uploads/{document_id}.pdf."""
    target = _uploads_dir() / f"{document_id}.pdf"
    with target.open("wb") as out:
        shutil.copyfileobj(source, out)
    return target


def upload_path(document_id: int) -> Path:
    return _uploads_dir() / f"{document_id}.pdf"


def delete_upload(document_id: int) -> None:
    target = upload_path(document_id)
    if target.exists():
        target.unlink()