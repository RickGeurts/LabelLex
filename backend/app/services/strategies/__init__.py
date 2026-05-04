"""Pre-labelling strategies.

Each strategy proposes attribute values for a (label, clause) pair. They
share a single interface so the router can swap between them without
caller changes. Cost rank orders them from cheapest to most expensive:

  zero_shot  (0)  — single LLM call, no examples
  few_shot   (1)  — N labelled examples in the prompt          [Phase A.5]
  rag        (2)  — retrieved similar clauses + LLM            [Phase B]
  fine_tuned (3)  — dedicated model trained on the corpus      [Phase B+]

The router consults a per-(label, attribute) scoreboard derived from
suggestion outcomes and picks the cheapest strategy whose recent
accuracy clears a threshold. For Phase A the router is a stub that
always returns zero_shot, which gets us baseline numbers in the
scoreboard before we layer on the smarter routes.
"""
from __future__ import annotations

from .base import Strategy, StrategyOutput, StrategyValue
from .registry import get_strategy, list_strategies
from .router import route_for_attribute_prediction

__all__ = [
    "Strategy",
    "StrategyOutput",
    "StrategyValue",
    "get_strategy",
    "list_strategies",
    "route_for_attribute_prediction",
]
