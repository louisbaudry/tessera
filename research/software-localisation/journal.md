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

## 2026-11-05, S1: unit context

Built (issue #351): a unit's `name` and its own notes are read at import, stored on the
segment, shown read-only in the editor and sent in the draft prompt (`tessera-draft-v2`).
Nothing was run against a hypothesis; the change is tested for its mechanics (escaping,
bounds, round trip, migration, a byte-identical zero-edit export), and no draft was
compared with or without the context.

Observed while building: the S0 fixture's notes already carry the plural category and
the register ("Imperative verb"), so the text H1 would judge is written for the
translator, not for the engine; and a note repeated word for word on every plural unit
costs prompt characters (500 each, at most three notes) without saying anything the key
does not. Whether the context helps a draft is for round 1 (S6) to count, not assumed.

Not done: no results file. H1 to H3 are still untested.

## 2026-11-05, S2: plural siblings

Built (issue #353): the XLIFF group of a unit is stored; pre-translate places nothing on the
forms of a group that share a source with another form of it, and `consistency.target_differs`
no longer compares units of one group. Nothing was run against a hypothesis; the tests cover the
mechanics with a control outside a group.

Observed: `seg.untranslated`, which the spec listed beside `consistency.target_differs`, compares a
target with its own source and needed no change. The memory still receives every confirmed form, so
a second project over the same strings can find three targets for one source; that is the
polysemy question H2 counts, not something S2 settles.

Not done: no results file. H1 to H3 are still untested.

## 2026-11-06, S3: glossary import

Built (issue #356): a glossary CSV (`term,lang,rendering,status,avoid,keep`) is read whole, refused
by line, and written all or nothing into a `.ctg` through the one rendering write. Nothing was run
against a hypothesis; the tests cover the mechanics (parser refusals, transaction, notes, a second
import, the route's isolation).

Observed while building: the workbench's two glossary facts that a `.ctg` has no home for, `status`
and `keep`, became notes on the rendering, so a person sees them but no rule reads them. Whether an
`official` rendering should weigh more than a `review` one in `term.glossary_mismatch` is the kind of
question S5's numbers should answer, not a guess made here.

Not done: no results file. H1 to H3 are still untested, and no real termbase was read.
