# Hypotheses

Append-only. Each entry is dated and lives in the commit that states them, which
must come before the commit of any result that tests them.

## 2026-11-05 — the first three, before round 1

Written in slice S0 (`planning/software-localisation-spec.md` §5), before any run.
**The thresholds are the author's judgment, fixed now so that no result can move
them.** If one is wrong, a later entry revises it under a new id (H1 to H1b) before
the run it would govern, never after.

The unit of analysis is a catalogue string (one XLIFF unit) in one language and one
release of the workbench's catalogue. **Gold is the reviewer's final target only**:
a unit that arrived `final` through a round (S4), never an AI draft that is
unchanged by default. Numbers are computed per language (`uk`, `ru`) and never
pooled; `zh-Hans` (round 2) is tested separately and only for H3.

**Normalised edit distance** is the Levenshtein distance in Unicode code points
between a draft and the reviewer's final target, divided by the length of the longer
of the two (0 when both are empty). A `{{variable}}` is compared as the text it is.

- **H1 (notes and glossary help the engine).** Giving the Tessera engine a unit's
  notes and the glossary's terms found in its source lowers the normalised edit
  distance between its draft and the reviewer's final target, against the same engine
  without them. Arms: A, the engine with both; B, the engine without; C, DeepL
  (`uk` and `ru` only, descriptive, no threshold, because it has no channel for
  either). The same units, the same memory, the same model and parameters in A and B;
  only the prompt block differs (it needs slice S1).
  _Supported_ for a language if A's mean is at most 0.9 times B's mean (at least 10%
  lower) **and** a paired bootstrap of the per-unit differences (10,000 resamples of
  the units, seed recorded) has a 95% interval that excludes zero. _Falsified_ for a
  language if A's mean is higher than B's and the interval excludes zero. Anything
  else is _not shown_, and is reported as that, not as a failure of the engine. The
  share of units each arm left unchanged is reported beside the mean and is not a
  threshold.
- **H2 (plural siblings are corrupted without S2).** Without slice S2, a unit in a
  plural group, or one sharing a source with a sibling unit of another key, receives
  a propagated or exact-matched target taken from that sibling (its stored origin is
  `propagated` or `tm_exact`, and the donor or hit is a sibling), and the reviewer
  then changes it. The measure is that count, per language, and its share of the
  units placed that way. _Supported_ (S2 is needed) if the count is at least 5 in
  either language. After S2 the same count is expected to be 0; _falsified_ (S2 does
  not do what it is for) if it is at least 1 after S2. A mechanism for it exists in
  the fixture (the `few`, `many` and `other` forms of an English plural share one
  source hash) and is pinned by a test; that is a reason to expect H2, not evidence
  for it.
- **H3 (the glossary check misfires on the new languages).**
  `term.glossary_mismatch` flags **accepted** targets (a target the reviewer
  confirmed unchanged, in a segment whose source holds a glossary term) often enough
  to need slice S5. The measure is the share of such segments that carry a flag, per
  language (`uk`, `ru`; `zh-Hans` in round 2). _Supported_ (S5 is needed) if the
  share is at least 5% in any of them. Below 5% in all, the inflection lists and the
  CJK match of S5 are not started on this evidence. S0's probes show the check
  misfiring on invented inflected and Chinese cases; those are exploratory, were seen
  before this entry was written, and do not confirm H3.

Falsification and non-support change a slice, not the spec's premise: each is written
into the spec with a pointer to its results file.
