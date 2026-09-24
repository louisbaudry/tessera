# v1 Issue Backlog

Derived from `planning/v1-spec.md`. Ordered so that the riskiest thing —
tag-safe DOCX roundtrip — is proven before any UI exists.

Sizes: **S** ≈ half a day, **M** ≈ 1–2 days, **L** ≈ 3–5 days.
Built in this repo.

**Every open entry below is a GitHub issue**, linked from its own
heading and labelled by epic and size. *Status, ordering and what is in
flight live there, not here* — don't record progress in this file, move
the card. (The two numberings are independent and will never line up:
`#15d` is a backlog ID, `issue #3` is where its state lives. The
issues were renumbered when they moved here from the private
development repository in September 2026.)

Two heading forms, and only two. An open entry is
`**#N · Title · SIZE** · [issue #X]`. A completed one is
`**#N · ~~Title~~ · DONE — where it lives**`, with no issue link — its
state is settled, so the entry is now record and nothing tracks it. The
PR that lands an item rewrites the first form into the second, in the
same change that adds the write-up. Don't leave it half-way, carrying
both a "what it taught" section and a live issue link: that reads as
open on the board and done in the file.

A **phased** item is the single exception, and `#18b` is the live one:
while any phase is still open it keeps its link — pointing at the open
phase's issue — even though the finished phases are struck through. Only
when the last phase lands does it take the completed form. Phased work
has its own handoff rules in `planning/multi-session-workflow.md`.

What stays here is the **record**: why a decision was made, what a real
client file turned out to do, which invariant a test earned. That is why
completed entries are kept in full rather than deleted — several of them
are the only written trace of a bug that cost a day (`#7`'s `w:pPr`
depth, `#10`'s three data-loss bugs, `#18`'s 4,615-line warning storm).
A closed issue is a state change; the paragraph explaining what it taught
is not.

---

## Epic 0 — Foundations

**#1 · ~~Resolve the stack decision~~ · DONE, re-scoped 2026-08-30**
**TypeScript throughout**, lock confirmed and unaffected by the pivot
below. The Tauri prototype in `cat-tool-project/code/` is parked as a
licensing spike and is not carried into this repo. The shell decision
(Electron vs. web) is superseded: v1 ships as a web service —
`@cat-tool/server` (Fastify) + `@cat-tool/web` (React) — per
`v1-spec.md` §2. `@cat-tool/core` was built headless specifically so this
kind of reversal costs nothing; it does not.

**#2 · ~~Monorepo scaffold~~ · DONE**
pnpm workspaces, `@cat-tool/core`, TS strict (`noUncheckedIndexedAccess`,
`verbatimModuleSyntax`), vitest, eslint flat config, prettier.
`typecheck` runs against `tsconfig.check.json`, which *includes* test files
— vitest only transpiles, so without that a type error in a test would go
unnoticed. Changesets still to add when there is something to version.

**#3 · CI matrix · PARTIAL** · [issue #1]
GitHub Actions on Windows / macOS / Linux: install, typecheck, lint,
format check, test, build. **Green.**
*Remaining, re-scoped for the web-service pivot:* the 3-OS matrix mattered
for a packaged desktop app; a server needs one build target — the
container's own Linux — plus a smoke test of the built image against a
throwaway volume. `better-sqlite3`'s native ABI now only has to match the
container's Node, chosen once (TM format spec §1.1).

**#4 · ~~Core domain types~~ · DONE**
`Token`, `TmToken`, `TagKind`, `Segment`, `SegmentStatus`, `Origin`,
`QaRule`, `QaIssue` in `@cat-tool/core/model`. Tag invariants as pure
predicates — `validateTagStructure` (nesting, interleaving, duplicate ids,
unclosed), `tagSignature` / `tagsMatch` (order-independent multiset),
`missingTags` / `extraTags` (feeding QA rules `tag.missing` / `tag.extra`).
18 tests.

`FormatEntry` deferred to #7, where the format table is actually designed
against real DOCX rather than guessed at.

---

## Epic 1 — DOCX filter *(highest risk — do first)*

**#5 · ~~Real-world DOCX corpus~~ · DONE (with gaps)**
20 real client DOCX in `fixtures/docx/`, selected from a 36-file archive
for structural diversity and pseudonymised before entering git history.
See `fixtures/docx/README.md` for provenance, method and per-file rationale.

Covered: tables, hyperlinks, endnotes, tracked changes, fields, drawings,
legacy VML, text boxes, deep numbering, content controls, embedded fonts,
mixed language, headers/footers, superscript.

**Not covered — needed in a later batch:** comments, `fldSimple`,
equations, symbol runs. Tracked changes, endnotes, tables and footnotes
each come from a single file, so none is covered redundantly.

Footnotes arrived with `footnotes-manuscript` (72 notes, 55 of them
referenced mid-sentence, 10 footers, Spanish source text). That file also
made footnote *bodies* in-scope for v1 — see spec §3.5.

Two fixtures fail strict XSD validation *in their original form*
(`mc:AlternateContent`-wrapped `numPicBullet`; an unreferenced
`[trash]/0000.dat` part). Both are kept deliberately — #8 must preserve
them, not repair them.

**#6 · ~~Unzip / rezip with byte fidelity~~ · DONE**
`@cat-tool/core/docx/package.ts` — `readDocx` / `writeDocx` / `getPart` /
`replacePart` / `translatableParts`, over `fflate`. Order-preserving,
immutable, and refuses to read or write a package missing
`[Content_Types].xml` or `word/document.xml`.

Verified across all 21 fixtures: read → write → read reproduces every
part's decompressed bytes and their order exactly, including embedded
fonts, image binaries, and the unreferenced `[trash]` part. 54 tests.

Note for #10: compare binary parts by **digest**, never `toEqual()` —
deep equality walks a multi-megabyte `Uint8Array` element by element and
took 54s across the corpus; hashing takes 14s.

**#7 · ~~Skeleton extraction~~ · DONE**
`docx/xml-scan.ts` (offset-reporting scanner) and `docx/skeleton.ts`
(`extractSkeleton` / `renderSkeleton` / `regionText` / `isUntranslatable`).
Per-part skeletons across body, tables, headers, footers, text boxes and
footnote/endnote bodies. 39 tests.

The skeleton is built by **slicing the original XML string**, never by
re-serializing a parsed tree — that is why an unmodified render is
byte-identical rather than merely equivalent. Regions store the exact
substring they replaced; `w:pPr` stays in the skeleton because it is
formatting, not content.

Verified byte-identical on every translatable part of all 21 fixtures,
which is stronger than this issue asked for (semantic equality) and is
already the property #8 needs.

Two bugs worth remembering, both found by tests rather than review:
`w:pPr` was located by nesting depth, but depth is only comparable within
a single scan — it is now found by position, per the schema rule that
`w:pPr` is the first child. And nested paragraphs (text boxes) initially
had their whole element replaced while only their *content* was spliced
back, silently dropping the `<w:p>` wrapper.

*Deferred to #9:* the format table. Regions currently carry raw XML;
tokenising it into `Token[]` with a `fmt` index is #9's job, and the
skeleton mechanism is provable without it.

**#8 · ~~🚦 Roundtrip gate~~ · DONE — Epic 5+ unblocked**
`docx/document.ts` (`importDocx` / `exportDocx` / `documentSegments` /
`translatableSegments`) and `docx/roundtrip.gate.test.ts`. 73 tests, its
own `pnpm test:gate` script and its own CI job on Linux + Windows.
**Mark `🚦 roundtrip gate` as a required status check on `main`.**

Asserts **byte-identical** parts, not semantic equality — stronger than
this issue asked for. Also asserts export is idempotent (a second save
must not drift), segment text and part assignment survive, and note
bodies sort after body text (spec §3.5).

*Verified the gate can fail*, by injecting two realistic corruptions and
confirming it caught both:
- rewriting `<w:br/>` as `<w:br></w:br>` — semantically identical,
  byte-different — failed 5 fixtures;
- dropping the unreferenced `[trash]` part as "cleanup" — failed 2.

A gate that passes on the first run is worth distrusting; this one was
mutation-tested rather than assumed.

Non-vacuity is asserted in-suite too: every fixture must yield at least
one translatable segment, a changed segment must change the output, and
changing one segment must leave every other part untouched.

Encoding note for later parts: `TextDecoder` is constructed with
`ignoreBOM: true` and `fatal: true`. Without the first it silently strips
a leading byte-order mark, dropping three bytes and breaking fidelity
invisibly; without the second, malformed UTF-8 becomes U+FFFD instead of
an error.

**#9 · ~~Runs → tagged tokens~~ · DONE**
`docx/tokenize.ts` — `tokenizeRegion` returns `Token[]` plus a
`FormatEntry[]` format table. Runs with formatting become paired tags,
hyperlinks wrap their content, footnote refs / fields / breaks / tabs /
drawings become `ph`. Ids number from 1 in source order. 25 tests.

**Tags are visible or hidden.** Taking spec §3.2 literally — "a change in
`w:rPr` opens a tag pair" — is unusable against real documents: one 31k-word
manuscript has **9,261 runs carrying only `w:spacing`** (kerning) against
201 that are actually italic. So a run tag is *visible* only when its
properties carry formatting a translator would recognise (b, i, u, strike,
caps, vertAlign, rStyle, highlight, colour); incidental properties still
produce a tag so the run can be rebuilt, but it is carried automatically.

Corpus-wide result: **57% of 1,211 segments are completely tag-free**, with
1,992 visible tags against 12,501 hidden. Without the split a translator
would face 14,493.

Tracked changes: `w:ins` is transparent (insertions are current text),
`w:del` is an opaque hidden placeholder (struck text is not what is being
translated).

Corpus-wide properties asserted: every segment tokenises to a **valid tag
structure** per #4's `validateTagStructure`, segment text survives exactly,
ids are contiguous from 1, and every tag token has a format entry.

*Fixed en route:* `regionText` counted `w:delText` as text, so a
reviewer-deleted comma appeared in the segment text but not in the token
stream. Deleted text is now excluded from both.

*Export path unchanged.* Unmodified segments still export by splicing
original XML, which is what keeps the gate byte-identical. Rendering a
**modified** segment from tokens is #10.

**#10 · ~~Tokens → runs (render)~~ · DONE**
`docx/render.ts` — `renderTokens` / `renderRegion` / `mergeTokens` /
`withText`. 30 tests.

Rejects tag-invalid targets before emitting anything: unclosed pairs,
interleaving, and tokens pointing at a format id that does not exist.
Emitting broken XML would hand back a file Word refuses to open, and the
failure would surface at delivery rather than at the mistake.

Re-merges adjacent identical formatting (spec §3.4) and joins adjacent
text, so editing does not fragment a segment further on every save.
`FormatEntry` gained `placement` so the renderer knows where each payload
may legally sit — a `w:br` must be inside a run, a `w:proofErr` must not.

Corpus-wide: every segment renders, text survives, tag structure stays
valid, no kind of formatting is lost, visible tag count never grows, and
**rendering is a fixed point** — a second render changes nothing further.

*End-to-end proof:* six fixtures fully translated segment by segment,
then XSD-validated. Five pass cleanly; `media-heavy-packet` carries the
same `mc:AlternateContent` error it arrived with. Construct census
across all six is unchanged — footnote references, tables, cells,
drawings, VML, hyperlinks, breaks, tabs, numbering, fields, content
controls, text boxes, bookmarks all preserved.

**Three data-loss bugs found here, all invisible to #9's own tests:**
- Empty runs (`<w:r><w:rPr/></w:r>`) were silently dropped, so a render
  was not a fixed point — every save would have rewritten the document.
- A run holding only an empty `<w:t></w:t>` took the visible-tag path but
  produced no text, so its tag vanished on re-render. Word emits these
  around character-style boundaries.
- `w:ins` was treated as transparent, so translating a document
  **silently accepted every pending tracked insertion**. Wrappers
  (`w:ins`, `w:smartTag`, `w:sdt`) are now hidden paired tags.

**#11 · ~~Untranslatable detection~~ · DONE**
`isUntranslatable` in `docx/skeleton.ts`, wired through
`DocumentSegment.untranslatable` and `translatableSegments`. A region with
no letter in any script — pure numbers, punctuation, whitespace — is not
presented as a segment. Uses `\p{L}` rather than an ASCII range, so
Spanish accents and inverted marks count as content.

---

## Epic 2 — Segmentation

**#12 · ~~SRX-lite engine~~ · DONE**
`segment/segmenter.ts` — `findBoundaries` (pure, on plain text) and
`segmentTokens` (tag-aware). Deliberately two stages so boundary rules can
be tested against a sentence list without any XML in the way.

A tag pair spanning a boundary is closed at the end of one segment and
reopened in the next, and ids are renumbered from 1 per segment with its
own format table. Export re-merges the adjacent identical formatting
(#10), so the split is invisible in the output.

**The split is deferred, not immediate.** A footnote reference written
after a full stop belongs to the sentence it annotates, not the one that
follows; closing tags likewise close the sentence that just ended. Only
an opening tag or new text starts the next segment.

Corpus result: **1,211 paragraphs → 2,706 segments**, 43% of paragraphs
splitting, median segment 94 characters.

**#13 · ~~Abbreviation lists, 7 languages~~ · DONE**
`segment/rules.ts` — rules are data, not code. EN and ES curated to a
higher bar as the working pair; ES includes the religious and academic
honorifics (`Mons.`, `Excmo.`, `Rvdo.`, `Pbro.`) that the actual source
texts are full of, each of which is otherwise a false break mid-name.

Three language-specific behaviours, each earned by a failing test:
- **ES inverted marks.** `¿` and `¡` open a sentence, so the usual
  "next character is uppercase" test *misses* a real boundary and merges
  two sentences into one.
- **DE/NL ordinals.** German capitalises every noun, so the word after
  "3." cannot distinguish "Der 3. Absatz" from "Wir zählten 20. Dann".
  Resolved by looking at what precedes the number: a determiner or
  preposition (`ordinalPrefixes`) means an ordinal.
- **Case-flexible abbreviations.** A lowercase abbreviation is capitalised
  when it opens a sentence ("Vgl. Kap. 4") and a capitalised one appears
  lowercase mid-sentence ("Ref. no. 5"). Only the first letter is flipped,
  so `US` never collides with `us`.

**Deliberate bias, documented in test:** where an abbreviation genuinely
could end a sentence (`etc.`), no break is made. A false break hands the
translator half a sentence and writes a fragment into the memory that will
never match again; a missed break only produces a longer segment they can
split by hand (#14). The recoverable mistake is the one to make.

`:` and `;` are per-language switches, off everywhere by default.

**#13a · Segmentation rules for Korean and Vietnamese · M** · [issue #2]
Found while reverse-engineering real `.sdltm` memories (2026-09-13, two
more real client TMs — EN→KO, 529 units; EN→VI, 2,866 units,
both with real tagged content): `rulesFor('ko-KR')` and
`rulesFor('vi-VN')` both throw (`SUPPORTED_LANGUAGES` is currently `en,
es, fr, de, it, pt, nl` only). `assembleFile` takes its `SegmenterRules`
from exactly this call, so **importing a fresh Korean or Vietnamese
source document would fail before producing a single segment** — not a
quality gap, a hard block. The normalisation/hashing layer (`core/tm/
normalize.ts`) was checked against real text from both files and has no
problem — NFC and the typographic-variant folding don't touch either
script, `hashOf` is stable. The gap is segmentation only.

**Deliberately not attempted quickly:** #13's own lesson is that a
curated list earns its place one failing test at a time (the ES
inverted-mark and DE/NL ordinal-prefix rules above didn't come from
guessing); Korean in particular doesn't have a Latin-style abbreviation
problem at all — its sentence-boundary question is a different kind of
problem (no inter-word spacing to lean on, different final punctuation
conventions) and deserves the same real-failing-test discipline as EN/
ES got, not a rushed first pass.

*Done when:* `rulesFor('ko')` and `rulesFor('vi')` return real rule
sets, each with at least one behaviour earned by a real failure the way
§13's ES/DE/NL rules were, and `SUPPORTED_LANGUAGES` includes both.
Real reference text exists for both (the two TMs above) but neither is
in `fixtures/` yet — pseudonymising and adding them the way
`fixtures/docx/` was built is worth doing before this item is picked
up, not after.

**#12a–#12f · ~~Custom segmentation~~ · DONE (12d partial) — see
`planning/segmentation-spec.md` §7**
`segment/profile.ts` (profiles as deltas over the built-in defaults, with
explicit removals), `segment/trados-lists.ts` (the actual Trados
migration path), `segment/srx.ts` (SRX 2.0 export, 1.0 + 2.0 import).
69 segment-suite tests.

Evaluation order: user rules decide first and outrank everything;
variables veto breaks inside themselves; built-ins handle the rest. A
break rule can create boundaries no terminator scan would visit.

**Bug caught by the roundtrip test, worth remembering:** lifting SRX
no-break rules into typed lists silently *reordered* them behind any
imported generic break rule, defeating every lifted exception. Import now
lifts only from our own exports (recognised by their generic-rule
fingerprint, which is then dropped as redundant with the built-ins);
foreign SRX imports verbatim as ordered rules, preserving its
first-match-wins semantics exactly.

#12d is partial by dependency, not omission: the `seg_profile` schema and
its JSON serialization are specified and implemented; writing it into an
actual SQLite file lands with #15a. Trados cannot export SRX at all — its
rules live in the TM rather than a file type — so the `.txt` lists are
the real migration path off Trados.

**#14 · ~~Merge / split segments~~ · DONE — `segment/edit.ts`**
Within one paragraph, with target preservation and skeleton consistency.

`splitSegment` reuses the segmenter's cut machinery (`cutTokensAt`,
extracted for the purpose), so a manual break behaves exactly like an
automatic one: spanning pairs closed and reopened, trailing placeholders
kept with the sentence they annotate, halves renumbered from 1. It
refuses cuts that would leave a whitespace-only side. `mergeSegments`
fuses the close/reopen seam back into spanning pairs by format payload
and emits a normal form (adjacent text tokens coalesced). The
`EditableSegment` policy layer decides targets and statuses: a split
keeps the whole target on the first half as a draft (targets do not
align by character offset, so no mechanical cut); a merge joins targets
with a space and demotes to draft; nothing stays confirmed; locked
segments are refused.

**Invariant, proven on the manuscript corpus:** split-then-merge renders
to byte-identical XML for every segment, and folding a whole paragraph's
segments back together preserves text and tag structure. Token-level
identity is deliberately *not* the invariant — a cut that lands between
two adjacent runs with identical formatting is indistinguishable from a
cut through one run, so merge fuses both cases, exactly as the renderer
collapses identical adjacent runs anyway.

---

## Epic 3 — Storage

**#15 · ~~Project schema + migrations~~ · DONE — `@cat-tool/db`**
Project schema per spec §4.1, including the `tm_one_write_target` partial
index. Versioned migration runner shared with the TM format.

`db/migrate.ts` is the shared runner every SQLite file this product
writes goes through: it identifies a file by `application_id`, refuses
one whose `user_version` is newer than the build understands, backs up
an existing file (via `wal_checkpoint(TRUNCATE)` + copy, so nothing in
the WAL is left behind) before running any pending migration, applies
migrations one at a time each in its own transaction, and runs
`integrity_check` before ever handing back the connection. This already
implements #15b's guard for any file type — #15a's `.ctm` schema plugs
into the same runner unchanged.

`db/project/schema.ts` is the v1-spec §4.1 schema verbatim, with two
additions: `application_id = 0x43415450` ("CATP", distinct from `.ctm`'s
"CATM") for the same self-identification discipline the TM format gets,
and CHECK constraints on `segment.status` and `qa_issue.{rule,severity}`
generated from `@cat-tool/core`'s own closed-set constants
(`SEGMENT_STATUSES`, `QA_RULES`) rather than duplicated as literal SQL —
one list to keep in sync, not two. `segment.origin` is deliberately left
unconstrained, per spec §4.3: a new TM match kind is a value, not a
migration.

`db/platform/schema.ts` is the new §4.1a account table (`application_id
= 0x4341544C`, "CATL"), seeded with one row for now.

19 tests: the runner against a throwaway schema (fresh-file claiming,
idempotent reopen, partial-migration catch-up, backup timing, rejected
application_id mismatch, rejected future version, surfaced corruption,
rejected non-contiguous migration lists, rollback on a failed
migration), plus both real schemas' constraints exercised directly.

**#15a · ~~`.ctm` format implementation~~ · DONE — `@cat-tool/db/tm`**
Full multilingual schema per `tm-format-spec.md` §2: `tm`, `tu`, `tuv`,
`tu_attr`, `tuv_history`, `tuv_fts` with triggers, `tuv_vec`, plus
`seg_profile` (already speced in #12d — shipped inside format version 1
since no file had been written yet). `application_id = 0x4341544D`
("CATM") and `user_version` pragmas, WAL, `synchronous = FULL`, all via
the shared `openAndMigrate` runner from #15 — nothing schema-specific
needed adding to it beyond one thing: `foreign_keys = ON`, added to the
runner itself (not just `.ctm`) since it was a correct default the
project schema was quietly missing too.

`createTm`/`openTm` split creation from opening: the `tm` table's
`CHECK (id = 1)` makes an identity-less file an incomplete memory, so
`createTm` writes that row (fresh `uuid`, `normalizer_version` and
`tokenizer_version` stamped at 1) and refuses outright on a file that
already has one, rather than silently ignoring a second call's options.

*Done when:* a created file is identified as `CATM` by its header
alone, and `integrity_check` passes after a forced-kill mid-write.
Both proven directly: the header check reads the raw bytes at offset 68
with no SQLite involved at all; the crash-safety test spawns a real
child process that opens the file, begins a transaction, inserts 200
rows, writes a marker proving it got that far, and is then hard-killed
(`SIGKILL`) from the parent mid-transaction — the parent reopens the
file fresh afterward and confirms `integrity_check` passes and none of
the 200 rows landed (WAL correctly discarded the incomplete transaction
on next open).

`tuv_fts` sync is trigger-based (external-content fts5, standard
insert/delete/update trigger trio) and tested against real inserts,
updates and deletes — including that `remove_diacritics 2` makes
`solucion` find `solución`, which matters for Spanish.

Also closes **#15b** for `.ctm` specifically: a hand-bumped
`user_version` is refused with a clear message, not partially read —
the guard already existed generically in the shared runner (#15),
proven here again against a real `.ctm` file rather than only inherited
by architecture.

Deliberately not touched here, each its own backlog item: `plain`/`hash`
normalisation (#17), the project-`Token` ↔ `TmToken` mapping (#15c),
merge (#15d), and the pair-retrieval query (#15e).

**#15e · ~~Pair retrieval self-join~~ · DONE — `@cat-tool/db/tm/retrieve.ts`**
`tuv`-to-`tuv` join on `tu_id` for any `(src_lang, tgt_lang)`, ordered by
quality then recency, excluding tombstoned units. Region-insensitive
language fallback (`es-ES` query matches `es` variant).

`retrievePair(db, {srcLang, srcHash, tgtLang})` is the whole surface.
There is no separate reverse-lookup path because the schema never
encoded a direction — `s`/`t` are just which side of the join a given
call puts each language on, so ES→EN from EN→ES-authored units is the
identical function call with the arguments swapped, proven directly by
a test.

Region-insensitivity is a SQL scalar function, `primary_subtag(lang)`,
registered once per connection (`better-sqlite3` throws on a duplicate
registration, guarded by a module-level `WeakSet<Database>`) and applied
to **both** sides of the join — a document tagged `en-GB` still finds a
memory built with bare `en`, not just the target side the "done when"
example mentions. The BCP-47 split itself (`primarySubtag`) moved out of
`segment/rules.ts` into a shared export, since segmentation's `rulesFor`
and this query both need the exact same answer for the exact same tag —
one definition, not two that could drift.

*Done when:* a memory holding EN/ES/DE retrieves all six directions
correctly, and reverse lookup (ES→EN from EN→ES-authored units) works
without a separate code path. Both proven directly, plus: ordering
(quality desc, then recency, tested against three units genuinely
sharing one source hash per spec §7), tombstone exclusion, and the
region-insensitive fallback on both source and target.

**#15b · ~~Format version guard~~ · DONE — see #15a**
Refuse files above the known `user_version` with a clear message; offer
and perform upgrade for files below it; back up before every migration
(format spec §9, §10).

Implemented generically in `@cat-tool/db/migrate.ts` (#15) — shared by
every SQLite file this product writes — and proven twice: once against
a throwaway schema in `migrate.test.ts`, and once against a real
`.ctm` file in #15a's own test, closing the "done when" for the format
this item actually cares about protecting.

**#15c · ~~Reduced token mapping~~ · DONE — `@cat-tool/core/tm/mapping.ts`**
Project `Token` ↔ `TmToken`: drop `fmt`, derive `TagKind`, renumber ids.
Retrieval re-maps TM tags onto the current segment's formatting by
`(kind, order)` (format spec §3).

Lives in `core`, not `db`: this is pure token-shape logic with no
SQLite in it, and it's the first thing to land in `core/tm/`
(previously "not started" in the README's own layout diagram).

`toTmTokens` is the write side — mechanical, drop `fmt`, keep `kind` as
the hint, renumber from 1. `remapTmTokens` is the read side and does
the actual work: it groups the receiving segment's own `open`/`ph` tags
by kind, in source order, then walks the matched `TmToken[]` consuming
one id per kind in the same order — the Nth `bold` tag in the match
takes the fmt id of the Nth `bold` tag already in the segment. It
refuses (a typed `{ok:false, reason}`, never a guess) the moment a
kind's count doesn't match exactly between the two sides, in *either*
direction (the match having more of a kind than the source has, and
the reverse), or a match tag carries no kind hint, or a close has no
matching open — every one of those is exactly what the
`tm_exact_tagdiff` path (`v1-spec.md` §6.1) exists to catch, so
refusing loudly here is what hands the decision to that path instead
of emitting something tag-invalid. The success path is additionally
checked with `validateTagStructure` before it's ever returned, as a
safety net against a mapping bug rather than trusting the algorithm.

*Done when:* a unit written from a bold-containing segment and
retrieved into a *differently* formatted document applies the target
document's formatting, not the origin's. Proven end-to-end: a segment
tokenized with a plain-bold run is written to `TmToken[]`, then
remapped onto a *different* document whose bold run is bold+italic —
the rendered output carries the receiving document's `<w:b/><w:i/>`
run, not the origin's plain `<w:b/>`.

**#15d · Merge two `.ctm` files · M** · [issue #3]
`uuid` + `rev` resolution, tombstone propagation, history retention,
same-hash-different-uuid kept as distinct units (format spec §7).
*Done when:* merging a file with itself is a no-op, and merge is
commutative on the test corpus.

**#16 · ~~Repositories~~ · DONE — `@cat-tool/db/project/*`**
Typed CRUD over projects, files, segments, TM refs, QA issues.
Multi-TM `ATTACH` and priority resolution. Synchronous throughout
(`better-sqlite3`), with `db.transaction()` around every multi-statement
write.

**Turned up a real gap nothing had built yet: there was no code
anywhere that turned an imported DOCX into rows a repository could
insert.** `@cat-tool/core/project/assemble.ts` (`assembleFile`) is
that missing step — tokenizes every region, sentence-segments it with
`segmentTokens`, hashes each result with #17's `normalizeTokens`, and
classifies untranslatable content as locked, never sentence-split.
Deliberately its own top-level `core/project/` layer rather than
living in `docx/`: `assembleFile` needs `segment/segmenter.js`, and
`docx/` must never depend on `segment/` (the dependency already runs
the other way — `segmentTokens` takes a `TokenizedRegion`).

**A second real gap, found while wiring the first one up: `file` and
`segment`'s columns didn't actually match what #7/#9 built.**
`v1-spec.md` §4.1 had `format_table` on `file` (one shared table) and
a vague "document.xml with markers" `skeleton` column — drafted before
the skeleton and tokenizer existed. Once they did, `segmentTokens` /
`renumberRegion` turned out to already give each sentence-level split
its *own* renumbered format table — exactly the self-contained shape
a segment needs, with no file-wide id-renumbering/dedup scheme to
invent. Moved `format_table` to `segment`; `skeleton` is now
literally `PartSkeleton[]` JSON. Free to fix in place — no project
database has ever been written, the same situation as every other
spec correction this session. Full reasoning in `v1-spec.md` §4.1's
own correction note.

That schema fix meant `FormatEntry`/`TokenizedRegion` needed to move
too: a `Segment` domain type needs its own format table, but they
lived in `docx/tokenize.ts`, and `model/` (where `Segment` lives) must
never import from `docx/` — the reverse already holds. Moved both into
`model/token.ts`, next to `Token`; `docx/tokenize.ts` re-exports them
so nothing importing from there broke.

Five repository modules, each a thin, honest mapping between a
domain type and its rows — JSON columns parsed/stringified at the
boundary, booleans converted, nothing smarter:
- `project.ts` — the schema's own `CHECK (id = 1)` singleton, `create`/
  `get`, refusing a second identity row the same way `createTm` does.
- `files.ts` — `insertFile` is the one place a `file` row and its
  `segment` rows are ever written together, as one `db.transaction()`,
  so a project database can never hold a file with a partial or
  missing segment set.
- `segments.ts` — read paths plus `setSegmentTarget`, the one write an
  interactive edit or the future matcher/write-back (#19/#20) actually
  performs. Refuses a locked segment for the same reason pre-translate
  must (`v1-spec.md` §6.1) — there is no reason an interactive edit
  should be allowed where pre-translate isn't.
- `tm-refs.ts` — priority-ordered listing, `setWriteTarget` (clears
  the old target and sets the new one in one transaction, so the
  partial unique index is never briefly violated), and `attachTms`/
  `detachTms`: `ATTACH DATABASE` under a stable per-ref alias
  (`tm_<id>`), idempotent by checking `PRAGMA database_list` rather
  than trusting a call count. *Not* included: the cross-TM matching
  query itself — that reads the attached schemas, and is #19's job.
- `qa-issues.ts` — `replaceQaIssues` re-runs a segment's findings
  wholesale in one transaction, per spec §6.4's "QA re-run, not
  diffed" model, so a fixed issue can never linger.

Proven against the real fixture corpus throughout, not synthetic
rows: `insertFile`/`listSegments` round-trip a genuine 371-paragraph
manuscript through JSON and back; `attachTms` attaches real `.ctm`
files created via `createTm` and queries across the alias.

**#16a · Off-thread bulk operations · M** · [issue #4]
Route TMX import, `.ctm` merge, `VACUUM`, rehash, and batch
find-and-replace through a `worker_thread` / Electron `utilityProcess`
with progress reporting and cancellation (format spec §1.1).
*Done when:* a 500k-unit TMX import leaves the UI responsive and is
cancellable without leaving a partial write.

**#17 · ~~Normalisation + hashing~~ · DONE — `@cat-tool/core/tm/normalize.ts`**
`normalizer_version = 1` exactly as frozen in format spec §4.

**A real bug in the spec itself, caught while implementing it:**
format spec §4's typographic-variant list was missing U+2018/U+2019 —
the two curly single quotes Word's own AutoCorrect actually produces by
default. At some point the literal example characters in that markdown
file were silently straightened, losing the entry most likely to matter
in real client documents (ironic, since undoing exactly that kind of
silent quote-mangling is step 4's whole purpose). Fixed in the spec
first, spelled out by codepoint now rather than left as glyphs, so this
class of corruption is catchable by inspection rather than by accident
during implementation. Free to fix in place — same situation as
§2.7's `seg_profile`, nothing has shipped yet.

Implementation runs the frozen rules in a different order than they're
*numbered* in the spec, deliberately: typographic folding (NBSP, thin
space, etc. → a plain space) happens *before* the whitespace-collapse
pass, not after, because otherwise a mixed run like `"NBSP NBSP"`
would only be partially collapsed by an ASCII-only whitespace regex.
The numbered list describes the rule set; it was never a promise about
pipeline order.

`NORMALIZER_VERSION` lives in `core`, next to the algorithm that
actually implements it — `db/tm/schema.ts` now imports it instead of
declaring its own copy, the same fix `primarySubtag` already got in
#15e for the identical reason (two definitions of one frozen fact can
drift; one can't).

*Done when:* curly/straight quotes, dashes, NBSP, thin spaces, soft
hyphens and ellipsis variants all hash equal; case does not; and the
version is written into every file. All tested directly — including
that `createTm` stamps the real, imported `NORMALIZER_VERSION` (not a
coincidentally-equal local constant) into the `tm` row.

**#17a · ~~Context capture~~ · DONE — `@cat-tool/core/tm/context.ts`**
Populate `prev_hash` / `next_hash` on every write from the segment's
document neighbours. No matcher reads them in v1.

Neither #19 (pre-translate) nor #20 (write-back on confirm) exists yet,
so there is no real "write" to hang this on — `insertUnit`/`insertTu`
only exist as test helpers in `db/tm/*.test.ts`, never as production
code. Scoped this to what's genuinely buildable and testable *now*, and
reusable unchanged by whichever of #19/#20 writes the first real `tuv`
row: `documentContext` is a pure function over `{id, ord, hash,
locked}[]`, no SQLite, no opinion on which language's hash it's given
— exactly like `mapping.ts`/`normalize.ts` beside it in `core/tm/`.
`sourceDocumentContext` is the convenience wrapper for the one hash a
project actually stores today (`Segment.sourceHash`); a future
target-hash write path builds its own entries instead of extending
this function.

**A design decision the spec was silent on, resolved and documented in
`tm-format-spec.md` §5's own implementation note:** locked segments
(page-break markers, empty table cells — never sentence-split, never
confirmed, never written) are skipped entirely — both as neighbours
(they carry no real surrounding-sentence context) and as keys in the
result (they never become a `tuv`, so they never need context of their
own). Two translatable segments separated only by a run of locked ones
are each other's context, not `null`.

*Done when:* units written from a multi-segment file carry correct
neighbours, `NULL` at document boundaries. Proven directly against
`ContextEntry[]` fixtures (a three-segment chain, a single segment,
out-of-order input, one and two consecutive locked segments between
translatable ones, all-locked) and against real `Segment[]` shapes via
`sourceDocumentContext`. **This must ship with the first write-back** —
context not captured at write time cannot be recovered — so whichever
of #19/#20 lands first calls this rather than reinventing it.

---

## Epic 4 — TM and QA

**#18 · ~~TMX import~~ · DONE — `@cat-tool/core/tm/tmx.ts` +
`@cat-tool/db/tm/import-tmx.ts`**
Split the same way DOCX import is split: `core/tm/tmx.ts` does pure
format decoding (`parseTmx`, no DB in it), `db/tm/import-tmx.ts` writes
the result into an open `.ctm` connection as one transaction.

Unlike the DOCX filter, TMX has no byte-fidelity requirement — §8's own
export table documents exactly what's lossy — so `parseTmx` builds a
real tree via a small generic XML parser (elements, attributes, entity
and CDATA decoding, mixed content) rather than slicing the source
string. `<bpt>`/`<ept>` pair into `open`/`close` on TMX's own `i`
attribute; `<ph>`/`<it>`/the deprecated `<ut>` become `ph`; `<hi>` is
tracked through its own stack so nested highlights still pair; any
other inline element degrades to a bare `ph` placeholder rather than
being silently dropped. A `type=` matching one of our own `TagKind`
names is read back as the `k` hint (recognises our own prior export;
left unhinted for arbitrary third-party TMX rather than guessed at).

Every `<tuv>` becomes its own `tuv` row — a multilingual TMX imports
whole, not flattened to a pair, which falls out of the schema for free
(§2.3). `<prop type="x">` → `tu_attr`, with `x-*` props matched
case-insensitively onto the reserved keys (§2.4) where the stripped
name matches, passed through verbatim otherwise; `<note>` also lands
under the reserved `note` key.

**`x-catm-*` restoration is the mechanism that makes our own TMX
roundtrip lossless (§8's claim), not just an import nicety:** `x-catm-
uuid`/`x-catm-rev` (unit-level) and `x-catm-quality`/`x-catm-prev`/
`x-catm-next`/`x-catm-rev` (variant-level) are pulled out of `props`
before they ever reach `tu_attr`, and used to restore the unit's real
identity and a variant's real quality/context instead of the ordinary-
TMX defaults (fresh uuid, quality 2, `NULL` context). Deliberately not
a merge, though: a restored uuid that collides with one already in this
file falls back to a fresh uuid with a warning rather than reconciling
revisions — that reconciliation is #15d's job, kept out of this one on
purpose.

Malformed `xml:lang` warns rather than throwing (one bad `<tuv>` does
not fail an otherwise-good import); a structural problem (no `<tmx>`
root, no `<body>`, a `<tu>` with no `<tuv>`, an `<ept>` with no matching
`<bpt>`) does throw, and the whole import runs as one `db.transaction()`
so a thrown error leaves the file exactly as it was. Every import also
warns once that TMX-sourced units can never be ICE matches (§5 — no TMX
file carries context) unless `x-catm-*` restored it.

`tm.langs` (§2.1's denormalised convenience field) is recomputed from
`tuv` after every import rather than incrementally maintained — a
projection can't drift if it's never trusted to stay in sync by hand.

**Validated against a real SDL Trados export (2026-09-13), not just the
hand-built fixture** — a 24MB, 20,684-unit/41,368-variant bilingual
(en-US/es-MX) memory. Import ran clean: exact TU/TUV counts, correct
`bpt`/`ept`/`ph` pairing against real interleaved tag structure (a
"Page X of Y" segment with four nested tags), SDL's own numeric `type`
codes correctly left unhinted (none matched a `TagKind` name, as
expected), curly quotes and other real prose surviving normalisation.
~5s for the whole file, one transaction.

Two real gaps the hand-built fixture never exercised, both fixed here:

- **Repeated `<prop>` keys silently lost data.** SDL's own
  `x-Context`/`x-ContextContent` bookkeeping repeats the same `type` on
  one `<tu>` routinely — up to 180 times in this file — and `tu_attr`
  is one row per `(tu_id, key)`, so the collapse to one value is
  unavoidable without a schema change. What wasn't unavoidable was
  doing it *silently*: `directProps` now reports which prop types
  repeated, and `parseTmx` aggregates that into one summary warning
  per prop type (`"2277 unit(s)/variant(s) repeat <prop
  type=\"x-Context\">…"`) rather than one line per occurrence — the
  first version of this fix warned per-unit and produced 4615 lines
  for one import, which is not a report a caller could act on.
- **`usagecount`/`lastusagedate` weren't mapped at all**, even though
  `tuv.usage_count`/`last_used_at` exist for exactly this and this real
  file has meaningful usage stats (segments reused 1000+ times). Now
  read from TMX's `<tu>` attributes (where real Trados exports put
  them) with a `<tuv>`'s own value taking precedence when present, per
  the TMX 1.4b DTD allowing either.

38 tests across both packages now (up from 31), including the
duplicate-prop and usage-stat cases above.

**#18b · ~~Native `.sdltm` import~~ · DONE — `core/tm/sdltm.ts`
+ `db/tm/import-sdltm.ts`**
Reverse-engineered against one real Trados Studio memory (2026-09-13,
same source data as #18's real-file test, provided as the original
`.sdltm` rather than its TMX export) — see `tm-format-spec.md` §8a for
the full write-up. Recorded here as a real backlog item, per this
project's "spec before code" rule, rather than built opportunistically
off what was meant to be a TMX validation pass.

**Phase 2a (2026-09-15) — pure parsers, no DB integration yet:**
`parseSdltm(db)` (validates `application_id` + version),
`parseSdltmSegment(xml)` (native Trados segment XML), and
`sdltmSegmentToTokens(segment)` (→ `TmToken[]`, `CanHide` honoured).
9 tests in `packages/db/src/tm/sdltm.test.ts`, against synthetic data
built from the reverse-engineered schema — deliberately not against the
real file, which Phase 2b needs anyway.

**Why this is worth its own item and not folded into #18:** two things
a `.sdltm` file has that a TMX export of the same memory structurally
cannot carry, confirmed by comparing the two directly —
- **Real per-occurrence ICE context.** `translation_unit_contexts`
  (`left_source_context`/`left_target_context`, one row per document
  location a segment was ever confirmed at) is Trados's own equivalent
  of `prev_hash`/`next_hash` (§5) — richer than ours, in fact, since one
  unit can carry many context occurrences, not one. TMX's exporter
  serialises all of them onto one `<tu>` as repeated `x-Context` props
  (up to ~180 observed on one unit), which is exactly what #18's
  duplicate-prop warning is looking at — and which cannot be reversed
  back into real context by *any* TMX importer, ours included: the hash
  algorithm differs from `hashOf`'s SHA-256-of-normalised-text (§4), and
  `tuv` holds one context pair per variant, not per occurrence.
- **`CanHide`-accurate tag visibility.** The native `<Segment>` XML
  marks every tag `CanHide: true/false` directly — maps onto
  `FormatEntry.visible` with no guessing, where TMX's `bpt`/`ept`/`ph`
  carries no equivalent signal at all.

**Phase 2b (2026-09-15) — database integration; real-file validation still
open:** `db/tm/import-sdltm.ts`'s `importSdltm(db, path)` /
`importSdltmFrom(db, sdltmDb)` writes a parsed memory into `.ctm` as one
transaction, opening the Trados file **read-only** (an import must never be
able to touch the translator's original). One `translation_units` row
becomes one language-neutral `tu` plus one `tuv` per language, so
`retrievePair` works in both directions with no reverse-lookup path — §7's
merge argument made concrete. 49 tests across the two files (up from 9).
Full write-up in `tm-format-spec.md` §8a.1.

**The headline finding reverses this item's own "done when": a `.sdltm`
cannot produce an ICE-capable unit, and that is not a matter of decoding
Trados's hash.** `translation_unit_contexts` records a **left** context
only, and §5's ICE tier needs both neighbours — so `next_hash` would be
`NULL` on every imported variant even with the algorithm in hand. The
second reason stands on its own: Trados's hash is not §4's
SHA-256-of-normalised-text, and a foreign value in `prev_hash` is
indistinguishable at read time from a real one, which would cost the
column the single meaning the whole ICE tier rests on. Both occurrences
and unit ids are therefore carried verbatim into `tu_attr`
(`x-sdltm-contexts`, `x-sdltm-id`) — complete, including the ~180-occurrence
worst case, so nothing is lost if the algorithm is ever recovered — and
every import says so in as many words. The original expectation was
recorded before the left-only asymmetry was noticed; it was wrong, and the
`.ctm` side is better off for not accommodating it.

**`CanHide` did pay off as promised**, and is the one place the native
format's extra fidelity is consumed: a hideable tag never enters the token
stream (the receiving document re-emits its own invisible tags), and a pair
survives only if *both* halves are visible — dropping half a pair would
leave an unclosed tag. What `.sdltm` turned out *not* to carry is the tag
**kind**: `<TagID>` is a document-local Trados id, so imported tags get no
`k` hint, and `remapTmTokens` correctly refuses to guess one. A tagged
`.sdltm` match therefore lands on §6.1's `tm_exact_tagdiff` path rather
than a full placement. Text-only units — most of a real memory — are
unaffected.

**Three bugs in Phase 2a's own code, all found only by making it write
something.** (1) `sdltmSegmentToTokens` emitted every tag before every
text, because the parser returned tags and texts as two arrays with the
interleaving thrown away — `<Tag>Page </Tag>` came out as `open, close,
"Page "`, tags wrapping nothing. The segment is now an ordered `elements`
list, with `tags`/`texts` kept as projections of it. (2) Both the context
and attribute queries were `db.prepare`d *inside* the per-unit loop: 40k
prepares and 40k queries on a 20k-unit file, now two queries grouped in
memory. (3) A unit that failed to parse warned per unit — the exact shape
of #18's 4,615-line report — now tallied by cause, one line each, as is
every other repeated condition on both sides of the import.

Also hardened against the thing this item is actually blocked on: since
the schema is observed rather than documented, unit columns are discovered
with `PRAGMA table_info`, a missing side table degrades to a warning, an
unobserved tag `<Type>` becomes a placeholder rather than vanishing, a
`<CultureName>` disagreeing with the memory's pair is reported, and
`tucount` is checked against what was actually read — the cheapest signal
there is that this reader has misread a Studio version it has not seen.
`DEFAULT_IMPORTED_QUALITY`, now that two importers need it, moved into
`db/tm/import-common.ts`, and `TmError` into `db/tm/errors.ts` so a
re-exported module can throw it without importing its own barrel back.

**`refreshLangs` got the same treatment twice, in parallel, and the
merge is worth recording.** This branch moved it out of `import-tmx.ts`
into `import-common.ts`; #20, in flight at the same time, moved it into
`write.ts` — and #20's is the better home, because it takes the
`(db, options: { schema? })` shape an `ATTACH`ed `.ctm` needs, where
this branch's was the unqualified version. Resolving the conflict by
keeping both would have re-created the exact duplication each change
was making; both importers now call `write.ts`'s, and
`import-common.ts` deliberately holds no copy. Worth knowing for the
next concurrent pair: "extract the shared fact" is the right instinct,
but two branches can extract the *same* fact to two places, and the
merge is where that has to be caught — `git merge` will happily leave
you with two.

**The same merge left a quieter duplicate that `git` could not flag at
all, since neither side's text conflicted:** `write.ts`'s private
`CONFIRMED_QUALITY = 2` and `import-common.ts`'s
`DEFAULT_IMPORTED_QUALITY = 2` were two spellings of one row of spec
§6's quality table. Both are now `schema.ts`'s `QUALITY`, which spells
out all five rows rather than only the two with a caller — a partial
copy of a table is how the second copy starts. `DEFAULT_IMPORTED_QUALITY`
survives as `QUALITY.confirmed` under its own name because "an imported
unit is confirmed" is a *decision* worth arguing once (neither TMX nor
`.sdltm` carries a quality signal; `reviewed` would assert a second pair
of eyes that may never have existed, `draft` would rank a real memory
below this project's own unconfirmed work) — a named decision reading
one table, not a second definition of the number. `tuv.quality`'s
`DEFAULT 1` in the v1 migration stays a literal on purpose: a migration
is a historical record, and interpolating a constant into one means a
file created last year stops being describable by the DDL that made it.

**Update (2026-09-18) — a real file was finally read, and it found three
things in a row.** Not an import: a pseudonymisation pass over a 2013
client memory, thirteen years older than the 8.06 sample, run on the
owner's machine because the file could never reach a session. It did not
survive first contact with the schema, which is the entire point:

- **Context hashes are signed 64-bit integers.** The file carries
  `-8331597179047842233`. `better-sqlite3` returns
  `-8331597179047842000` for it — silently, no error — while
  `node:sqlite` throws. `readContexts` therefore corrupted every context
  hash past 2^53, breaking §8a.1's own guarantee that provenance is kept
  *intact* for the day Trados's algorithm is known. Fixed with
  `CAST(... AS TEXT)` in SQL, so no double is ever involved.
- **`sdltm.fixture.ts` declared those columns `TEXT`, which is why 49
  green tests never caught it** — TEXT affinity converted every synthetic
  int64 to a string before the reader saw it. A fixture wrong in the same
  direction as the code proves nothing. Now `INTEGER`, and the regression
  test fails without the fix.
- **`string_attributes` has no `id` column, and seven tables exist that
  §8a never recorded** (`fuzzy_data`, `date_attributes`,
  `numeric_attributes`, `picklist_attributes`, `picklist_values`,
  `resources`, `tm_resources`). `fuzzy_data` holds one row per unit and
  has not been examined — relevant to any future attempt to ship a
  scrubbed `.sdltm` as a fixture.

Written up in `tm-format-spec.md` §8a.2. Worth keeping in view: **the
fixtures were the means and the findings were the end.** No `.sdltm`
fixture has been committed and none may ever be; the exercise still
answered #18b's open question (*no*, the schema does not hold across
Studio versions) and turned up a live data-corruption bug in shipped
code — from a file nobody in the session could see.

**Update (2026-09-23): four real files, read by shape only, and the
importer would have refused all four.** A read-only probe, run on the
owner's machine, reports each file's tables, types and value widths, and
refuses to print if a single word from the memory would appear. It was
run over both client A memories (66 and 454 units) and both
client B memories (EN→KO 529 units, EN→VI 2,866). Written
up in `tm-format-spec.md` §8a.3. What it taught:

- **`parseSdltm`'s `application_id` guard rejects every real file.**
  All four carry `0`. The expected `1112754007` was one sample's value,
  promoted to a rule. It was never checked, because the fixture sets that
  same value.
- **`parameters.VERSION` is `8.06` across two quite different schemas.**
  The client B files have nine more unit columns and seven more tables
  than the client A ones. `PRAGMA table_info` discovery absorbed all of it.
- **`sdltm.fixture.ts` gets the schema wrong in six places**, including
  `tm_id` where every real file has `translation_memory_id`. That is
  §8a.2's lesson a second time: a fixture that agrees with the code
  cannot catch a mistake in either.
- **`fuzzy_data` and the newer token blobs hold no recoverable text.**
  This answers §8a.2's open question. **`resources.data` does**: it is
  plain XML in the newer files. And user names sit in plain text on
  every unit. The scrub used so far rewrote neither, so pseudonymising
  a real `.sdltm` into `fixtures/` (#13a's plan) is now an open question,
  not a pending step. The alternative is to copy the real schemas
  verbatim and fill them with synthetic rows.

Nothing was imported and no code changed. The probe and scrub scripts
stay out of the repository, as the DOCX scrub does. The follow-through
(drop the guard, correct the fixture, then the real-file run) is tracked
on issue #26.

*What this was never checked against, closed anyway (2026-09-15):* **no
real `.sdltm` has been through this path.** Everything above is exercised
against synthetic databases from `db/tm/sdltm.fixture.ts` (excluded from
the build via `*.fixture.ts`), which is this project's belief about Studio
8.06's schema written as executable DDL — it cannot falsify itself, and
the schema came from *one* sample file. #18's own lesson is that the
interesting failures appear only on a real file, and the two criteria that
would catch a misread schema — unit count against a real
`translation_memories.tucount`, and `CanHide` visibility against real
tagged content — are exactly the two never exercised on one. Read that as
a live warning rather than a to-do: the first person to point this
importer at a real Trados memory should expect to be surprised, and
backlog #13a's two real EN↔KO/EN↔VI memories, pseudonymised into
`fixtures/` the way `fixtures/docx/` was, are the material for doing it
properly.

**#19 · ~~Exact matcher + pre-translate~~ · DONE — `core/tm/pretranslate.ts`
+ `db/project/pretranslate.ts`**
Split the way #18 was: `core/tm/pretranslate.ts`'s `placeMatch` is the
pure placement decision (no DB), `db/project/pretranslate.ts`'s
`pretranslate(db, {fileId?})` is the orchestration — `tm_ref` priority
order, the cross-TM query, walking segments, writing the result, all in
one transaction.

**`placeMatch` turned out to already be built, in two pieces, before this
item started:** spec §6.1 step 3's "tag multiset of the TM hit's source
equals the segment's source" is exactly what `remapTmTokens` (#15c)
already checks — matching the *retrieved match's* tag kinds against the
*receiving segment's own source* by `(kind, order)`, not some separate
multiset comparison against a stored "TM hit's source" that doesn't
exist as queryable data (§4's `plain`/`hash` deliberately drop tags).
When it succeeds → `tm_exact`/`translated`. When it refuses (a genuine
count mismatch) → the fallback `mapping.ts` already documented for this
exact situation: the match's plain text, tags dropped entirely, never a
guessed placement → `tm_exact_tagdiff`/`draft` plus a `tag.missing` QA
warning (severity `warning`, per spec, not `tag.missing`'s usual
`DEFAULT_SEVERITY` of `error` — a call site is free to say what actually
happened here). "Re-tagged by position where unambiguous" in the spec's
prose turned out to already be settled more conservatively in
`mapping.ts`'s own docstring (written alongside `remapTmTokens`): drop
all tags on any mismatch, never partially guess. Followed that, not the
looser prose — the settled decision predates this item and a
partial-remap heuristic risks exactly the tag-invalid output the
invariant list forbids.

**Internal propagation reuses the identical placement path** — a
confirmed donor segment's target (`toTmTokens`'d against *its own*
format table) is placed onto the receiving segment exactly like a TM
hit is, including the same tagdiff/QA fallback. Runs only as a fallback
*after* the TM-priority pass finds nothing for a segment (spec's own
step ordering, 1-3 then 4); donors are frozen from already-`confirmed`
segments before any write in this run, so a segment this same run
pre-translates is never itself eligible as a donor later in the same
run — only a hash a translator had already confirmed counts. Donors are
drawn from the whole project regardless of an optional `fileId` filter
on candidates (spec says "the project", not "the file").

**Cross-TM querying needed `retrievePair` to run against an `ATTACH`ed
alias, not just a `.ctm`'s own connection** — `tm-refs.ts`'s own
comment already flagged this as #19's job when `attachTms` was built.
Generalised via a `RetrieveOptions { schema? }` third argument (matching
the `(db, params, options)` shape `glossary/terms.ts`'s `findRendering`
already established for the identical problem on `.ctg`), rather than a
separate cross-schema query — one join, written once. The alias
validation the glossary side already had (`qualify`/`ALIAS`) is now
`db/schema-alias.ts`'s `qualifySchema`/`SchemaAliasError`, shared by
both rather than kept as two copies of the same four lines — exactly
the "one definition, always imported" rule this was about to violate a
second time.

Idempotent by construction: a rerun recomputes the same match and
overwrites with the same result; `replaceQaIssues`'s own wholesale-
per-segment contract means a since-resolved tagdiff warning disappears
on rerun too, not just a fresh one appearing. Never touches a confirmed
or locked segment — `isProtectedFromPretranslate` (already existed on
`Segment`, unused until now) filters candidates before `setSegmentTarget`
is ever called, which is a stricter gate than `setSegmentTarget`'s own
refusal (only on the `locked` flag, not `status === 'confirmed'`).

19 new tests across `core`/`db` (5 for `placeMatch`, 10 for
`pretranslate`, 3 for the new shared `schema-alias.ts`, 1 more for
`retrievePair`'s schema path), built against real fixture DOCX files
(`form-minimal.docx`) rather than synthetic tokens — `fixtures/docx/`
continuing to pay for itself here too. Full gate green.

**#20 · ~~Write-back on confirm~~ · DONE — `db/tm/write.ts`
+ `db/project/confirm.ts`**
Upsert into the write-target TM; undo rolls back in the same transaction
(spec §6.2).

`core/tm/context.ts` gained `confirmedTargetContext`, alongside the
existing `sourceDocumentContext`: source-side context (#17a) chains over
every sibling's `sourceHash` regardless of status, but target-side
context can only chain over segments whose target is actually final, so
it filters to `status === 'confirmed'` — plus the segment currently
being confirmed, which is still `translated` in the DB at the moment its
own context is computed. Deliberately does **not** retroactively patch
an already-written neighbor's `prev_hash`/`next_hash` when a nearby
segment is confirmed later — context is captured once, at write time,
matching the "captured once" philosophy already established for
source-side context in #17a. Covered by `confirm.test.ts`.

`db/tm/write.ts` is the one real (non-test) place outside `db/project/
confirm.ts` that inserts or updates a `tu`/`tuv` row — every `*.test.ts`
file's own `insertTu` helper is a fixture, not a write path.
`writeBack(db, params, options)` upserts source and target together as
one transaction, keyed on the source variant's `(lang, hash)` (matching
`retrievePair`/`findRendering`'s `(db, params, { schema? })` shape); the
`tu` is reused whenever that source has already been seen in any
language, never flattened to a fixed source/target pair, per the
multilingual `tu`/`tuv` model. Quality is `QUALITY.confirmed` and never
lowers an existing value (spec §6: "re-confirming something already
reviewed leaves it reviewed") — written here as a private
`CONFIRMED_QUALITY = 2` at first, folded into `schema.ts`'s one copy of
§6's table once #18b's importers turned out to have spelled the same
row out separately.

Two ambiguous phrases in spec §6.2 needed resolving in code, not just
in prose:
- *"keeps the old one only if the two differ in tags"* — `tagsMatch`
  (`core/model/tags.ts`) compares by raw token id, which only works
  when both sides share an origin (a segment's own source vs. target
  from one tokenization pass). Two independently-renumbered `TmToken[]`
  streams have no such shared origin, so `write.ts` has its own
  `tagKindMultisetsEqual`, comparing by `TagKind` counts instead — the
  question is "did the *kind* of markup change", not "do the ids line
  up". A history row is written to `tuv_history` only when the multiset
  actually differs.
- *"undo rolls back in the same transaction"* — read as describing the
  atomicity `confirmSegment` itself must have (the `tuv` writes and the
  segment's status flip commit or fail together), not a request to
  build a separate undo/unconfirm feature. Verified with a
  `db.prepare` monkey-patch that fails the second `INSERT INTO tuv` and
  asserts nothing committed.

`refreshLangs` (recomputing `tm.langs` from what `tuv` actually
contains) existed once already inside `import-tmx.ts` (#18); rather than
let `write.ts` grow a second copy, it moved to `write.ts` as a shared,
schema-qualified export and `import-tmx.ts` now imports it — the same
"one definition, always imported" call as `qualifySchema` in #19.

`db/project/confirm.ts`'s `confirmSegment(db, segmentId, options?)` is
the actual call site: validates the segment has target tokens and isn't
locked, resolves the enabled write-target `tm_ref`
(`listTmRefs(...).find(r => r.isWriteTarget && r.enabled)`), attaches it
before opening a transaction (SQLite forbids `ATTACH` inside one),
computes both context maps from the file's sibling segments, then runs
`writeBack` and `setSegmentTarget(..., { status: 'confirmed' })` as one
transaction — origin is left untouched; confirm only changes status.
Throws `ConfirmError` for every precondition failure (no target, locked,
no write-target TM configured, no project identity, unknown segment)
rather than a generic error, so callers can distinguish "nothing to
confirm" from "misconfigured project".

37 new tests across `core`/`db` (5 for `confirmedTargetContext`, 12 for
`writeBack`/`refreshLangs`, 11 for `confirmSegment`, plus the moved
`refreshLangs` coverage), the `confirmSegment` tests built against a
real fixture DOCX (`form-minimal.docx`) rather than synthetic tokens.
Full gate green.

**#21 · ~~TMX export~~ · DONE — `core/tm/tmx.ts` (`serializeTmx`) +
`db/tm/export-tmx.ts`**
Per format spec §8, with `x-catm-*` props carrying uuid, rev, quality and
context so our own roundtrip is lossless. Optional language filter;
default exports every language in the memory.
*Done when:* an exported TMX imports cleanly into Trados with tags intact,
**and** re-importing it here restores context and quality. Trados
roundtrip is the acceptance test, not schema validity.

`core/tm/tmx.ts` gained `serializeTmx`/`TmxExportDoc`/`isoToTmxDate`
alongside the existing `parseTmx` — the inverse walk, in the same file,
since it's the same narrow job in the other direction: turn a `.ctm`
shape into TMX text, with nothing DB-specific in it. Several
implementation decisions the format spec's export table left open were
settled and written into `tm-format-spec.md` §8 before coding against
them, per this file's own "spec before code" rule:

- `<header srclang>` has no natural single-language value for a
  multilingual memory — exported as the `srclang="*all*"` convention
  several TMX consumers already recognise, rather than picking one
  language arbitrarily.
- `tu_attr`'s `tuid` and `note` keys are not ordinary `<prop>`s on
  export — they become `<tu tuid>` and a `<note>` child respectively,
  mirroring the special-casing `parseTmx` already does reading them the
  other way. Every other key (reserved keys like `client` included)
  becomes a plain `<prop type="{key}">`, since import's
  `mapReservedProp` already recognises the bare (no `x-` prefix) form
  on the way back in — no extra mapping needed for a lossless
  round-trip.
- `<bpt i>`/`<ept i>` reuse the `TmToken`'s own numeric `id` directly
  for TMX's `i` correlation attribute; `<ph>` gets no `i`/`x` at all,
  since import already assigns placeholder ids locally in document
  order rather than reading one back — nothing is lost by leaving it
  off.
- `tuv` has no `created_by` column (only `updated_by`), a pre-existing
  asymmetry (§2.3) — so an exported variant's `creationid` and
  `changeid` are both that one stored value. Reimporting is idempotent
  either way (`changeid` wins when both are present).
- A `tu` left with zero variants after a language filter is omitted
  from the export entirely, never written as a `<tu>` with no `<tuv>` —
  the same shape `parseTmx` already refuses on the way in.

`db/tm/export-tmx.ts`'s `exportTmx(db, options?)` mirrors
`import-tmx.ts`'s split: it is the one place `tu`/`tuv`/`tu_attr` rows
become a `TmxExportDoc` to hand `serializeTmx`, with no format
knowledge of its own. Reads only — no transaction needed. Excludes
tombstoned (`deleted = 1`) units and, per `tuv`'s own schema, only ever
sees the current revision of each variant (`tuv_history` isn't queried,
matching the spec's lossy table).

43 new tests (36 for `serializeTmx`/`isoToTmxDate` in `core`, purely
structural — building a `TmxExportDoc` by hand and asserting on the XML
and on re-parsing it; 7 for `exportTmx` in `db`, each round-tripping a
real `writeBack`/`importTmx`-populated `.ctm` through export and back
into a *fresh* file via `importTmx`, checking uuid, quality,
prev_hash/next_hash, tag structure, the multilingual `tu` reuse, the
language filter, and `tu_attr`'s three export shapes all survive).
Full gate green. Not validated against a real Trados import in this
session — that half of the "done when" acceptance test is still open,
same caveat `tm-format-spec.md`'s "no committed TM-format corpus yet"
section already flags for #18.

**#22 · ~~QA engine + tag rules~~ · DONE — `core/qa/rules.ts`
+ `db/project/qa-issues.ts` + `db/project/qa-settings.ts`**
Rule registry, per-project switches, persisted dismissals. Implements
`tag.missing`, `tag.extra`, `tag.unbalanced` — the other nine rules in
spec §6.4's table (`seg.*`, `consistency.*`, `num.*`, `punct.*`) are
backlog `#23`/`#24`, plugging into the same registry rather than a
second one.

Split the way every other core/db pair in this project is: `core/qa/
rules.ts`'s `QaCheck`s are pure — tokens in, `QaFinding[]` out, no DB —
built entirely on predicates `#4`/`#9` already proved corpus-wide
(`missingTags`/`extraTags`/`validateTagStructure`, `core/model/tags.ts`).
`db/project/qa-issues.ts`'s `runQaRules(db, segmentId)` is the only new
orchestration: load the segment, run the registry against its enabled
rules, persist via `replaceQaIssues`.

**One finding per rule per segment, not one per tag id.** `qa_issue` has
no column for "which occurrence," and the future QA panel (`#33`) filters
and jumps by rule. `tag.missing`/`tag.extra` each aggregate every
offending id into one message (`"Missing tags: 1, 2"`); `tag.unbalanced`
aggregates every structural error the same way. This also makes
dismissal-by-rule (below) mean something: dismissing "tag.missing"
dismisses the segment's tag problem, not one of several near-duplicate
rows.

**`tag.unbalanced` checks the target only, never the source.** Checking
source would be dead code — `assembleFile`'s own corpus-wide invariant
(`#9`) guarantees every source tokenises validly, so no real input could
ever fail that check. A target *can* still go bad: `setSegmentTarget`
(`#16`) writes whatever tokens it is given with no structural validation
of its own. `tag.unbalanced` is the QA-time backstop for exactly that
gap — distinct from `renderTokens`'s export-time rejection (`#10`), which
only ever sees a target after this rule has already had the chance to
flag it.

**Persisted dismissals turned out to need a real design decision, not
just a boolean column.** `replaceQaIssues` (`#16`) already existed and
is explicitly wholesale-not-diffed ("stale issues never linger") — but
naively wholesale also means a dismissal evaporates the moment the same
rule fires again, which happens on every confirm once QA runs there.
Fixed by keying the carry-forward on `rule` alone, not `message`: before
deleting a segment's old issues, note which *rules* were dismissed, then
re-apply `dismissed = true` to any fresh finding whose rule matches, even
though its message (which ids, which structural errors) may have
changed. A rule that stops firing still loses its dismissal along with
the issue itself — there was never a separate "dismissal record"
independent of a live issue to preserve. Existing callers (`#19`'s
pretranslate tagdiff insert) are unaffected: neither of `replaceQaIssues`'s
two original tests dismissed anything before rerunning, and three new
ones now lock the carry-forward behaviour down directly.

**Per-project switches are absence-based, not a seeded row per rule.**
`qa_rule_setting` (project schema migration v3) only ever holds a row for
a rule someone has explicitly turned *off*; a rule with no row is
enabled. `QA_RULES` gaining a member later — `#23`/`#24` will do exactly
this — needs no migration to make it on-by-default for every existing
project, the same reasoning `origin`'s missing CHECK constraint already
documents for itself in `schema.ts`, applied to a table instead of a
column.

23 new tests (12 core, 11 db) plus one existing enumerated-tables test
updated for the new `qa_rule_setting` table. Full gate green, including
`test:gate` (nothing under `docx/` changed, run anyway).

**#23 · ~~Empty, untranslated, consistency rules~~ · DONE — `core/qa/rules.ts`
+ `db/project/qa-issues.ts` + `db/project/qa-untranslated-allowlist.ts`
(new) + `db/project/schema.ts` migration v4**

Implements the remaining four of #22's nine deferred rules:
`seg.empty`, `seg.untranslated`, `consistency.target_differs`,
`consistency.source_differs` — `num.*`/`punct.*` stay backlog #24. Plugs
into the same `QA_CHECKS` registry and `runQaRules` orchestration #22
built, not a second one.

**Design decision (spec-before-code, 2026-09-18):** `consistency.target_differs`
and `consistency.source_differs` need project-wide context — every other
segment's `source_hash`/target text, not just the one segment's own
`{source, target}` `QaCheckContext` carries today. Chosen approach: widen
`QaCheckContext` with **optional** fields rather than inventing a second,
project-scoped check shape/registry:

```ts
export interface QaCheckContext {
  readonly source: readonly AnyToken[];
  readonly target: readonly AnyToken[] | null;
  readonly status?: SegmentStatus;           // seg.empty
  readonly untranslatedAllowed?: boolean;    // seg.untranslated suppression
  readonly siblings?: {                      // consistency.*
    readonly sameSourceOtherTargets: readonly string[];
    readonly sameTargetOtherSources: readonly string[];
  };
}
```

This keeps the existing rule — "each check only destructures what it uses,
existing checks never have to widen their own signature" — true at the
per-check level: `tag.*` checks are untouched, and a check that needs
project context just returns no findings when its field is `undefined`
(e.g. a unit test building a bare `{source, target}` context). A second
registry was rejected: it would fork `runQaChecks`/`QA_CHECKS` into two
call sites for what is still "one finding per rule per segment" against
the same `qa_issue` table, for no isolation benefit — nothing about
`consistency.*` needs a different persistence shape, only richer input.

`db/project/qa-issues.ts` computes `siblings` per call with two plain
queries against `segment` (one by `source_hash`, one full scan comparing
rendered target plain text — there is no target-text index) and decodes
tokens to plain text in JS. This is O(n) per segment, run fresh on every
`runQaRules` call; acceptable at v1's single-translator project scale,
same "wholesale, not diffed" simplicity `replaceQaIssues` already
established. If a future project-wide QA sweep over many thousand
segments makes this the bottleneck, build the index once (map by
`source_hash` and by target text) and reuse it across all segments in
that sweep, rather than adding a project-scoped registry.

**`seg.empty` does not use `SEGMENT_STATUSES`' array order as "≥
translated"**, despite the table's wording. `locked` sorts after
`confirmed` in `SEGMENT_STATUSES` but *means* "not editable — untranslatable
content, or locked by the user" (`model/segment.ts`): a locked segment is
deliberately allowed an empty target. `checkSegEmpty` fires only for
`status === 'translated' || status === 'confirmed'`, an explicit set, not
an ordinal comparison — reading the table literally would make every
locked-and-empty segment (the common untranslatable-content case) a false
positive on every project.

**Per-project allow-list for `seg.untranslated` is keyed by `source_hash`,
not by segment id**, in a new table `qa_untranslated_allowlist
(source_hash TEXT PRIMARY KEY, added_at TEXT NOT NULL)` — project schema
migration v4. Reasoning: the content this suppresses (a brand name, a
code snippet, a segment that is legitimately identical in both languages)
recurs verbatim across a document, and `source_hash` is already the
column that means "this exact normalised source," shared with TM
matching (`tm-format-spec.md` §4) and `pretranslate.ts`'s donor lookup —
allow-listing by segment id would need re-allow-listing every new
occurrence of the same source by hand. This is *presence*-based, the
opposite of `qa_rule_setting`'s absence-based default: a row means
"suppressed," no row means the rule runs normally, since an allow-list
with nothing in it must suppress nothing.

`checkTagExtra`'s existing test fixture (`source: [text('a')], target:
[open(1), text('a'), close(1)]`) needed its target text changed to `'b'`
— once `seg.untranslated` runs alongside `tag.extra` in the same
`runQaChecks(ctx, ALL_RULES)` call, a target that is source-plus-a-tag
is *also* untranslated (same underlying text), which the pre-#23 test
had no way to fire since the rule didn't exist yet. `db/project/qa-
issues.test.ts`'s `breakTargetTags` fixture got the same fix, appending
a differing text token before its tag-breaking one, for the same reason.
Neither is a behaviour change — both fixtures now isolate the tag
findings they were written to test, the same way `checkTagUnbalanced`'s
tests already isolate structural breaks from missing/extra tags.

31 new tests (23 core — four checks plus `runQaChecks` interactions — 8
db: two module tests for `qa-untranslated-allowlist.ts`'s four functions,
plus new `runQaRules` cases for `seg.empty`/locked-suppression,
`seg.untranslated`/allow-list-suppression, and both consistency rules
via directly-inserted sibling segment rows), plus the schema's
enumerated-tables test updated for `qa_untranslated_allowlist`. Full
gate green (656 tests + 73-test `test:gate`, nothing under `docx/`
changed, run anyway).

**#24 · ~~Number and punctuation rules~~ · DONE — `core/qa/rules.ts`
+ `core/qa/numbers.ts` (new) + `core/qa/locale.ts` (new)**

The last six of spec §6.4's rules — `num.missing`, `num.altered`,
`punct.terminal`, `punct.brackets`, `punct.inverted`, `punct.spacing` —
into the same `QA_CHECKS` registry #22 built. Every `QaRule` now has a
check. `QaCheckContext` gained `srcLang`/`tgtLang`, read from the
`project` row in `db/project/qa-issues.ts`'s `runQaRules`; the
locale-aware rules report nothing without them rather than guess.
The decisions themselves are written into `v1-spec.md` §6.4 ("How the
`num.*` and `punct.*` rows are read"), spec-before-code; the short form:
a numeral is matched by surface, then value under each side's *own*
locale, then digits (that last one is `num.altered`), then a
non-consuming components pass before it is `num.missing`; `punct.*`
compares the target's imbalance to the source's rather than judging the
target alone; spacing is a per-target-locale profile with `fr`, `fr-CA`
and `fr-CH` all different.

**The "done when" fixture found a real false positive before it ever
shipped.** Seven EN sentences each with a locale-correct FR, DE and ES
rendering (amounts, percentages, section numbers, dates and times,
quotes, a URL) run against all six rules and must produce nothing. The
first run failed on ES: `https://example.com/?id=42` fired
`punct.inverted` — a `?` with no `¿`. Fixed by counting only runs in
sentence position (followed by whitespace, a closing mark or the end),
the same test `punct.spacing` already used for `10:30` and `http://`.
That is the fixture doing what #23's record asked of it: the wrong
inputs to check are exactly the ones a hand-written unit test never
thinks of.

**Dates were the false positive that design review caught, not the
test.** English `03/12/2025` scans as three numerals; German
`12.03.2025` scans as one, and under German conventions it is not a
number at all (`03` is not a thousands group). Without the components
pass every date in a DE/ES/FR target would have been three `num.missing`
errors — on the most common numeric content in a contract. Two things
recorded as deliberately *not* fixed, so nobody re-litigates them
quietly: a number written in words (`3` → `trois`) and a 12/24-hour time
change both read as `num.missing`; a test documents each.

**The `\uXXXX` rule bit again, the way #39's note said it would — and
the check that catches it is a one-liner worth keeping.** Every escape
in the new sources arrived on disk as the real glyph: U+202F written as
an actual narrow no-break space, `\u00D7` as a bare `×`, curly quotes as
curly quotes. The tests still passed — which is precisely why the rule
exists, since nothing would have told anyone when an editor later folded
them. Caught by listing every non-ASCII byte outside comment lines
(`grep -nP '[^\x00-\x7F]'` on each new file) before the first run,
then re-escaping. Do that on any file that mentions NBSP, thin space or
quotes, whatever wrote it.

103 new tests (core: `numbers.test.ts` for extraction, per-locale
`canonicalValue` and the four matching passes; `rules.test.ts` per rule
plus the 21-case zero-issue fixture, `es-MX` and `de-CH`; db: the
language-pair plumbing and an EN→FR number round trip through
`runQaRules`). Full gate green: 759 tests, 73-test `test:gate` (nothing
under `docx/` changed, run anyway).

**Three follow-ups from the `.ctm` scale benchmark** (`pnpm bench:tm`,
`db/tm/bench/`; results in `tm-format-spec.md` §11, 2026-09-23). The
format held at 5M synthetic units, and the one real memory measured
(86k units, en→es, §11.4) matched the synthetic shapes. What didn't
hold was code that reads or writes the format. It wasn't caught
earlier because every unit test has a dozen rows (CLAUDE.md's
function-around-an-indexed-column gotcha).

**#18c · ~~Streaming TMX import with bounded memory~~ · DONE —
`TmxStreamParser` in `core/tm/tmx.ts`; `importTmxFile`/`listTmImports`
in `db/tm/import-tmx.ts`; `.ctm` format version 2 (`tm_import`)**
`importTmx(db, xml: string)` needed the whole document as one string
and the whole parse tree: 4.1 GiB RSS at 1M units, and a 5M-unit TMX
could not be read at all (V8 caps a string at 2^29 characters). Now
`TmxStreamParser` takes the document in chunks and returns each `<tu>`
as its closing tag arrives. `importTmxFile` reads the file 1 MiB at a
time and commits every 10,000 units. In a process capped at a 2 GB
heap, the 5M-unit file (1,975 MiB) imported with a 288 MiB peak RSS,
and 1M peaked at 243 MiB. Memory no longer grows with the file. Time
did: 12–17% slower than one transaction or 50k slices, from the extra
commits, and untuned (tm-format-spec.md §11.2 has the table).
`parseTmx` is now one push into the stream parser, so there is one
TMX reader, not two, and `add-tm` streams.

**§12.4's question, answered: an import may be incomplete; a merge may
not.** §7's all-or-nothing protects a merge, whose half-applied state
would be inconsistent. An import only appends, and every batch ends on
a unit boundary, so an interrupted one leaves a *prefix*: whole units,
consistent, just not all of them. The danger is not knowing that, so
`.ctm` gained a `tm_import` table (schema v2, through the shared
runner; a v1 file upgrades with a backup on open). An unfinished run
has `finished_at IS NULL` and `units_done` says how far it got. That
count is also the resume point. Resuming re-parses and skips that many
units, which is independent of encoding and chunking, where a byte
offset would not be. A resume against a file of a different size is
refused. One transaction would also have held the write lock for 38
minutes, grown the WAL by a whole memory's worth of disk, and lost
everything on a crash. `importTmx(db, xml)` stays the single-batch,
all-or-nothing case. `.sdltm` import is still one transaction.
`add-tm` keeps an interrupted memory, says so, and running the same
command again resumes it. The CLI test checks both halves with a
20,000-unit file.

**Three things only the streaming reader forced into the open:**
- *A parse error in a chunk loses that chunk's earlier units.* Nothing
  is lost for good: they were never committed, and a resume re-reads
  them. But the first test of it, with one small file arriving as a
  single chunk, expected two committed units and found none. The test
  now uses 64-byte chunks, as a real file would arrive.
- *`<body>` may hold `<tu>` and comments, nothing else.* The tree
  parser silently skipped any other element there. A streaming reader
  cannot skip an element it does not know without parsing it, and a
  silently skipped element could be a lost unit, so it is a `TmxError`
  now.
- *Every per-occurrence warning had to become a tally*, the CLAUDE.md
  gotcha again, at a scale where it is a memory bug and not just a
  noisy report. A bad `xml:lang` was one string per variant, and a
  reused uuid one per unit. Held until the end of a 5M-unit import,
  that is tens of millions of strings. Both now report once per cause,
  with a count.

The resume guard catches a changed size, never changed content of the
same size. That trade is recorded in §2.9. Hashing the file first
would cost another full read before every import. The test suite
found the guard's value on its own: the CLI test's "fixed" file was
first written one byte short, and the guard refused it.

**#19a · ~~Make exact lookup seek the `(lang, hash)` index~~ · DONE —
`db/lang-match.ts` (`matchingLangs`), used by `db/tm/retrieve.ts` and
`db/glossary/terms.ts`**
`retrievePair`'s `primary_subtag(s.lang) = …` scanned all of `tuv` on
every lookup: 1.7 s at 1M units, 214 ms on the real 86k memory. Both it
and `findRendering` now match `lang IN (…)` over the stored tags whose
primary subtag matches, and both plans are `SEARCH`: 0.16 ms p50 /
0.33 ms p99 at 1M in `pnpm bench:tm --sizes 1000000`
(tm-format-spec.md §11.2 has the note). `ensurePrimarySubtagFn` moved
into the same module — it was a TM function the glossary reached into.

**The rewrite that was measured was not the one that shipped, on
purpose.** The bench's candidate read the language list from
`tm.langs` and ran in 0.03 ms. But `tm.langs` is a projection the write
paths maintain, and #20a is about to rework how. A lookup that trusted
it would silently return nothing for any language a stale projection
left out, and no test of the lookup would notice, since every one
inserts rows directly. So `matchingLangs` reads the distinct tags off
the index itself with a recursive loose index scan (one seek per
language). It costs about 0.13 ms more and can't disagree with the
table. A test sets `tm.langs`/`glossary.langs` to `[]` and still finds
the match. The bench keeps the `tm.langs` column for comparison.

**The plan is the only thing a dozen-row test can see**, so it is now
under test. `query-plan.fixture.ts` records every statement a
repository call runs with its bound parameters and returns
`EXPLAIN QUERY PLAN` for each. Tests assert the `(lang, hash)` seek
(own file and `ATTACH`ed), the `(lang, plain)` seek, and no `SCAN` of
any table or alias; both fail against the old query. SQLite picks
`tuv_ctx` over `tuv_lookup` without statistics, since both lead with
`(lang, hash)`, so the assertion accepts either.

**#20a · ~~Stop `refreshLangs` scanning `tuv` on every confirm~~ · DONE —
`distinctLangs` in `db/lang-match.ts`, used by `db/tm/write.ts`'s
`refreshLangs`**
`writeBack` recomputed `tm.langs` with `SELECT DISTINCT lang FROM tuv`
on every confirm, which read the whole `tuv_lookup` index: 247 ms at 1M
units, 1.3 s at 5M. `tm.langs` is still a projection recomputed from
`tuv` on every write (§2.1). Only the read changed: it is now the same
loose index scan #19a built for lookups, factored out of
`matchingLangs` as `distinctLangs`, one seek per language. In
`pnpm bench:tm --sizes 1000000`, `writeBack` went from 247 ms to 1.1 ms
p50 and from 314 ms to 25 ms p99. The importers call `refreshLangs`
too, so they get the same saving once per import.

**The p99 is not zero, and it isn't this.** 25 ms at p99 against 1.1 ms
at p50 is a tail, but the new plan reads `tuv` by `SEARCH` only, and a
test pins that (it fails on the old query's
`SCAN tuv USING COVERING INDEX tuv_lookup`). The tail wasn't profiled.
A WAL checkpoint landing on a confirm is the likeliest cause, and that
is a question for the editor's autosave (#31), not for `refreshLangs`.

Two more `refreshLangs` tests pin the ordering contract. The projection
equals `SELECT DISTINCT lang … ORDER BY lang` exactly, including
case-distinct tags (`EN` sorts before `de` under binary collation),
and an empty memory writes `[]`.

---

## Epic 5 — CLI *(the harness that proves it all)*

**#25 · ~~CLI: project + import + pretranslate + export~~ · DONE —
`@cat-tool/cli` (`packages/cli`) + `core/project/export.ts` +
`db/project/export.ts`**
`init`, `add-file`, `add-tm`, `pretranslate`, `qa`, `export`; design in
`v1-spec.md` §2.4, the export fold rule in §3.4. A full job runs
headless with no UI in the loop — `cli.test.ts` drives one through
`runCli` (init → add-file → add-tm from a TMX → add-tm creating the
write target → pretranslate → qa → export) against a real fixture,
without spawning a process, and the built binary was smoke-run the
same way by hand.

**The gap the "harness that proves it all" was meant to find: nothing
anywhere could turn a project file back into a DOCX.** `exportDocx`
(#8) took replacements keyed by part and region; `assembleFile` (#16)
cut regions into sentence-level segments; no code produced the one
from the other. `core/project/export.ts` (`foldSegments`,
`exportProjectFile`) is that step — the mirror of `assembleFile`, in
the same `project/` layer for the same reason (it needs `segment/`'s
fold and `docx/`'s render, and neither may import the other in that
direction). The rule it settles, now in §3.4: a paragraph none of whose
segments has a target is *not rendered at all* — its original region
XML is spliced back by `renderSkeleton`'s default; otherwise every
segment contributes its target (whatever its status) or its source
over its own format table, folded in `para_ord` order with
`mergeSegments(a, b, { separator: ' ' })` — the fold `edit.test.ts`
already proved over the corpus — and rendered with `renderTokens`. The
first half is what makes an untranslated project export reproduce the
source part for part through the database; checked on three fixtures
including `footnotes-manuscript` and `fields-textboxes` (a nested text
box survives because the drawing is a `ph` whose XML still carries the
child's marker). The separator only fires where neither side brings
boundary whitespace, which is exactly the asymmetry between the two
kinds of piece: a source piece after the first carries the
inter-sentence space the segmenter left on it, a target never does.

`toDocPart` had to gain an inverse — a stored `'header3'` has to find
`word/header3.xml`'s skeleton again — so both directions moved out of
`assemble.ts` into `core/project/parts.ts`, one definition of the
mapping rather than a table and its mirror image drifting apart.

Smaller things the harness settled:
- **Whole-file SHA differs while every part is byte-identical.** The
  zip container is rewritten on export, as it is in the gate itself;
  the gate's per-part comparison is the contract, and the CLI test
  compares the same way. Don't "fix" this by trying to reproduce the
  container.
- **`qa`'s exit status is `isBlocking`** (`core/model/qa.ts`, severity
  `error` and not dismissed) — existed since #4, unused until now.
  That is what lets a script chain `pretranslate`, `qa`, `export` and
  stop where a translator would.
- **`add-tm` takes `.ctm`, `.tmx` or `.sdltm`**, creating an empty
  `.ctm` for a path that doesn't exist yet (the natural way to get a
  write target for a new job) and importing the other two into a
  sibling `.ctm` it refuses to overwrite. A failed import removes the
  half-made `.ctm` again, or the retry would be refused as "already
  exists". Priority defaults to after every memory already attached, so
  `add-tm` order is consultation order. Paths are stored absolute:
  pre-translate re-attaches by them from wherever it later runs.
- **Every command but `init` opens the project through a guard**:
  `openProjectDb` happily creates an empty database at a mistyped path,
  which is the wrong answer to `cat-tool qa projcet.catdb`.
- **No CLI framework** — `node:util`'s `parseArgs`, strict, unknown
  options refused. Six subcommands did not justify the first
  non-workspace dependency outside `fflate` and `better-sqlite3`.
- **Not `confirm`.** Confirming is the translator's act on a segment
  they have read — the editor's (§7). A CLI that confirmed everything
  pre-translate produced would write unreviewed targets into the
  memory, exactly what §6.2's write-back is not for.

Noticed in passing, not fixed here: issue #2 (backlog #13a) says
`rulesFor('ko')` and `rulesFor('vi')` throw, but `LANGUAGE_RULES` has
had `ko` and `vi` entries for a while — the "unsupported language"
test here had to use `ja` to find a language `rulesFor` still refuses.
The card's "done when" may already be partly met; worth checking
before it is picked up.

29 new tests (7 `parts`, 8 `export` in `core`; 3 `exportFile` in `db`;
11 through `runCli`). Full gate green, including the roundtrip gate.

**#26 · ~~Golden end-to-end test~~ · DONE — `cli/golden.test.ts` +
`fixtures/golden/`, its own CI job (`pnpm test:golden`)**
Real DOCX + memory → pre-translate → review → export, against a
committed transcript. `prose-short.docx` (the corpus's plain-prose
baseline, with Word's real run fragmentation: nearly every sentence
inside a pair of invisible run tags, one carrying ten) and a
Trados-shaped TMX of its own sentences in German go through every CLI
command in script order; everything the job prints — stdout, stderr,
exit codes — plus the text of every segment of the delivered document
is compared to `prose-short.en-de.expected.txt` byte for byte, and
every part the job did not translate is asserted byte-identical to the
source. Design in `v1-spec.md` §2.4; what each unit of the memory is
there to exercise is in `fixtures/golden/README.md`.

**A golden file, not a list of `expect`s, on purpose.** The gate (#8)
asks one question with one answer. This job's answer is a page of
output, and the interesting regressions are the ones nobody thought to
assert on — a summary count shifting, a warning appearing, a paragraph
folding differently. A transcript catches all of them and turns each
into a diff to read; `UPDATE_GOLDEN=1 pnpm test:golden` regenerates
it, and the diff is the review. Paths are normalised (`<job>`,
`<repo>`, `/`) so the file is the same on every OS. Excluded from
`pnpm test` like the gate, with the same positional-filter script
shape and its own CI job (Linux only — the check matrix already runs
the CLI's own suite on three platforms, and the comparison has no
platform-specific half).

**The review step is the half the CLI deliberately lacks.** Pre-translate
leaves two things for a human here, and both are done through the
repository, not a command: the tag-diff draft gets its tag reapplied
and is confirmed (`confirmSegment`, which writes it into the job's
write-target `.ctm` — asserted, one unit), and one false positive is
dismissed. `qa` then exits 0, with the dismissed finding still listed
as `(dismissed)` — the first end-to-end proof that #22's dismissal
carry-forward holds through a real rerun.

What the first run found:
- **`punct.terminal` did not know German closes a quote with `“`.** The
  trailing-after-terminal class had `”` `’` `»` `›` — the marks that
  close in English and French — so the most tag-dense sentence in the
  file, ending `neu.“`, was reported as having no full stop. Fixed by
  listing every quote mark that closes somewhere (`“` `‘` `«` `‹` too;
  in English they open, and an opener never legitimately trails a
  sentence, so nothing is lost), with the rule's tests extended and
  §6.4 saying so.
- **`(Revelation 21:5)` → `(Offenbarung 21,5)` is `num.missing`**, an
  error. German writes chapter and verse with a comma, and `21,5`
  reads as one decimal number under the `de` format, so its groups
  never enter the components pool — §6.4 reserves that for numerals a
  locale *cannot* read as one number. A real convention hitting a
  deliberate rule; not changed here, since widening the pool to every
  target numeral's groups is a §6.4 decision to make on purpose, not a
  side effect of a test. Kept in the fixture as the dismissal case,
  which is what the product offers for exactly this. Worth a card if it
  recurs on real jobs.
- **A Trados TMX's tags carry no kind hint**, so a unit taken verbatim
  from a Studio export can never place its tags here — every one is a
  tag-diff draft. Expected from #15c's design (`kind` is the only thing
  that survives a move between documents), now visible end to end;
  the fixture keeps one such unit for that path.
- **The transcript's double-space warnings are true positives**: the
  source document has them, the memory kept them, and `punct.spacing`
  judges the target on the target locale's terms alone (§6.4).

Not a real TMX. The German is a hand translation and the Trados shape
is modelled, so this does not close `CLAUDE.md`'s "no committed TM
corpus" gap — #13a still holds the real material that should. The
`fixtures/golden/` README says so in as many words.

1 golden test, 2 more `punct.terminal` cases. Full gate green, roundtrip
gate green, golden green.

---

## Epic 6 — Editor *(gated on #8)*

**Re-scoped 2026-08-30 (v1-spec.md §2 pivot): web service, not Electron.**
#27 becomes the API server; #28–#35 are unchanged, since they describe the
React UI itself, not the shell around it.

**#27 · ~~API server + auth + accounts~~ · DONE — `@cat-tool/server`
(`packages/server`) + `db/platform/accounts.ts` + `core/auth/credentials.ts`**
Fastify, one process: `platform.sqlite` (accounts and sessions) and the
storage volume, `core` and `db` in-process, JSON out. A bearer-session
login gate in front of every `/api/` route but login; projects created,
listed and read, a DOCX imported through `assembleFile` + `insertFile`,
a file's segments served — the surface #28's grid needs first. Routes
and decisions in `v1-spec.md` §2.5; `account_session` in §4.1a.

**The storage root is resolved per session before any path is touched
— by construction.** The card's sentence could have been a check on
every route; it is instead a property of `server/src/storage.ts`: every
path is built from the account's `storage_root` (`u/` + 96 random bits,
minted by `createAccount`, never chosen by a caller) and a project slug
validated against `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, and no
function accepts a path from a request. `../escape`, `a/b`, `dots.catdb`
are 400 before any `join` runs; two accounts may use one project name
and get two files under two roots; a project the account does not have
is 404 whoever else has one by that name. The test that matters asserts
nothing landed outside the root.

**The login is the portal's, not a second one.** `account_session` is
`admin_session` with the account's foreign key, and the four functions
behind both (`hashPassword`/`verifyPassword`, scrypt with a salt per
password; `generateSessionToken`/`hashSessionToken`, 256 random bits
stored as SHA-256; a 30-day TTL) moved from `portal-core` into
`core/auth/credentials.ts`. The alternatives were a second copy — the
drift the single-definition invariant exists to prevent — or the CAT
server depending on the portal product for a hash function, the wrong
direction. `portal-core` re-exports them, so nothing in the portal
changed but an import; `db/portal/admin.ts` and `db/platform/accounts.ts`
are the two stores of the one definition.

Smaller things the server settled:
- **A project is a slug that is also its file's basename**; `title` is
  the human name in the identity row. One `.catdb` per project, opened
  per request and closed after it — a connection cache is a later
  problem with a measurable cause.
- **`countSegments`** is the one thing `db` lacked: a file listing must
  not load every segment's tokens to count them. The route rule from
  the CLI (one repository call, HTTP around it) held everywhere else.
- **One account, seeded by `create-account`, not an endpoint** — the
  portal's `create-admin` reasoning; a second run with another email
  is a second account, additive, as §4.1a promised.
- **Fastify's `decorateRequest` refuses `null` for a non-nullable
  declared type** — `account` is declared `Account | null` and handlers
  read it through `owner(req)`, which is the one place the "behind the
  gate" assumption is written down.
- **Tests need no port.** `app.inject` with a WHATWG `FormData` as the
  multipart payload; `logger: false` keeps the run readable. The
  multipart plugin's own answer to a JSON body on the upload route is
  406, not 400 — asserted as such rather than papered over.
- **The smoke run paid for itself in one command.** `pnpm run
  create-account -- <email> <password>` arrives in the script as
  `['--', email, password]` — pnpm forwards the separator — and the
  first account this server ever made had the email `--`. The script
  now drops a leading `--` and refuses an email without an `@`; the
  gotcha is in `CLAUDE.md`. `portal-server`'s `create-admin` is
  documented with the same invocation and reads its arguments the same
  way — noticed, not fixed here (its area, its card).

Not here: `@cat-tool/web`. It starts with #28, where there is a grid to
show; a login page with nothing behind it would be scaffolding. Also not
here: pre-translate, QA, export and TM routes — #32's management UI is
where they get a caller, and each is one repository call away.

18 new tests (5 accounts, 2 config, 11 through `inject`; the 7 credential
tests moved with their module). Full gate green; the server smoke-run as
a real process with `create-account` then `start`.

**#28 · Virtualised segment grid · L** · [issue #5]
Two columns, status/origin/QA gutter, smooth at 10k+ segments.

**#29 · Tag-aware target editor · L** · [issue #11]
Atomic tag chips, insert-next-tag, tag list, full-tag toggle. Tags never
editable as text.

**#30 · Keyboard model · M** · [issue #6]
Confirm-and-advance, copy source, tag insert, merge/split, filter focus
(spec §7).

**#31 · Autosave · S** · [issue #7]
Debounced per keystroke. No save action; crash costs seconds.

**#32 · Project and TM management UI · M** · [issue #8]
Create project, add files, attach TMs, set priority and write target.

**#33 · QA panel · M** · [issue #9]
Filter by rule and severity, jump to segment, dismiss.

**#34 · Filters and progress · S** · [issue #10]
Status/origin/QA/text filters; segment and word progress.

**#35 · Dark mode and visual pass · M** · [issue #20]
Calm palette, no layout shift when panels open.

---

## Epic 7 — Ship to self

**#36 · Deploy · M** · [issue #21]
One container image (server + built SPA), one deployment target with a
persistent volume for `platform.sqlite`, project `.catdb` files, and
`.cattm` files. HTTPS in front of it. Superseded electron-builder plan
(three-platform installers) — a web service ships once, to one place.

**#37 · 🏁 Real job dogfood · L** · [issue #22]
Translate and deliver one real paid multi-file client job end to end.
*Done when:* delivered without opening Trados. **This is v1 done.**

**#38 · Post-job triage · S** · [issue #23]
Log every friction point from #37. Feeds v1.1 — concordance is the
expected first item.

---

## Sequencing

```
#1 → #2 → #3 ─┬─→ #4 ──────────────────────────┐
              └─→ #5 → #6 → #7 → #8 🚦         │
                                │              │
                #9 → #10 → #11 ─┤              │
                #12 → #13 → #14 ┤              │
   #15 → #15a → #15b/c/d → #16 ─┼──→ #17 → #17a │
                                │      ↓        │
                                │   #18..#24 ───┤
                                └──→ #25 → #26 ─┘
                                              │
                                    #27..#35 ─→ #36 → #37 → #38
```

**#8 is the gate.** If the roundtrip cannot be made to hold on real client
files, the whole approach needs rethinking — and that is much cheaper to
discover in week two than in month three.

**#27 no longer needs Epic 5 (#18–#26) to be a shell around**: it *is*
the shell now, in the sense that the API server is what everything after
#8 eventually runs behind. The dependency graph above is otherwise
unchanged — the web pivot moved *where* #27–#38 run, not what they
depend on.

**Rough total:** ~14 M-equivalents in Epics 1–5 (headless core, CLI-proven)
and ~11 more in Epics 6–7. Solo, part-time around client work, the core is
realistically 7–9 weeks and the editor a similar stretch. The `.ctm`
format work (#15a–d, #17a) adds roughly a week over a plain SQLite store —
paid once, against a file format that then holds years of work.

---

## Epics 8–12 — beyond v1 (2026-08-30, Epic 12 added 2026-09-15)

Everything above (Epics 0–7, #1–#38) is **Ring 0** of
`planning/ai-platform-vision.md` — unchanged in scope, unchanged in
order, still the thing to finish first. What follows it, once Ring 0 is
close to done, is scoped in that document at the level Ring 0 deserved
when it started, not before: a real spec per epic, written when that
epic is next, the way `segmentation-spec.md` was written for #12a–f
rather than upfront for all of v1.

Placeholders only — sizing and issue-level breakdown deliberately
deferred:

- **Epic 8 — AI-assisted translation** (Ring 0.5): TM-first, MT
  fallback, Claude polish + semantic QA. Design constraints already
  fixed by what's failed in every other tool tried (vision doc §3):
  context-aware, inline in the segment flow, never blocking.
- **Epic 9 — Language Provider tools** (Ring 1): vendor/translator
  management, AI-assisted quoting and project setup.
- **Epic 10 — Client-facing** (Ring 2): intake, status, feedback.
- **Epic 11 — Invoicing/payments integration** (Ring 3): provisionally
  hand off to Zoho Books rather than rebuild accounting.
- **Epic 12 — Website localisation** (Ring 4, v2/v3) · [issue #25]: the
  Weglot slot, with the one thing Weglot cannot do — accept a translation
  memory.
  Design constraints and the four deferred decisions are in vision doc
  §3 (Ring 4); the short version is below.

**Epic 12 · Website localisation — why it is on the list at all (recorded 2026-09-15)**

From a loss that has already happened more than once: clients with a
translation memory *here* — years of approved, client-specific wording —
still put their websites through Weglot, because a plugin is what website
translation looks like on the market. Weglot has no TM import. So the
site is machine-translated from zero, the terminology the client already
paid to settle is discarded, and the translator is paid again to
re-approve wording that was already approved in a `.ctm` on this side of
the relationship. The document/website content overlap is not marginal —
product names, boilerplate, legal text, the "about" copy — and it is
thrown away twice, once as MT cost and once as review time.

What makes it cheap here rather than a second product:

- A web page is **one more caller of `retrievePair`** and the
  priority-ordered attached-refs mechanism (client `.ctm` over base
  `.ctm`, client `.ctg` over base). Match tiers, the ICE definition and
  the glossary decision log apply unchanged; nothing in the matcher
  becomes web-specific. This is `core` staying headless paying off the
  same way the desktop→web-service pivot did.
- **HTML is a new filter under the DOCX filter's existing rules.** The
  skeleton-by-slicing invariant is *more* load-bearing here, not less —
  a re-serialized DOM reorders attributes, normalises quoting and
  rewrites void elements, so an untouched page would come back subtly
  different everywhere. An HTML roundtrip gate over real client pages is
  the equivalent of `pnpm test:gate` and is what should prove the epic.
- **`TmToken` carrying only a `kind` hint is what makes a DOCX memory
  usable on HTML at all** — the match renders as today's page's
  `<strong>`, never a run property carried across a format boundary.
  The invariant was written for a 2023 client file; it turns out to be
  the cross-*format* rule too.

Deferred on purpose, to the ring's own design pass: delivery mechanism
(reverse proxy vs. JS snippet vs. CMS plugin — SEO is usually why a
client pays, which argues against the snippet however easy it demos),
stable segment identity across a site redesign, where review happens,
and pricing. Vision doc §3 and §7.6 carry the reasoning. One thing is
settled in advance because the invariant already settled it: a URL-,
DOM-path- or selector-derived value **never** goes in
`prev_hash`/`next_hash` — that is the `.sdltm` mistake — it goes in
`tu_attr` as provenance.

Carded as [issue #25] so the reasoning has somewhere to live, but still
unsized and still a placeholder — sizing and an issue-level breakdown
wait for the ring's own design pass, and Ring 0 finishes first. (Epics
8–11 carry no card; this one does because it came out of a live
commercial loss rather than a planned sequence, and the card is where
that stays visible.)

### Epic 10a — Translation Portal v0 (pulled forward, done 2026-09-11)

Not part of the Ring 0/0.5/1/2/3 sequence above — a business need (a
client-facing intake/delivery surface for Optime Services, one pilot
client) pulled forward ahead of Epic 10's real design pass,
which still waits on the pilot client's actual pain points per `ai-platform-vision.md`
§7.2. Full design in `planning/portal-v0-spec.md`.

Shipped: `@cat-tool/portal-core` (pricing, order lifecycle state machine,
notification/production-adapter interfaces — pure TS, tested),
`packages/db/src/portal/` (client/rate/order/file schema and repositories
through the shared migration runner), `@cat-tool/portal-server` (Fastify
API + a deliberately framework-free static UI for both the client and
admin screens). End-to-end flow verified manually: client submits an
order with files -> admin sets word count -> price computes from
configured rates -> client approves -> admin moves to in_progress ->
admin uploads final files and marks delivered -> both notifications fire
(console-logged in v0).

What's manual in v0: actual translation production, word count for every
file type except `.txt` (admin enters it by hand), notification delivery
(console log, not real email). `ProductionAdapter` is a named seam
(`ManualProductionAdapter` today) for the CAT tool to plug into later
without touching the order model, pricing, or status machine — see
`portal-v0-spec.md` §1 and §8.

Not done: a non-Zoho invoicing/payment step, and Epic 10's actual
client-facing design pass. (Real admin auth landed 2026-09-13, below;
client auth is still a bearer link, deliberately — see that update.)

**2026-09-11 update:** real email notifications shipped —
`SmtpNotificationService` (`packages/portal-server/src/notification/smtp.ts`,
via nodemailer) implements `NotificationService` alongside
`ConsoleNotificationService`; `buildApp` picks SMTP automatically when
`PORTAL_SMTP_HOST` is configured, console logging otherwise. See
`portal-v0-spec.md` §5.

**2026-09-13 update:** real admin auth shipped, replacing
`PORTAL_ADMIN_TOKEN`. `admin_user`/`admin_session` (migration v2 in
`packages/db/src/portal/schema.ts`) back a real login: `POST
/api/admin/login` (email + password) returns a bearer session token,
`POST /api/admin/logout` revokes it. Password hashing and session-token
generation/hashing are pure functions in `@cat-tool/portal-core/src/auth.ts`
(`node:crypto` only); `packages/db/src/portal/admin.ts` stores and looks
them up. One admin account is created once via `pnpm --filter
@cat-tool/portal-server run create-admin -- <email> <password>` — still
one admin in practice, just a real account rather than a shared secret.
Client auth (the private-link `access_token`) is unchanged — reasonable
for a single pilot client with no self-serve signup. See
`portal-v0-spec.md` §7.

**2026-09-22 update: file download, so delivery actually happens through
the portal.** Until this, nothing could serve a stored file back: the
admin's delivery upload recorded metadata the client could see the
_name_ of and nothing else, and the "delivered" email pointed at a
portal with nothing to download — so the delivery still went by email,
which §1 says is the thing the portal exists to remove. Now
`GET /api/client/orders/:id/delivered-files/:fileId` (scoped to the
owning client) and `GET /api/admin/orders/:id/{source,delivered}-files/
:fileId`, a client order-detail screen (files, downloads, status
history) and download buttons on the admin's; `portal-v0-spec.md` §6.
Two things this fixed on the way, both worth remembering:

- **v0 stored uploads under the client's own filename** —
  `join('orders', id, 'source', part.filename)`, the exact pattern the
  CAT server's storage rule forbids. Not fixed by sanitising: the
  on-disk name is now server-minted (`mintStoredName`, a uuid) and the
  uploaded name survives only as display metadata, its last path segment
  (`displayFilename`). A `../../escape.txt` upload is a test now, and it
  lands at `orders/<id>/source/<uuid>` like every other file. Same
  reasoning as `qualifySchema` and `projectPath`: a value that never
  becomes a path needs no defence.
- **`portal-server` had no route tests at all** — the end-to-end flow
  above was "verified manually", once. `packages/portal-server/src/
  app.test.ts` now drives submit → price → approve → deliver → download
  through Fastify's `inject`, the CAT server's pattern, and it is where
  the ownership boundary lives as a check rather than a belief: another
  client's order, a stranger's token, and a file id from a different
  order are each asserted to fail. The WHATWG `FormData` serializer
  percent-encodes a `"` in a multipart filename before the route sees
  it, so the quoted-name case lives in `storage.test.ts`, against
  `attachmentDisposition` directly.

Still manual: the word count (the `.txt` auto-count `portal-core` ships
is not yet called by the server), and a client-side cancel.

### Epic 8a — Smart glossary (spec'd 2026-09-14, not started)

Design in `planning/smart-glossary-spec.md`. A term the AI draft renders
inconsistently is detected _after_ drafting, surfaced in a non-blocking
side panel, decided once by the translator, and remembered per client as
an append-only decision log. Ten design decisions recorded in the spec's
§1; two things the codebase forced on top of them in §2 — notably that
the glossary is a `.ctg` file (the `.ctm` shape with the vocabulary
changed, through the shared migration runner, attached to a project with
a priority like a TM), **not** a table in `portal.sqlite`, which is
declared "never translation content".

Split so the headless part does not wait on the editor:

- **#39 · ~~`.ctg` format + repositories~~ · DONE (2026-09-15)** —
  `db/glossary/` (`schema.ts`, `createGlossary`/`openGlossary`,
  `terms.ts`), project schema **migration v2** adding `glossary_ref`,
  `db/project/glossary-refs.ts` with `resolveRendering` across attached
  files by priority, `core/model/glossary.ts` + `core/glossary/key.ts`.
  30 new tests. _Done when_ all proven directly: `CATG` read from byte 68
  with no SQLite involved; a client `.ctg` over a base `.ctg` returns the
  client's rendering and falls through to the base's only when absent;
  `UPDATE`/`DELETE` on `term_decision` raise from a schema trigger, and
  a term with decisions cannot be hard-deleted (no cascade — deliberate).
  Worth remembering:
  - **`term_variant.plain` is case-folded** (`termKey` = `normalizeText`
    + `toLowerCase()`), which segment hashing deliberately is not — a
    glossary that missed every sentence-initial occurrence would be
    useless. Own function in `core/glossary/key.ts`, not a flag on
    `normalizeText`: two different facts. Spec §3.3 updated.
  - **`attachTms`/`detachTms` were generalised** into
    `project/attached-refs.ts` rather than copied — same mechanism,
    two alias schemes (`tm_<id>`, `gl_<id>`). `ensurePrimarySubtagFn` is
    now exported from `tm/retrieve.ts` and shared, so the glossary reads
    never register `primary_subtag` a second time on one connection (the
    `better-sqlite3` gotcha in CLAUDE.md, avoided rather than hit).
  - **A latent bug fixed en route:** `createProject` stamped
    `schema_version: 1` as a literal. The first real migration (this
    one) would have had every new project misreport its own format;
    it now stamps the last migration's version, as `createTm` does.
  - **The CLAUDE.md Unicode gotcha bit once more, in a new way:** the
    ` ` escapes written into the test file arrived on disk as bare
    NBSP glyphs (the tool that wrote the file interpreted the escape),
    and the tests _passed_ that way — the bytes were right, the source
    was the fragile form the gotcha warns about. Caught by checking the
    file's bytes, not by any test; rewritten as literal escapes.
- **#40 · Candidate extraction + flagging · M** · [issue #24] — buildable
  now, deterministic; the aligner is a seam (`TermAligner`), `core` ships
  only the static test implementation.
- **#41 · Session state machine · S** · [issue #12] — buildable now.
- **#42 · `ClaudeTermAligner` · M** · [issue #13] — with Epic 8,
  opt-in gated per `ai-platform-vision.md` §5.
- **#43 · Glossary panel · M** · [issue #14] — after #28–#35.
- **#44 · `term.glossary_mismatch` QA rule · S** · [issue #15] — with
  Epic 8's semantic QA; a project-format migration, since `QA_RULES` is
  a CHECK constraint.

### Epic 9 — Language Provider tools (spec'd 2026-09-22, not started)

Design in `planning/vendor-spec.md`. A vendor is a translator, not a
CRM-style record referenced by a job — the spec's central decision, and
the reason this isn't modelled as a portal-style admin/client split: a
vendor is a first-class `platform.sqlite` account, authorized onto
specific projects via a new `project_authorization` table
(`account_id`, `project_id`, `scope`), and does the actual work in the
real segment editor. No separate lightweight editing surface to build
or keep in sync.

Eleven decisions recorded in the spec's §1, an assignment state machine
in §4 (`offered`/`pool_open`/`claimed`/`accepted`/`declined`/
`in_progress`/`delivered`/`reviewed`, append-only event log, same
pattern as `portal-v0-spec.md`'s `order_event`), and a walked-through
vendor daily flow in §7, anchored on the pain point named directly from
experience across all three roles this product models (owner, vendor,
translator): a job offered with no context — deadline, source material,
or instructions — before the accept/decline decision. Worth carrying
forward once implementation starts:

- **Vendor business data lives in its own file** (`.ctv`, working name),
  through the shared migration runner — not a table in `platform.sqlite`
  (accounts/sessions) or `portal.sqlite` (client-order data, declared
  "never translation content"). Same reasoning as the `.ctg` decision
  for the smart glossary above: a third distinct concern gets a third
  file, not a column stuffed into one of the other two.
- **Rates are tiered by TM match category** (no-match/fuzzy bands/
  100%/ICE), not a flat per-word rate — the real-world standard for how
  translation work is paid, and the reason `db/vendor`'s payable
  calculation has a real cross-package dependency on `db/tm`'s
  `retrievePair` match-tier output, to design for explicitly rather than
  bolt on later.
- **A platform-wide storage question got split off rather than decided
  here.** Whether the product eventually moves off SQLite onto a real
  RDBMS was raised while scoping Vendor's data needs, but touches
  standing invariants (the migration runner, `ATTACH`-based cross-file
  queries, `.ctm`/`.ctg` portability) well beyond this epic. Tracked
  separately in `planning/storage-architecture.md`; Vendor proceeds on
  SQLite regardless of how or when that's resolved.

Broken into sized issues 2026-09-23, split the same way Epic 8a was so
the headless part doesn't wait on Epic 6's editor UI — none of backlog
`#28`–`#35` has shipped yet, so there is no authenticated UI shell for
any of this to render into until those land:

- **#45 · Account role + `project_authorization` model · M** ·
  [issue #17] — foundational, everything else depends on it; also where
  spec §3's `scope` vocabulary question (beyond `owner`/
  `assigned_translator`) gets settled.
- **#46 · `.ctv` format + `db/vendor` profile repositories · M** ·
  [issue #18] — mirrors `#39`; versioned rate history so a later rate
  change can't retroactively alter a past delivered job's payable.
- **#47 · `vendor-core`: assignment lifecycle state machine · S** ·
  [issue #27] — pure TS, no DB, same discipline as `core`/`portal-core`.
- **#48 · Assignment repositories + offer/pool/claim/accept/decline
  routes · M** · [issue #19] — concurrency-safe pool claim (spec §7);
  where §3/§6's `vendor-server`-vs-routes-on-`@cat-tool/server` question
  gets decided, once the route count here plus `#50`/`#51` is known.
- **#49 · Tiered rate/payable calculation · M** · [issue #28] —
  `db/vendor` reading `db/tm`'s `retrievePair` output, the cross-package
  dependency spec §1 decision 9 calls out explicitly.
- **#50 · Vendor-facing API: job feed, offer detail, accept/decline/
  claim · S** · [issue #29] — JSON only; the UI for it is `#52`.
- **#51 · PM-facing API: assign vendor, review/close assignment · S** ·
  [issue #30] — where spec §4's `reviewed` gate (QA `isBlocking`, PM
  read, or both) gets decided for real.
- **#52 · Job feed + offer detail screens · M** · [issue #31] — after
  `#28`–`#35`, the same gating the glossary panel (`#43`) got.
- **#53 · Running payable total in the editor · M** · [issue #32] —
  after `#28`–`#35` and `#49`.
- **#54 · Capacity status toggle UI · S** · [issue #33] — after
  `#28`–`#35`.

### Cross-cutting — Auditability (spec'd 2026-09-23, not started)

Design in `planning/audit-spec.md`. Added "from the get-go", ahead of the
epics that need it, for the reason the `.ctm` context columns were: history
not recorded at write time can't be recovered afterwards. Today
`setSegmentTarget` overwrites `target_tokens` with no actor, so every edit
destroys the one before it. That was harmless while one person wrote every
segment. It stops being harmless the moment vendors (Epic 9) and AI drafts
(Epic 8) write into the same project. The decisions worth carrying forward:

- **An append-only `audit_event`, written in the same transaction as the
  change, enforced by triggers**, `term_decision`'s way, not by
  convention. One table shape, defined once in `core/audit/`, in each
  database that needs it (`project.catdb`, `platform.sqlite`,
  `portal.sqlite`). The log lives in the file whose data it describes.
- **The actor is required at the repository API, never defaulted**, and
  it is a different fact from `origin`. An AI engine is never an actor:
  the human who accepted its draft is, and the engine's provenance
  (model, prompt version, input digest) rides in the event. That section
  (spec §4) is a requirement Epic 8's design must meet.
- **Hash-chained from the first row**, because a chain can't be
  retrofitted onto rows written before it. Anchoring the head outside the
  file is deferred.
- **Reads aren't audited; content leaving the system is**: exports,
  downloads, deliveries, and AI requests.

Sized issues:

- ~~**#55 · `core/audit`: actor, event shape, hash chain · S**~~ —
  **DONE** — `packages/core/src/audit/`: `actor.ts` (`parseActor`/
  `formatActor`), `actions.ts` (one action list per database, and
  `AuditDetail`, each action's detail shape), `chain.ts`
  (`chainHash`, `genesisHash`, `verifyAuditChain`). Writing it forced
  the four byte-level choices spec §3 had left open — hex, the decimal
  `application_id` in the genesis, `detail` hashed as the stored string
  rather than a re-serialised object, ids required to ascend — now
  recorded as §3.1, along with the one thing the chain cannot see:
  rows cut from the end. The actor grammar (§2.1) gives each id exactly
  one spelling, since `account:03` beside `account:3` would be two
  actors to every query that groups by actor. The actions are three
  lists rather than one, so a `project.catdb` `CHECK` cannot admit
  `auth.login`.
- ~~**#56 · `audit_event` in `project.catdb` (schema v5), actor required
  on every segment write · M**~~ — **DONE** — the table, its writer and
  its reads live once in `packages/db/src/audit/events.ts`
  (`auditEventDdl`, `appendAuditEvent`, `listEvents`, `listBatch`,
  `verifyAudit`) for `#57`/`#58` to reuse; project schema v5
  (`db/project/schema.ts`) adds it with a `segment.baseline` per
  existing target. `setSegmentTarget`, `confirmSegment`, `pretranslate`,
  `insertFile` and `exportFile` each take a required `AuditActor`
  (`core/audit/actor.ts`), and the compiler found every caller;
  the CLI is `cli:<OS user>` (`cliActor`), the server the session's
  `account:<id>`. CLI `history` and `audit-verify` are one repository
  call each. Three things building it decided (spec §2.4): a write that
  changes nothing records nothing — or every pre-translate re-run would
  log a row per already-matched segment, forever; pre-translate now
  decides every placement before writing, because the parent's counts
  must be in its hashed row before a child can point at it; and the
  genesis reads the file's own `application_id`, so no caller can
  chain against the wrong file type. `history` renders tags by id
  (`{1}`…`{/1}`): in the golden job the only difference between the
  pre-translated draft and the reviewer's fix is a reapplied tag, which
  plain text hid. Left for a follow-up: `project.setting_changed` from
  the settings writes (QA switches, TM/glossary refs), whose `key`
  names are a design of their own.
- ~~**#57 · `audit_event` in `platform.sqlite`; the server passes the
  session's actor into every write · M**~~ — **DONE** — platform schema
  v3 (`db/platform/schema.ts`) adds the shared table. `createAccount`,
  `createAccountSession` and `deleteAccountSession` take a required
  actor and log `account.created`/`auth.login`/`auth.logout` in their
  own transaction. `db/platform/audit.ts` covers the events whose change
  is not a row in this file: `recordFailedLogin`, `recordProjectChange`
  and `recordDownload`. In the server, `sessionActor(req)` is the one
  place a route's actor comes from. The new routes are
  `DELETE /api/projects/:name`, `GET …/files/:id/export` and
  `PUT …/segments/:id`, the last one's edit landing in the project's
  log. A test with a logger attached proves no segment text reaches
  the request log. `create-account` names its OS user through
  `osUserActor` (`db/audit/os-user.ts`), now the CLI's `cliActor` too.
  `attachmentDisposition` moved to `core/delivery/` so both servers
  share it. What building it decided (spec §2.5):
  - **Nothing personal goes in a hashed column.** Erasure can reach
    only `actor_label`, so `account.created` carries no email and a
    failed login never records the email tried.
  - **A failed login's actor is `system:login`, the gate.** Using the
    named account would record the attacker as the victim.
  - **Across two files, the event is written before the effect is
    visible.** A project's file is created or deleted inside the
    platform transaction, after its event, so a failed change rolls the
    event back.
  - **Tokens from a request are shape-checked** (`parseTokens`,
    `core/model/token.ts`) against the segment's format table. A `fmt`
    pointing nowhere is refused; which tags a target uses is QA's to
    flag, not a refusal.
  - `authorization.*` stays unwritten until `#45` exists, and whichever
    lands second adds it.
- ~~**#58 · Portal: actor on `order_event`, append-only triggers, portal
  `audit_event` · S**~~ — **DONE** — portal schema v3
  (`db/portal/schema.ts`) rebuilds `order_event` with a `NOT NULL`
  `actor` and an `actor_label`, backfilled `system:migration`/`NULL`,
  plus `BEFORE UPDATE`/`BEFORE DELETE` triggers. It also adds the shared
  `audit_event`. `createOrder` and `setStatus` take a required actor.
  `createAdminSession` logs `auth.login` in the session's transaction,
  and `insertDeliveredFile` logs `file.delivered` in its row's.
  `db/portal/audit.ts` holds `recordFailedAdminLogin` and
  `recordFileDownload`. In `portal-server`, `adminActor`/`clientActor`
  are the only places a route's actor is built, and the admin gate now
  keeps the session's admin on the request. What building it decided
  (spec §2.6):
  - **`client:` is the client's id, not the order's.** The spec's
    table said "order id", but the private link is
    `client.access_token`, one per client. An order id would give one
    link-holder a different actor on each of their orders: two
    spellings of one principal, the thing §2.1's grammar forbids. The
    actor carries no label, because a name would claim a person the
    link cannot prove.
  - **`order_event` was rebuilt, not `ALTER`ed.** SQLite can only add
    a `NOT NULL` column with a default, and a default would let a
    writer that forgot its actor through. The update trigger permits
    one change, erasing `actor_label` (§5), the same exception
    `audit_event` makes.
  - **A portal file is its own subject** (`source_file` /
    `delivered_file`, row id). The two tables' ids overlap, so an order
    subject plus `file_id` could not say which file left.
  - **A download reads the whole file before sending it.** Streaming
    would mean hashing one read and sending another. With a single
    buffer, the logged digest is exactly the bytes that left. The
    upload cap is 100 MB.
  - A client's view of an order's history drops `actorLabel`: it shows
    who acted (`admin:1`), never an admin's email.

Also binding on work already carded: backlog `#46`/`#48` (`.ctv` rate
history, `assignment_event`) carry an `actor` from their first migration
(spec §8.2).

## Not in this backlog (Epics 0–7)

Fuzzy matching, concordance, termbase, XLIFF/XLSX/PPTX, CJK,
auto-localisation, collaboration. See spec §1.

**No longer true of the product as a whole** — MT, a cloud tier, and
licensing are now Epics 8 and 11 and the commercial horizon in
`ai-platform-vision.md` §2, not permanently excluded. They stay out of
*this* list of epics (0–7) because Ring 0 still finishes first.

<!-- Open backlog items, one GitHub issue each. -->

[issue #1]: https://github.com/louisbaudry/tessera/issues/1
[issue #2]: https://github.com/louisbaudry/tessera/issues/2
[issue #3]: https://github.com/louisbaudry/tessera/issues/3
[issue #4]: https://github.com/louisbaudry/tessera/issues/4
[issue #5]: https://github.com/louisbaudry/tessera/issues/5
[issue #11]: https://github.com/louisbaudry/tessera/issues/11
[issue #6]: https://github.com/louisbaudry/tessera/issues/6
[issue #7]: https://github.com/louisbaudry/tessera/issues/7
[issue #8]: https://github.com/louisbaudry/tessera/issues/8
[issue #9]: https://github.com/louisbaudry/tessera/issues/9
[issue #10]: https://github.com/louisbaudry/tessera/issues/10
[issue #20]: https://github.com/louisbaudry/tessera/issues/20
[issue #21]: https://github.com/louisbaudry/tessera/issues/21
[issue #22]: https://github.com/louisbaudry/tessera/issues/22
[issue #23]: https://github.com/louisbaudry/tessera/issues/23
[issue #24]: https://github.com/louisbaudry/tessera/issues/24
[issue #12]: https://github.com/louisbaudry/tessera/issues/12
[issue #13]: https://github.com/louisbaudry/tessera/issues/13
[issue #14]: https://github.com/louisbaudry/tessera/issues/14
[issue #15]: https://github.com/louisbaudry/tessera/issues/15
[issue #25]: https://github.com/louisbaudry/tessera/issues/25
[issue #36]: https://github.com/louisbaudry/tessera/issues/36
