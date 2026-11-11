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

## 2026-11-10 — E-002 run

- Three runs (batch 20, 80, 160), results in `results/E-002/`. H5 to H10 all held,
  again at the ceiling: 320 of 320 valid on the first try, 117 of 117 tagged, 489
  of 489 terms followed, no number or punctuation finding, the planted word in no
  draft.
- Because a clean sweep can mean a blind check, the scoring was tested after the
  runs on three hand-written drafts (not a run, no results file): an altered
  number and a dropped number each got `num.missing`; a draft using the usual
  word in place of the glossary's counted as not followed. The checks can fail.
- Found: context roughly doubled what is sent per 1,000 words (about 15,200
  characters against 8,800). Found: a 160-segment batch (about 53,000 characters)
  was more than the stand-in's shell would display.
- Two ceilings in a row say the method has run out, not that the loop is proven.
  What is left cannot be learned from synthetic text and a stand-in: quality (a
  person reading drafts), a real document, and a real chat host's speed and quota.
  Both need Louis: a real host needs a hosted server and an account, and a real
  document must stay off this repository.

## 2026-11-10 — O1 decided; nothing measured

- Louis ruled on the spec's O1: a client's text reaches a chat host only with the
  client's consent to that engine and the connected person's recorded statement
  that their chat account is on a business plan (spec D15). O2 follows from it.
- No run. E-001 and E-002 did not bear on this decision: it is contractual, and
  neither experiment says anything about a host's terms.
- Still open and needing a person: a real host's speed and quota, and quality.

## 2026-11-11 — S1a and S1b built; nothing measured

- Two slices built, neither an experiment: a read-only endpoint with a hand-made
  token (backlog #378), then sign-in from a chat host by OAuth with PKCE (backlog
  #381). No run, no results file.
- The official client connected, listed and called tools against both, and ran
  its own sign-in against the second. That is a check of the protocol, not a
  measurement of a chat host.
- Unchanged: no real chat host has connected, so its speed, quota and the quality
  of its drafts are still unmeasured. The next step that can be measured needs a
  server on `https` and an account on a host, which are Louis's to provide.
