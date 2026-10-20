# Custom Segmentation — Design Spec

**Status:** draft for review
**Date:** 2026-08-26
**Extends:** `v1-spec.md` §5, `tm-format-spec.md`
**Backlog:** new issues #12a–#12f (see end)

Segmentation rules are currently compile-time constants in
`packages/core/src/segment/rules.ts`. A translator who hits a false break
on a domain abbreviation has no recourse but a code change. This spec
makes rules editable, following the Trados model, with SRX as an
interchange format rather than the internal one.

---

## 1. What the standard actually is

**SRX (Segmentation Rules eXchange)** is the interchange standard.
Version 2.0 was accepted as an OSCAR recommendation in April 2008 and
remains the latest version. LISA, which maintained it, became insolvent in
2011; the specification and schema are now hosted by
[GALA](https://www.gala-global.org/srx-20-april-7-2008). It is also
carried as a Working Draft in **ISO/TC 37/SC 4**, so it is not orphaned,
but it has not moved in a long time.

An SRX rule is a pair of regular expressions plus a verdict:

```xml
<languagerule languagerulename="es">
  <rule break="no">
    <beforebreak>\bSr\.</beforebreak>
    <afterbreak>\s</afterbreak>
  </rule>
  <rule break="yes">
    <beforebreak>[.!?]+</beforebreak>
    <afterbreak>\s+[¿¡A-ZÁÉÍÓÚÑ]</afterbreak>
  </rule>
</languagerule>
```

Rules are ordered and **first match wins**, which is why no-break rules
are written above break rules — the exception has to be reachable before
the general case.

### Support in practice is patchy

| Tool | SRX |
|---|---|
| **Trados Studio** | **None.** Rules live in the TM, not in a file type, so there is no SRX import or export at all |
| memoQ | SRX **1.0**, with separate "for memoQ" and "for other tools" exports |
| Okapi Framework | Native — its segmentation engine *is* SRX |
| OmegaT | None |
| CafeTran | Supported |

**This changes the migration story.** SRX cannot move rules *out of*
Trados, because Trados will not emit it. What Trados does export is its
resource **lists** — variables, abbreviations, ordinal followers — as
plain `.txt`, one item per line, one file per resource type. That is the
practical path for a translator moving off Trados, and it is cheap to
support.

There is also Unicode **UAX #29** (Text Segmentation), a genuinely
maintained standard. It is character-class based and language-neutral,
with no concept of abbreviations, so it breaks `Sr. Gómez` every time.
Useful as a substrate, not as a segmenter.

---

## 2. The Trados model, and what to take from it

Trados splits segmentation into four resources rather than one blob:

| Resource | Purpose |
|---|---|
| **Abbreviations** | A full stop after one of these is punctuation, not a sentence end |
| **Ordinal followers** | Words that may follow an ordinal — if `April` is a follower, `23. April` is a date, not two sentences |
| **Variables** | Product names and similar, passed through untouched |
| **Segmentation rules** | The ordered regex list |

Two decisions worth adopting, one worth improving.

**Adopt: rules live with the memory, not the project.** Leverage is only
meaningful if the query is segmented the way the memory was built. Storing
rules in the TM makes that automatic and makes a match rate reproducible.
Rules therefore belong in `.ctm`, not in the project database.

**Adopt: separate typed lists, not one rule soup.** A translator adding
`Mons.` should be adding a word to a list, not writing a regex. Lists are
what people actually edit; the rule list is the escape hatch.

**Improve: ordinal handling.** Trados looks *forward* — is the next word
in the ordinal-follower list. The current implementation looks *backward*
— is the number preceded by a determiner (`Der 3. Absatz`). Both are
partial:

- Forward alone misses `Der 3. Absatz`, because `Absatz` is not a month.
- Backward alone misses `Es begann 1999. Januar folgte.` — no determiner,
  but `Januar` is still a follower.

Keep both. Forward is what users understand and edit; backward catches
what a follower list cannot enumerate.

**Improve: Trados has no preview.** You write a rule and discover on the
next file whether it was right. Segmenting is cheap here (§6), so the
document can be re-segmented live as a rule is edited.

---

## 3. The model

```ts
/** One user rule. SRX-compatible by construction. */
export interface SegmentationRule {
  /** true = break here, false = never break here. */
  readonly break: boolean;
  /** Regex matched against the text ending at the candidate position. */
  readonly beforeBreak: string;
  /** Regex matched against the text starting at the candidate position. */
  readonly afterBreak: string;
  /** Shown in the editor; carried through SRX as a comment. */
  readonly note?: string;
}

/** The complete, editable rule set for one language. */
export interface SegmentationProfile {
  readonly lang: string;
  /** Full stop after these is punctuation. */
  readonly abbreviations: readonly string[];
  /** Words that may legitimately follow an ordinal number. */
  readonly ordinalFollowers: readonly string[];
  /** Never broken, and never altered on the way through. */
  readonly variables: readonly string[];
  /** Ordered; first match wins. Applied before the built-in logic. */
  readonly rules: readonly SegmentationRule[];
  readonly breakOnColon: boolean;
  readonly breakOnSemicolon: boolean;
  readonly invertedMarks: boolean;
}
```

The existing `LanguageRules` becomes the **built-in default profile** for
each language — the same data, reachable and overridable rather than
compiled in.

### Layering

```
built-in defaults  →  TM profile  →  (session override, preview only)
```

A TM profile stores only its **delta** from the built-in defaults, not a
copy. Two reasons: a memory created today still benefits when the English
abbreviation list improves, and the diff is what a user actually wants to
see when asking "what did I change?".

Deletions are recorded explicitly, so a user who removes `No` from the
English list keeps it removed after an update.

---

## 4. Evaluation order

```
for each candidate terminator position:
    1. user rules, in order      → first match decides, stop
    2. variables                 → inside one? never break
    3. built-in logic            → abbreviations, ordinals, initials,
                                   decimals, ellipsis, opensSentence
```

User rules run **first** and win outright. "Custom" is worthless if the
built-ins can veto it — a translator who writes a rule and watches it get
overruled will not write a second one.

### Hard separators

Decided 2026-10-20. `|` is a **hard separator**: in every language, with no
profile setting, a bar followed by whitespace and then more text ends a
segment ("Home | About us | Contact" gives three). It is not a terminator, so
it skips the tests a terminator gets (abbreviations, ordinals, initials,
decimals, and `opensSentence`): the item after a bar in a menu, a breadcrumb or
a table row is as often lowercase as not, and the capital-letter test would
veto exactly those breaks. Rules:

- **The bar stays** at the end of the segment before it, so export loses no
  character. A run (`||`) is one separator.
- **Whitespace must follow**, so `a|b` is left alone. A shell pipe written
  with spaces (`cat file | grep x`) does break; there the bar is as much a
  separator as in a menu, and a longer segment would be the same mistake the
  other way.
- **Nothing breaks if only blanks (or bars) precede the bar in its segment**,
  so `| Name | Value |` gives `| Name |` and `Value |`, never a segment of one
  bar. The end of the text is no boundary.
- It sits after the user rules and the variables in the order above: a user
  rule can say no-break at that position, and a variable containing a bar
  ("Ops | Dev") is never cut. SRX export carries the generic break rule, and
  import still recognises exports made without it.

It was chosen over an opt-in flag (as `breakOnColon` is) because a bar between
spaces is a separator in nearly all running text and a flag nobody sets would
leave menus unsplit. Segments already stored are not re-cut: segmentation runs
at import.

The built-in logic stays hand-written rather than being re-expressed as
regexes. It does things regex handles badly: case-flipped abbreviation
matching, backward ordinal lookback, and the deferred-split behaviour that
keeps a trailing footnote reference with the sentence it annotates. The
tests behind that behaviour (#12, #13) must keep passing unchanged.

---

## 5. Import and export

### Trados resource lists — the real migration path

One item per line, UTF-8, one file per resource type, matching what Trados
emits:

```
Mons.
Excmo.
Rvdo.
```

Bidirectional. This is the path a translator moving off Trados actually
has, so it ships first.

### SRX 2.0

**Export** is a mapping exercise, not a new engine:

| Ours | SRX |
|---|---|
| `rules` | `<rule>` in order |
| `abbreviations` | generated `break="no"` rules, `\bWORD\.` + `\s` |
| `ordinalFollowers` | generated `break="no"` rules, `\d+\.` + `\s*WORD` |
| `variables` | generated `break="no"` rules |
| flags | generated break rules |
| hard separators (`\|`) | one generated break rule, `\|+` + `\s+\S`, last of the generic suffix |
| `lang` | `<languagemap>` |

**Import** is best-effort and must say so, and it preserves semantics
over structure. Lifting a no-break rule out of the ordered sequence into
a typed list is only sound when nothing left behind can outrank it — in
this engine lists are consulted *after* user rules, so a leftover generic
break rule would defeat every lifted exception. Import therefore runs in
two modes:

- **Our own exports** are recognised by their generic-rule fingerprint;
  the typed lists are lifted back minimally and the generic suffix is
  dropped, since the built-in logic already implements it. A user rule
  that is structurally identical to a generated one (a plain no-break
  abbreviation guard) is normalised into the list — behaviour unchanged,
  and a list entry is more editable than a regex.
- **Foreign documents** are imported verbatim as ordered rules, keeping
  their first-match-wins semantics exactly. No lifting.

A round trip through another tool will not come back structurally
identical, and the UI should not imply otherwise.

Two constraints to honour:

- **Regex flavour.** SRX assumes ICU/Java-style regex; JavaScript differs
  on named groups, possessive quantifiers and some character classes. Every
  imported pattern is compiled at import time and a rule that will not
  compile is reported, never silently dropped.
- **memoQ emits SRX 1.0.** Accept both 1.0 and 2.0 on import.

---

## 6. Preview and safety

Segmenting the manuscript fixture (371 paragraphs, 205k characters) is a
few hundred milliseconds, so a live preview is affordable.

On any rule change, show against the open document:

- resulting segment count, and the delta from the current rules
- which segments would **split** and which would **merge**
- a warning when a rule matches nothing — usually a broken regex
- a warning when a rule matches more than ~30% of candidates — usually a
  regex that lost an anchor

**Existing work is never re-segmented silently.** `v1-spec.md` §5.3 already
requires re-segmentation to be explicit and to warn when confirmed
segments would be dropped. Rules living in the TM help here: editing them
changes how *future* files are imported and leaves files already in
progress alone.

---

## 7. Backlog

| # | Title | Size | Status |
|---|---|---|---|
| **#12a** | `SegmentationProfile` + layering | M | **Done** — `segment/profile.ts` |
| **#12b** | Ordinal followers + variables | M | **Done** — engine + de/nl month lists |
| **#12c** | User rule engine | M | **Done** — ordered pairs, first match wins, before built-ins |
| **#12d** | Profiles in `.ctm` | M | **Partial** — schema + serialization specified and implemented; SQLite storage lands with #15a. No `user_version` bump needed: the format has never shipped a file |
| **#12e** | Trados `.txt` list import/export | S | **Done** — `segment/trados-lists.ts` |
| **#12f** | SRX 2.0 + 1.0 import/export | M | **Done** — `segment/srx.ts`, fidelity-preserving import |

Ordering: **#12e first** — it is small, it is what unblocks moving off
Trados, and it needs only #12b. SRX is worth having for memoQ and Okapi
interchange, but it cannot carry rules out of Trados and should not be
sold as if it can.

---

## 8. Open questions

1. **Profile scope.** Trados stores rules per TM. With multiple TMs
   attached to one project (`v1-spec.md` §4.1), which profile segments the
   document — the write-target's, or a project-level one? Proposal: the
   write-target TM's, since that is the memory the work accumulates into.
2. **Sharing profiles.** Should a profile be exportable independently of
   its memory, so the same rules can seed a new TM?
3. **Per-file overrides.** A single badly-formatted file sometimes needs
   one-off rules. Worth it, or does manual merge/split (#14) cover it?

---

## 9. The corpus

Decided 2026-10-20 (issue #267). `segmenter.test.ts` holds the cases someone
thought of while writing the code. A corpus organised by *what makes a text
hard*, per language, shows what the segmenter does not do yet and records the
choices it makes on purpose.

**Where:** `packages/core/src/segment/corpus/<lang>.fixture.ts` (test
scaffolding, excluded from the build), run by `corpus.test.ts` inside
`pnpm test`. A language in `SUPPORTED_LANGUAGES` with no corpus fails the run,
so adding a language forces its cases to be written. The text-level function
under test is `findBoundaries`; the token-level path is covered elsewhere.

**Three kinds of case.** A case is `correct` (the default), `policy` or `gap`:

| Kind | Meaning | What the test asserts |
|---|---|---|
| correct | the segmenter gives what a translator should get | the cut equals `sentences` |
| policy | a deliberate conservative choice, with the reason in `note` | the cut equals `sentences` (today's behaviour) |
| gap | the segmenter is wrong; `sentences` is what it should give, `issue` tracks it | the cut still **differs**, so fixing it fails the run until the case is promoted |

The last row is the point of the exercise. A corpus that holds only passing
cases says nothing about what is missing, and a gap asserted as "still wrong"
cannot be fixed by accident and forgotten: closing it turns the run red with
"gap #N is closed: delete the status, note and issue from this case".

**The policy that recurs:** a known abbreviation followed by a capital
("etc. They", "Inc. Her desk") does not break. A false break puts half a
sentence into the memory, where it never matches again; a missed break only
makes a longer segment the translator can split by hand (v1-spec.md §5.1).

**Categories** (a `Category` on each case, so a gap names its cause):
plain terminators, hard separators, ellipsis and runs of marks, quotes and brackets,
abbreviations, abbreviation at a sentence end, initials and acronyms, numbers
and decimals, ordinals and dates, numbered steps, URLs / emails / file names,
lowercase starts, whitespace, inverted marks, typographic spacing, scripts
without case.

**What it found on the first run** (127 cases in nine languages: 104 correct,
7 policy, 16 gaps, each gap filed as its own issue and none fixed on that
branch):

| Issue | Gap |
|---|---|
| #268 | a closing quotation mark after a sentence end is not recognised (U+2019, German U+201C and reversed guillemets, a space before French `»`). Closed: U+2019, U+201C and U+00AB join the trailing set, and a lone closing mark set off by spaces is consumed |
| #269 | abbreviations missing from the default lists (en `p.`, `Mt.`; vi `tr.`). Closed: `p` joined the shared list, `Mt` the English one, `tr` the Vietnamese one, and the three cases were promoted |
| #270 | an abbreviation written in two parts with a space (`z. B.`) is split |
| #271 | the word "no" is an abbreviation and never ends a sentence. Closed: `no` and `nos` are abbreviations only before a digit |
| #272 | a step number is cut off from its text (`Step 1. Open ...`) |
| #273 | a sentence starting with a lowercase product name (`iPhone`) is not cut |
| #274 | the Korean list holds single syllables that end ordinary clauses |

**Prior art.** The idea of a "golden rules" set organised by edge-case
category is pySBD's and pragmatic_segmenter's (both MIT, read at 5905f13 and
358fe97: `planning/prior-art.md`, kind B). Only their READMEs' description of
the idea and the names of their test files were looked at; no case was read,
and nothing is copied: every sentence is written for Tessera.

**What it does not prove.** It is synthetic text written by us, so it shows
the cases we thought of, not how often they occur. It holds no client text.
The corpus covers the nine languages the segmenter supports and has not been
reviewed by a native reader of each; the Korean and Vietnamese cases in
particular are a start (#274 asks for that review).

