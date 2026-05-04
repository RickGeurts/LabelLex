"""Detect the structural sections of a bank-prospectus PDF.

Strategy:
1. Try the PDF's embedded outline (`pymupdf` `doc.get_toc`). Most modern
   prospectuses have one — the reference NN Bank doc does.
2. If empty, fall back to parsing the printed Table of Contents page.
   Heuristic: find a page whose text contains "TABLE OF CONTENTS" then
   scan for `<title> .... <page>` lines (dotted leaders).
3. Hand the resulting outline to Ollama with a JSON-schema-constrained
   prompt that classifies each entry into one of the section types we
   care about for MREL analysis.

Section types are deliberately MREL-flavoured: the three T&C sections
get distinct classes because they are the load-bearing ones, while
non-MREL sections (Taxation, Subscription/Sale, ...) collapse to coarser
buckets. Adjust the enum as the workflow evolves.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import fitz

from .ollama import OllamaClient


SECTION_TYPES = (
    "summary",
    "risk_factors",
    "important_information",
    "documents_incorporated",
    "supplements",
    "tc_senior_preferred",
    "tc_senior_non_preferred",
    "tc_subordinated",
    "tc_other",
    "global_form",
    "use_of_proceeds",
    "business_description",
    "taxation",
    "subscription_sale",
    "general_information",
    "definitions",
    "other",
)


@dataclass
class OutlineEntry:
    title: str
    page_num: int  # 1-based PDF ordinal
    level: int = 1


@dataclass
class DetectedSection:
    title: str
    page_num: int
    section_type: str
    confidence: float = 1.0


# --- Outline extraction ----------------------------------------------------

def _outline_from_toc(pdf_doc: fitz.Document) -> list[OutlineEntry]:
    raw = pdf_doc.get_toc(simple=True)
    out: list[OutlineEntry] = []
    for level, title, page_num in raw:
        title = (title or "").strip()
        if not title:
            continue
        out.append(OutlineEntry(title=title, page_num=int(page_num), level=int(level)))
    return out


# Lines like "TERMS AND CONDITIONS OF THE SUBORDINATED NOTES ........... 137"
_TOC_LINE_RE = re.compile(
    r"^\s*([A-Z][A-Z0-9 ,/\-&\(\)']{4,})[\s\.]{3,}(\d{1,4})\s*$",
)


def _outline_from_text_toc(pdf_doc: fitz.Document) -> list[OutlineEntry]:
    """Fallback: scan early pages for a printed TOC."""
    # Look in the first 15 pages — TOCs are always near the front.
    for page_index in range(min(15, len(pdf_doc))):
        text = pdf_doc[page_index].get_text("text") or ""
        if "TABLE OF CONTENTS" not in text.upper():
            continue
        out: list[OutlineEntry] = []
        for line in text.splitlines():
            m = _TOC_LINE_RE.match(line)
            if not m:
                continue
            title = m.group(1).strip().rstrip(".").strip()
            try:
                page_num = int(m.group(2))
            except ValueError:
                continue
            out.append(OutlineEntry(title=title, page_num=page_num))
        if out:
            return out
    return []


def _entry_looks_like_heading(entry: OutlineEntry) -> bool:
    """Heuristic: a real section heading is short (≤ 90 chars) and either
    title-cased or all-caps. Sub-clause anchors (e.g. "(a) the Issuer is
    declared bankrupt") fail both tests — they're sentence-shaped lowercase.
    """
    title = entry.title
    if len(title) > 90:
        return False
    # Reject lines starting with a parenthesised list marker.
    if title.startswith("(") and ")" in title[:6]:
        return False
    letters = [c for c in title if c.isalpha()]
    if not letters:
        return False
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    return upper_ratio >= 0.4  # ALL CAPS, Title Case, etc.


def get_outline(pdf_doc: fitz.Document) -> list[OutlineEntry]:
    """Return the document's outline, preferring whichever source yields
    more clean section-heading-shaped entries. Bank prospectuses sometimes
    embed an outline that's full of deep-cut sub-clause anchors rather than
    real section headings — in that case the printed TOC page is more
    reliable.
    """
    embedded = _outline_from_toc(pdf_doc)
    text_toc = _outline_from_text_toc(pdf_doc)

    embedded_clean = [e for e in embedded if _entry_looks_like_heading(e)]
    text_clean = [e for e in text_toc if _entry_looks_like_heading(e)]

    # Prefer whichever has more clean headings; tiebreak in favour of the
    # printed TOC since it's authored for human navigation.
    if len(text_clean) >= len(embedded_clean):
        return text_clean or text_toc
    return embedded_clean or embedded


# --- Classification --------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a legal-document classifier. Given a list of section titles "
    "from a European bank prospectus, classify each one into exactly one "
    "category. Be conservative — only the three Terms-and-Conditions "
    "categories should be used for sections explicitly titled 'Terms and "
    "Conditions of the Senior Preferred / Senior Non-Preferred / "
    "Subordinated Notes'. Use 'tc_other' for any other Terms-and-Conditions "
    "variant. When in doubt, use 'other'."
)


def _classification_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "classifications": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "page_num": {"type": "integer"},
                        "section_type": {
                            "type": "string",
                            "enum": list(SECTION_TYPES),
                        },
                    },
                    "required": ["title", "page_num", "section_type"],
                },
            },
        },
        "required": ["classifications"],
    }


def _build_user_prompt(outline: list[OutlineEntry]) -> str:
    lines = "\n".join(f"- p.{e.page_num}: {e.title}" for e in outline)
    return (
        "Classify each of the following sections (one entry per line, "
        "page number followed by the section title):\n\n"
        f"{lines}\n\n"
        "Return a JSON object with key 'classifications' — one object per "
        "section preserving the title and page_num exactly as given, plus "
        "the chosen 'section_type'."
    )


def classify_outline(
    outline: list[OutlineEntry],
    ollama: OllamaClient,
) -> list[DetectedSection]:
    if not outline:
        return []
    schema = _classification_schema()
    response = ollama.generate_structured(
        prompt=_build_user_prompt(outline),
        schema=schema,
        system=_SYSTEM_PROMPT,
        options={"temperature": 0.1},
    )
    out: list[DetectedSection] = []
    by_input = {(e.title, e.page_num): e for e in outline}
    for item in response.get("classifications", []):
        title = str(item.get("title", "")).strip()
        try:
            page_num = int(item.get("page_num"))
        except (TypeError, ValueError):
            continue
        section_type = str(item.get("section_type", "other"))
        if section_type not in SECTION_TYPES:
            section_type = "other"
        # Re-anchor to the originally-supplied (title, page_num) when the
        # model paraphrases — keeps page numbers honest.
        key = (title, page_num)
        if key not in by_input:
            # Try matching by page only; the model may have rewritten title.
            for k, v in by_input.items():
                if k[1] == page_num:
                    title = v.title
                    break
        out.append(
            DetectedSection(title=title, page_num=page_num, section_type=section_type)
        )
    return out


def detect_structure(pdf_path: str, ollama: OllamaClient) -> list[DetectedSection]:
    pdf_doc = fitz.open(pdf_path)
    try:
        outline = get_outline(pdf_doc)
    finally:
        pdf_doc.close()
    return classify_outline(outline, ollama)
