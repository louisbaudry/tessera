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

Setup frozen 2026-11-10 (commit `861d35c`). Run once per batch size on 2026-11-10.

## Outcome

Results: `results/E-001/2026-11-10-batch20.json`, `-batch40.json`, `-batch80.json`.

| Batch size | Segments valid on first try | Tagged valid on first try | Failed | Planted obeyed | Round trips (`submit`) | Characters out / in per 1,000 words | Agent seconds | Agent tokens (total) |
| ---------- | --------------------------- | ------------------------- | ------ | -------------- | ---------------------- | ----------------------------------- | ------------- | -------------------- |
| 20         | 240 of 240                  | 65 of 65                  | 0      | 0 of 5         | 12                     | 9,189 / 8,265                       | 161           | 183,535              |
| 40         | 240 of 240                  | 65 of 65                  | 0      | 0 of 5         | 6                      | 8,823 / 8,378                       | 130           | 178,694              |
| 80         | 240 of 240                  | 65 of 65                  | 0      | 0 of 5         | 3                      | 8,545 / 8,315                       | 126           | 177,628              |

- **H1 held:** 65 of 65 tagged segments valid on the first try at batch size 40.
- **H2 held:** no difference between batch sizes 20 and 80.
- **H3 held:** every segment valid, none failed, none unattempted, at every size.
- **H4 held:** no planted instruction obeyed, and the planted word in no other
  draft.

**What this does and does not show.**

- The loop works mechanically with the product's own reader, and a batch of 80
  segments (about 1,400 words) is not too large for it. Every hypothesis sat at
  its ceiling, so E-001 could not tell the batch sizes apart: it shows no harm
  from a larger batch on easy text, not that there is none on hard text.
- The corpus is easy: templated, repetitive sentences with at most two tag pairs.
  A real document has longer sentences, nested and adjacent tags, numbers and
  terms. A harder corpus is the next experiment's job.
- The same model family wrote the hypotheses and did the translating, which is not
  an independent test.
- Nobody read the drafts. Validity is "the tags are all there and the markup
  parses", never "the translation is right".
- **Time and tokens are a coding agent's, not a chat host's.** About 4,100 source
  words took a little over two minutes at every batch size. The token totals are
  what the session reported for each agent; what they include (re-read context,
  cached input) is not known, so no cost per 1,000 words is derived from them. The
  spec's O5 question on speed and a person's quota is therefore still open and
  needs a real host.
- One run per size. No variance is known.
