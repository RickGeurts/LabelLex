"""Abstract Strategy + value types."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from ...models import AttributeDefinition, LabelDefinition
from ..ollama import OllamaClient


@dataclass
class StrategyValue:
    attribute_def_id: int
    value: Any


@dataclass
class StrategyOutput:
    """What every strategy returns to the router."""

    strategy: str
    model: str
    confidence: float
    values: list[StrategyValue] = field(default_factory=list)


class Strategy(ABC):
    """Interface for an attribute-prediction strategy."""

    name: str = ""
    cost_rank: int = 0

    @abstractmethod
    def predict_attributes(
        self,
        *,
        db: Session,
        label: LabelDefinition,
        attributes: list[AttributeDefinition],
        clause_text: str,
        ollama: OllamaClient,
    ) -> StrategyOutput:
        """Propose values for `attributes` (own + inherited) on this clause."""
