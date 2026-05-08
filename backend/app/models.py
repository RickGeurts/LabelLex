"""ORM models. v0 spike: flat label set, single-user, document-scoped annotations.

Hierarchical labels, attribute defs, relations, and inter-annotator agreement
land in a later iteration once the UI spine is proved. The data shape here is
intentionally narrow.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    labels: Mapped[list["LabelDefinition"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class LabelDefinition(Base):
    __tablename__ = "label_definitions"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_labeldef_project_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("label_definitions.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str] = mapped_column(String(16), default="#3b82f6")
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
    # Scope labels mark "this region is in-play"; clause labels (the default)
    # carry the actual factual labelling. Annotations of either kind share the
    # same span/edit/delete machinery — only rendering and the panel filter
    # treat them differently.
    is_scope: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    project: Mapped[Project] = relationship(back_populates="labels")
    parent: Mapped["LabelDefinition | None"] = relationship(
        "LabelDefinition", remote_side="LabelDefinition.id", back_populates="children"
    )
    children: Mapped[list["LabelDefinition"]] = relationship(
        "LabelDefinition", back_populates="parent", cascade="save-update"
    )
    attributes: Mapped[list["AttributeDefinition"]] = relationship(
        back_populates="label", cascade="all, delete-orphan", order_by="AttributeDefinition.id"
    )


class AttributeDefinition(Base):
    """Typed attribute slot attached to a label.

    Attributes are inherited by descendant labels: an annotation tagged with a
    descendant can carry values for any attribute defined on itself or on any
    ancestor. This keeps the schema authoring DRY (e.g. "currency" lives once
    on a parent group label, not duplicated on every leaf).

    `value_type` ∈ {"string", "enum", "bool", "number", "date"}. For enum,
    `enum_values` must be a non-empty list of strings; for the others it is
    null.
    """

    __tablename__ = "attribute_definitions"
    __table_args__ = (UniqueConstraint("label_id", "name", name="uq_attr_label_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    label_id: Mapped[int] = mapped_column(
        ForeignKey("label_definitions.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    value_type: Mapped[str] = mapped_column(String(16))
    enum_values: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    label: Mapped[LabelDefinition] = relationship(back_populates="attributes")


class DocumentCategory(Base):
    """Admin-defined per-project bucket (e.g. 'Senior Preferred Prospectus').

    Documents may be tagged with one category; the assignment is optional.
    Deleting a category nulls the FK on documents (handled in the router
    explicitly so behaviour matches whether or not SQLite has FK
    enforcement enabled).
    """

    __tablename__ = "document_categories"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_doccat_project_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
    color: Mapped[str] = mapped_column(String(16), default="#6366f1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("document_categories.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(512))
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="ready")  # uploading|parsing|ready|failed
    file_path: Mapped[str] = mapped_column(String(1024))
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # Bumped whenever an annotation on this document is created/updated/deleted
    # or when a clause-discovery suggestion is accepted. Drives the
    # "last activity" column in the project's document table.
    last_modified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )

    project: Mapped[Project] = relationship(back_populates="documents")
    pages: Mapped[list["Page"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="Page.page_num",
    )
    annotations: Mapped[list["Annotation"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (UniqueConstraint("document_id", "page_num", name="uq_page_doc_num"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    page_num: Mapped[int] = mapped_column(Integer)  # 1-based PDF ordinal
    printed_page_num: Mapped[str | None] = mapped_column(String(16), nullable=True)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text())
    # Words stored as JSON: list of {char_start, char_end, text, bbox:[x0,y0,x1,y1], block, line}
    words: Mapped[list[dict]] = mapped_column(JSON, default=list)

    document: Mapped[Document] = relationship(back_populates="pages")


class Annotation(Base):
    """A labelled span. Spans may cross page boundaries — the start and end
    are referenced as `(start_page_num, start_char)` and
    `(end_page_num, end_char)`. For single-page annotations,
    start_page_num == end_page_num.
    """

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    label_definition_id: Mapped[int] = mapped_column(ForeignKey("label_definitions.id"))
    start_page_num: Mapped[int] = mapped_column(Integer)
    start_char: Mapped[int] = mapped_column(Integer)  # offset within start page's text
    end_page_num: Mapped[int] = mapped_column(Integer)
    end_char: Mapped[int] = mapped_column(Integer)  # offset within end page's text (exclusive)
    text: Mapped[str] = mapped_column(Text())  # denormalised for display/search
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    document: Mapped[Document] = relationship(back_populates="annotations")
    label: Mapped[LabelDefinition] = relationship()
    attributes: Mapped[list["AnnotationAttribute"]] = relationship(
        back_populates="annotation",
        cascade="all, delete-orphan",
        order_by="AnnotationAttribute.id",
    )


class AnnotationAttribute(Base):
    """Concrete attribute value carried by a single annotation.

    `value` is JSON so the same column holds strings, numbers, booleans,
    enum-strings, and ISO-formatted dates without coercion gymnastics. The
    annotation router validates `value` against the AttributeDefinition's
    `value_type` and `enum_values` on write.
    """

    __tablename__ = "annotation_attributes"
    __table_args__ = (
        UniqueConstraint(
            "annotation_id", "attribute_def_id", name="uq_annattr_annotation_def"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    annotation_id: Mapped[int] = mapped_column(
        ForeignKey("annotations.id", ondelete="CASCADE")
    )
    attribute_def_id: Mapped[int] = mapped_column(
        ForeignKey("attribute_definitions.id")
    )
    value: Mapped[object] = mapped_column(JSON)

    annotation: Mapped[Annotation] = relationship(back_populates="attributes")
    attribute_def: Mapped[AttributeDefinition] = relationship()


class RelationDefinition(Base):
    """Admin-defined per-project relation type (e.g. 'modifies',
    'cross-references', 'subordinates-to'). Annotations are linked to
    each other via concrete `AnnotationRelation` rows whose `relation_def_id`
    points here.
    """

    __tablename__ = "relation_definitions"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_reldef_project_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
    color: Mapped[str] = mapped_column(String(16), default="#64748b")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )


class AnnotationRelation(Base):
    """A directed link between two annotations on the same document.

    Same-document constraint is enforced in the router (rejecting
    cross-document relations for v0). Self-loops (from == to) are also
    rejected. Cascading on annotation/relation-def delete is handled in
    Python because SQLite FK enforcement is off on this engine — the
    relation rows are removed explicitly before the parent goes away.
    """

    __tablename__ = "annotation_relations"
    __table_args__ = (
        UniqueConstraint(
            "from_annotation_id",
            "to_annotation_id",
            "relation_def_id",
            name="uq_annrel_from_to_def",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE")
    )
    from_annotation_id: Mapped[int] = mapped_column(
        ForeignKey("annotations.id", ondelete="CASCADE")
    )
    to_annotation_id: Mapped[int] = mapped_column(
        ForeignKey("annotations.id", ondelete="CASCADE")
    )
    relation_def_id: Mapped[int] = mapped_column(
        ForeignKey("relation_definitions.id", ondelete="CASCADE")
    )
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )


class AnnotationSuggestion(Base):
    """A model-proposed set of attribute values for a (label, clause) pair.

    Created with `status="pending"` when a labeller asks the model for a
    suggestion; resolved when they submit the resulting annotation. The
    diff flags + linked annotation_id powers the per-strategy scoreboard.

    Span fields are nullable because we may eventually suggest off the
    user's selection without knowing exact char offsets — for now they're
    populated from the form's current state.
    """

    __tablename__ = "annotation_suggestions"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE")
    )
    label_definition_id: Mapped[int] = mapped_column(
        ForeignKey("label_definitions.id")
    )

    # The clause text the suggestion was made against.
    text: Mapped[str] = mapped_column(Text())
    start_page_num: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_char: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_page_num: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_char: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Provenance.
    strategy: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(128))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)

    # Proposed attribute values: list of {attribute_def_id, value}.
    suggested_attributes: Mapped[list[dict]] = mapped_column(JSON, default=list)

    # Lifecycle.
    status: Mapped[str] = mapped_column(String(16), default="pending")
    annotation_id: Mapped[int | None] = mapped_column(
        ForeignKey("annotations.id", ondelete="SET NULL"), nullable=True
    )
    label_changed: Mapped[bool] = mapped_column(Boolean, default=False)
    span_changed: Mapped[bool] = mapped_column(Boolean, default=False)
    attributes_changed: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    label: Mapped[LabelDefinition] = relationship()
