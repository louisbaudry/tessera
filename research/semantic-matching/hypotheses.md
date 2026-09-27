# Hypotheses

Append-only (README rule 5). Each entry is stated in the commit that
adds it, so `git log` on this file dates it against the results.
Outlines and reasoning are in `planning/semantic-matching-spec.md` §5;
the wording here is the binding one.

Thresholds written as _to be fixed_ get fixed in the experiment file
before its first run, and that commit is the one that counts.

---

## H1 — Recall

**Stated:** 2026-09-25.

On a translation memory of at least 1M bilingual units, a candidate set
made of the FTS5 top-50 (bm25) plus the vector top-_m_ contains the
naive scan's best FS-1 match more often than the FTS5 top-50 alone, on
each corpus measured, and its p99 lookup latency stays within a budget
fixed in E-001 before the first run.

Tested on: synthetic memories at 100k, 1M and 5M; at least one public
corpus; the owner's private memories. Query sets include both lexical
perturbations (E-000's) and paraphrases.

Falsified if: the union's recall is not higher than FTS alone on the
1M+ corpora, or the budget cannot be met by any _m_ that raises it.

## H2 — Usefulness below the fuzzy threshold

**Stated:** 2026-09-25.

For query segments whose best FS-1 match is below the fuzzy threshold
(to be fixed in the experiment, 75% by default), the target side of the
best semantic candidate scores a higher chrF against the reference
translation than the target side of the best FS-1 candidate, on average
across the query set, with the difference outside a bootstrap 95%
confidence interval.

Tested on: public parallel corpora with held-out references only. No
private memory, because the reference would be client text.

Falsified if: no higher mean chrF, or the interval includes zero.

## H3 — LLM context

**Stated:** 2026-09-25.

Few-shot context drawn from both fuzzy and semantic candidates gives
LLM translations that are no worse than fuzzy-only context, by
automatic metrics (chrF, COMET) and, where affordable, a blind human
comparison. This deliberately tests the opposite finding of EAMT 2026
(see journal, 2026-09-25) on our data. A "no worse" margin is fixed in
the experiment before the run.

Tested on: public corpora only, since client text sent to an LLM is an
`ai.requested` event under `audit-spec.md` §4.

## H4 — Real use

**Stated:** 2026-09-25.

Once semantic matches ship: translators accept a semantic match in a
share of the segments where one is shown (the share is a result, not a
prediction), and accepted semantic matches need fewer edits before
confirmation (token edit distance, `telemetry-spec.md` §7) than MT drafts
for comparable segments.

Precondition: the acceptance-rate denominator (spec §7, §9.2) is decided
and collecting before measurement starts.

## H1b — Recall at an equal candidate count

**Stated:** 2026-09-25. Revises H1 without replacing it (rule 5).

**Why:** H1 compares FTS top-50 plus the vector top-_m_ against FTS
top-50 alone. The union contains the FTS top-50, so its recall can
never be lower, and any extra candidates, even random ones, can only
raise it. H1 cannot fail on recall by construction. H1b adds the
control that can fail.

**Statement:** on a natural-language memory of at least 1M bilingual
units, with paraphrase queries, FTS top-50 plus vector top-_m_ contains
the naive scan's best FS-1 match more often than FTS top-(50 + _m_), for
at least one model and _m_ whose p99 lookup latency meets E-001's budget.

Tested on: `dgt-tm-v2019-en-fr-1M`, query set `para`, with the test,
the correction and the budget fixed in
`experiments/E-001-shortlist-recall.md` before its first run.

Falsified if: no model × _m_ comparison is significant after correction,
or none meets the budget.
