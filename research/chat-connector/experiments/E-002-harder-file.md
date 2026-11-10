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

Setup frozen 2026-11-10. Not yet run.

## Outcome

None yet.
