# E-000 — Prior observations

**Status:** record only. Not an experiment run under the protocol, and
nothing in it can confirm a hypothesis (spec §6.2 rule 5).

**Why it is here:** these are the measurements that motivated H1. They
were taken for `tm-format-spec.md` §11 before semantic matching was
proposed, so they were not predicted by a hypothesis. They are the
baseline the paper starts from and are listed so it can say so
honestly.

## What was measured

All with FS-1 (`db/tm/bench/stats.ts`, `fuzzyScore`) and an FTS5 top-50
shortlist ranked by bm25. Recall = the shortlist contained the unit the
naive scan scored best.

| Source          | Corpus                             | Units  | Recall, top-50 | Where                     |
| --------------- | ---------------------------------- | ------ | -------------- | ------------------------- |
| Synthetic bench | `corpus.ts`, 6,000-word vocabulary | 100k   | 90%            | `tm-format-spec.md` §11.2 |
| Synthetic bench | same                               | 1M     | 67%            | §11.2                     |
| Real memory     | `private-A` (2022, en-US → es-ES)  | 86,240 | 100%           | §11.4                     |

Queries were source sentences drawn from the memory itself, with one word replaced and,
for longer ones, one word deleted (`measure.ts`, "fuzzy baselines"),
40 queries per size.

## What it leaves open

- The synthetic drop may come from the synthetic vocabulary (§11.3
  lists how a real memory differs). No real memory of 1M units has
  been measured.
- 40 queries is a small sample: a 100% recall is compatible with a
  true recall a few points lower.
- The query perturbation (one substitution, one deletion) is a lexical
  edit, which favours lexical retrieval. Queries that differ in wording
  but not meaning were never tried. That is the case semantic matching
  is for, and E-001 must include it.
