# XLSX test corpus

Two workbooks for the XLSX filter (`packages/core/src/xlsx/`, `planning/v1-spec.md`
§3.10, issue #169). **Every sentence is written for this repository**; nothing
comes from a client or from another project's files.

| File                 | Made by                                                                                                                                                               | What it exercises                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lo-book.en.xlsx`    | **LibreOffice 24.2.7.2**, converting `source/lo-book.en.fods` (a flat ODS written for this repository): `soffice --headless --convert-to xlsx source/lo-book.en.fods` | a full producer's package: styles, a theme, document properties; two sheets, strings shown on both, rich strings (bold and italic written as `val="true"`, a font-only run around them), a cell with a line break (written as `&#10;`), numbers, two formulas, a text cell that is only digits; `xml:space="preserve"` on every string                                                                                                |
| `edge-cases.en.xlsx` | `scripts/make-xlsx-fixture.py` (standard library only), byte-reproducible                                                                                             | sheet files **not numbered in tab order**, a **table** with a header row and a totals row, a string shown on two sheets, a string no cell shows, an empty string, a run with no properties, a property switched off (`<b val="0"/>`), superscript, a phonetic guide, edge whitespace, entities, a raw `_x000D_` escape, inline strings (plain and rich), a formula with a cached text, a self-closed string cell followed by a number |

## What these do not prove

**No file written by Excel has been read, and no export has been opened in
Excel.** `lo-book.en.xlsx` is LibreOffice's idea of a workbook and
`edge-cases.en.xlsx` is a hand-built one, so both encode a belief about Excel's
output wherever it differs, which is exactly the risk the repository's fixture
rule names (`CLAUDE.md`, fixture corpus). The table in `edge-cases.en.xlsx` in
particular is written to the schema, not copied from what Excel writes. A real
sample, passed through `scripts/synthesize-fixtures.py`'s approach (structure
kept, every word replaced), and one translated export opened in Excel, are the
next checks.

## Provenance

`lo-book.en.xlsx` is the output of a conversion, committed as a binary. It holds
LibreOffice's generated styles and theme, not text copied from a template of
ours or anyone's; whether a tool's generated boilerplate needs a notice is the
judgement already recorded for the PPTX deck in `planning/prior-art.md`
(LibreOffice, kind C). If the answer is yes, the workbook is removed and the
gate runs on `edge-cases.en.xlsx` alone.

openpyxl 3.1.5 was used on a developer's machine only, to open the workbooks and
the translated exports as a second reader. Nothing of it is in the repository.
