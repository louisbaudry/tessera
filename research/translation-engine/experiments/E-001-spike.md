# E-001 — slice-0 spike: cost and speed of a retrieval-prompted draft

Tests H1, H2, H3, H4 (`hypotheses.md`, 2026-10-13). Spec: slice 0 of
`planning/translation-engine-spec.md` §7.

## Question

Can the engine of spec §3 draft a segment from the client's TM matches,
glossary terms and neighbours fast enough for the editor's prefetch and
cheaply enough to batch, and does the tag round trip hold?

## Setup (frozen at the commit that fills the blank below)

- **Corpus.** Synthetic only. A seeded generator makes a memory of 2,000
  translation units and a test set of 50 segments (45 plain, 5 with a
  planted instruction for H4; 20 of the 50 carry inline tags), per pair. The
  generator, its seed and the corpus SHA-256 are recorded in every results
  file. No real text, no text from any client or any real document.
- **Language pairs.** EN to ES and EN to VI (Louis, 2026-10-13; spec D14).
  Each pair is a separate run on its own synthetic corpus, and **every
  hypothesis is tested per pair**: H1 to H4 must hold for both for the
  spike to count as passed, and a pair that misses is recorded as a miss
  with its own results file. Vietnamese is expected to cost more tokens than
  Spanish (more tokens per word; an inference this run will test).
  Setup frozen at the commit that fills this in.
- **Retrieval.** The product path: `retrieveFuzzy` over a `.ctm` built from
  the synthetic memory, at most 3 matches, no threshold floor (a 60% match
  is useful as an example), glossary from a synthetic `.ctg` of 40 terms.
- **Engine.** One call per segment, no batching, no prompt caching in the
  first run (a later run adds it and compares). Model: the mid tier, id
  recorded; temperature 0 where the API allows it.
- **Prompt.** `prompt_version = spike-1`, in this folder, never in `core/`.
  The slice-2 template is written after these results, not before.
- **Run.** Sequential, one machine, 3 repetitions of the 50 segments, the
  first repetition discarded as a warm-up and recorded anyway.
- **Measured.** Per call: input tokens, output tokens, wall-clock time,
  whether the placeholders map back, whether a planted instruction was
  obeyed. Summaries: median and 95th percentile of each.
- **Credential.** Read from `ANTHROPIC_API_KEY` in the environment. The
  harness refuses to run without it and never prints or stores it.

## Status

**Blocked, 2026-10-13.** The pairs are now named (above). Still waiting on
an API key supplied to the environment by Louis. The harness and the corpus generator
are written meanwhile and tested offline with a fake engine; no number
from a fake engine is a result and none is recorded as one.

## Outcome

None yet.
