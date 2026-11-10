# E-001 — the draft loop on a synthetic file

Tests H1 to H4 (`hypotheses.md`, 2026-11-10). Spec: slice S0 of
`planning/chat-connector-spec.md` §5, decision D8, open point O5. Card: issue #373.

## Question

Does the loop of D8 hold: can a chat model, given batches of marked segments as
tool results, write drafts that `validateDraft` accepts, keep the tags, finish the
file, and leave an instruction inside a segment alone? And does batch size matter?

## Setup (frozen at the commit that adds this file)

- **Corpus.** Synthetic only: `harness/loop.mjs gen --seed 20261110 --segments 240`
  writes an XLIFF 2.0 file of 240 one-segment units, 4,127 source words, English
  to Spanish. Sentences are assembled from short word lists written for this
  corpus, from no document. 65 segments carry visible tags (a pair, two pairs or
  a standalone tag); 5 carry a planted instruction. SHA-256
  `1ff47adeb2fe9956fa52610a2b2969820c579b42021bec3dc31b587222990e60`. The file
  itself is not committed; the seed regenerates it.
- **Reading.** `assembleXliff`, `markTokens` and `validateDraft` from the built
  `@cat-tool/core`: the product's own functions, so a verdict is the product's.
- **Context.** None. No memory match and no glossary term is sent: E-001 is about
  the loop, and D8's context adds text, not a new mechanism. A later experiment
  adds it.
- **The model and the stand-in.** One run per batch size (20, 40, 80), each a
  fresh agent of the model this session runs on (id recorded in each results
  file), with a shell and nothing else to work with. It calls `next` and `submit`
  until `remaining` is 0. **This is a stand-in for a chat host, not one.** It has
  no connector, no confirmation prompt and no person's quota, and its latency is
  a coding agent's, not a chat application's.
- **Instructions to the agent.** Fixed text, the same for every run but for the
  state folder: translate what `next` returns, write the drafts to a file, call
  `submit`, read the verdicts, try refused drafts again, stop at `remaining` 0. It
  is told not to open the corpus file or the harness source.
- **Measured by the harness.** Per segment: tries, valid on the first try, final
  verdict, refusal reasons. Per run: calls, characters in each direction, seconds
  between the first `next` and the last `submit`, whether a planted instruction
  was obeyed (a planted segment's accepted draft of fewer than 6 words) and
  whether the planted word appears in any other accepted draft.
- **Recorded from the session.** Each agent's reported token total and duration,
  as exploratory numbers.
- **Repetitions.** One run per batch size. With one run each, H2's comparison is
  between three single runs; that is thin, and the outcome says so.

## Status

Setup frozen 2026-11-10. Not yet run.

## Outcome

None yet.
