# Chat connector — research record

The evidence behind `planning/chat-connector-spec.md` (issue #152; slice S0 is
issue #373). The spec holds the **proposals**; this folder holds the **evidence**.
The protocol is the one binding on `research/semantic-matching/`
(`planning/semantic-matching-spec.md` §6), applied here unchanged.

## Rules

1. **A hypothesis is committed before the run that tests it.** A result seen first
   is exploratory and never confirms it.
2. **Every run is recorded, failures included.** A results file, or a journal line
   saying why there is none.
3. **Every number is reproducible from its results file:** the commit, whether the
   tree was dirty, the corpus seed and SHA-256, the model id, every parameter, the
   runtime.
4. **No client text here, ever, and no text at all in a results file.** The corpus
   is generated from a seed; a results file holds numbers only.
5. **`journal.md` and `hypotheses.md` are append-only.** Correct an entry with a
   later one; revise a hypothesis under a new id.
6. **A session that touches this feature ends with a journal entry**, even when
   nothing was measured.
7. **No credential here, ever.**

## Layout

| Path                     | What                                                   |
| ------------------------ | ------------------------------------------------------ |
| `journal.md`             | Dated entries: done, decided, found, abandoned         |
| `hypotheses.md`          | Hypotheses, dated, in the commit that states them      |
| `experiments/E-NNN-*.md` | One per experiment; setup fixed before the first run   |
| `results/E-NNN/*.json`   | One file per run; never edited, a rerun is a new one   |
| `harness/loop.mjs`       | The draft loop as shell commands; research scaffolding |

## Experiments

| Id                                       | Question                                                                   | Hypotheses     | Status                    |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------------- | ------------------------- |
| [E-001](experiments/E-001-draft-loop.md) | Does the pull-and-push draft loop of spec D8 hold, and at what batch size? | H1, H2, H3, H4 | Setup frozen; not yet run |
