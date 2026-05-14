"""Sub-paragraph segmentation within a top-level clause.

A clause body is structured into sub-paragraphs marked with one of three
common notations:
    - Lettered: `(a)`, `(b)`, `(c)`, `(aa)`
    - Roman:    `(i)`, `(ii)`, `(iii)`, `(iv)`
    - Numeric:  `1.1`, `1.2`, `2.3.1`

This module finds those markers inside a single clause's text span and
returns (start_page_num, start_char, end_page_num, end_char) for each
sub-paragraph, computed in the same per-page coordinate system the
top-level segmenter uses.

Detection rules (kept narrow on purpose — the post-filters in the
top-level segmenter taught us that permissive regexes generate noise):
    - The marker must be at a line start (optional leading whitespace).
    - Followed by horizontal whitespace then a capital letter (the
      sub-paragraph's heading or first sentence word).
    - Roman is tried before lettered at the same position, so `(i)`
      parses as Roman rather than the letter `i`.
    - Numeric markers require at least one sub-level (`1.1`), to avoid
      colliding with the top-level dotted clause regex (`1.`).
    - Sequential filter per marker family — within one clause, lettered
      markers must form an increasing alphabetic sequence (a, b, c…),
      Roman must form an increasing Roman sequence, numeric must be
      monotone — to drop stray references in body text.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from ..models import Page


# Markers at line start. Order matters in the alternation: Roman before
# lettered so `(i)` parses as Roman. The numeric branch requires at
# least one dot to avoid colliding with top-level clause numbering.
_SUBPARA_RE = re.compile(
    r"""
    (?:^|\n)[ \t]*
    (?:
        \( (?P<roman>[ivx]{1,5}) \)
        |
        \( (?P<letter>[a-z]{1,3}) \)
        |
        (?P<num>\d{1,3}(?:\.\d{1,3}){1,3})
    )
    [ \t]*                                  # optional horizontal ws
    (?:\n[ \t]*)?                           # optional newline + indent
    (?P<head>\S[^\n]{2,200})                # heading: starts non-whitespace
    """,
    re.VERBOSE,
)


# Heading-text signatures that flag a regex match as a false positive
# rather than a real sub-paragraph start. Two failure modes from the
# anomaly audit:
#   - Class 1 (back-references): "(a) above in respect of..."
#                                "(x) and (y) of this clause (b)..."
#                                "(b) of these Conditions..."
#   - Class 2 (concatenated markers): "(i)(b). (4) SONIA Fallbacks..."
#                                      — captures (i) but heading is "(b)..."
# Real sub-paragraph headings start with content words and don't open
# with a paren, a positional adverb, or a conjunction-into-marker.
_HEAD_REF_FIRST_WORDS = frozenset({"above", "below"})
_HEAD_REF_LIST_PREFIXES = ("and (", "or (")
_HEAD_REF_PHRASES = (
    "of this clause",
    "of these conditions",
    "of this condition",
    "of the conditions",
    "of these terms",
)


_LEADING_ALPHA_RE = re.compile(r"[a-zA-Z]+")


def _is_reference_or_concatenated(head: str) -> bool:
    h = head.lstrip()
    if not h:
        return False
    # Class 2: heading opens with another marker — the regex anchored on
    # an inner glued token rather than a real sub-paragraph start.
    if h.startswith("("):
        return True
    h_lower = h.lower()
    # Class 1a: positional back-reference. Match the leading alphabetic
    # run only so debris like "above,109" (footnote-glued page numbers)
    # still resolves to "above".
    m = _LEADING_ALPHA_RE.match(h_lower)
    first_alpha = m.group(0) if m else ""
    if first_alpha in _HEAD_REF_FIRST_WORDS:
        return True
    # Class 1b: list-of-references "(x) and (y)...", "(p) or (q)...".
    if any(h_lower.startswith(p) for p in _HEAD_REF_LIST_PREFIXES):
        return True
    # Class 1c: phrases that only appear inside cross-references.
    head_prefix = h_lower[:50]
    if any(phrase in head_prefix for phrase in _HEAD_REF_PHRASES):
        return True
    return False


# Roman numeral conversion for sequence-check purposes. Cap at 30 — real
# legal docs rarely go past (xv) at one nesting level.
_ROMAN_TO_INT = {
    "i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7,
    "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13,
    "xiv": 14, "xv": 15, "xvi": 16, "xvii": 17, "xviii": 18, "xix": 19,
    "xx": 20, "xxi": 21, "xxii": 22, "xxiii": 23, "xxiv": 24, "xxv": 25,
    "xxvi": 26, "xxvii": 27, "xxviii": 28, "xxix": 29, "xxx": 30,
}


@dataclass
class SubparagraphSpan:
    """A single sub-paragraph span inside a clause.

    `level` is the nesting depth relative to the parent Clause:
    2 = first-level sub-paragraph, 3 = sub-sub-paragraph, 4+ = deeper.
    The caller maps level → label id (Sub-paragraph / Sub-sub-paragraph /
    Sub-sub-sub-paragraph). Levels deeper than 4 are clipped to 4.
    """

    marker: str  # The marker as it appears in the source: "(a)", "(i)", "1.1"
    kind: str    # "letter" | "roman" | "num"
    level: int   # 2 = sub-paragraph, 3 = sub-sub, 4+ = sub-sub-sub
    heading: str
    start_page_num: int
    start_char: int
    end_page_num: int
    end_char: int
    text: str


def _classify_match(
    m: re.Match[str],
) -> tuple[str, str, int | None, int | None]:
    """Return (kind, marker_text, sort_key, first_segment).

    `first_segment` is the leading integer for numeric markers (e.g. 14
    for "14.2", 3 for "3.01"); None for lettered/Roman. The caller uses
    this to reject numeric markers whose first segment doesn't match the
    parent clause's number — that filters body-text references like
    "14.2 (Spanish law section)" inside a clause 3.
    """
    if m.group("roman") is not None:
        token = m.group("roman")
        return ("roman", f"({token})", _ROMAN_TO_INT.get(token), None)
    if m.group("letter") is not None:
        token = m.group("letter")
        sort_key = ord(token[0]) - ord("a") + 1 if len(token) == 1 else None
        return ("letter", f"({token})", sort_key, None)
    token = m.group("num")
    last = int(token.rsplit(".", 1)[-1])
    first = int(token.split(".", 1)[0])
    return ("num", token, last, first)


def _assign_levels_by_indentation(
    matches_with_x0: list[
        tuple[re.Match[str], str, str, int | None, int | None, float]
    ],
    tolerance_pt: float = 5.0,
) -> list[tuple[re.Match[str], str, str, int]]:
    """Cluster marker x-coordinates within one clause to discover the
    discrete indentation levels the doc uses, then assign each marker
    a level by its cluster index (leftmost cluster = level 2).

    This is the indentation-aware path — it sees structure the way the
    typesetter wrote it, rather than guessing from marker style. A
    clause with `(c)` followed by a NESTED `(a)(b)(c)` at deeper indent
    gets the second sequence labelled level 3 or 4 instead of rejected.

    `tolerance_pt` is how close two x-values must be to share a cluster;
    PDF indent steps are typically 18-36pt so 5pt comfortably handles
    rendering jitter without merging real levels.

    Falls back to position 0 (level 2) when x0 is missing/negative.
    """
    if not matches_with_x0:
        return []
    # Collect x0 values; cluster via single-pass greedy on sorted unique.
    x0s = sorted({round(x, 2) for _, _, _, _, _, x in matches_with_x0 if x >= 0})
    clusters: list[float] = []  # cluster representatives (left edges)
    for x in x0s:
        if not clusters or x - clusters[-1] > tolerance_pt:
            clusters.append(x)
    # Each marker's level = (its cluster index) + 2.
    def level_for(x: float) -> int:
        if x < 0 or not clusters:
            return 2
        for i, c in enumerate(clusters):
            if x <= c + tolerance_pt:
                return i + 2
        return len(clusters) + 1
    out: list[tuple[re.Match[str], str, str, int]] = []
    for m, kind, marker, _key, _first, x in matches_with_x0:
        out.append((m, kind, marker, level_for(x)))
    return out


def _assign_levels(
    matches: list[tuple[re.Match[str], str, str, int | None, int | None]],
    max_gap: int = 3,
) -> list[tuple[re.Match[str], str, str, int]]:
    """Style-stack level assignment — fallback when bbox/x0 data isn't
    available.

    Stack entries are (style, last_key). For each new match:
    - If its style sits on the stack, pop everything above and either
      continue the sequence at that level or reject (out-of-order).
    - If its style is new, push as a deeper level.

    Stack starts empty per clause — the Clause itself is conceptually
    level 1, the first marker pushed lives at level 2.
    """
    out: list[tuple[re.Match[str], str, str, int]] = []
    stack: list[tuple[str, int]] = []  # (style, last_key)
    for entry in matches:
        m, kind, marker, key, _first = entry
        # Find this style on the stack (top-down).
        found_idx = -1
        for i in range(len(stack) - 1, -1, -1):
            if stack[i][0] == kind:
                found_idx = i
                break
        if found_idx >= 0:
            prev_key = stack[found_idx][1]
            if key is None:
                # Unrankable — treat as a sibling continuation; pop above
                # without advancing the key.
                stack = stack[: found_idx + 1]
                level = len(stack) + 1
                out.append((m, kind, marker, level))
                continue
            if prev_key < key <= prev_key + max_gap:
                # In-sequence continuation at this level.
                stack = stack[:found_idx]
                stack.append((kind, key))
                level = len(stack) + 1
                out.append((m, kind, marker, level))
            # else: out-of-sequence at this level — drop the match.
            continue
        # New style — push as a deeper level.
        if key is None:
            # Push with a sentinel so subsequent matches can navigate.
            stack.append((kind, 0))
        else:
            stack.append((kind, key))
        level = len(stack) + 1
        out.append((m, kind, marker, level))
    return out


def segment_subparagraphs(
    clause_pages: list[Page],
    clause_start_page_num: int,
    clause_start_char: int,
    clause_end_page_num: int,
    clause_end_char: int,
    clause_number: int | None = None,
) -> list[SubparagraphSpan]:
    """Find sub-paragraph spans inside a single clause, with hierarchical
    nesting via a style-stack walk.

    `clause_number`, when provided, is the parent clause's leading
    integer (e.g. 3 for clause "3."). Numeric markers whose first
    segment doesn't equal it are rejected — that filters body-text
    references like "14.2" inside clause 3, which would otherwise be
    detected as a sub-paragraph.

    Each returned span carries a `level`: 2 for first-level sub-paragraph,
    3 for sub-sub-paragraph, 4+ for sub-sub-sub-paragraph and deeper.
    Caller maps level to the corresponding label id.
    """
    if not clause_pages:
        return []

    # Build the clause's flat text (just the portion inside the clause
    # span) and a flat-offset → (page_num, page_char) map.
    flat_parts: list[str] = []
    flat_to_page: list[tuple[int, int, int]] = []
    pages_by_num: dict[int, Page] = {}
    cursor = 0
    for page in clause_pages:
        pages_by_num[page.page_num] = page
        page_text = page.text or ""
        if page.page_num == clause_start_page_num and page.page_num == clause_end_page_num:
            slice_start = clause_start_char
            slice_end = clause_end_char
        elif page.page_num == clause_start_page_num:
            slice_start = clause_start_char
            slice_end = len(page_text)
        elif page.page_num == clause_end_page_num:
            slice_start = 0
            slice_end = clause_end_char
        else:
            slice_start = 0
            slice_end = len(page_text)
        segment = page_text[slice_start:slice_end]
        flat_to_page.append((cursor, page.page_num, slice_start))
        flat_parts.append(segment)
        cursor += len(segment)
    flat_text = "".join(flat_parts)

    def to_page_coords(flat_offset: int) -> tuple[int, int]:
        for fs, pn, page_offset_at_start in reversed(flat_to_page):
            if flat_offset >= fs:
                return pn, page_offset_at_start + (flat_offset - fs)
        return flat_to_page[0][1], flat_to_page[0][2]

    def x0_for_char(page_num: int, page_char: int) -> float:
        """Look up the bbox.x0 of the word containing the given char
        offset on the given page. Returns -1 when the word can't be
        located (signals "fall back to style-stack").
        """
        page = pages_by_num.get(page_num)
        if page is None:
            return -1.0
        words = page.words or []
        # Linear scan — sub-paragraph word lists are typically a few
        # hundred entries per page; binary search optimisation is
        # premature.
        for w in words:
            cs = w.get("char_start")
            ce = w.get("char_end")
            if cs is None or ce is None:
                continue
            if cs <= page_char < ce:
                bbox = w.get("bbox") or []
                if len(bbox) >= 1:
                    try:
                        return float(bbox[0])
                    except (TypeError, ValueError):
                        return -1.0
                return -1.0
        return -1.0

    raw: list[tuple[re.Match[str], str, str, int | None, int | None, float]] = []
    for m in _SUBPARA_RE.finditer(flat_text):
        kind, marker, key, first_segment = _classify_match(m)
        # Reject numeric markers whose leading integer doesn't match the
        # parent clause (e.g. "14.2 (Spanish law section)" inside clause
        # 3). Skipped when clause_number is unknown.
        if (
            kind == "num"
            and clause_number is not None
            and first_segment is not None
            and first_segment != clause_number
        ):
            continue
        # Drop back-references ("(a) above…", "(x) and (y) of this clause…")
        # and in-line concatenated markers ("(i)(b). (4) SONIA…").
        if _is_reference_or_concatenated(m.group("head") or ""):
            continue
        # Find the x0 of this marker's leading word for indentation-
        # based level assignment.
        if kind == "roman":
            marker_pos = m.start("roman") - 1  # include opening `(`
        elif kind == "letter":
            marker_pos = m.start("letter") - 1
        else:
            marker_pos = m.start("num")
        page_num, page_char = to_page_coords(marker_pos)
        x0 = x0_for_char(page_num, page_char)
        raw.append((m, kind, marker, key, first_segment, x0))

    if not raw:
        return []

    # Prefer indentation-based level assignment when we have usable
    # bbox data on most markers. Fall back to the style-stack walk
    # otherwise (older / non-EU docs sometimes have missing word bboxes).
    have_x0 = sum(1 for _, _, _, _, _, x in raw if x >= 0)
    if have_x0 >= len(raw) * 0.8:
        leveled = _assign_levels_by_indentation(raw)
    else:
        raw_no_x0 = [(m, k, mk, key, fs) for m, k, mk, key, fs, _ in raw]
        leveled = _assign_levels(raw_no_x0)
    if not leveled:
        return []

    def marker_start_in_match(m: re.Match[str], kind: str) -> int:
        if kind == "roman":
            return m.start("roman")
        if kind == "letter":
            return m.start("letter")
        return m.start("num")

    spans: list[SubparagraphSpan] = []
    for i, (m, kind, marker, level) in enumerate(leveled):
        marker_pos = marker_start_in_match(m, kind)
        # Step back to include the opening `(` for paren markers — the
        # capture group is the inner text, not the parens.
        flat_start = marker_pos - 1 if kind in ("roman", "letter") else marker_pos
        # Step forward until the next sub-paragraph or end of clause.
        if i + 1 < len(leveled):
            next_m, next_kind, _, _ = leveled[i + 1]
            next_marker_pos = marker_start_in_match(next_m, next_kind)
            flat_end = (
                next_marker_pos - 1 if next_kind in ("roman", "letter") else next_marker_pos
            )
        else:
            flat_end = len(flat_text)
        while flat_end > flat_start and flat_text[flat_end - 1] in " \t\n":
            flat_end -= 1
        if flat_end <= flat_start:
            continue
        start_page_num, start_char = to_page_coords(flat_start)
        end_page_num, end_char = to_page_coords(flat_end - 1)
        end_char += 1
        heading = m.group("head").strip()
        spans.append(
            SubparagraphSpan(
                marker=marker,
                kind=kind,
                level=level,
                heading=heading,
                start_page_num=start_page_num,
                start_char=start_char,
                end_page_num=end_page_num,
                end_char=end_char,
                text=flat_text[flat_start:flat_end],
            )
        )
    return spans
