# DOCX test corpus

Real Word documents' **structure**, synthetic **content**. Backlog #5.

These exist to make backlog **#8 (the roundtrip gate)** meaningful: import →
export with zero edits must reproduce every one of these byte-for-byte
outside `word/document.xml`. Hand-written fixtures cannot prove that,
because nobody writes fixtures containing the things Word actually emits.

## Provenance

Twenty files came from a 36-file archive of real working documents,
selected for structural diversity; `footnotes-manuscript` was supplied
separately to close the footnote gap.

They were first committed pseudonymised: names swapped, metadata
stripped. An audit before the repository went public (2026-09-23) found
that was not enough — logos and photographs untouched, real addresses and
a real registration URL left in the text, pseudonyms applied
inconsistently, and whole texts that were someone else's copyright. So
every file was then rewritten by `scripts/synthesize-fixtures.py`:

- **Every word replaced** by a pseudo-word of the same length, case
  pattern and accent positions. The map is keyed on the lower-cased word,
  so a repeated word or sentence stays repeated; it is an HMAC under a
  random key that existed only for that run, so it cannot be inverted by
  hashing guesses. A short list of function words and abbreviations
  (`the`, `de`, `St`, `Mr`, …) is kept, so segmentation behaves as it did
  on the original.
- **Punctuation, whitespace and entities kept; digits permuted** by a
  fixed bijection, so `¿…?`, guillemets, number shapes and dates keep
  their form but not their values.
- **Every image redrawn** as a flat placeholder of the same format and
  pixel size.
- **Every external link target** (`.rels`, `w:instrText`, visible URLs
  and emails) rewritten to `example.org`.
- **Alt text, picture names and tooltips** mapped like text.

**Structure was not touched.** Parts, run fragmentation, styles, tag
nesting, tracked changes, fields, content controls, numbering and embedded
fonts are exactly as Word left them — that fragmentation is what the
filter is being tested against, and it survives because only character
data and a handful of human-written attributes change. The gate and the
full test suite passed unchanged on the synthetic corpus; the golden
transcript (`fixtures/golden/`) changed only in its text.

A new fixture goes through the same script before it is committed:

```sh
python3 scripts/synthesize-fixtures.py /tmp/out new.docx
```

## The corpus

| Fixture                                                                              | Size     | Why it is here                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracked-changes-endnotes`                                                           | 28 KB    | **Only** file with tracked changes (4 ins / 8 del) and endnotes; also fields, content controls, footer                                                                                                    |
| `table-hyperlink`                                                                    | 17 KB    | **Only** file containing a table; hyperlinks, field instructions                                                                                                                                          |
| `rich-mixed-content`                                                                 | 61 KB    | Densest structure: drawings, VML, 20 text boxes, 134 numbering refs, superscript, content controls                                                                                                        |
| `embedded-fonts`                                                                     | 2.0 MB   | **Only** file with embedded fonts (5 `.odttf`); header + footer                                                                                                                                           |
| `mixed-language`                                                                     | 14 KB    | **Only** file with a non-English `w:lang` run (`it-IT`)                                                                                                                                                   |
| `vertalign-superscript`                                                              | 19 KB    | Superscript runs; header + footer                                                                                                                                                                         |
| `fields-textboxes`                                                                   | 17 KB    | Field instructions, text boxes, legacy VML, content control                                                                                                                                               |
| `large-media-packet`                                                                 | 0.8 MB   | 6 media parts, 2 headers, drawings, deep numbering                                                                                                                                                        |
| `media-heavy-packet`                                                                 | 0.8 MB   | 9 media parts, VML + DrawingML mixed                                                                                                                                                                      |
| `image-heavy`                                                                        | 35 KB    | Drawings, VML and text boxes, minimal text                                                                                                                                                                |
| `deep-numbering`                                                                     | 25 KB    | Deepest list nesting in the corpus                                                                                                                                                                        |
| `form-release` · `form-contract` · `form-waiver` · `form-minimal` · `form-financial` | 13–18 KB | Blank templates. Numbered clauses, legal prose, no filled fields                                                                                                                                          |
| `email-hyperlink`                                                                    | 11 KB    | Short document whose payload is a hyperlink                                                                                                                                                               |
| `prose-long` · `prose-short` · `prose-dates`                                         | 13–26 KB | Plain prose baselines. `prose-dates` is date-dense, useful for number/date QA rules                                                                                                                       |
| `footnotes-manuscript`                                                               | 191 KB   | **Only** file with footnotes — 72 of them, ~8.9k chars of note text, with their own `footnotes.xml.rels`. 55 paragraphs carry a ref _mid-sentence_. 10 footers. Spanish source: 101 `¿`, 18 `¡`, 119 `«»` |

Totals: 21 files, ~4.1 MB (images are now placeholders), ~1,490 paragraphs, ~327k characters of text.

### `footnotes-manuscript` in particular

Worth calling out because it carries several things nothing else does:

- **Footnotes at realistic density.** 72 notes, and critically 55 of the
  referring paragraphs have substantial text around the reference — so the
  reference lands _inside_ a segment as an inline `ph` tag rather than
  conveniently at a paragraph boundary. That is the case that breaks naive
  extractors.
- **Spanish source text.** It is the only fixture that exercises
  `punct.inverted` (`¿` / `¡` pairing), which has no analogue in the other
  six supported languages, and its 119 guillemets exercise the
  typographic canonicalisation in `source_hash`
  (`planning/tm-format-spec.md` §4).
- **Ten footers.** `footer1`–`footer10`, forcing per-part skeletons rather
  than a single document skeleton.
- Its text is synthetic like every other fixture's; the structure — the
  footnote density, the mid-sentence references, the Spanish punctuation —
  is what came from the original.

## Known quirks — preserve these, do not fix them

Two files fail strict XSD validation **in their original form**. Both were verified as pre-existing, and both are kept deliberately:

- `media-heavy-packet` — `w:numPicBullet` wraps its `w:pict` in
  `mc:AlternateContent`. This is valid Markup Compatibility that the strict
  schema does not model. Word writes it.
- `prose-long` — carries an unreferenced `[trash]/0000.dat` part, left
  behind by some tool in the document's history.

An implementation that "cleans up" either one fails the roundtrip gate, and
correctly so. Real documents carry debris, and preserving it byte-for-byte
is the whole point of the skeleton approach (`planning/v1-spec.md` §3.1).

## Gaps

No fixture contains comments, `fldSimple` fields, OMML equations or symbol
runs.

Four constructs each come from exactly **one** file, so a regression in any
of them has a single fixture standing between it and CI:

| Construct                 | Sole source                |
| ------------------------- | -------------------------- |
| Footnotes                 | `footnotes-manuscript`     |
| Tracked changes, endnotes | `tracked-changes-endnotes` |
| Tables                    | `table-hyperlink`          |
| Non-English `w:lang`      | `mixed-language`           |

Worth supplying in a later batch, roughly in priority order:

1. More tables — especially merged cells and nested tables, neither of
   which appears anywhere in the corpus
2. Comments
3. A second document with tracked changes
4. A second document with footnotes, ideally English-source
5. Equations / symbol runs
