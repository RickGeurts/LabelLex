"""FastAPI app entrypoint. v0 spike: SQLite, single hardcoded user, no auth.

Run from repo root:
    .venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --app-dir backend
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import Base, SessionLocal, engine, run_lightweight_migrations
from .routers import (
    annotations,
    attributes,
    categories,
    documents,
    labels,
    projects,
    publish,
    relations,
    search,
    structure,
    suggestions,
)
from .seed import seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    run_lightweight_migrations()
    with SessionLocal() as db:
        seed(db)
    yield


app = FastAPI(title="LabelLex", version="0.0.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(labels.router)
app.include_router(attributes.router)
app.include_router(categories.router)
app.include_router(documents.router)
app.include_router(annotations.router)
app.include_router(relations.router)
app.include_router(search.router)
app.include_router(structure.router)
app.include_router(suggestions.router)
app.include_router(publish.router)


@app.get("/api/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}
