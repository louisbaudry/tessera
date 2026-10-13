# Results

One JSON file per run, under `results/E-NNN/`. Never edited; a rerun is a
new file. No client text, no key.

Fields every file carries: `experiment`, `run_id`, `date`, `commit`,
`tree_dirty`, `corpus` (`id`, `sha256`), `model`, `parameters`, `machine`,
`runtime` (Node, package versions), `status` (`ok` or `failed`, with the
reason), and the measured values. The schema is completed when the first
harness lands (slice 0); this file is updated then, in the same commit.
