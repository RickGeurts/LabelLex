"""Clause discovery: ask Ollama to find clauses matching a label set, page by page.

The model gets the verbatim text of a single page plus a list of labels
(name + description) and is constrained by JSON schema to return verbatim
quotes labelled with one of the provided names. Each returned quote is
re-anchored to the page text by exact substring match — paraphrased
candidates are dropped via a whitespace-tolerant fallback.

Why per-page chunking: bank prospectuses are 200–400 pages but a single
T&Cs section is ~30 pages. Per-page calls (~700 input tokens, small JSON
output) keep each round-trip fast and bounded; the model also scopes
better to a single page than an entire section. Trade-off: a clause
straddling a page break splits into two per-page candidates — the
labeller can extend the span via "edit span" once they're in the viewer.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..models import LabelDefinition, Page
from .ollama import OllamaClient


_SYSTEM_PROMPT = (
    "You are an expert in EU bank-resolution law (BRRD/SRMR) reading "
    "clauses from a bank prospectus. The user gives you the verbatim text "
    "of a single page and a list of labels with descriptions. Identify "
    "every clause on the page that matches one of the provided labels and "
    "return each as a verbatim quote. Quotes MUST be copied exactly from "
    "the page text — no rewording, no truncation, no ellipses. Prefer the "
    "smallest self-contained span of text that captures the clause "
    "(usually a sentence or paragraph, not the entire section). If "
    "multiple labels apply, pick the most specific. If no label applies, "
    "return an empty list. Do not invent quotes."
)


@dataclass
class DiscoveredCandidate:
    label_definition_id: int
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str
    confidence: float


def _build_schema(label_names: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "candidates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "enum": label_names},
                        "quote": {"type": "string"},
                    },
                    "required": ["label", "quote"],
                },
            },
        },
        "required": ["candidates"],
    }


def _build_prompt(page_text: str, labels: list[LabelDefinition]) -> str:
    label_lines = "\n".join(
        f"- {l.name}: {l.description or '(no description)'}" for l in labels
    )
    return (
        "Labels to scan for:\n"
        f"{label_lines}\n\n"
        "Page text (verbatim):\n"
        f'"""\n{page_text}\n"""\n\n'
        "Return a JSON object with key 'candidates' — one entry per clause "
        "you identify. Each entry has 'label' (one of the names above) and "
        "'quote' (the clause text copied verbatim from the page)."
    )


def _whitespace_tolerant_find(haystack: str, needle: str) -> tuple[int, int] | None:
    """Find `needle` in `haystack` treating any whitespace run in either as
    matching any whitespace run on the other side. Returns (start, end)
    referring to `haystack`, or None.

    Bank prospectus pages have hard line breaks at column boundaries; the
    model often returns quotes with those breaks normalised to single
    spaces. A naive substring match would miss them.
    """
    needle = needle.strip()
    if not needle:
        return None
    n_len = len(needle)
    h_len = len(haystack)
    for i in range(h_len):
        h = i
        nc = 0
        while h < h_len and nc < n_len:
            hch = haystack[h]
            ncch = needle[nc]
            if hch.isspace() and ncch.isspace():
                while h < h_len and haystack[h].isspace():
                    h += 1
                while nc < n_len and needle[nc].isspace():
                    nc += 1
            elif hch == ncch:
                h += 1
                nc += 1
            else:
                break
        if nc == n_len:
            return i, h
    return None


def _anchor_quote(page_text: str, quote: str) -> tuple[int, int] | None:
    if not quote.strip():
        return None
    idx = page_text.find(quote)
    if idx >= 0:
        return idx, idx + len(quote)
    return _whitespace_tolerant_find(page_text, quote)


def discover_clauses_on_page(
    page: Page,
    labels: list[LabelDefinition],
    ollama: OllamaClient,
) -> list[DiscoveredCandidate]:
    if not labels or not page.text.strip():
        return []
    name_to_id = {l.name: l.id for l in labels}
    label_names = list(name_to_id.keys())
    schema = _build_schema(label_names)
    prompt = _build_prompt(page.text, labels)
    response = ollama.generate_structured(
        prompt=prompt,
        schema=schema,
        system=_SYSTEM_PROMPT,
        options={"temperature": 0.1},
    )
    out: list[DiscoveredCandidate] = []
    seen: set[tuple[int, int, int]] = set()
    for item in response.get("candidates", []):
        label_name = str(item.get("label", "")).strip()
        quote = str(item.get("quote", ""))
        label_id = name_to_id.get(label_name)
        if label_id is None:
            continue
        anchor = _anchor_quote(page.text, quote)
        if anchor is None:
            continue
        start, end = anchor
        key = (label_id, start, end)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            DiscoveredCandidate(
                label_definition_id=label_id,
                start_page_num=page.page_num,
                start_char=start,
                end_page_num=page.page_num,
                end_char=end,
                text=page.text[start:end],
                confidence=0.7,
            )
        )
    return out
