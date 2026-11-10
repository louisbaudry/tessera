# Journal

Append-only. Newest entry last.

## 2026-11-10 — folder opened, E-001 set up

- Louis chose "measure first" for the chat connector (`chat-connector-spec.md`
  O5). Card: issue #373.
- Wrote the harness (`harness/loop.mjs`): the draft loop of D8 as shell commands
  over the product's own `assembleXliff`, `markTokens` and `validateDraft`.
  Checked by hand that it accepts a valid draft and refuses a dropped tag
  (`tag_missing`) and a stray angle bracket (`malformed_markup`).
- The DOCX fixtures could not be the corpus: their words are synthetic
  pseudo-words (`fixtures/docx/README.md`), which no model can translate. The
  corpus is generated English sentences in an XLIFF file instead, so E-001 says
  nothing about a DOCX round trip; the roundtrip gate already covers that.
- No model key is available in this session, and a real chat host needs a hosted
  server and a person's account. The runs use an agent of this session's model as
  a stand-in, and E-001 says in its setup what that does not show.
- H1 to H4 and the setup are committed before any run.

## 2026-11-10 — E-001 run

- Three runs (batch 20, 40, 80), results in `results/E-001/`. H1 to H4 all held, at
  the ceiling: 240 of 240 segments and 65 of 65 tagged segments valid on the first
  try at every size, no planted instruction obeyed.
- The ceiling is the finding to be careful with: the corpus was too easy to
  separate the batch sizes. E-001 supports "the loop works and 80 is not too many
  on easy text" and nothing stronger.
- Round trips fell from 12 to 3 as the batch grew, and the time fell a little with
  them (161 s to 126 s by the agent's clock), so the round trip, not the
  translating, was the part that varied.
- Not learned: a chat host's latency and quota, quality, behaviour on real tag
  structures, behaviour with memory and glossary context in the batch.
- Next, if Louis wants more before deciding the spec's open points: E-002 on a
  harder synthetic corpus (nested and adjacent tags, numbers, long sentences) with
  context in the batch, and a real-host run, which needs a hosted server and an
  account.

## 2026-11-10 — E-002 set up

- Louis chose a harder test after E-001 (card: issue #375).
- `harness/hard.mjs` adds the harder corpus, the batch context of D8 (glossary
  renderings, memory matches) and scoring by the product's QA rules. `loop.mjs`
  gained `gen --profile hard`; E-001's corpus still regenerates to the same digest.
- Checked by hand before any run: a nested and adjacent tag sequence passes the
  filter and the reader; a Spanish exclamation with no opening mark is flagged
  `punct.inverted`; a draft that keeps "supervisor" counts as one term not
  followed.
- H5 to H10 and the setup are committed before any run. They were written knowing
  E-001's result, which is why they are new ids and not a rerun of H1 to H4.
