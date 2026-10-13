# Translation engine — research record

The evidence behind `planning/translation-engine-spec.md` (Epic 8, issue
#228). The spec holds the **decisions**; this folder holds the **evidence
and the path** to them. The protocol is the one binding on
`research/semantic-matching/` (`planning/semantic-matching-spec.md` §6),
applied here unchanged; spec decision D7 names it for the quality
benchmark.

## Rules

1. **A hypothesis is committed before the run that tests it.** A result
   that inspired a hypothesis is _exploratory_ and never confirms it.
2. **Every run is recorded, failures included.** A results file, or a
   journal line saying why there is none.
3. **Every number is reproducible from its results file** (commit, whether
   the tree was dirty, corpus id and SHA-256, model id, every parameter,
   machine, runtime versions). Paper figures are generated from `results/`
   by a script, never typed in.
4. **No client text here, ever.** A private memory is measured on the
   owner's machine and gives numbers only, under an opaque id
   (`private-A`); the id-to-client mapping stays off the repo. The spike
   (E-001) uses a **synthetic** memory only.
5. **`journal.md` and `hypotheses.md` are append-only.** Correct an entry
   with a later one; revise a hypothesis under a new id (H1 → H1b). A
   changed line in an old entry is a review finding.
6. **A session that touches this feature ends with a journal entry**, even
   when nothing was measured.
7. **No credential here, ever.** A run reads its API key from the
   environment; a results file records the model id, never a key.

## Layout

| Path                     | What                                                 |
| ------------------------ | ---------------------------------------------------- |
| `journal.md`             | Dated entries: done, decided, found, abandoned       |
| `hypotheses.md`          | Hypotheses, dated, in the commit that states them    |
| `experiments/E-NNN-*.md` | One per experiment; setup fixed before the first run |
| `results/E-NNN/*.json`   | One file per run; never edited, a rerun is a new one |

## Experiments

| Id                                  | Question                                                                        | Hypotheses     | Status                                    |
| ----------------------------------- | ------------------------------------------------------------------------------- | -------------- | ----------------------------------------- |
| [E-001](experiments/E-001-spike.md) | Is a retrieval-prompted Claude draft feasible at editor latency and token cost? | H1, H2, H3, H4 | Setup frozen; blocked on a key, see there |
