"""PDF parsing service.

Canonical text extraction for LabelLex. Backend is the source of truth for
text content and per-word bboxes; the frontend renders the PDF visually with
pdf.js but pulls text/positions from this layer so character offsets stay
consistent with what gets persisted as annotations.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import fitz


@dataclass
class Word:
    char_start: int
    char_end: int
    text: str
    bbox: tuple[float, float, float, float]
    block: int
    line: int

    def to_dict(self) -> dict:
        d = asdict(self)
        d["bbox"] = list(self.bbox)
        return d


@dataclass
class ParsedPage:
    page_num: int
    width: float
    height: float
    text: str
    words: list[Word]

    def to_dict(self) -> dict:
        return {
            "page_num": self.page_num,
            "width": self.width,
            "height": self.height,
            "text": self.text,
            "words": [w.to_dict() for w in self.words],
        }


@dataclass
class ParsedDocument:
    page_count: int
    pages: list[ParsedPage]

    def to_dict(self) -> dict:
        return {
            "page_count": self.page_count,
            "pages": [p.to_dict() for p in self.pages],
        }


def _page_words(page: fitz.Page) -> tuple[str, list[Word]]:
    """Extract words from a page in reading order with cumulative char offsets.

    pymupdf's `page.get_text("words")` returns tuples of
    (x0, y0, x1, y1, word, block_no, line_no, word_no). Sorting by
    (block, line, word_no) yields the reading order pymupdf inferred from the
    page's structure tree — generally good for digitally-generated docs and
    the right thing to validate against on a real prospectus.
    """
    raw = page.get_text("words")
    raw.sort(key=lambda w: (w[5], w[6], w[7]))

    parts: list[str] = []
    words: list[Word] = []
    cursor = 0
    prev_block: int | None = None
    prev_line: int | None = None

    for x0, y0, x1, y1, text, block_no, line_no, _word_no in raw:
        if not text:
            continue

        if prev_block is None:
            sep = ""
        elif block_no != prev_block:
            sep = "\n\n"
        elif line_no != prev_line:
            sep = "\n"
        else:
            sep = " "

        if sep:
            parts.append(sep)
            cursor += len(sep)

        start = cursor
        parts.append(text)
        cursor += len(text)

        words.append(
            Word(
                char_start=start,
                char_end=cursor,
                text=text,
                bbox=(float(x0), float(y0), float(x1), float(y1)),
                block=int(block_no),
                line=int(line_no),
            )
        )
        prev_block = block_no
        prev_line = line_no

    return "".join(parts), words


def parse_pdf(path: str | Path) -> ParsedDocument:
    """Parse a PDF into pages of text + per-word bboxes."""
    pages: list[ParsedPage] = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc, start=1):
            text, words = _page_words(page)
            pages.append(
                ParsedPage(
                    page_num=i,
                    width=float(page.rect.width),
                    height=float(page.rect.height),
                    text=text,
                    words=words,
                )
            )
    return ParsedDocument(page_count=len(pages), pages=pages)


def find_phrase_pages(doc: ParsedDocument, phrase: str) -> list[int]:
    """Return 1-based page numbers whose text contains `phrase` (case-insensitive)."""
    needle = phrase.lower()
    return [p.page_num for p in doc.pages if needle in p.text.lower()]
