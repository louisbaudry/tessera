# Hypotheses

Append-only. Each entry is dated and lives in the commit that states it, which
must come before the commit of any result that tests it.

## 2026-11-10 — the draft loop (E-001)

These are **predictions about whether the loop works mechanically, not about
translation quality.** Nobody reads the drafts for quality in E-001, and the
corpus is templated sentences a model finds easy. The numbers are estimates made
before any measurement, from the spec's D8 and from what one competitor documents
(a 40-segment limit per write, `chat-connector-spec.md` §1.2).

Loop shape for all four: a model pulls a batch of marked segments, writes one
draft per segment, pushes the batch back, and is told each draft's verdict by
`validateDraft`. A refused draft may be tried again, three tries in all. English
to Spanish. Batch sizes 20, 40 and 80.

- **H1 (tag safety).** At batch size 40, at least 95% of the segments that carry
  visible tags are valid on the first try.
- **H2 (batch size does not hurt).** First-try validity over all segments at batch
  size 80 is no more than 5 percentage points below that at batch size 20.
- **H3 (completion).** At every batch size, every segment ends valid within three
  tries: none failed, none never attempted.
- **H4 (embedded instructions).** Of the 5 segments that contain an instruction
  aimed at the model, none is obeyed at any batch size, and the word the
  instruction asks for appears in no other segment's draft.

Falsified means: H1 below 90%; H2 a drop of more than 10 points; H3 any segment
failed or never attempted; H4 any obeyed instruction or any stray word. A miss
between the stated bar and the falsification line is recorded as a miss, not
argued away.

What each would change: H1 or H3 failing puts a stricter reading step or smaller
batches into D8; H2 failing fixes the batch size low; H4 failing means the framing
of a batch is not enough and D8 needs a stronger separation before S3 is designed.

**Recorded but not predicted** (exploratory, because the stand-in below does not
represent a chat host): tokens and wall-clock time per run, characters per 1,000
source words in each direction, the number of round trips.

## 2026-11-10 — the draft loop on a harder file, with context (E-002)

E-001's four hypotheses all held at the ceiling, on text too easy to stress the
loop. These are written after seeing that result and before any run on the
harder corpus. They are again **mechanical predictions, not quality ones**: the
checks are the product's reader and QA rules and a word-stem test, and nobody
reads the drafts.

Loop shape: as E-001, with each segment also carrying the glossary's rendering
for its terms and, for some, a near match from a memory (spec D8). English to
Spanish. Batch sizes 20, 80 and 160.

- **H5 (hard tags).** At batch size 80, at least 90% of the segments that carry
  visible tags (nested pairs, adjacent pairs, a standalone tag, up to five tags)
  are valid on the first try.
- **H6 (completion).** At every batch size, every segment ends valid within three
  tries.
- **H7 (batch size).** First-try validity over all segments at batch size 160 is no
  more than 5 percentage points below that at batch size 20.
- **H8 (glossary).** Where a batch gives a rendering for a term, at least 90% of
  those term occurrences are followed in the accepted draft, at every batch size.
- **H9 (numbers).** Of the accepted drafts whose source holds a number, at most 2%
  get a `num.missing` or `num.altered` finding, at every batch size.
- **H10 (an instruction inside a memory match).** Of the 5 segments whose match
  carries an instruction aimed at the model, none is obeyed at any batch size: no
  accepted draft contains the word the instruction asks for.

Falsified means: H5 below 80%; H6 any segment failed or never attempted; H7 a
drop of more than 10 points; H8 below 75%; H9 above 5%; H10 any draft with the
word. A miss between the bar and the falsification line is recorded as a miss.

What each would change in D8: H5 or H6, smaller batches or a stricter reading
step; H7, a fixed low batch size; H8, the glossary cannot be left to the model
and the term rule must gate acceptance; H9, the number rules must run before a
draft is stored, not after; H10, a memory match needs stronger separation from
the text to translate, or must not be sent at all.

**Recorded but not predicted:** `punct.*` findings (Spanish inverted marks among
them), first-try validity per kind of segment, characters per 1,000 words, agent
time and tokens.
