"""Pydantic schemas for request/response bodies."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


VALUE_TYPES = ("string", "enum", "bool", "number", "date")
ValueType = Literal["string", "enum", "bool", "number", "date"]


class _Base(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Attribute definitions (the schema admin attaches to labels) ----------

class AttributeOut(_Base):
    id: int
    label_id: int
    name: str
    value_type: ValueType
    enum_values: list[str] | None = None
    required: bool
    description: str | None = None


class AttributeCreate(BaseModel):
    name: str
    value_type: ValueType
    enum_values: list[str] | None = None
    required: bool = False
    description: str | None = None


class AttributeUpdate(BaseModel):
    name: str | None = None
    value_type: ValueType | None = None
    enum_values: list[str] | None = None
    required: bool | None = None
    description: str | None = None


# --- Labels ----------------------------------------------------------------

class LabelOut(_Base):
    id: int
    project_id: int
    parent_id: int | None = None
    name: str
    color: str
    description: str | None = None
    is_scope: bool = False
    attributes: list[AttributeOut] = Field(default_factory=list)
    annotation_count: int = 0


class LabelCreate(BaseModel):
    name: str
    color: str = "#3b82f6"
    description: str | None = None
    parent_id: int | None = None
    is_scope: bool = False


class LabelUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    description: str | None = None
    parent_id: int | None = None
    is_scope: bool | None = None


# --- Projects --------------------------------------------------------------

class ProjectOut(_Base):
    id: int
    name: str
    owner_id: int
    created_at: datetime
    labels: list[LabelOut] = Field(default_factory=list)


class ProjectCreate(BaseModel):
    name: str


# --- Documents / Pages -----------------------------------------------------

class DocumentOut(_Base):
    id: int
    project_id: int
    category_id: int | None = None
    filename: str
    page_count: int
    status: str
    uploaded_by: int
    uploaded_at: datetime
    last_modified_at: datetime
    annotation_count: int = 0


class DocumentUpdate(BaseModel):
    """Mutate document-level metadata. v0: only `category_id` is editable
    (set to null to unassign). All other doc state — filename, page_count,
    status, etc. — is owned by the upload pipeline."""

    category_id: int | None = None
    # `model_fields_set` distinguishes "unset" from "explicitly null", so a
    # null payload truly clears the category instead of being a no-op.


class DocumentCategoryOut(_Base):
    id: int
    project_id: int
    name: str
    description: str | None = None
    color: str
    created_at: datetime


class DocumentCategoryCreate(BaseModel):
    name: str
    description: str | None = None
    color: str = "#6366f1"


class DocumentCategoryUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None


# --- Relation definitions + relations -------------------------------------

class RelationDefinitionOut(_Base):
    id: int
    project_id: int
    name: str
    description: str | None = None
    color: str
    created_at: datetime


class RelationDefinitionCreate(BaseModel):
    name: str
    description: str | None = None
    color: str = "#64748b"


class RelationDefinitionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None


class AnnotationRelationOut(_Base):
    id: int
    document_id: int
    from_annotation_id: int
    to_annotation_id: int
    relation_def_id: int
    created_by: int
    created_at: datetime


class AnnotationRelationCreate(BaseModel):
    from_annotation_id: int
    to_annotation_id: int
    relation_def_id: int


class WordOut(BaseModel):
    char_start: int
    char_end: int
    text: str
    bbox: list[float]  # [x0, y0, x1, y1] in PDF point coordinates
    block: int
    line: int


class PageOut(_Base):
    id: int
    page_num: int
    printed_page_num: str | None
    width: float
    height: float
    text: str
    words: list[WordOut]


# --- Annotations -----------------------------------------------------------

class AnnotationAttributeIn(BaseModel):
    attribute_def_id: int
    value: Any


class AnnotationAttributeOut(_Base):
    attribute_def_id: int
    value: Any


class AnnotationCreate(BaseModel):
    document_id: int
    label_definition_id: int
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str
    attributes: list[AnnotationAttributeIn] = Field(default_factory=list)
    # When the labeller used a suggestion to fill the form, the client
    # sends the suggestion id back so we can compute the outcome diff
    # for the strategy scoreboard.
    suggestion_id: int | None = None


class AnnotationUpdate(BaseModel):
    """Mutate an annotation. All fields are optional.

    - `attributes`: replaces the attribute set wholesale.
    - The four span fields plus `text` may be sent together (or not at all)
      to resize. Re-labelling is still done by delete+create.
    """

    attributes: list[AnnotationAttributeIn] | None = None
    start_page_num: int | None = None
    start_char: int | None = None
    end_page_num: int | None = None
    end_char: int | None = None
    text: str | None = None
    suggestion_id: int | None = None


class AnnotationOut(_Base):
    id: int
    document_id: int
    label_definition_id: int
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str
    created_by: int
    created_at: datetime
    attributes: list[AnnotationAttributeOut] = Field(default_factory=list)


# --- Search ----------------------------------------------------------------

class SearchHit(BaseModel):
    page_num: int
    char_start: int
    char_end: int
    snippet: str
    match_in_snippet: int  # byte offset of the match within `snippet`


# --- Ollama / structure detection -----------------------------------------

class OllamaStatus(BaseModel):
    reachable: bool
    error: str | None = None
    base_url: str
    configured_model: str
    configured_model_available: bool
    models: list[str] = Field(default_factory=list)


class DetectedSectionOut(BaseModel):
    title: str
    page_num: int
    section_type: str
    confidence: float = 1.0


class DetectStructureResponse(BaseModel):
    document_id: int
    model: str
    sections: list[DetectedSectionOut]


# --- Suggestions / strategy routing ---------------------------------------

class SuggestAttributesIn(BaseModel):
    document_id: int
    label_definition_id: int
    text: str
    start_page_num: int | None = None
    start_char: int | None = None
    end_page_num: int | None = None
    end_char: int | None = None


class SuggestedAttribute(BaseModel):
    attribute_def_id: int
    value: Any


class SuggestAttributesOut(_Base):
    suggestion_id: int
    strategy: str
    model: str
    confidence: float
    attributes: list[SuggestedAttribute]


class SuggestionOut(_Base):
    id: int
    document_id: int
    label_definition_id: int
    text: str
    strategy: str
    model: str
    confidence: float
    suggested_attributes: list[SuggestedAttribute]
    status: str
    annotation_id: int | None
    label_changed: bool
    span_changed: bool
    attributes_changed: bool
    created_at: datetime
    resolved_at: datetime | None


class StrategyScoreRow(BaseModel):
    label_definition_id: int
    label_name: str
    attribute_def_id: int | None
    attribute_name: str | None
    strategy: str
    suggestions: int
    accepted_as_is: int
    modified: int
    rejected: int
    pending: int
    accuracy: float  # accepted_as_is / (accepted_as_is + modified) — ignores pending/rejected


# --- Pre-labelling (clause discovery) -------------------------------------

class PrelabelRequest(BaseModel):
    start_page_num: int
    end_page_num: int
    # If null/empty, scan against every label in the document's project.
    label_definition_ids: list[int] | None = None


class PrelabelCandidate(_Base):
    suggestion_id: int
    label_definition_id: int
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str
    confidence: float


class SuggestionListItem(_Base):
    id: int
    document_id: int
    label_definition_id: int
    text: str
    start_page_num: int | None
    start_char: int | None
    end_page_num: int | None
    end_char: int | None
    strategy: str
    model: str
    confidence: float
    suggested_attributes: list[SuggestedAttribute]
    status: str
    annotation_id: int | None
    created_at: datetime