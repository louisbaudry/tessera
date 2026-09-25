# Results

One JSON file per run, at `results/E-NNN/<run-id>.json`, where `<run-id>`
is `YYYY-MM-DD-<short-sha>-<n>`. Never edited after it is written: a
rerun is a new file, and a run later found to be wrong gets a journal
entry, not a deletion.

**Numbers only.** No segment text, no client names, no file paths from
the owner's machine. The same rule as `tm-format-spec.md` §11.3's bench
output.

## Shape

```json
{
  "schema": 1,
  "experiment": "E-001",
  "run": "2026-10-02-ba297ae-1",
  "hypotheses": ["H1"],
  "confirmatory": true,
  "started_at": "2026-10-02T09:14:00Z",
  "finished_at": "2026-10-02T11:40:00Z",
  "outcome": "completed",

  "code": { "commit": "ba297ae…", "dirty": false },
  "corpus": {
    "id": "synthetic-1M",
    "sha256": "…",
    "units": 1000000,
    "langs": ["en", "fr"]
  },
  "model": { "id": "…", "revision": "…", "dim": 384, "pooling": "mean" },
  "params": { "fts_k": 50, "vec_m": 50, "fuzzy_scorer": "FS-1" },
  "machine": {
    "cpu": "…",
    "ram_gib": 16,
    "os": "…",
    "node": "22.x",
    "sqlite": "3.49.2"
  },

  "metrics": {},
  "notes": ""
}
```

- `confirmatory` is `false` for any run whose hypothesis was written
  after its results were seen (protocol rule 1).
- `outcome` is `completed`, `failed` or `aborted`. Failed runs are kept
  (rule 2); `notes` says what broke.
- `corpus.id` is a public corpus name and version (`dgt-tm-2024-en-fr`),
  `synthetic-<size>`, or an opaque `private-<letter>`. `sha256` is the
  digest of the input file, per the repo's rule on comparing binary
  payloads by digest.
- `metrics` is per experiment; its keys are defined in the experiment
  file before the first run, never invented after.

Bump `schema` for an incompatible change and say so in the journal.
