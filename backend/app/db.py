"""SQLAlchemy engine, session, and Base."""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


_is_sqlite = settings.db_url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}
engine = create_engine(settings.db_url, connect_args=_connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


# SQLite-specific tuning. WAL lets readers run concurrently with one writer
# (instead of readers blocking on every write), which keeps the streaming
# pre-labelling endpoint from starving GETs. busy_timeout makes contended
# writes wait up to 5 s for the lock instead of erroring instantly with
# "database is locked" — important because Ollama-driven scans hold a
# write lock briefly per page-commit. Both are no-ops on Postgres.
if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, _connection_record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def run_lightweight_migrations() -> None:
    """Idempotent ALTER TABLE shims for v0.

    SQLAlchemy's `create_all` adds *new* tables but never new columns to
    existing ones. Until we adopt Alembic, this hand-rolled helper checks
    `PRAGMA table_info` and runs ALTERs / backfills as needed. Cheap to
    keep — each call is O(rows added) on a known column set, and bails
    out fast when the column already exists. Safe to call on every
    startup.
    """
    if not _is_sqlite:
        return
    with engine.begin() as conn:
        cols = {
            row[1]
            for row in conn.execute(text("PRAGMA table_info(documents)"))
        }
        if "last_modified_at" not in cols:
            conn.execute(
                text(
                    "ALTER TABLE documents ADD COLUMN last_modified_at TIMESTAMP"
                )
            )
            conn.execute(
                text(
                    "UPDATE documents SET last_modified_at = uploaded_at "
                    "WHERE last_modified_at IS NULL"
                )
            )
        if "category_id" not in cols:
            conn.execute(
                text("ALTER TABLE documents ADD COLUMN category_id INTEGER")
            )
        if "review_status" not in cols:
            conn.execute(
                text(
                    "ALTER TABLE documents ADD COLUMN review_status VARCHAR(16) "
                    "NOT NULL DEFAULT 'reviewed'"
                )
            )
            # Backfill: existing docs are 'reviewed' by default (the human
            # labelled them by hand). Auto-label runs flip new annotations'
            # parent doc to 'unverified' explicitly.

        label_cols = {
            row[1]
            for row in conn.execute(text("PRAGMA table_info(label_definitions)"))
        }
        if "is_scope" not in label_cols:
            conn.execute(
                text(
                    "ALTER TABLE label_definitions ADD COLUMN is_scope BOOLEAN "
                    "NOT NULL DEFAULT 0"
                )
            )
