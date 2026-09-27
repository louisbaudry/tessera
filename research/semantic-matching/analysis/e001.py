#!/usr/bin/env python3
"""E-001's pre-registered H1b test, computed from results files only.

    python3 research/semantic-matching/analysis/e001.py [corpus-id]

For each model and m on the corpus's `para` set, the comparison is
`union` against `ftsK` at equal candidate count, taken from the exact
arm if it met the budget, else from the hnsw arm if that did, else
excluded (E-001, "Vector search" and "Test"). Holm correction across
the included comparisons. Only confirmatory, completed runs are read;
for each (model, search) the latest such run wins.

Prints a table; writes nothing.
"""

import json
import sys
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results" / "E-001"
CORPUS = sys.argv[1] if len(sys.argv) > 1 else "dgt-tm-v2019-en-fr-1M"
ALPHA = 0.05


def runs():
    for f in sorted(RESULTS.glob("*.json")):
        d = json.loads(f.read_text())
        if (
            d["corpus"]["id"] == CORPUS
            and d["confirmatory"]
            and d["outcome"] == "completed"
            and not d["code"]["dirty"]
        ):
            yield f.name, d


def main():
    latest = {}  # (model, search) -> (file, run)
    free = None
    for name, d in runs():
        if d["model"] is None:
            free = (name, d)
            continue
        latest[(d["model"]["id"], d["params"]["vector_search"])] = (name, d)
    if not latest:
        sys.exit(f"no confirmatory model runs for {CORPUS}")

    rows = []
    for set_ in ("para", "lex"):
        comparisons = []
        models = sorted({k[0] for k in latest})
        for model in models:
            for m in (10, 25, 50):
                chosen = None
                for search in ("exact", "hnsw"):
                    run = latest.get((model, search))
                    if run and run[1]["metrics"].get(f"budget_met.{set_}.union_m{m}"):
                        chosen = (search, run)
                        break
                ref = latest.get((model, "exact")) or latest.get((model, "hnsw"))
                met = ref[1]["metrics"]
                ftsk = free[1]["metrics"].get(f"recall.{set_}.ftsK_m{m}") if free else None
                if chosen is None:
                    comparisons.append(
                        dict(set=set_, model=model, m=m, search="-", p=None, ftsK=ftsk,
                             union=None, disc=None, file="-")
                    )
                    continue
                search, (fname, d) = chosen
                mt = d["metrics"]
                comparisons.append(
                    dict(
                        set=set_, model=model, m=m, search=search, file=fname,
                        p=mt[f"mcnemar_p.{set_}.union_m{m}"],
                        union=mt[f"recall.{set_}.union_m{m}"],
                        ftsK=ftsk,
                        disc=mt[f"discordant.{set_}.union_m{m}"],
                    )
                )
        # Holm over the comparisons that were eligible.
        tested = sorted((c for c in comparisons if c["p"] is not None), key=lambda c: c["p"])
        k = len(tested)
        running = 0.0
        for i, c in enumerate(tested):
            running = max(running, min(1.0, (k - i) * c["p"]))
            c["p_holm"] = running
        rows += comparisons

    print(f"E-001 on {CORPUS} (model-free run: {free[0] if free else 'none'})")
    print(f"{'set':5} {'model':46} {'m':>3} {'search':6} {'ftsK':>6} {'union':>6} "
          f"{'u_only':>6} {'k_only':>6} {'p':>9} {'p_holm':>9}  file")
    for c in rows:
        fmt = lambda x: "-" if x is None else f"{x:.3f}"
        disc = c["disc"] or {}
        print(
            f"{c['set']:5} {c['model']:46} {c['m']:>3} {c['search']:6} {fmt(c['ftsK']):>6} "
            f"{fmt(c['union']):>6} {disc.get('union_only', '-'):>6} {disc.get('ftsK_only', '-'):>6} "
            f"{('-' if c['p'] is None else f'{c[chr(112)]:.2e}'):>9} "
            f"{('-' if c.get('p_holm') is None else f'{c[chr(112) + chr(95) + chr(104) + chr(111) + chr(108) + chr(109)]:.2e}'):>9}  {c['file']}"
        )
    para = [c for c in rows if c["set"] == "para" and c.get("p_holm") is not None]
    if not para:
        verdict = "falsified: no model x m met the budget"
    elif any(c["p_holm"] < ALPHA and c["disc"]["union_only"] > c["disc"]["ftsK_only"] for c in para):
        verdict = "supported"
    else:
        verdict = "falsified: no comparison significant after Holm"
    print(f"\nH1b on para: {verdict}")


if __name__ == "__main__":
    main()
