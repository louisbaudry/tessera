# XLIFF test corpus

Hand-written XLIFF 2.x files for the filter in `packages/core/src/xliff/`
(issue #169, `planning/v1-spec.md` §3.8). **Every sentence is written for
this repository**; none comes from a client or a tool's output.

They are shaped to the OASIS XLIFF 2.1 text (the reference; nothing was
copied from it), which means they encode a belief about what other tools
write. **No file from Trados, memoQ, Phrase or Smartling has been read**, so
these prove the filter is consistent with the specification as read here and
nothing more. A real sample, put through `scripts/synthesize-fixtures.py`'s
approach (structure kept, every word replaced), is the next check.

| File                         | What it exercises                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic.en-de.xlf`            | default namespace, `<group>`, several segments in one unit, an `<ignorable>`, `<pc>` with `originalData`, `<ph>`, `<sc>`/`<ec>`, `<sm>`/`<em>`, an isolated `<sc>`, `<mrk>`, `<cp>`, entities, `translate="no"`, a Translation Candidates `<mtc:match>` whose `<source>` must be ignored, single-quoted attributes                                                                                                                                         |
| `prefilled.en-de.xlf`        | a prefixed namespace (`xlf:`), version 2.0, region-tagged languages, targets in `initial`, `translated` and `final`, an empty `<target/>`, a segment with no target                                                                                                                                                                                                                                                                                        |
| `xliff-12.en-de.xlf`         | XLIFF 1.2, which must be refused by name                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `software-strings.en-uk.xlf` | a keyed-strings file (`planning/software-localisation-spec.md`, S0): invented interface strings, one `<group>` of plural units (`_one`, `_few`, `_many`, `_other`) with `{{count}}` as a `<ph>`, `{{name}}` in a sentence, two `translate="no"` units, a target in `initial` and one in `translated`, a unit with no target, and a checksum file note. Its names, notes and group are what the unit-context and plural-form tests read (issues #351, #353) |
