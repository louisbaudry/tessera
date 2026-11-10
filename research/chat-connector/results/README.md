# Results

One JSON file per run, under `results/E-NNN/`, never edited (a rerun is a new
file). Each records the commit, whether the tree was dirty, the corpus digest, the
model id, every parameter and the runtime, and **numbers only**: no source, no
draft. A run that fails still gets a file.
