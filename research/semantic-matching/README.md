# Semantic matching — research record

The evidence behind `planning/semantic-matching-spec.md`, kept for an
empirical paper. The spec holds the **decisions**; this folder holds the
**evidence and the path** to them. The protocol is the spec's §6; this
is its short form. It binds every session that touches semantic
matching.

## Rules

1. **A hypothesis is committed before the run that tests it.** A result
   that inspired a hypothesis is _exploratory_ and never confirms it.
2. **Every run is recorded, failures included.** A results file, or a
   journal line saying why there is none.
3. **Every number is reproducible from its results file** (commit,
   corpus digest, model, parameters, machine). Paper figures are
   generated from `results/` by a script, never typed in.
4. **No client text here, ever.** Private memories are measured on the
   owner's machine and give numbers only, under opaque ids
   (`private-A`). The id-to-client mapping stays off the repo.
5. **`journal.md` and `hypotheses.md` are append-only.** Correct an
   entry with a later one; revise a hypothesis under a new id
   (H1 → H1b). A changed line in an old entry is a review finding.
6. **A session that touches this feature ends with a journal entry**,
   even when nothing was measured.

## Layout

| Path                     | What                                                 |
| ------------------------ | ---------------------------------------------------- |
| `journal.md`             | Dated entries: done, decided, found, abandoned       |
| `hypotheses.md`          | Hypotheses, dated, in the commit that states them    |
| `experiments/E-NNN-*.md` | One per experiment; setup fixed before the first run |
| `results/E-NNN/*.json`   | One file per run; schema in `results/README.md`      |

## Experiments

| Id                                               | Question                                                              | Hypotheses          | Status          |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------------------- | --------------- |
| [E-000](experiments/E-000-prior-observations.md) | What was measured before this protocol existed                        | none (motivates H1) | Record only     |
| [E-001](experiments/E-001-shortlist-recall.md)   | Does a vector top-_m_ recover fuzzy matches the FTS shortlist misses? | H1, H1b             | Set up, not run |

Status lives in this table and in the experiment file, not in the
journal: the journal says what happened, this says where things stand.
