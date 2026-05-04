"""Strategy router.

Phase A: always picks zero_shot. The point of having a router stub at all
is that callers don't need to know — when we add few_shot / rag and the
real per-(label, attribute) scoreboard, the call site stays unchanged.

Phase B will read recent SuggestionOutcome rows and pick the cheapest
strategy whose rolling accuracy clears a threshold.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ...models import LabelDefinition
from .base import Strategy
from .registry import get_strategy


def route_for_attribute_prediction(
    *, db: Session, label: LabelDefinition
) -> Strategy:
    del db, label  # unused in Phase A
    return get_strategy("zero_shot")
