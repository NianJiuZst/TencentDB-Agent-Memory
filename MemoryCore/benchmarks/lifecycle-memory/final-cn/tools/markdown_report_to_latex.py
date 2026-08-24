#!/usr/bin/env python3
"""Convert the repository's constrained REPORT_CN.md dialect to LaTeX.

The converter deliberately supports only the constructs used by REPORT_CN.md:
headings, paragraphs, ordered/unordered lists, fenced text blocks, links, bold
spans, and pipe tables. It keeps the Markdown file as the report source of
truth while producing a reviewable LaTeX body for the final Chinese volume.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


SPECIALS = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def escape_latex(text: str) -> str:
    return "".join(SPECIALS.get(char, char) for char in text)


def process_inline(text: str) -> str:
    placeholders: list[str] = []

    def reserve(value: str) -> str:
        token = f"@@LATEX{len(placeholders)}@@"
        placeholders.append(value)
        return token

    def link(match: re.Match[str]) -> str:
        label = process_inline(match.group(1))
        target = match.group(2)
        return reserve(rf"\href{{{target}}}{{{label}}}")

    def bold(match: re.Match[str]) -> str:
        return reserve(rf"\textbf{{{process_inline(match.group(1))}}}")

    def code(match: re.Match[str]) -> str:
        return reserve(rf"\texttt{{{escape_latex(match.group(1))}}}")

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, text)
    text = re.sub(r"\*\*([^*]+)\*\*", bold, text)
    backtick = chr(96)
    text = re.sub(rf"{backtick}([^{backtick}]+){backtick}", code, text)
    text = escape_latex(text)
    for index, value in enumerate(placeholders):
        text = text.replace(f"@@LATEX{index}@@", value)
    return text


def strip_manual_number(title: str) -> str:
    return re.sub(r"^\d+(?:\.\d+)*(?:\.)?\s+", "", title).strip()


def parse_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def is_separator(line: str) -> bool:
    cells = parse_cells(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def column_widths(count: int) -> list[float]:
    presets = {
        2: [0.28, 0.64],
        3: [0.20, 0.18, 0.53],
        4: [0.20, 0.14, 0.42, 0.14],
        5: [0.08, 0.18, 0.14, 0.16, 0.32],
        6: [0.12, 0.10, 0.10, 0.28, 0.16, 0.10],
        7: [0.13, 0.075, 0.075, 0.075, 0.275, 0.095, 0.075],
    }
    if count in presets:
        return presets[count]
    usable = 0.82 / count
    return [usable] * count


def render_table(header: list[str], rows: list[list[str]]) -> list[str]:
    count = len(header)
    widths = column_widths(count)
    spec = "".join(
        rf">{{\raggedright\arraybackslash}}p{{{width:.3f}\linewidth}}"
        for width in widths
    )
    size = r"\scriptsize" if count >= 6 else r"\footnotesize"

    def row(cells: list[str], header_row: bool = False) -> str:
        padded = cells + [""] * (count - len(cells))
        rendered = [process_inline(cell) for cell in padded[:count]]
        if header_row:
            rendered = [rf"\textbf{{{cell}}}" for cell in rendered]
        return " & ".join(rendered) + r" \\"

    output = [
        r"\begingroup",
        size,
        r"\setlength{\tabcolsep}{3pt}",
        r"\renewcommand{\arraystretch}{1.16}",
        rf"\begin{{longtable}}{{@{{}}{spec}@{{}}}}",
        r"\toprule",
        row(header, header_row=True),
        r"\midrule",
        r"\endfirsthead",
        r"\toprule",
        row(header, header_row=True),
        r"\midrule",
        r"\endhead",
        r"\bottomrule",
        r"\endfoot",
    ]
    output.extend(row(cells) for cells in rows)
    output.extend(
        [
            r"\end{longtable}",
            r"\endgroup",
            "",
        ]
    )
    return output


def convert(source: Path) -> str:
    lines = source.read_text(encoding="utf-8").splitlines()
    start = next(
        index for index, line in enumerate(lines) if line.strip() == "## 摘要"
    )
    lines = lines[start:]

    output: list[str] = []
    paragraph: list[str] = []
    list_kind: str | None = None
    in_code = False
    index = 0

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            text = " ".join(part.strip() for part in paragraph)
            output.extend([process_inline(text), ""])
            paragraph = []

    def close_list() -> None:
        nonlocal list_kind
        if list_kind:
            output.extend([rf"\end{{{list_kind}}}", ""])
            list_kind = None

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if in_code:
            if stripped.startswith("~~~"):
                output.extend([r"\end{Verbatim}", ""])
                in_code = False
            else:
                output.append(line)
            index += 1
            continue

        if stripped.startswith("~~~"):
            flush_paragraph()
            close_list()
            output.append(r"\begin{Verbatim}[fontsize=\small]")
            in_code = True
            index += 1
            continue

        if not stripped:
            flush_paragraph()
            close_list()
            index += 1
            continue

        if stripped == "---":
            flush_paragraph()
            close_list()
            index += 1
            continue

        if stripped.startswith("|") and index + 1 < len(lines) and is_separator(
            lines[index + 1]
        ):
            flush_paragraph()
            close_list()
            header = parse_cells(stripped)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(parse_cells(lines[index]))
                index += 1
            output.extend(render_table(header, rows))
            continue

        heading = re.match(r"^(#{2,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            close_list()
            level = len(heading.group(1))
            title = strip_manual_number(heading.group(2))
            if level == 2 and title == "摘要":
                output.extend(
                    [
                        r"\section*{摘要}",
                        r"\addcontentsline{toc}{section}{摘要}",
                        "",
                    ]
                )
            else:
                command = {2: "section", 3: "subsection", 4: "subsubsection"}[
                    level
                ]
                output.extend([rf"\{command}{{{process_inline(title)}}}", ""])
            index += 1
            continue

        bullet = re.match(r"^-\s+(.+)$", stripped)
        numbered = re.match(r"^\d+\.\s+(.+)$", stripped)
        if bullet or numbered:
            flush_paragraph()
            desired = "itemize" if bullet else "enumerate"
            if list_kind != desired:
                close_list()
                output.append(rf"\begin{{{desired}}}")
                list_kind = desired
            item = bullet.group(1) if bullet else numbered.group(1)
            output.append(rf"\item {process_inline(item)}")
            index += 1
            continue

        paragraph.append(line)
        index += 1

    flush_paragraph()
    close_list()
    if in_code:
        raise ValueError("unterminated fenced block")
    return "\n".join(output).rstrip() + "\n"


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: markdown_report_to_latex.py REPORT_CN.md report-body.tex"
        )
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    target.write_text(convert(source), encoding="utf-8")


if __name__ == "__main__":
    main()
