# Journal

Append-only. Dated entries: what was done, decided, found, abandoned.

## 2026-10-13 — slice 0 begins

Done: opened the record (this folder), wrote the spike's setup (E-001) and
its four engineering predictions (H1–H4) before any run.

Found: the spike cannot run yet. The session has no Anthropic API key in
its environment (`ANTHROPIC_API_KEY` is not set), and a key is a credential
only Louis can provide. The language pair is also not named (spec D14),
which the spike needs only as a parameter, but the setup is not frozen until
it is filled in.

Decided: nothing new. No result exists, so nothing here is confirmatory.

## 2026-10-13 (later) — the pairs are named

Louis named the pairs: mostly EN to ES and EN to VI. Recorded in spec D14
and in E-001's setup, which is now frozen apart from the key. Decided: the
spike runs per pair and every hypothesis is tested per pair (stricter than
the single-run wording of 2026-10-13's hypotheses, which named no pair; the
hypotheses themselves are unchanged).

Found, from the repo and not measured: Vietnamese has no segmentation rules
(backlog #13a, open), which blocks a Vietnamese source but not EN to VI.
Whether DeepL translates into Vietnamese is unverified and is checked first
when the D7 benchmark is set up. Neither changes a hypothesis.

Still blocked: no API key in the environment.
