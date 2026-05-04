"""Document-wide text search.

Plain case-insensitive substring search across every page's text. Returns
hits in reading order (page → char_start) up to `limit`. Each hit includes a
~60-char snippet centred on the match plus the match's offset inside that
snippet so the frontend can highlight without recomputing positions.

For v0.8 we use SQLite `LIKE` + Python `str.find` per page — fine up to
mid-thousands of pages on the dev machine. SQLite FTS5 (or Postgres
`tsvector`) would be the obvious upgrade once corpora grow.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Document, Page
from ..schemas import SearchHit


router = APIRouter(prefix="/api/documents/{document_id}/search", tags=["search"])


SNIPPET_CONTEXT = 30  # characters of context on each side of the match
ELLIPSIS = "…"


def _build_snippet(text: str, match_start: int, match_end: int) -> tuple[str, int]:
    raw_start = max(0, match_start - SNIPPET_CONTEXT)
    raw_end = min(len(text), match_end + SNIPPET_CONTEXT)
    body = text[raw_start:raw_end].replace("\n", " ")
    match_in_body = match_start - raw_start
    prefix = ELLIPSIS if raw_start > 0 else ""
    suffix = ELLIPSIS if raw_end < len(text) else ""
    snippet = f"{prefix}{body}{suffix}"
    match_in_snippet = match_in_body + len(prefix)
    return snippet, match_in_snippet


@router.get("", response_model=list[SearchHit])
def search_document(
    document_id: int,
    q: str = Query(..., min_length=2, description="Substring to search for (≥2 chars)."),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[SearchHit]:
    if db.get(Document, document_id) is None:
        raise HTTPException(status_code=404, detail="Document not found")

    needle = q.lower()
    needle_len = len(q)
    pages = db.scalars(
        select(Page)
        .where(Page.document_id == document_id)
        .order_by(Page.page_num)
    ).all()

    hits: list[SearchHit] = []
    for page in pages:
        text = page.text
        text_lower = text.lower()
        idx = 0
        while True:
            pos = text_lower.find(needle, idx)
            if pos == -1:
                break
            snippet, match_in_snippet = _build_snippet(text, pos, pos + needle_len)
            hits.append(
                SearchHit(
                    page_num=page.page_num,
                    char_start=pos,
                    char_end=pos + needle_len,
                    snippet=snippet,
                    match_in_snippet=match_in_snippet,
                )
            )
            if len(hits) >= limit:
                return hits
            idx = pos + max(1, needle_len)
    return hits