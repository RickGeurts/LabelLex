"""Regex-based top-level clause boundary detection.

The interactive Ollama path chunks by page, which works but strips the
hierarchical context: the model sees a deep-inside-clause-7 page in
isolation and treats lettered sub-paragraphs `(a) (b) (c) ...` as if
they were top-level clauses. This is the source of most false positives
observed on Argenta Pandbrieven pp.103-105.

This module pre-extracts the structural skeleton of a T&C section so the
auto-label pipeline can call the LLM once per top-level clause with full
clause context, rather than once per page with no parent. The LLM no
longer has to guess what level it's looking at — we tell it.

Boundary heuristic: top-level clauses are numbered `1.`, `2.`, ..., at
the start of a (possibly indented) line, followed by whitespace and an
uppercase heading word. Sub-divisions `(a)`, `(i)`, `2.1`, etc. are
NOT matched. The heading itself is captured for use in the LLM prompt.

Trade-off: this is intentionally conservative. A doc that uses Roman
numerals at the top level, or "Article 1" / "Condition 1" wrappers,
will fall through and the caller should fall back to the per-page
strategy. We can extend the patterns when we hit real-world examples.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from ..models import Page


# Top-level clause headings. Three house styles seen in the wild,
# all matched here:
#   Argenta style — `1. Type, Form, Denomination and Title` (number-dot,
#     whitespace, capital heading on the same line or the next). The
#     dot is the disambiguator — blank lines between are fine.
#   Belfius style — `2\nInterest and Other Calculations` (number alone
#     on its own line, heading on the IMMEDIATELY next line, NO dot,
#     no blank line in between).
#   BPCE style — `13 Replacement of definitive Notes` (number, single
#     space, heading on the SAME line, NO dot, no newline between).
# The "no blank line" rule on the Belfius branch is load-bearing: page
# numbers in running headers look like `\n\n57\n\nTERMS...` (number with
# blank line on both sides). The `(?!\n)` lookahead rejects those.
# The BPCE branch is the riskiest — `\d+ X` patterns appear in body
# text too ("for 5 Years"). The line-start gate in `_find_top_level_starts`
# and the non-sequential filter together suppress most strays.
# Negative lookbehind rejects `2.1`-style sub-numbering and `(2)` markers.
_TOP_LEVEL_RE = re.compile(
    r"(?<![\.0-9(])(\d{1,3})(?:\.\s+|[ \t]*\n(?!\n)|[ \t]+)([A-Z][^\n]{2,200})",
)


@dataclass
class ClauseSpan:
    """One top-level clause's span across (possibly) page boundaries."""

    number: str
    heading: str
    start_page_num: int
    start_char: int  # char offset within start page's text
    end_page_num: int
    end_char: int  # exclusive char offset within end page's text
    text: str  # the clause body verbatim (joined across pages)


def _line_start_positions(text: str) -> list[int]:
    """Return all character indices that are at the start of a line."""
    out = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            out.append(i + 1)
    return out


def _is_real_heading_followup(text: str, heading_end: int) -> bool:
    """Heuristic: a real clause heading is followed within a few chars by
    a paragraph break (`\\n\\n`) or a sub-paragraph marker (`\\n(`).

    Body-text references that the regex accidentally matches — dates
    like 'about\\n2 May 2024 (as amended...the\\n"Agency Agreement"', or
    footnote anchors — continue mid-sentence on the next line: a
    lowercase or otherwise non-marker character right after the line
    ending. Rejecting those at this step pre-empts a lot of work for
    the downstream sequential filter.
    """
    # Walk forward to the end of the heading line.
    while heading_end < len(text) and text[heading_end] != "\n":
        heading_end += 1
    if heading_end >= len(text) - 1:
        # End of doc — assume it's a heading.
        return True
    next_char = text[heading_end + 1]
    return next_char == "\n" or next_char == "("


def _find_top_level_starts(text: str) -> list[tuple[int, str, str, str]]:
    """Find (char_offset, number, heading, style) tuples for top-level clauses.

    `style` is 'dotted' (number followed by a period, Argenta house style)
    or 'plain' (number on its own line or with a space, Belfius/BPCE
    house styles). The caller uses this to filter isolated single-style
    matches that are almost certainly false positives.

    Only matches that begin at a line start count, so `... 2.` mid-paragraph
    references like "see clause 2." don't trigger. Additionally, matches
    whose heading line is not followed by a paragraph break / sub-marker
    are dropped — that suppresses body-text strays like "2 May 2024" that
    happen to land at a line start due to PDF wrapping.
    """
    line_starts = set(_line_start_positions(text))
    out: list[tuple[int, str, str, str]] = []
    for m in _TOP_LEVEL_RE.finditer(text):
        # Walk back to the line start to see if this match begins a line.
        start = m.start()
        # Skip leading whitespace on the line — many clauses are indented.
        i = start
        while i > 0 and text[i - 1] in " \t":
            i -= 1
        if i not in line_starts:
            continue
        number = m.group(1)
        heading = m.group(2).strip()
        # Drop very-short headings — almost always false positives from
        # in-text references like "regulation 1. of section 2."
        if len(heading) < 3:
            continue
        # Disambiguate which branch of _TOP_LEVEL_RE matched by inspecting
        # the chars between the number and the heading. Dotted (Argenta)
        # has a `.`; plain-newline (Belfius) has a `\n`; BPCE-inline has
        # neither — just whitespace.
        number_end = m.start(1) + len(number)
        gap = text[number_end:m.start(2)]
        if "." in gap:
            style = "dotted"
        elif "\n" in gap:
            style = "plain"
        else:
            style = "plain"  # BPCE-style — same style category as Belfius
            # Only the BPCE branch needs the heading-followup check —
            # it's the most permissive branch and the most prone to
            # body-text strays like "2 May 2024". The dotted and
            # plain-newline branches have stronger signals (dot, or
            # number-alone-on-a-line) and the followup check incorrectly
            # rejects multi-line heading wraps in those styles (observed
            # on ING Covered Bond clause 10).
            if not _is_real_heading_followup(text, m.end(2)):
                continue
        out.append((start, number, heading, style))
    return out


def _drop_non_sequential_matches(
    starts: list[tuple[int, str, str, str]], max_gap: int = 2
) -> list[tuple[int, str, str, str]]:
    """Drop matches whose number is not the next-or-close-to-next integer
    after the previous accepted match.

    Within a single T&C section, clause numbers form a sequence
    (1, 2, 3, ...). Numbers that suddenly drop or jump by a large amount
    are almost always false positives — table row numbers ('3.
    Subordinated liabilities'), dates ('31. December'), or other
    decorative content the segmenter accidentally matched.

    `max_gap` is the largest allowed forward jump (covers the rare case
    where a real clause was missed by the regex). The first accepted
    match anchors the sequence — any starting number is fine.

    Numbers that don't parse as ints are dropped silently.
    """
    if not starts:
        return []
    out: list[tuple[int, str, str, str]] = []
    last_num: int | None = None
    for s in starts:
        try:
            num = int(s[1])
        except (TypeError, ValueError):
            continue
        if last_num is None:
            out.append(s)
            last_num = num
            continue
        if last_num < num <= last_num + max_gap:
            out.append(s)
            last_num = num
        # else: drop the match (out-of-sequence or too-big jump)
    return out


def _drop_isolated_style_matches(
    starts: list[tuple[int, str, str, str]], k: int = 3
) -> list[tuple[int, str, str, str]]:
    """Drop matches whose style is isolated among their nearest neighbours.

    A match is kept only if at least one of the `k` matches immediately
    before or after it shares its style. This filters stray footnote
    anchors (one plain match surrounded by dotted neighbours, or vice
    versa) without false-killing legitimate matches that happen to sit
    adjacent to a stray.

    Why per-match (not per-run): the run-based filter drops a legitimate
    clause that's separated from the rest of its style cluster by a
    single stray. The neighbourhood check keeps it as long as at least
    one of its nearby matches also shares its style.
    """
    if len(starts) <= 1:
        return list(starts)
    out: list[tuple[int, str, str, str]] = []
    for i, s in enumerate(starts):
        lo = max(0, i - k)
        hi = min(len(starts), i + k + 1)
        has_same_neighbor = any(
            j != i and starts[j][3] == s[3] for j in range(lo, hi)
        )
        if has_same_neighbor:
            out.append(s)
    return out


def segment_top_level_clauses(pages: list[Page]) -> list[ClauseSpan]:
    """Segment the given ordered page subset into top-level clause spans.

    Pages must be sorted by page_num and form a contiguous range (the T&C
    section). Returns clause spans in document order.

    Empty list when no top-level headings are detected — the caller should
    fall back to the per-page strategy in that case.
    """
    if not pages:
        return []

    # Build a flat text concatenation and a parallel index that maps a
    # flat offset back to (page_num, page_local_offset). Concatenation
    # uses single newlines between pages so flat offsets line up with
    # per-page offsets predictably.
    flat_parts: list[str] = []
    page_offsets: list[tuple[int, int, int]] = []  # (flat_start, page_num, page_text_len)
    flat_cursor = 0
    for page in pages:
        page_text = page.text or ""
        page_offsets.append((flat_cursor, page.page_num, len(page_text)))
        flat_parts.append(page_text)
        flat_cursor += len(page_text)
        # No separator between pages — keep flat offsets aligned with
        # per-page char offsets so anchoring back is exact.

    flat_text = "".join(flat_parts)
    starts = _find_top_level_starts(flat_text)
    # Sequential filter FIRST: drops body-text strays whose number is
    # out of sequence (e.g. NIBC's `360 Fraction` runs between real
    # clauses 4 and 5). This prevents same-style strays from "isolating"
    # legitimate clauses in the style filter's neighbourhood check.
    starts = _drop_non_sequential_matches(starts)
    starts = _drop_isolated_style_matches(starts)
    if not starts:
        return []

    def _flat_to_page(flat_offset: int) -> tuple[int, int]:
        # Find the page whose range contains flat_offset.
        # Linear scan is fine — 60 pages max in a typical T&C.
        for i in range(len(page_offsets) - 1, -1, -1):
            flat_start, page_num, page_len = page_offsets[i]
            if flat_offset >= flat_start:
                return page_num, flat_offset - flat_start
        # Shouldn't happen if flat_offset is in range.
        return page_offsets[0][1], 0

    spans: list[ClauseSpan] = []
    for idx, (flat_start, number, heading, _style) in enumerate(starts):
        flat_end = (
            starts[idx + 1][0]
            if idx + 1 < len(starts)
            else len(flat_text)
        )
        # Trim trailing whitespace so clauses don't end mid-page-header.
        while flat_end > flat_start and flat_text[flat_end - 1] in " \t\n":
            flat_end -= 1
        start_page_num, start_char = _flat_to_page(flat_start)
        # end is exclusive — point at the first char AFTER the clause.
        end_page_num, end_char = _flat_to_page(flat_end - 1)
        end_char += 1
        spans.append(
            ClauseSpan(
                number=number,
                heading=heading,
                start_page_num=start_page_num,
                start_char=start_char,
                end_page_num=end_page_num,
                end_char=end_char,
                text=flat_text[flat_start:flat_end],
            )
        )
    return spans
