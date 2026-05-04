"""Zero-shot attribute prediction via Ollama with structured output.

Sends the clause text + the label definition + the schema of expected
attributes to the model and asks for a JSON object whose keys are
attribute names. The model gets no labelled examples — purely instruction
following plus its pretraining.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ...models import AttributeDefinition, LabelDefinition
from ..ollama import OllamaClient
from .base import Strategy, StrategyOutput, StrategyValue


_SYSTEM_PROMPT = (
    "You are an expert in EU bank-resolution law (BRRD/SRMR) classifying "
    "clauses from bank prospectuses. The user gives you a single clause, "
    "the label that has been applied to it, and a schema of attributes "
    "to extract. Respond with a JSON object whose keys are the attribute "
    "names and whose values match the requested types. Be conservative — "
    "if a value is not clearly determinable from the clause text, omit "
    "the key. Do not invent."
)


def _attr_schema_property(attr: AttributeDefinition) -> dict[str, Any]:
    """Translate an AttributeDefinition into a JSON-schema property."""
    if attr.value_type == "enum":
        return {
            "type": "string",
            "enum": list(attr.enum_values or []),
        }
    if attr.value_type == "string":
        return {"type": "string"}
    if attr.value_type == "bool":
        return {"type": "boolean"}
    if attr.value_type == "number":
        return {"type": "number"}
    if attr.value_type == "date":
        return {
            "type": "string",
            "description": "ISO 8601 date (YYYY-MM-DD).",
        }
    return {"type": "string"}


class ZeroShotStrategy(Strategy):
    name = "zero_shot"
    cost_rank = 0

    def predict_attributes(
        self,
        *,
        db: Session,
        label: LabelDefinition,
        attributes: list[AttributeDefinition],
        clause_text: str,
        ollama: OllamaClient,
    ) -> StrategyOutput:
        del db  # not needed for zero-shot
        if not attributes:
            return StrategyOutput(
                strategy=self.name,
                model=ollama.default_model,
                confidence=1.0,
                values=[],
            )

        properties: dict[str, dict[str, Any]] = {}
        attr_by_name: dict[str, AttributeDefinition] = {}
        for attr in attributes:
            properties[attr.name] = _attr_schema_property(attr)
            if attr.description:
                properties[attr.name]["description"] = attr.description
            attr_by_name[attr.name] = attr

        schema = {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        }

        attr_lines = "\n".join(
            f"- {a.name} ({a.value_type}{', ' + 'enum: ' + str(list(a.enum_values or [])) if a.value_type == 'enum' else ''}"
            f"{', required' if a.required else ''})"
            f"{': ' + a.description if a.description else ''}"
            for a in attributes
        )
        prompt = (
            f"Label applied to this clause: {label.name}\n"
            f"Label description: {label.description or '(none)'}\n\n"
            "Attributes to extract:\n"
            f"{attr_lines}\n\n"
            "Clause text (verbatim):\n"
            f"\"\"\"\n{clause_text}\n\"\"\"\n\n"
            "Return a JSON object whose keys are the attribute names listed "
            "above. Omit any attribute whose value cannot be confidently "
            "determined from the clause text."
        )

        response = ollama.generate_structured(
            prompt=prompt,
            schema=schema,
            system=_SYSTEM_PROMPT,
            options={"temperature": 0.1},
        )

        values: list[StrategyValue] = []
        for name, value in response.items():
            attr = attr_by_name.get(name)
            if attr is None:
                continue
            if value is None or value == "":
                continue
            values.append(StrategyValue(attribute_def_id=attr.id, value=value))

        # Confidence is 1.0 minus a small penalty per missing attribute —
        # Ollama doesn't expose token-level probabilities here, so this is
        # an interim coarse signal until we wire up logprobs / consensus
        # voting.
        missing = max(0, len(attributes) - len(values))
        confidence = max(0.0, 1.0 - 0.1 * missing)

        return StrategyOutput(
            strategy=self.name,
            model=ollama.default_model,
            confidence=confidence,
            values=values,
        )
