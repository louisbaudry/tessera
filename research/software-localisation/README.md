# Software localisation — research record

The evidence behind `planning/software-localisation-spec.md` (Epic 16). The spec
holds the **decisions**; this folder holds the **evidence and the path** to them.
The protocol is the one binding on `research/semantic-matching/`
(`planning/semantic-matching-spec.md` §6) and `research/translation-engine/`,
applied here unchanged.

## Rules

1. **A hypothesis is committed before the run that tests it.** A result that
   inspired a hypothesis is _exploratory_ and never confirms it.
2. **Every run is recorded, failures included.** A results file, or a journal line
   saying why there is none.
3. **Every number is reproducible from its results file** (commit, whether the tree
   was dirty, input digest, model id, every parameter, machine, runtime versions).
   Figures are generated from `results/` by a script, never typed in.
4. **Numbers only, no text, even though these strings are public.** The record then
   looks like every other and never has to be re-checked for a string that should
   not be here. A reviewer is a person and is never named: the reviewer stays in
   Tessera's audit log, outside the repository.
5. **`journal.md` and `hypotheses.md` are append-only.** Correct an entry with a
   later one; revise a hypothesis under a new id (H1 to H1b). A changed line in an old
   entry is a review finding.
6. **A session that touches this feature ends with a journal entry**, even when
   nothing was measured.
7. **No credential here, ever.** A run reads its key from the environment; a results
   file records the model id, never a key.

## Layout

| Path                     | What                                                 |
| ------------------------ | ---------------------------------------------------- |
| `journal.md`             | Dated entries: done, decided, found, abandoned       |
| `hypotheses.md`          | Hypotheses, dated, in the commit that states them    |
| `experiments/E-NNN-*.md` | One per experiment; setup fixed before the first run |
| `results/E-NNN/*.json`   | One file per run; never edited, a rerun is a new one |

## What exists

| Id                   | What                                                                                      | Status                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S0 probes            | Five recorded observations, as tests (see the journal of 2026-11-05 for where each lives) | Done; observations, not runs of a hypothesis               |
| H1, H2, H3           | Hypotheses and thresholds, committed before round 1 (`hypotheses.md`)                     | Open; no run yet                                           |
| Round 1 (`uk`, `ru`) | The first run, slice S6                                                                   | Not started; needs the workbench's L2 (built) and S1 to S4 |
