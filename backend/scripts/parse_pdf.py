"""Runner: parse example_prospectus.pdf and print enough output to eyeball
whether pymupdf's reading order is sane on real legal text.

Usage (from repo root):
    .venv\\Scripts\\python.exe backend\\scripts\\parse_pdf.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.services.pdf_parser import parse_pdf, find_phrase_pages  # noqa: E402

PDF_PATH = REPO_ROOT / "example_prospectus.pdf"


def banner(title: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


def show_page_text(doc, page_num: int, max_chars: int = 1500) -> None:
    page = doc.pages[page_num - 1]
    banner(f"PAGE {page_num} — {len(page.words)} words, {page.width:.0f}x{page.height:.0f}pt")
    text = page.text
    if len(text) > max_chars:
        print(text[:max_chars])
        print(f"\n... [truncated, {len(text) - max_chars} more chars] ...")
    else:
        print(text)


def show_word_samples(doc, page_num: int, n: int = 15) -> None:
    page = doc.pages[page_num - 1]
    banner(f"PAGE {page_num} — first {n} words with bboxes (reading order)")
    for w in page.words[:n]:
        x0, y0, x1, y1 = w.bbox
        print(
            f"  [{w.char_start:>5}-{w.char_end:<5}] "
            f"({x0:6.1f},{y0:6.1f})-({x1:6.1f},{y1:6.1f})  block={w.block:>2} line={w.line:>2}  {w.text!r}"
        )


def main() -> None:
    if not PDF_PATH.exists():
        print(f"Missing: {PDF_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsing {PDF_PATH.name} ...")
    doc = parse_pdf(PDF_PATH)

    total_words = sum(len(p.words) for p in doc.pages)
    total_chars = sum(len(p.text) for p in doc.pages)
    banner("DOCUMENT SUMMARY")
    print(f"  pages          : {doc.page_count}")
    print(f"  total words    : {total_words:,}")
    print(f"  total chars    : {total_chars:,}")
    print(f"  avg words/page : {total_words / doc.page_count:.0f}")

    # Per-page word counts (compact)
    banner("WORDS PER PAGE")
    for p in doc.pages:
        marker = ""
        if len(p.words) == 0:
            marker = "  <-- EMPTY (likely scanned/image-only)"
        print(f"  p{p.page_num:>3}: {len(p.words):>5} words{marker}")

    # Where do the relevant sections live?
    banner("PHRASE LOCATIONS")
    for phrase in [
        "Terms and Conditions",
        "Table of Contents",
        "MREL",
        "Subordinat",  # picks up Subordinated/Subordination
        "Eligible Liabilities",
        "Risk Factors",
    ]:
        pages = find_phrase_pages(doc, phrase)
        head = pages[:8]
        more = "" if len(pages) <= 8 else f" (+{len(pages) - 8} more)"
        print(f"  {phrase!r:<28} pages: {head}{more}")

    # Show a few representative pages in full text:
    # - page 1 (cover)
    # - first page where "Terms and Conditions" appears (the section we care about)
    # - a page mid-document for general layout
    pages_to_show: list[int] = [1]
    tc_pages = find_phrase_pages(doc, "Terms and Conditions")
    if tc_pages:
        pages_to_show.append(tc_pages[0])
        # Also a page a bit deeper into the T&Cs section
        if len(tc_pages) > 2:
            pages_to_show.append(tc_pages[2])
    mid = max(2, doc.page_count // 2)
    if mid not in pages_to_show:
        pages_to_show.append(mid)

    for pn in pages_to_show:
        show_page_text(doc, pn)
        show_word_samples(doc, pn, n=20)


if __name__ == "__main__":
    main()
