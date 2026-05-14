"""Detect the Terms & Conditions section and segment it into Clause +
Instrument scope-label suggestions.

This pipeline mirrors what a human labeller does on a bank prospectus:

1. Locate the Terms & Conditions section(s) via the embedded outline /
   printed TOC (reusing `structure_detector.get_outline`). A programme
   can have multiple T&C sections (one per ranking), each becomes its
   own scan range. A single-instrument doc (covered bond, CD) has one.
2. For each T&C page, ask Ollama for two things at once:
   - Top-level numbered clauses (verbatim quote of the clause body).
   - "Instrument marker" clauses — a clause that introduces or defines
     the instrument ranking (typically `1. Form, Status of the Notes`
     or `2.1 Status of Senior Preferred Notes`). When found, the model
     emits the matching `Ranking` enum value too.
3. Re-anchor every quote to the page text via the same helpers
   `clause_discovery` uses (exact → whitespace-tolerant → head/tail
   anchor) so paraphrased candidates get dropped, not silently mangled.

The output is a list of `DiscoveredCandidate`s the router persists as
`AnnotationSuggestion` rows with status=pending. Instrument candidates
carry a `suggested_attributes` payload pre-filling the Ranking value.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import fitz

from ..models import LabelDefinition, Page
from .clause_discovery import _anchor_quote
from .ollama import OllamaClient
from .structure_detector import OutlineEntry, get_outline


@dataclass
class TncRange:
    start_page_num: int
    end_page_num: int
    title: str


@dataclass
class DiscoveredCandidate:
    label_definition_id: int
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str
    confidence: float
    suggested_attributes: list[dict] = field(default_factory=list)


# --- T&C span detection ---------------------------------------------------

_TNC_TITLE_RE = re.compile(
    r"\b(terms\s+and\s+conditions|conditions\s+of\s+the)\b", re.IGNORECASE
)


def _outline_to_ranges(
    outline: list[OutlineEntry], total_pages: int
) -> list[TncRange]:
    """Pick outline entries that look like T&C section starts and pair
    them with the next entry's page (or the document end) as a bound."""
    if not outline:
        return []
    matches: list[tuple[int, OutlineEntry]] = [
        (i, e) for i, e in enumerate(outline) if _TNC_TITLE_RE.search(e.title)
    ]
    out: list[TncRange] = []
    for i, entry in matches:
        if i + 1 < len(outline):
            end = max(entry.page_num, outline[i + 1].page_num - 1)
        else:
            end = total_pages
        end = min(end, total_pages)
        if end < entry.page_num:
            continue
        out.append(
            TncRange(
                start_page_num=entry.page_num,
                end_page_num=end,
                title=entry.title,
            )
        )
    return out


_TNC_HEADING_RE = re.compile(
    # Accepts three forms:
    #   - `TERMS AND CONDITIONS OF THE [RANKING] NOTES` (most prospectuses)
    #   - `TERMS AND CONDITIONS OF [SOMETHING]` (older / shorter docs)
    #   - `APPENDIX N: TERMS AND CONDITIONS` (Argenta CDs)
    # The `OF [...]` suffix is optional so bare "TERMS AND CONDITIONS"
    # also matches. Case-sensitive ALL CAPS — relies on the heading being
    # typographically distinct from body-text references.
    r"^\s*(?:APPENDIX\s+\d+\s*:\s+)?TERMS\s+AND\s+CONDITIONS(?:\s+OF\s+(?:THE\s+)?[A-Z][A-Z \-]*)?",
    re.MULTILINE,
)


def _scan_section_heading_pages(pdf_doc: fitz.Document) -> list[int]:
    """Find all PDF pages that begin with an all-caps section heading.

    Used to bound the LAST T&C in a doc — we look for the next page
    whose header looks like a section heading. This avoids relying on
    the outline, which may have offset page numbers or be missing.

    Scan window: first 600 chars of the page. Some PDFs (BOI EMTN
    observed) emit a run of empty/whitespace lines at the top of each
    page before the real content starts, so a "first few lines" window
    is too narrow to catch the heading.
    """
    pages: list[int] = []
    # An ALL-CAPS heading on its own line, anchored to a line start.
    # Length floor of 6 chars filters page-number-only lines and
    # decorative single words. Parens are excluded because real section
    # headings in prospectuses don't carry them — but parenthetical
    # fragments like `(Referencing SONIA)` wrapped onto a new line
    # otherwise sneak through (observed on ING Covered Bond p114).
    heading_re = re.compile(
        r"(?:^|\n)\s*[A-Z][A-Z0-9 ,/\-&']{6,80}\s*(?:\n|$)",
    )
    # Reject ALL-CAPS lines preceded by a `N.` numbered marker — those
    # are CLAUSE headings inside a T&C section, not SECTION headings.
    # NIBC EMTN uses ALL-CAPS clause headings (`6.\nTAXATION`), which
    # otherwise tricked the scanner into cutting the T&C off at p120.
    numbered_prefix_re = re.compile(r"(?:^|\n)\s*\d{1,3}\.\s*$")
    for page_index in range(len(pdf_doc)):
        text = pdf_doc[page_index].get_text("text") or ""
        head = text[:600]
        m = heading_re.search(head)
        if not m:
            continue
        # Look at the text immediately preceding the all-caps line —
        # if it's a numbered marker, this is a clause heading, not a
        # section heading.
        before = head[: m.start()]
        if numbered_prefix_re.search(before[-40:]):
            continue
        pages.append(page_index + 1)
    return pages


def _text_scan_tnc_ranges(pdf_doc: fitz.Document) -> list[TncRange]:
    """Scan page headers for `TERMS AND CONDITIONS OF THE ...` literal text
    and return a TncRange per hit.

    Per-hit end boundary:
    - If there's a later T&C hit, end at (next hit - 1). This is exact.
    - Else (last T&C in the doc), look for the next all-caps section
      heading on a later page and end one page before it. Falls back to
      total_pages only when no such heading is found.

    The text-scan-only approach (vs the outline) is more robust because
    embedded outlines often use printed page numbers offset from PDF
    indices — observed on NN Bank where outline's `page 105` actually
    refers to PDF page 108.
    """
    total_pages = len(pdf_doc)
    hits: list[tuple[int, str]] = []
    seen_starts: set[int] = set()
    for page_index in range(total_pages):
        text = pdf_doc[page_index].get_text("text") or ""
        head = text[:400]
        m = _TNC_HEADING_RE.search(head)
        if not m:
            continue
        # Skip Table-of-Contents pages — they list T&C headings as
        # references alongside other section labels, not as the section
        # itself (observed on Triodos p3 where the printed TOC's "TERMS
        # AND CONDITIONS OF THE SENIOR PREFERRED NOTES" line otherwise
        # got picked up as a bogus T&C start). The marker is "TABLE OF
        # CONTENTS" within the first ~600 chars of the page.
        if "TABLE OF CONTENTS" in text[:600].upper():
            continue
        start_page_num = page_index + 1
        if start_page_num in seen_starts:
            continue
        seen_starts.add(start_page_num)
        hits.append((start_page_num, m.group(0).strip()))

    if not hits:
        return []

    # Pages whose headers look like section headings — used to bound the
    # last T&C section.
    section_heading_pages = _scan_section_heading_pages(pdf_doc)

    out: list[TncRange] = []
    for i, (start_page_num, title) in enumerate(hits):
        if i + 1 < len(hits):
            end_page_num = hits[i + 1][0] - 1
        else:
            # Last T&C: end at the next section heading after start, or
            # at doc end if there's nothing recognisable downstream.
            candidates = [
                p for p in section_heading_pages if p > start_page_num + 1
            ]
            end_page_num = (candidates[0] - 1) if candidates else total_pages
        if end_page_num < start_page_num:
            continue
        out.append(
            TncRange(
                start_page_num=start_page_num,
                end_page_num=end_page_num,
                title=title,
            )
        )
    return out


def detect_tnc_ranges(pdf_path: str) -> list[TncRange]:
    """Open the PDF and return the T&C ranges within it.

    Strategy: prefer text-scanned headings over the embedded outline.
    The outline is often off (printed page numbers vs PDF indices, or
    just incomplete), while the rendered `TERMS AND CONDITIONS OF THE …`
    heading is always at the exact PDF page where the section starts.
    Fall back to outline-based detection only when no headings are
    visible in page text — covers older docs where pdfminer ate the
    heading or it lives in an image.
    """
    pdf_doc = fitz.open(pdf_path)
    try:
        ranges = _text_scan_tnc_ranges(pdf_doc)
        if ranges:
            return ranges
        outline = get_outline(pdf_doc)
        return _outline_to_ranges(outline, total_pages=len(pdf_doc))
    finally:
        pdf_doc.close()


# --- Per-page Clause + Instrument discovery -------------------------------

_SYSTEM_PROMPT = """You are an expert in EU bank-resolution law (BRRD/SRMR) reading the Terms & Conditions of a bank prospectus. The user gives you the verbatim text of a single page from the T&C section, the project's Instrument ranking enum, and asks you to identify two things:

1. CLAUSES — every top-level numbered clause whose body appears in whole or in part on the page (e.g. '1. Definitions', '2. Status of the Notes', '2.1 Status of Senior Preferred Notes'). Emit a verbatim quote of the clause: include the clause's number, heading, and body text up to the next top-level number. If the clause spills onto the next page, emit what's on THIS page only.

2. INSTRUMENT MARKERS — only emit an instrument marker when the page contains a clause that EXPLICITLY identifies a specific ranking of instrument. Typical markers:
   - A 'Status of …' clause naming the ranking ('Status of Senior Preferred Notes', 'Status of the Subordinated Notes').
   - A section heading 'Terms and Conditions of the [Ranking] Notes'.
   - A clause stating the notes qualify as Tier 2 / Additional Tier 1 / senior preferred / etc.
   The quote for an instrument marker is the clause that establishes the ranking — same verbatim-from-the-page rule. If the page doesn't introduce a specific ranking, return no instrument markers.

RULES
- Copy quotes EXACTLY from the page text — no rewording, no truncation, no ellipses, no added quotation marks.
- A page may contribute multiple clauses, multiple instrument markers, or none.
- Definitions sections (clause headed 'Definitions' / 'Interpretation') ARE clauses — emit them.
- Do NOT emit table-of-contents lines, page headers/footers, or running heads.
- Do NOT emit sub-paragraphs as standalone clauses ('(a) …', '(i) …') — they belong to the parent clause's quote.

If nothing matches, return empty arrays."""


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
                },
            },
        },
        "required": ["clauses", "instrument_markers"],
    }


def _build_prompt(page_text: str, ranking_values: list[str]) -> str:
    ranking_lines = "\n".join(f"  - {v}" for v in ranking_values)
    return (
        "Instrument Ranking enum (use one of these verbatim for any "
        "instrument marker you emit):\n"
        f"{ranking_lines}\n\n"
        "Page text (verbatim):\n"
        f'"""\n{page_text}\n"""\n\n'
        "Return a JSON object with keys 'clauses' and 'instrument_markers'. "
        "Each clause entry has 'quote'; each instrument_marker entry has "
        "'quote' and 'ranking'."
    )


def discover_on_page(
    page: Page,
    clause_label: LabelDefinition,
    instrument_label: LabelDefinition,
    ranking_attribute_id: int,
    ranking_values: list[str],
    ollama: OllamaClient,
) -> list[DiscoveredCandidate]:
    """Run one Ollama call on the page; emit Clause + Instrument candidates."""
    if not page.text.strip() or not ranking_values:
        return []
    schema = _build_schema(ranking_values)
    response = ollama.generate_structured(
        prompt=_build_prompt(page.text, ranking_values),
        schema=schema,
        system=_SYSTEM_PROMPT,
        options={"temperature": 0.1},
    )

    out: list[DiscoveredCandidate] = []
    seen: set[tuple[int, int, int]] = set()

    for item in response.get("clauses", []):
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
                confidence=0.7,
            )
        )

    for item in response.get("instrument_markers", []):
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
                confidence=0.7,
                suggested_attributes=[
                    {
                        "attribute_def_id": ranking_attribute_id,
                        "value": ranking,
                    }
                ],
            )
        )

    return out