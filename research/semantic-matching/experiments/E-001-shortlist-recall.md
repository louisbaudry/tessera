# E-001 — Offline shortlist recall

**Status:** set up, not run. This file was committed before any
measured run (protocol rule 1). A change to anything below after the
first confirmatory run needs a journal entry naming it, and runs made
under the old setup stay labelled with the commit they ran on.

**Tests:** H1 as stated, and H1b (`hypotheses.md`), which adds the
control H1 lacks. **Card:** backlog `#59`, issue #50. **Spec:**
`planning/semantic-matching-spec.md` §3.1, §5, §8 (S1).

## Question

A fuzzy lookup asks FTS5 for 50 candidates by bm25 and scores only
those with FS-1. E-000 saw that shortlist lose the best FS-1 match at
scale: 67% recall at 1M synthetic units. Does adding the vector top-_m_
to the shortlist recover the missed matches? Does it do better than
simply asking FTS for _m_ more? And does it stay within a latency
budget?

## Why H1b exists

The union contains the FTS top-50, so its recall can never be lower
than the FTS top-50's. H1's "more often than FTS top-50 alone" is
therefore met by any extra candidate, including random ones. The
comparison that matters is at an equal candidate count: FTS top-50 plus
vector top-_m_ against FTS top-(50 + _m_). H1b states that. H1 is still
reported as written (protocol rule 5 forbids editing it), but the
verdict that goes into the paper is H1b's.

## Arms

Every arm scores its candidates with FS-1 (`db/tm/bench/stats.ts`,
`fuzzyScore`, word-level edit distance, unchanged since E-000) and
keeps the best score.

| Arm       | Candidates                                                        |
| --------- | ----------------------------------------------------------------- |
| `naive`   | Every source-language variant in the memory. Defines "best".      |
| `fts50`   | FTS5 top-50 by bm25, the 100 most frequent words dropped (E-000). |
| `ftsK`    | Same query, top-(50 + _m_). The control.                          |
| `union`   | `fts50` ∪ vector top-_m_ (cosine, same source language).          |
| `vecOnly` | Vector top-_m_ alone. Descriptive, not tested.                    |

The stopword list is E-000's: the 100 words with the highest document
frequency in 20,000 sampled source variants (the synthetic corpus uses
its own first 100 Zipf ranks). The FTS query is those words' `OR`, each
quoted, as in `measure.ts`.

`naive` has an exact shortcut: FS-1 can be no higher than
`min(len) / max(len)`, so a variant whose length bound is below the
best score so far is skipped unscored. That is exact, not approximate:
it can only skip variants that could not have won.

**Recall** of an arm on a query set is the share of queries for which
the arm's best FS-1 score equals `naive`'s (to within 1e-9, so ties
count).

## Values of _m_

_m_ ∈ {10, 25, 50}. So `ftsK` is top-60, top-75 and top-100.

## Models

All three are run through `@huggingface/transformers` 3.8.1
(transformers.js), the int8 ONNX weights (`dtype: 'q8'`), on CPU, and
L2-normalised, so cosine is a dot product. The revision is the Hugging
Face commit the run downloaded, pinned here.

| Key      | Model                                          | Revision  | Dim | Pooling | Prefix (memory and query) |
| -------- | ---------------------------------------------- | --------- | --- | ------- | ------------------------- |
| `e5s`    | `Xenova/multilingual-e5-small`                 | `761b726` | 384 | mean    | `query: `                 |
| `minilm` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | `2c4055b` | 384 | mean    | none                      |
| `labse`  | `Xenova/LaBSE`                                 | `147002d` | 768 | cls     | none                      |

- **e5 prefix:** the model card's instruction for symmetric tasks is
  `query: ` on both sides. This is a source-to-source search, so it is
  symmetric.
- **LaBSE's dense layer is missing:** its sentence-transformers
  pipeline ends with a dense layer that this ONNX export does not
  include. We use what transformers.js runs. The result is labelled
  `labse`, not LaBSE as published.
- **Excluded: `onnx-community/embeddinggemma-300m-ONNX`.** A feasibility
  probe on 2026-09-25 (journal) embedded 30 sentences/s on this
  machine, against 156–230 for the three above. At that rate 1M units
  take about nine hours, too slow for a CAT tool's own machine. It is
  excluded on cost, not on quality, and the paper says so.

**What is embedded:** `tuv.plain` of each source-language variant,
under the current `NORMALIZER_VERSION`, the text FTS indexes. Queries
are embedded the same way, and query embedding counts towards the
latency the query is charged.

## Vector search

1. **`exact`** is the reference: a dot product against every stored
   vector of the query's model and source language, held in memory as
   one `Float32Array` loaded from `tuv_vec`. Its top-_m_ defines the
   vector candidates for the recall arms.
2. **`hnsw`** is measured only if `exact` misses the budget at a size.
   It uses `hnswlib-node`, with M = 16, efConstruction = 200 and
   efSearch = 128. Its recall is reported next to `exact`'s, and it
   joins the H1b test only if it meets the budget where `exact` did
   not. It is labelled as a separate arm, never substituted silently.

Vectors are stored in `tuv_vec` as float32 (tm-format-spec.md §2.8).
Storage is measured on that format. Any quantised storage would be a
later experiment.

## Corpora

| Id                                      | What                                                                                                                            | Units          | Pair  | Where run       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- | --------------- |
| `synthetic-100k`                        | `db/tm/bench/corpus.ts`, as E-000                                                                                               | 100,000        | en→fr | this machine    |
| `synthetic-1M`                          | same                                                                                                                            | 1,000,000      | en→fr | this machine    |
| `synthetic-5M`                          | same                                                                                                                            | 5,000,000      | en→fr | this machine    |
| `dgt-tm-v2019-en-fr-1M`                 | OPUS DGT v2019, Moses `en-fr.txt.zip` (sha256 `d1d720a3…dd1ff2`), first 1,000,000 line pairs in file order, empty sides dropped | ≤ 1,000,000    | en→fr | this machine    |
| `private-A` (and others the owner adds) | Owner's Trados memories, via `--sdltm`                                                                                          | as is (86,240) | en→es | owner's machine |

- **Synthetic corpora test cost, not meaning.** The synthetic text is
  pseudo-words (`corpus.ts`). An embedding model sees it as subword
  noise, so synthetic recall numbers measure subword overlap, not
  semantics. They are run for latency, storage and embedding time at
  5M, and their recall is reported but carries no weight in H1b's
  verdict.
- **At 5M, embedding cost limits the models run.** One 5M embedding
  pass takes about six hours per model here. `synthetic-5M` runs
  `e5s` only. It was chosen before any run as the smallest and fastest
  of the three, and it is used for scaling only.
- **The whole DGT-TM (4.94M pairs) is not part of E-001's confirmatory
  set.** A 5M natural-language run with the model §9.1 settles on may
  follow as a labelled secondary run.
- **Attribution.** DGT-TM is © European Union, reused under Commission
  Decision 2011/833/EU; OPUS per Tiedemann (2012). No DGT text is
  committed here, only its digest and numbers derived from it.

## Query sets

Per corpus, drawn once with a fixed seed (7, as E-000) and recorded in
the results by count and digest, never by text.

- **`lex` (lexical edits).** E-000's method: a random source variant
  from the memory, one word replaced by one of the 2,000 most frequent
  words, and one word deleted if the sentence is longer than four
  words. The original stays in the memory. 400 queries, or 200 at
  `synthetic-5M`, where each `naive` scan takes about a minute.
- **`para` (natural paraphrases).** Only corpora with real text: DGT
  and private. Pairs of units (A, B) where:
  - the normalised targets are identical;
  - the normalised sources differ, with FS-1(source A, source B) < 0.75
    (below the default fuzzy threshold, so lexical matching would not
    surface B);
  - the target has at least four words.

  The query is A's source. **Every unit whose source equals A's is
  removed from the memory before import**, so the query has no exact
  match. B stays. We sample 400 pairs, at most one per distinct target,
  and record the eligible count if it is below 400. Two translators, or
  one translator twice, rendered both sources with the same target
  sentence. That is a paraphrase found in the data, not generated, and
  the paper can say so.

  For `para` we also report **partner recall**: the share of queries
  whose arm's candidates contain B. It is descriptive. It feeds H2's
  design and is not tested here.

## Latency and the budget

A query's **lookup time** is the wall time of:

- producing its candidates (FTS query; plus, for vector arms, embedding
  the query and the vector search);
- fetching the candidates' `plain`;
- FS-1 scoring;

all in one process, sequentially, on a warm cache.

**Budget (fixed here, before any run):** at each size, on the same
machine, p99 lookup time of `union` ≤ p99 lookup time of `fts50` +
**100 ms**. A relative budget, because absolute milliseconds from two
different machines are not comparable, and "what does semantic matching
add" is the product question. 100 ms is a judgement, not a measurement:
an editor that fetches matches for the next segment while the
translator works on the current one can hide that much, and a
translator waiting on a lookup notices more.

## Test

For H1b, on `dgt-tm-v2019-en-fr-1M`, query set `para`: for each model
and each _m_ whose `union` meets the budget, compare `union` against
`ftsK` per query. Test with an exact one-sided McNemar test on the
discordant queries (`union` found the best and `ftsK` did not, and the
reverse). Apply Holm correction across the 9 model × _m_ comparisons.

- **Supported** if at least one comparison has an adjusted p < 0.05 in
  `union`'s favour.
- **Falsified** if none does, or if no model × _m_ meets the budget.

`lex` on the same corpus is run and reported the same way. It is a
secondary test, because lexical edits are the case FTS is built for,
so a null result there is expected and would not count against H1b.

Private corpora are below 1M units and are descriptive, as are
`synthetic-*` for recall.

## Metrics keys

One results file per corpus × model (plus one per corpus for the arms
that need no model, with `model` null). `metrics` holds exactly:

| Key                                   | Meaning                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `queries.<set>.n`                     | Queries run                                                                      |
| `queries.<set>.sha256`                | Digest of the query list (ids and perturbations as JSON)                         |
| `queries.para.eligible`               | Eligible pairs before sampling                                                   |
| `recall.<set>.<arm>`                  | Recall (0–1); `<arm>` includes `_m` for `ftsK`, `union`, `vecOnly` (`union_m25`) |
| `partner_recall.para.<arm>`           | Share of `para` queries whose candidates contain B                               |
| `discordant.<set>.union_m<m>`         | `{ union_only, ftsK_only }` counts                                               |
| `mcnemar_p.<set>.union_m<m>`          | Exact one-sided p, unadjusted                                                    |
| `latency_ms.<set>.<arm>`              | `{ n, p50, p99, max }` lookup time                                               |
| `latency_ms.embed_query`              | `{ n, p50, p99, max }` query embedding alone                                     |
| `latency_ms.vector_search.<method>`   | `{ n, p50, p99, max }` search alone, `exact` or `hnsw`                           |
| `budget_met.<set>.union_m<m>`         | Boolean, per the rule above                                                      |
| `hnsw.recall_vs_exact.m<m>`           | Share of exact top-_m_ that HNSW returned, if run                                |
| `embed.units`                         | Variants embedded                                                                |
| `embed.ms`                            | Wall time of the embedding pass                                                  |
| `embed.units_per_sec`                 | Throughput                                                                       |
| `embed.peak_rss_mib`                  | Peak RSS of the embedding process                                                |
| `storage.tuv_vec_bytes`               | `dbstat` size of `tuv_vec` and its index                                         |
| `storage.bytes_per_unit`              | That over units embedded                                                         |
| `storage.ctm_bytes_before` / `_after` | File size without and with vectors                                               |

Holm-adjusted p-values are computed from these by the analysis script
and not stored, so the adjustment can be rerun if a comparison is added.

## Machine

Public and synthetic runs: this project's cloud container, 4 vCPU, 15
GiB RAM, Linux, Node 22. Each results file records the exact machine.
Private runs: the owner's machine, recorded the same way.

## Done when

- Results on all three corpus kinds, failed runs included.
- H1 and H1b are each marked supported or falsified in the journal,
  against the criteria above.
- The `tuv_vec` contract is in `tm-format-spec.md` §2.8.
- Spec §9.1 (which model) has a decision, or a recorded reason there
  isn't one yet.
