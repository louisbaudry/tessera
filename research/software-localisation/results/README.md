# Results

One JSON file per run, under `results/E-NNN/`, never edited (a rerun is a new file).
Each records the commit, whether the tree was dirty, the input digest (the English
catalogue's SHA-256, as the workbench's export writes it), the model id, every
parameter, the machine and the runtime versions, and **numbers only**: no string, no
draft, no target, no reviewer. A run that fails still gets a file.

There is none yet: slice S0 ran probes, which are tests, not runs of a hypothesis
(see `../journal.md`, 2026-11-05).
