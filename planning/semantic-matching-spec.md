# Semantic matching — spec

Status: design, 2026-09-25. Not yet built, no backlog entries or issues
yet. The owner asked for the spec first, to review before it is broken
into cards. Nothing in this document is measured yet, and every number
in it is either arithmetic or a citation.

**Confirmed with Louis, 2026-09-25:**

- **What we build: a TM match found by meaning, alongside fuzzy, never
  instead of it.** Embeddings first widen the fuzzy shortlist (§3.1).
  They then surface a separately labelled *semantic match* (§3.2). A
  semantic match **carries no percentage and never counts in analysis,
  pricing or pay** (§4).
- **The work is also research.** This feature is the subject of an
  **empirical paper**. Its record lives in `research/semantic-matching/`
  in this repo, under the protocol in §6. That protocol is binding on
  every session that touches this feature, from the first measurement.
- **Data comes in two stages.** Offline benchmarks come first: public
  corpora for publishable numbers, and the owner's private memories
  measured on the owner's machine, with only aggregate numbers coming
  back. Data from real use is designed now and collected only after the
  feature ships, behind consent, derived from `audit_event` (§7).
- **No venue or deadline yet.** The protocol runs as if there were one.
  The venue gets chosen once the first offline results exist.

Extends: `tm-format-spec.md` §2.8 (`tuv_vec`), §11.2–§11.4 (shortlist
recall) and §12.5 (the open question this answers); `v1-spec.md` §4.3
(fuzzy-ready schema); `ai-platform-vision.md` §3 Ring 0.5 (TM matches in
the prompt) and §5 (confidentiality); `audit-spec.md` §4 (a suggestion
is not a write); `telemetry-spec.md` §6–§7 (consent, productivity from
`audit_event`); `vendor-spec.md` decision 9 (rates by match tier).

## 0. Why now

Two reasons, one technical and one about the record.

**The fuzzy shortlist loses matches at scale.** `tm-format-spec.md`
§11.2 measured the planned design: an FTS top-50 shortlist, then
scoring by edit distance. On the synthetic corpus it missed the best
match 10% of the time at 100k units, and a third of the time at 1M.
§12.5 already lists embeddings as one possible second candidate source.
A real 86k-unit memory scored 100% (§11.4), so the question is open at
agency size, not settled.

**A paper needs a record written as the work happens.** The spec and
backlog keep *conclusions*. A paper also needs:

- hypotheses dated before the measurement that tests them;
- the experiments that failed;
- enough provenance to regenerate every number.

None of that can be reconstructed afterwards. This is the same reasoning
`audit-spec.md` §0 gives: history not recorded at write time is gone.

## 1. Who else does this (survey, 2026-09-25)

In summary: nobody ships it as a TM match type, as far as searches found.
The full survey, with sources and the queries used, is the first journal
entry (`research/semantic-matching/journal.md`).

- **Commercial CAT tools use embeddings to feed an LLM, not to show the
  translator a match.** Trados Studio 2026 (RWS) describes
  retrieval-augmented generation over TM and terminology. memoQ 12.3's
  AI translation takes TMs and glossaries as context, and memoQ's own
  documentation says its TM comparison is by letters and words, not
  meaning. Phrase, Smartling, Smartcat and Crowdin have LLM layers. No
  public material found shows any of them putting a semantic match next
  to fuzzy matches in the editor.
- **Research does it directly.** SmartMatch (EACL 2026 demo) retrieves
  TM entries with sentence encoders and a vector database, and reports
  BM25 as a strong, cheap lexical baseline. Cross-lingual neural fuzzy
  matching (arXiv 2401.08374) uses multilingual embeddings to reach
  target-language monolingual text. Ranasinghe et al. (arXiv
  2004.12894) is the earlier sentence-encoder study.
- **One result points the other way.** EAMT 2026 ("Fuzzy Matching and
  Sentence Embeddings for Few-shot MT with LLMs") found that word-based
  fuzzy matching beat embedding retrieval for choosing few-shot examples
  on medical text (en-de, en-ro). Similar meaning is not the same as
  reusable wording. H3 (§5) is framed so that this result can be
  replicated or contradicted, not ignored.

The gap this leaves: **a semantic match the translator sees, kept apart
from fuzzy matches and pricing, and measured in real use.** That is
what H4 (§5) tests and what no source found reports.

## 2. Vocabulary

Four terms, used exactly this way here and in `research/`:

- **Fuzzy score (FS-1).** Word-level similarity: `1 − wordDistance /
  max(len)` over normalised words. It is the scorer in
  `db/tm/bench/stats.ts` (`fuzzyScore`) that §11 measured. Product
  fuzzy matching is not built (`v1-spec.md` §4.3), and when it is, its
  scorer may differ (character-based, tag penalties). The research
  baseline stays FS-1 until a journal entry says otherwise, so results
  measured months apart stay comparable. A new scorer is FS-2, never a
  silent change to FS-1.
- **Semantic similarity.** Cosine similarity between two embeddings from
  the same model. It is never shown as a percentage and never compared
  with an FS score (§4).
- **Shortlist recall.** Did the candidate set contain the unit that the
  naive scan (score every unit) ranks best by FS-1? This is §11's
  metric, kept unchanged.
- **Semantic match.** A TM unit shown to the translator because its
  source is close in meaning to the segment, whether or not its FS-1
  score clears the fuzzy threshold. It is a match type of its own
  (§3.2).

## 3. The feature

### 3.1 Step 1: embeddings as a second candidate source

The shortlist becomes the union of the FTS top-*k* and the vector
top-*m*, and is then scored by the ordinary fuzzy scorer. Nothing new
reaches the translator, and a fuzzy match stays a fuzzy match. This
changes recall only, and it can be measured before any product code
exists (H1).

### 3.2 Step 2: the semantic match type

A candidate with high semantic similarity but a fuzzy score below the
fuzzy threshold is shown as a **semantic match**:

- **Where it is shown.** In the match list, below fuzzy matches, with its
  own label and **no percentage**. What exactly the label says is the
  editor's spec (Epic 6), not this one.
- **Its `origin` when accepted.** A new value, `tm_semantic`.
  `Segment.origin` is open by design (`v1-spec.md` §4.3), so no schema
  change is needed.
- **Its use in Ring 0.5.** It is also a source of context for Ring 0.5's
  prompt (`ai-platform-vision.md` §3), alongside fuzzy matches. Whether
  that helps is H3.

### 3.3 Where the code goes

- **Embeddings are computed locally.** `transformers.js` is already in
  the locked stack (`tm-format-spec.md` §2.8). A local model means no
  client text leaves the process, so there is no `ai.requested` event
  and no per-client opt-out question. A hosted embedding API would be
  an engine under `ai-platform-vision.md` §5 and `audit-spec.md` §4,
  and would need its own decision.
- **`core` stays headless.** Loading model weights is I/O. `core` gets
  an `Embedder` interface and the pure pieces: the input normalisation
  and the similarity function. The `transformers.js` implementation
  lives in a shell package. This is the `NotificationService` /
  `SmtpNotificationService` split from CLAUDE.md applied again.
- **`tuv_vec` gets a frozen contract before its first row.** Two rules:
  - A `model` value names the model, its revision and the pooling, and
    what was embedded: `tuv.plain` under the current
    `NORMALIZER_VERSION`. The identifier gets one definition, imported
    everywhere, per CLAUDE.md's rule on cross-package facts.
  - Vectors from different `model` values are never compared, and never
    stored under one another's name.

  The contract is written into `tm-format-spec.md` §2.8 in the same
  change that writes the first vector.

### 3.4 Cost, as arithmetic

- **Storage.** One float32 vector of 384 dimensions is 1.5 KiB, about
  the same as a whole bilingual unit today (§11.2). A 768-dimension
  model doubles that. Embedding only source-side variants, or int8
  quantisation, are the obvious levers.
- **Search.** Exact nearest-neighbour search at 1M units is 384M
  multiply-adds per query. An approximate index (a native SQLite
  extension such as `sqlite-vec`, or an in-process index) is a
  Phase 1 measurement. A native one needs a `pnpm-workspace.yaml`
  `onlyBuiltDependencies` entry (CLAUDE.md gotchas).
- **Embedding time.** Embedding a whole memory on import is real CPU
  time. Import already runs in batches (§12.4, backlog #18c), and
  embedding would follow the same batches, resumable.

None of these is measured yet. Phase 1 measures them.

## 4. Pricing: why a semantic match has no percentage

Fuzzy percentages set prices: analysis reports, client discount grids
and vendor pay by match tier (`vendor-spec.md` decision 9) are all
built on edit-distance bands. A cosine similarity is a different
quantity. Shown as "92%", it would read as a 92% fuzzy match and be
priced like one.

So:

- **No percentage anywhere a translator or client reads it.**
- **For analysis and pay, a semantic match is a no-match.** An accepted
  one (`origin` `tm_semantic`) falls in the no-match tier of every
  analysis and rate card.
- **A unit that clears the fuzzy threshold is a fuzzy match**, whatever
  its semantic similarity, and is priced as one. A semantic score never
  promotes it to a higher band or a better rate.

This also keeps the research clean: the paper can claim semantic
matches added value without anyone's pay depending on the claim.

## 5. Hypotheses

Stated here in outline. The binding, dated wording, and every later
revision, is in `research/semantic-matching/hypotheses.md` (§6).

- **H1 — recall.** On a memory of 1M units or more, adding the vector
  top-*m* to the FTS top-50 raises shortlist recall (§2) over FTS alone,
  within the latency budget for a lookup. Measured with the §11 bench,
  on synthetic data, a public corpus and the owner's memories.
- **H2 — usefulness below the threshold.** For segments whose best
  FS-1 match is below the fuzzy threshold, the target of the best
  semantic candidate is closer to the reference translation (chrF) than
  the target of the best fuzzy candidate. This needs references, so it
  is measured on public parallel corpora only.
- **H3 — LLM context.** Few-shot context drawn from both fuzzy and
  semantic candidates gives translations at least as good as fuzzy-only
  context. This is the EAMT 2026 result (§1) tested on our data. The
  hypothesis is "no worse" because that paper found worse.
- **H4 — real use.** Translators accept semantic matches, and an
  accepted semantic match needs fewer edits before confirmation than an
  MT draft of the same segment would have. Measured only after the
  feature ships (§7).

## 6. The research protocol

Binding on every session that works on this feature. It exists so that
the paper can be written from the record, not from memory.

### 6.1 The folder

`research/semantic-matching/` in this repo, next to the code, so that
every result points at the commit that produced it.

| File | What it holds | How it changes |
|---|---|---|
| `README.md` | These rules, short, and the index of experiments | Edited freely |
| `journal.md` | Dated entries: what was done, decided, found, abandoned | **Append-only.** A wrong entry is corrected by a later one, never edited |
| `hypotheses.md` | Each hypothesis with its date and the commit it was stated at | **Append-only.** A revision is a new id (H1 → H1b) with the reason |
| `experiments/E-NNN-*.md` | One per experiment: question, hypotheses tested, setup, status, outcome | Setup is fixed before the first run. Later changes are appended, with dates |
| `results/E-NNN/*.json` | One file per run, schema in `results/README.md` | Never edited. A rerun is a new file |

"Append-only" here is enforced by review and by git history, not by a
trigger. A changed line in an existing journal entry or hypothesis is a
review finding.

### 6.2 Rules

1. **A hypothesis is committed before the run that tests it.** The
   hypothesis commit comes earlier in history than the result's commit.
   A result that inspired a hypothesis is *exploratory*, is labelled so,
   and is never cited as confirming it.
2. **Every run is recorded, including failures.** A crashed run, a model
   that did badly, a threshold that didn't work: each gets a results
   file or a journal line saying why it has none. Only recording
   successes is how a paper overclaims.
3. **Every number is reproducible from its results file.** The file
   records the commit (and whether the tree was dirty), the corpus id
   and SHA-256, the model id, every parameter, the machine and the
   runtime versions. A figure in the paper is generated from results
   files by a script in the folder, never typed in.
4. **No client text in `research/`, ever.** Private memories are
   measured on the owner's machine and give numbers only, as §11.3
   already requires. They get opaque ids (`private-A`), and the mapping
   from id to client stays off the repo. Example sentences in the paper
   come from public corpora only.
5. **Nothing measured before this protocol counts as confirmatory.**
   §11's recall figures are prior observations (`E-000`) and motivate
   H1. They cannot confirm it.
6. **A session that touches this feature ends with a journal entry**,
   even when nothing was measured. Design decisions, dead ends and
   surprises are what the paper's discussion section is made of.

### 6.3 Relation to the rest of `planning/`

This spec holds **decisions**. The backlog holds what shipped and what
it taught. `research/` holds the **evidence and the path**. A result
that changes a decision is written into this spec as the decision, with
a pointer to the experiment. The spec never copies result tables, so
the two can't drift.

## 7. Data from real use (after it ships)

Most of it is already covered by `telemetry-spec.md` §7: acceptance and
edit distance come from `audit_event` (`segment.target_set` with
`origin` `tm_semantic`, then `segment.confirmed`). It needs no new
channel and inherits the project file's confidentiality and retention.

**One gap, left open (§9.2):** the *denominator*. The audit log records
what was accepted, not what was shown, because a suggestion is not a
write (`audit-spec.md` §4). An acceptance rate needs "how often was a
semantic match on screen?". That is either a `usage` telemetry event
(ids and counts only, consent under `telemetry-spec.md` §6) or a
per-segment count recorded some other way. It has to be decided before
H4 is measured, not after.

The feature's users are, at first, the owner's own business. That is a
threat to validity, and the paper must state it. It is not a reason to
collect more than §7 allows.

## 8. Phases (proposed, not yet cards)

Each would become a backlog entry and issue once the owner approves
this spec. **Approved 2026-09-25:** S1, S2 and S3 are carded as backlog
`#59`, `#60` and `#61`. S4–S6 wait on the editor, Epic 8, or a shipped
feature.

- **S0. Protocol and scaffold.** This spec and `research/semantic-matching/`.
- **S1. Offline recall (H1).** Extend `pnpm bench:tm` with an embedding
  pass into `tuv_vec` and a vector candidate source. Measure recall and
  latency at 100k/1M/5M synthetic, on one public corpus, and on the
  owner's memories. Compare two or three local multilingual models
  (choice recorded in the experiment file before the run). This is where
  the `tuv_vec` contract (§3.3) gets written.
- **S2. Usefulness offline (H2).** A harness over a public parallel
  corpus with held-out references. Research tooling, not product: it
  stays out of `pnpm test` and the build, like the bench.
- **S3. Fuzzy matching in the product.** A prerequisite, not part of
  this feature: product fuzzy matching is a v1 cut (`v1-spec.md` §1,
  §4.3) and needs its own card and scorer decision (FS-2, §2). Step 1
  (§3.1) lands with it or right after. **Sequenced after `#37`, the
  real dogfood job** (owner, 2026-09-25): v1 ships as planned, and S1
  and S2's results then inform the shortlist design instead of
  following it.
- **S4. The semantic match type (§3.2).** Needs the editor (Epic 6) and
  the §9.2 decision.
- **S5. LLM context (H3).** With Ring 0.5 (Epic 8).
- **S6. Real use (H4).** After S4 has shipped and been in use long
  enough to have data.

S1 and S2 need no product decision and can start as soon as this spec
is approved.

## 9. Open, deliberately deferred

1. **Which embedding model.** Decided by S1's measurements, not here.
   Candidates must run locally under `transformers.js` and cover the
   business's language pairs.
2. **The acceptance-rate denominator (§7).** A consented `usage` event
   is the likely answer, because it keeps the audit log about writes.
   Decide before S6.
3. **Where research harness code lives.** Product-relevant measurements
   extend `db/tm/bench/`. Research-only tooling (public corpus fetchers,
   chrF scoring, LLM few-shot runs) could live under `research/` or in
   a package of its own. Decide in S2, once there is code to place.
4. **The semantic threshold and how many semantic matches to show.**
   These are results of S1/S2, not guesses to write down now.
5. **Cross-language retrieval.** Multilingual embeddings could match a
   French segment against an English source (`tm-format-spec.md` §2.8).
   It is interesting and out of scope until H1–H2 are answered.
6. **Venue, co-authors, whether to publish the harness.** Once the S1
   results exist.
