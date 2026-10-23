# PPTX test corpus

Two decks for the PPTX filter (`packages/core/src/pptx/`, `planning/v1-spec.md`
§3.9, issue #169). **Every sentence is written for this repository**; nothing
comes from a client or from another project's files.

| File                 | Made by                                                                                                                                                               | What it exercises                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lo-deck.en.pptx`    | **LibreOffice 24.2.7.2**, converting `source/lo-deck.en.fodp` (a flat ODP written for this repository): `soffice --headless --convert-to pptx source/lo-deck.en.fodp` | a full producer's package: master, layouts, two themes, a notes master; four slides, bold/italic/superscript runs, a line break, a table, a notes page, a hyperlink, a slide-number field (LibreOffice writes `&lt;number&gt;` into it, which has letters)                                                                                      |
| `edge-cases.en.pptx` | `scripts/make-pptx-fixture.py` (standard library only), byte-reproducible                                                                                             | slide files **not numbered in play order**, notes pages on slides 1 and 3, entities, edge whitespace, a bold-italic-underlined run, sub- and superscript, a hyperlink run, a line break, an empty run, a paragraph that is only digits and one that is only a field, a field inside a sentence, a text box stored twice (`mc:AlternateContent`) |

## What these do not prove

**No file written by PowerPoint has been read.** `lo-deck.en.pptx` is
LibreOffice's idea of a deck and `edge-cases.en.pptx` is a hand-built one, so
both encode a belief about PowerPoint's output wherever it differs, which is
exactly the risk the repository's fixture rule names (`CLAUDE.md`, fixture
corpus). A real sample, passed through `scripts/synthesize-fixtures.py`'s
approach (structure kept, every word replaced), is the next check.

## Provenance

`lo-deck.en.pptx` is the output of a conversion, committed as a binary. It
holds LibreOffice's generated master, layouts and themes, not text copied from
a template of ours or anyone's; whether a tool's generated boilerplate needs a
notice is a judgement recorded in `planning/prior-art.md` (LibreOffice, kind C)
and flagged to Louis in the pull request. If the answer is yes, the deck is
removed and the gate runs on `edge-cases.en.pptx` alone.

python-pptx 1.0.2 was used on a developer's machine only, to open the decks
and the translated exports as a second reader. Nothing of it, and none of its
default template, is in the repository.
