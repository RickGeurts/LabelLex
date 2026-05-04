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

import re
from dataclasses import dataclass

from ..models import LabelDefinition, Page
from .ollama import OllamaClient


_WORD_RE = re.compile(r"\S+")
_PUNCT_STRIP = ",.;:!?\"'()[]{}«»“”‘’"


_SYSTEM_PROMPT = """You are an expert in EU bank-resolution law (BRRD/SRMR) reading clauses from a bank prospectus. The user gives you the verbatim text of a single page and a list of labels with descriptions. Identify every clause on the page that matches one of the provided labels and return each as a verbatim quote.

RULES
- Copy quotes EXACTLY from the page text — no rewording, no truncation, no ellipses, no quotation marks added.
- Prefer the smallest self-contained span (one sentence or one paragraph), not the whole section.
- Pick the MOST SPECIFIC label that applies. Prefer 'Subordination Clause' or 'Acceleration / Default' over the catch-all 'MREL-Eligible (positive)' when the clause is specifically about ranking or acceleration.

WHAT COUNTS AS A CLAUSE
- Substantive operative language: contractual statements about ranking, redemption, default, loss absorption, payment, etc.
- Both substantive triggers and explicit limitations are valid (e.g. 'no right of acceleration except…').

DO NOT RETURN
- Section / chapter headings ('TERMS AND CONDITIONS OF THE SUBORDINATED NOTES', 'Risk Factors', table-of-contents lines).
- Definitions of terms ('"Notes" means …', '"Maturity Date" has the meaning …'). Tag the clauses that USE those terms instead.
- Boilerplate from Risk Factors, Use of Proceeds, Taxation, Subscription and Sale, Selling Restrictions, or General Information sections — they discuss possibilities, not contractual terms.
- Cover-page summary tables (e.g. 'Senior Preferred Notes:' followed by descriptive bullets).
- Form-of-the-Notes / global-note mechanics.

If no clause on the page matches any label, return an empty candidates list. Do not invent quotes."""


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


def _normalise_word(w: str) -> str:
    return w.strip(_PUNCT_STRIP).lower()


def _word_positions(text: str) -> list[tuple[int, int, str]]:
    return [(m.start(), m.end(), m.group()) for m in _WORD_RE.finditer(text)]


def _anchored_match(
    haystack: str, needle: str, anchor_words: int = 5
) -> tuple[int, int] | None:
    """Locate a span in `haystack` whose first and last `anchor_words`
    tokens match those of `needle`, in order, within a reasonable window.

    Recovers candidates the model lightly paraphrased in the middle while
    keeping endpoints intact — a common failure mode where exact and
    whitespace-tolerant matches both reject. Comparison normalises case
    and trims punctuation to absorb the model's small wrappings (smart
    quotes, trailing periods, etc.).

    Returns the char range from the first word of the head anchor to the
    last word of the tail anchor; the caller can slice `haystack` with it.
    """
    needle_words = [_normalise_word(w) for _, _, w in _word_positions(needle)]
    needle_words = [w for w in needle_words if w]
    if len(needle_words) < 2 * anchor_words + 1:
        return None
    haystack_word_pos = _word_positions(haystack)
    if not haystack_word_pos:
        return None
    haystack_norm = [_normalise_word(w) for _, _, w in haystack_word_pos]

    head = needle_words[:anchor_words]
    tail = needle_words[-anchor_words:]
    needle_word_count = len(needle_words)
    max_window = int(needle_word_count * 1.6) + 10

    n = len(haystack_word_pos)
    for i in range(n - anchor_words + 1):
        if haystack_norm[i : i + anchor_words] != head:
            continue
        head_start = haystack_word_pos[i][0]
        max_j = min(n - anchor_words, i + max_window)
        for j in range(i + anchor_words, max_j + 1):
            if haystack_norm[j : j + anchor_words] == tail:
                tail_end = haystack_word_pos[j + anchor_words - 1][1]
                return head_start, tail_end
    return None


def _anchor_quote(page_text: str, quote: str) -> tuple[int, int] | None:
    quote = quote.strip().strip(_PUNCT_STRIP).strip()
    if not quote:
        return None
    idx = page_text.find(quote)
    if idx >= 0:
        return idx, idx + len(quote)
    ws = _whitespace_tolerant_find(page_text, quote)
    if ws is not None:
        return ws
    return _anchored_match(page_text, quote)


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
