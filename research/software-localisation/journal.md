# Journal

Append-only. Dated entries: what was done, decided, found, abandoned.

## 2026-11-05 — slice S0

Done: opened this record; committed H1 to H3 and their thresholds before any run
(`hypotheses.md`); wrote the fixture `fixtures/xliff/software-strings.en-uk.xlf`
(invented strings, one unit per key, a `<ph>` per variable, a plural group expanded to
Ukrainian's four categories, notes, `translate="no"`, targets in `initial`) and its
tests in `packages/core/src/project/xliff.test.ts`; wrote the five probes of spec §5
as tests that name what is known.

Found, each observed by running the real code on invented sentences and not assumed.
The tests below pin each one; a change to the behaviour changes its test and this
journal says why.

1. **A `<ph>` is not in the plain text.** `plainText` of `{{count}} items` is
   ` items`. A glossary check, a QA rule and a memory's text index read plain text, so
   none of them sees the variable. The fixture test pins it.
2. **The plural siblings share a source hash.** The `few`, `many` and `other` units
   of an English plural are the same source, so one memory hit or one confirmed donor
   is a hit for all three in a language where they differ. This is the mechanism H2
   is about (`xliff.test.ts`).
3. **An exact memory hit replaces an arriving target.** A target that arrives in the
   file as `initial` (a draft) or `translated` is overwritten by an exact hit in the
   memory, which becomes `translated` with the origin `tm_exact`; only a confirmed or
   locked segment is protected. A `translate="no"` unit arrives `locked`, with the
   target it came with, and is skipped (`packages/db/src/project/pretranslate.test.ts`,
   the last describe).
4. **`num.altered` misfires on a correct Ukrainian or Russian number.** `1,234.50` to
   `1 234,50` is reported as reformatted, because `core/qa/locale.ts` has no number
   format for `uk` or `ru`; the same pair into French is silent
   (`packages/core/src/qa/software-localisation.probe.test.ts`).
5. **`punct.terminal` misfires on a correct Chinese full stop or question mark** (the
   full-width forms), and fires correctly on a Chinese target with no terminal. The
   rule compares ASCII terminals only (same file).
6. **The glossary check misfires on an inflected Ukrainian or Russian rendering** (an
   accusative or plural form is `missing_preferred`; a form that equals the
   dictionary form passes) **and on any Chinese rendering inside a sentence** (no word
   boundary to match on). `inflection.ts` has endings for `de`, `es`, `fr` and `en`
   only (same file).
7. **DeepL's pairs, from the adapter's list only.** English into `uk` and `ru` is
   served; `zh-Hans` is refused (`packages/server/src/deepl-engine.test.ts`, the last
   describe). Whether DeepL itself serves each language was **not checked** against
   DeepL's own list from this session; the adapter's comment says that check comes
   first.

Decided: the thresholds in `hypotheses.md` are the author's judgment, fixed before
round 1. The fixture is invented and is the output of no tool, so it checks the
filter against the shape the spec describes and nothing else. Nothing here is a run
of a hypothesis, so nothing is confirmatory.

Not done: no results file exists, because nothing was run against a hypothesis; the
probes are tests. S1 to S4 and the workbench's export in a reviewed state are not
built, so no round can start.
