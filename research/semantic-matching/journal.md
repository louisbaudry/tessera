# Journal

Append-only (README rule 5). Newest entry last. Each entry: date, what
was done, what was decided and why, what is open. Correct a mistake
with a later entry that names the one it corrects.

---

## 2026-09-25 — Survey, scope, and the protocol itself

**Question from the owner:** "We must develop a new type of fuzzy
matches: vector-based matching. Is anybody else doing this today?"

### What the survey found

Web searches on 2026-09-25. Queries, so the survey can be repeated:

- `CAT tool semantic fuzzy match translation memory embeddings 2026`
- `Trados "AI Assistant" OR memoQ "semantic" translation memory neural fuzzy match vector`
- `"semantic search" translation memory Phrase OR XTM OR Smartcat OR memoQ OR "Bureau Works" OR Crowdin`
- `memoQ 2026 AI translation memory "semantic" match`
- `Trados 2026 "semantic" translation memory matching RWS launch`

Findings:

- **No shipped CAT tool found showing a semantic TM match to the
  translator.** Vendors use embeddings or retrieval to feed an LLM.
  - Trados Studio 2026 (RWS): search summaries of the launch describe
    retrieval-augmented generation over TM and terminology. The press
    release page itself returned no readable content when fetched, so
    this rests on the summaries.
    <https://www.rws.com/about/news/2026/rws-launches-trados-studio-2026/>,
    <https://www.trados.com/product/features/AI-Assistant/>
  - memoQ 12.3 (April 2026): AI translation takes TMs and glossaries
    as context. Its documentation says TM comparison is by letters and
    words, not meaning.
    <https://www.memoq.com/product/ai-translation/>,
    <https://docs.memoq.com/current/en/Concepts/concepts-translation-memories.html>
  - Phrase, Smartling, Smartcat, Crowdin: LLM translation layers; no
    public material found on semantic TM matching.
    <https://phrase.com/blog/posts/localization-platform-comparison-2026/>
- **Research does it directly.**
  - SmartMatch (Estevanell-Valladares, Lamsiyah, Picazo-Izquierdo,
    Ranasinghe, Mitkov, Muñoz; EACL 2026 demo): open-source TM retrieval
    with sentence encoders and a vector database. On DGT-TM it reports
    full coverage at millisecond latency and BERTScore up to 0.91 at
    k=10, and calls BM25 a strong lightweight lexical baseline.
    <https://aclanthology.org/2026.eacl-demo.36/>
  - Cross-lingual neural fuzzy matching: multilingual embeddings to
    retrieve proposals from target-language monolingual corpora.
    <https://arxiv.org/pdf/2401.08374>
  - Ranasinghe et al., intelligent TM matching with sentence encoders
    (2020). <https://arxiv.org/pdf/2004.12894>
- **Counter-evidence.** EAMT 2026, "Fuzzy Matching and Sentence
  Embeddings for Few-shot MT with LLMs": on European Medicines Agency
  text (en-ro, en-de), token-based fuzzy matching gave overwhelmingly
  higher automatic scores than embedding retrieval for choosing
  few-shot examples. <https://aclanthology.org/2026.eamt-1.34/>

Limits of this survey: web search and public pages only. No vendor was
asked, no product was tried, and a feature shipped without public
material would not show up. The claim for the paper is "no published
or documented product", not "nobody".

### Decisions (owner, 2026-09-25)

1. **Build semantic matching as a separate match type, never inside
   fuzzy bands.** Three options were put to the owner:
   - embeddings only as a candidate source;
   - a separate, unpriced semantic match type (built on the first);
   - semantic similarity blended into fuzzy percentages.

   Chosen: the second. Reason: fuzzy percentages set prices (analysis,
   discount grids, vendor pay by tier), and a cosine similarity shown
   as a percentage would be priced as a fuzzy match. The third option
   was rejected on that ground and because the EAMT 2026 finding
   suggests it would lower match quality.

2. **The work is the subject of an empirical paper**, not an experience
   report. Claims must be measurable.
3. **The record lives in this repo** (`research/semantic-matching/`),
   so every result points at a commit. A separate repo or a document
   outside git were rejected: links to code break, and results are
   not tied to commits.
4. **Offline first, real use later.** Public corpora for publishable
   numbers. Private memories on the owner's machine, numbers only. Data
   from real use once shipped, behind consent, from `audit_event`.
5. **No venue or deadline yet.** Chosen once E-001 has results.

### Found while scoping

- **Product fuzzy matching does not exist yet.** It is a v1 cut
  (`v1-spec.md` §1, §4.3). The only fuzzy scorer in the repo is the
  bench's throwaway FS-1. That makes FS-1 the research baseline (spec
  §2). Product fuzzy is a prerequisite card (spec §8, S3), not part of
  this feature.
- **E-000's recall numbers were all measured with lexical-edit queries**
  (one word substituted, one deleted). Paraphrase queries, which are
  what semantic matching is for, were never measured. E-001 has to
  include them, or H1 is tested only on the case least likely to need
  it.
- **The acceptance-rate denominator is a real gap.** `audit_event`
  records accepted suggestions, not suggestions shown (`audit-spec.md`
  §4). Left open in spec §9.2, to be decided before H4.
- **Storage is not free.** A 384-dimension float32 vector is 1.5 KiB,
  about the size of a whole bilingual unit in a `.ctm` today.

### Open after today

- Owner review of `planning/semantic-matching-spec.md`, then cards for
  S1 and S2.
- E-001's setup (models, corpora, query sets, latency budget, metric
  keys) is to be written and committed before its first run.

---

## 2026-09-25 — Spec merged, first cards

The spec and this folder were merged into `main` (PR #49) on the
owner's go-ahead. Three phases became cards:

- backlog `#59`, issue #50: E-001, offline shortlist recall (H1);
- backlog `#60`, issue #51: E-002, usefulness below the fuzzy
  threshold (H2);
- backlog `#61`, issue #52: product fuzzy matching, the prerequisite.

Nothing measured. Two things fixed in the cards that the spec left
implicit:

- **E-001 must include paraphrase queries**, not only E-000's lexical
  edits (see the scoping notes in the previous entry).
- **E-002 must exclude exact and near-duplicate queries from the
  memory** it retrieves from. DGT-TM repeats heavily, and a query that
  is also in the memory would score as a perfect retrieval without
  testing anything.

Product fuzzy matching reverses a v1 scope cut. **Decided by the owner
the same day: after `#37`, the real dogfood job.** Three options were
put: after `#37`, before it, or in parallel with the editor cards. Why
this one:

- v1 ships as planned, without an L-sized card added to its path.
- E-001 and E-002 don't need product fuzzy, so the research is not held
  up.
- The fuzzy shortlist is then designed with E-001's results in hand,
  not before them.

The cost for the paper: H4 (real use) moves further out, since the
semantic match type (S4) needs product fuzzy first.

---

## 2026-09-25 — E-001 set up (card `#59`, issue #50)

Picked up issue #50. Before writing any harness code, I fixed E-001's
setup in `experiments/E-001-shortlist-recall.md` and committed it. No
measured run has happened.

**Found while writing the setup: H1 cannot fail on recall.** The union
contains the FTS top-50, so it can never find less than FTS top-50
alone. Stated as written, H1 would be "confirmed" by adding any
candidates at all. H1 stays as it is (rule 5). The new **H1b** compares
against FTS top-(50 + _m_), the same number of candidates, and that is
the verdict E-001 will report. Worth a sentence in the paper: the
pre-registration caught a hypothesis that could not fail before any
data could have been bent to it.

**Feasibility checks, not measurements** (not results files; none of
them tests a hypothesis):

- Embedding throughput on this container (4 vCPU, 15 GiB), 1,024
  English-like word-list sentences, batch 32, int8 weights,
  `@huggingface/transformers` 3.8.1:
  - `multilingual-e5-small`: 227 sentences/s (121 in fp32);
  - `paraphrase-multilingual-MiniLM-L12-v2`: 230 sentences/s;
  - `LaBSE`: 156 sentences/s;
  - `embeddinggemma-300m`: 30 sentences/s.

  That excluded EmbeddingGemma on cost, and put `synthetic-5M` on one
  model (about six hours per 5M pass).

- OPUS DGT v2019 en-fr downloads (Moses zip, 295 MB, 4,938,565 line
  pairs; digest in E-001). In its first 1M pairs, 81,756 distinct French
  sentences occur more than once. That is where the `para` query set
  (units sharing an identical target) comes from, so the set will not
  be short of candidates. This count describes the corpus; it is not a
  result.

**Decided in the setup, with reasons in E-001:**

- Three models: `e5s`, `minilm`, `labse`. All int8 and local.
- _m_ ∈ {10, 25, 50}.
- Latency budget is relative: `union` p99 ≤ `fts50` p99 + 100 ms at the
  same size, on the same machine.
- Synthetic corpora count for cost only. Pseudo-words mean nothing to
  an embedding model.
- The `para` queries are natural paraphrases found in the data (the
  same target sentence, different sources). They are not generated, so
  there is no LLM in the loop and no generation prompt to defend.

**Open:** the harness itself (embedding pass, `tuv_vec` writes,
vector search, arms, results files), then the runs.

---

## 2026-09-25 — E-001 harness built; shakedown runs

The harness is `pnpm bench:e001` (`db/tm/bench/e001.ts`). It rests on
three new pieces: the `tuv_vec` contract (`tm-format-spec.md` §2.8), its
one key definition (`embeddingModelKey`, `core/tm/embedding.ts`), and
the vector repository (`db/tm/vectors.ts`). Nothing in the product
calls them yet.

A decision made while writing the contract: `writeBack` rewrites a
variant's `plain` in place, so a vector can go stale. `writeBack` now
deletes that variant's vectors in the same transaction. A schema
trigger would enforce it for every future write path too, but it
needs a format-version bump for every user's `.ctm` over a table the
product leaves empty. Revisit when the product writes vectors.

**Shakedown runs: exploratory, and not results.** Two runs checked the
plumbing, with output written to scratch and not kept:

- `synthetic` at 20k units, `e5s`, _m_ = 10, 30 `lex` queries;
- the first 50,000 DGT line pairs (48,483 units), `minilm`, _m_ = 10,
  20 `lex` and 50 `para` queries.

I saw their recall numbers. On the DGT slice the `para` set drew 246
eligible pairs, and partner recall was about a third in every arm. They
are exploratory under rule 1, on an ad-hoc corpus id, and they
changed nothing in E-001's setup, which was committed before them. The
DGT slice is a subset of `dgt-tm-v2019-en-fr-1M`; the paper should say
so.

One implementation detail the setup left open, fixed from the
shakedown: when a drawn `para` pair conflicted with an earlier one (its
partner already deleted, or its query's deletion would remove a kept
partner), the first version skipped it and came out short: 48 of 50.
It now keeps drawing in the shuffled order until 400 are kept, which is
what "sample 400 pairs" meant.

Throughput on real text matches the probe: `minilm` embedded 268
units/s on the DGT slice.

---

## 2026-09-25 — First confirmatory run: synthetic-100k; exact search misses the budget

`synthetic-100k` ran on commit 479ce51, clean tree: all three models,
400 `lex` queries. Results `2026-09-25-479ce51-1` to `-4`. Synthetic
recall is descriptive only (E-001), so this entry reports cost. Recall
waits for DGT.

**Exact vector search misses the budget already at 100k.** A dot
product against every stored vector, in plain JS, takes about 100 ms
p99 at 384 dimensions (`e5s`, `minilm`) and 183 ms at 768 (`labse`).
The `union` arm's p99 is 111–127 ms against `fts50`'s 9.8 ms for the
384-dimension models, and 196–208 ms for `labse`. That is over
`fts50` + 100 ms at every _m_. Exact search is linear in the memory, so
at 1M it will be about ten times slower. E-001 fixed what happens in
that case before any run: measure `hnsw` (`hnswlib-node`, M = 16,
efConstruction = 200, efSearch = 128) as a separate arm. I did not
speed up the exact loop: after seeing it miss the budget, that would
be a change made to pass the test.

The `hnsw` arm is now in the harness (`--search hnsw`). A shakedown at
20k (exploratory, scratch, not kept) returned 100% (_m_ = 10) and 99.6%
(_m_ = 25) of exact's top-_m_, with a p99 search of 5 ms.

**One metric key added after the setup:** `hnsw.build_ms`, the index
build time. It is descriptive cost, like `embed.ms`, and nothing is
tested on it. It is listed here because E-001 says keys are never
invented after the fact, and this one was.

**Run plan changed, not the setup.** The first driver deleted each
`.ctm` after its exact run, which would have thrown away the vectors
the `hnsw` arm needs (DGT-1M alone is about 4.5 hours of embedding). I
stopped it between corpora; the DGT-1M exact run it had started
continues untouched. From now on each corpus runs `exact`, then
`hnsw` on the same kept memory. `synthetic-100k` gets re-embedded for
its `hnsw` run.

Embedding throughput at 100k: `e5s` 248 units/s, `minilm` 263, `labse` 184.

Housekeeping: results JSON is now excluded from prettier. The files are
machine-written and never edited, so reformatting them would break
rule 2's "never edited".
