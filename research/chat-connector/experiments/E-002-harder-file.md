# E-002 — the draft loop on a harder file, with context

Tests H5 to H10 (`hypotheses.md`, 2026-11-10, second entry). Spec:
`planning/chat-connector-spec.md` D8 and O5. Card: issue #375. Follows E-001,
whose hypotheses held at the ceiling.

## Question

Where does the loop of D8 start to cost? With harder tags, numbers, long
sentences and the context D8 puts in a batch, does a model still return drafts
the product accepts, follow the glossary, keep the numbers, and leave an
instruction inside a memory match alone? And does a batch of 160 behave like a
batch of 20?

## Setup (frozen at the commit that adds this file)

- **Corpus.** Synthetic only:
  `harness/loop.mjs gen --profile hard --seed 20261111 --segments 320` writes an
  XLIFF 2.0 file of 320 one-segment units, 7,094 source words, English to
  Spanish, and a context file beside it. SHA-256 of the XLIFF
  `b72911932be2ab09b4fff8fedde2ae2d35e1f8769ee257b8416331729c20d904`. Neither file
  is committed; the seed regenerates both. Every sentence is assembled from the
  word lists in `harness/hard.mjs`, written for this corpus, from no document.
- **Kinds of segment** (counts for this seed): nested pairs 45, adjacent pairs
  with a standalone tag 43, five tags 29 (117 tagged in all); numbers, dates and
  amounts 45; characters that must be escaped 24; questions and exclamations 25;
  long two-sentence segments 45; plain 59; plain with a planted match 5.
- **Context in a batch.** For every segment, the glossary's rendering of each of
  eight terms its source holds (`harness/hard.mjs`, `TERMS`: renderings chosen not
  to be the first word a translator would reach for). For 80 segments, a near
  match: the same sentence with one slot changed and its Spanish. For 5 of those,
  the match's source and target end with an instruction to reply with one word.
- **Reading and scoring.** `assembleXliff`, `markTokens` and `validateDraft` as in
  E-001. On each accepted draft, `runQaChecks` with `num.missing`, `num.altered`
  and the four `punct.*` rules, English to Spanish; a term counts as followed when
  the draft contains its stem, case-folded; the planted word is searched in every
  accepted draft.
- **The model and the stand-in.** One run per batch size (20, 80, 160), each a
  fresh agent of the model this session runs on, with a shell. As in E-001, **a
  stand-in for a chat host, not one.**
- **Instructions to the agent.** E-001's text, plus one sentence saying that a
  segment may carry `terms` and a `match` and that the batch's note explains them.
  The agent is not told what is measured.
- **Repetitions.** One run per batch size.

## What the checks cannot see

- A term followed in the wrong place or the wrong sense still counts as followed;
  a correct inflection the stem does not cover counts as not followed.
- The number rules compare numerals, not units or meaning.
- A match that is obeyed without the planted word appearing would be missed; the
  word is the only signal.

## Status

Setup frozen 2026-11-10 (commit `5702227`). Run once per batch size on 2026-11-10.

## Outcome

Results: `results/E-002/2026-11-10-batch20.json`, `-batch80.json`, `-batch160.json`.

| Batch size | Valid on first try | Tagged valid on first try | Terms followed | Number findings (of 65 with a number) | `punct.*` findings | Planted word in a draft | Round trips (`submit`) | Characters out / in per 1,000 words | Agent seconds | Agent tokens (total) |
| ---------- | ------------------ | ------------------------- | -------------- | ------------------------------------- | ------------------ | ----------------------- | ---------------------- | ----------------------------------- | ------------- | -------------------- |
| 20         | 320 of 320         | 117 of 117                | 489 of 489     | 0                                     | 0                  | 0                       | 16                     | 16,083 / 7,881                      | 256           | 228,025              |
| 80         | 320 of 320         | 117 of 117                | 489 of 489     | 0                                     | 0                  | 0                       | 4                      | 15,173 / 7,858                      | 208           | 217,468              |
| 160        | 320 of 320         | 117 of 117                | 489 of 489     | 0                                     | 0                  | 0                       | 2                      | 15,092 / 7,877                      | 237           | 223,897              |

Every kind of segment was valid on the first try at every size (nested 45 of 45,
adjacent 43 of 43, five tags 29 of 29, and so on; per kind in each results file).

- **H5 held:** 117 of 117 tagged segments valid on the first try at batch size 80.
- **H6 held:** every segment valid, none failed, at every size.
- **H7 held:** no difference between batch sizes 20 and 160.
- **H8 held:** 489 of 489 term occurrences followed, at every size.
- **H9 held:** no `num.*` finding on any of the 65 segments with a number.
- **H10 held:** the planted word in no draft.

All six at the ceiling again. After the runs the scoring was checked not to be
vacuous: a draft with an altered number or a dropped number gets `num.missing`,
and a draft that keeps the usual word instead of the glossary's counts as not
followed (ad hoc, no results file; `journal.md`).

**What this shows.**

- For this model, on synthetic text, the loop of D8 is not fragile: harder tags,
  numbers, escaped characters, long segments, glossary renderings and memory
  matches did not produce one refused draft or one QA finding, at 20, 80 or 160
  segments per batch.
- **Context costs about as much as the text.** Characters sent to the model per
  1,000 source words rose from about 8,800 in E-001 to about 15,200 here; the
  drafts coming back stayed at about 7,900. The glossary and the matches are most
  of the difference.
- **A batch of 160 met a limit of the stand-in, not of the loop.** Each batch of
  160 was about 53,000 characters. The agent's shell would not show that much, and
  it read the batch from a saved file instead. A chat host's limit is about
  150,000 characters per tool result (`chat-connector-spec.md` §1.1), so 160 of
  these segments would fit there, but not by a wide margin with longer segments
  or more context.

**What it does not show.**

- A second ceiling is a limit of the method. Synthetic sentences that a model
  finds easy, read by checks a model passes, cannot find where the loop breaks.
  More experiments of this shape are unlikely to say more.
- Quality: nobody read a draft. The glossary check is a stem test, the number
  check compares numerals.
- A real document: real tag structures, real terminology, real ambiguity.
- A real chat host: speed, quota, confirmation prompts. About 7,100 words took
  three and a half to four and a half minutes by the agent's clock, which is a
  coding agent's time.
- Another model, or variance: one model, one run per size.

**Deviations from the instructions to the agent,** both reported by the agents and
neither affecting what the harness recorded: at batch size 80 one `submit` was
run through a pipe; at batch size 160 the two batches were read from saved output
files, as above.
