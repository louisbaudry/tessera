# Software localisation — the first real scenario (spec)

Status: **proposal, 2026-10-31. Nothing is built, no card is filed, and no decision in §7 is taken.** Written from
Louis's request: the OSINT Workbench (`louisbaudry/osint`, his own application, public) needs a multilingual
interface, and translating that interface should be the first real scenario for Tessera. The workbench's side is
`docs/INTERFACE_LOCALISATION.md` in that repository; the two are written to be read together and meet at **a file**
(XLIFF 2.x), never at a network call. This is proposed as **Epic 16** under v1 (Ring 0) for the filter, editor and QA
work and v1.5 (Ring 0.5) for the engine work; the number and milestones are Louis's to confirm.

It is **dogfood, not a product line.** Tessera does not become a software-localisation platform, and nothing here
adds a tenant, a customer or a screen for one. What it gives is a real job, owned end to end, with a source we control,
reviewers who can be real, and strings that expose what DOCX never did.

## 0. What is being asked

Take the workbench's interface strings (about 1,766 keys per language, English the source, Ukrainian and Russian
present as unreviewed drafts, Simplified Chinese the likely next) through Tessera: pre-fill from a translation memory,
draft what is missing with the engine, have a native reader review it as a vendor on the roster, pass QA, and hand a
checked file back. Repeat per release. Measure what works, and record every place where Tessera, built around
documents, is wrong for short, keyed, placeholder-bearing, plural-bearing text.

## 1. Why this scenario

- **Both ends are ours.** The source producer is the workbench's exporter (spec'd, not a third party's), so a defect is
  fixable on either side, and the file's shape is a decision rather than an inheritance.
- **The text is public.** The strings are code in a public repository, so the engine's per-client consent (D4 of
  `translation-engine-spec.md`) can be switched on for this one internal client without anyone's confidential text
  involved. That makes it the first honest test of consent, provenance and the purge on real text.
- **It exercises what documents do not:** units identified by a key rather than by position, placeholders that must
  survive, plural categories that differ by language, very short segments whose meaning depends on where they appear,
  and a glossary that is not an afterthought.
- **It is the first job through the whole chain:** XLIFF in, memory, engine, vendor review, QA, export, with the audit
  log under all of it.
- **It feeds Epic 12.** A website is also keyed, short and context-dependent. What this finds about context and
  repeated text is evidence for that epic before it is designed.
- **A caveat that stays in view:** the workbench's present Ukrainian and Russian are AI-drafted and unreviewed. They are
  *input* (as drafts), not a quality baseline; no benchmark in this spec treats them as gold.

## 2. What already carries it (read from the code, 2026-10-31)

- **The XLIFF 2.x filter** (`v1-spec.md` §3.8). One `<segment>` is one segment, never re-segmented, so any source
  language imports; export edits the original string, so a zero-edit round trip is byte-identical and ids, notes and
  unknown markup survive; `<ph>`, `<pc>` and the rest map to tokens, all visible; a target that arrives is `draft`
  (`state` `initial`) or `translated`, **never `confirmed`**; `translate="no"` locks a segment.
- **Placeholders are first-class.** Tag chips are labelled by the element's `disp`, else `equiv`, else `type`
  (`web/src/tag-label.ts`), so `{{count}}` shows as `{{count}}`. `tag.missing`, `tag.extra` and `tag.unbalanced` are
  errors, and the engine's prompt carries tags as `<tN>` markers it must reproduce (`validateDraft` refuses otherwise).
- **TM, glossary, engine, review.** Exact and fuzzy retrieval (`v1-spec.md` §6.1, §6.1a); a `.ctg` glossary with several
  renderings per term per language, a `forbidden` flag and a decision log (`smart-glossary-spec.md` §3); the draft
  engines with per-client consent, the suggestion store, the purge and the editor strip (`translation-engine-spec.md`);
  the roster, invitations, assignments and review (`vendor-spec.md`); the audit log; tenancy.
- **`seg.untranslated` has an allow-list**, so a string that is rightly identical in two languages is not a nuisance.

## 3. What the scenario needs and Tessera lacks

Each gap is read from the specs and code named, not guessed. Where a behaviour is *unknown* it is listed as a probe for
S0, not asserted.

**G1. A unit's context never reaches the translator or the engine.** The filter *carries* `<notes>` and does not
understand them (`v1-spec.md` §3.8, "what it does not do"); a search of `packages/web/src` finds no place that shows one,
and the draft prompt's `<context>` block holds only the neighbouring segments (`core/draft/prompt.ts`). For keyed UI
text this is the largest quality lever: "Open" is a verb on a button, an adjective on a status, and a neighbouring key is
not its neighbouring sentence. The unit's `name` or `id` is likewise dropped (`para_key` is the unit's *ordinal*, by design).

**G2. A source text does not decide the target.** Three rules in Tessera say it does, and for keyed text each is wrong
in a way a reviewer will meet at once:

- *Internal propagation* (`v1-spec.md` §6.1, 4): when one segment is confirmed, every other segment with the same
  `source_hash` is populated with it as a draft.
- *Exact placement* (§6.1, 3): an exact hit is placed as `translated`.
- `consistency.target_differs` warns when one source has different targets.

A plural group is the clean case. Ukrainian `itemCount` has four forms whose English source is the same sentence for
`few`, `many` and `other`; confirming the `few` unit would propagate its wording into the other three, and the rule would
then warn when the translator correctly writes them differently. Polysemy ("Open", "Close", "Set") is the quieter case:
the same English string under two keys that want two translations.

**G3. The glossary has no bulk entry.** TBX and CSV import are named and deferred (`smart-glossary-spec.md` §8). The
workbench has an official glossary of 100 terms in three languages, each with a status (`official` or `review`), a list
of variants to avoid and words to keep in English. A `.ctg` can hold all of it (several renderings, `forbidden`, a note),
but today a term enters through the editor, one at a time.

**G4. Glossary matching and QA for `uk`, `ru` and `zh-Hans` are unproven.** `term.glossary_mismatch` matches a rendering
as a whole word with a closed per-language ending list (German, Spanish, French, English); "any other language matches
the exact word only" (`smart-glossary-spec.md` §6.1), and "a letter or digit on neither side" is the boundary test.
Probable consequences, **to be measured, not assumed**: Ukrainian and Russian renderings are inflected (`джерело`,
`джерела`) so an accepted target can be flagged as a mismatch; Chinese has no spaces, so a rendering inside a longer
phrase fails the boundary test. Separately, the locale tables of `num.*` and `punct.*` (`core/qa/locale.ts`) were built
for the working pair; whether `punct.terminal`, `punct.brackets` and `num.altered` fire correctly for Chinese full-width
punctuation or Cyrillic number formats is not recorded anywhere. `rulesFor` throws `UnsupportedGlossaryLanguage` for a
language with no list, which matters only to detection (not used here) but must be seen not to break the QA pass.

**G5. "Reviewed" has no segment-level representation.** A segment is `new`, `draft`, `translated`, `confirmed` or
`locked`; `reviewed` is an *assignment* status (`vendor-spec.md`). The XLIFF export writes `translated` (or `initial`
for a draft), whatever the segment's status. So the file the workbench receives cannot tell "a translator confirmed
this" from "a native reader approved this", which is the one distinction its interface wants to state honestly.

**G6. Chinese is a script, not a primary subtag.** TM and glossary lookup match on `primary_subtag` (`db/lang-match.ts`),
so `zh-Hans` and `zh-Hant` would be one language to the memory. DeepL's list excludes CJK on purpose (D14,
`deepl-engine.ts`), so a Chinese draft can only come from the Tessera engine. There is no word counter for Chinese
(D14 keeps CJK out of the first benchmark for that reason, and the portal's count is `null` for `zh`, `ja` and `th`), so
what a Chinese assignment would be priced on is unknown: *probe in S0*, and a `null` rather than a wrong figure is the
behaviour to keep. None of this blocks `uk` and `ru`; all of it shapes the second language.

**G7. A round has no update-in-place.** A project is made from files, and no spec or command I found describes
replacing a project's file with a newer source while keeping its work. The memory keeps every confirmed unit, so a new project per round recovers the work as exact
matches, but the precedence between a **target that arrives in the file** (a `draft`) and **an exact hit in the memory**
for the same segment is not written down. *Probe in S0.*

**G8. No unattended path.** The CLI has no drafting step by design (`CLAUDE.md`, "The draft engine", D39); a draft run
is a server job started from the SPA. The loop is therefore a person's, by hand, in the first rounds. That is the right
size for a release-by-release cadence and is not a defect to fix now.

**G9. Length is unmeasured.** A UI string has room; Tessera has no rule for it. Whether it matters is an empirical
question (how many Russian or Ukrainian targets exceed the English source by a margin that breaks a layout), and it is
answered by round 1, not by building a rule first.

## 4. The loop

A round is one language and one release of the workbench's catalogue.

1. **Export** (workbench, offline): `locales export --lang uk` writes one XLIFF 2.1 file: `srcLang="en"`, `trgLang="uk"`,
   one `<unit id name>` per key, `{{x}}` as `<ph>`, a `<group>` per plural key expanded to the target's categories,
   notes for context and glossary hits, the current Ukrainian as `state="initial"`, `translate="no"` on the seven
   likelihood-band words and the product name. The file lives outside the repositories.
2. **Project** (Tessera): a new project per round, in the owner's tenant, for an internal client number; the file is
   added; the language memory for the pair and the workbench glossary are attached.
3. **Pre-translate** (TM first). What the memory already holds is placed; with S2, only where the unit's kind allows.
4. **Draft** (engine, if the client has consented): the engine drafts what is left, with the memory's nearest units,
   the glossary and (S1) the unit's notes. Drafts are suggestions beside the segment, accepted by a person.
5. **Review** (a native reader): offered as an assignment, edited and confirmed in the editor with the notes shown;
   QA runs on every save; the owner reviews the assignment as usual.
6. **Export** with the reviewed-state option (S4): confirmed segments are written `final`; everything else keeps
   `translated` or `initial`.
7. **Import** (workbench): the strict checks of its §3.6, then a pull request. The workbench counts `final` units as
   reviewed and says so in its interface.

```xml
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.1" version="2.1" srcLang="en" trgLang="uk">
  <file id="f1">
    <unit id="saveButton" name="saveButton">
      <notes><note category="context">Button, case page toolbar. Imperative verb.</note></notes>
      <segment state="initial"><source>Save</source><target>Зберегти</target></segment>
    </unit>
    <group id="itemCount">
      <unit id="itemCount_few" name="itemCount_few">
        <notes><note category="context">Plural, category "few" in Ukrainian (2 to 4, 22 to 24, not 12 to 14).</note></notes>
        <segment state="initial">
          <source><ph id="1" equiv="{{count}}" disp="{{count}}"/> items</source>
          <target><ph id="1" equiv="{{count}}" disp="{{count}}"/> елементи</target>
        </segment>
      </unit>
    </group>
  </file>
</xliff>
```

The strings in that example are invented; the real ones are not copied into this repository (§5).

## 5. How it is proved, and what would not be proof

Tessera's fixture rule applies: a fixture encodes a belief about someone else's format, and only a real sample checks it.
Here the producer is the workbench's exporter, which we write, so the file is a real sample *of this scenario* but still
not of any other tool's output. The spec does not claim more.

- **A fixture** `fixtures/xliff/software-strings.en-uk.xlf`, hand-written with **invented** strings in the shape of §4
  (a `<ph>` per variable, a plural `<group>`, notes, `translate="no"`, targets in `initial`), under the same gate:
  zero-edit round trip byte-identical, every inline element round-trips through tokens, a translated export parses
  again. It also pins the probes below as tests that name what is known.
- **A research record** in `research/software-localisation/`, under the protocol that binds `semantic-matching-spec.md`
  §6 and the engine benchmark: a hypothesis is committed before the run that tests it; every run gets a results file
  with commit, corpus digest, model and parameters, failures included; `hypotheses.md` and `journal.md` are append-only;
  numbers only, no text, even though these strings are public, so this record looks like every other. The first
  hypotheses, to be committed in S0 with their thresholds **before** round 1:
  - **H1.** Giving the engine a unit's notes and the glossary's terms lowers the edit distance between its draft and the
    reviewer's final target, against the same engine without them. Arms: Tessera engine with both, without, and DeepL
    (`uk`, `ru` only). Gold is reviewed targets only, never the present AI drafts.
  - **H2.** Without S2, plural siblings and same-source units receive propagated or exact-matched targets that a reviewer
    then changes; the count is the measure, and S2 should bring it to zero.
  - **H3.** `term.glossary_mismatch` flags accepted `uk`, `ru` and `zh-Hans` targets often enough to need S5; the share
    is the measure and its threshold is fixed before the run.
- **S0's probes**, each a recorded observation and not an assumption: QA over a `uk`, `ru` and `zh-Hans` pair
  (which rules misfire, and on what); glossary matching on an inflected `uk`/`ru` rendering and a `zh-Hans` one; the
  precedence of an arriving target against an exact memory hit; DeepL's pairs for `uk` and `ru` against the adapter's
  list.

A pass here proves the loop runs and says where Tessera is wrong for this text. It does not prove translation quality;
that is H1 on reviewed data, and it is only as good as the reviewers.

## 6. Slices (proposed cards, none filed)

Each is one card, one branch, one PR, and each starts with the standing question of working rhythm 6 (D5).

| | Slice | Size | Notes |
| --- | --- | --- | --- |
| S0 | The fixture, the research record with H1 to H3 committed, and the probes of §5 as tests | S | no behaviour change |
| S1 | **Unit context (G1).** Read `name` and `<notes>` into nullable columns on the segment (a project-schema migration), show them read-only in the editor under the source, add a bounded, escaped `<note>` block to the draft prompt (`PROMPT_VERSION` bumped, per its own rule). Third-party text, so it follows the escaping of every other prompt input; never on a client-facing surface | M | needs S0 |
| S2 | **Plural siblings (G2).** Units sharing an XLIFF `<group>` take no propagation from one another, are excluded from `consistency.target_differs` and `seg.untranslated` against one another, and an exact hit is never placed *between* siblings. Bounded and deterministic. Key-scoped matching for polysemy is the wider option (D4) and waits for H2's count | M | needs S0 |
| S3 | **Glossary import (G3).** A CSV (`term,lang,rendering,status,avoid,keep`) into a `.ctg`, each row one `custom` decision through `writeRendering` (the one write path), `avoid` as `forbidden` renderings, `keep` as a rendering equal to the term with a note, the actor required, all or nothing with refusals by line | M | |
| S4 | **Reviewed state on export (G5).** An export option, off by default and logged in the event's detail, that writes `final` for `confirmed` segments and leaves the rest; a zero-edit export without it stays byte-identical | S | |
| S5 | **`uk`, `ru` and `zh-Hans` in glossary matching and QA (G4, G6).** Scoped by S0's findings and H3: at most a substring rule for CJK, ending lists as data for a language where the data are checked by a reader, and script-aware language matching for `zh-Hans` against `zh-Hant`. Not started without S0's numbers | M | needs S0, H3 |
| S6 | **Round 1: `uk` and `ru`.** An operation, recorded in the research record and the backlog: counts, defects found, hours spent, what Tessera could not do | S | needs the workbench's L2 and S1 to S4 |
| S7 | **Round 2: `zh-Hans`.** The first new language; the Tessera engine only (D14), the pricing basis of G6 settled or left `null`, the first look at script-aware matching | S | needs S6, S5 as needed |
| S8 | **Decide whether a native resource-file filter is worth it** (JSON catalogues read directly, no XLIFF in between), on the friction rounds 1 and 2 record. Not before | | needs S7 |
| S9 | Only if measured: key-scoped matching (D4 option B), a length rule (G9), a context for the sibling units of a plural group in the prompt | | |

The workbench's L1 to L5 do not wait on any of this, and S0 to S5 do not wait on the workbench.

## 7. Decisions proposed (none taken)

**D1. Who the client is.** (a) Louis's own tenant with an internal client number; consent for the Tessera engine switched
on for that client only (the text is public); DeepL left off until `uk`/`ru` rounds show a reason. (b) Human-only first,
engine off. (c) A fresh tenant for the experiment. *Recommended: (a).* It is the consent gate and the purge under real
conditions, with nothing at risk. (c) adds tenancy ceremony for no gain.

**D2. XLIFF only, for now.** (a) Rounds 1 and 2 use the existing XLIFF filter; a native JSON filter is decided after
round 2 (S8). (b) Build the JSON filter first. *Recommended: (a).* It needs no new filter, the format is standard,
and the friction that would justify a JSON filter is exactly what the rounds measure.

**D3. How the reviewers are engaged.** (a) Native readers invited to the roster as vendors, offered an assignment,
paid at a rate Louis sets (the real Epic 9 path, so it is under test). (b) Readers outside Tessera, working from the
exported file in another tool. (c) Louis alone for the first round. *Recommended: (a) once a reader exists; (c) only to
shake out S1 to S4.* (b) tests nothing about Tessera.

**D4. Plural and polysemy handling.** (a) S2 now, bounded to groups; key-scoped matching later if H2 shows polysemy
errors. (b) Key-scoped matching from the start: a unit's `name` stored with each memory unit and an exact hit placed
only where names agree. *Recommended: (a).* (b) changes the memory's contract (`tm-format-spec.md`) for a problem not yet
counted.

**D5. Working rhythm 6, Rust/WebAssembly.** The question is asked before each slice; nothing here is a hot kernel. The
work is reading XML attributes, a prompt block, a CSV and a few SQL columns. *Recommended: stay in TypeScript for S0 to
S5*, as D6 of the engine spec and §3.8 and §3.9 did, and reopen only on a `pnpm bench:tm` result. Louis's answer is
needed before S1; this spec is not a stop because it builds nothing.

**D6. Where the numbers live.** (a) `research/software-localisation/`, numbers only, the protocol of the other records.
(b) Also keep the (public) strings and drafts there. *Recommended: (a).* One protocol, and the strings are already in
the workbench's repository if anyone wants them.

## 8. Not in this spec

A tenant or portal for software customers; a connector to a code host or a continuous-integration step that calls
Tessera (G8); ICU MessageFormat, Android, gettext or `.strings` filters; screenshots or in-context preview; a machine
quality-estimation score; real-time collaboration; translating Markdown help articles or lesson JSON (the workbench's
§4 lists them as later surfaces and each needs an extractor of its own); any change to pay, rates or the portal.
