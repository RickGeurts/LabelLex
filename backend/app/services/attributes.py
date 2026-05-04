"""Attribute helpers: walk ancestry to collect effective attributes for a
label, and validate concrete values against their definitions.

`bool` validation is intentionally placed *before* `number` because
`isinstance(True, int) is True` in Python — without that ordering, booleans
would silently pass number validation.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from ..models import AttributeDefinition, LabelDefinition


def collect_effective_attributes(
    db: Session, label_id: int
) -> list[AttributeDefinition]:
    """All attribute definitions visible at `label_id`: own + ancestors.

    Order: deepest-first (own attributes, then parent's, then grandparent's...).
    Duplicates by id are de-duped (shouldn't happen with the unique
    constraint per label, but defensive).
    """
    out: list[AttributeDefinition] = []
    seen: set[int] = set()
    cur: int | None = label_id
    visited_labels: set[int] = set()
    while cur is not None and cur not in visited_labels:
        visited_labels.add(cur)
        label = db.get(LabelDefinition, cur)
        if label is None:
            break
        for attr in label.attributes:
            if attr.id not in seen:
                out.append(attr)
                seen.add(attr.id)
        cur = label.parent_id
    return out


def validate_value(
    value_type: str, enum_values: list[str] | None, value: Any
) -> Any:
    """Return `value` if it conforms to the type, else raise ValueError."""
    if value is None:
        return None
    if value_type == "string":
        if not isinstance(value, str):
            raise ValueError("expected string")
        return value
    if value_type == "enum":
        if not isinstance(value, str):
            raise ValueError("expected string for enum")
        if not enum_values or value not in enum_values:
            raise ValueError(f"value not in enum_values {enum_values}")
        return value
    if value_type == "bool":
        if not isinstance(value, bool):
            raise ValueError("expected bool")
        return value
    if value_type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("expected number")
        return value
    if value_type == "date":
        if not isinstance(value, str):
            raise ValueError("expected ISO date string")
        try:
            datetime.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"invalid ISO date: {exc}") from exc
        return value
    raise ValueError(f"unknown value_type: {value_type}")
