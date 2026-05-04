"""Document upload + retrieval. Upload parses synchronously for v0; large docs
will move to a background job once we wire the pre-labelling pipeline."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Document, DocumentCategory, Page, Project
from ..schemas import DocumentOut, DocumentUpdate, PageOut
from ..services import storage
from ..services.document_activity import attach_annotation_counts
from ..services.pdf_parser import parse_pdf


router = APIRouter(prefix="/api", tags=["documents"])


@router.get("/projects/{project_id}/documents", response_model=list[DocumentOut])
def list_documents(project_id: int, db: Session = Depends(get_db)) -> list[Document]:
    docs = list(
        db.scalars(
            select(Document)
            .where(Document.project_id == project_id)
            .order_by(Document.last_modified_at.desc())
        ).all()
    )
    attach_annotation_counts(db, docs)
    return docs


@router.post(
    "/projects/{project_id}/documents",
    response_model=DocumentOut,
    status_code=201,
)
def upload_document(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> Document:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDFs are supported")

    doc = Document(
        project_id=project_id,
        filename=file.filename or "document.pdf",
        page_count=0,
        status="parsing",
        file_path="",
        uploaded_by=settings.default_user_id,
    )
    db.add(doc)
    db.flush()  # need doc.id for storage path

    saved_path = storage.save_upload(doc.id, file.file)
    doc.file_path = str(saved_path)

    try:
        parsed = parse_pdf(saved_path)
    except Exception as exc:
        doc.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail=f"PDF parse failed: {exc}") from exc

    doc.page_count = parsed.page_count
    for parsed_page in parsed.pages:
        db.add(
            Page(
                document_id=doc.id,
                page_num=parsed_page.page_num,
                printed_page_num=None,  # TODO: extract from header/footer
                width=parsed_page.width,
                height=parsed_page.height,
                text=parsed_page.text,
                words=[w.to_dict() for w in parsed_page.words],
            )
        )
    doc.status = "ready"
    db.commit()
    db.refresh(doc)
    return doc


@router.get("/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: int, db: Session = Depends(get_db)) -> Document:
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    attach_annotation_counts(db, [doc])
    return doc


@router.patch("/documents/{document_id}", response_model=DocumentOut)
def update_document(
    document_id: int,
    payload: DocumentUpdate,
    db: Session = Depends(get_db),
) -> Document:
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    data = payload.model_dump(exclude_unset=True)
    if "category_id" in data:
        new_cat_id = data["category_id"]
        if new_cat_id is None:
            doc.category_id = None
        else:
            cat = db.get(DocumentCategory, new_cat_id)
            if cat is None:
                raise HTTPException(
                    status_code=404, detail="Category not found"
                )
            if cat.project_id != doc.project_id:
                raise HTTPException(
                    status_code=400,
                    detail="Category belongs to a different project",
                )
            doc.category_id = new_cat_id
    db.commit()
    db.refresh(doc)
    attach_annotation_counts(db, [doc])
    return doc


@router.get("/documents/{document_id}/pdf")
def get_document_pdf(document_id: int, db: Session = Depends(get_db)) -> FileResponse:
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    path = storage.upload_path(doc.id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="PDF file missing on disk")
    return FileResponse(path, media_type="application/pdf", filename=doc.filename)


@router.get("/documents/{document_id}/pages/{page_num}", response_model=PageOut)
def get_page(document_id: int, page_num: int, db: Session = Depends(get_db)) -> Page:
    page = db.scalar(
        select(Page).where(Page.document_id == document_id, Page.page_num == page_num)
    )
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return page


@router.get("/documents/{document_id}/pages", response_model=list[PageOut])
def get_all_pages(document_id: int, db: Session = Depends(get_db)) -> list[Page]:
    """Bulk fetch every page (with words) for a document.

    Used by the continuous-scroll viewer so cross-page selection has all the
    word data it needs without round-tripping per page. For the reference
    254-page prospectus this is ~15 MB raw / ~3 MB gzipped — acceptable for
    a one-shot on document open.
    """
    if db.get(Document, document_id) is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return list(
        db.scalars(
            select(Page)
            .where(Page.document_id == document_id)
            .order_by(Page.page_num)
        ).all()
    )
