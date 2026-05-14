"""Claude-powered clause/instrument discovery — same shape as the Ollama
counterpart in `clause_instrument_discovery.py`.

Why a second implementation rather than abstracting the LLM:
- The Ollama path uses an httpx client + structured-output via JSON schema in
  the `format=` field of /api/generate. Claude uses the Anthropic SDK with
  prompt caching, adaptive thinking, and `output_config.format`. The two
  request shapes diverge enough that a shared "client" interface would
  obscure rather than clarify.
- The post-processing (re-anchor verbatim quotes against the page text) IS
  shared — we import `_anchor_quote` from the Ollama service.

Key choices:
- `claude-opus-4-7` with adaptive thinking — the skill's recommended default
  for non-trivial classification. Sampling parameters and `budget_tokens`
  are not supported on Opus 4.7.
- System prompt + ranking enum + few-shot examples are wrapped in a single
  cacheable system block. Across a 60-page sweep the prefix is hit ~59 times.
- Few-shot examples come from real accepted annotations on OTHER documents
  in the same project — pulled by the caller via `collect_few_shot_examples`.
- The per-page user message is intentionally lean (page text only) so the
  cacheable prefix dominates the request.
"""
from __future__ import annotations

from dataclasses import dataclass

import anthropic
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..models import Annotation, Document, LabelDefinition, Page
from .clause_discovery import _anchor_quote
from .clause_instrument_discovery import DiscoveredCandidate


@dataclass
class FewShotExample:
    """A single accepted-annotation example for in-context learning.

    `kind` is 'clause' or 'instrument'; for instrument we also carry the
    Ranking value the labeller chose, so the model sees how rankings map
    to representative spans.
    """

    kind: str  # "clause" | "instrument"
    text: str
    ranking: str | None = None


def collect_few_shot_examples(
    db: Session,
    project_id: int,
    clause_label_id: int,
    instrument_label_id: int,
    ranking_attribute_id: int,
    exclude_document_id: int | None = None,
    max_clauses: int = 6,
    max_instruments: int = 5,
) -> list[FewShotExample]:
    """Pull representative accepted annotations from OTHER docs in the project.

    Limits per kind keep the cached prefix bounded — we want enough to
    illustrate the pattern, not enough to balloon the input cost.
    """
    ann_q = (
        select(Annotation)
        .options(selectinload(Annotation.attributes))
        .join(Document, Annotation.document_id == Document.id)
        .where(Document.project_id == project_id)
    )
    if exclude_document_id is not None:
        ann_q = ann_q.where(Annotation.document_id != exclude_document_id)
    annotations = list(db.scalars(ann_q).all())

    clauses: list[FewShotExample] = []
    instruments: list[FewShotExample] = []
    for ann in annotations:
        text = (ann.text or "").strip()
        if not text:
            continue
        if ann.label_definition_id == clause_label_id and len(clauses) < max_clauses:
            clauses.append(FewShotExample(kind="clause", text=text))
        elif ann.label_definition_id == instrument_label_id and len(instruments) < max_instruments:
            ranking = None
            for attr in ann.attributes:
                if attr.attribute_def_id == ranking_attribute_id:
                    ranking = str(attr.value) if attr.value is not None else None
                    break
            instruments.append(
                FewShotExample(kind="instrument", text=text, ranking=ranking)
            )
        if len(clauses) >= max_clauses and len(instruments) >= max_instruments:
            break

    return clauses + instruments


_SYSTEM_PROMPT = """You are an expert in EU bank-resolution law (BRRD/SRMR) reading the Terms & Conditions of a bank prospectus. The user gives you the verbatim text of a single page from a T&C section. Identify two distinct things:

1. CLAUSES — every TOP-LEVEL numbered clause whose body appears in whole or in part on the page. Top-level means a heading shaped like `1.`, `2.`, `3.`, etc. — NOT lettered sub-divisions like `(a)`, `(b)`, `(e)`, NOT Roman numerals like `(i)`, `(ii)`, NOT inline defined terms. Emit the verbatim quote of the clause: include its number, heading, and body text up to (but not including) the next top-level number. If the clause spills onto the next page, emit only what is on THIS page.

2. INSTRUMENT MARKERS — only emit when the page contains a clause that EXPLICITLY identifies a specific ranking of instrument. Typical markers are 'Status of the [Ranking] Notes' clauses or section headings like 'Terms and Conditions of the [Ranking] Notes'. The quote is the verbatim clause that establishes the ranking. If the page does not introduce a specific ranking, return no instrument markers.

NEVER EMIT THESE AS STANDALONE CLAUSES (most common false positives):
- Lettered sub-divisions of a top-level clause: '(a) Type of Belgian pandbrieven', '(e) Redemption upon Tax Event', '(b) Form and Denomination', etc. These belong to the parent numbered clause's body. Even if they look heading-shaped, they are NOT top-level.
- Inline defined terms: '"Tax Event" means …', '"Maturity Date" has the meaning given in …'. These are definitions embedded inside a clause body, not clauses of their own.
- Mid-sentence fragments continuing from a previous page (e.g. "it is entitled to effect such redemption…" without a preceding heading on this page).
- Section preambles / introductory paragraphs that precede clause 1 (e.g. "The following is the text of the Terms and Conditions..."). These are not numbered clauses.
- Section/chapter headings, page headers, footers, running heads, dotted-leader TOC lines.

A page may contribute zero clauses, multiple clauses, or only the tail of a clause that started earlier. Returning an empty list is the correct answer for many pages.

RULES
- Copy quotes EXACTLY from the page text — no rewording, no truncation, no ellipses, no added quotation marks.
- The quote must be findable verbatim in the page text (whitespace-tolerant). Do not paraphrase headings.
- The 'Definitions' or 'Interpretation' clause IS a top-level clause if it is numbered (e.g. '1. Definitions'). Emit it.
"""


def _build_few_shot_block(examples: list[FewShotExample]) -> str:
    if not examples:
        return ""
    clauses = [e for e in examples if e.kind == "clause"]
    instruments = [e for e in examples if e.kind == "instrument"]
    lines: list[str] = [
        "REFERENCE EXAMPLES — these are the kinds of spans a human labeller "
        "annotated in similar prospectuses. Use them to calibrate granularity.",
        "",
    ]
    if clauses:
        lines.append("Examples of top-level CLAUSES (each is one annotation):")
        for i, e in enumerate(clauses, 1):
            preview = e.text[:600].replace("\n", " ").strip()
            lines.append(f"  [{i}] {preview}")
        lines.append("")
    if instruments:
        lines.append("Examples of INSTRUMENT markers (with their Ranking):")
        for i, e in enumerate(instruments, 1):
            preview = e.text[:600].replace("\n", " ").strip()
            ranking = e.ranking or "(unspecified)"
            lines.append(f"  [{i}] Ranking={ranking} | {preview}")
        lines.append("")
    return "\n".join(lines)


def _build_system_blocks(
    ranking_values: list[str], examples: list[FewShotExample]
) -> list[dict]:
    """Return system blocks ready for `messages.create(system=...)`.

    Single cached block holding prompt + ranking enum + few-shot examples,
    so a per-page sweep amortises the prefix across every page after the
    first.
    """
    ranking_lines = "\n".join(f"  - {v}" for v in ranking_values)
    body = _SYSTEM_PROMPT + (
        f"\nINSTRUMENT RANKING ENUM — use exactly one of these for any "
        f"instrument marker:\n{ranking_lines}\n"
    )
    few_shot = _build_few_shot_block(examples)
    if few_shot:
        body = body + "\n" + few_shot
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
            "clauses": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"quote": {"type": "string"}},
                    "required": ["quote"],
                    "additionalProperties": False,
                },
            },
            "instrument_markers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "quote": {"type": "string"},
                        "ranking": {"type": "string", "enum": ranking_values},
                    },
                    "required": ["quote", "ranking"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["clauses", "instrument_markers"],
        "additionalProperties": False,
    }


def _extract_json(message: anthropic.types.Message) -> dict:
    """Pull the JSON payload out of a Messages API response.

    With output_config.format set, the response's first text block is
    schema-conformant JSON. We still defensively scan for any text block
    so an unexpected ordering (e.g. thinking + text) doesn't drop us.
    """
    import json as _json

    for block in message.content:
        if getattr(block, "type", None) == "text":
            text = block.text or ""
            if text.strip():
                return _json.loads(text)
    return {}


def discover_on_page_claude(
    page: Page,
    clause_label: LabelDefinition,
    instrument_label: LabelDefinition,
    ranking_attribute_id: int,
    ranking_values: list[str],
    examples: list[FewShotExample],
    client: anthropic.Anthropic,
    model: str = "claude-opus-4-7",
) -> list[DiscoveredCandidate]:
    """One Claude call per page, emitting Clause + Instrument candidates.

    Mirrors `clause_instrument_discovery.discover_on_page` in shape — same
    `DiscoveredCandidate` outputs, same anchoring logic — so the
    surrounding endpoint code does not branch on provider for persistence.
    """
    if not page.text.strip() or not ranking_values:
        return []

    system_blocks = _build_system_blocks(ranking_values, examples)
    schema = _build_schema(ranking_values)
    user_text = (
        f"Page {page.page_num} of the document's T&C section. Verbatim text follows.\n\n"
        f'"""\n{page.text}\n"""\n\n'
        "Return the JSON object now."
    )

    message = client.messages.create(
        model=model,
        max_tokens=8000,
        system=system_blocks,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": user_text}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    payload = _extract_json(message)

    out: list[DiscoveredCandidate] = []
    seen: set[tuple[int, int, int]] = set()

    for item in payload.get("clauses", []):
        quote = str(item.get("quote", ""))
        anchor = _anchor_quote(page.text, quote)
        if anchor is None:
            continue
        start, end = anchor
        key = (clause_label.id, start, end)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            DiscoveredCandidate(
                label_definition_id=clause_label.id,
                start_page_num=page.page_num,
                start_char=start,
                end_page_num=page.page_num,
                end_char=end,
                text=page.text[start:end],
                confidence=0.85,
            )
        )

    for item in payload.get("instrument_markers", []):
        quote = str(item.get("quote", ""))
        ranking = str(item.get("ranking", "")).strip()
        if ranking not in ranking_values:
            continue
        anchor = _anchor_quote(page.text, quote)
        if anchor is None:
            continue
        start, end = anchor
        key = (instrument_label.id, start, end)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            DiscoveredCandidate(
                label_definition_id=instrument_label.id,
                start_page_num=page.page_num,
                start_char=start,
                end_page_num=page.page_num,
                end_char=end,
                text=page.text[start:end],
                confidence=0.85,
                suggested_attributes=[
                    {
                        "attribute_def_id": ranking_attribute_id,
                        "value": ranking,
                    }
                ],
            )
        )

    return out


def get_claude_client() -> anthropic.Anthropic | None:
    """Return a configured client, or None if no API key is set."""
    from ..config import settings

    if not settings.anthropic_api_key:
        return None
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)
