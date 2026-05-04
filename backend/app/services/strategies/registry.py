"""Strategy registry. New strategies register themselves here so the
router can pick from them without any wiring elsewhere.
"""
from __future__ import annotations

from .base import Strategy
from .zero_shot import ZeroShotStrategy


_REGISTRY: dict[str, Strategy] = {
    ZeroShotStrategy.name: ZeroShotStrategy(),
    # few_shot, rag, fine_tuned to come.
}


def get_strategy(name: str) -> Strategy:
    if name not in _REGISTRY:
        raise KeyError(f"Unknown strategy: {name}")
    return _REGISTRY[name]


def list_strategies() -> list[Strategy]:
    return sorted(_REGISTRY.values(), key=lambda s: s.cost_rank)
