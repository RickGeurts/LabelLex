"""Bulk auto-labelling pipeline (production path).

Different shape from the interactive clause discovery:
- Clause boundaries come from a regex pre-pass (`clause_segmenter`),
  not from the LLM. Every top-level numbered clause becomes a Clause
  annotation automatically — no LLM call needed for that decision.
  This matches the user's observed labelling pattern (every top-level
  clause is annotated) and removes the entire class of false positives
  where the LLM mistook sub-paragraphs for clauses.
- The LLM (Sonnet 4.6 by default) is asked a single narrow question
  per clause: "Does this clause establish a specific instrument
  ranking, and if so, which one?". Easier task, higher accuracy.
- Results are written DIRECTLY to `Annotation` — no suggestion-review
  middleman. A paired `AnnotationSuggestion` row is still inserted as
  an audit trail (status `accepted_as_is`, linked via `annotation_id`).
- The document's `review_status` flips to `"unverified"` on completion
  so the LoRA Forge publish endpoint can gate on it.

Per-clause prompt caching: system prompt + ranking enum + few-shot
examples stay constant across every clause in a doc, so the cache hits
on every clause after the first.
"""
from __future__ import annotations

from dataclasses import dataclass

import anthropic
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Annotation,
    AnnotationAttribute,
    AnnotationSuggestion,
    Document,
    LabelDefinition,
    Page,
)
from .clause_instrument_discovery import detect_tnc_ranges
from .clause_instrument_discovery_claude import (
    FewShotExample,
    collect_few_shot_examples,
    get_claude_client,
)
from .clause_segmenter import ClauseSpan, segment_top_level_clauses
from .document_activity import touch_document


@dataclass
class InstrumentDecision:
    is_marker: bool
    ranking: str | None = None


@dataclass
class AutoLabelEvent:
    """One event in the auto-label stream."""

    type: str  # "started" | "clause_done" | "done" | "error"
    payload: dict


_SYSTEM_PROMPT = """You are an expert in EU bank-resolution law (BRRD/SRMR) reading a single numbered clause from the Terms & Conditions of a bank prospectus.

Your job is to answer ONE narrow question: does this clause establish or identify a specific RANKING of the financial instrument being issued? If yes, which ranking from the enum applies?

A clause IS an instrument marker when it:
- Has 'Status of [Ranking] Notes' or similar in its heading or body, AND specifies which type of instrument the holder owns.
- Defines that the notes 'qualify as', 'rank pari passu with', or 'constitute' a specific ranking (Tier 2, AT1, senior preferred, senior non-preferred, etc.).
- For covered bonds, includes 'issued as [Belgian/European] covered bonds (premium)', 'pandbrieven', or similar covered-bond establishing language.

A clause is NOT an instrument marker when it:
- Discusses general operational mechanics: redemption, payments, taxation, notices, meetings, governing law, definitions, etc.
- Mentions an instrument ranking only in passing (e.g. comparing to or referencing another type).
- Is purely a definition list, even if it defines ranking terms.

For prospectuses that establish a SINGLE instrument (e.g. a covered bond programme), only the FIRST clause that establishes the nature of the instrument should be a marker — not every later clause that mentions it.

Return JSON with `is_marker` (bool) and `ranking` (string from the enum, or null if is_marker is false).
"""


def _build_system_blocks(
    ranking_values: list[str], examples: list[FewShotExample]
) -> list[dict]:
    ranking_lines = "\n".join(f"  - {v}" for v in ranking_values)
    body = _SYSTEM_PROMPT + (
        "\nINSTRUMENT RANKING ENUM:\n" + ranking_lines + "\n"
    )
    instr_examples = [e for e in examples if e.kind == "instrument"]
    if instr_examples:
        body += "\nREFERENCE EXAMPLES — clauses that were marked as instrument markers:\n"
        for i, e in enumerate(instr_examples, 1):
            preview = e.text[:500].replace("\n", " ").strip()
            ranking = e.ranking or "(unspecified)"
            body += f"  [{i}] Ranking={ranking} | {preview}\n"
    return [
        {
            "type": "text",
            "text": body,
            "cache_control": {"type": "ephemeral"},
        }
    ]


def _build_schema(ranking_values: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "is_marker": {"type": "boolean"},
            "ranking": {
                "anyOf": [
                    {"type": "string", "enum": ranking_values},
                    {"type": "null"},
                ],
            },
        },
        "required": ["is_marker", "ranking"],
        "additionalProperties": False,
    }


def _extract_json(message: anthropic.types.Message) -> dict:
    import json as _json

    for block in message.content:
        if getattr(block, "type", None) == "text":
            text = block.text or ""
            if text.strip():
                return _json.loads(text)
    return {}


def _check_instrument(
    clause: ClauseSpan,
    ranking_values: list[str],
    system_blocks: list[dict],
    schema: dict,
    client: anthropic.Anthropic,
    model: str,
) -> InstrumentDecision:
    user_text = (
        f"Clause {clause.number}. {clause.heading}\n\n"
        f"Clause text (verbatim):\n"
        f'"""\n{clause.text}\n"""\n\n'
        "Return the JSON object now."
    )
    message = client.messages.create(
        model=model,
        max_tokens=1000,
        system=system_blocks,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": user_text}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    payload = _extract_json(message)
    is_marker = bool(payload.get("is_marker", False))
    ranking = payload.get("ranking")
    if is_marker and ranking and ranking in ranking_values:
        return InstrumentDecision(is_marker=True, ranking=str(ranking))
    return InstrumentDecision(is_marker=False)


def _persist_annotation(
    db: Session,
    document: Document,
    label_id: int,
    span: ClauseSpan,
    text: str,
    model_name: str,
    strategy_tag: str,
    suggested_attributes: list[dict] | None = None,
) -> Annotation:
    """Write an Annotation directly + a paired audit-trail AnnotationSuggestion."""
    ann = Annotation(
        document_id=document.id,
        label_definition_id=label_id,
        start_page_num=span.start_page_num,
        start_char=span.start_char,
        end_page_num=span.end_page_num,
        end_char=span.end_char,
        text=text,
        created_by=settings.default_user_id,
    )
    for entry in suggested_attributes or []:
        attr_id = entry.get("attribute_def_id")
        value = entry.get("value")
        if attr_id is None or value is None:
            continue
        ann.attributes.append(
            AnnotationAttribute(attribute_def_id=attr_id, value=value)
        )
    db.add(ann)
    db.flush()

    from datetime import datetime, timezone

    suggestion = AnnotationSuggestion(
        document_id=document.id,
        label_definition_id=label_id,
        text=text,
        start_page_num=span.start_page_num,
        start_char=span.start_char,
        end_page_num=span.end_page_num,
        end_char=span.end_char,
        strategy=strategy_tag,
        model=model_name,
        confidence=0.95,
        suggested_attributes=suggested_attributes or [],
        status="accepted_as_is",
        annotation_id=ann.id,
        label_changed=False,
        span_changed=False,
        attributes_changed=False,
        resolved_at=datetime.now(timezone.utc),
        resolved_by=settings.default_user_id,
    )
    db.add(suggestion)
    return ann


def run_auto_label(
    db: Session,
    document: Document,
    clause_label: LabelDefinition,
    instrument_label: LabelDefinition,
    ranking_attribute_id: int,
    ranking_values: list[str],
    tier: str = "regex",
    model: str | None = None,
):
    """Generator yielding NDJSON-shaped progress events.

    Two tiers:
    - "regex" (default, free, instant): writes one Clause annotation per
      top-level clause from the segmenter. Skips Instrument detection —
      we don't trust regex with semantic decisions. User escalates if
      this isn't enough.
    - "claude" (paid, ~30s): segments the same way, then runs one
      Sonnet/Opus call per clause to decide whether it's an Instrument
      marker. Writes both Clause and (when found) Instrument annotations.

    `started` event lists the clause count up-front so the UI can show
    a determinate progress bar. Each `clause_done` event reports the
    Annotation(s) written for that clause; `done` finalises and flips
    review_status.
    """
    use_model = model or "claude-sonnet-4-6"

    ranges = detect_tnc_ranges(document.file_path)
    if not ranges:
        yield AutoLabelEvent(
            type="error",
            payload={
                "message": (
                    "No Terms & Conditions section found in the document "
                    "outline. Add the section manually via the interactive "
                    "modal."
                )
            },
        )
        return

    # Segment per-T&C, then concatenate. Segmenting the combined page
    # list would let clause N of T&C i extend across the boundary into
    # T&C (i+1) — observed on NN Bank where clause 16 of Senior Preferred
    # absorbed the entire T&C-2 header + intro paragraph because the
    # segmenter's next-clause anchor was clause 1 of T&C 2.
    clauses = []
    for r in ranges:
        page_rows = list(
            db.scalars(
                select(Page)
                .where(Page.document_id == document.id)
                .where(Page.page_num >= r.start_page_num)
                .where(Page.page_num <= r.end_page_num)
                .order_by(Page.page_num)
            ).all()
        )
        clauses.extend(segment_top_level_clauses(page_rows))

    if not clauses:
        yield AutoLabelEvent(
            type="error",
            payload={
                "message": (
                    "No top-level numbered clauses detected by the "
                    "segmenter. This document's T&C section may use a "
                    "non-standard structure — fall back to the interactive "
                    "modal."
                )
            },
        )
        return

    # Claude-only setup. Skipped entirely on the regex tier.
    client = None
    system_blocks: list[dict] = []
    schema: dict = {}
    if tier == "claude":
        client = get_claude_client()
        if client is None:
            yield AutoLabelEvent(
                type="error",
                payload={
                    "message": (
                        "Claude tier requires LABELLEX_ANTHROPIC_API_KEY to "
                        "be set on the server."
                    )
                },
            )
            return
        few_shot = collect_few_shot_examples(
            db,
            project_id=document.project_id,
            clause_label_id=clause_label.id,
            instrument_label_id=instrument_label.id,
            ranking_attribute_id=ranking_attribute_id,
            exclude_document_id=document.id,
        )
        system_blocks = _build_system_blocks(ranking_values, few_shot)
        schema = _build_schema(ranking_values)

    started_model = use_model if tier == "claude" else "regex-only"
    strategy_tag = "auto_label_claude" if tier == "claude" else "auto_label_regex"

    yield AutoLabelEvent(
        type="started",
        payload={
            "model": started_model,
            "tier": tier,
            "clauses_total": len(clauses),
            "ranges": [
                {
                    "start_page_num": r.start_page_num,
                    "end_page_num": r.end_page_num,
                    "title": r.title,
                }
                for r in ranges
            ],
        },
    )

    try:
        for idx, clause in enumerate(clauses, start=1):
            # Always create the Clause annotation.
            clause_ann = _persist_annotation(
                db,
                document=document,
                label_id=clause_label.id,
                span=clause,
                text=clause.text,
                model_name=started_model,
                strategy_tag=strategy_tag,
            )
            instr_ann_id = None
            ranking_value = None

            if tier == "claude":
                try:
                    decision = _check_instrument(
                        clause,
                        ranking_values=ranking_values,
                        system_blocks=system_blocks,
                        schema=schema,
                        client=client,
                        model=use_model,
                    )
                except anthropic.APIError as exc:
                    db.commit()
                    yield AutoLabelEvent(
                        type="error",
                        payload={"message": f"Claude API error: {exc}"},
                    )
                    return

                if decision.is_marker and decision.ranking:
                    instr_ann = _persist_annotation(
                        db,
                        document=document,
                        label_id=instrument_label.id,
                        span=clause,
                        text=clause.text,
                        model_name=started_model,
                        strategy_tag=strategy_tag,
                        suggested_attributes=[
                            {
                                "attribute_def_id": ranking_attribute_id,
                                "value": decision.ranking,
                            }
                        ],
                    )
                    instr_ann_id = instr_ann.id
                    ranking_value = decision.ranking

            touch_document(db, document.id)
            db.commit()

            yield AutoLabelEvent(
                type="clause_done",
                payload={
                    "clauses_done": idx,
                    "clauses_total": len(clauses),
                    "number": clause.number,
                    "heading": clause.heading,
                    "clause_annotation_id": clause_ann.id,
                    "instrument_annotation_id": instr_ann_id,
                    "ranking": ranking_value,
                },
            )

        document.review_status = "unverified"
        db.commit()
        yield AutoLabelEvent(type="done", payload={})
    except Exception as exc:  # noqa: BLE001 — surface anything to client
        db.rollback()
        yield AutoLabelEvent(
            type="error", payload={"message": f"Unexpected error: {exc}"}
        )
