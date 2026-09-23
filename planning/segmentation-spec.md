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
